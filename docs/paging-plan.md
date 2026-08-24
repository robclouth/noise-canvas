# Paged Residency

Reviewed twice against the source (Codex, Gemini) on 2026-08-24. Every claim below that says "verified" was checked at a file and line. The findings from that review are folded in; where a first draft was wrong, the correction is stated rather than the original.

## Why

GPU memory costs 148 bytes per packed texel (`gpu-budget.ts`: 56 per file, 68 scratch, 24 CPU on unified memory), and texel count is fixed by duration: about 4.5 texels per input frame at every Resolution setting. Memory therefore scales with file length and nothing else. A 60 s stereo file holds 1.8 GiB while painting; five minutes holds 9.0 GiB.

The August 2026 work (`docs/perf-low-end-mac.md`) cut the constant as far as it goes: depth buffers removed, masks and modulator targets to half precision, the modulator MRT made lazy, and — as of `07a5e67` — the pass buffers allocated on first use, which drops a default brush from 132 to 100 resident bytes per texel. The charge stays at 148 because a brush can grow at any time.

Everything else that was priced:

| Lever                                            | Saving                 | Verdict                                                                                                                                                                                                                         |
| ------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feature stripping (Reduced Mode)                 | 148 → 116              | Rejected and reverted. 24 s → 31 s of admissible audio on a 1.5 GB device, for real feature loss.                                                                                                                               |
| A mono packed layout                             | 148 → 92               | Rejected. Changes the on-disk packed format, which wipes history — and history _is_ the painted state for a reopened file.                                                                                                      |
| Charge the budget for what is actually held      | 0                      | **Worth doing now, independently of this plan.** The pool starts at 20 B/texel (`stroke-scratch-pool.ts`) but is charged at 68 up front, so admission refuses files it could open. Reporting and admission only; no memory won. |
| Page only the pristine texture and inverse map   | 24 GPU + 8 CPU B/texel | Worth doing later. About 22 %. Does not change the scaling with duration.                                                                                                                                                       |
| Delete the inverse map, derive it in range draws | 8 GPU + 8 CPU B/texel  | Blocked by full-screen draws, which take no per-band varying, and by Sort, which needs a neighbour's band and frame. Revisit alongside the GPU-generated window map.                                                            |
| Split into RG16F magnitude + RG32F phase         | 4 B/texel              | Dead end. Every read becomes two fetches across 11 GLSL units.                                                                                                                                                                  |
| Footprint-sized `fbo2`                           | —                      | Dead end without the same remapping this plan does. The 2026-08 verdict stands (`docs/perf-low-end-mac.md`).                                                                                                                    |
| Whole-file magnitude, windowed phase             | —                      | Dead end. A phase miss during ordinary painting needs the same gather, reach and tile machinery as paging, for less of the saving.                                                                                              |

None of them touch the whole-file FBO pair that dominates duration-scaled residency. Paging is the first design that does, and it costs no sound quality, which rules out the remaining alternative of importing at a lower sample rate.

## The idea

Stop treating "the file" as the unit of residency. Keep two things instead:

- **An overview** — the whole file, decimated, magnitudes only, in dB. Backs the display wherever the window does not reach. Grows with file length, but at 1/64th the rate.
- **A window** — the visible viewport plus whatever a stroke reads or writes, at full precision. Its size is a **setting**, not a function of file length.

The packed array on disk is the backing store. Memory stops scaling with duration.

## What the current code already gives us

Verified in the source, with the review's corrections applied:

| Piece                                    | Where                                  | What it actually gives us                                                                                                                                                                                                |
| ---------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A choke point for _canvas_ display reads | `fetchDisplayTexel`, `display.frag`    | Every canvas display sample goes through it, including both taps of `sampleDisplayInterp`. **Image export does not** — `export.frag` samples through `sampleSourceInterp`, so there are two display paths, not one.      |
| A per-band range table, already exact    | `previewBinRangesTex`, same function   | It picks preview-versus-committed per texel from a per-band `[start, end)` table written by the same code that builds the draw ranges. The pattern generalises; the residency test itself does not reuse it (see below). |
| The display never reads phase            | `display.frag`, `export.frag`          | Only `.x` of each `interpolateComplex` result reaches the colour block, and `interpolateComplex` derives its magnitude from magnitudes alone. Verified for both display paths. The overview can be magnitudes only.      |
| Left-edge dyadic bins                    | `gaborator-addon.cpp`, `coef-patch.ts` | `len = ((numFrames-1) >> stepLog2) + 1`, `inverseMap[i] = i * timeStep`, `minFrame = k0 << stepLog2`. Bins really do sit at `k·2^s`. This is what makes the window alignment below exact.                                |
| Time window to packed ranges             | `coef-patch.ts`                        | The mapping arithmetic is there, inside an apply-and-mutate function. It has to be extracted, not called.                                                                                                                |
| Range algebra                            | `pixel-ranges.ts`                      | Merge, subtract, gather and scatter over packed ranges, tested. Reusable as is.                                                                                                                                          |
| Partial GPU upload                       | `patchFBOData`, `stroke-renderer.ts`   | Scatters only changed packed pixels, 1–7 ms. Its 50 %-of-texture fallback needs re-tuning against window texels.                                                                                                         |
| Drawing arbitrary ranges                 | `range-quads.ts`, `range-quad.vert`    | Instanced quads over packed pixel ranges. Reusable as is.                                                                                                                                                                |
| The decimation rule                      | `max-pyramid.ts`                       | Precedent only — a CPU max pyramid over a 1-D `Float32Array` for the navigation strips. It tells us max, not mean, so transients survive zoom-out. The overview needs its own reducer.                                   |
| Partial synthesis                        | `files.ts`, `C++ synthesis {partial}`  | Synthesis narrows its **time span**. It still indexes one contiguous packed buffer.                                                                                                                                      |
| Packed state on disk                     | `history-manager.ts`                   | The backing store's format and writer already exist.                                                                                                                                                                     |

