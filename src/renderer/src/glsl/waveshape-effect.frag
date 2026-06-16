#include "effect-common.glsl";
#include "effect-wrapper.glsl"

uniform int waveshapeMode;
uniform Parameter waveshapeDrive;
uniform Parameter waveshapeTilt;

// Triangle-wave folder: reflects back into [-1, 1].
float fold(float x) {
  float a = abs(x);
  float m = mod(a, 2.0);
  return (m > 1.0 ? 2.0 - m : m) * sign(x);
}

// Sawtooth wrap: modulo to [-1, 1].
float wrap(float x) {
  return mod(x + 1.0, 2.0) - 1.0;
}

vec2 applyWaveshape(vec2 magPhase, float drive, float tilt) {
  float M = magPhase.x;
  float x = M * drive;

  // Apply waveshaper to magnitude only — operating on the phase would cause
  // discontinuities across STFT frames that cancel in overlap-add reconstruction.
  float shaped;
  if (waveshapeMode == 0) {
    shaped = tanh(x);
  } else if (waveshapeMode == 1) {
    shaped = clamp(x, 0.0, 1.0);
  } else if (waveshapeMode == 2) {
    shaped = abs(x);
  } else if (waveshapeMode == 3) {
    float a = abs(x); float m = mod(a, 2.0);
    shaped = m > 1.0 ? 2.0 - m : m;
  } else if (waveshapeMode == 4) {
    shaped = mod(x, 1.0);
  } else {
    shaped = abs(sin(x));
  }

  // Tilt: shift the phase proportional to how much this bin was saturated.
  // Heavily clipped bins get a phase offset; linear bins are untouched.
  // This creates distortion-coupled phase character unique to spectral processing.
  float compression = (x > 1e-4) ? clamp(1.0 - shaped / x, 0.0, 1.0) : 0.0;
  float newPhase = magPhase.y + tilt * compression * PI;

  return vec2(shaped, newPhase);
}

vec4 applyEffectStroke(vec4 src, ProcessingUvs coords, float audioLevelDb) {
  bool used[NUM_MODULATORS];
  for (int _mi = 0; _mi < NUM_MODULATORS; _mi++) {
    used[_mi] = (waveshapeDrive.modulationAmounts[_mi] != 0.0);
  }
  vec2 mods[NUM_MODULATORS];
  evalModulators(coords.dest, 0, audioLevelDb, used, mods);
  vec2 drive = applyModulationCached(
    waveshapeDrive.value, waveshapeDrive.minValue, waveshapeDrive.maxValue,
    waveshapeDrive.modulationAmounts, waveshapeDrive.contextualModAmounts, waveshapeDrive.macroAmounts,
    mods
  );
  vec2 tilt = applyModulation(
    waveshapeTilt.value, waveshapeTilt.minValue, waveshapeTilt.maxValue,
    waveshapeTilt.modulationAmounts, waveshapeTilt.contextualModAmounts, waveshapeTilt.macroAmounts,
    coords.dest, 1, audioLevelDb
  );

  return vec4(applyWaveshape(src.rg, drive.x, tilt.x), applyWaveshape(src.ba, drive.y, tilt.y));
}
