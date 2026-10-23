#ifndef SCALE_SNAP_GLSL
#define SCALE_SNAP_GLSL

// Signed distance to the nearest in-scale pitch, indexed by absolute pitch
// class (0 = C); 0 for in-scale classes. Built by buildScaleOffsets.
uniform float scaleOffsets[12];
uniform float brushBasePitchAbsSemis;

// Snap a pitch in semitones to the nearest in-scale semitone. Considers both the
// floor and ceil chromatic neighbors so values near boundaries pick the truly-closest
// scale note.
float snapToScale(float target) {
    float chromaLow = floor(target);
    float chromaHigh = chromaLow + 1.0;
    int pcLow = int(mod(chromaLow, 12.0));
    int pcHigh = int(mod(chromaHigh, 12.0));
    float candLow = chromaLow + scaleOffsets[pcLow];
    float candHigh = chromaHigh + scaleOffsets[pcHigh];
    return (abs(candLow - target) <= abs(candHigh - target)) ? candLow : candHigh;
}

// Shift in semitones that moves `base` to the in-scale pitch nearest `base + shift`.
// A non-zero shift that would snap back onto `base` moves one scale note in its
// direction instead, so every non-zero shift moves the pitch.
float snapShiftToScale(float base, float shift) {
    float from = snapToScale(base);
    float landed = snapToScale(base + shift);
    if (shift == 0.0 || abs(landed - from) > 0.5) return landed - base;
    float dir = shift > 0.0 ? 1.0 : -1.0;
    float semi = floor(from + 0.5);
    for (int i = 0; i < 12; i++) {
        semi += dir;
        if (scaleOffsets[int(mod(semi, 12.0))] == 0.0) break;
    }
    return semi - base;
}

#endif
