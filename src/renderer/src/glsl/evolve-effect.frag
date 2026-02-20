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
    vec4 center = sampleWithEdgeMode(coords.source, coords.dest, sourceOffsetX, sourceOffsetY, evolveEdgeMode);
    vec4 left = sampleWithEdgeMode(coords.source + vec2(-offsetX, 0.0), coords.dest, sourceOffsetX - offsetX, sourceOffsetY, evolveEdgeMode);
    vec4 right = sampleWithEdgeMode(coords.source + vec2(offsetX, 0.0), coords.dest, sourceOffsetX + offsetX, sourceOffsetY, evolveEdgeMode);
    vec4 up = sampleWithEdgeMode(coords.source + vec2(0.0, offsetY), coords.dest, sourceOffsetX, sourceOffsetY + offsetY, evolveEdgeMode);
    vec4 down = sampleWithEdgeMode(coords.source + vec2(0.0, -offsetY), coords.dest, sourceOffsetX, sourceOffsetY - offsetY, evolveEdgeMode);

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
    vec4 advectedL = sampleWithEdgeMode(advectedUvL, coords.dest, sourceOffsetX - flowDirectionL.x * flow * 0.5, sourceOffsetY - flowDirectionL.y * flow * 0.5, evolveEdgeMode);
    vec4 advectedR = sampleWithEdgeMode(advectedUvR, coords.dest, sourceOffsetX - flowDirectionR.x * flow * 0.5, sourceOffsetY - flowDirectionR.y * flow * 0.5, evolveEdgeMode);

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
