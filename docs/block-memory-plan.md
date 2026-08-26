# Block memory plan

Goal: RAM stops scaling with file length. A 60-minute file costs the same
resident memory as a 60-second file; length costs disk only. Target device:
2019 Intel Mac (Iris 655, 8 GB unified, ~1.5 GB GPU pool), where today a 60 s
stereo file fills the pool.

All estimates use the measured density: ~4.5 packed texels per input sample at
every Resolution setting. 60 s stereo 48 kHz ≈ 13M texels; 1 B/texel ≈ 13 MB.

## How to run this plan (rules for the executing agent)

- Run one task at a time, in order. Finish it, verify it, commit it, then start
  the next. Never leave a task half-done in the tree.
- Line numbers in this document are anchors from 2026-08-25. They drift. Always
  re-locate the code by the quoted symbol or string with grep before editing.
  If the code contradicts a claim in this plan, STOP and report — do not
  improvise around it.
- After each task: `npm run typecheck`, then `npm run test:run`. Both must be
  green before the commit. Native addon changes (Phase 2+) also need
  `npx node-gyp rebuild` and `npm run test:addon`; if C++ behaviour seems not
  to change after an edit, run `node-gyp clean && node-gyp rebuild` (stale
  incremental builds are a known trap).
- Every new test must be mutation-checked: temporarily break the code under
  test, confirm the test fails, restore the code, confirm it passes. Tests call
  the real code; never re-implement the logic under test inside the test.
- Commits go on dev, one per task, gitmoji format:
  `<emoji> (scope): <imperative description>` (✨ feature, 🐛 fix, ♻️ refactor,
  ⚡️ performance, ✅ tests, 📝 docs) with the unicode emoji.
- Never use the `any` type or `as unknown as` casts; fix the real type.
- Code comments: only a one-line docstring on an exported symbol, or a short
  note on a non-obvious correctness invariant. Never rationale, never history.
- User-visible strings follow docs/copy-style.md (British English, `-ise`).
- Marks in this plan: **STOP-ASK** means present findings/options to Rob and
  wait; do not pick for him. **MEASURE** means gather the number before coding.
- To smoke-test in the real app: build with
  `VITE_DEBUG_GLOBALS=1 npx electron-vite build`, launch via Playwright
  `_electron.launch` with `ELECTRON_RUN_AS_NODE` deleted from the env, open a
  file with `webContents.send("open-file", path)`, and read
  `globalThis.__store` for state. Keep driver scripts out of the repo.

## Where the memory goes today (verified 2026-08-25)

Per open file, at rest: 96 B/texel.

| Buffer                                                          | B/texel | Tier |
| --------------------------------------------------------------- | ------- | ---- |
| Canvas ping-pong FBOs `fbo1`/`fbo2` (RGBA32F ×2)                | 32      | GPU  |
| Pristine packed DataTexture (`textures.original`)               | 16      | GPU  |
| Inverse-map DataTexture                                         | 8       | GPU  |
| `spectrogramData.packedData` (backs the pristine texture)       | 16      | CPU  |
| `HistoryManager.currentPacked` (copy of the same bytes at root) | 16      | CPU  |
| `spectrogramData.inverseMap`                                    | 8       | CPU  |

Shared scratch while painting, worst case 84 B/texel: pass FBOs 32 (lazy),
stroke-start snapshot 16 (eager), per-step mask ping-pong pairs 20 (lazy),
modulator MRT 16 (lazy). Peak total 180 B/texel — a 60 s file peaks at
~2.3 GB; a 10-minute file would need ~23 GB and cannot open.

`gpu-budget.ts` undercounts: `CPU_BYTES_PER_TEXEL_FILE = 24` misses the root
duplicate, and the history LRU budgets (up to ~160 MiB at 8 GiB, see
`historyCacheBudgets`) are uncharged.

## Constraints (settled — do not relitigate)

- **No zoom or view coupling for paint residency.** A design where the resident
  paint window followed the view was built and reverted (branch
  `paging-windows`): its saving depended on zoom level. Paint residency follows
  the brush over a fixed grid of time blocks. The display's _content_ is
  inherently view-driven; the rule for the display is that its resident cost
  stays bounded and small at every zoom — never that zooming changes what
  painting costs.