The recorded 2026-08 verdict — that `fbo2` cannot shrink because every read site would need remapping — was right about the count of read sites. This plan accepts that cost and enumerates it below.

## The numbers

Overview at RG16F (4 B/texel) decimated 16× in time is 0.25 bytes per original texel. A 15 s window at 48 kHz is 3.24 M texels at the full 148 B. All figures MiB, consistently.

| File                           | Texels |    Today | Paged, 15 s window |       |
| ------------------------------ | -----: | -------: | -----------------: | ----: |
| 60 s stereo                    |   13 M | 1835 MiB |            460 MiB |  4.0× |
| 71.2 s mono (the field report) | 15.4 M | 2174 MiB |            461 MiB |  4.7× |
| 5 min stereo                   |   65 M | 9174 MiB |            473 MiB | 19.4× |
| 20 min stereo                  |  259 M | 35.7 GiB |            519 MiB | 70.4× |

The 20-minute row is **out of reach for paging alone**: Stage 0 measured the addressing ceiling at 2^24 frames, which is 349.5 s at 48 kHz. It stays in the table because the memory arithmetic is what it is, and because the row is what integer addressing would buy on top of this plan.

Two things that column does **not** say, and the first draft wrongly implied:

- **It is the figure after Stage 4, not after Stage 3.** Until the CPU backing store lands, `packedData` stays whole-file at 16 B/texel — 3.9 GiB on its own for 20 minutes, on top of the window. Each stage below states its own peak.
- **It excludes audio.** `file.audioBuffer` is 440 MiB for 20 minutes of 48 kHz stereo float32, and partial synthesis copies every channel again in C++. Paging the spectrogram does not page the audio, and at these durations audio becomes the second-largest allocation. It needs its own plan or its own budget line; it is out of scope here but must not be out of sight.

Window size becomes the memory setting: 8 s holds about 250 MiB, 30 s about 930 MiB. That is the honest version of a low-memory mode — less of the file resident at once, rather than fewer features or less bandwidth.

---

# The design

Four decisions carry the plan.

## 1. The window is a frame span aligned to the coarsest dyadic step

```
align = 1 << max(bandStepLog2s)
windowStartFrame ≡ 0 (mod align),  windowEndFrame ≡ 0 (mod align)
```

Under that alignment every band's first window bin is exactly `windowStartFrame >> stepLog2[band]`, with no rounding disagreement between bands, and every band gets at least one bin because the window spans at least `align` frames. **Both reviews verified this against the addon's own layout arithmetic**, and it earns more than it was claimed to: Sort's neighbour lookup (`sort-effect.frag`, `absoluteFrames = timeIdx * timeStep`, then divide by the neighbour's step) stays correct in window-relative frames without an edit, purely because of the alignment.

Every shader that addresses packed data does

```
timeInFrames = uv.x * frameCount
scaledTime   = timeInFrames / exp2(bandTimeScaleExp)
```

and the windowed form subtracts the window origin before the band scale. Unpacked UV therefore stays in file space everywhere outside the addressing helpers — brush space, modulators, onsets, grid and mouse mapping are untouched. That part of the first draft survives. Three parts of it did not:

**a. The residency test does not exist yet. It is not the existing bounds check.**
`bandTimeIndices` **clamps** — `clamp(scaledTime, 0.0, frames - 1.0)` — and discards the fact that it clamped. `packedInterpBins` outputs only the clamped indices, so a test in `fetchDisplayTexel` downstream of it always passes. The same clamp sits in `readPackedData` and in `attractPackedRead`, so out-of-window **effect** reads return window-edge data silently. That is worse than a crash and it is the single most dangerous thing in this plan.

The fix is a signature change, not a third case: `bandTimeIndices` gains an `out bool resident`, decided in **file frames before the band scale**, and both `packedInterpBins` and `readPackedData` thread it out. `fetchDisplayTexel` needs both the window bin index and the file time index, because the overview addresses itself in file space.

**b. Wrap mode wraps the window unless it is given the file's band length.**
`mod(scaledTime, frames)` with `frames = bandLength` tiles the **window** across the canvas once `bandLength` is the window's. Meanwhile `getBrushTimeCoverage` folds its offset in **file** frames, so the two disagree. `bandTimeIndices` needs the file band length as a separate modulus argument, distinct from the window's length. Wrap is an arithmetic problem as well as a reach problem.

