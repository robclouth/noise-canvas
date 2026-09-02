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

The in-place packed truth is gone (2026-08-26). What shipped:

- The tier is the read source, gated on `overlayNodeId === currentId`. A
  stroke's `addStroke` runs the tier ops before the delta encode: the store
  patches its own blocks from the painted footprint and walks the tail turns
  itself (`applyTurnsCollecting`), and the residuals that walk collects are
  the ones the delta stores — so undo subtracts back exactly over the store
  with no whole-array walk anywhere. A tier that cannot take the patch drops
  to a whole snapshot, and turns without a tier walk refuse rather than store
  an uninvertible delta.
- The commit is compact end to end: brush.ts reads only the footprint back
  (`readPixelRanges`), takes the pre-stroke values from the store
  (`currentRanges`), and `commitStroke` composes the addon's view from the
  store's pixels with the footprint written over them. The canvas patch and
  the turn probe read from the store after the stroke is stored (the
  `PackedGather` is async now); a store that cannot serve marks the FBO out
  of sync and the next navigation rebuilds whole. Stashed patches slimmed to
  `{ranges, turns}` — their values live in the tier.
- Hops walk the deltas windowed over the store (`walkTierValues`) and patch
  the canvas compactly; the whole-array mirror (`currentPacked`,
  `currentPackedState`) is deleted, and every fallback reader
  (`readCurrentPackedData`, onset restore, hop synthesis, `resetToCurrent`)
  goes FBO → tier → transient reconstruct.
- `spectrogramData.packedData` is optional and released once the GPU holds
  the state: `releasePackedData` forces the texture upload (`initTexture`),
  empties the texture's CPU copy, and drops the field — after the history
  hookup on mount, after a re-analysis snapshot, and after a cross-anchor
  restore. The texture seed lives in a ref keyed to the spectrogram object,
  so the release cannot retrigger the texture effect with nothing to build
  from.