- **No allocation or resize inside a stroke.** Reallocation hitches while
  painting are worse than the memory (owner decision; the same reason freeing
  the scratch pool on idle is banned).
- **Phase channels stay float32.** Unwrapped phase accumulates large values;
  half-float was tried and reverted. Masks and modulator outputs are half.
- **The float32 addressing ceiling:** `bandStartOffset + timeIndex` aliases
  past 2^24 texels. Per-block addressing (Phase 3) removes the whole-file case.
- Time bins are a nested dyadic grid; the stored coefficient sits at the bin's
  LEFT edge `k·2^b`. Any block edge must align to the coarsest band's grid.
- Effects blur/clone/transform have bounded time reach. Evolve, sort, convolve,
  transmute, attract and wrap modes 1|3 read the whole file.
- The plan stays a plan. Status is one line per phase; findings go in commit
  messages, not here.

## Memory by phase (peak while painting, unified memory)

| After phase | 60 s file | 10 min file          | What stops scaling              |
| ----------- | --------- | -------------------- | ------------------------------- |
| Today       | ~2.3 GB   | ~23 GB (cannot open) | —                               |
| 0           | ~2.0 GB   | ~20 GB (cannot open) | — (−15% everywhere)             |
| 1           | ~2.0 GB   | same                 | — (scaffolding, +~10 MB)        |
| 2           | ~2.0 GB   | ~17 GB (cannot open) | CPU side                        |
| 3           | ~0.9 GB   | ~0.9 GB              | GPU side — the class change     |
| 4           | ~0.9 GB   | ~0.9 GB              | — (restores whole-file effects) |

Fixed budgets at 8 GB (scale with RAM like `historyCacheBudgets`): GPU block
cache ~384 MB, RAM block cache ~384 MB, block scratch ~100 MB, display ~20 MB.
Disk: ~600–900 MB per 10 minutes of file, removed on close.

---

## Phase 0 — the simple package (days)

Four independent tasks. Each lands and ships alone. All four were verified
against the code by two independent reviews on 2026-08-25.

### Task 0.1 — history root alias (−208 MB per file)

Current behaviour, `src/renderer/src/lib/history-manager.ts`:

- `addRootSnapshot` (~line 774) does `this.currentPacked = new
Float32Array(opts.data)` (~line 796) and seeds the `packedCache` with that
  copy just after. The same copy exists in the full-snapshot path used after
  re-analysis (~line 831).
- So from file open until the first stroke, `spectrogramData.packedData` and
  `currentPacked` are two identical arrays.
- Precedent: the reopen/anchor navigation path already ALIASES the two (search
  for assignments of `this.currentPacked` around lines 1075 and 1250), so
  shared-mutation semantics already exist in the app.
- Commits intentionally mutate `currentPacked` in place (the footprint patch is
  written into it); after aliasing, `packedData` mutates with it. That is the
  intended "current state" semantics.
- The pristine GPU texture (`createTextures` in
  `src/renderer/src/components/file-renderer.tsx`, ~line 429) uploads
  `packedData` once at load and nothing re-marks it `needsUpdate`, so
  Original-mode shader reads keep load-time content. A `reloadTextures` or a
  context-restore re-upload would show current state instead — identical to
  the existing reopen/anchor behaviour, accepted.

Steps:

1. In `addRootSnapshot` and in the re-analysis full-snapshot path, assign
   `this.currentPacked = opts.data` (alias, no copy). Check the parameter type
   is `Float32Array` end to end; adjust the type, never cast.
2. Remove the `packedCache` seeding at root. Undo-to-root reconstructs from the
   on-disk full snapshot; the cache is only speed.
3. Search for any other `new Float32Array(` copy of freshly analysed packed
   data between analysis and history seeding; remove duplicates only where the
   two arrays are provably never diverged.

Tests (extend `src/renderer/src/lib/__tests__/history-manager.test.ts`):

- After open, `currentPackedState()` and `spectrogramData.packedData` are the
  SAME object (`toBe`). This test doubles as the Task 0.4 budget guard.
- Stroke, then undo to root: state byte-equal to a copy of the analysed data
  saved by the test before painting.
- Redo after that undo: byte-equal to the post-stroke state.
- Re-analyse, then the same round trip.
- Mutation-check each by restoring the copy in step 1.

Commit: `⚡️ (history): alias the root packed state instead of copying it`

