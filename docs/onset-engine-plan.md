# Onset Engine & Transient-Preserving Defaults — Implementation Plan

> **Status: implemented** on `feature/onset-engine`. Kept as the record of what
> was intended; three things were built differently from what is written below,
> for reasons found while building:
>
> - **Phase 1** budgets detection against the audio (~1.5 ms per second) rather
>   than against synthesis, which is FFT-based and far faster than a
>   per-coefficient walk, so "under 10% of synthesis" was never reachable.
>   Detection is therefore requested per call rather than always on. Peak
>   picking also spreads each coefficient's contribution across the time it
>   covers: dropping it into the bin it starts in makes the slow bands, one
>   coefficient per 43 ms, spike periodically and swamp the function.
> - **Phase 2** scales salience against the file's 90th percentile rather than
>   by rank. Rank scoring gives the weakest hit of a loop of equal hits a score
>   of zero, which is exactly wrong.
> - **Phase 7** derives tonality per pixel from the source's own phase (five
>   texture reads) instead of a per-band map computed in C++ and carried
>   through as a texture the size of the spectrogram. Same behaviour, finer
>   resolution, and nothing new to plumb.
>
> Phase 6 also found a real defect the plan assumed away: the transported
> deviation was being read from interpolated phase, which averages two atoms
> that disagree across an attack. It now comes from the nearest stored
> coefficient, rounded on that band's own stride.

Self-contained plan for implementing the onset engine, UI, and transient-preserving
transform defaults. Background, formulas, and conventions are included so no prior
conversation context is needed.

## Background (read first)

The app stores Gaborator constant-Q coefficients as mag/phase pairs, phase
**unwrapped along time per band**, in the **global convention**: an impulse at
time T has phase `−2π·f·T` at every atom within support (see comment in
`src/renderer/src/glsl/align-effect.frag`). Two proven facts drive this work
(validated end-to-end in `test-pitchdown-proof.mjs` against the real addon;
listening results in `test-audio/pitchdown-proof/`):

1. **Never scale stored phase.** Phase is only meaningful mod 2π; multiplying by
   a frequency ratio turns arbitrary 2πn unwrap history into per-band garbage.
   This is why pitch shifts smear transients (a 3-octave downshift smeared a
   0.9 ms click to 57 ms with 32% of energy arriving before the hit).
2. **Onset transport fixes it.** Near an onset at source time T_src mapped to
   dest time T_dest:
   `φ_dest = −2π·f_dest·T_dest + (φ_src + 2π·f_src·T_src)`
   — purely additive (unwrap junk cancels mod 2π), transports the source's
   phase deviation from the impulse relation, so coherent clicks stay coherent
   and noisy attacks stay noisy. Away from onsets, percussive material wants
   re-randomized phase; tonal material wants the existing NeutralV2 rule.
   Shipped as transform algorithm 5 "Punchy"
   (`getTransformedSamplePunchy` in `src/renderer/src/glsl/effect-common.glsl`,
   CPU onset map in `src/renderer/src/lib/onset-map.ts`).

Key sensitivities, empirically verified:

- Onset-time error ε displaces the transported transient by `(α−1)·ε` for pitch
  ratio α (a linear-in-frequency phase deviation is a delay, not a scramble —
  degrades gracefully, but ±0.5 ms bins cost ~3.5 ms at 3 octaves). Sub-bin
  refinement is mandatory.
- The lock window sigma must match the **source** band's Gabor support
  (`0.7·bandsPerOctave/f_src`, floor 2 ms) — the width of the attack ridge in
  the transported data. A dest-support window coheres tail noise into a false
  click.
- The onset anchor must sit on the **energy ridge**, not the flux peak (flux
  peaks on the rising edge, ~1 envelope-sigma early).
- The exact time-shift carrier correction (`φ += 2π·f·ΔT`) still smears
  transients ~10 ms via per-band fractional-grid interpolation at different
  strides; ridge re-anchoring recovers the floor (0.1 ms). So re-anchoring
  helps time ops, not just pitch ops.

Project conventions (from AGENTS.md + established practice):

- Never use `any`; no `unknown` casts — fix the real type.
- Comments describe functionality only, never the change history.
- Gitmoji commits: `<emoji> (scope): <imperative>` — ✨ feature, 🐛 fix,
  ♻️ refactor, ✅ tests, ⚡️ performance.
- `npm run test:run` after big changes (browser/WebGL suite);
  `npm run test:addon` for native addon tests; `npx node-gyp rebuild` after C++
  changes — if C++ behavior mysteriously doesn't change, `node-gyp clean` first
  (stale incremental builds are a known trap).
- FBO textures must stay RGBA32F.
- `includeInStep` params live on the active step, not global state — tests must
  `Object.assign` overrides onto `state.brushes[0].steps[0]`.
