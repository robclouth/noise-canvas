# The canvas window

**Every file paints through a window.** `canvasWindowBlocks` sizes the window
against the GPU pool, and the canvas clamps it to the file: a file whose whole
state fits gets a window spanning every block, which never slides; a longer one
paints through a window of K blocks. There is no separate whole-file canvas.
A build pins K with `VITE_CANVAS_WINDOW_BLOCKS`, where 0 gives every file a
window over all of it. `canvasHoldsWholeFile` picks the file's store: a file
the canvas holds whole keeps its painted state in one array in RAM and writes
only its seed to disk; a longer one keeps both on disk in blocks. Sliding,
carrying and slot reuse only happen for a file long enough to need a window,
but every rule below holds for both.

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
- **Block** — a fixed span of the file, about two seconds, and a whole, even
  number of the coarsest band's bins. The file is a row of blocks. Blocks are
  what the disk store, the GPU slot cache and the undo footprints all count
  in. Because the number is even, a bin's index in a view has the parity of
  its index in the file, and a sort pairs the same neighbours on both.
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
may be wider than the canvas and use the pyramid and tile ring. A dab may be
wider than the canvas too: it paints a block at a time (rule 1).

## Who owns what

| File                       | Holds                                                                      |
| -------------------------- | -------------------------------------------------------------------------- |
| `lib/canvas-view.ts`       | what a view is, and every conversion between file space and view space     |
| `lib/block-grid.ts`        | where the block edges fall                                                 |
| `lib/block-store.ts`       | the file's packed state as blocks on disk, current and as seeded           |
| `lib/whole-state-store.ts` | the same for a file the canvas holds whole: current in RAM, seeded on disk |
| `lib/block-slot-cache.ts`  | blocks on the GPU, in fixed slots, under a byte budget                     |
| `lib/canvas-window.ts`     | placing the window, filling it, and what the canvas holds                  |
| `lib/packed-window.ts`     | the same window over the file's original, as one texture                   |
| `lib/source-window.ts`     | a window over another file, for a brush painting or filtering from it      |
| `lib/impulse-need.ts`      | the other files a dab's effects read: convolve responses, Attract fields   |
| `lib/effect-reach.ts`      | how far past the brush each effect reads                                   |
| `lib/export-window.ts`     | spans of the committed state for an image export                           |
| `lib/whole-file-gate.ts`   | what a brush asks for that a window cannot serve                           |
| `lib/stroke-slots.ts`      | a stroke's paint and masks on blocks that left the window, on the GPU      |
| `lib/carried-paint.ts`     | the same in RAM, for blocks the stroke slots had no room for               |
| `lib/coarse-canvas.ts`     | the file at screen resolution, for a preview and a stroke not yet landed   |
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
carrier phase, a modulator pattern, a random seed — takes the file's. A read
that lands on a bin's edge takes its bin through `binAt`, which moves it a
hundredth of a bin in, so the canvas and a view round it to the same bin.

## What must stay true

Each of these has cost real damage. Break one and the app eats audio quietly.