### Task 0.2 — single-buffer stroke masks (−130 MB peak)

Current behaviour:

- `src/renderer/src/glsl/mask-update.frag` computes
  `float maxWeight = max(currentWeight, newWeight)` (~line 32) — a manual max
  because no blend mode was used.
- `src/renderer/src/lib/stroke-scratch-pool.ts` `maskFbos(stepIndex)`
  (~line 144) creates a ping-pong `MaskPair` of two R16F targets per step.
- `src/renderer/src/lib/stroke-renderer.ts`: binds `currentMaskTex` from
  `fbos[this.maskPingPong]` (~line 1496), draws into `fbos[1 - maskPingPong]`
  (~line 1498), swaps (~line 1506); readers bind
  `maskPair[this.maskPingPong].texture` (~line 1239); `maskPingPong` resets at
  ~lines 536 and 1999.

Precondition (do this FIRST): add a GPU capability test in the existing
Playwright/WebGL test harness (`src/renderer/src/test/render-harness.ts`
pattern): render two overlapping quads with values 0.25 then 0.75 into one
R16F target with `CustomBlending`, `MaxEquation`, `OneFactor`/`OneFactor`;
read back; expect 0.75 where they overlap. If this fails on any target
platform, **STOP-ASK** with the result (fallback: keep the ping-pong).

Steps:

1. `mask-update.frag`: stop sampling `currentMaskTex`; output the new weight
   only. The blend equation performs the max.
2. Mask material: `blending = CustomBlending`, `blendEquation = MaxEquation`,
   `blendSrc = OneFactor`, `blendDst = OneFactor`.
3. Pool: `MaskPair` becomes a single `WebGLRenderTarget` per step; halve the
   mask allocation; clear to 0 on creation and on mask reset.
4. Renderer: delete `maskPingPong` and the `currentMaskTex` uniform; all mask
   reads bind the single target. Grep `maskPingPong`, `currentMaskTex`,
   `strokeMaskFbos`, `MaskPair` for every touch point, including
   `gpu-budget.test.ts` and the stroke-blend/mask tests.
5. `src/renderer/src/lib/gpu-budget.ts`: `GPU_BYTES_PER_TEXEL_SCRATCH` 84 → 74,
   with the doc comment's arithmetic updated. `gpu-budget.test.ts` computes the
   rate from the real pool, so it verifies the constant.

Semantics must not change: the mask holds the strongest weight each step
reached per pixel; steps cannot raise each other's weight (each step still owns
its own target). The existing mask tests keep their assertions unchanged.

Commit: `⚡️ (scratch): keep each step's stroke mask in one target with MAX blending`

### Task 0.3 — share the inverse map on derive (−104 MB per derived file)

- `src/renderer/src/store/files.ts` ~line 611: `inverseMap:
base.inverseMap.slice()` — a full copy for a derived/duplicated file. Search
  for the other derived-file site (stem separation) doing the same.
- Verify immutability first: grep for writes (`inverseMap[`, `.set(` on it).
  Nothing writes it; re-analysis builds a fresh array. If a write exists,
  **STOP-ASK**.
- Replace the copies with the reference. Test: a derived file's
  `spectrogramData.inverseMap` `toBe` the base file's.

Commit: `⚡️ (files): share the inverse map with derived files`

### Task 0.4 — honest budget accounting

- After 0.1, `CPU_BYTES_PER_TEXEL_FILE = 24` in `gpu-budget.ts` is truthful;
  the reference-equality test from 0.1 guards it.
- Add the history cache budgets (`historyCacheBudgets` in history-manager.ts)
  as a fixed overhead term in `usedBudgetFraction` /
  `remainingCoefficientBudget` — a constant, not per-texel.
- Update `gpu-budget.test.ts` accordingly.

Commit: `🐛 (budget): charge the history caches and pin the CPU rate`

### Phase 0 exit

- Suite and typecheck green; addon tests untouched.
- **MEASURE**: fresh 60 s stereo file open, no stroke — renderer memory before
  vs after the four tasks (diag sampler in the log file, Help → Show Log File,
  or Activity Monitor). Expect ~200 MB lower at rest, ~330 MB at peak.
- **STOP-ASK**: present the measurements; Rob decides whether Phases 1–4 run.

