# The canvas window

**The budget decides.** `canvasWindowBlocks` sizes the window against the GPU
pool. A file whose whole state fits keeps one canvas over all of it, exactly as
it always did; a longer one paints through a window of K blocks. A build pins K
with `VITE_CANVAS_WINDOW_BLOCKS`, where 0 keeps the whole file on the canvas.
The same answer, `canvasHoldsWholeFile`, picks the file's store: a file the
canvas holds whole keeps its painted state in one array in RAM and writes only
its seed to disk; a longer one keeps both on disk in blocks. Everything below
only happens for a file long enough to need a window.

This page is the model. `block-memory-plan.md` is the work log — read that only
when you want to know why something was done.

## The problem

The painting canvas is a pair of float32 render targets the size of the whole
file. At ten minutes that is several gigabytes, and the file cannot open. The
canvas has to stop growing with the file.

## The model

Four words, and everything else follows from them.

- **File** — the whole analysed spectrogram, as a run of packed texels: the
  band lengths laid end to end, with no width, no height and no padding. The
  unit everything outside the renderer speaks in. A texture built from any part
  of it picks its own fold through `packedFold`.
- **Block** — a fixed span of the file, about two seconds, aligned to the
  coarsest band's bin grid. The file is a row of blocks. Blocks are what the
  disk store, the GPU slot cache and the undo footprints all count in.
- **View** — a run of blocks, expressed as its own packed layout: its own band
  offsets, its own metadata texture, its own frame count. A view looks exactly
  like a small file, which is why no shader had to change.
- **Canvas** — the render-target pair, laid out by one view. It holds that
  view's texels and nothing else.

So the canvas is a window of K blocks that follows the brush. `plan` decides
where the window should sit, the slot cache pages the blocks in from disk, and
`compose` draws them into the canvas. A stroke moves the window every frame.
Everything else — a pointer only hovering, a pan under way — moves it once the
aim comes to rest, because paging in every block a pointer crosses serves no
dab.

The screen's visible range is distinct from the packed view. `isPopulated`
says every block of the canvas's current view has content. `holdsFrames` checks
that the entire requested file-frame range is present; `isFillingFrames` checks
that an outstanding fill's layout can cover it. `fitsWindow` measures capacity
in blocks, and both dab refusal and admission use that decision. A screen range
may be wider than the canvas and use the pyramid and tile ring; an impossible
dab is refused.

## Who owns what

| File                       | Holds                                                                      |
| -------------------------- | -------------------------------------------------------------------------- |
| `lib/canvas-view.ts`       | what a view is, and every conversion between file space and view space     |
| `lib/block-grid.ts`        | where the block edges fall                                                 |
| `lib/block-store.ts`       | the file's packed state as blocks on disk, current and as seeded           |
| `lib/whole-state-store.ts` | the same for a file the canvas holds whole: current in RAM, seeded on disk |
| `lib/block-slot-cache.ts`  | the blocks that are on the GPU, in fixed slots, under a byte budget        |
| `lib/canvas-window.ts`     | placing the window, filling it, and what the canvas holds                  |
| `lib/packed-window.ts`     | the same window over the file's original, as one texture                   |
| `lib/source-window.ts`     | a window over another file, for a brush painting or filtering from it      |
| `lib/impulse-need.ts`      | the response each convolve step reads, and the frames its taps cover       |
| `lib/effect-reach.ts`      | how far past the brush each effect reads                                   |
| `lib/export-window.ts`     | spans of the committed state for an image export                           |
| `lib/whole-file-gate.ts`   | what a brush asks for that a window cannot serve                           |
| `lib/carried-paint.ts`     | paint on blocks that left the window mid-stroke                            |
| `lib/windowed-canvas.ts`   | **the boundary.** File coordinates in, view coordinates out                |
| `lib/stroke-renderer.ts`   | painting, in view coordinates only                                         |

The passes that read the file outside the renderer live beside the addon they
drive, because the extension host runs them too:

