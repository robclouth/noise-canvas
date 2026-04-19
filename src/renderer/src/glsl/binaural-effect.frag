/**
 * Binaural Effect Shader
 *
 * Applies HRTF-based binaural spatialization to audio.
 * The HRTF texture is pre-baked as a 2D texture:
 *   X = azimuth (0° to 360°)
 *   Y = frequency (log-scale)
 *   RGBA = [magL, phaseL, magR, phaseR]
 *
 * Each frequency band can have its own azimuth via modulation.
 *
 * Stereo Angle controls how L/R channels are spread:
 *   - At 0°: Both channels go through same HRTF (mono panning)
 *   - At 180°: L channel at azimuth-90°, R channel at azimuth+90° (full stereo spread)
 */

#include "effect-common.glsl"
#include "effect-wrapper.glsl"

// HRTF texture and metadata
uniform sampler2D hrtfTex;
uniform float hrtfMinFreq;
uniform float hrtfMaxFreq;
uniform int hrtfNumAzimuths;
uniform int hrtfNumFreqBands;

// Effect parameters
uniform Parameter azimuth;
uniform Parameter distance;
uniform Parameter stereoAngle;

// Sample HRTF at given azimuth and frequency
vec4 sampleHrtf(float az, float bandFreqHz) {
  // Map azimuth to texture U coordinate [0, 1]
  // Azimuth range is -180 to +180, texture is stored as -180 to +180
  float u = (az + 180.0) / 360.0;
  // Wrap around for values outside [-180, 180]
  u = fract(u);

  // Map frequency to texture V coordinate [0, 1] using log scale
  float totalOctaves = log2(hrtfMaxFreq / hrtfMinFreq);
  float v = log2(max(bandFreqHz, hrtfMinFreq) / hrtfMinFreq) / totalOctaves;
  v = clamp(v, 0.0, 1.0);

  // Sample HRTF texture with hardware bilinear interpolation
  // returns [magL, phaseL, magR, phaseR]
  return texture(hrtfTex, vec2(u, v));
}

vec4 applyEffectStroke(vec4 sourceTexel, ProcessingUvs coords, float audioLevelDb) {
  // Binaural positioning is shared across channels (HRTF sampling geometry);
  // collapse modulation to scalar.
  float azValue = applyModulationMono(
    azimuth.value, azimuth.minValue, azimuth.maxValue,
    azimuth.modulationAmounts, azimuth.contextualModAmounts, azimuth.macroAmounts,
    coords.dest, 0, audioLevelDb
  );

  float distValue = applyModulationMono(
    distance.value, distance.minValue, distance.maxValue,
    distance.modulationAmounts, distance.contextualModAmounts, distance.macroAmounts,
    coords.dest, 0, audioLevelDb
  );

  float stereoAngleValue = applyModulationMono(
    stereoAngle.value, stereoAngle.minValue, stereoAngle.maxValue,
    stereoAngle.modulationAmounts, stereoAngle.contextualModAmounts, stereoAngle.macroAmounts,
    coords.dest, 0, audioLevelDb
  );

  // Get frequency of this band from metadata
  vec4 meta = getDestMetadata(coords.dest);
  float bandFreqHz = meta.a;

  // Calculate azimuths for left and right virtual sources
  // At stereoAngle=0: both at azValue (mono)
  // At stereoAngle=180: L at azValue-90, R at azValue+90
  float halfSpread = stereoAngleValue / 2.0;
  float leftAz = azValue - halfSpread;
  float rightAz = azValue + halfSpread;

  // Sample HRTF for both virtual source positions
  vec4 hrtfL = sampleHrtf(leftAz, bandFreqHz);
  vec4 hrtfR = sampleHrtf(rightAz, bandFreqHz);

  // Distance attenuation: inverse distance law
  float atten = 1.0 / max(distValue, 0.1);

  // High-frequency air absorption (increases with distance and frequency)
  float airAbsorb = exp(-0.0001 * distValue * bandFreqHz);
  atten *= airAbsorb;

  // Extract source magnitude and phase
  float srcMagL = getMag(sourceTexel.rg);
  float srcPhaseL = getPhase(sourceTexel.rg);
  float srcMagR = getMag(sourceTexel.ba);
  float srcPhaseR = getPhase(sourceTexel.ba);

  // Apply HRTF to each channel separately:
  // Left source channel goes through HRTF at leftAz position
  // hrtfL.r = left ear magnitude, hrtfL.b = right ear magnitude
  float outMagLL = srcMagL * hrtfL.r * atten;  // Left channel -> left ear
  float outPhaseLL = srcPhaseL + hrtfL.g;
  float outMagLR = srcMagL * hrtfL.b * atten;  // Left channel -> right ear
  float outPhaseLR = srcPhaseL + hrtfL.a;

  // Right source channel goes through HRTF at rightAz position
  float outMagRL = srcMagR * hrtfR.r * atten;  // Right channel -> left ear
  float outPhaseRL = srcMagR > 0.0 ? srcPhaseR + hrtfR.g : 0.0;
  float outMagRR = srcMagR * hrtfR.b * atten;  // Right channel -> right ear
  float outPhaseRR = srcMagR > 0.0 ? srcPhaseR + hrtfR.a : 0.0;

  // Sum contributions to each ear
  // Left ear = (left channel through left HRTF) + (right channel through right HRTF)
  vec2 leftEarFromL = fromPolar(outMagLL, outPhaseLL);
  vec2 leftEarFromR = fromPolar(outMagRL, outPhaseRL);
  vec2 outL = leftEarFromL + leftEarFromR;

  // Right ear = (left channel through left HRTF) + (right channel through right HRTF)
  vec2 rightEarFromL = fromPolar(outMagLR, outPhaseLR);
  vec2 rightEarFromR = fromPolar(outMagRR, outPhaseRR);
  vec2 outR = rightEarFromL + rightEarFromR;

  return vec4(outL, outR);
}