Status: done, awaiting the go/no-go on Phase 1.

---

## Phase 1 — display pyramid (1–2 weeks; scaffolding, no saving)

Purpose: `display.frag` stops reading the canvas FBOs. That read is what forces
the whole canvas to stay GPU-resident, so Phase 3 cannot land without this.

Design:

- New `src/renderer/src/lib/display-pyramid.ts` owning a stack of RG16F dB
  textures (`20·log10(mag + 1e-7)`; the display never reads phase — keep that
  exemption for every write path). Level L holds the file at time step 2^L,
  bands kept whole. Every level at or under a fixed texel cap (start:
  16M texels ≈ 64 MB total) is always resident, so the whole file is visible
  at every zoom.
- Finer detail than the resident cap comes from small fixed-size tiles around
  the visible span, cut on demand and held in a byte-budgeted LRU
  (`display-tiles.ts`). In this phase, tiles are cut from the in-RAM
  `packedData`; Phase 2/3 swaps that source for the block store behind the
  same function, so the display code does not change again.
- Build at analysis (GPU pass over the packed texture, reusing the instanced
  range-quad draw); patch at commit from the footprint ranges (the patch path
  in `patchFBOData` shows the pattern).
- `display.frag` picks the level whose bin density best matches screen pixels
  and blends between adjacent levels to avoid a visible step. The hover
  preview keeps its current mechanism (`previewBinRangesTex`).
- Level choice is view-driven CONTENT, which is fine; residency stays fixed.

Tests:

- Parity: committed picture from the pyramid vs the FBO read, ≤1 grey unit,
  at whole-file zoom and at 8× (adapt the parity-test pattern; a version
  exists on branch `paging-windows` for reference — read it, do not merge it).
- Patch-on-commit mutation check: skip the patch, test must fail.
- **MEASURE**: pan/zoom frame times on a 120 s file, before vs after; must not
  regress.

Exit: no read of `fbo1`/`fbo2` remains in the display path; parity and perf
measurements pass. **STOP-ASK** with the measurements before Phase 2.

Status: done. Pyramid and tile ring both built, wired and measured. The
committed picture no longer reads the canvas at any zoom; the hover preview
still does, by the design this phase keeps.

Two figures in this section did not survive contact with the code, and the
built numbers are what shipped:

- The epsilon is 1e-9, not 1e-7. `interpolateComplex` mixes magnitudes under
  1e-9, and 1e-7 broke parity by 32 grey units next to silence.
- The pyramid cap is 5M texels (20 MB), not 16M (64 MB). 64 MB is 17% of the
  Iris 655's whole budget for one open file, and the plan's own fixed-budget
  list says 20 MB.

The tile ring differs from this section's sketch in one way that matters: its
tiles are not a fixed grid. A tile's frame span follows the zoom (256 screen
pixels wide, rounded up to the coarsest band's step), because a fixed grid
either needs hundreds of slots when zoomed out or covers a fraction of a
screen when zoomed in. The ring is therefore a screen-sized cache, not an
early cut of Phase 2's block grid; the two are separate objects.

Measured on a 120 s stereo 48 kHz file, `17e2672` (pyramid only) vs `19d2402`:

|                              | pyramid only         | with the ring        |
| ---------------------------- | -------------------- | -------------------- |
| accounted spectrogram memory | 4463 MB              | 4471 MB              |
| budget readout               | 54 %                 | 55 %                 |
| pan/zoom cadence             | 18.240 ms (54.8 fps) | 18.015 ms (55.5 fps) |
| `fileFrame(active)`          | 1.655 ms             | 1.874 ms             |

Memory is +8 MB, the ring's flat charge, and it does not grow with the file.
Cadence does not regress. The display shader costs +0.22 ms a frame for the
ring's extra reads.

---

## Phase 2 — disk-backed block store for the CPU truth (1–2 weeks)

Design:

- **Block grid** (`src/renderer/src/lib/block-grid.ts`): fixed time span per
  block, target ~2 s (~8–16 MB packed). The span in frames must be a multiple
  of the coarsest band's time step (2^maxStepLog2) so no bin straddles a block
  edge — derive it from the band layout, don't hard-code. Pure functions:
  `blockOfFrame`, `blockPixelRanges(blockIndex)` (per band, from the same
  float32-rounded offsets the shaders use — `spectrogramData.metadata`, never
  exact ints), `blocksForFrameRange`. Pin with a unit test against the dyadic
  layout before any store code.
