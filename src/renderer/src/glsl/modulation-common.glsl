
uniform int modulatorMode;
uniform int modulatorPatternShape;
uniform vec2 modulatorPatternRate;
uniform float modulatorAmplitude;
uniform float modulatorRotation;

float random(vec2 st) {
    return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
}

float getModulation(vec2 uv) {
  float v = 0.0;
  if (modulatorMode == 0) { // LFO
    vec2 rates = vec2(1.0 / modulatorPatternRate.x, 1.0 / modulatorPatternRate.y);

    float rot = modulatorRotation * PI / 180.0;
    float s = sin(rot);
    float c = cos(rot);
    mat2 m = mat2(c, -s, s, c);
    vec2 rotatedUv = m * (uv - 0.5) + 0.5;

    vec2 pos = rotatedUv * rates;

    if (modulatorPatternShape == 0) { // SINE
      v = (sin(pos.x * 2.0 * PI) + sin(pos.y * 2.0 * PI)) / 4.0 + 0.5;
    } else if (modulatorPatternShape == 1) { // TRIANGLE
      vec2 p = fract(pos);
      float tx = 1.0 - abs(p.x * 2.0 - 1.0);
      float ty = 1.0 - abs(p.y * 2.0 - 1.0);
      v = tx * ty;
    } else if (modulatorPatternShape == 2) { // SQUARE
      vec2 p = fract(pos);
      v = pow(step(0.5, p.x) - step(0.5, p.y), 2.0);
    } else if (modulatorPatternShape == 3) { // SAWTOOTH
      vec2 p = fract(pos);
      v = p.x * p.y;
    } else if (modulatorPatternShape == 4) { // PULSE
      vec2 p = fract(pos);
      v = max(1.0 - step(0.2, p.x), 1.0 - step(0.2, p.y));
    } else if (modulatorPatternShape == 5) { // RANDOM
      v = random(floor(pos));
    }
  }
  return mix(0.5 - modulatorAmplitude / 2.0, 0.5 + modulatorAmplitude / 2.0, v);
}

float applyModulation(float value, float minValue, float maxValue, float modulationAmount, vec2 uv) {
  float modulation = getModulation(uv);

  float minV = minValue;
  float maxV = maxValue;

  if (modulationAmount < 0.0) {
    minV = maxValue;
    maxV = minValue;
  }

  float modulatedValue = mix(minV, maxV, modulation);

  return mix(value, modulatedValue, abs(modulationAmount));
}