| File                           | Holds                                             |
| ------------------------------ | ------------------------------------------------- |
| `main/lib/packed-view.ts`      | the per-band ranges one span of the file lays out |
| `main/lib/onset-scan.ts`       | onsets, a chunk of the file at a time             |
| `main/lib/synthesis-chunks.ts` | the audio, a chunk of the file at a time          |

Audio reconstruction writes 30 seconds per pass. Each coefficient read includes
the full synthesis filter support on both sides: one support for the synthesis
range and two more for the coefficients that feed it. The native
`synthesisReadReach` query derives this margin from the sample rate and analysis
settings. It is not a fixed fraction of a second. Low-frequency bands need
several seconds of context to keep the audio continuous across chunk boundaries.
The interactive stroke commit has its own support policy.

Replacing the full canvas state or disposing the canvas cancels held painting
and advances the stroke revision. Pending reads from the previous revision
cannot replay dabs or patch the restored display. The file engine checks that
revision before rolling back a cancelled settlement, so an old settlement cannot
roll back a newer state.

## The one rule that keeps it findable

> The stroke renderer speaks the canvas's space.
> Everything above it speaks the file's.
> `windowed-canvas.ts` is the only thing that converts.

A packed pixel range, a UV and a frame count each mean one thing against the
file and another against the canvas, and mixing them is silent — the paint
lands in the wrong place, or a commit stores zeros. `canvas-space-boundary.test.ts`
fails if a new file starts converting.

The shader side has the same split and the compiler cannot help there.
`effect-common.glsl` names it instead: `destFileSec` and `destFileUvX` are the
file's clock, plain `destUv` is the canvas's. Anything absolute — an onset, a
carrier phase, a modulator pattern, a random seed — takes the file's.

## What must stay true

Each of these has cost real damage. Break one and the app eats audio quietly.

1. **A dab never lands on a block the canvas has no content for.** An empty
   block is zeros, and painting blends out of the canvas, so the dab would
   commit silence. `holdsFrames` gates it, `paintWhenHeld` holds the dab back
   with the position it was given, and the fill that brings the block in runs
   it. Held dabs run in the order they were given, so one the canvas could
   take does not overtake one still waiting. `settle` drains what is left
   before the commit reads the stroke. Settlement returns `completed`,
   `cancelled` or `failed`; only `completed` can enter history or synthesis.
   Unavailable blocks after eight fills without progress, or a failed read,
   fail the whole stroke. Cancellation stops waiting and removes held dabs
   before an outstanding read can release them. Each stroke retains a rollback
   snapshot until its commit starts. A failed stroke restores the committed
   store plus pending commits across its footprint. A stroke begun during
   settlement or restoration waits: the file view keeps every position the
   pointer crosses, and the engine starts the stroke the moment the last one
   ends, after its commit has read it. If the pointer is already up by then,
   the stroke commits straight away. If restoration also fails, painting stays
   blocked and the user must reopen the file; incomplete pixels never become
   a successful commit.
   A quick pointer crosses several brush widths between two frames. The file
   view samples the pointer's path at half a brush width, snaps each sample,
   and queues the positions; the next frame paints each one before the
   cursor's own dab, so a fast stroke leaves no gaps. A position equal to the
   last dab is skipped.
   A grid fill is a stroke like any other: each of its dabs goes through
   `paintWhenHeld`, and the fill settles every chunk before it gives the
   next, so the window walks the file behind the anchors and the carry keeps
   what it leaves. A fill that painted straight into the canvas covered only
   the window it happened to be on. Cancelling such a fill cannot put a
   snapshot back either, because the window has slid since it was taken:
   `discardStroke` drops the held dabs and the carry and patches the store's
   values over the stroke's footprint, with the paint of any commit still
   landing laid back on top.
2. **The original is read only for a dab that samples it.** The window over
   the original is built the first time a step in Original mode asks for it,
   and such a dab lands only once that window holds the canvas's view, because
   the shaders address the original through the canvas view's metadata. A
   slide no dab asked the original for leaves it where it was.