- **Store** (`src/renderer/src/lib/block-store.ts`): tiers are RAM
  (`ByteBudgetCache` of decoded `Float32Array` blocks — reuse the class in
  history-manager.ts) over disk (zstd blocks under the file's history
  directory, one file per block, via the addon's `historyEncodePlanes` /
  `historyDecodePlanes` — both already run on worker threads). API:
  `read(blocks: number[]): Promise<Float32Array[]>`, `patch(ranges, data)`
  (in place on resident blocks, mark dirty), `flush()` (lazy writeback),
  `dispose()` (delete the directory). Analysis writes blocks as it completes.
- **Reader migration**, one at a time, each with a parity test against the
  whole-array path before the array is removed: `readCurrentPackedData` /
  `currentPackedSnapshot` consumers, commit synthesis windows (already
  regional per stroke — map the window to a block run), export, save,
  undo/redo delta application (deltas are footprint-ranged; apply per block).
  The per-file task queue (`serializeFileTask`) still serialises every reader
  against commits — keep every store access inside it.
- Inverse map: regenerate per block from the band layout with
  `host.analysis.buildHistoryInverseMap` instead of storing a file-sized
  array; the GPU inverse texture is unchanged in this phase.
- Disk hygiene: delete a file's blocks on close; sweep orphans at app start;
  report store size in the diag log.

Exit: renderer heap for a 5-minute file drops by ~the packed-array size;
paint/undo/export byte-identical on a 60 s file; suite + addon tests green.
**STOP-ASK** with measurements. (A 10-minute file still cannot open; the GPU
side waits for Phase 3.)

Status: in progress. Done so far:

- Block grid (`block-grid.ts`) and store (`block-store.ts`), with an exact
  tiling proof, a patch-during-flush version counter, copy-on-encode against
  torn writes, a serialised flush chain that `dispose` fences, and a dirty
  tier that flushes itself past the resident budget.
- The history root now lives as the block store's seed (`block-stores.ts`
  registry at `<userData>/blocks/<fileId>`): `addRootSnapshot` seeds instead
  of writing a snapshot file, `reconstruct` reads the root anchor from the
  store (falling back to the file for older histories), `resetToCurrent`
  re-seeds, close destroys the blocks, app start sweeps orphans, and the diag
  log carries `blocksMB`.
- Deviations, both approved 2026-08-26: the blocks live beside the history
  directory rather than inside it (`readManifest` wipes the history dir on a
  manifest-version bump, which would destroy the blocks), and the root
  snapshot file is replaced by the seed rather than duplicated (the store is
  read-only until the reader migration, so seed == root).
- Measured on the 120 s file (this Mac): open-to-loaded 2.7 s → 3.1 s, disk
  settle 6.7 s → 8.1 s, on-disk 271 MB → 296 MB (23 MB history + 273 MB
  blocks; per-block zstd compresses ~9% worse than one whole-file pass). The
  plan as written would have doubled disk to ~544 MB.
- A close during a disk rebuild now drops the navigation instead of rejecting
  (`navigateToNow` catches reconstruction errors once the manifest is gone) —
  a latent race the truthful recursive-rm test stub exposed.