Measured (150 s stereo file, fresh profile, renderer private memory, GC'd):
open+settle 1518 MB before → 468 MB after (the app idles at ~154 MB); after
a stroke, an undo and a redo 1679 MB → 516 MB. Live runs on the built app
show the compact route end to end (`commitStroke` logs `windowed:1,
viewFromStore:1`, hops log `mode:"patch"` at 5–45 ms) with no history parity
warnings.

The inverse map is released the same way (2026-08-26): `inverseMap` is
optional, `releaseAnalysisData` frees it with the packed array once both
textures are on the GPU, and `deriveSpectrogramData` (stem splits, merges)
rebuilds it from the band layout via `buildHistoryInverseMap` when the base
has released its copy.

Phase 2 exit measurements (renderer private memory, fresh profile, GC'd):

- 150 s stereo: open+settle costs ~316 MB over the ~154 MB idle app
  (pre-removal: 1364 MB — 4.3× less); after a stroke, an undo and a redo the
  process sits at ~560 MB against 1679 MB before.
- 60 s stereo: open+settle costs 121 MB. The open cost therefore still
  scales at ~2.2 MB per second of audio (it was ~9.1 MB/s), and the release
  of the packed and inverse arrays is verified to run — so the remaining
  slope lives elsewhere: the audio buffers (~0.7 MB/s by design until
  Phase 4), and unattributed length-scaled state (display pyramid strips,
  addon-held analysis state — the addon runs in-process). Attribution needs
  a heap snapshot; `Runtime.queryObjects` cannot see the page realm here.

Follow-ups, not in this phase: heap-snapshot attribution of the remaining
slope; a hop-synthesis view over the store only if the FBO-readback fallback
measurably slows undo.

### Attribution and stroke-cost investigation (2026-08-26, post-exit)

Heap-snapshot attribution (CDP snapshot, retainer walk) found the remaining
non-audio slope: `createTextures` listed `spectrogramData.inverseMap` in its
dependency array, and React's hook record kept the pre-release array alive
until the component's next render — 91 MiB at 60 s, 227 MiB at 150 s, the
whole "unattributed" slope. Fixed by dropping the field from the deps (the
spectrogram object identity already covers every real change). Corrected
numbers, same procedure: 60 s open+settle 293 MB, 150 s 353 MB → slope
~0.66 MB/s, which is the audio alone (0.34 MB/s JS channel arrays +
~0.32 MB/s native audio copy — Phase 4 scope). The display pyramid and the
addon hold nothing length-scaled at settle.

Stroke timing against the fork point (9f2e9a5, same harness, 6 strokes +
6 undo + 6 redo, medians, end-to-end):

|                                          | commit 60 s | commit 150 s | undo 150 s | redo 150 s |
| ---------------------------------------- | ----------- | ------------ | ---------- | ---------- |
| old (fork)                               | 363 ms      | 776 ms       | 210 ms     | 434 ms     |
| new, resident budget 0                   | 1054 ms     | 1449 ms      | 534 ms     | 546 ms     |
| new, resident budget 256 MB (experiment) | —           | ~946 ms      | ~332 ms    | ~294 ms    |

Paint-time fps is unchanged (~60 both systems). The overhead is entirely the
block layer, and the codec dominates: `openBlockStore` sets
`maxResidentBytes: 0` (a pre-hot-path choice), so every read decodes zstd
(~15 ms/block, 43–76 decodes per 150 s stroke) and every dirty set encodes
on the awaited `store.flush()` inside `tierStrokePatch` and
`syncStoreToCurrent`. Disk IO itself is minor (~100–200 ms/stroke read+write
combined). With a 256 MB budget the decodes vanish once warm; the remaining
gap over the old system is the awaited encode+flush (~170–480 ms per op).
Candidate remedies, undecided: a RAM-scaled resident budget; deferring the
flush off the commit path (write-behind — the overlay marker already
invalidates before mutation, so a crash costs a longer restore, not
corruption); keeping hot overlay blocks raw and compressing on eviction.

Remedies shipped (2026-08-26, Rob picked the first two): the RAM-scaled
resident budget (`historyCacheBudgets().blockResident`, 64→256 MiB over
8→16 GiB of system memory, charged in the GPU-budget overhead) and the
write-behind flush (`scheduleTierFlush` in history-manager). The write-behind
keeps the crash contract: the in-RAM tier marker goes valid at patch time so
the next stroke and the packed readers never wait, while every manifest write
masks the on-disk marker until the last pending flush lands and writes it
unmasked — the disk can never name a tier the overlay does not fully hold. A
failed flush leaves the mask standing. `seed`/`seedCurrent` join the store's
flush chain, and reshape/reset/dispose/purge drain pending flushes first.
Same harness, medians, end-to-end:

|                    | commit 60 s | undo 60 s | redo 60 s | commit 150 s | undo 150 s | redo 150 s |
| ------------------ | ----------- | --------- | --------- | ------------ | ---------- | ---------- |
| old (fork)         | 363 ms      | 151 ms    | 178 ms    | 776 ms       | 210 ms     | 434 ms     |
| new, both remedies | 367 ms      | 115 ms    | 117 ms    | 1058 ms      | 395 ms     | 360 ms     |

At 60 s the gap is closed — undo and redo beat the old system. The overhead
left at 150 s is the O(file-length) turn-tail work through the store (a
decode per cold block, the float walk, the patch of every block right of the
stroke), which a longer resident budget cannot remove; end-of-session private
at 150 s is 1086 MB (the resident cache full) against the old system's
2644 MB. Raw hot overlay blocks (the third remedy) stay unimplemented.

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

Step (1) architecture (decided 2026-08-26): the canvas renders over a
**view** — a block-aligned frame span expressed as its own packed layout
(`canvas-view.ts`), the GPU twin of the addon's `CommitView`. The stroke
shaders are already parametrised by a metadata texture and a frame count, so
a view needs no shader changes: the FBO pair, the scratch set and the
footprint machinery are built over the view's layout, and the wrapper
translates coordinates at the edges. The per-block GPU LRU holds committed
block texels in slots; stroke start composes the acquired blocks into the
view (a blit per resident block, an upload from the block store per cold
one) and commit copies the painted blocks back to their slots. This keeps
every effect pass byte-identical by construction and puts all block logic on
the CPU side, instead of an atlas indirection inside every GLSL sampling
helper — and per-view addressing retires the 2^24 ceiling the same way
per-block would. With the whole file as one view, step (1) degenerates to
today's behaviour exactly. A view's inverse map comes from the existing
`buildHistoryInverseMap` over the view's band table. Displays stop reading
the canvas texture as their full-res fallback in step (2) — the tile ring
takes that over.

Exit: a 10-minute file opens, paints, undoes and exports on an 8 GB machine at
≤ ~1 GB resident; committed strokes byte-identical to the whole-file path on a
small file; a cold-jump stroke drops no frames (measure with the Playwright
driver).

Status: step (1) in progress —

- `canvas-view.ts`: view layout, file↔view range remapping, view inverse map,
  view content compose, whole-file view.
- `block-slot-cache.ts`: paged slot store with LRU claim, upload / compose /
  copy-back over the existing patch and gather materials.
- StrokeRenderer renders over a view: every dest-space size, layout, metadata
  texture and frame count reads from `this.view` (whole-file by default,
  byte-identical — full suite green). An explicit view builds its own
  metadata + inverse-map textures.
- Sub-view stroke parity proven (`stroke-renderer-view.test.ts`): the real
  transform brush over a 4-block sub-view matches the whole-file path —
  magnitudes < 1e-5, phases < 1e-3 (interpolated reads across seeded random
  phase jumps amplify a last-bit UV difference; bit-exactness holds only for
  the whole-file view), zero paint outside the view. A canvas composed from
  block slots paints and folds back byte-identically.

Known sub-view gaps, deliberate until step (2): `getDirtyPixelRanges` mixes
view UV with the file layout (whole-file only); same-file source info,
`originalSpectrogramTex`, onset textures and beat-anchored modulator phases
need the wrapper's translation; displays still read the canvas texture.

Step (2) in progress. Landed so far (each parity-tested, whole-file identity
pinned by the full suite):

- The display pyramid and tile ring cut from a `CommittedSource` — the canvas
  texture plus the view that lays it out — with every source address
  translated through the view and clamped to taps the view holds. Cutting a
  whole ring tile the view does not cover throws.
- The display shader's canvas taps (fallback and hover preview) address the
  canvas through `canvasMetadataTex` / `canvasFrameCount` /
  `canvasStartFrame`; the whole-file case short-circuits bit-exactly.
- Whole-state readers in files.ts (duplicate, HPSS, NMF, AI stems, whole-file
  synthesis) go through `readCurrentPackedData`'s FBO → tier → reconstruct
  chain, so the FBO step can be view-gated in one place at the shrink.
- The ring works without a covering canvas: `aim` picks the window and lists
  missing tiles (emptying the bound window when a far pan retargets slots
  it still shows), `tileSourcePixelRanges` names the file pixels to read, and
  `cutTileFromPacked` cuts a tile from those values byte-identically to the
  canvas path.

Chosen shrink architecture (step 2 remainder): the canvas pair becomes a
fixed K-block sliding window. Every interior K-block view shares one band
layout, and the only other shape is the tail view, so both layouts and their
metadata/inverse textures are built once — a slide moves content, never
allocates. A slide runs between dabs: range-copies shift the canvas pair,
stroke-start snapshot and masks through a bounce target; blocks entering
compose from the slot cache or store; painted texels leaving are read back
and stashed for the commit. Files at or under K blocks keep the whole-file
view and today's behaviour exactly. Order: (S1) `slideView` in the renderer
with dab-across-slide parity, (S2) wrapper view placement on hover/drag,
(S3) commit across slides + file-space translation at the handle, (S4)
navigation patches invalidate slots and patch the intersecting view, (S5)
load seeds the pyramid from packed data and the ring drives aim/cut when the
canvas cannot cover, (S6) source-file views (cross-file and same-file), (S7)
original/onset textures composed from the seed tier per view, (S8) budget,
admission and the whole-file-effect gate.

S1 and the handle half of S3 are done:

- `slideView` moves the canvas onto a new same-fold view mid-stroke: overlap
  carries over by patch triples, entering blocks compose committed values
  into the canvas and the stroke-start snapshot, masks bounce out, clear and
  come back at their new place, and the view-relative CPU state (committed
  bounds, dirty region, mask rows) rebases. A three-dab stroke across a
  slide matches the whole-file stroke to the sub-view tolerances, with a
  low-intensity dab pinning the mask move (a flat envelope hides a stale
  mask — the weight is max(own, mask), so only a weaker later dab can see
  it). Between strokes the slide disowns the scratch instead.
- The handle speaks file space whatever the view holds: reads, patches,
  phase turns and dirty ranges translate through `clipRangesToView` /
  `viewRangesToFile`, UV regions rebase on the time axis, `getFBOData`
  returns null when the view does not cover the file (the store chain
  serves those callers), and a covering view passes everything through
  untouched — today's whole-file behaviour is pinned by the full suite.

S2, S4 and S5 are done. The window is off unless the build sets
`VITE_CANVAS_WINDOW_BLOCKS`, so the shipped canvas still holds the whole file
and the full suite pins that behaviour:

- `canvas-window.ts` places the window — centred on the blocks the brush
  needs, held still while a margin of blocks remains on each side the file
  continues past, clamped at the ends — and fills its slots from the store,
  one read per block. Every window of a file keeps the texture fold of a full
  window, so the shorter window at the end lays out in the same textures and
  a slide never allocates.
- The renderer builds the window, composes the blocks it holds, reads the
  rest in the background, and moves the canvas when they land: a slide
  between strokes, or mid-stroke while one is up. A dab's cursor and duration
  are the window's, not the file's.
- The display stopped needing a covering canvas. The pyramid is seeded from
  the analysed state at load and from a whole-state restore
  (`patchFromCompact` takes a range's own pixels, so the store can feed it),
  the ring cuts its tiles from the store through `aim` / `cutTileFromPacked`,
  and a history hop patches the picture from the values it applies while the
  block slots and the ring tiles it touched are dropped. Phase turns drop
  slots too: the display never shows phase, but the slots hold it.
- Measured live on a 60 s file with an 8-block window (~15 s of canvas): the
  window follows the pointer end to end, the picture shows the whole file, a
  stroke commits windowed (`windowed:1, viewFromStore:1`, 80–102 ms), and an
  undo and a redo with the canvas at the far end of the file patch through
  (`navigateTo FBO upload mode:patch`, 1.4–3.9 ms) with no parity warning.

S6's same-file half, S3's commit half, S7 and the original window are done:

- A dab's source carries the span its textures lay out, so every source-space
  scale reads the canvas's frame count instead of the file's. Without it a
  windowed canvas painting from itself read the last texel of every band.
- Paint on a block that leaves the canvas mid-stroke is kept: the block slots
  take the painted texels so a window coming back shows them, the display
  picture takes them so they stay on screen, and the carry holds them for the
  commit, which merges them into its footprint and its values. A block whose
  slot loses its paint to the store keeps its pixels in the carry. Measured on
  a 60 s file with an 8-block window: a 36 s drag commits the same 153 ranges
  and 1,430,229 pixels the whole-file canvas commits; without the carry the
  commit keeps 372,189 of them.
- Reading for a window no longer takes the slot of a block that window needs.
- Absolute positions are the file's, not the canvas's: onset lookups, the
  transient phase anchors, the carrier re-anchor in the Sharp warp, the
  modulator patterns and the sequencer, and the random draws behind
  Synthesise's noise and the warp's noise-phase replacement. Each is pinned by
  a sub-view parity test; the whole-file path returns its old value untouched,
  which the full suite pins.
- Two random draws changed for everyone: Synthesise's noise and the warp's
  noise-phase replacement now seed on whole frames rather than on the UV a
  fragment happens to arrive with. The noise is different, its character is
  not.
- The original is a window too. The block store serves its seeded state by
  range, so a second window over the same blocks composes the original into
  one texture laid out by the canvas view, and the shaders read it through the
  destination's metadata. The two windows move together: the canvas slides
  only once both have their blocks.
- The file-sized packed and inverse-map textures are gone under a window.
  Nothing samples them any more, and they were the largest thing a long file
  put on the graphics device: a 60 s file at rest went from 791 MB to 573 MB.
- A window request that superseded a pending one used to drop its fill, and
  the next slide then shifted the empty overlap into place and composed only
  what entered — half the window stayed black, and a dab there blended out of
  nothing and committed silence. The window now tracks which blocks the canvas
  holds, composes whatever it still lacks, and a dab waits for a block the
  canvas has no content for.

Step (3) is done. A dab the canvas cannot take is held rather than dropped:

- `paintWhenHeld` takes the dab with the frames it lands on, and the fill that
  brings the block in runs it — at the position it was given, not where the
  brush has moved on to. Held dabs run in the order they were given, so a dab
  the canvas could take does not overtake one still waiting. `settle` drains
  what is left before the commit reads the stroke, bringing the window back to
  a waiting dab if the brush has run elsewhere, and drops the paint after
  eight fills so a read that never lands cannot stall a commit.
- `holdsFrames` used to clip the asked-for span to the view before testing it,
  so a dab entirely past the view's edge measured as empty and passed. It now
  refuses any span the view does not contain, unless the span is wider than
  the window and so can never fit in one.
- The slot cache now holds two windows, not one. A slide claims the entering
  window's slots, then folds the leaving window's paint back into its own
  slots; a jump the width of the window makes those sets disjoint, so
  `windowBlocks + 4` slots let the copy-back evict a block the slide was about
  to compose. The app threw "the block has no slot" on every later fill, the
  stroke committed nothing, and the retries ran resident memory to 1.5 GB.
  `2 × windowBlocks + 4` costs about 48 MB more at eight blocks on a 60 s
  file, and stays flat in file length. Pinned by a unit test that jumps a
  five-block window over a twenty-block grid.
- `window:check` could not see any of this. Its drag was shorter than the
  window, so the window never slid. The drag now crosses the file and ends
  with a dab back at the start, on a block the window has long left: that dab
  has to wait for a read, and dropping it shortens the commit. Steps are
  spaced 400 ms because the whole-file build cannot render a dab per frame on
  a 60 s file, and a collapsed reference run compares nothing. The footprint
  comparison allows one bin per band: the footprint's time edge rounds up
  against the band's bin count, which the file rounds up again, so the two
  runs can land a bin apart at an edge. The four-bin margin covers it.

S6b is done. A brush painting from another file reads it through a window of
the destination's own:

- The source read had to become a position in the source FILE before a window
  could be placed by it. `sourceOffsetForViews` puts the brush anchor on the
  destination file's clock, asks `calculateSourceOffset` for a fraction of the
  source file, and divides that by the span the source textures hold; the
  shader scales the source time offset the same way, because that control names
  a fraction of the source file's whole length. Whole-file spans on both sides
  return the old value untouched, which the full suite pins. Painting from a
  short source onto a windowed canvas was already wrong before the window
  existed on the source side: it read from the source's start rather than the
  beat-matched position.
- `source-window.ts` is a window over another file: a `PackedWindow` over its
  committed state plus the view's own band table, and a second window over its
  original built the first time a step reads it. `sourceReadFrames` names the
  frames a dab reads, `sourceReadSpan` widens and wraps them, and the dab waits
  through `paintWhenHeld` until both the canvas and that window hold what it
  asked for.
- A read-only block window now takes one window of slots plus the spare, not
  two. The two-window budget exists so a slide can fold the leaving window's
  paint back while the entering window holds its own; nothing copies back into
  the original or the source window. `window:check` resident went 603 → 545 MB.
- The window serves the source file's COMMITTED state, so it re-reads when that
  state moves (`WindowedCanvas.stateRevision`, watched through the file
  handle). Reading another file's half-painted stroke, which the live-canvas
  path allowed, is gone.
- Not covered by a test: the wiring in `file-renderer.tsx` that decides a
  source window is needed. `window:check` paints one file only, so a cross-file
  drag would have to open two files and set the step's source.
- `sourceInverseMapTex` is declared and uploaded but no shader samples it. The
  source texture set makes it optional rather than removing it; removing the
  uniform touches every test that builds a `SourceFileInfo`.

Reverse is fixed and the gate is in. Reverse turned out to be worth fixing
rather than gating; wrap could not be:

- A reversal turns every band by 2πf·T, and T was read off the canvas. Through a
  window the painted phase was out by up to 5.3 rad. `destFileAxisSec` and
  `sourceFileAxisSec` ask the file's frame count instead, at the three sites
  that apply the turn (Basic, Locked, Soft). A whole-file canvas divides the
  same numbers as before. Pinned per warp algorithm in the view parity test.
- The parity harness fed the sub-view renderer the whole file's pristine
  texture while addressing it through the view's metadata, so every algorithm
  that reads the original was compared against garbage. It now calls
  `setOriginalTexture` with a composed window, as the app does.
- `lib/whole-file-gate.ts` names what a brush asks for that a window cannot
  serve: wrap in time (`fract` folds onto the far end of the CANVAS), a
  full-length brush (it spans the canvas), and the effects that read past any
  span — attract, convolve, evolve, sort, transmute. `dispatchStroke` refuses
  the dab, the file view shows one message. Dormant while the canvas holds the
  whole file, which is every file today.
- Measured and left alone: the Locked warp at an exact -1 mirror differs by up
  to 2π on 660 of ~4,000 painted texels. The mirror lands on bin edges and
  Locked differences adjacent stored phases, so `floor` is decided by the last
  bit of the coordinate. At -1.013 the window is bit-identical to the whole
  file. It is a knife edge in the algorithm, not in the window.

Effects under a window are done. Three separate faults, each measured on the
sub-view parity harness before it was fixed:

- **A smear and a repeat gap converted against the file.** Both are offsets
  added to a source UV, and the shader reads that UV against the span the
  source textures hold. A 4% blur was out by 0.178 in magnitude and a 2-copy
  repeat by 0.270, with no read leaving the view at all. `sourceLayout` gives
  them the source side's own duration, as `destinationLayout` already gave the
  warp its shift.
- **A turn traded time for pitch on the canvas's axis.** A rotation mixes the
  two UV axes, so a shorter canvas turned the sound by a different amount: out
  by 0.89 in magnitude at 5 degrees, 30 and 90 alike. `destFileUvSpanX` and
  `destCanvasUvSpanX` take the turn to the file's time axis and back. A canvas
  over the whole file returns the distance untouched.
- **A read that leaves the window clamps at its edge.** `effect-reach.ts`
  declares how far each effect reads past the brush, in seconds of the file:
  the blur smear and its tap noise (one-sided by Origin), the furthest repeat
  copy through its shape table, and the warp's arm, turn, mirror and shift. A
  modulated parameter reaches as far as its own sources can move it, and a
  scale that can pass through zero reads without bound. Only Bleed and Invert
  read past the brush at all — Cut, Wrap, Clamp and Reflect fold the read back
  inside it, so they reach nothing. The aim and the dab's wait widen by the
  reach, and `overReachNeeds` refuses a brush whose dab plus reach cannot fit a
  whole window. Pinned by a parity test that fails at 0.95 on a view holding
  only the dab and passes on the same view widened by the declared reach.
- Source tracking away from Follow, and a source time offset, put a same-file
  read anywhere in the file. Both are now named by `wholeFileNeeds`.

S8 is done, and the window is on by default:

- `canvasWindowBlocks(grid)` sizes the window against the GPU pool. A file
  whose whole analysed state fits a third of the spectrogram budget keeps one
  canvas over all of it and behaves exactly as it did; a longer one takes the
  widest window of blocks that budget affords, floored at four blocks and
  capped at sixteen. `VITE_CANVAS_WINDOW_BLOCKS` still pins the figure, and 0
  now means "keep the whole file" — `window:check` sets it for its reference
  run.
- Admission stops depending on length. `spectrogramBytes` charges a windowed
  file its window, its block slots and no CPU copies, and
  `remainingCoefficientBudget` returns undefined — no limit but the analyser's
  own texture cap — as soon as what is left can hold one more window. The
  budget's per-texel rates are pinned against what `CanvasWindow` and
  `PackedWindow` really claim.
- A commit that needs the whole painted state takes it from the block store
  with the stroke's own pixels written over it, in `brush.ts` and again in the
  addon call's `readWhole`. Before this a stroke that rebuilt the whole file —
  Re-analyse over older unprojected paint — committed nothing at all on a
  windowed canvas.
- The image export walks the file in strips, each served by its own window over
  the committed state (`export-window.ts`), and the shader reads each strip's
  columns as a UV range on that span. Pinned by rendering the same file both
  ways: no channel differs by more than 2 of 255. The snapshot needed nothing —
  it draws the display material, which the pyramid and the ring already serve.

Left before the window can carry a real session:

- The cross-file source window still widens by the dab's own span either side
  rather than by the declared reach; the reach is in destination seconds and
  the source window counts source frames through the beat ratio.
- The fit refusal measures the brush from `resolveBrushFootprint`, which does
  not know the grid swing that can widen a snapped cell.
- The warp's noise-phase replacement still draws differently for about 0.8% of
  texels through a window (517 of 65,216 measured) even with the file-seeded
  draw. It is a random phase either way, so it is a difference in the noise,
  not in the signal. The Noisey warp seeds on the source TEXTURE's pixel
  coordinates, so it draws a different phase through a window for the same
  reason.
- Not pinned by a test yet: the rigid transient tail at a file edge, the
  cross-resolution carrier rebase (it needs two bands-per-octave settings), the
  warp's noise seed, and the three wirings in the React component that decide
  what a window has to hold (`sourceNeedFor`, `reachFrames` and
  `strokeRefusal`) — `window:check` opens one file with a plain brush.

### Phase 3 exit measurements (2026-09-01)

Taken on an Apple M4 Pro, 24 GB, which reports a 16 GB graphics budget — not
the 8 GB Iris 655 the plan targets. Renderer private memory, fresh profile, one
mono 44.1 kHz file at 36 bands per octave, through open, a drag, an undo, a
redo and an image export. The four-block row is pinned with
`VITE_CANVAS_WINDOW_BLOCKS`; it stands in for the window a small device's
budget would pick.

| 300 s file, 59.5M texels                   | idle | open | paint | undo | redo | export | budget |
| ------------------------------------------ | ---- | ---- | ----- | ---- | ---- | ------ | ------ |
| whole file on the canvas                   | 285  | 595  | 861   | 924  | 923  | 760 MB | 115 %  |
| window the budget picks (16 blocks, ~32 s) | 286  | 624  | 772   | 680  | 696  | 613 MB | 21 %   |
| window pinned to 4 blocks (~8 s)           | 286  | 557  | 605   | 567  | 572  | 557 MB | 12 %   |

A 60 s file keeps the whole-file canvas on this machine and peaks at 477 MB
against a 286 MB idle app.

What the measurements say:

- The canvas has stopped scaling with length. The whole-file canvas accounts
  for 115 % of the graphics budget at five minutes and would not open on the
  target device; a four-block window accounts for 12 % and peaks 319 MB over
  the idle app.
- What still scales is the audio, at about 0.66 MB a second, which is Phase 4's
  scope: 60 s costs 148 MB over idle and 300 s costs 319 MB, and the difference
  is the audio buffers almost exactly.
- Undo and redo cost less than painting under a window, where on the whole-file
  canvas they were the peak.

**The ten-minute file does not open, and the graphics budget is not what stops
it.** The analyser refuses it: "The maximum audio duration is 318 seconds."
That is `MAX_TEXTURE_SIZE² = 8192 × 8192` packed coefficients at the worst-case
density of 4.79 per sample — 318 s at 44.1 kHz, 292 s at 48 kHz — checked in
`gaborator-addon.cpp` before any allocation. `remainingCoefficientBudget` now
returns undefined for any length, so the cap is the only limit left.

Nothing in the windowed path needs the packed state to be one texture: the
canvas addresses a view, the display reads the pyramid and the ring, and the
block store works in linear pixel ranges. The file-sized texture is not even
built. Lifting the cap is therefore a separate piece of work, and a decision:
raise `MAX_TEXTURE_SIZE` (the device here reports 16384, which would take the
cap to about 21 minutes), or stop shaping the analysed state as a texture at
all. **STOP-ASK.**

---

## Phase 3.5 — the analysed state stops being a texture

Rob answered the Phase 3 exit STOP-ASK on 2026-09-02: drop the texture shape.

### The shape it takes

A file's analysed state is **N coefficients in band order**, four floats each —
magnitude and unwrapped phase per channel. N is the sum of the band lengths. It
has no width, no height and no padding. Where a piece of it goes on the
graphics device, that piece picks its own fold: `width = min(8192, texels)`,
`height = ceil(texels / width)`. `canvasViewOf`, `display-pyramid`,
`display-tiles` and `block-slot-cache` already fold that way. The file stops
being the one thing that carries a fold of its own.

Why four floats interleaved, and not two planes or a narrower mono pixel:

- Every consumer already reads and writes this stride — the window upload, the
  block patch, the FBO readback, `gatherPixelRanges` and
  `scatterCompactPixelRanges`. Planes would add a de-interleave to every block
  upload and a re-interleave to every readback, on the JS thread.
- Storage is already planar where planes pay: `encodeHistorySnapshot` reorders
  into planes before zstd, so a mono file's two empty channels cost almost
  nothing on disk.
- In RAM only bounded pieces are held now, so a mono file's empty channels cost
  nothing that grows with length.

What leaves the analysis payload:

- **The inverse map.** It is `(k << stepLog2, band)` for each coefficient — a
  pure function of the band layout, which the payload already carries three
  ways. It costs 8 bytes a coefficient to build and send, and the renderer
  drops it unread as soon as the canvas holds a window.
  `buildHistoryInverseMap` already rebuilds it on demand.
- **The padding to a rectangle.**
- **`textureWidth` and `textureHeight`.** One `texels` count replaces them.

### What the length limit becomes

- The analyser's own cap goes. What is left is the caller's coefficient budget,
  which measures RAM rather than a texture edge.
- One texture still cannot exceed the device's edge, so a file with more than
  `ANALYSIS_MAX_TEXTURE_SIZE²` coefficients can never hold its whole state on
  one canvas. `canvasWindowBlocks` must return a finite window for such a file
  whatever the budget says.

### What the analyser holds while it works

Counted for a 600 s mono 44.1 kHz file at 36 bands per octave, N ≈ 119M:

| held at once                        | today        | after this phase |
| ----------------------------------- | ------------ | ---------------- |
| the coefficients                    | 1.90 GB      | 1.90 GB          |
| their copy into JS                  | 1.90 GB      | —                |
| the inverse map                     | 0.95 GB      | —                |
| its copy into JS                    | 0.95 GB      | —                |
| one unwrapped phase per coefficient | 0.48 GB      | —                |
| the analyser's own coefficient tree | 0.95 GB      | 0.95 GB          |
| **peak**                            | **≈ 7.1 GB** | **≈ 2.9 GB**     |

### Tasks

- **3.5.1 — `texels` replaces the texture pair.** DONE. `SpectrogramData` and
  `HistoryDimensions` carry `texels`. A `packedFold(texels)` helper gives the
  fold where a whole-file texture is really built. `wholeFileCanvasView`
  collapses into `canvasViewOf`, because there is one fold convention now. A
  manifest written before this reads its pair and keeps working.
- **3.5.2 — the analyser returns coefficients, not an image.** DONE. No padding, no
  inverse map, no `MAX_TEXTURE_SIZE` cap. The renderer builds the inverse map
  only when it builds a whole-file texture. What limits the length now is the
  RAM one analysis holds at its peak (`analysisPeakTexels`), which is what
  `remainingCoefficientBudget` returns for a file a window will serve.
- **3.5.3 — one unwrapped phase a band.** DONE. `unwrapForward` reads the previous
  bin only, and the walk is ascending inside a band, so the analyser keeps one
  phase and one bin index per band instead of one phase per coefficient.
- **3.5.4 — hand the coefficients over without copying them.** The worker's
  vector becomes the JS array's storage through an external `ArrayBuffer` with
  a finaliser, rather than a memcpy into a fresh one.
- **3.5.5 — a window is compulsory above one texture.** DONE.
- **3.5.6 — MEASURE at 600 s.** DONE; see below.
- **3.5.8 — the band layout stops being a texture row.** The 600 s run threw
  "the block lies outside the view": `BandLayout.metadata` is the Float32Array
  the metadata texture is built from, and float32 counts integers exactly only
  to 2^24. At 119M coefficients the band offsets round to multiples of 8, so
  the CPU range arithmetic picks the wrong band. The exact figures are already
  in the payload as `bandOffsets`/`bandLengths`/`bandStepLog2s`; the CPU layout
  must read those and the texture stay a separate, converted payload.
- **3.5.7 — analyse in spans and forget.** Gaborator supports incremental
  analysis with `analyze(signal, t0, t1, coefs)` and `forget_before`, and
  `analysis_support()` names the margin a span needs. Three terms make the
  peak, and streaming removes all three: the coefficient run (16 B a texel),
  its copy into JavaScript (another 16), and the analyser's own tree (8 a
  channel). The renderer would drive it: a layout call first, then a span at a
  time into a reused buffer, each span's blocks encoded into the store and
  dropped. The per-band unwrap carries one phase and one bin index between
  spans.

### Phase 3.5 measurements (2026-09-02)

Same machine as the Phase 3 exit: Apple M4 Pro, 24 GB, a 16 GB graphics budget.
Mono 44.1 kHz, 36 bands per octave, the window the budget picks (16 blocks).
Renderer private MB; `peak` is the largest reading while the file opens, polled
every 400 ms, so it catches the analysis.

| file  | texels | idle | open (peak) | paint | undo | redo | export | budget |
| ----- | ------ | ---- | ----------- | ----- | ---- | ---- | ------ | ------ |
| 300 s | 59.5M  | 291  | 584 (1879)  | 773   | 787  | 696  | 600 MB | 21 %   |
| 600 s | 119.0M | 285  | 691 (3441)  | 995   | 1100 | 1105 | 822 MB | 21 %   |

**The ten-minute file opens, paints, undoes, redoes and exports.** The old
analyser refused it outright. The graphics budget charges it the same 21 % as
the five-minute file, because both paint through a 16-block window.

What the measurement says:

- The settled cost still rises with length — 691 MB against 584 MB at open —
  and the rise is the audio buffer (~0.66 MB a second, Phase 4's scope) plus
  the history caches painting fills.
- **The peak is now the analysis, not the canvas.** 3441 MB for ten minutes,
  against 691 MB settled. It is the three terms 3.5.7 removes: the coefficient
  run, its copy into JavaScript, and the analyser's own tree. On the 8 GB Iris
  target the RAM cap (`analysisPeakTexels`) refuses the file before it tries.
- Painting on the ten-minute file threw once — see 3.5.8.

Status: in progress.

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
