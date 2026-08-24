# GPU Memory and Paint Performance

## Overview

This document records the memory model and the paint-pipeline costs established during the August 2026 performance work, triggered by a report of the app being "very sluggish and stuttery" on a 2019 13" MacBook Pro (2.4 GHz quad i5, Intel Iris Plus 655 with a 1536 MB shared pool, 8 GB LPDDR3, macOS Ventura). Three independent audits (in-session, Codex, Gemini) converged on the same causes; every claim below was verified in code or by measurement before it was acted on.

The work spans commits `348ebc1..3ed01a7` on `dev`. Baseline for all before/after figures is `8fd28f2`.

## The memory model

### Texel density is fixed by file length, not by Resolution

Measured with the real analyser and confirmed against nine real history manifests: the packed spectrogram holds **4.50–4.76 texels per input sample at every Resolution setting** (12 bands/octave is the most expensive, 36 the cheapest). Resolution is therefore not a memory lever; file length is. A stereo minute at 48 kHz is ~13 M texels.

### Bytes per texel

Every value is bytes per packed texel of the largest open file. "Before" includes the DEPTH_COMPONENT24 renderbuffer three.js attaches to every render target by default; nothing in the paint path ever wrote depth.

| Allocation                                        | Before         | After                               | How                                                              |
| ------------------------------------------------- | -------------- | ----------------------------------- | ---------------------------------------------------------------- |
| Canonical ping-pong pair (`fbo1`/`fbo2`, RGBA32F) | 32 + 8 depth   | 32                                  | depth removed                                                    |
| Original packed + inverse map textures            | 24             | 24                                  | unchanged                                                        |
| **Per open file**                                 | **64**         | **56**                              |                                                                  |
| Pass buffers + stroke-start snapshot (RGBA32F ×3) | 48 + 12 depth  | 48                                  | depth removed                                                    |
| Stroke masks ×2                                   | 8 + 8 depth    | 4                                   | R32F → R16F, depth removed                                       |
| Modulator MRT ×2                                  | 32 + 4 depth   | 16, **lazy**                        | RGBA32F → RGBA16F, allocated only when a step routes a modulator |
| **Scratch pool (shared across files)**            | **112 always** | **52 typical / 68 with modulators** |                                                                  |
| **One file open + scratch**                       | **176**        | **108 typical / 124 fullest**       | **−39% / −30%**                                                  |

The rollback buffer (grid-fill previews) is transient: 16 + 4 → 16, only while held.

Phase never moved to half floats: the FBO phase channel stores large accumulated values and must stay RGBA32F (see the 2026-07-07 band-centre-residual revert). Masks and modulator outputs are bounded, which is why half precision is safe there.

### What this means in files

A 60 s stereo file at 48 kHz (~13 M texels): **2.28 GB before, 1.40 GB after** while painting. The same GPU pool now holds ~1.6× more audio. On the Iris 655's 1536 MB pool, ~55–60 s of audio is now the practical ceiling; before, ~35 s already overflowed it — silently, because of the next point.

### The budget is now truthful

`GetGpuMemoryBytes` only queried DXGI under `_WIN32`; macOS fell back to `os.totalmem()`, so the Iris machine budgeted against 8 GB of RAM (4 GB after the 50% share) while owning 1.5 GB of GPU pool. The addon now returns Metal's `recommendedMaxWorkingSetSize` (`gpu-memory-mac.mm`), DXGI on Windows, and a 2 GiB cap for unknown GPUs (Linux). Files that do not fit are refused at analysis with the graceful message instead of thrashing shared memory. A device without float render targets, or one whose max texture size cannot hold the spectrogram, is reported at startup; a refused scratch allocation closes the file instead of leaving a silent GL error.

### CPU memory

History's in-memory caches (packed states, node deltas, audio hops) scale from 0.25× at 8 GiB of RAM to 1× at 16 GiB: **640 MB → 160 MB on an 8 GB machine**. The 512 MB audio LRU was already on disk and never counted against RAM.

## The paint pipeline

### Where the cost went, per dab

1. **Hover preview (the dominant cost, removed).** Every hover frame ran a full-texture `blitFramebuffer` because the display sampled `destinationFbo` directly. On a 90 s file that is ~19.4 M texels × 32 B ≈ **620 MB of bus traffic per frame** — ~18 ms on the Iris' ~34 GB/s shared bus before any drawing. The display now composites the preview from the committed texture plus the ping-pong partner; nothing is copied.
2. **Every pass drew full-width rows; the final pass now draws the footprint.** All effect, mask and modulator passes render instanced packed-pixel ranges (`glsl/range-quad.vert`, `lib/range-quads.ts`). Intermediate passes still cover the brush's full rows, because later passes read them with effect-specific reach (blur taps, iterated transform shifts, a later step's source offsets). The final pass — the only one nothing reads back — covers just the brush's bands × its time window (+4-bin margin), and a committed stroke folds that footprint back with one range-copy draw. A 0.25 s dab on a 20 s file rasterises **1/80th** of the pixels its rows span. Footprints over half the texture keep the old whole-texture draw + buffer swap, which measures ~25% cheaper than copy-back at that size.
3. **The preview display test is exact.** Band offsets are unaligned uint32 stored as float32; above 2²⁴ texels (~78 s at 48 kHz) they round by up to ±2. The display therefore decides preview-vs-committed per texel through a per-band bin-range texture written by the same code that builds the draw ranges — never by re-deriving pixel ranges from a formula.
4. **Smaller fixed costs:** the mask pass is bounded to the rows the stroke has touched; the modulator MRT renders only when routed; no depth writes anywhere in the paint path.

