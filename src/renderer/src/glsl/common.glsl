precision highp float;
precision highp sampler2D;
precision highp int;

in vec2 vUv;

out vec4 outColor;

struct Parameter {
    float value;
    float minValue;
    float maxValue;
    float modulationAmounts[3];
};

#define PI 3.141592653589793
#define TWO_PI 6.28318530718

#define EPSILON 1e-6