**c. There is no single addressing site, and no single packed texture.**
Verified sites that convert a file time to a bin: `readPackedData`, `packedInterpBins`, `getTransformedSampleBasic`, `getTransformedSampleSnappy`, `getBrushTimeCoverage`, `attractPackedRead`, `attractFileFieldMag`, the convolve source and IR reads, and Sort's vertical neighbour. And there are **four** packed-texture identities, not two:

| Texture                | Bound from                                           | Reach                                               |
| ---------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| `sourceSpectrogramTex` | the file, another file, or the stroke-start snapshot | brush footprint plus effect reach                   |
| `destSpectrogramTex`   | the canvas                                           | footprint, plus Sort's and Attract's neighbourhood  |
| `attractFieldTex`      | **another open file's committed FBO**                | whole field file, by definition of Field mode       |
| `convolveIrTex`        | **another open file's committed FBO**                | whole IR file, by definition of an impulse response |

The first draft did not mention the last two at all — it confused Attract's field with Attract's scratch modulator map. So the window origin **must travel with the texture, not as a global uniform**. Carry it in the metadata texture: build the window's metadata as `numBands × 2`, row 0 as today (`bandStartOffset`, `bandLength`, `stepLog2`, `freq`), row 1 as (`windowStartFrame`, `fileBandLength`, `fileBandOffset`, spare). `fetchBandMetadata` gains a sibling and the origin arrives wherever the metadata does — including for textures added later.

**d. Float precision does not improve, and it caps the plan at 2^24 frames. Measured.**
`timeInFrames = uv.x * frameCount` is formed in **file** space, before any subtraction, so the window buys nothing. The code already records the loss (`getBrushTimeCoverage`: "frame 256 comes back as 255.99998"). Stage 0 measured it on the GPU through the real helper: bin addressing is **exact below 2^24 frames and wrong above it** — by one bin at 6 minutes and two at 20, at 48 kHz. That is 349.5 s at 48 kHz, 380.4 s at 44.1 kHz, 174.8 s at 96 kHz. **Longer files need integer or view-local addressing, which is its own piece of work.** The plan aims at about 5 minutes.

## 2. File-space packed indices stay the app's currency

Verified as the right call: `history-manager.ts`, `store/brush.ts`, `pixel-ranges.ts` and `main/lib/history-delta.ts` all trade in file ranges, and rebasing them would touch far more code than translating at the renderer boundary. The boundary is bigger than the first draft drew it.

**Outward, at the renderer's public methods:**