### Measured results (M4 Pro, median ms per dab, small blur brush)

The M4 is dispatch-bound, so these are lower bounds for the Iris gains; the Iris is fill-bound and tracks the bytes-moved ratios above.

| Case                     | 8fd28f2 | After |                          |
| ------------------------ | ------- | ----- | ------------------------ |
| Hover preview, 15 s file | 1.20    | 0.89  |                          |
| Hover preview, 45 s file | 1.38    | 0.95  |                          |
| Hover preview, 90 s file | 2.04    | 0.95  | flat against file length |
| Committed dab, 90 s file | 2.41¹   | 1.32  |                          |
| Whole-file brush, 90 s   | 22.2    | 21.9  | unchanged by design      |

¹ Measured after the first pass; the first pass did not touch the committed path, so it stands for the baseline.

Correctness is held by the equivalence suite (`scissor-copyback.test.ts`): every optimised path must be byte-identical to the legacy full-texture path (`disableScissorCopyBack`), including multi-pass effects, iterated time shifts, full-pitch brushes, wrapped brushes, and the preview bins against a committed dab. Playwright-driven app screenshots are pixel-identical before and after.

## Bugs found by the review passes (Codex + Gemini over the whole range)

- **Feedback loop in multi-pass steps after the first** (`3ff11c9`): a later step reads its input as `blendBaseTex` on every pass, but the pass buffers alternated without regard to it — the driver dropped the offending draws as a feedback loop (INVALID_OPERATION), leaving passes unrendered. Pass targets are now assigned backwards from the step's end over the buffers the step does not read; a test spies on every draw and asserts none samples its own target.
- **Hidden depth renderbuffers** (`0fa93f5`): see the table above; also removed ~4 B/px of depth-write bandwidth from every pass.
- **Undo footprint used the active step only** (`3ed01a7`, pre-existing): paint covers the union of all steps, so undoing a multi-step brush whose other step was larger left pixels behind. The dirty region and history footprint now use the step union.
- **Float32 offset sliver** (`3ed01a7`): whole-band footprint ranges widen by the margin in pixels, clamped to the rows earlier passes wrote, so rounded offsets past 2²⁴ texels cannot leave an unpainted band edge.
- **`uniform1fv: no array` ten times per file open** (`dd28048`): `defaultParameterUniform` shipped an empty `modulationAmounts`; a zero triple fixes it.
- **Failure-handling hardening** (`7fbddaa`, `3ed01a7`): Electron's main-process error dialog is preserved (`uncaughtExceptionMonitor`); an unwritable log directory cannot block window creation; log rotation cannot grow unbounded under a locked old file; only a genuine `GpuMemoryError` closes a painted file; the scratch check drains every latched GL error; the console capture cannot throw into its caller; the memory sampler reads the cached GPU figure instead of creating a Metal device every 10 s; the modulator-precompute and range-copy programs join the shader warmup.

## Diagnosing a slow machine

Everything needed arrives in one file: `<userData>/logs/noise-canvas.log`, revealed by **Help → Show Log File**. It carries the session header (versions, CPU, RAM, GPU name and Metal budget, ANGLE backend requested), the real WebGL renderer string, shader link/warmup times, every texture allocation with its budget share, per-dab and synthesis timings, a frame-cadence line (p50/p95) every 10 s, per-process working sets, and every captured error including GL context loss.

To test the Metal ANGLE backend on Intel, launch from Terminal:

```
NOISE_CANVAS_ANGLE=metal "/Applications/Noise Canvas.app/Contents/MacOS/Noise Canvas"
```

The log's `[gl] context` renderer string proves which backend actually ran. The default stays OpenGL until measurements justify a change.

## Deliberately unchanged

- **The scratch pool is never freed on idle** — this is a painting app; reallocation hitches cost more than the memory.
- **`fbo2` cannot shrink.** It is the final-pass target and the preview source at packed coordinates, a full-pitch brush's footprint spans every row, and every effect reads `destSpectrogramTex`/`blendBaseTex` at those coordinates — a smaller buffer needs every read site remapped. Pooling one partner across open files would save 16 B/texel per extra file but forces copy-back onto whole-texture strokes (+25%); not worth it at one or two open files.
- The loading-overlay blur, and all Resolution/memory copy.
- Whole-texture strokes keep the swap path (see above).

## Open items

- The user's measurements: file length, whether lag is hover-only or paint-only, and one `NOISE_CANVAS_ANGLE=metal` run with the log.
- Intermediate passes could also draw footprints if each effect declared its time reach; unbounded-reach effects (transform) keep rows.
- File logging in the Ableton extension build (`host.diag` is console-only there).
- The unknown-GPU fallback budget (Linux) is a flat 2 GiB; make it tunable if large discrete GPUs turn up.
