# File engines and view rendering

`FileEngineRegistry` owns one engine per open file within the shared graphics
context. An engine owns painting textures, window residency, stroke dispatch and
history attachment. Changing the selected layer or remounting a view does not
replace that engine. Parking releases its graphics resources; reopening or
reloading prepares a new resource generation before publishing it.

`FileRendererHandle` is the stable file-operation adapter used by the store,
exports and source reads. Only interactive stroke and preview operations forward
to the current view. Snapshot capture belongs to `ViewRendererHandle`.

`ViewDisplay` owns the visible layer list, tint and display materials, presentation
residency and shared view transform. Each layer retains its own file metadata.
The normalised alignment and additive blending also apply to files with different
lengths. Only the editing layer retains its colour; background layers use
greyscale tints at the same luminance. Selecting another layer updates both the
live composition and its snapshot. `file-editor.ts` prepares the selected layer's brush and
overlays; it does not own a React component or file lifetime.

## Frames and snapshots

Gesture transforms reach the display controller before a frame is requested.
React carries membership, selection and whether the view needs to stay live.
Motion keeps the live canvas visible independently of hover and ends 180 ms
after the last transform update. Each moving frame uses the current transform.

`ViewSnapshot` gives each requested image a content revision. Concurrent requests
share the pending capture. Readback can publish only if that revision, view
lifetime, canvas identity and dimensions still match. A change during capture
requests one fresh capture after the pending work finishes. The shared capture
target issues drawing and the PBO read before awaiting the fence.

## Exact background cache

Stacks with at least three layers can retain their combined background in one
RGBA8 target at the view's physical pixel dimensions. Warm top-layer painting
uses two presentation draws and does not rebuild the background. One- and
two-layer views draw directly and allocate no backdrop.

Membership, tint, background content or residency, spectral settings, dimensions
and transform changes invalidate the cache. Top-layer brush and preview changes
do not. Continuous zoom and pan draw all layers directly; settling builds the
exact final background once. A rebuild frame therefore costs N+1 presentation
draws, including the background build. A warm frame costs two. Captures use the
same exact composition; a different output size uses direct drawing.

The target costs width × height × 4 bytes: 1,107,200 bytes for a 692 × 400 view.
`ViewDisplay.backdropBytes` reports owned target bytes. Shrinking to two layers,
parking or disposing the view releases it. There is no overscan or approximate
reprojection. The direct composition method remains the gesture path and pixel
oracle, without a product setting to select implementations.

## Painting boundaries

The model in [canvas-window.md](canvas-window.md) remains authoritative. Prepared
dabs retain file-space bounds and source/impulse requests through admission and
dispatch. Conversion into canvas coordinates stays at the window boundary.
The reach cache retains its `State` key and engine-context lifetime. Original,
source and impulse windows keep separate roles.

Held dabs keep FIFO order. Carry, pending committed paint and readback epochs
retain their existing behaviour. Stroke settlement has explicit completion,
cancellation and failure results.
Only completed strokes can commit; incomplete strokes restore their rollback
state. See `canvas-window.md` for the failure policy. Slot allocation tuning
was measured separately. The tested reuse paths reduced object creation, but
timing was inconclusive under heavy machine load, so the existing copy path
remains. See `slot-copy-profile.md` for the measurements.

## Checks

The renderer residency tests drive production frames and GL draws. They check
current gesture uniforms, revision-safe snapshots, exact cached/direct pixels,
cache invalidation, disposal and stable engines and GPU allocation counts across
100 view switches.

Run the app guards sequentially after the unit suite:

- `npm run window:check`: whole-file and forced-window committed paint.
- `npm run window:stack:check`: retained static stacks, pending captures and
  pointer-away zoom with visible spectral movement.
- `npm run window:display:check`: natural-window display residency and fine pan.
- `npm run window:original:check`: original restoration and saved audio.

Performance comparisons need identical fixtures, viewport and analysis settings,
warm-up, repeated workloads and recorded load. Do not run a build, unit suite or
another measurement alongside a measured app. GPU query samples with a disjoint
flag are excluded. Draw savings alone do not establish an interaction speedup.
