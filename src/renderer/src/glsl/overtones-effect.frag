precision highp float;
in vec2 vUv;

#include "effect-common.glsl"

uniform Parameter overtonesScale;
uniform Parameter overtonesDecay;
uniform sampler2D shapeTexture;

vec4 applyEffectStroke(vec4 sourceTexel, ProcessingUvs coords, float audioLevelDb) {
    float scale = applyModulation(overtonesScale.value, overtonesScale.minValue, overtonesScale.maxValue, overtonesScale.modulationAmounts, coords.dest, 0, audioLevelDb);
    float decay = applyModulation(overtonesDecay.value, overtonesDecay.minValue, overtonesDecay.maxValue, overtonesDecay.modulationAmounts, coords.dest, 0, audioLevelDb);
  
    // Separate accumulators for magnitude and phase
    float sumMagL = 0.0;
    float sumMagR = 0.0;
    float sumPhaseL = 0.0;
    float sumPhaseR = 0.0;
    float sumWeight = 0.0;
    float sumPhaseWeightL = 0.0;
    float sumPhaseWeightR = 0.0;
    
    // Use the fundamental (current band) as the phase reference
    float fundamentalMagL = sourceTexel.x;
    float fundamentalMagR = sourceTexel.z;
    float referencePhaseLFundamental = sourceTexel.y;
    float referencePhaseRFundamental = sourceTexel.w;
    
    // Add the fundamental (current band)
    sumMagL += fundamentalMagL;
    sumMagR += fundamentalMagR;
    
    sumPhaseL += referencePhaseLFundamental;
    sumPhaseWeightL += 1.0;
    
    sumPhaseR += referencePhaseRFundamental;
    sumPhaseWeightR += 1.0;
    
    sumWeight += 1.0;

    ivec2 textureSize2d = textureSize(shapeTexture, 0);

    // Calculate harmonics dynamically
    for (int si = 0; si < textureSize2d.x; si++) {
        float semitone = texelFetch(shapeTexture, ivec2(si, 0), 0).r;

        float amplitude = smoothstep(1.0, 0.0, float(si) / float(textureSize2d.x - 1) * decay);
       
        // Calculate the pixel offset for this harmonic
        float pixelOffset = destBandsPerOctave * semitone / 12.0 * scale;
        
        // Calculate the vertical UV offset
        float offsetV = -pixelOffset / destBandCount;
        vec2 overtoneUv = coords.source + vec2(0.0, offsetV);
        
        // Bounds check: skip if sampling outside valid frequency range
        if (overtoneUv.y < 0.0 || overtoneUv.y > 1.0) {
            continue;
        }
        
        // Sample the harmonic from the source
        vec4 harmonicColor = getTransformedSample(overtoneUv, coords.dest, 1.0, 1.0, 0.0, offsetV);
        
        float harmonicMagL = getMag(harmonicColor.rg);
        float harmonicMagR = getMag(harmonicColor.ba);
        
        // Accumulate magnitude
        sumMagL += harmonicMagL * amplitude;
        sumMagR += harmonicMagR * amplitude;
        
        float harmonicPhaseL = getPhase(harmonicColor.rg);
        float deltaPhaseL = harmonicPhaseL - referencePhaseLFundamental;
        sumPhaseL += (referencePhaseLFundamental + unwrapPhase(deltaPhaseL)) * amplitude;
        sumPhaseWeightL += amplitude;
        
        float harmonicPhaseR = getPhase(harmonicColor.ba);
        float deltaPhaseR = harmonicPhaseR - referencePhaseRFundamental;
        sumPhaseR += (referencePhaseRFundamental + unwrapPhase(deltaPhaseR)) * amplitude;
        sumPhaseWeightR += amplitude;
        
        sumWeight += amplitude;
    }
    
    vec4 result = sourceTexel;
    if (sumWeight > 0.0) {
        float avgMagL = sumMagL ;
        float avgMagR = sumMagR ;
        
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