| Method            | Change                                                                                                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patchFBOData`    | Intersect file ranges with the window, remap, upload; drop the rest and record that the CPU array is now ahead of the canvas. Re-tune the 50 % full-upload fallback against **window** texels.                                                                                   |
| `readPixelRanges` | Map inwards; read the window; return values keyed to the file ranges. Ranges outside the window are a miss the caller must handle, not a clamp.                                                                                                                                  |
| `getFBOData`      | Becomes `getFBOData(into: Float32Array)`. Today it allocates a fresh file-sized array; paged, it must scatter a window into a caller-owned array, and callers already hold `currentPackedState()`. Left alone it would allocate and copy 1 GiB per synthesis on a 5-minute file. |
| `setFBOData`      | Gather the window out of the file array and upload it.                                                                                                                                                                                                                           |
| `applyPhaseTurns` | Sixth method, missed by the first draft. Takes file pixel indices and `packedTextureSize`; same mapping, same miss rule.                                                                                                                                                         |
| `getTextures`     | Hands out window textures **and** the window layout, so a cross-file reader knows what it got.                                                                                                                                                                                   |

**Inward, and this is the part the first draft got wrong:** the file/window split runs _through the middle of `StrokeRenderer`_, not around it. `calculateFootprint`, `calculateScissorRows`, `drawRanges` and `previewRangeTex` all need **window** pixel indices; `getDirtyPixelRanges`, `patchFBOData`, `readPixelRanges` and `applyPhaseTurns` all need **file** indices. Both read `this.spectrogramData` today. Hold `this.fileLayout` and `this.windowLayout` explicitly and never let `spectrogramData` stand for either.

**And two things outside the renderer do need edits after all:**

- `store/brush.ts` gates its footprint-only read on `base.length === textureWidth * textureHeight * 4`.
- `canvas-phase-turns.ts` verifies the GPU's float addition once per process by reading back 64 sampled pixels and comparing exactly. Phase turns are band **tails**, so with a window near the start of the file most sampled pixels are not resident; they come back clamped, the verdict latches false for the process, and every later re-analysing stroke falls back to the whole-tail upload the verdict exists to avoid — with a warning each time. `samplePixelRanges` must sample only resident pixels, and the verdict must be keyed to the layout.
- `StrokeScratchPool.acquire` is called with `spectrogramData` dimensions. **That is 68 of the 148 bytes.** Leave it and a 5-minute file still holds 4.4 GiB of scratch and the Stage 2 memory target is unreachable. Size the pool to the largest **window** across open files, and never shrink it — a file shorter than the window is whole-file resident at smaller dimensions and would otherwise make the pool churn on every file switch.

## 3. The overview is the same dyadic layout, decimated in bins, holding dB

Not a dense band×time image — that would only be about 9× smaller. The overview keeps the packed layout and divides each band's bin count by `D = 16`, taking the **max** over each group of 16 consecutive bins, per channel, into RG16F: `4/16 = 0.25` bytes per original packed texel. Because bin `k` covers frames `[k·2^s, (k+1)·2^s)`, a group of 16 covers `16·2^s` frames exactly, so the overview is addressed by the file time index with `stepLog2 + 4`, reusing `packedTexel` and `fetchBandMetadata` unchanged. Bands clamp to a minimum of one bin.

**Store dB, not linear magnitude.** Half-float cannot hold the range the display offers:

- Min dB is user-adjustable to **−120 dBFS**, which is magnitude 4.6e-7. The smallest normal binary16 is 6.1e-5, about −77.5 dBFS. WebGL2 does not require subnormal support, so on a flush-to-zero driver the overview floors to black at −77.5 dBFS while the window keeps drawing to −133. The seam appears the moment a user drags Min dB below −77, and the default −70…0 range means a Stage 1 eyeball check at defaults would not see it.
- `MAGNITUDE_HARD_CEILING` is 1e15 against a half-float maximum of 65504. Measured: the CPU encoder **saturates** rather than overflowing, so a magnitude of 1e6 reads back 23 dB quieter than it is. (`Inf` was the first draft's claim; it is wrong for `DataUtils.toHalfFloat`, though a GPU-written RG16F target would produce it.) Either way the value is wrong.

`20·log10(mag)` over −140…+24 fits half float to a measured worst of **0.125 dB**, at the −128 end where the exponent is largest and finer everywhere the display normally sits (the first draft said 0.01 dB, which was optimistic by an order of magnitude; an eighth of a dB is still far below what the eye reads off a spectrogram). It has no subnormal region, cannot saturate, and — because `max` commutes with a monotone map — leaves the decimation rule unchanged. The full-scale offset stays **out** of the store: the display adds it, and it is a calibration the overview should not need rebuilding for.

**The seam needs a fade.** A full-precision bin next to a 16-bin max is systematically darker; blending one of each through `interpolateComplex` reads as a bright edge, not a join. Take both taps from the overview within one bin of the boundary, or cross-fade over about 8 bins.

## 4. Exactness is promised only where it can be delivered

The first draft's target — every effect tiles exactly — does not survive the source. Intermediate passes deliberately write the brush's full packed **rows** because later passes read with reach. Evolve's neighbourhood offset is `|scaleX| · 0.05` of the **whole file's UV width per iteration**, so at the default Scale X of 50 one iteration reaches 7.5 s of a 5-minute file and two iterations always exceed a 15 s window. Convolve takes up to 512 source taps. Sort walks packed neighbours against the inverse map. Transmute routes values into time and pitch reads.

So the plan divides effects, and says so in the UI rather than pretending:

- **Page-exact:** pointwise effects and finite-radius ones whose reach is expressible in seconds or beats (Blur measures in beats and is safe). These tile exactly, with a materialised halo for every intermediate pass.
- **Whole-file:** wrap mode, Evolve, Sort, Convolve, Attract in Field mode, and domain-routing Transmute. These page the whole file in, or run tile by tile with an explicit accuracy caveat, or are refused above a length. Changing Evolve's stencil from UV to seconds or beats is a separate and arguably correct fix that would move it into the first group.

---

# Stages

Stage 0 and Stage 1 are both gates. The order is deliberate: **the cheapest question that can kill the plan is asked first**, and it is not the display's frame time.

## Stage 0 — centralise addressing, then spike the two things that can kill this — **done**

No behaviour change: 1222 existing tests pass unchanged, and 29 new ones cover the addressing.

**What landed**

- **The addressing is centralised.** A `PackedBand` struct plus `fetchPackedBand`, `bandBin` (point), `bandBins` (interpolated) and `bandBinOfFrame` (from a raw file frame) in `effect-common.glsl`. Every one carries the residency flag from decision 1a and wraps over the file's band length per decision 1b. `grep -nE "[Mm]eta\.[rg]\b" src/renderer/src/glsl/` now returns nothing: no shader reads a band offset or length out of a raw `vec4` any more. The remaining `fetchBandMetadata` callers read only centre frequency and step exponent, which no window changes.
- **The window origin travels in the metadata texture**, exactly as decision 1c requires. `fetchPackedBand` reads row 1 when the texture has one and otherwise describes itself, so a whole-file texture is unchanged and every existing 1-row texture — including all four packed identities and every test fixture — keeps working untouched.
- **The sentinel exists.** `markResidency` poisons a non-resident read under `#define PAGING_SENTINEL`, and is compiled out otherwise.
- **`lib/window-layout.ts`** with `windowAlignment`, `alignWindow`, `buildWindowLayout`, `buildWindowMetadata`, `buildWindowInverseMap`, `windowFileRanges`, `mapFileRangesToWindow` and `frameSpanOfRanges`. 17 tests.
- **Sort and Convolve now report misses instead of absorbing them.** Sort takes the neighbour's window bin from `bandBinOfFrame` against the file frame the inverse map holds, and bails when it is not resident. Convolve bounds-checks its source and IR taps in file bins, then tests residency separately, so a tap the window misses is distinguishable from a tap past the end of the file.

