// The display textures store magnitudes as dB in RG16F. Half-float dB keeps a
// uniform step (at worst 0.125 dB) across the whole audible range, where a
// linear half-float magnitude loses the quiet floor. The epsilon matches the
// one interpolateComplex mixes magnitudes under, so blending stored dB along
// time gives the same result as blending the magnitudes themselves.
const float DISPLAY_MAGS_EPSILON = 1.0e-9;

float displayMagToDb(float mag) {
  return 20.0 * log(mag + DISPLAY_MAGS_EPSILON) / log(10.0);
}

float displayDbToMag(float db) {
  return max(pow(10.0, db / 20.0) - DISPLAY_MAGS_EPSILON, 0.0);
}
