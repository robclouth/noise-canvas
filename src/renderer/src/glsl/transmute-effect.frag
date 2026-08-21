#include "effect-common.glsl";
#include "effect-wrapper.glsl"

uniform int transmuteFrom;
uniform int transmuteTo;
uniform Parameter transmuteAmount;
uniform Parameter transmuteCurve;
uniform float transmuteBeatsToUv;

// Sources and targets, in the order the pickers list them.
const int PART_MAG   = 0;
const int PART_PHASE = 1;
const int PART_TIME  = 2;
const int PART_PITCH = 3;
const int PART_PAN   = 4;

// The span the level reads across as a drive, and is written back over.
const float TRANSMUTE_SPAN_DB = 80.0;

float levelToUnit(float mag) {
  float db = 20.0 * log(max(mag, 1e-9)) / log(10.0);
  return clamp((db + TRANSMUTE_SPAN_DB) / TRANSMUTE_SPAN_DB, 0.0, 1.0);
}

float unitToLevel(float unit) {
  return pow(10.0, (clamp(unit, 0.0, 1.0) * TRANSMUTE_SPAN_DB - TRANSMUTE_SPAN_DB) / 20.0);
}

float phaseToUnit(float phase) {
  return (unwrapPhase(phase) + PI) / TWO_PI;
}

float unitToPhase(float unit) {
  return clamp(unit, 0.0, 1.0) * TWO_PI - PI;
}

// Where the band sits between the speakers, 0 at the left and 1 at the right.
float panToUnit(float magL, float magR) {
  return magR / max(magL + magR, 1e-9);
}

// The drive, shaped by curve. A negative curve reads it upside down.
float shapeDrive(float unit, float curve) {
  float shaped = pow(clamp(unit, 0.0, 1.0), max(abs(curve), 0.001));
  return curve < 0.0 ? 1.0 - shaped : shaped;
}

float semisToUv(float semis) {
  return semis * (destBandsPerOctave / 12.0) / max(destBandCount, 1.0);
}

// What one channel of the band reads as a 0..1 drive.
float readSource(vec2 magPhase, float magOther, vec2 brushUnit, bool right) {
  if (transmuteFrom == PART_MAG)   return levelToUnit(magPhase.x);
  if (transmuteFrom == PART_PHASE) return phaseToUnit(magPhase.y);
  if (transmuteFrom == PART_TIME)  return brushUnit.x;
  if (transmuteFrom == PART_PITCH) return brushUnit.y;
  return right ? panToUnit(magOther, magPhase.x) : panToUnit(magPhase.x, magOther);
}

vec4 applyEffectStroke(vec4 src, ProcessingUvs coords, float audioLevelDb) {
  vec2 mods[NUM_MODULATORS];
  sampleModulators(mods);
  vec2 amount = resolveParameter(transmuteAmount, mods);
  vec2 curve = resolveParameter(transmuteCurve, mods);

  vec2 inL = src.rg;
  vec2 inR = src.ba;

  // Position inside the brush footprint, 0..1 on each axis.
  vec2 brushUnit = clamp(getEffectiveBrushOffset(coords.dest) / max(brushSizeUv, vec2(EPSILON)), 0.0, 1.0);

  float driveL = shapeDrive(readSource(inL, inR.x, brushUnit, false), curve.x);
  float driveR = shapeDrive(readSource(inR, inL.x, brushUnit, true), curve.y);

  vec2 outL = inL;
  vec2 outR = inR;

  if (transmuteTo == PART_MAG) {
    // The drive becomes the level. Phase -> Mag draws the phase where the
    // level effects reach it and leaves the phase itself alone, so the passes
    // in between still read a real one; a later Mag -> Phase reads it back.
    outL.x = unitToLevel(driveL) * max(abs(amount.x), 1e-6);
    outR.x = unitToLevel(driveR) * max(abs(amount.y), 1e-6);

  } else if (transmuteTo == PART_PHASE) {
    // The drive becomes the phase, written around the whole turns the pixel
    // already holds. Closing a Phase -> Mag, the turns and the level both come
    // off the stroke-start snapshot, since the level slot holds a picture by
    // then — which is what keeps content a pass in between dragged in from
    // outside the pair, still carrying a full unwrapped phase, from returning
    // at full level.
    vec4 strokeStart = texture(blendOriginalTex, vUv);
    vec2 baseL = inSwappedDomain ? strokeStart.rg : inL;
    vec2 baseR = inSwappedDomain ? strokeStart.ba : inR;
    outL = vec2(baseL.x, round(baseL.y / TWO_PI) * TWO_PI + unitToPhase(driveL) * amount.x);
    outR = vec2(baseR.x, round(baseR.y / TWO_PI) * TWO_PI + unitToPhase(driveR) * amount.y);

  } else if (transmuteTo == PART_TIME || transmuteTo == PART_PITCH) {
    // The drive moves the band: each bin reads from somewhere else, as far as
    // the drive says. The drive is centred, so it pushes both ways. amount is
    // beats for time, semitones for pitch, and as in Transform a positive move
    // carries the sound later and higher, so the read goes the other way.
    float reachL = -(driveL - 0.5) * 2.0 * amount.x;
    float reachR = -(driveR - 0.5) * 2.0 * amount.y;
    bool toPitch = transmuteTo == PART_PITCH;
    vec2 stepL = toPitch ? vec2(0.0, semisToUv(reachL)) : vec2(reachL * transmuteBeatsToUv, 0.0);
    vec2 stepR = toPitch ? vec2(0.0, semisToUv(reachR)) : vec2(reachR * transmuteBeatsToUv, 0.0);
    vec4 readL = getTransformedSample(coords.sourceL + stepL, coords.dest, 1.0, 1.0,
                                      sourceOffsetX + stepL.x, sourceOffsetY + stepL.y);
    vec4 readR = getTransformedSample(coords.sourceR + stepR, coords.dest, 1.0, 1.0,
                                      sourceOffsetX + stepR.x, sourceOffsetY + stepR.y);
    outL = readL.rg;
    outR = readR.ba;

  } else {
    // The drive places the band between the speakers. The band's energy is
    // kept and split, so Pan -> Pan at 1 leaves it where it was, 0 folds it to
    // the centre and past 1 pushes it out to the sides.
    float total = inL.x + inR.x;
    float placeL = clamp(0.5 + (driveL - 0.5) * amount.x, 0.0, 1.0);
    float placeR = clamp(0.5 + (driveR - 0.5) * amount.y, 0.0, 1.0);
    outL.x = total * (1.0 - placeL);
    outR.x = total * placeR;
  }

  return vec4(outL, outR);
}