**Spike A — precision. Answered: the ceiling is 2^24 frames, and paging cannot lift it.**

Measured on the GPU through the real helper (`paging-precision.test.ts`), over contiguous runs at the start, middle and end of each file:

| File             |   Frames | Worst bin error, top band |
| ---------------- | -------: | ------------------------: |
| 1–5 min @ 48 kHz | ≤ 14.4 M |                     **0** |
| 6 min @ 48 kHz   |  17.28 M |                         1 |
| 20 min @ 48 kHz  |   57.6 M |                         2 |

The break is at 2^24 frames, where float32 stops naming every whole integer — **349.5 s at 48 kHz, 380.4 s at 44.1 kHz, 174.8 s at 96 kHz**, all three verified. Decision 1d said the window buys no precision because `uv.x * frameCount` is formed in file space before any origin comes off; that is confirmed, so **the 20-minute row in "The numbers" is not reachable by paging alone.** It needs integer or view-local addressing, which is a separate piece of work with its own risk. Two caveats worth keeping: the error is not monotonic in duration — it depends on how a particular frame count factors, so 10 minutes measures cleaner than 6 — and a sparse probe misses the worst case, which is why the figures above come from contiguous runs.

**Spike B — half-file correctness. Answered for addressing; not yet for a whole stroke.**

`paging-window.test.ts` renders the real helpers against a whole-file texture and against a window gathered out of the same file, with a distinct magnitude in every packed pixel so a mis-addressed read cannot pass:

- A whole-file window is **byte-identical** to the file, and reports every read resident.
- A half-file window matches the file **exactly** at every resident read, at five different window offsets, and reports every out-of-window read as a miss rather than clamping.
- With a wrapping time axis, a window tiles the **file** — probed a full file length past the end, where a window that wrapped itself would land somewhere else.

The suite was mutation-checked; each of the three failure modes the reviews found is caught:

| Mutation                                 | Result       |
| ---------------------------------------- | ------------ |
| `resident = true` (the old silent clamp) | 2 tests fail |
| wrap over the window instead of the file | 1 test fails |
| ignore the window origin                 | 3 tests fail |

**What Spike B does not yet prove:** the plan asked for the existing `stroke-renderer.test.ts` and `effects.test.ts` to run under a forced half-file window. They cannot yet — `StrokeRenderer` sizes its FBOs, its scratch pool and its footprint from `spectrogramData`, and splitting `fileLayout` from `windowLayout` is Stage 2 work. So the _addressing_ is proven exact under a window; a whole stroke through the page-exact effect set is not. The golden test still belongs before Stage 3's tiling code, as planned.

**A fourth silent failure mode, found while doing this.** A GLSL compile error is silent: three logs nothing the test harness surfaces, the draw produces a black target, and the suite reads it as an effect that output zeros. A `vec4` passed where a `PackedBand` was expected cost real time to find because `attract-effect.frag` was not in any compile check — `shader-compile-perf.test.ts` draws every effect but asserts only timing. `shader-compile.test.ts` now globs `glsl/*.frag` and `glsl/*.vert` and asserts each compiles, naming the file that failed, in about 250 ms for all 22. This belongs on the risk list beside the other silent failures.

**Still open from this stage:** the diag lines (`[paging] gather`, `[paging] overview update`, `[paging] miss`) wait for the operations that emit them, in Stages 1 and 2.

**Gate: passed.** The addressing is exact under a window, and the precision ceiling is known.

## Stage 1 — the overview, the display fallback, and image export — **landed, except what Stage 2 has to supply first**

**Landed**

- **`lib/overview.ts`.** `buildOverview` and `updateOverviewRanges`, over a layout that is the file's own with each band's step exponent shifted by 4, so `packedTexel` and the band metadata read it with no special case. Max, not mean, per channel, stored as dB in RG16F. 13 tests, mutation-checked: switching max for mean fails 5 of them, and updating only the first group of a straddling range fails 2.
- **Two claims corrected by measurement**, both in decision 3 above: the CPU encoder **saturates** at 65504 rather than overflowing to `Inf`, and dB quantisation is **0.125 dB** at the −128 end rather than 0.01.
- **`glsl/overview.glsl`.** `sampleOverviewMagnitudes` returns the overview in the `(magL, phaseL, magR, phaseR)` shape a packed read returns, so the caller's band interpolation and dB mapping are untouched; `overviewBlend` gives the overview's share.
- **`display.frag` falls back and fades.** `bandResidencyMargin` (in the addressing block, so it reuses `bandFirstBin` rather than re-deriving) drives an 8-bin cross-fade; beyond the window the overview is taken whole. `bandIsWholeFile` guards it — without that, the fade fires at the **file's own first and last bins**, where nothing is missing. Found by writing the test, not by reading the code.
- **`overview-display.test.ts`**: a whole-file texture takes nothing from the overview; beyond a window the overview is taken whole and well inside it the window is; the seam is monotone and spreads over the full 8 bins rather than stepping; and the level read out sits between the two overview bins the read blends, matching a group's own peak exactly when probed on a group boundary.

**Still open**

