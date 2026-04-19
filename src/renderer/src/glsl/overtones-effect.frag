#include "effect-common.glsl"

uniform Parameter overtonesScale;
uniform Parameter overtonesDecay;
uniform sampler2D shapeTexture;

vec4 applyEffectStroke(vec4 sourceTexel, ProcessingUvs coords, float audioLevelDb) {
    // Stereo-aware harmonic placement. scale drives the vertical UV offset per
    // harmonic; decay shapes the per-harmonic weight curve. Fast path samples
    // once per harmonic when both params and source UVs match across channels.
    vec2 scale = applyModulation(overtonesScale.value, overtonesScale.minValue, overtonesScale.maxValue, overtonesScale.modulationAmounts, overtonesScale.contextualModAmounts, overtonesScale.macroAmounts, coords.dest, 0, audioLevelDb);
    vec2 decay = applyModulation(overtonesDecay.value, overtonesDecay.minValue, overtonesDecay.maxValue, overtonesDecay.modulationAmounts, overtonesDecay.contextualModAmounts, overtonesDecay.macroAmounts, coords.dest, 0, audioLevelDb);

    bool sameHarmonics = (scale.x == scale.y) && (decay.x == decay.y) && coords.sameSourceUv;

    // Separate accumulators for magnitude and phase
    float sumMagL = 0.0;
    float sumMagR = 0.0;
    float sumPhaseL = 0.0;
    float sumPhaseR = 0.0;
    float sumPhaseWeightL = 0.0;
    float sumPhaseWeightR = 0.0;

    // Use the fundamental (current band) as the phase reference
    float referencePhaseLFundamental = sourceTexel.y;
    float referencePhaseRFundamental = sourceTexel.w;

    // Add the fundamental (current band)
    sumMagL += sourceTexel.x;
    sumMagR += sourceTexel.z;

    sumPhaseL += referencePhaseLFundamental;
    sumPhaseWeightL += 1.0;

    sumPhaseR += referencePhaseRFundamental;
    sumPhaseWeightR += 1.0;

    ivec2 textureSize2d = textureSize(shapeTexture, 0);

    // Calculate harmonics dynamically
    for (int si = 0; si < textureSize2d.x; si++) {
        float semitone = texelFetch(shapeTexture, ivec2(si, 0), 0).r;

        float amplitudeL = smoothstep(1.0, 0.0, float(si) / float(textureSize2d.x - 1) * decay.x);
        float amplitudeR = sameHarmonics ? amplitudeL : smoothstep(1.0, 0.0, float(si) / float(textureSize2d.x - 1) * decay.y);

        // Per-channel pixel offset for this harmonic.
        float pixelOffsetL = destBandsPerOctave * semitone / 12.0 * scale.x;
        float offsetVL = -pixelOffsetL / destBandCount;
        vec2 overtoneUvL = coords.sourceL + vec2(0.0, offsetVL);
        bool inL = overtoneUvL.y >= 0.0 && overtoneUvL.y <= 1.0;

        if (sameHarmonics) {
            if (!inL) continue;
            vec4 harmonicColor = getTransformedSample(overtoneUvL, coords.dest, 1.0, 1.0, 0.0, offsetVL);
            sumMagL += getMag(harmonicColor.rg) * amplitudeL;
            sumMagR += getMag(harmonicColor.ba) * amplitudeL;
            float deltaPhaseL = getPhase(harmonicColor.rg) - referencePhaseLFundamental;
            float deltaPhaseR = getPhase(harmonicColor.ba) - referencePhaseRFundamental;
            sumPhaseL += (referencePhaseLFundamental + unwrapPhase(deltaPhaseL)) * amplitudeL;
            sumPhaseR += (referencePhaseRFundamental + unwrapPhase(deltaPhaseR)) * amplitudeL;
            sumPhaseWeightL += amplitudeL;
            sumPhaseWeightR += amplitudeL;
        } else {
            if (inL) {
                vec4 harmonicColorL = getTransformedSample(overtoneUvL, coords.dest, 1.0, 1.0, 0.0, offsetVL);
                sumMagL += getMag(harmonicColorL.rg) * amplitudeL;
                float deltaPhaseL = getPhase(harmonicColorL.rg) - referencePhaseLFundamental;
                sumPhaseL += (referencePhaseLFundamental + unwrapPhase(deltaPhaseL)) * amplitudeL;
                sumPhaseWeightL += amplitudeL;
            }
            float pixelOffsetR = destBandsPerOctave * semitone / 12.0 * scale.y;
            float offsetVR = -pixelOffsetR / destBandCount;
            vec2 overtoneUvR = coords.sourceR + vec2(0.0, offsetVR);
            bool inR = overtoneUvR.y >= 0.0 && overtoneUvR.y <= 1.0;
            if (inR) {
                vec4 harmonicColorR = getTransformedSample(overtoneUvR, coords.dest, 1.0, 1.0, 0.0, offsetVR);
                sumMagR += getMag(harmonicColorR.ba) * amplitudeR;
                float deltaPhaseR = getPhase(harmonicColorR.ba) - referencePhaseRFundamental;
                sumPhaseR += (referencePhaseRFundamental + unwrapPhase(deltaPhaseR)) * amplitudeR;
                sumPhaseWeightR += amplitudeR;
            }
        }
    }
    
    // The fundamental always contributes weight 1.0 per channel, so the phase
    // accumulator is non-empty; still guard in case floats collapse to zero.
    float avgPhaseL = sumPhaseWeightL > 0.0 ? sumPhaseL / sumPhaseWeightL : referencePhaseLFundamental;
    float avgPhaseR = sumPhaseWeightR > 0.0 ? sumPhaseR / sumPhaseWeightR : referencePhaseRFundamental;
    return vec4(fromPolar(sumMagL, avgPhaseL), fromPolar(sumMagR, avgPhaseR));
}

#include "effect-wrapper.glsl"
