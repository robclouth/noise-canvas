// The display texture stores magnitudes as dB in RG16F. Half-float dB keeps a
// uniform step (at worst 0.125 dB) across the whole audible range, where a
// linear half-float magnitude loses the quiet floor.
const float DISPLAY_MAGS_EPSILON = 1.0e-7;

float displayMagToDb(float mag) {
  return 20.0 * log(mag + DISPLAY_MAGS_EPSILON) / log(10.0);
}

float displayDbToMag(float db) {
  return max(pow(10.0, db / 20.0) - DISPLAY_MAGS_EPSILON, 0.0);
}