3. **A slide keeps the overlap and composes what enters — so the overlap has
   to be real.** If a fill was abandoned, those blocks are still empty; the
   window tracks what the canvas holds and composes whatever it lacks.
4. **A block that leaves goes back to its slot as the canvas last held it,
   and paint on a block that leaves mid-stroke is carried.** The slot copy
   means a returning block shows the canvas's latest values, not the store's
   values from when the slot was filled; the display takes the paint so it
   stays on screen, and the carry holds it so the commit stores it. A block whose slot went while it
   was away comes back with the store's values, so the canvas takes its paint
   out of the carry as it lands: the stroke sees what it painted there, paints
   over it, and the commit reads the canvas rather than a stale carry.
   A stroke's paint stays on the canvas after the pen lifts, too: the commit
   holds the pixels it read until the store has them, and a block the window
   brings in before then, from a slot or a store that predates the stroke,
   takes those pixels back on top. Without that, a quick next stroke reads
   the old state where the window moved and commits it over the last one.
   The stroke ends the moment the commit has read it, not when the commit
   lands: a commit takes seconds, and a stroke begun meanwhile would
   otherwise be ended mid-way, its slides carrying nothing.
   The display's tile ring reads the committed state through the canvas for
   the same reason (`readCommittedTaps`): a tile cut while a commit is
   landing takes the held paint over the store's values, so a zoom across a
   level never shows the state before the stroke; and holding the paint
   re-encodes the stroke's footprint from the canvas, so a tile cut while
   the stroke was painted shows its dabs. A tile reads only the taps its bins
   keep (`readTaps`, two floats each), not every pixel of the span they
   stride over, because a level's decimation is what the cut would have
   thrown away. And the ring serves only a view the canvas neither holds nor
   is filling to hold: where the window is aimed at the view, the ring lets
   go and the pyramid's finest level stands in until the canvas lands. At
   fine levels a tile is floored to the coarsest band's step, four viewports
   wide, and reading four of those per level was the pause a zoom paid.
5. **Any whole-state move installs a fresh carry.** After a history hop, a
   restore or phase turns, the old carry no longer speaks for the file. A
   commit already reading the old one keeps the object it took.
6. **The source read is a position in the source file, not in its canvas.** A
   brush reads the source beat for beat against the two files' clocks.
   `sourceOffsetForViews` puts the brush anchor on the destination file's clock
   and divides the answer by the span the source textures hold; the shader
   scales the source time offset the same way, because that control is a
   fraction of the source file's whole length. Without both, a windowed canvas
   reads from the start of whatever window it happens to show.
7. **A brush reading another windowed file reads it through a window of its
   own.** The other file's canvas sits wherever its own brush left it, so the
   destination places a `SourceWindow` by the frames the dab asks for
   (`sourceReadFrames` names them) and holds the dab until it lands. That
   window serves the other file's **committed** state, so it re-reads when that
   state moves — a stroke still under the other file's brush is not in it. The
   canvas keeps one window for the file a step paints from, and one for each
   file a convolve step filters through. A convolve that names no response file
   filters through the file it paints from, which is the file it paints on when
   it names neither, and that read is a window too. IR Start is a fraction of
   the response file, so it lands against the file before it is measured
   against the window. A response whose own canvas holds all of it is read
   through that canvas, with no window of ours.
8. **A phase turn taken over "the whole file" asks the file.** A reversal turns
   every band by the file's duration. `destFileAxisSec` and `sourceFileAxisSec`
   read the file's frame count; the canvas's own frame count is the span it
   holds. A canvas over the whole file returns the value it always did.
9. **A brush that reads the whole file does not paint on a window.** Wrapping in
   time folds a read onto the far end of the canvas, a full-length brush spans
   the canvas, and source tracking away from Follow puts the read anywhere in
   the file. `wholeFileNeeds` names them, `dispatchStroke` refuses the dab and
   the file view says so once. No effect is among them: each declares a reach
   instead. The gate is off while the canvas holds the whole file.