1. **A dab never lands on a block the canvas has no content for.** An empty
   block is zeros, and painting blends out of the canvas, so the dab would
   commit silence. `holdsFrames` gates it, `paintWhenHeld` holds the dab back
   with the position it was given, and the fill that brings the block in runs
   it. A dab is held per block (`lib/held-dabs.ts`): each block it writes
   paints once the canvas holds that block plus what the dab reads from each
   pixel of it (`pieceReach` in `effect-reach.ts`, which is more than the
   reach past the brush: a blur with Cut edges still smears inside it), and
   one bin of the coarsest band past each cut the dab continues across,
   because a pixel next to a cut interpolates over it. Neighbouring blocks
   that are ready paint as one run under a write clip (`StrokeParams.clip`),
   with the brush laid out over the file, not the canvas, so every piece
   paints the same pixels a whole-file canvas would. A dab that fits and finds
   nothing held paints whole, at once.
   Some dabs cannot be cut on the canvas. An effect that may read anywhere in
   the brush (a warp that scales, turns or mirrors time, any read an edge mode
   wraps round) would read blocks the canvas does not hold, and an Accumulate
   dab would read, across a cut, what its own earlier piece painted.
   `DabExtent.piece` is null for them, and every block reads the whole dab.
   One the window cannot hold is painted beside the canvas (rule 16).
   A block of a dab waits for the older dabs that still have that block to
   paint or, when they read the canvas as the dabs before them left it
   (Accumulate), still have it to read; and, when it reads the canvas that way
   itself, for the older dabs within its reach. So every pixel takes its dabs
   in the order they came, and a dab far from an older one does not wait for
   it. `settle` aims the window at the oldest
   waiting block and widens over what follows while one window holds it.
   `settle` drains what is left
   before the commit reads the stroke. Settlement returns `completed`,
   `cancelled` or `failed`; only `completed` can enter history or synthesis.
   Unavailable blocks after eight fills without progress, or a failed read,
   fail the whole stroke. Cancellation stops waiting and removes held dabs
   before an outstanding read can release them. A stroke can be taken back
   until its commit starts, and taking it back needs no snapshot: the
   committed store plus pending commits go back over its footprint. A stroke begun during
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
   A region edit (silence, cut, paste, duplicate) is a row of dabs, each no
   longer than the longest brush (`regionParts`), held the same way and
   settled before its commit; a paste's later parts read further into the
   clipboard. So a region of any length paints, whatever the window holds.
   A selection clips the stroke at file frames; the shader gets them less the
   canvas view's start. Reads for a region (copy, the
   wand, auditioning a selection) take the store's committed state over the
   blocks they cover (`readPackedSpan`), never the canvas. The wand reads a
   chunk at a time, only where its region reaches, so it grows over any
   length of file.
   A grid fill is a stroke like any other: each of its dabs goes through
   `paintWhenHeld`, and the fill settles every chunk before it gives the
   next, so the window walks the file behind the anchors and the stroke slots
   keep what it leaves. A fill that painted straight into the canvas covered only
   the window it happened to be on. Cancelling such a fill cannot put a
   snapshot back either, because the window has slid since it was taken:
   `discardStroke` drops the held dabs, the stroke slots and the carry, and patches the store's
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
4. **The block slots mirror the store; a stroke's paint lives on the canvas
   and in the stroke slots until its commit stores it.** A block that leaves
   mid-stroke with paint on it goes to the stroke slots as the canvas holds
   it, with each brush step's mask over it; nothing is read back. A block that
   comes back is composed from its block slot into the canvas and into the
   stroke-start snapshot, and the stroke slots then draw the stroke's paint
   and masks back over the canvas alone. So the stroke keeps blending from
   what the file held before it, and a weaker dab never pulls back what a
   stronger one painted: a canvas holding the whole file would paint the same.
   When the stroke slots are full, the blocks held longest go to RAM
   (`CarriedPaint`) with their masks, and come back the same way.
   A stroke's paint stays on the canvas after the pen lifts, too. At pen-up
   its blocks go into the block slots on the GPU, from the canvas or from the
   stroke slots, marked ahead of the store; a block the stroke left in RAM
   loses its slot instead. The commit holds the pixels it read until the
   store has them, and a block the window brings in from a slot that mirrors
   the store takes those pixels back on top. Without that, a quick next
   stroke reads the old state where the window moved and commits it over the
   last one. Once the store has them, the slots that mirror it take them a
   block at a time, in the order the store took them, and a slot ahead of the
   store is left alone. A commit that stores values of its own past the
   stroke drops the slots over them, and one that is not stored drops the
   slots it put ahead.
   The stroke ends the moment the commit has read it, not when the commit
   lands: a commit takes seconds, and a stroke begun meanwhile would
   otherwise be ended mid-way, its slides carrying nothing.
   The display's tile ring reads the committed state through the canvas for
   the same reason (`readCommittedTaps`): a tile cut while a commit is
   landing takes the held paint over the store's values, so a zoom across a
   level never shows the state before the stroke; and holding the paint
   re-encodes the stroke's footprint from the canvas and drops the tiles over
   the rest of it, so a tile cut while the stroke was painted shows its dabs. A tile reads only the taps its bins
   keep (`readTaps`, two floats each), not every pixel of the span they
   stride over, because a level's decimation is what the cut would have
   thrown away. And the ring serves only a view the canvas neither holds nor
   is filling to hold: where the window is aimed at the view, the ring lets
   go and the pyramid's finest level stands in until the canvas lands. At
   fine levels a tile is floored to the coarsest band's step, four viewports
   wide, and reading four of those per level was the pause a zoom paid.