- **App wiring — landed.** `file-renderer` builds the overview on load, on `reloadTextures` and on `setFBOData`, updates it from `patchFBOData`, and binds `overviewTex` / `overviewMetaTex` / `overviewActive` to the display material. `buildInPlaceWindowMetadata` describes the whole-file packed texture as if only a window of it were resident — row 0's offsets still address the file's own texels, so a resident read does not move — and `__paging.setPretendWindowFraction(f)` turns it on in a dev build. Only the display material takes it; the shared metadata texture stays whole-file, so painting is untouched. Verified on the GPU: inside the pretend window every read matches the file exactly, outside it every read reports a miss, and dropping the offset fix-up fails the test.

  **Two costs this leaves on the table**, both worth measuring before Stage 2 changes the path anyway. `patchOverview` sets `needsUpdate`, and three re-uploads the _whole_ overview — about 16 MiB on a 5-minute file, by `texImage2D`, so it reallocates as well. A row-span sub-upload would help a pitch-narrow stroke (band offsets rise monotonically, so a contiguous band range is a contiguous row range) and nothing else. Separately, `restoreSpectrogramFromFull` calls `reloadTextures` and then `setFBOData`, so that one path rebuilds the overview twice; a guard on the source array is unsafe, because the history manager also walks its packed array **in place**.

- **`export.frag` — deferred to Stage 4, not skipped.** Unchanged, and it still samples the whole file's UV range through `sampleSourceInterp`. It breaks the moment Stage 2 lands. The fix is to render it in horizontal tiles, paging the window across the file, since export is offline — but tiling needs the ability to build a window texture for an arbitrary span out of the CPU backing store, which is Stage 2's gather and Stage 4's chunk provider. It cannot be written before them. The overview backs the quick preview only. Reading the overview is nearly free and loses nothing in the high bands (an 8K export of a 5-minute file spans about 1875 frames per output pixel, so a 16× overview still supplies over a hundred bins there), but the coarsest bands — whose bins already span tens of milliseconds — become 16× coarser again and visibly blocky. Set `timeTaps` against whichever stride is in play. Snapshot capture uses `displayMaterial` and already follows the display fix.
- **The scissored variant**, which is a mitigation for a gate that is still unmeasured, so it waits for the measurement. Residency depends on time only, so "inside the window" is a contiguous interval of screen x, and a view draws in up to three scissor rects with the window rect compiled with the branch defined out. Register the second program in `precompile-shaders.ts` — the warmup cache keys on source text, so it is a distinct program and will otherwise stall on the first pan across a seam.

**Gate: not yet measured, and it needs hardware this work cannot reach.** The display pass's GPU cost on the Iris 655, with `EXT_disjoint_timer_query_webgl2` around the display draw rather than `[frame] cadence` — the canvas runs `frameloop="demand"`, so gaps quantise to vsync and a 3 ms regression inside a 16.7 ms budget reads as identical p50, and the cadence ring holds only about 34 s. **Threshold: display-pass GPU time grows by no more than 20 % at 1× zoom on a 5-minute file, or the scissored variant recovers it.**

**Also unchecked: the by-eye pass at Min dB −110**, not at the default −70, on material with sharp transients — does 16× read mushy, and does the overview floor hold? The arithmetic says it should (dB has no subnormal region), but the question was always visual.

### The seam, measured in the app, and what closed it

Driven with Playwright on a 240 s file, the pretend window at 0.5, Min dB −70, 1× zoom: **outside the window read 100 against 77 inside it** — a bright block over half the lane, not the join the 8-bin fade was written to hide. The fade cannot help, because the step is not at the boundary; it is between what the two sources _are_. A screen pixel at 1× zoom on that file spans about 5600 frames. The window read point-samples one bin of the hundreds under the pixel; the overview read returns a max. The window is the one that is wrong: it drops transients on zoom-out, and it always has.

So the source is now decided by **zoom, not by residency**: `overviewZoomBlend` ramps from the window to the overview as an overview bin falls from twice a screen pixel to half of one, and `overviewBlend` returns the larger of that and the seam fade. Because the ramp depends on the zoom alone, it is equal on both sides of a window edge and adds nothing there. `fwidth(uv.x)` supplies the frames per pixel, taken before the band branch, which varies within a quad.

That alone fixed the top half of the lane and left the bass stepping by up to 32. The cause was the fixed 16× decimation: a band's overview step is `16·2^s`, and `s` spans about eight octaves, so the crossover zoom differed by 256× between the top band and the bottom one, and the two sides of the edge disagreed wherever a band had not yet crossed. **The overview now decimates to one time step**, `OVERVIEW_STEP_LOG2 = 11` — 2048 frames, about 45 ms — per band, `2^max(0, 11 − s)` bins into one. A band already coarser than that keeps its own bins, so the overview _is_ the file there and both sources read the same level exactly. One `overviewStepLog2` uniform drives the ramp, so the crossover is simultaneous in every band and no band boundary shows a join either.

Measured again the same way: the step is **under one unit of 255 in every band**, zero in the two lowest groups, and at 64× zoom the window-on and window-off frames are byte-identical. The overview also got smaller — 1.64 M texels against 2.97 M on that file, 6.6 MiB against 11.9 MiB, and 167 ms to build against 210 ms.