10. **The canvas holds what an effect reads, not only what the dab covers.** A
    blur smear, a repeat gap and a warp's turn, stretch or shift all read past
    the brush when the edge mode is Bleed or Invert; the other edge modes fold
    the read back inside the brush and reach nothing. A transmute that moves a
    band along time reads where it lands, an attract reads the field it places
    bands against, an evolve reads the neighbourhood it flows through, and a
    convolve steps the read one response bin per tap, the way Rate's sign
    points. `effect-reach.ts` says how far, in seconds of the file, and the aim
    and the dab's own wait widen by it.
    A brush whose dab plus reach is wider than a whole window can never be
    served, so `overReachNeeds` names it and the dab is refused.
11. **An offset added to a source UV converts against the span the source
    textures hold.** A blur's beats and a repeat's gap are source-UV distances
    (`sourceLayout`), a warp's shift is a destination-UV one
    (`destinationLayout`), and a turn mixes the two axes, so it converts to the
    file's own time axis first (`destFileUvSpanX`).
12. **A reader that needs the whole file takes it a span at a time.** A
    windowed canvas commits only the stroke's footprint, however much of the
    file it covers, and history stores that as a delta; a file whose tier is
    on disk writes no whole checkpoints, because its tier already holds the
    state. Only a projection over the whole file composes the whole painted
    state from the block store with the stroke's own pixels over it. The image
    export walks the file in strips, each served by its own window. Neither asks the canvas for a state it
    cannot hold, and a span that falls short of what it serves stops the
    reader rather than drawing clamped values.

    Opening a file is the same rule. `AnalysisStream` works the band layout out
    before it reads any audio, so the analysis hands back one block of
    coefficients at a time and the store is seeded as they land; the display
    then draws the file from those blocks. The analysis also keeps a strip of
    the whole file at one coarser pyramid level (`lib/coarse-strip.ts`), the
    taps that level's decimation would take, so the picture shows at that
    level the moment the view mounts and the finer levels are drawn in
    underneath it; the level choice never goes below the pyramid's
    `readyLevel` until that draw finishes. Wherever the pyramid stands in for
    a finer picture — a tile still being read, a coarser level while the
    finer ones are drawn — the display greys that region after a short grace
    (`displayLoading`), so a reader sees it is loading rather than taking the
    stand-in for the state. `synthesiseInChunks` reads the store back a chunk
    at a time through a view, and the onsets come out of the same read: each
    chunk's detection curves (`onsetCurvesOfChunk`) are found while the chunk
    is synthesised, from a view widened to the whitening's warm-up, and once
    the audio is there the events are picked off the curves of the whole file
    at once and measured a chunk at a time (`finishFileOnsets`). The detector
    needs two things only the whole file can give — every band's loudest
    moment, which the analysis carries, and the loudest moment of the
    detection function, which is the gate the pick is held to — and one more
    the curves cannot carry: an event's size is read off the coefficients
    around it, up to where the next event starts, so the measuring round
    reads again, only around the events. `scanOnsets` is the same three
    stages for a caller with no synthesis to ride on, and a pass handed no
    band maxima takes a round to find them first. A windowed file opens with
    no onsets and no gate; its first synthesis brings both, and the root node
    stores them then. A host that answers whole passes only keeps the
    whole-run path.

    Deriving a file from another is the same rule again. A duplicate seeds its
    store from the old file's a block at a time, and a merge sums the parts a
    block at a time; a block's own packed layout is `blockBandLayout`. Only the
    passes that cannot be cut into blocks still read a whole run: HPSS and NMF,
    which factorise over the file, and the splice re-analysis, which takes the
    old coefficients as one array. The seed loop runs under the source file's
    task queue, so a stroke committed on the source while its blocks are read
    waits, and the copy is one state.

    A store cannot answer until the root snapshot naming its seed is written,
    which is long after the canvas is built. So the picture the owner asked for
    at construction comes back empty and has to be asked for again once the
    root is there — `WindowedCanvas.storeReady`.

    A block the window reads goes from the store to its slot as the store
    holds it, with no copy in between (`readBlock`): the slot cache uploads
    it at once through a texture it keeps, and the store's array may change
    under a later commit. The range readers stay for everything that keeps
    what it reads.

    A file the canvas holds whole never pays for blocks. Its store keeps the
    current state as one array, patched in place by every commit, and writes
    the seeded blocks behind the open; the first patch waits for that write,
    and until then the array answers for the seed too. The manifest on disk
    never names a tier held in RAM, so a relaunch rebuilds the state from the
    seed and the deltas and seeds the array again.