5. **Any whole-state move drops what the stroke left off the canvas.** After
   a history hop, a restore or phase turns, the old carry and stroke slots no
   longer speak for the file. A commit issues its reads of both at pen-up,
   so a stroke starting after it can reuse them.
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
   state moves — a stroke still under the other file's brush is not in it.
   A dab asks for what each of its steps reads as a `SourceRead`: the source
   frames against the frames it writes, one mapped linearly onto the other,
   padded by what its effects read around them and a bin of the source's
   coarsest band. A first step that names no file reads the active file, which
   gets a window the same way.
   `sourceNeedsOver` turns that into the window for one piece of the dab, so
   a dab wider than a window reads its source a block at a time too, and a
   dab with such a read paints each block on its own. A window never says it
   holds a span wider than itself, and a dab whose piece asks for more than a
   window holds is refused (`servable`), because a read past a window's edge
   takes the edge's values. The window's texture takes a newly read view a
   step before the window does, and it serves nothing while the two differ. The
   canvas keeps one window for the file a step paints from, and one for each
   file a convolve step filters through. A convolve that names no response file
   filters through the file it paints from, which is the file it paints on when
   it names neither, and that read is a window too. IR Start is a fraction of
   the response file, so it lands against the file before it is measured
   against the window. A response whose own canvas holds all of it is read
   through that canvas, with no window of ours. An Attract field file is
   read the same way, laid over the painted file in proportion, so the dab's
   share of the painted file is the share of the field it reads; a file read
   by two effects is read through one window over both spans. A window over
   another file reads that file as its canvas shows it: the store, with the
   paint of strokes whose commits have not landed laid over it
   (`withPendingPaint`), and it reads again when that paint changes.
8. **A phase turn counts the file's time.** A reversal turns every band by its
   centre times the read's time plus the write's, both counted from the
   file's start (`destFrames`, `sourceFrames`), in exact turns; the canvas's
   own frame count is only the span it holds. A canvas over the whole file
   returns the value it always did.
9. **A brush is laid out over the file, not the canvas.** A full-length brush
   spans the file's frames, so on a window it paints a block at a time like
   any wide dab. Wrapping in time folds modulo the file's frames
   (`brushWrapSpanX`), and a wrapping dab writes two spans, the file's end and
   its start. Random and Time modulation read file UV.
   A step that reads this file away from the dab (source tracking off Follow,
   or a source time offset) reads it off the canvas when the canvas can hold
   the read beside the dab: the dab's reach widens to cover it
   (`withSelfReads`), and the offset lands on the canvas's span like any
   other window's (`sourceOffsetForViews`). Further away, it reads through a
   window over this file of its own (`lib/self-window.ts`): the store's
   blocks with the paint of strokes still committing laid over them, which is
   the file as a stroke finds it, and, for a step that reads the canvas as the
   stroke leaves it (Accumulate, or a step after the first), this stroke's own
   paint on top, from the canvas, the stroke slots and the carry. A read of
   a brush that wraps in time and runs past either end of the file is moved a
   whole file length back in, as a whole-file canvas's wrap would; half a
   frame of slack keeps rounding from moving one that starts on frame 0
   (`wholeFilesPast`). Any other read past an end clamps at the file's edge,
   as it does on a canvas over the whole file.
   An effect that reads past an end of the file under a brush that wraps
   in time reads the other end there, which no window holds beside the dab,
   so such a dab is painted beside the canvas (rule 16), where a read past
   an end of an axis the brush wraps round takes the whole of that axis and
   a tile's view spans the whole file.
10. **The canvas holds what an effect reads, not only what the dab covers.** A
    blur smear, a repeat gap and a warp's turn, stretch or shift all read past
    the brush when the edge mode is Bleed or Invert; the other edge modes fold
    the read back inside the brush and reach nothing. A transmute that moves a
    band along time reads where it lands, an attract reads the field it places
    bands against, an evolve reads the neighbourhood it flows through, and a
    convolve steps the read one response bin per tap, the way Rate's sign
    points. `effect-reach.ts` says how far, in seconds of the file, and the aim
    and the dab's own wait widen by it.
    Effects run one after another, and a step runs its effects
    `brushIterations` times over, each reading what the one before wrote, so
    their reaches add up along the chain. A sort reads a few bins and two
    bands either side per run, not the whole brush.
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
    stores them then. Until that pass, or the restore that stands in for it,
    is done the file is marked `onsetsPending`, and a stroke reading it is
    refused (`onsetsPendingRefusal`, which names the file): every read
    through the default warp follows onsets. A host that answers whole passes only keeps the
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

