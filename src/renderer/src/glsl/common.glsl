precision highp float;
precision highp sampler2D;
precision highp int;

in vec2 vUv;

out vec4 outColor;

#define NUM_CONTEXTUAL_MOD_SOURCES 8

struct Parameter {
    float value;
    float minValue;
    float maxValue;
    float modulationAmounts[3];
    float contextualModAmounts[NUM_CONTEXTUAL_MOD_SOURCES];  // iteration, time, pitch, random, step, pressure, tiltX, tiltY
};

// Contextual modulation uniforms - passed per stroke/iteration
uniform float strokeIterationNormalized;  // i / (brushIterations - 1), 0-1
uniform float strokeTimePosition;         // brush center x position, 0-1
uniform float strokePitchPosition;        // brush center y position, 0-1
uniform float strokeRandom;               // random value per stroke, 0-1
uniform float strokeStepNormalized;       // stepIndex / (numSteps - 1), 0-1
uniform float strokePressure;             // pen pressure, 0-1
uniform float strokeTiltX;                // pen tilt X, 0-1 (center=0.5)
uniform float strokeTiltY;                // pen tilt Y, 0-1 (center=0.5)

#define PI 3.141592653589793
#define TWO_PI 6.28318530718

#define EPSILON 1e-6