Two things this leaves. The zoomed-out picture is now brighter than today's app draws it (mean 89 against 77 at 1× on that file) because it stops aliasing; nothing changes for a whole-file texture, where `bandIsWholeFile` still returns 0. And the overview is no longer a fixed fraction of the file: bands whose own step is at or past 2048 frames cost a full RG16F texel each, so `gpu-budget.ts` must charge `layoutPixelCount(buildOverviewLayout(file))`, not `filePixels / 16`.

## Stage 2 — the window becomes real for display

### What the first paged windows showed

`window-policy.ts` chooses the window from the view: the visible span widened by half its width on each side, capped, aligned. The margin is the hysteresis — the window is kept while it still covers the view, so panning inside the margin costs nothing. `file-renderer` moves the window from the frame loop, because that is where it can act before anything reads the textures it is about to replace. A move drops the canvas and puts the history's packed state back on it, so it waits for everything on the canvas to have reached the history: no dab in flight, no stroke, no queued file task, no canvas patch stash.

Measured on the 240 s file with `__paging.setPagedWindows(true)`: at 8× zoom the window holds 11,934,864 of the file's 47,398,184 texels and a move costs 95–190 ms; at 256× it holds 442,032 and costs 7–14 ms. The move is the gather the plan asked to measure, and at the wide end it is a visible stutter — splitting it by band range across frames is still open.

**The paged display does not match the whole-file display, and the paged one is right.** A packed texel is addressed by adding a band's offset to a bin index in a float32. Past 2^24 that sum stops naming texels one at a time: the step is 2 texels above 16.8 M and 4 above 33.6 M, and **64.6 % of that file sits past the ceiling**, so up to four consecutive bins resolve to one texel. Measured on the rendered pixels at 256× zoom, runs of equal value along a row average 2.99 with the whole file and 1.80 with a window. Decision 1d withdrew the float-exactness argument for the inverse map; it stands for the packed texture, and paging is what removes it. `DEFAULT_WINDOW_POLICY.maxPixels` is `EXACT_ADDRESS_PIXELS = 2 ** 24` so a window is exact by construction rather than by luck.

The crossover to the overview sits at **one overview bin per screen pixel**, ramping to four. Below one bin per pixel the overview is coarser than the display and the window still resolves more; above it the overview loses nothing and the window's point sample is the read that aliases. The first draft crossed at half a bin per pixel, which mixed in something coarser than the screen and read as a brightness lift at zoom levels where the window was still the better source.

Memory drops for the first time.

- Allocate `fbo1`, `fbo2`, the pristine packed texture and the inverse map at window size — **and the scratch pool**, sized to the largest window across open files.
- Split `fileLayout` from `windowLayout` inside `StrokeRenderer` per decision 2.
- Change `getFBOData` to fill a caller-owned array. Guard the aliasing: the addon takes inputs by reference and writes the commit patch in place, so a paged read must not hand back an array the paint path also patches while a promise is in flight.
- **The inverse map is generated on the GPU** by a range-quad pass, removing an 8 B/texel CPU array. Set `NearestFilter` explicitly on the render target — `packedToUnpackedUv` uses a filtered read, and a linear filter blends frames across band boundaries. **Keep its frames in file space**: Sort reads `neighborInvRG.r / destFrameCount` raw, so window-relative frames would push its brush-membership guard permanently false and turn Sort into a silent no-op. That drops the float-exactness argument, which decision 1d already withdrew.
- Gather on view change with a margin and hysteresis. **Measure the gather** — 3.2 M texels is a 50 MiB upload — and if it stutters, split it across frames by band range.
- `gpu-budget.ts`: charge per window texel for the resident buffers, per overview texel (from `buildOverviewLayout`, not a fixed fraction) for the overview, and per file texel — until Stage 4 — for `packedData`.
- Painting stays confined to the window, and **the refusal must be real**: the footprint is the write set, and every clone, transform, blur and evolve read is larger. Without the Stage 0 residency flag this stage does not refuse anything — it paints window-edge data smeared across the read, with no log line.

**Exit:** measured memory on the three files, with the scratch pool included, plus the sentinel test green. Peak still includes whole-file `packedData`. Shippable behind the hidden switch.

## Stage 3 — painting inside the window

- `lib/stroke-reach.ts` (new): the file frame span a stroke will **read**, from the resolved step parameters and the effect chain — `sourceTimeOffset`, `sourceTimeScale` and their modulated extremes, each effect's declared stencil, and the whole-file cases from decision 4.
- At stroke start: `required = footprint ∪ reach`. Inside the window, paint. Inside the budget, widen and re-gather **once, at stroke start** — never mid-stroke, which would move the ping-pong state under the dabs. Otherwise tile, or run the whole-file path.
- **Cross-file sources must be asked, not assumed.** A source, Attract field or Convolve IR texture is another file's **window**, driven by that file's own viewport. Add `requestWindow(frameSpan)` to the renderer and call it at stroke start, with a budget that accounts for two or three files' windows at once. This is also what makes the source-file lane's rectangle honest.
- **Brush coverage needs the window origin.** `getBrushTimeCoverage` derives its bin from `unpackedUv.x * destFrameCount` and clamps against `bandLength`; with a windowed `bandLength` it mis-assigns bins, so the mask and envelope are **not** tile-invariant as the first draft claimed. The stroke mask also keeps a running max across dabs at local packed UV, so a page change loses the previous tile's mask — hold a stroke-global mask keyed by file ranges.
- Tiling, for the page-exact set only: per-tile stroke-start snapshot and `blendBaseTex` derived from the same stroke-start state, a materialised halo for every intermediate pass, and a tile seam that is explicitly **not** a hard edge for boundary conditioning.
- Commit patches the window, scatters to the CPU array, and updates the overview at the same choke point.
- History navigation: a hop's dirty ranges may lie wholly outside the window, in which case only the CPU array and the overview change. `fboOutOfSync` has to stay honest across that, and `restoreSpectrogramFromFull` must rebuild the window layout after a re-analyse.