16. **A dab the window cannot hold is painted beside the canvas, in tiles.**
    `besideFor` cuts it into tiles of bands over runs of blocks. `readBoxes`
    says what region a tile reads: from the brush's last effect back, each
    effect widens the region by what it reads around a pixel, maps it through
    its warp, or takes its step's whole brush when it may read anywhere in it.
    A tile that reads more than a window holds is halved across bands or
    blocks, whichever reads less, and a tile that cannot read less is refused.
    A transform that is the brush's first effect, run once, and warps or
    shifts, samples the first step's input through a view of its own, so
    reversing a whole file reads its far end, and a shift reads the one box it
    lands on, without one view spanning both.
    A refusal is never silent, and it says what to change. `reachFixes` moves
    each control of the brush, one at a time, toward its default or an end,
    and halves its travel against the real refusal test (`brushPaintsAt`) to
    find the nearest value that paints at that spot; the notice names the
    nearest few, and an edge mode that keeps reads inside the brush. A stroke
    is checked where it starts; a later dab that cannot paint is dropped and
    the stroke says so once (`reportDroppedDab`). Fill Grid and the region
    edits count the pieces they could not paint and give the first one's
    reason.
    Each tile paints on a renderer of its own (`StrokeRenderer.beside`) loaded
    with the file as the stroke found it (`readStart`) and the stroke's paint
    and masks so far (`readStrokePaint`), after the other files' windows hold
    what it reads there (`holdOthers`). The paint goes back on the canvas a
    block at a time as the window holds each (`layPaint`), each block held on
    its own, because laying reads nothing past it. Every tile reads the
    file as it was before the dab, so tiles never read one another's paint and
    an Accumulate dab cuts like any other. The dab starts once every earlier
    dab has painted, and holds every later one back until it has laid all its
    paint (`HoldOptions.holdsBack`).
    The same rule holds on the canvas: every pass of a step but the last
    writes the packed rows of the brush's bands and of the bands the passes
    after it read (`calculateScissorRows` with `pitchReachBands`). With fewer
    rows the next pass reads stale texels, which differ with the layout.

17. **Every dab of a stroke goes through `paintDab`.** The pointer's trail,
    the dab under the cursor, a region edit and a grid fill all ask it, and
    it paints on the canvas or beside it. A path that called `paintWhenHeld`
    itself would drop every dab the window cannot hold. When settling a
    stroke runs past half a second, the engine shows how many pieces are left
    (`WindowedCanvas.pendingWork`) in a dialog whose Cancel takes the stroke
    back.

18. **The picture shows an edit before its full-resolution paint lands.** A
    dab the canvas cannot show whole, and every dab of a stroke on a file the
    canvas holds a window of, is painted on the coarse canvas too
    (`lib/coarse-canvas.ts`): a renderer beside the canvas over the whole
    file, laid out as the display pyramid level the screen draws (at most a
    million texels), holding that level's magnitudes with zero phase. The
    display draws, in order, the canvas's preview, a dab previewed on the
    coarse canvas, and outside the canvas the stroke painted on it
    (`overlayDbAt` in `display.frag`). The coarse canvas is drawn again from
    the pyramid when the level or the picture moves (`DisplayPyramid.revision`),
    except while it holds a stroke, which it lets go once the canvas has
    settled and the store holds the paint (`hasUnstoredPaint`). It is a
    preview: phase is zero and the level is coarse, so it shows where the
    edit lands and how loud, not every detail.

## How to check it still works

The unit suite cannot see most of this: it compares two renderers, and both can
be fed the same empty canvas. Drive the real app instead.

```
npm run test:run          # 1400+ unit tests, whole-file path
npm run test:addon        # the native addon
npm run window:check      # builds windowed, paints, and checks the picture
```

`npm run drive:preview` checks the coarse picture in the built app: a
full-length brush must darken its row while it hovers, and a dab of it must
show well before its commit lands.

`window:check` is the one that catches the bugs the suite cannot: it opens a
file with an eight-block window, paints, and fails if any column of the
spectrogram went black or the committed footprint does not match the whole-file
build. It also prints resident memory.

`canvas-parity-matrix.test.ts` paints every effect at one beat, wider than the
window and over the whole file, with Accumulate off and on, through the real
dispatch on a canvas over the whole file and on a six-block window, and
compares the two. It runs a 60-second file; `VITE_PARITY_SECONDS=300,600` adds
the five- and ten-minute ones.

## Where the memory goes now

Per open file, windowed, at K blocks:

- canvas pair, sized to the window, not the file
- block slots on the GPU: a window plus four spare, plus whatever the
  window's share of the budget has left once the window is sized
  (`canvasExtraSlotBlocks`), up to the whole file. A block that keeps its slot
  composes on the GPU when the window comes back to it, instead of being read
  and uploaded again. Once the store can answer, idle time fills the free
  slots nearest the canvas first (`warmSlots`), pausing while a stroke paints
  or a commit lands and leaving two slots free for a slide; a zoomed-out stroke
  across the file then slides without reading a block. A read that was on its
  way when the store moved reads again rather than land stale values.
  Slot pages are allocated as blocks arrive.
- stroke slots: a window plus four spare, plus what the budget has left after
  the block slots (`canvasPaintExtraSlotBlocks`), each block with a two-byte
  mask per step beside it. Pages are allocated as a stroke leaves blocks.
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
