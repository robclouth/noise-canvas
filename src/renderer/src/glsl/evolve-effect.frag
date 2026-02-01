#include "effect-common.glsl"

uniform Parameter evolveFlow;
uniform Parameter evolveSpread;
uniform Parameter evolveGrow;
uniform Parameter evolveSwirl;
uniform Parameter evolveDriftX;
uniform Parameter evolveDriftY;
uniform Parameter evolveDecay;
uniform Parameter evolveScaleX;
uniform Parameter evolveScaleY;
uniform int evolveEdgeMode;

// Apply edge mode to a source UV coordinate
// Returns the transformed UV and flags for silence/invert
vec2 applyEvolveEdgeMode(vec2 sourceUv, out bool useZero, out bool invertSample) {
    useZero = false;
    invertSample = false;

    // Calculate position relative to source brush (including sourceOffset)
    vec2 sourceBrushBottomLeft = brushBottomLeftUv + vec2(sourceOffsetX, sourceOffsetY);
    vec2 localUv = sourceUv - sourceBrushBottomLeft;
    vec2 safeSize = max(brushSizeUv, vec2(1e-6));

    // Check if inside brush bounds
    bool insideBrush = (brushSizeUv.x == 0.0 || (localUv.x >= 0.0 && localUv.x < brushSizeUv.x)) &&
                       (brushSizeUv.y == 0.0 || (localUv.y >= 0.0 && localUv.y < brushSizeUv.y));

    if (insideBrush) {
        return sourceUv;
    }

    if (evolveEdgeMode == 0) {
        // Cut: return zero for out of bounds
        useZero = true;
        return sourceUv;
    } else if (evolveEdgeMode == 1) {
        // Bleed: sample beyond brush bounds (no change)
        return sourceUv;
    } else if (evolveEdgeMode == 2) {
        // Wrap: tile within brush bounds
        vec2 wrappedLocal = fract(localUv / safeSize) * safeSize;
        return sourceBrushBottomLeft + wrappedLocal;
    } else if (evolveEdgeMode == 3) {
        // Clamp: sample from nearest edge position (no-flux boundary)
        vec2 clampedLocal = clamp(localUv, vec2(0.0), safeSize - vec2(1e-6));
        return sourceBrushBottomLeft + clampedLocal;
    } else if (evolveEdgeMode == 4) {
        // Reflect: single reflection at boundary, then clamp
        vec2 reflected = localUv;
        if (localUv.x < 0.0) reflected.x = -localUv.x;
        else if (localUv.x >= safeSize.x) reflected.x = 2.0 * safeSize.x - localUv.x - 1e-6;
        if (localUv.y < 0.0) reflected.y = -localUv.y;
        else if (localUv.y >= safeSize.y) reflected.y = 2.0 * safeSize.y - localUv.y - 1e-6;
        reflected = clamp(reflected, vec2(0.0), safeSize - vec2(1e-6));
        return sourceBrushBottomLeft + reflected;
    } else if (evolveEdgeMode == 5) {
        // Invert: sample beyond bounds but negate the result (creates interference)
        invertSample = true;
        return sourceUv;
    }

    return sourceUv;
}

// Sample with edge mode handling
vec4 sampleWithEdgeMode(vec2 sourceUv, vec2 destUv, float offsetX, float offsetY) {
    bool useZero, invertSample;
    vec2 edgeUv = applyEvolveEdgeMode(sourceUv, useZero, invertSample);
    if (useZero) {
        return vec4(0.0);
    }
    vec4 result = getTransformedSample(edgeUv, destUv, 1.0, 1.0, offsetX, offsetY);
    if (invertSample) {
        // Negate sample (flips phase by 180°, creates interference patterns)
        return -result;
    }
    return result;
}

