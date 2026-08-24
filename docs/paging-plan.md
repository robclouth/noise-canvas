# Paged Residency

## Why

GPU memory costs 148 bytes per packed texel (`gpu-budget.ts`), and texel count is fixed by duration: about 4.5 texels per input frame at every Resolution setting. Memory therefore scales with file length and nothing else. A 60 s stereo file holds 1.8 GB while painting; five minutes holds 9.2 GB.

The August 2026 work (`docs/perf-low-end-mac.md`) cut the constant as far as it goes: depth buffers removed, masks and modulator targets to half precision, the modulator MRT made lazy, and — as of `07a5e67` — the pass buffers allocated on first use, which drops a default brush from 132 to 100 resident bytes per texel. The charge stays at 148 because a brush can grow at any time.

Two other levers were priced and rejected:

- **Feature stripping.** Only the scratch pool is reachable, and only the pass buffers (32 B) can honestly be refused up front. Every other scratch buffer has a reader with reach: the stroke-start snapshot doubles as `sourceSpectrogramTex` for non-cumulative strokes (`stroke-renderer.ts`, the `!accumulate && isSameFile` branch), and Attract reads the modulator map by `texelFetch` at a computed pixel (`attract-effect.frag`, `attractPackedRead`). A whole Reduced Mode measured 148 → 116, or 24 s → 31 s of admissible audio on a 1.5 GB device. Not worth the feature loss; reverted before commit.
- **A mono packed layout.** Real (92 B/texel) but it changes the on-disk packed format, which wipes history — and history _is_ the painted state for a reopened file.

Paging is the only lever that changes the shape of the problem rather than shaving the constant. It also costs no sound quality, which rules out the remaining alternative of importing at a lower sample rate.

## The idea

Stop treating "the file" as the unit of residency. Keep two things instead:

- **An overview** — the whole file, decimated, magnitudes only. Backs the display wherever the window does not reach. Grows with file length, but at 1/64th the rate.
- **A window** — the visible viewport plus whatever a stroke reads or writes, at full precision. Its size is a **setting**, not a function of file length.

The packed array on disk is the backing store. Memory stops scaling with duration.

## What the current code already gives us

Verified in the source, not assumed:

| Piece                                    | Where                                 | Why it matters                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One choke point for display reads        | `fetchDisplayTexel`, `display.frag`   | Every display sample of the packed data goes through it, including both taps of `sampleDisplayInterp`.                                                                           |
| A per-band residency test, already exact | `previewBinRangesTex`, same function  | It picks preview-versus-committed per texel from a per-band `[start, end)` table written by the same code that builds the draw ranges. Window-versus-overview is the same shape. |
| The display never reads phase            | `display.frag`, colour block          | Only `.r` and `.b` reach `magnitudeToDb`. The overview can be magnitudes only.                                                                                                   |
| Time window to packed ranges             | `coef-patch.ts`                       | `(band, k0, count)` triples become packed pixel ranges with frame bounds. This is the residency mapping.                                                                         |
| Range algebra                            | `pixel-ranges.ts`                     | Merge, subtract, gather and scatter over packed ranges, tested.                                                                                                                  |
| Partial GPU upload                       | `patchFBOData`, `stroke-renderer.ts`  | Scatters only changed packed pixels, 1–7 ms.                                                                                                                                     |
| Drawing arbitrary ranges                 | `range-quads.ts`, `range-quad.vert`   | Instanced quads over packed pixel ranges.                                                                                                                                        |
| Max-reduction precedent                  | `max-pyramid.ts`                      | The decimation rule for the overview: max, not mean, so transients survive zoom-out.                                                                                             |
| Partial synthesis                        | `files.ts`, `C++ synthesis {partial}` | Synthesis is already regional.                                                                                                                                                   |
| Packed state on disk                     | `history-manager.ts`                  | The backing store's format and writer already exist.                                                                                                                             |

The parts that assume whole-file residency are fewer than expected. This is a large change, but it is not a rewrite.

## The numbers

Overview at RG16F (4 B/texel) decimated 16× in time is 0.25 bytes per original texel. A 15 s window at 48 kHz is 3.24 M texels at the full 148 B.