- In tests, reuse production code paths (StrokeRenderer + real shaders via the
  helpers in `src/renderer/src/test/render-harness.ts`), don't reimplement.

Existing verification harness: `test-pitchdown-proof.mjs` (repo root, run with
`node test-pitchdown-proof.mjs` from the repo root after adjusting its OUT_DIR if
needed) — analyzes → transforms coefficients → resynthesizes → measures E90
(90%-energy duration), crest, envelope correlation vs ground truth, pre-echo %,
and peak displacement. Ground-truth trick: band-mask the same impulse to the
target octave range = the physically ideal shifted result. Extend this harness
whenever phase rules change.

---

## Phase 0 — Commit the baseline

Everything below builds on the uncommitted Punchy work currently on `dev`.

- Add `test-audio/pitchdown-proof/` to `.gitignore` (WAVs are regenerable by the
  harness; keep the repo lean).
- Commit in two commits:
  1. ✨ (transform): add Punchy onset-transport algorithm with CPU onset map —
     `effect-common.glsl`, `onset-map.ts`, `stroke-renderer.ts`,
     `base-effect.ts`, `constants.ts`.
  2. ✅ (transform): add Punchy alignment tests and pitch-down proof harness —
     `transform-punchy.test.ts`, `test-pitchdown-proof.mjs`, `.gitignore`.
- Acceptance: `npm run typecheck && npm run test:run` green before and after.

## Phase 1 — C++ onset engine in the addon

**Goal:** onsets always reflect the current canvas, detected with
literature-grade quality, returned with continuous salience (no thresholding in
C++ — the UI thresholds downstream).

### 1a. Detector core (`gaborator-addon.cpp`)

Factor a reusable function that walks packed coefficient data (the same layout
the synthesize path already receives zero-copy — do not copy buffers; see the
existing synthesize marshaling):

```
computeOnsets(const float* packed, const band metadata (offsets, stepLog2s,
              lengths, freqsHz), numFrames, sampleRate)
  -> vector<{ double timeSec; float salience; }>
```

Detection function, accumulated into 0.5 ms time bins:

1. **Log compression:** per coefficient, `c = log1p(gamma * mag)` with
   `gamma = 20.0` (constant, tunable), `mag = (magL + magR)/2`.
2. **Per-band adaptive whitening** (Stowell & Plumbley): per band, running peak
   `P_b = max(c, r·P_b)` with `r = exp(-strideSeconds / 2.0)` (2 s time
   constant, computed per band from its stride), floor `P_b` at 1e-4;
   normalized value `v = c / P_b`.
3. **SuperFlux max-filter** (Böck & Widmer 2013): flux contribution
   `d = max(0, v_b[k] − maxNeighbor)` where `maxNeighbor` is the max of `v` at
   the _previous_ time position across bands `b−2 … b+2` (sample each neighbor
   band at the time-index matching `(k−1)·stride_b` on that neighbor's own
   grid). This suppresses false positives from vibrato and pitch glides —
   important because users paint pitch modulation.
4. **Complex-domain term** (Bello/Duxbury): predicted phase
   `φ̂[k] = 2φ[k−1] − φ[k−2]` (linear extrapolation — trivial because stored
   phase is unwrapped per band); deviation
   `dev = | mag[k]·e^{iφ[k]} − mag[k−1]·e^{iφ̂[k]} |` (use cos/sin of the
   unwrapped values). Catches soft tonal onsets flux misses.
5. **Combined ODF per bin:** `odf = fluxSF + 0.5 · complexDev` (weight
   constant, tunable).

Peak picking (Böck-style), permissive because thresholding happens downstream:

- Peak if `odf[n]` is the max over `n ± 15 ms` AND
  `odf[n] ≥ mean(odf over [n−80 ms … n+30 ms]) · 1.5` (low bar; catch
  everything plausible), min inter-onset gap 30 ms.
- **Ridge anchoring:** for each accepted peak, find the _energy_ argmax within
  the next 10 ms (energy = per-bin sum of raw `mag`), then parabolic-vertex
  refine on the energy bins (clamp vertex to ±0.5 bin, base at bin center).
  This is the onset time. Do NOT use the ODF peak time directly.
- **Salience:** `odf[n] / (localMean + eps)`, stored raw (float). JS normalizes
  per file later.

### 1b. Addon API

- Export `addon.detectOnsets(packedData, metadata, sampleRate, config)` for
  direct calls (analysis-time and tests).
- Also run `computeOnsets` inside the synthesize path on the same packed data
  it already walks, and attach the result to the synthesize return value as a
  flat `Float32Array [t0, s0, t1, s1, …]` (times in seconds, float64→float32 is
  fine at audio timescales).

