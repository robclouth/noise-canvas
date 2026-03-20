# Phase Correction for Spectrogram Transforms

## Overview

This document covers the phase correction algorithm used when transforming spectrogram content in the gaborator constant-Q domain. It covers the theory, proven formulas, implementation details, and ideas for future improvement.

The algorithm lives in `getTransformedSampleNeutralV2()` in `src/renderer/src/glsl/effect-common.glsl` (Algorithm 4 — "Neutral").

## Background: Gaborator Global Phase Convention

The gaborator stores coefficients as `[magnitude, phase]` pairs per band per time frame. The phase uses the **global phase convention**:

```
φ_global(b, t) = φ_instantaneous(b, t) - 2π·f_b·t
```

For a pure tone at exactly the band center frequency `f_b`, the global phase is **constant** (does not change with time). For a component at `f₀ ≠ f_b`, the global phase drifts linearly:

```
φ_global = φ₀ + 2π·(f₀ - f_b)·t = φ₀ + 2π·Δf·t
```

The synthesis reconstructs audio by summing windowed cosines:

```
output(t) = Σ |c(b,k)| · cos(φ_global + 2π·f_b·t) · window(t - t_k)
```

The **total instantaneous phase** is `Φ = φ_global + 2π·f_b·t`. The frequency the listener hears is `f_b + dφ_global/dt/(2π)`.

## The Core Problem

When transforming spectrogram content (stretch, reverse, pitch shift), we move coefficients from source position `(b_src, t_src)` to destination position `(b_dst, t_dst)`. The synthesizer at the destination multiplies by `e^{i·2π·f_dst·t_dst}` instead of `e^{i·2π·f_src·t_src}`. We need to set `φ_dest` so the output frequency and phase alignment are correct.

Different operations need different corrections:

- **Time shift**: compensate for the carrier phase offset at a different time
- **Time stretch**: preserve component frequencies despite temporal resampling
- **Reversal**: conjugate the phase and compensate for mirrored time
- **Pitch shift**: scale phase to produce the new target frequency

## Proven Formulas (Individual Operations)

### Time Shift

```
φ_dest = φ_src + 2π·f_b·(t_src - t_dest)
```

Uses the **band center frequency** `f_b` because it compensates for the synthesis carrier being at a different time. Proven with r=0.987-0.999 across positions.

### Time Reversal

```
φ_dest = -φ_src - 2π·f_b·(t_src + t_dest)
```

Phase negation handles the conjugation. The `(t_src + t_dest)` term is constant for whole-file reversal (`= T_total`) but varies for partial brushes. Uses exact brush boundaries, NOT `T_total`. Proven with r=0.994.

### Time Stretch (Scale-by-S)

```
φ_dest = scaleX × φ_src
```

For a component with constant IF offset `Δf`:

```
scaleX × (φ₀ + 2π·Δf·t_dest/|S|) = scaleX·φ₀ + signX·2π·Δf·t_dest
```

Phase advance per frame = `2π·Δf·dt` (correct). No per-frame IF estimation needed, no error accumulation, every pixel independent. Proven with respec=0.9985 and sine r_env=0.999.

**Why this works better than additive IF correction**: The additive approach (`φ + dphi × stretchFrames`) extrapolates a noisy single-point dphi estimate over hundreds of frames. The error accumulates linearly with distance from the brush start, causing different-sounding results at different positions. Scale-by-S has no accumulation — every pixel is computed identically.

**Why the old Neutral V2 formula caused banding**: The old formula `φ + 2π·f_b·(srcUv - dstUv)·T` used the band center frequency `f_b` for the stretch correction. For a 440Hz component in a 434Hz band, the correction used 434Hz instead of the 5.9Hz IF offset — overcorrecting by ~74× and causing massive constructive/destructive interference (energy collapsing into horizontal bands).

### Pitch Shift

```
φ_dest = φ_src × (f_dst / f_src)
```

Scaling by the frequency ratio adjusts all phase advance rates to match the target frequency. Proven with sine r_env=0.993 (440Hz → 880Hz).

## The Unified Formula (Current Implementation)

The shader blends two approaches based on `|scaleX|`:

### Near |scaleX| = 1 (shift/reversal): Additive approach

```
φ_dest = signX × signY × φ_src + carrier_correction
```

Where carrier correction is:
- Positive scaleX: `2π·f_src·(srcUv - dstUv/scaleX)·T`
- Negative scaleX: `-2π·f_src·(srcUv + dstUv)·T`

