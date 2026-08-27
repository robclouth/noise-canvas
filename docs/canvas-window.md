# The canvas window

**Off by default.** `CANVAS_WINDOW_BLOCKS` is `Infinity` unless
`VITE_CANVAS_WINDOW_BLOCKS` is set at build time, so the shipped app keeps one
canvas over the whole file, exactly as it always did. Everything below only
happens for a file long enough to need a window.

This page is the model. `block-memory-plan.md` is the work log — read that only
when you want to know why something was done.

## The problem

The painting canvas is a pair of float32 render targets the size of the whole
file. At ten minutes that is several gigabytes, and the file cannot open. The
canvas has to stop growing with the file.

## The model

Four words, and everything else follows from them.

- **File** — the whole analysed spectrogram, as packed texels. The unit
  everything outside the renderer speaks in.
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
`compose` draws them into the canvas.

## Who owns what

| File                      | Holds                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| `lib/canvas-view.ts`      | what a view is, and every conversion between file space and view space |
| `lib/block-grid.ts`       | where the block edges fall                                             |
| `lib/block-store.ts`      | the file's packed state as blocks on disk, current and as seeded       |
| `lib/block-slot-cache.ts` | the blocks that are on the GPU, in fixed slots, under a byte budget    |
| `lib/canvas-window.ts`    | placing the window, filling it, and what the canvas holds              |
| `lib/packed-window.ts`    | the same window over the file's original, as one texture               |
| `lib/source-window.ts`    | a window over another file, for a brush painting from it               |
| `lib/whole-file-gate.ts`  | what a brush asks for that a window cannot serve                       |
| `lib/carried-paint.ts`    | paint on blocks that left the window mid-stroke                        |
| `lib/windowed-canvas.ts`  | **the boundary.** File coordinates in, view coordinates out            |
| `lib/stroke-renderer.ts`  | painting, in view coordinates only                                     |

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
   before the commit reads the stroke.
2. **The canvas and the original move together.** The canvas slides only once
   both windows have their blocks, because the shaders address the original
   through the canvas view's metadata.
3. **A slide keeps the overlap and composes what enters — so the overlap has
   to be real.** If a fill was abandoned, those blocks are still empty; the
   window tracks what the canvas holds and composes whatever it lacks.
4. **Paint on a block that leaves mid-stroke is carried.** The slots take it so
   a returning window shows it, the display takes it so it stays on screen, and
   the carry holds it so the commit stores it.
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
7. **A brush painting from another windowed file reads it through a window of
   its own.** The other file's canvas sits wherever its own brush left it, so
   the destination places a `SourceWindow` by the frames the dab asks for
   (`sourceReadFrames` names them) and holds the dab until it lands. That
   window serves the other file's **committed** state, so it re-reads when that
   state moves — a stroke still under the other file's brush is not in it.
8. **A phase turn taken over "the whole file" asks the file.** A reversal turns
   every band by the file's duration. `destFileAxisSec` and `sourceFileAxisSec`
   read the file's frame count; the canvas's own frame count is the span it
   holds. A canvas over the whole file returns the value it always did.
9. **A brush that reads the whole file does not paint on a window.** Wrapping in
   time folds a read onto the far end of the canvas, a full-length brush spans
   the canvas, and the effects in `WHOLE_FILE_EFFECTS` read past any span a
   window holds. `wholeFileNeeds` names them, `dispatchStroke` refuses the dab
   and the file view says so once. The gate is off while the canvas holds the
   whole file, which is every file today.

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

Per open file, windowed, at eight blocks:

- canvas pair, sized to the window, not the file
- block slots on the GPU: two windows plus four spare, because a slide holds
  the window it enters and the one whose paint it folds back
- the original window: one window plus four spare, plus its composed texture
- a source window while a brush paints from another windowed file, and its
  original once a step reads that
- the display pyramid and tile ring, which are bounded by the viewport

The file-sized pristine texture and inverse map are gone. A 60-second file at
rest went from 791 MB to 573 MB, and the remaining cost no longer grows with
length.
