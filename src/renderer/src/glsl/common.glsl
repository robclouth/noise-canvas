precision highp float;
precision highp sampler2D;
precision highp int;

in vec2 vUv;

layout(location = 0) out vec4 outColor;

// A modulatable parameter. On a log slider the sources sweep `position`, the
// knob position 0–1, and resolveParameter maps the result back to a value; the
// static terms are then in knob position too.
struct Parameter {
    float value;
    float position;
    float minValue;
    float maxValue;
    float modulationAmounts[3];
    // Stroke-context and macro contributions, pre-summed on the CPU: the
    // weighted sum of their swept values and their total weight.
    float staticSum;
    float staticWeight;
    int scaleKind; // 0 linear, 1 log, 2 log-bipolar, 3 log1p
    vec2 logEnds; // log: natural logs of the slider's ends; log-bipolar and log1p: log1p of the largest magnitude
};

// A modulator parameter. Its stroke-context and macro contributions arrive as an
// affine map, applied after one level of pattern nesting.
struct ModulatorParameter {
    float value;
    float minValue;
    float maxValue;
    float modulationAmounts[3];
    float staticScale;
    float staticOffset;
};

#define PI 3.141592653589793
#define TWO_PI 6.28318530718

#define EPSILON 1e-6


// Maps a swept knob position back to the slider's value for a log scale kind.
vec2 fromKnobPosition(vec2 v, int scaleKind, vec2 logEnds) {
    vec2 pos = clamp(v, 0.0, 1.0);
    if (scaleKind == 1) return exp(mix(vec2(logEnds.x), vec2(logEnds.y), pos));
    if (scaleKind == 2) {
        vec2 arc = pos * 2.0 - 1.0;
        return sign(arc) * (exp(abs(arc) * logEnds.x) - 1.0);
    }
    return exp(pos * logEnds.x) - 1.0;
}