### Far from |scaleX| = 1 (stretch): Scale-by-S approach

```
φ_dest = scaleX × signY × φ_src
```

### Blend

```
stretchAmount = clamp(|scaleX| - 1) × 4, 0, 1)
φ_dest = mix(additive, scale_by_S, stretchAmount)
```

### Pitch ratio (applied to both)

```
φ_dest *= f_dst / f_src
```

### Complete shader pseudocode

```glsl
// Additive (precise for shift/reversal)
addPhase = signX * signY * srcPhase + carrierCorrection;

// Scale-by-S (no accumulation for stretch)
sclPhase = scaleX * signY * srcPhase;

// Blend based on stretch amount
stretchAmount = clamp(abs(abs(scaleX) - 1.0) * 4.0, 0.0, 1.0);
phase = mix(addPhase, sclPhase, stretchAmount);

// Pitch ratio
phase *= freqRatio;
```

## Key Insights Discovered

### 1. Band-center frequency pull (the "pulse train" artifact)

Without IF correction, time stretching by factor S shifts every component's frequency **toward its band center** by `Δf × (1 - 1/S)`. Across all bands, this creates a frequency comb (energy concentrated at band centers), which manifests as a periodic pulse train in the time domain. The pulse period is `1/(f_b × band_spacing)` — shorter at high frequencies, longer at low frequencies, creating a characteristic "downward sweep" sound.

### 2. Additive IF correction accumulates error

The additive correction `dphi × stretchFrames` uses a per-frame IF estimate (from phase derivative) and multiplies by the total offset from the brush start. Any error in dphi gets amplified by stretchFrames, which grows linearly. This causes:
- **Position-dependent quality**: kicks near brush start sound different from kicks near the end
- **Swooping artifacts**: noisy dphi from transients creates pitch sweeps when multiplied by large stretchFrames

### 3. Scale-by-S eliminates accumulation

`scaleX × φ_src` achieves the same frequency correction as the additive approach (for constant IF) but without any per-frame estimation or accumulation. Each pixel is computed independently. The tradeoff: initial phase offset `(S-1)·φ₀` per component, which slightly affects transient alignment but not frequency.

### 4. Reversal needs the carrier correction

For pure reversal (|scaleX|=1), the scale-by-S approach gives `-φ_src`, which has the correct frequency but wrong inter-band phase alignment. The additive reversal correction `-2π·f_b·(srcUv+dstUv)·T` is needed for perfect transient reconstruction. This is why the blend uses additive near |scaleX|=1.

### 5. The reversal+stretch correction has an extra f_b term

For reversal+stretch (scaleX=-S, |S|≠1), the reversal correction's `(srcUv+dstUv)` varies with position (unlike pure reversal where it's constant). This introduces a time-varying `f_b` drift that needs compensating. In the additive approach, this required adding `2π·f_b·bandStep/SR` ("expectedAdvance") to the dphi estimate. In the scale-by-S approach, this is handled automatically by the scaling.

### 6. Pitch shift works via frequency ratio scaling

Multiplying the entire phase (including all corrections) by `f_dst/f_src` scales all phase advance rates to match the target pitch. This works because pitch change is fundamentally multiplicative on phase, while time operations are additive.

### 7. Wide finite difference for IF estimation

When using the additive approach, a wider finite difference for dphi estimation (`(phase[k+R] - phase[k-R]) / (2R)` with R=32) is equivalent to smoothing the estimate over 2R frames, using the same 2 texture reads. This reduces swooping from transient noise while preserving the average IF. However, scale-by-S made this unnecessary for stretch.

## Test Results Summary

Test script: `test-phase.mjs` at project root. Uses a real drum loop sample and rubberband as reference.

| Operation | Metric | Score | Method |
|---|---|---|---|
| Identity (scaleX=1) | respec | 1.000 | all |
| Pure reversal (scaleX=-1) | respec | 0.9999 | additive (via blend) |
| Pure stretch (scaleX=2) | respec | 0.9985 | scale-by-S (via blend) |
| Rev+stretch (scaleX=-2) | respec | 0.9938 | scale-by-S (via blend) |
| Pitch up octave (scaleY=2) | respec | 0.999 | freqRatio |
| Pitch down octave (scaleY=0.5) | respec | 0.995 | freqRatio |
| Stretch+pitch (2, 2) | respec | 0.999 | scale-by-S + freqRatio |
| Shift invariance | variance | 0.018 | additive |
| Sine 440→880Hz | r_env | 0.993 | freqRatio |
| Sine 2× stretch | r_env | 0.999 | scale-by-S |

