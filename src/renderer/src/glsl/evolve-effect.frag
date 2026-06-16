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

#include "edge-mode.glsl"

void main() {
    ProcessingUvs coords = getProcessingUvs(vUv);
    vec4 originalTexel = texture(destSpectrogramTex, vUv);
    float audioLevelDb = getAudioLevelDb(coords.dest);
    vec2 weight = getBrushWeight(coords.dest, audioLevelDb);
    if (weight.x <= 0.0 && weight.y <= 0.0) {
        outColor = originalTexel;
        return;
    }


    // Per-channel dynamics scalars (applied to pre-computed L/R samples).
    vec2 mods[NUM_MODULATORS];
    sampleModulators(mods);
    vec2 flow = applyModulationCached(evolveFlow.value, evolveFlow.minValue, evolveFlow.maxValue, evolveFlow.modulationAmounts, evolveFlow.contextualModAmounts, evolveFlow.macroAmounts, mods) / 100.0;
    vec2 spread = applyModulationCached(evolveSpread.value, evolveSpread.minValue, evolveSpread.maxValue, evolveSpread.modulationAmounts, evolveSpread.contextualModAmounts, evolveSpread.macroAmounts, mods) / 100.0;
    vec2 grow = applyModulationCached(evolveGrow.value, evolveGrow.minValue, evolveGrow.maxValue, evolveGrow.modulationAmounts, evolveGrow.contextualModAmounts, evolveGrow.macroAmounts, mods) / 100.0;
    vec2 swirl = applyModulationCached(evolveSwirl.value, evolveSwirl.minValue, evolveSwirl.maxValue, evolveSwirl.modulationAmounts, evolveSwirl.contextualModAmounts, evolveSwirl.macroAmounts, mods) / 100.0;
    vec2 driftX = applyModulationCached(evolveDriftX.value, evolveDriftX.minValue, evolveDriftX.maxValue, evolveDriftX.modulationAmounts, evolveDriftX.contextualModAmounts, evolveDriftX.macroAmounts, mods) / 100.0;
    vec2 driftY = applyModulationCached(evolveDriftY.value, evolveDriftY.minValue, evolveDriftY.maxValue, evolveDriftY.modulationAmounts, evolveDriftY.contextualModAmounts, evolveDriftY.macroAmounts, mods) / 100.0;
    vec2 decay = applyModulationCached(evolveDecay.value, evolveDecay.minValue, evolveDecay.maxValue, evolveDecay.modulationAmounts, evolveDecay.contextualModAmounts, evolveDecay.macroAmounts, mods) / 100.0;
    // Neighborhood scale feeds source sampling; stereo-aware with fast-path.
    vec2 scaleX = applyModulationCached(evolveScaleX.value, evolveScaleX.minValue, evolveScaleX.maxValue, evolveScaleX.modulationAmounts, evolveScaleX.contextualModAmounts, evolveScaleX.macroAmounts, mods) / 100.0;
    vec2 scaleY = applyModulationCached(evolveScaleY.value, evolveScaleY.minValue, evolveScaleY.maxValue, evolveScaleY.modulationAmounts, evolveScaleY.contextualModAmounts, evolveScaleY.macroAmounts, mods) / 100.0;

    bool sameNeighborhood = (scaleX.x == scaleX.y) && (scaleY.x == scaleY.y) && coords.sameSourceUv;

    // Sample the L-channel neighborhood (+ reuse for R when sameNeighborhood).
    float offsetXL = abs(scaleX.x) * 0.05;
    float offsetYL = abs(scaleY.x) * 0.05;
    vec4 centerL = sampleWithEdgeMode(coords.sourceL, coords.dest, sourceOffsetX, sourceOffsetY, evolveEdgeMode);
    vec4 leftL = sampleWithEdgeMode(coords.sourceL + vec2(-offsetXL, 0.0), coords.dest, sourceOffsetX - offsetXL, sourceOffsetY, evolveEdgeMode);
    vec4 rightL = sampleWithEdgeMode(coords.sourceL + vec2(offsetXL, 0.0), coords.dest, sourceOffsetX + offsetXL, sourceOffsetY, evolveEdgeMode);
    vec4 upL = sampleWithEdgeMode(coords.sourceL + vec2(0.0, offsetYL), coords.dest, sourceOffsetX, sourceOffsetY + offsetYL, evolveEdgeMode);
    vec4 downL = sampleWithEdgeMode(coords.sourceL + vec2(0.0, -offsetYL), coords.dest, sourceOffsetX, sourceOffsetY - offsetYL, evolveEdgeMode);

    vec4 centerR, leftR, rightR, upR, downR;
    if (sameNeighborhood) {
        centerR = centerL; leftR = leftL; rightR = rightL; upR = upL; downR = downL;
    } else {
        float offsetXR = abs(scaleX.y) * 0.05;
        float offsetYR = abs(scaleY.y) * 0.05;
        centerR = sampleWithEdgeMode(coords.sourceR, coords.dest, sourceOffsetX, sourceOffsetY, evolveEdgeMode);
        leftR = sampleWithEdgeMode(coords.sourceR + vec2(-offsetXR, 0.0), coords.dest, sourceOffsetX - offsetXR, sourceOffsetY, evolveEdgeMode);
        rightR = sampleWithEdgeMode(coords.sourceR + vec2(offsetXR, 0.0), coords.dest, sourceOffsetX + offsetXR, sourceOffsetY, evolveEdgeMode);
        upR = sampleWithEdgeMode(coords.sourceR + vec2(0.0, offsetYR), coords.dest, sourceOffsetX, sourceOffsetY + offsetYR, evolveEdgeMode);
        downR = sampleWithEdgeMode(coords.sourceR + vec2(0.0, -offsetYR), coords.dest, sourceOffsetX, sourceOffsetY - offsetYR, evolveEdgeMode);
    }

    // Calculate gradient (for advection) - based on magnitude differences
    vec2 gradientL = vec2(
        getMag(rightL.rg) - getMag(leftL.rg),
        getMag(upL.rg) - getMag(downL.rg)
    );
    vec2 gradientR = vec2(
        getMag(rightR.ba) - getMag(leftR.ba),
        getMag(upR.ba) - getMag(downR.ba)
    );

    // Add swirl (rotate gradient 90 degrees and blend with original)
    vec2 swirlGradientL = vec2(-gradientL.y, gradientL.x);
    vec2 swirlGradientR = vec2(-gradientR.y, gradientR.x);
    vec2 flowDirectionL = mix(gradientL, swirlGradientL, swirl.x);
    vec2 flowDirectionR = mix(gradientR, swirlGradientR, swirl.y);

    // Per-channel drift bias
    vec2 driftBiasL = vec2(driftX.x, driftY.x) * 0.1;
    vec2 driftBiasR = vec2(driftX.y, driftY.y) * 0.1;
    flowDirectionL += driftBiasL;
    flowDirectionR += driftBiasR;

    // Advect: sample from upstream position with edge mode handling
    vec2 advectedUvL = coords.sourceL - flowDirectionL * flow.x * 0.5;
    vec2 advectedUvR = coords.sourceR - flowDirectionR * flow.y * 0.5;
    vec4 advectedL = sampleWithEdgeMode(advectedUvL, coords.dest, sourceOffsetX - flowDirectionL.x * flow.x * 0.5, sourceOffsetY - flowDirectionL.y * flow.x * 0.5, evolveEdgeMode);
    vec4 advectedR = sampleWithEdgeMode(advectedUvR, coords.dest, sourceOffsetX - flowDirectionR.x * flow.y * 0.5, sourceOffsetY - flowDirectionR.y * flow.y * 0.5, evolveEdgeMode);

    // Diffuse: Laplacian (neighbor average - center)
    float neighborAvgL = (getMag(leftL.rg) + getMag(rightL.rg) + getMag(upL.rg) + getMag(downL.rg)) / 4.0;
    float neighborAvgR = (getMag(leftR.ba) + getMag(rightR.ba) + getMag(upR.ba) + getMag(downR.ba)) / 4.0;
    float laplacianL = neighborAvgL - getMag(centerL.rg);
    float laplacianR = neighborAvgR - getMag(centerR.ba);

    // Get magnitudes from advected samples
    float magL = getMag(advectedL.rg);
    float magR = getMag(advectedR.ba);

    // React: non-linear growth/shrinking (quadratic term)
    float reactionL = magL * magL * grow.x * 2.0;
    float reactionR = magR * magR * grow.y * 2.0;

    // Combine: advected + diffusion + reaction - decay
    float newMagL = magL + laplacianL * spread.x * 0.5 + reactionL - magL * decay.x * 0.1;
    float newMagR = magR + laplacianR * spread.y * 0.5 + reactionR - magR * decay.y * 0.1;

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