13. **The band layout is doubles, and the metadata texture is a conversion of
    it.** A float counts integers exactly only to 2^24, and a ten-minute file
    has 119M coefficients, so offsets held as floats round to multiples of
    eight while the lengths beside them stay exact. The two then disagree, a
    pixel at the end of one band reads as the start of the next, and a block
    lands outside the view that holds it. `bandLayoutOf` builds the layout from
    the exact per-band arrays; `metadataTextureRows` makes the floats the
    shaders sample, whose own offsets are a view's and stay small.

14. **A file with more coefficients than one texture always paints through a
    window.** The canvas is a texture pair, so neither the graphics budget nor
    a pinned `VITE_CANVAS_WINDOW_BLOCKS` may keep the whole file past
    `MAX_PACKED_TEXTURE_TEXELS`; `canvasWindowBlocks` returns a finite figure
    there whatever else says.

15. **A display store says where it has nothing, and nothing reads as zero.**
    The pyramid and the tile ring hold magnitudes as dB, so an untouched texel
    is 0 dB — the loudest value there is, which paints white. Every level is
    cleared to `DISPLAY_DB_UNKNOWN` before anything seeds it, the samplers
    refuse a tap holding it, and the display draws a hatch over what nothing
    can answer for. This is what a file being drawn block by block shows: it
    reaches `beginDisplaySeedFromStore` with no coarse strip to stand in, and
    the levels fill in one block at a time.

## How to check it still works

The unit suite cannot see most of this: it compares two renderers, and both can
be fed the same empty canvas. Drive the real app instead.

```
npm run test:run          # 1400+ unit tests, whole-file path
npm run test:addon        # the native addon
npm run window:check      # builds windowed, paints, and checks the picture
```

`window:check` is the one that catches the bugs the suite cannot: it opens a
file with an eight-block window, paints, and fails if any column of the
spectrogram went black or the committed footprint does not match the whole-file
build. It also prints resident memory.

## Where the memory goes now

Per open file, windowed, at K blocks:

- canvas pair, sized to the window, not the file
- block slots on the GPU: two windows plus four spare, because a slide holds
  the window it enters and the one whose paint it folds back, plus whatever
  the window's share of the budget has left once the window is sized
  (`canvasExtraSlotBlocks`), up to the whole file. A block that keeps its slot
  composes on the GPU when the window comes back to it, instead of being read
  and uploaded again. Once the store can answer, idle time fills the free
  slots nearest the canvas first (`warmSlots`), pausing while a stroke paints
  or a commit lands and leaving two slots free for a slide; a zoomed-out stroke
  across the file then slides without reading a block. A read that was on its
  way when the slots were dropped reads again rather than land stale values.
  Slot pages are allocated as blocks arrive.
- the original window, once a step in Original mode asks for it: one window
  plus four spare, plus its composed texture
- a source window per windowed file a step paints from, and its
  original once a step reads that
- the display pyramid and tile ring, which are bounded by the viewport

The file-sized pristine texture and inverse map are gone. A 60-second file at
rest went from 791 MB to 573 MB, and the remaining cost no longer grows with
length.

Nothing in RAM now holds the run of a whole file. A ten-minute file opens at a
peak of about a gigabyte, where it took 2.8 GB when the analysis returned its
coefficients in one array.