| File                           | Texels |   Today | Paged, 15 s window |      |
| ------------------------------ | -----: | ------: | -----------------: | ---: |
| 60 s stereo                    |   13 M | 1835 MB |             483 MB | 3.8× |
| 71.2 s mono (the field report) | 15.4 M | 2168 MB |             483 MB | 4.5× |
| 5 min stereo                   |   65 M | 9160 MB |             496 MB |  18× |
| 20 min stereo                  |  259 M | 36.6 GB |             545 MB |  67× |

The window is constant; only the overview grows, and slowly. The multiplier is file length ÷ window length, so it has no ceiling.

Window size becomes the memory setting: 8 s holds 256 MB, 30 s holds 960 MB. That is the honest version of a low-memory mode — less of the file resident at once, rather than fewer features or less bandwidth.

## Stages

Each stage ends somewhere shippable. Stage 1 is a gate: if it fails, nothing after it is worth building.

### Stage 1 — the overview and the residency branch, display only

Build the overview at analysis time (max-decimated magnitudes, RG16F) and extend `fetchDisplayTexel` with a third case: not resident, read the overview. Keep the full packed texture resident, and drive the branch with a forced pretend-window so the overview path actually renders.

Nothing is saved yet. The point is the measurement.

**Gate: frame time on the Iris 655 with the branch in.** The display is fill-bound there, and this adds a table lookup and a branch to every display texel. If it costs more than the paging saves, stop. Compare against the existing `[frame] cadence` p50/p95 lines in the diag log, on the same file.

### Stage 2 — the window becomes real for display

Allocate the packed FBO at window size. Gather the window out of the CPU packed array on view change, using `coef-patch` for the mapping and `patchFBOData` for the upload. Painting stays confined to the window or disabled.

Memory drops here for the first time. Measure against the table above.

### Stage 3 — painting inside the window

Strokes already work in packed ranges, so the paint path mostly moves under a coordinate offset. Commit patches the window, then scatters to the CPU array.

The new work is **reach**: before a stroke draws, compute the source span its effects will read — clone and transform offsets are known before the draw — and page it in, or widen the window. A brush whose footprint exceeds the window runs tile by tile.

### Stage 4 — the CPU backing store

Until this lands, `packedData` is still whole-file resident at 16 B/texel, which on a unified GPU counts against the same budget: five minutes is 1 GB on its own. Chunked, disk-backed packed storage, reusing the history writer's format.

This is the least-built part of the plan and the one to schedule most time for.

### Stage 5 — the setting and the fallbacks

Window size in Preferences, defaulted from the queried GPU budget. Whole-file brushes and long-reach sources run tile by tile. Export and synthesis stream over the backing store rather than a resident array.

## Risks

1. **The display branch cost on Intel.** Stage 1 exists to answer this before anything depends on it.
2. **Reads that leave the window.** A Full-time brush genuinely needs the file. Tiling makes it slow, not broken, but the slow path has to exist and be correct.
3. **The CPU backing store.** The most new code, and it sits under synthesis and history.
4. **History navigation.** Undo and redo are already footprint-based, but `navigateTo` uploads FBO data sized to the file. It needs the same window treatment.
5. **Painting while zoomed out.** The footprint can exceed the window on purpose. Same tiling path as (2).

## Open questions

- Decimation factor, and whether the overview keeps both channels or a sum. 16× and both channels are the starting assumption; the display colours left and right separately, so a sum changes the look when zoomed out.
- How the overview stays current. The painted region must be re-decimated after each commit. Cheap in principle, on the commit path in practice.
- Whether `previewBinRangesTex` generalises to carry residency too, or whether a second per-band table is cleaner.
- Whether the window should follow the viewport, the playhead, or the last stroke. Probably the viewport, widened by recent strokes.

## Deliberately unchanged

- **Sound quality.** No decimation reaches the audio path. The overview is a display structure; synthesis always reads full-precision packed data.
- **The packed layout on disk.** Paging is layout-neutral, which is what keeps existing history readable.
- **The brush model.** No steps, effects, iterations or modulators are removed. That was Reduced Mode, and it was reverted.
