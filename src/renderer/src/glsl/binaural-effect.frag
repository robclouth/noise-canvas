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

// Woodworth's ITD model: a pure time delay in seconds for a source at azimuth
// azDeg (0=front, +=right, -=left). Max ≈0.66 ms at ±90°. Because this is a
// delay in seconds it maps to the linear phase shift -2π·f·τ — smooth across
// frequency, which plays well with the multi-resolution spectrogram.
const float HEAD_RADIUS = 0.0875;
const float SOUND_SPEED = 343.0;
const float R_OVER_C = HEAD_RADIUS / SOUND_SPEED;

float computeItd(float azDeg) {
  float az = mod(radians(azDeg) + PI, TWO_PI) - PI; // wrap to [-π, π]
  float absAz = abs(az);
  float tau = absAz <= PI * 0.5
    ? R_OVER_C * (sin(absAz) + absAz)
    : R_OVER_C * (PI - absAz + sin(absAz));
  return sign(az) * tau;
}

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
  vec2 mods[NUM_MODULATORS];
  sampleModulators(mods);
  float azValue = applyModulationCachedMono(
    azimuth.value, azimuth.minValue, azimuth.maxValue,
    azimuth.modulationAmounts, azimuth.contextualModAmounts, azimuth.macroAmounts,
    mods
  );

  float distValue = applyModulationCachedMono(
    distance.value, distance.minValue, distance.maxValue,
    distance.modulationAmounts, distance.contextualModAmounts, distance.macroAmounts,
    mods
  );

  float stereoAngleValue = applyModulationCachedMono(
    stereoAngle.value, stereoAngle.minValue, stereoAngle.maxValue,
    stereoAngle.modulationAmounts, stereoAngle.contextualModAmounts, stereoAngle.macroAmounts,
    mods
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

  // Magnitudes from the HRTF (ILD + pinna colouration); phase gets a pure
  // linear-phase ITD delay per virtual source — no HRTF phase rotation, which
  // was the source of the bin-to-bin phase scrambling.
  float srcMagL = getMag(sourceTexel.rg);
  float srcPhaseL = getPhase(sourceTexel.rg);
  float srcMagR = getMag(sourceTexel.ba);
  float srcPhaseR = getPhase(sourceTexel.ba);

  // Symmetric half-delay: left ear lags by itd/2 for a right-side source.
  // Phase shift = -2π·f·delay, so +half-delay → -π·f·itd, -half-delay → +π·f·itd.
  float itdLeftSrc  = computeItd(leftAz);
  float itdRightSrc = computeItd(rightAz);
  float phiLL = -PI * bandFreqHz * itdLeftSrc;   // left ear, from L-channel virtual source
  float phiLR = +PI * bandFreqHz * itdLeftSrc;   // right ear, from L-channel virtual source
  float phiRL = -PI * bandFreqHz * itdRightSrc;  // left ear, from R-channel virtual source
  float phiRR = +PI * bandFreqHz * itdRightSrc;  // right ear, from R-channel virtual source

  float magLL = srcMagL * hrtfL.r * atten;
  float magLR = srcMagL * hrtfL.b * atten;
  float magRL = srcMagR * hrtfR.r * atten;
  float magRR = srcMagR * hrtfR.b * atten;

  // Sum contributions per ear in complex space — the two virtual sources arrive
  // at each ear with different ITDs, so their superposition must be coherent.
  vec2 outL = polarFromComplex(
    toComplex(fromPolar(magLL, srcPhaseL + phiLL)) +
    toComplex(fromPolar(magRL, srcPhaseR + phiRL))
  );
  vec2 outR = polarFromComplex(
    toComplex(fromPolar(magLR, srcPhaseL + phiLR)) +
    toComplex(fromPolar(magRR, srcPhaseR + phiRR))
  );

  return vec4(outL, outR);
}