**Tests:** the windowed-versus-resident golden test, written **before** the tiling code, over the page-exact set. The whole-file set gets a different test: that it correctly refuses or pages, never that it tiles exactly.

**Exit:** the page-exact set paints identically under a two-tile window; the whole-file set pages or refuses, loudly.

## Stage 4 — the CPU backing store

The least-built part, and the one to schedule most time for.

- Chunked, disk-backed packed storage in aligned frame spans, reusing the history writer's format and its full-snapshot anchors. An LRU of decoded chunks sized from the same budget.
- **The addon needs a chunk provider.** Its packed accessor is one `const float *data` with file-space band offsets, checked per band, indexed in the inner fill lambda. "Iterate chunk spans instead of indexing one array" understates it: this is a C++ accessor rewrite, and the re-analyse tail walks a band to the end of the file, so the store must serve whole bands. The alternative — assemble a contiguous buffer per call — must have its peak budgeted, because it is the thing paging exists to avoid. Design and benchmark this before committing to the stage.
- **Phase turns and history deltas are chunk-hostile today**: they mutate long file-indexed tails in place and store residuals as absolute float indices. Deltas, turns, patches, snapshots and reconstruction all become chunk-native, with chunk-relative residuals.
- Readers to convert, in dependency order: `readCurrentPackedData` and `getFBOData`, the history delta encoder and `restoreSpectrogramFromFull`, onset restore, synthesis and export, the overview updater (its 16-bin groups can straddle a chunk).

**Exit:** measured resident bytes for the longest file the Stage 0 precision spike admits, painting and exporting.

## Stage 5 — the setting and the fallbacks

- Window size in Preferences, defaulted from the queried GPU budget. Copy follows `docs/copy-style.md`; the manual gains it, naming no shipped content.
- The whole-file effect set gets progress indication rather than silent slowness, and an honest message when a file is too long for it.
- The maximum-duration analysis error changes meaning — length is no longer the limit — so it and `remainingCoefficientBudget` need rewriting against the new charge.
- Docs: `docs/perf-low-end-mac.md` gains the new per-texel table; this document records what was measured.

---

# Risks, in the order they can kill the plan

1. **Silent wrongness.** Every failure mode found in review — out-of-window reads, wrap, brush coverage, Sort's inverse map, the phase-turn verdict, image export — produces a plausible wrong picture or a quietly disabled feature, not an error. Stage 0 added a fourth: a **GLSL compile failure is silent too**, and reads as an effect that output zeros. The sentinel and `shader-compile.test.ts` both landed in Stage 0; the remaining mitigations must exist before Stage 2 is switched on for anyone.
2. **Tiling correctness for the page-exact set.** The golden test is the answer and it comes before the code.
3. ~~**Float precision.**~~ Answered in Stage 0: the ceiling is 2^24 frames (349.5 s at 48 kHz), it is a property of file-space UV rather than of paging, and lifting it is separate work.
4. **The CPU backing store and the addon accessor.** The most new code, under the two subsystems with the strictest invariants.
5. **Re-gather stutter** on a pan across a long file.
6. **The display branch cost on Intel.** Demoted from first place: it is measurable, it has a known fallback in the scissored variant, and it is not what makes the plan hard.
7. **Overview drift.** Any write that skips the patch choke point leaves the zoomed-out view stale.

# Deliberately unchanged

- **Sound quality.** No decimation reaches the audio path. The overview is a display structure; synthesis always reads full-precision packed data.
- **The packed layout on disk.** Paging is layout-neutral, which is what keeps existing history readable.
- **The brush model.** No steps, effects, iterations or modulators are removed. That was Reduced Mode, and it was reverted. Some effects gain a whole-file cost on long files, which is a different thing and is stated in the UI.
- **Unpacked UV semantics.** File space everywhere outside the addressing helpers.

# Open questions

- Decimation factor. 16× and both channels are the starting assumption; the display colours left and right separately, so a summed overview changes the look when zoomed out. Stage 1 answers it by eye, at a low Min dB.
- Whether Evolve's stencil should move from UV to seconds or beats. It would move Evolve into the page-exact set and is defensible on its own terms.
- Whether the pristine packed texture can be dropped for windows and re-gathered on demand, saving 16 B/window texel for a stall on the first Original-blend stroke.
- Whether the audio buffer gets its own paging plan, or a budget line and a length limit.
