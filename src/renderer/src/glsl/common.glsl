precision highp float;
precision highp sampler2D;
precision highp int;

in vec2 vUv;

out vec4 outColor;

#define NUM_CONTEXTUAL_MOD_SOURCES 5

struct Parameter {
    float value;
    float minValue;
    float maxValue;
    float modulationAmounts[3];
    float contextualModAmounts[NUM_CONTEXTUAL_MOD_SOURCES];  // iteration, time, pitch, random, step
};

// Contextual modulation uniforms - passed per stroke/iteration
uniform float strokeIterationNormalized;  // i / (brushIterations - 1), 0-1
uniform float strokeTimePosition;         // brush center x position, 0-1
uniform float strokePitchPosition;        // brush center y position, 0-1
uniform float strokeRandom;               // random value per stroke, 0-1
uniform float strokeStepNormalized;       // stepIndex / (numSteps - 1), 0-1

#define PI 3.141592653589793
#define TWO_PI 6.28318530718

#define EPSILON 1e-6