void main() {
    ProcessingUvs coords = getProcessingUvs(vUv);
    vec4 originalTexel = texture(destSpectrogramTex, vUv);
    float weight = getBrushWeight(coords.dest);
    if (weight <= 0.0) {
        outColor = originalTexel;
        return;
    }

    float audioLevelDb = getAudioLevelDb(coords.dest);

    // Get modulated parameters (normalized to 0-1 range from -100 to 100)
    float flow = applyModulation(evolveFlow.value, evolveFlow.minValue, evolveFlow.maxValue, evolveFlow.modulationAmounts, evolveFlow.contextualModAmounts, coords.dest, 0, audioLevelDb) / 100.0;
    float spread = applyModulation(evolveSpread.value, evolveSpread.minValue, evolveSpread.maxValue, evolveSpread.modulationAmounts, evolveSpread.contextualModAmounts, coords.dest, 0, audioLevelDb) / 100.0;
    float grow = applyModulation(evolveGrow.value, evolveGrow.minValue, evolveGrow.maxValue, evolveGrow.modulationAmounts, evolveGrow.contextualModAmounts, coords.dest, 0, audioLevelDb) / 100.0;
    float swirl = applyModulation(evolveSwirl.value, evolveSwirl.minValue, evolveSwirl.maxValue, evolveSwirl.modulationAmounts, evolveSwirl.contextualModAmounts, coords.dest, 0, audioLevelDb) / 100.0;
    float driftX = applyModulation(evolveDriftX.value, evolveDriftX.minValue, evolveDriftX.maxValue, evolveDriftX.modulationAmounts, evolveDriftX.contextualModAmounts, coords.dest, 0, audioLevelDb) / 100.0;
    float driftY = applyModulation(evolveDriftY.value, evolveDriftY.minValue, evolveDriftY.maxValue, evolveDriftY.modulationAmounts, evolveDriftY.contextualModAmounts, coords.dest, 0, audioLevelDb) / 100.0;
    float decay = applyModulation(evolveDecay.value, evolveDecay.minValue, evolveDecay.maxValue, evolveDecay.modulationAmounts, evolveDecay.contextualModAmounts, coords.dest, 0, audioLevelDb) / 100.0;
    float scaleX = applyModulation(evolveScaleX.value, evolveScaleX.minValue, evolveScaleX.maxValue, evolveScaleX.modulationAmounts, evolveScaleX.contextualModAmounts, coords.dest, 0, audioLevelDb) / 100.0;
    float scaleY = applyModulation(evolveScaleY.value, evolveScaleY.minValue, evolveScaleY.maxValue, evolveScaleY.modulationAmounts, evolveScaleY.contextualModAmounts, coords.dest, 0, audioLevelDb) / 100.0;

    // Scale factors for neighborhood sampling (convert percentage to UV offset)
    float offsetX = abs(scaleX) * 0.05;
    float offsetY = abs(scaleY) * 0.05;

    // Sample neighborhood with edge mode handling
    vec4 center = sampleWithEdgeMode(coords.source, coords.dest, sourceOffsetX, sourceOffsetY);
    vec4 left = sampleWithEdgeMode(coords.source + vec2(-offsetX, 0.0), coords.dest, sourceOffsetX - offsetX, sourceOffsetY);
    vec4 right = sampleWithEdgeMode(coords.source + vec2(offsetX, 0.0), coords.dest, sourceOffsetX + offsetX, sourceOffsetY);
    vec4 up = sampleWithEdgeMode(coords.source + vec2(0.0, offsetY), coords.dest, sourceOffsetX, sourceOffsetY + offsetY);
    vec4 down = sampleWithEdgeMode(coords.source + vec2(0.0, -offsetY), coords.dest, sourceOffsetX, sourceOffsetY - offsetY);

    // Calculate gradient (for advection) - based on magnitude differences
    vec2 gradientL = vec2(
        getMag(right.rg) - getMag(left.rg),
        getMag(up.rg) - getMag(down.rg)
    );
    vec2 gradientR = vec2(
        getMag(right.ba) - getMag(left.ba),
        getMag(up.ba) - getMag(down.ba)
    );

    // Add swirl (rotate gradient 90 degrees and blend with original)
    vec2 swirlGradientL = vec2(-gradientL.y, gradientL.x);
    vec2 swirlGradientR = vec2(-gradientR.y, gradientR.x);
    vec2 flowDirectionL = mix(gradientL, swirlGradientL, swirl);
    vec2 flowDirectionR = mix(gradientR, swirlGradientR, swirl);

    // Add drift bias
    vec2 driftBias = vec2(driftX, driftY) * 0.1;
    flowDirectionL += driftBias;
    flowDirectionR += driftBias;

    // Advect: sample from upstream position with edge mode handling
    vec2 advectedUvL = coords.source - flowDirectionL * flow * 0.5;
    vec2 advectedUvR = coords.source - flowDirectionR * flow * 0.5;
    vec4 advectedL = sampleWithEdgeMode(advectedUvL, coords.dest, sourceOffsetX - flowDirectionL.x * flow * 0.5, sourceOffsetY - flowDirectionL.y * flow * 0.5);
    vec4 advectedR = sampleWithEdgeMode(advectedUvR, coords.dest, sourceOffsetX - flowDirectionR.x * flow * 0.5, sourceOffsetY - flowDirectionR.y * flow * 0.5);

    // Diffuse: Laplacian (neighbor average - center)
    float neighborAvgL = (getMag(left.rg) + getMag(right.rg) + getMag(up.rg) + getMag(down.rg)) / 4.0;
    float neighborAvgR = (getMag(left.ba) + getMag(right.ba) + getMag(up.ba) + getMag(down.ba)) / 4.0;
    float laplacianL = neighborAvgL - getMag(center.rg);
    float laplacianR = neighborAvgR - getMag(center.ba);

    // Get magnitudes from advected samples
    float magL = getMag(advectedL.rg);
    float magR = getMag(advectedR.ba);

    // React: non-linear growth/shrinking (quadratic term)
    float reactionL = magL * magL * grow * 2.0;
    float reactionR = magR * magR * grow * 2.0;

    // Combine: advected + diffusion + reaction - decay
    float newMagL = magL + laplacianL * spread * 0.5 + reactionL - magL * decay * 0.1;
    float newMagR = magR + laplacianR * spread * 0.5 + reactionR - magR * decay * 0.1;

    // Clamp to valid range
    newMagL = max(0.0, newMagL);
    newMagR = max(0.0, newMagR);

    // Preserve phase from advected sample
    vec4 resultTexel = vec4(
        fromPolar(newMagL, getPhase(advectedL.rg)),
        fromPolar(newMagR, getPhase(advectedR.ba))
    );

    outColor = applyBrush(originalTexel, resultTexel, weight, coords.dest, vUv);
}