### 1c. Tests (`npm run test:addon`, node environment)

- Synthetic band-limited impulse (analyze a real impulse via `addon.analyze`,
  band-mask in JS, run `detectOnsets`): exactly one onset, `|T − T_true| <
0.2 ms`, including for impulses NOT on millisecond-grid positions.
- Noise-burst hat: one onset near burst start, none in the decay tail.
- Vibrato robustness: a sustained FM tone (sine with ±1 semitone LFO wobble,
  analyzed) produces zero onsets (this is the SuperFlux check; the old flux
  detector may fail it — that's the point).
- Soft onset: a tone with a 30 ms linear fade-in is detected (complex-domain
  check).
- Parity: run the same packed data through the harness JS detector and confirm
  the C++ one finds at least the same true onsets with better/equal timing.
- Perf guard: log synthesis duration with/without detection on a ~60 s file;
  detection must add < 10%.

## Phase 2 — Store, sensitivity, texture baking

**Goal:** one filtered onset list per file, live-thresholded, feeding
everything (single source of truth).

- Store (files slice, `src/renderer/src/store/files.ts` + `types.ts`): add
  per-file `onsets: Float32Array` (flat [t, salience] pairs). Populate on
  analyze completion and overwrite on every synthesize completion.
- New app-level parameter `onsetSensitivity` in `parameters.ts` (number, 0–100,
  default 50, not `includeInStep` — it's a view/engine control, not a brush
  step param).
- Salience normalization: per file, map raw saliences to [0,1] by rank
  (percentile), so the slider behaves consistently across material.
- **Soft-knee filtering** (no popping while dragging): threshold
  `θ = 1 − sensitivity/100`; effective strength
  `s_eff = smoothstep(θ − 0.1, θ + 0.1, s) · s`. Onsets with `s_eff ≈ 0` are
  dropped from display/snap; the rest carry `s_eff` as their strength.
- Rework `src/renderer/src/lib/onset-map.ts`: delete the CPU `detectOnsets`
  (superseded by the addon); keep and rename the baking half —
  `bakeOnsetTexture(onsets, durationSec)` producing the same nearest-onset
  RGBA32F 1-row texture (R = timeSec, G = strength) the shader already reads.
  Texture lifecycle moves from WeakMap to explicit per-file cache in the store,
  disposed on file close; rebake on new onsets or sensitivity change (debounce
  slider ~30 ms).
- `stroke-renderer.ts`: replace `getOnsetMapTexture(spectrogramData)` with the
  store-provided texture for the source file (and dest file for iterative/self
  passes). The shader uniform `sourceOnsetTex` and GLSL are unchanged.
- Update `transform-punchy.test.ts` to feed a baked texture from an explicit
  onset list (no CPU detection in the renderer path anymore).
- Acceptance: Punchy behaves as before on a fresh file; painting then
  re-synthesizing updates onsets (manual check); full suite green.

## Phase 3 — Onset markers in the UI

- Render post-threshold onsets as vertical tick marks over the spectrogram in
  `file-view.tsx` (mirror however the beat grid overlay is drawn — find the
  existing grid rendering and follow its pattern). Salience → opacity.
- Toggle "Show onsets" in view settings; markers update live with the
  sensitivity slider and after each synthesis.
- Sensitivity slider UI lives next to the toggle (bind to `onsetSensitivity`).
- Acceptance: markers align with audible hits on a drum loop; slider visibly
  adds/removes weak onsets without flicker.

## Phase 4 — Onset snap grid

- Extend the existing grid-snap mechanism in `file-view.tsx` (gesture handling /
  grid snapping already lives there) with a snap-source option:
  Beat grid | Onsets. When Onsets is active, the brush's time position snaps to
  the nearest post-threshold onset.
- Mirror the existing beat-grid snap semantics exactly (whatever edge/center the
  beat snap uses, onset snap uses the same) — attacks should land at the stamp
  start, which matches painting a transform onto a hit.
- Acceptance: with snap = Onsets, brush clicks land exactly on marker times;
  WebGL behavior otherwise unchanged.

## Phase 5 — Hybrid default algorithm

**Goal:** a default-safe transient-preserving mode:
`w·onset-transport + (1−w)·NeutralV2`.

- Note: the current default NeutralV2 (algorithm 4) has **no** dest-phase blend
  (only algorithm 3 "Neutralish" has one), so no gating is needed — the hybrid
  is a pure two-term phase blend.
- New GLSL function `getTransformedSampleHybrid` (algorithm 6) in
  `effect-common.glsl`:
  - Magnitude: `sampleSourceInterp` as in Punchy/NeutralV2.
  - Compute `w` exactly as Punchy does (onset fetch, source-support sigma,
    strength).
  - Phase A: the transport anchor (Punchy's `lockL/lockR`).
  - Phase B: NeutralV2's phase for the same sample (factor NeutralV2's phase
    computation so it can be reused without duplicating code).
  - Blend on the unit circle per channel: `v = w·e^{iA} + (1−w)·e^{iB}`,
    `φ = atan2(v)`.
- `constants.ts`: add `{ value: 6, label: "Neutral+" }` at the top of
  `ALGORITHMS`; change the `algorithm` parameter default in `parameters.ts`
  from 4 to 6. (Label choice is cosmetic — if "Neutral+" reads badly in the UI,
  pick something better; do not silently rename existing entries.)
- Tests (extend `transform-punchy.test.ts`):
  - Hybrid passes the same impulse-alignment assertion as Punchy (w ≈ 1 at the
    ridge).
  - Tonal safety: content far from any onset (strength-0 onset map) produces
    output identical to algorithm 4 within float tolerance (assert FBO equality
    against a NeutralV2 run).
- Harness check: add a hybrid rule to `test-pitchdown-proof.mjs` mirroring the
  shader math; confirm click E90 ≈ onset-transport and pure-tone content
  matches scale-neutral.

## Phase 6 — Onset re-anchoring for time operations (first pass)

**Goal:** kill the multi-scale interpolation smear on time ops (proven: exact
correction still smears 0.1 ms → 10 ms; relock recovers 0.1 ms).

- **Transform time ops:** the transport formula already maps the onset time
  through the transform's x-affine (`deltaDestUv = deltaSrcUv · scaleX /
sourceTimeScale` in `getTransformedSamplePunchy`), so horizontal shift/scale
  through Punchy/Hybrid re-anchors by construction. Add a WebGL test proving
  it: time-shift an impulse ridge by a non-dyadic amount (transformShiftBeats)
  with algorithm 6 and assert phase alignment `−2π·f·T_shifted` at the
  destination (mirror the harness `ts-relock` result).
- **Clone effect:** `clone-effect.frag` copies time regions; add the same
  w-windowed re-anchor: `sourceOnsetTex` is a global uniform in
  `effect-common.glsl`, already visible to every effect. Near onsets, replace
  the cloned phase with the transport anchor at the cloned-to time (f_dest =
  f_src here, so the formula reduces to the carrier correction re-anchored on
  the ridge); away from onsets keep clone's existing phase handling. Wire the
  onset texture into clone's uniform set in `stroke-renderer.ts` (it may
  already flow through common uniforms — verify).
- Out of scope for this pass: evolve/sort/other effects (note as follow-up).
- Acceptance: harness time-shift experiment reproduced through the actual
  shaders (WebGL test); clone of a drum hit to a non-dyadic position keeps its
  attack (manual listen + alignment test).

## Phase 7 — Tonality gate (three-way hybrid tail)

**Goal:** close the remaining gap — noisy tails through Hybrid currently get
NeutralV2's slowed/watery phase; they should get re-randomized phase like
Punchy, without harming tonal content.

- Compute a per-band × coarse-time **tonality map** in the C++ detector pass
  (it already walks every coefficient): per coefficient, phase-rate stability
  `|Δφ[k] − Δφ[k−1]|` (second difference of unwrapped phase); average into a
  coarse grid (per band × 10 ms), map to tonality `τ ∈ [0,1]` (low second
  difference = tonal). Return alongside onsets; upload as a small 2D texture
  (numBands × timeBins, RGBA32F single channel used).
- In `getTransformedSampleHybrid`, the `(1−w)` term becomes
  `τ·NeutralV2 + (1−τ)·randomPhase` (unit-circle blend, reusing Punchy's
  hash-random).
- Tests: harness — hat tail through the full hybrid matches Punchy's
  random-tail metrics (crest ≈ 17–20, E90 ≈ 115 ms for the standard hat case);
  pure sine content still byte-identical to NeutralV2. WebGL — noise-region
  pixels (low τ) differ from NeutralV2, tonal-region pixels don't.
- After this lands, algorithm 6 is feature-complete as the default; "Punchy"
  (5) remains in the menu as the aggressive percussive variant.

---

## Sequencing & commits

One commit per phase (gitmoji, scoped), full suite (`test:run`) green at each;
`test:addon` additionally for Phases 1 and 7. Phases 3–4 depend on 2; 5 depends
on 2; 6 depends on 5; 7 depends on 1's walk infrastructure but can land last.

## Open minor choices (implementer may decide, note in commit messages)

- Exact label for algorithm 6 ("Neutral+" suggested).
- Marker visual style (full-height faint line vs top ticks).
- Debounce interval for slider-triggered rebakes (~30 ms suggested).