The store now carries the current state as well, on the copy-on-write shape
(chosen 2026-08-26 under Rob's "whatever is best while keeping it safe"):

- Seeded blocks are never rewritten. Patches flush into a `current/` overlay,
  so a torn write can only reach the overlay; the seed plus the deltas stay
  the durable truth, and a block whose size does not fit the store's grid is
  refused rather than misread.
- Commits and undo/redo hops patch the overlay in step with `currentPacked`
  (phase-turn spans included) and flush inside the per-file queue, so disk
  always holds the current state. The manifest's `overlayNodeId` names the
  node the overlay holds; it is invalidated on disk before the overlay
  changes, and a patch whose base the overlay does not hold reseeds it whole.
- A re-analysis reshapes the store to the new grid with the new state as its
  seed (`seedNodeId`); the previous seed-holder is first written out as its
  own snapshot file, so every anchor stays reconstructable and no state is
  ever stored twice.

The commit now runs windowed (2026-08-26): the addon's `commitStroke` accepts
a view — a buffer holding only a frame span of the file, block-aligned, with
every packed access translated through a per-band origin — and validates each
pass's reach against it before touching anything, so a view that falls short
rejects with the buffer untouched. Tail turns come back unapplied
(`tailApplied: false`); the caller shifts them with the addon's own float
arithmetic and collects the residuals. Byte-for-byte parity with the
whole-file commit is pinned in the addon suite (audio, patch, tails,
residuals, onsets, levels), and `commit-view.ts` maps the view's gather and
scatter on the renderer side, falling back to the whole state if the addon
refuses the view. Measured live on the 120 s file: the same brush stroke
committed windowed in 191 ms against 1.4–1.8 s for a whole-file pass, and the
current tier followed the stroke and the undo hop. Export and save turned out
to read the audio channels, not the packed state — nothing to migrate there.

Remaining: the in-place packed truth itself — the stroke-commit base and
`addStroke`/hop walks working per block instead of on one whole-file array,
and the texture uploads reading the store transiently — then the per-block
inverse map, and the renderer-heap exit measurement.

---

## Phase 3 — block-resident canvas (2–3 weeks) — the class change

Design:

- **BlockCanvas**: the canvas FBO pair, per-block, in a fixed-budget GPU LRU.
  A stroke acquires, at stroke start, the blocks under the brush plus each
  active effect's declared halo; scratch is sized to the acquired set and never
  grows mid-stroke. Commit reads back per-block footprints (the existing
  footprint readback, per block); blocks release by LRU, not at commit.
- **No stall on a cold block:** disk read + decode are already off-thread.
  Upload in row slices (2–4 MB per frame) during idle frames ahead of the
  brush. Prefetch on hover before mousedown and along drag direction during
  the stroke. If the brush outruns prefetch, the stroke keeps recording and
  the block's dabs replay when it lands (~100 ms visible trail, never a
  freeze). If the trail proves noticeable, halve the block span.
- Original/pristine reads come from the block store on demand; the whole-file
  pristine texture and its CPU backing are gone.
- Per-block addressing retires the 2^24 ceiling and its cap.
- Budget: charge the fixed caches, not per-file texels; admission stops
  depending on length. Update the memory readout copy per docs/copy-style.md.
- **Temporary gate:** whole-file effects (evolve, sort, convolve, transmute,
  attract, wrap 1|3) refuse on files whose packed size exceeds the GPU cache,
  with a plain message, until Phase 4.

Order inside the phase: (1) block canvas behind the existing renderer API with
whole-file-sized cache (pure refactor, parity-tested byte-identical), (2)
shrink the cache + acquisition/prefetch, (3) late-dab replay, (4) budget and
gate. **STOP-ASK** after (1) with the parity result.

Exit: a 10-minute file opens, paints, undoes and exports on an 8 GB machine at
≤ ~1 GB resident; committed strokes byte-identical to the whole-file path on a
small file; a cold-jump stroke drops no frames (measure with the Playwright
driver).

Status: not started.

---

## Phase 4 — whole-file effects inside the budget (1–2 weeks)

For each gated effect, **MEASURE its true reach first** (what it actually reads
at the settings the app allows), then record the decision in a reach table in
the effects registry:

- convolve: streamed overlap over blocks.
- evolve, attract: bounded reach, streamed iterations where the algorithm
  allows.
- transmute, wrap 1|3: bound or stream to match the measured reach.
- sort: the hard case — a global sort has no block form. Either an addon
  implementation streaming from the block store, or a documented range cap.
  **STOP-ASK** with the measurements; Rob picks.

No memory change; this phase removes the Phase 3 gate so the ~0.9 GB figure
covers the full effect set.

Status: not started.

---

## Risks

- MAX blending on R16F on ANGLE/Metal and ANGLE/GL (Task 0.2) — the capability
  test runs first.
- Root-alias drift on texture re-upload paths (reload, context restore) —
  covered by the Task 0.1 test list.
- Block-grid alignment with the nested dyadic bin grid — one wrong edge and
  brush membership staircases; the grid test lands before any store code.
- The cold-miss trail (Phase 3) — bounded by block size.
- The Phase 3→4 window where whole-file effects refuse on long files.
- Disk growth from many open long files — per-file stores, cleaned on close,
  surfaced in the diag log.
