# Slot-copy allocation check

The existing slot-copy implementation remains. The tested reuse paths reduced
object creation, but timing is inconclusive under the machine's heavy load.
The owner confirmed that the machine was busy during these runs. Neither a
speed gain nor a regression is established, and no app-level performance
claim is made. No further timing runs were taken after that confirmation.

## Workload

Run the production `BlockSlotCache` upload, compose and copy-back paths through
Chromium/WebGL:

```
npm run test:perf -- src/renderer/src/lib/__tests__/block-slot-cache.perf.test.ts
```

Each repeat warms up for ten cycles, then measures 200 cycles. Each cycle
uploads three blocks, composes them, copies them back and composes them again:
1,200 draws per repeat. The fixture is two seconds at 8 kHz, four bands per
octave, with a 0.25-second block grid and blocks 2–4 selected. Shader code,
slot capacity and pixel-copy operations are unchanged between candidates.

The benchmark counts submitted object identities with weak references, so the
counter does not keep disposed objects alive. Times include this instrumentation
and measure CPU submission per six-draw cycle, not completed GPU execution or
painting preparation. Timing assertions are deliberately absent.

## Result, 14 September 2026

The final paired run used baseline `2882100` and a candidate that reused only
the scene and mesh. Both implementations ran in one browser process in
baseline/candidate/candidate/baseline order, with separate caches and warm-ups.
No build or other test suite ran alongside the measurement. One-minute machine
load was 5.56 at the start and 7.03 at the end; five-minute load was
10.21–10.44 and fifteen-minute load was 13.06–13.13.

| Implementation       | Repeat | Draws | Scenes / meshes | Geometries | Attributes | Range arrays | p50 / p95 / p99, ms |
| -------------------- | ------ | ----: | --------------- | ---------: | ---------: | -----------: | ------------------- |
| Baseline             | 1      | 1,200 | 1,200 / 1,200   |      1,200 |      3,600 |        1,200 | 0.2 / 0.4 / 1.1     |
| Reuse scene and mesh | 1      | 1,200 | 1 / 1           |      1,200 |      3,600 |        1,200 | 0.1 / 1.3 / 1.7     |
| Reuse scene and mesh | 2      | 1,200 | 1 / 1           |      1,200 |      3,600 |        1,200 | 0.2 / 1.5 / 2.1     |
| Baseline             | 2      | 1,200 | 1,200 / 1,200   |      1,200 |      3,600 |        1,200 | 0.1 / 0.8 / 1.7     |

Each row allocated 676,800 bytes of range arrays. A preceding candidate reused
the geometry, attributes and a page-bounded range buffer too: one scene, mesh,
geometry and array, three attributes and 2,976 range bytes per repeat. Its observed
p95 times were also higher, but the load prevents attributing that difference
to the implementation. Switching that buffer to streaming usage and retaining
per-draw GPU buffer disposal did not establish a consistent improvement.
The cause of the timing difference is not established. Buffer synchronisation
was a hypothesis, not a confirmed diagnosis. The short-run load samples above
do not establish comparable CPU or GPU availability.

The candidates passed byte comparisons for uploads, compositions, copy-backs,
changing copy sizes and independent caches. Correctness and lower allocation counts do not establish an overall speed
gain. With timing inconclusive, the candidates and their implementation-specific
tests were removed. Any renewed timing comparison needs a quiet machine; it is
not part of this completed profiling pass.

Raw logs and the paired harness are in
`/private/tmp/noise-canvas-final-two/`. The committed benchmark can be run on
any revision for a fresh comparison.

## Memory accounting

`BlockStore.residentBytes` includes both current blocks and cached decoded
original blocks. The original cache has its own budget; the current tier's
flush threshold still counts only current blocks. A regression test checks
that an original block is counted once and that disposal releases the count.
