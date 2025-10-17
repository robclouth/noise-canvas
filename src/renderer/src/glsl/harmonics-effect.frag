precision highp float;
varying vec2 vUv;

#include "effect-common.glsl"

uniform Parameter harmonicsPower;
uniform Parameter harmonicsFalloff;

vec4 applyEffectStroke(vec4 sourceTexel, ProcessingUvs coords, float audioLevelDb) {
    // Apply modulation to get the actual parameter values for this pixel
    float power = applyModulation(harmonicsPower.value, harmonicsPower.minValue, harmonicsPower.maxValue, harmonicsPower.modulationAmounts, coords.dest, 0, audioLevelDb);
    float falloff = applyModulation(harmonicsFalloff.value, harmonicsFalloff.minValue, harmonicsFalloff.maxValue, harmonicsFalloff.modulationAmounts, coords.dest, 0, audioLevelDb);
    
    // Threshold for ignoring weak harmonics
    const float AMPLITUDE_THRESHOLD = 0.001;
    const float MIN_MAG_FOR_PHASE = 1e-6;
    
    // Separate accumulators for magnitude and phase
    float sumMagL = 0.0;
    float sumMagR = 0.0;
    float sumPhaseL = 0.0;
    float sumPhaseR = 0.0;
    float sumWeight = 0.0;
    float sumPhaseWeightL = 0.0;
    float sumPhaseWeightR = 0.0;
    
    // Use the fundamental (current band) as the phase reference
    float fundamentalMagL = getMag(sourceTexel.rg);
    float fundamentalMagR = getMag(sourceTexel.ba);
    float referencePhaseLFundamental = getPhase(sourceTexel.rg);
    float referencePhaseRFundamental = getPhase(sourceTexel.ba);
    
    // Add the fundamental (current band)
    sumMagL += fundamentalMagL;
    sumMagR += fundamentalMagR;
    
    // Only accumulate phase if magnitude is meaningful
    if (fundamentalMagL > MIN_MAG_FOR_PHASE) {
        sumPhaseL += referencePhaseLFundamental;
        sumPhaseWeightL += 1.0;
    }
    if (fundamentalMagR > MIN_MAG_FOR_PHASE) {
        sumPhaseR += referencePhaseRFundamental;
        sumPhaseWeightR += 1.0;
    }
    sumWeight += 1.0;
    
    // Calculate harmonics dynamically
    for (int h = 2; h < 64; h++) {
        // Calculate the harmonic amplitude with falloff 
        float amplitude = pow(float(h), -falloff / 20.0);
        
        // Skip harmonics that are too weak to matter
        if (amplitude < AMPLITUDE_THRESHOLD) {
            // For positive falloff, harmonics only get weaker, so we can break early
            if (falloff > 0.0) {
                break;
            }
            continue;
        }
        
        // Calculate the pixel offset for this harmonic
        float pixelOffset = destBandsPerOctave * power * log2(float(h));
        
        // Calculate the vertical UV offset
        float offsetV = -pixelOffset / destBandCount;
        vec2 harmonicUv = coords.source + vec2(0.0, offsetV);
        
        // Bounds check: skip if sampling outside valid frequency range
        if (harmonicUv.y < 0.0 || harmonicUv.y > 1.0) {
            continue;
        }
        
        // Sample the harmonic from the source
        vec4 harmonicColor = sampleSourceInterp(harmonicUv);
        
        float harmonicMagL = getMag(harmonicColor.rg);
        float harmonicMagR = getMag(harmonicColor.ba);
        
        // Accumulate magnitude
        sumMagL += harmonicMagL * amplitude;
        sumMagR += harmonicMagR * amplitude;
        
        // Only accumulate phase from harmonics with meaningful magnitude
        // This prevents noise from near-zero samples from corrupting the phase
        if (harmonicMagL > MIN_MAG_FOR_PHASE) {
            float harmonicPhaseL = getPhase(harmonicColor.rg);
            float deltaPhaseL = harmonicPhaseL - referencePhaseLFundamental;
            sumPhaseL += (referencePhaseLFundamental + unwrapPhase(deltaPhaseL)) * amplitude;
            sumPhaseWeightL += amplitude;
        }
        
        if (harmonicMagR > MIN_MAG_FOR_PHASE) {
            float harmonicPhaseR = getPhase(harmonicColor.ba);
            float deltaPhaseR = harmonicPhaseR - referencePhaseRFundamental;
            sumPhaseR += (referencePhaseRFundamental + unwrapPhase(deltaPhaseR)) * amplitude;
            sumPhaseWeightR += amplitude;
        }
        
        sumWeight += amplitude;
    }
    
    // Normalize and reconstruct complex numbers from polar form
    vec4 result = sourceTexel;
    if (sumWeight > 0.0) {
        float avgMagL = sumMagL / sumWeight;
        float avgMagR = sumMagR / sumWeight;
        
        // Use the phase-specific weights for phase averaging
        float avgPhaseL = sumPhaseWeightL > 0.0 ? sumPhaseL / sumPhaseWeightL : referencePhaseLFundamental;
        float avgPhaseR = sumPhaseWeightR > 0.0 ? sumPhaseR / sumPhaseWeightR : referencePhaseRFundamental;
        
        vec2 finalL = fromPolar(avgMagL, avgPhaseL);
        vec2 finalR = fromPolar(avgMagR, avgPhaseR);
        
        result = vec4(finalL, finalR);
    }
    
    return result;
}

#include "effect-wrapper.glsl"
