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

// The flow step at full Flow, in neighbourhoods, and the most it may ever be.
// The cap is what gives the read an end: the gradient it follows grows with
// the sound, and without a cap a loud passage carries the read anywhere.
const float EVOLVE_FLOW_REACH = 10.0;
const float EVOLVE_FLOW_LIMIT = 8.0;

// How far the flow carries a point. The gradient gives the direction and how
// hard the point is pushed; the neighbourhood gives the distance, so the same
// brush travels the same time and pitch whatever the canvas holds.
vec2 evolveFlowStep(vec2 direction, float flow, vec2 neighbourhood) {
  vec2 limit = EVOLVE_FLOW_LIMIT * neighbourhood;
  return clamp(direction * flow * EVOLVE_FLOW_REACH * neighbourhood, -limit, limit);
}

void main() {
    vec2 destUv = packedToUnpackedUv(destInverseMapTex, vUv, destFrameCount, destBandCount);
    if (brushWeightIsZero(destUv)) {
        outColor = texture(destSpectrogramTex, vUv);
        return;
    }
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
    vec2 flow = resolveParameter(evolveFlow, mods) / 100.0;
    vec2 spread = resolveParameter(evolveSpread, mods) / 100.0;
    vec2 grow = resolveParameter(evolveGrow, mods) / 100.0;
    vec2 swirl = resolveParameter(evolveSwirl, mods) / 100.0;
    vec2 driftX = resolveParameter(evolveDriftX, mods) / 100.0;
    vec2 driftY = resolveParameter(evolveDriftY, mods) / 100.0;
    vec2 decay = resolveParameter(evolveDecay, mods) / 100.0;
    // The neighbourhood arrives as source UV, converted from beats and
    // semitones, where every other control here is a plain percentage.
    vec2 scaleX = resolveParameter(evolveScaleX, mods);
    vec2 scaleY = resolveParameter(evolveScaleY, mods);

    bool sameNeighborhood = (scaleX.x == scaleX.y) && (scaleY.x == scaleY.y) && coords.sameSourceUv;

    // Sample the L-channel neighborhood (+ reuse for R when sameNeighborhood).
    // The scales arrive as source UV, converted from beats and semitones.
    vec2 neighbourL = abs(vec2(scaleX.x, scaleY.x));
    vec2 neighbourR = abs(vec2(scaleX.y, scaleY.y));
    float offsetXL = neighbourL.x;
    float offsetYL = neighbourL.y;
    vec4 centerL = sampleWithEdgeMode(coords.sourceL, coords.dest, sourceOffsetX, sourceOffsetY, evolveEdgeMode);
    vec4 leftL = sampleWithEdgeMode(coords.sourceL + vec2(-offsetXL, 0.0), coords.dest, sourceOffsetX - offsetXL, sourceOffsetY, evolveEdgeMode);
    vec4 rightL = sampleWithEdgeMode(coords.sourceL + vec2(offsetXL, 0.0), coords.dest, sourceOffsetX + offsetXL, sourceOffsetY, evolveEdgeMode);
    vec4 upL = sampleWithEdgeMode(coords.sourceL + vec2(0.0, offsetYL), coords.dest, sourceOffsetX, sourceOffsetY + offsetYL, evolveEdgeMode);
    vec4 downL = sampleWithEdgeMode(coords.sourceL + vec2(0.0, -offsetYL), coords.dest, sourceOffsetX, sourceOffsetY - offsetYL, evolveEdgeMode);

    vec4 centerR, leftR, rightR, upR, downR;
    if (sameNeighborhood) {
        centerR = centerL; leftR = leftL; rightR = rightL; upR = upL; downR = downL;
    } else {
        float offsetXR = neighbourR.x;
        float offsetYR = neighbourR.y;
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
    vec2 stepL = evolveFlowStep(flowDirectionL, flow.x, neighbourL);
    vec2 stepR = evolveFlowStep(flowDirectionR, flow.y, neighbourR);
    vec2 advectedUvL = coords.sourceL - stepL;
    vec2 advectedUvR = coords.sourceR - stepR;
    // Every part of the input holds the neighbourhood reads; an advected read
    // is the one part's whose core holds its point.
    sourcePartMiss = false;
    vec4 advectedL = sampleWithEdgeMode(advectedUvL, coords.dest, sourceOffsetX - stepL.x, sourceOffsetY - stepL.y, evolveEdgeMode);
    bool missL = sourcePartMiss;
    sourcePartMiss = false;
    vec4 advectedR = sampleWithEdgeMode(advectedUvR, coords.dest, sourceOffsetX - stepR.x, sourceOffsetY - stepR.y, evolveEdgeMode);
    bool missR = sourcePartMiss;
    if (sourcePartOn && (sourcePartChannel == 0 ? missL : missR)) discard;

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