## Ideas for Further Improvement

### 1. Transient detection + phase reset (high impact, high complexity)

The biggest remaining quality gap versus phase vocoders like rubberband. Detect transient onsets (sudden broadband magnitude increase) and at those frames, force all bands to use identity phase (no scaling) to preserve the sharp attack's cross-band phase coherence. Between transients, use scale-by-S for frequency accuracy.

**Implementation**: Could be done as a pre-pass that writes a 1D "transient map" texture (one value per time frame: 0=tonal, 1=transient). The transform shader reads this and blends between scale-by-S (tonal) and identity (transient). The transient detector looks at magnitude derivative across bands.

### 2. Pitch-induced temporal resampling correction (medium impact, low complexity)

When pitch-shifting up, content moves from low-freq bands (large bandStep, few frames) to high-freq bands (small bandStep, many frames). This is an implicit temporal upsampling — adjacent destination frames interpolate between the same source frames. This is equivalent to time stretching and could benefit from the same scale-by-S treatment.

**Implementation**: Compute `implicitStretch = srcBandStep / dstBandStep`. When this differs from 1, apply scale-by-S with this implicit factor in addition to the explicit scaleX.

### 3. Adaptive blend threshold (low impact, trivial)

The current blend uses `clamp((|scaleX|-1) × 4, 0, 1)`, transitioning between additive and scale-by-S over the range |scaleX| = 1.0 to 1.25. This threshold (4.0) was chosen arbitrarily. It could be tuned based on the signal characteristics (more tonal content → blend earlier to scale-by-S; more transient → stay on additive longer).

### 4. Higher bands-per-octave for reduced phase offset (medium impact, architectural)

The `(S-1)·φ₀` phase offset from scale-by-S depends on `φ₀`, which is the IF offset from band center. With more bands per octave, each band is narrower, components sit closer to band centers, `φ₀` is smaller, and the scaling artifact is smaller. The current default of 24 bands/octave could be increased for higher quality at the cost of analysis speed and memory.

### 5. Log-magnitude interpolation verification (unknown impact, low complexity)

The shader's `interpolateComplex` function uses log-magnitude interpolation for blending between time frames. Verify this is being used consistently in the transform path (not just for the source sampling but also for any magnitude blending in the brush application).

### 6. Phase vocoder pre-pass for high-quality stretch (high impact, high complexity)

Instead of manipulating gaborator coefficients directly, implement a proper phase vocoder as a separate processing step:
1. Synthesize the source region to audio (via gaborator)
2. Run a phase vocoder (overlap-add with phase propagation and transient detection)
3. Re-analyze the result with gaborator
4. Write back to the spectrogram

This would give rubberband-quality stretching but at the cost of two gaborator round-trips and a phase vocoder pass. Could be offered as a "high quality" mode for non-realtime operations.

### 7. Coefficient-domain phase propagation pre-pass (medium-high impact, medium complexity)

A compromise between per-pixel and full phase vocoder: run a sequential phase propagation pass over the gaborator coefficients before the transform. For each band, iterate through destination frames sequentially and propagate the phase using IF estimates. This gives better temporal coherence than per-pixel scale-by-S (each frame builds on the previous) without the full cost of synthesis+analysis.

**Implementation**: A separate GPU compute pass that reads the source texture, propagates phases per band, and writes to an intermediate "corrected phase" texture. The transform shader then reads from this instead of computing phases per-pixel.

### 8. Perceptual weighting of phase correction (low impact, low complexity)

Weight the phase correction by perceptual importance. Low frequencies (< 1kHz) are more sensitive to phase errors than high frequencies. Transient regions are more sensitive than sustained tones. Apply stronger correction where it matters most and relax it where errors are less audible.

## File References

- Shader: `src/renderer/src/glsl/effect-common.glsl` — `getTransformedSampleNeutralV2()`
- Transform effect: `src/renderer/src/glsl/transform-effect.frag`
- Algorithm constants: `src/renderer/src/lib/constants.ts` — `ALGORITHMS` array
- Test script: `test-phase.mjs` (project root)
- Test sample: Splice drum loop (path in test script)
