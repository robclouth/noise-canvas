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

#endif
