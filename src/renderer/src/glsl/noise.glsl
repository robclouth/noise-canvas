// Self-contained procedural noise used by the modulator system.
//
// snoise / mod289 / permute: 2D simplex noise.
//   Copyright 2021-2023 Stefan Gustavson and Ian McEwan. MIT license.
//   https://github.com/stegu/webgl-noise
// random: hash-based pseudo-random value in [0, 1].
//   Copyright 2014 David Hoskins. MIT license.
// Extended noise fields (Quilt..Flow below):
//   Copyright (c) 2026 @lumiey. MIT license.

#ifndef FNC_MOD289
#define FNC_MOD289
vec2 mod289(const in vec2 x) { return x - floor(x * (1. / 289.)) * 289.; }
vec3 mod289(const in vec3 x) { return x - floor(x * (1. / 289.)) * 289.; }
#endif

#ifndef FNC_PERMUTE
#define FNC_PERMUTE
vec3 permute(const in vec3 v) { return mod289(((v * 34.0) + 1.0) * v); }
#endif

#ifndef FNC_SNOISE
#define FNC_SNOISE
float snoise(in vec2 v) {
    const vec4 C = vec4(0.211324865405187,  // (3.0-sqrt(3.0))/6.0
                        0.366025403784439,  // 0.5*(sqrt(3.0)-1.0)
                        -0.577350269189626, // -1.0 + 2.0 * C.x
                        0.024390243902439); // 1.0 / 41.0
    // First corner
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);

    // Other corners
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;

    // Permutations
    i = mod289(i); // Avoid truncation effects in permutation
    vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0))
                              + i.x + vec3(0.0, i1.x, 1.0));

    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m;
    m = m * m;

    // Gradients: 41 points uniformly over a line, mapped onto a diamond.
    // The ring size 17*17 = 289 is close to a multiple of 41 (41*7 = 287)
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;

    // Normalise gradients implicitly by scaling m
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);

    // Compute final noise value at P
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
}
#endif

#ifndef FNC_RANDOM
#define FNC_RANDOM
float random(in vec2 st) {
    return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453);
}
#endif

// ---- Extended noise fields (@lumiey, MIT) ----
#ifndef FNC_NOISE_EXTENDED
#define FNC_NOISE_EXTENDED

float hash12(vec2 p) {
    uvec2 u = floatBitsToUint(p * vec2(141421356, 2718281828));
    return float((u.x ^ u.y) * 3141592653u) / float(~0u);
}

vec2 hash22(vec2 p) {
    uvec2 u = floatBitsToUint(p * vec2(141421356, 2718281828));
    return vec2((u.x ^ u.y) * uvec2(3141592653, 1618033988)) / float(~0u);
}

vec3 hash32(vec2 p) {
    uvec2 u = floatBitsToUint(p * vec2(141421356, 2718281828));
    return vec3((u.x ^ u.y) * uvec3(1732050807, 2645751311, 3316624790)) / float(~0u);
}

// Quilt: smooth value noise on a grid.
float value12(vec2 p) {
    vec2 i = floor(p);
    vec2 f = p - i;
    f *= f * (3.0 - 2.0 * f);
    return mix(
        mix(hash12(i), hash12(i + vec2(1, 0)), f.x),
        mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1)), f.x), f.y);
}

// Clouds: classic Perlin gradient noise.
float perlin12(vec2 p) {
    vec2 i = floor(p);
    vec2 f = p - i;
    vec2 u = f * f * f * (10.0 + f * (6.0 * f - 15.0));
    float a = dot(normalize(hash22(i + vec2(0, 0)) - 0.5), f - vec2(0, 0));
    float b = dot(normalize(hash22(i + vec2(1, 0)) - 0.5), f - vec2(1, 0));
    float c = dot(normalize(hash22(i + vec2(0, 1)) - 0.5), f - vec2(0, 1));
    float d = dot(normalize(hash22(i + vec2(1, 1)) - 0.5), f - vec2(1, 1));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 0.7 + 0.5;
}

// Perlin noise with analytic derivative (value in .x, gradient in .yz).
vec3 perlin12d(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    vec2 ga = hash22(i + vec2(0, 0)) * 2.0 - 1.0;
    vec2 gb = hash22(i + vec2(1, 0)) * 2.0 - 1.0;
    vec2 gc = hash22(i + vec2(0, 1)) * 2.0 - 1.0;
    vec2 gd = hash22(i + vec2(1, 1)) * 2.0 - 1.0;
    float va = dot(ga, f - vec2(0, 0));
    float vb = dot(gb, f - vec2(1, 0));
    float vc = dot(gc, f - vec2(0, 1));
    float vd = dot(gd, f - vec2(1, 1));
    return vec3(va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd), ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) + du * (u.yx * (va - vb - vc + vd) + vec2(vb, vc) - va));
}

// Cells: Worley (cellular) noise, F1 distance.
float worley12(vec2 p) {
    vec2 i = floor(p);
    p -= i;
    float w = 1e9;
    for (float x = -1.0; x <= 1.0; ++x)
    for (float y = -1.0; y <= 1.0; ++y) {
        vec2 c = p - vec2(x, y) - hash12(i + vec2(x, y));
        w = min(w, dot(c, c));
    }
    return 1.0 - sqrt(w);
}

// Bubbles: smooth Voronoi. s controls edge smoothness.
float voronoi12(vec2 x, float s) {
    s = 1.0 / s;
    vec2 p = floor(x);
    vec2 f = x - p;
    float va = 0.0;
    float wt = 0.0;
    for (float x = -1.0; x <= 1.0; x++)
    for (float y = -1.0; y <= 1.0; y++) {
        vec3 o = hash32(p + vec2(x, y));
        float d = length(vec2(x, y) - f + o.xy);
        // Ascending edges: smoothstep with edge0 > edge1 is undefined in GLSL ES.
        float ww = pow(1.0 - smoothstep(0.0, 1.414, d), s);
        va += o.z * ww;
        wt += ww;
    }
    // Every tap can sit at or past the falloff radius near a lattice corner,
    // which would make this 0/0.
    return wt > 0.0 ? va / wt : 0.0;
}

// Craters: ring-shaped impacts.
float crater12(vec2 p) {
    vec2 f = fract(p);
    p = floor(p);
    float va = 0.;
    float wt = 0.;
    for (int i = -2; i <= 2; i++)
        for (int j = -2; j <= 2; j++) {
            vec2 g = vec2(i, j);
            vec2 o = hash22(p + g);
            float d = distance(f - g, o);
            float w = exp(-4. * d);
            va += w * sin(6.28 * sqrt(max(d, 0.06)));
            wt += w;
        }
    return abs(va / wt);
}

// Ripples: oriented sinusoidal (Gabor) noise.
float gabor12(vec2 p) {
    const float kF = 8.0;
    vec2 i = floor(p);
    vec2 f = p - i;
    f *= f * (3.0 - 2.0 * f);
    return mix(mix(sin(kF * dot(p, hash22(i + vec2(0, 0)))),
                   sin(kF * dot(p, hash22(i + vec2(1, 0)))), f.x),
               mix(sin(kF * dot(p, hash22(i + vec2(0, 1)))),
                   sin(kF * dot(p, hash22(i + vec2(1, 1)))), f.x), f.y);
}

// Flow: curl of Perlin noise (returns a 2D flow vector).
vec2 curl22(vec2 p) {
    vec2 e = vec2(0.1, 0);
    vec2 a = vec2(perlin12(p + e.xy), perlin12(p + e.yx));
    vec2 b = vec2(perlin12(p - e.xy), perlin12(p - e.yx));
    return (a - b) / e.x * 0.5;
}

// Scratches: thin streaks.
float scratch(vec2 uv, float f) {
    vec2 seed = floor(uv);
    uv -= seed;
    seed.x = floor(sin(seed.x * 51024.0) * 3104.0);
    seed.y = floor(sin(seed.y * 1324.0) * 554.0);

    uv = uv * 2.0 - 1.0;
    uv = uv * cos(seed.x + seed.y) + vec2(-uv.y, uv.x) * sin(seed.x + seed.y);
    uv += sin(seed.x - seed.y);
    uv = uv * 0.5 + 0.5;

    const float WAVYNESS = 0.2;
    float s = (sin(seed.x + uv.y * 3.1415) + sin(seed.y + uv.y * 3.1415)) * WAVYNESS;

    float x = abs(uv.x - 0.5 + s);
    x = 0.5 - x * f;
    x = smoothstep(-2.0, fwidth(x) * 1.5 + 16.0, x) * 12.0;
    x *= uv.y;

    return x;
}

float scratches12(vec2 uv) {
    float scratches = 0.0;
    float f = 1.0 / length(fwidth(uv));
    for (int i = 0; i < 8; ++i) {
        float x = scratch(uv, f);
        scratches = max(scratches, x);
        uv = uv * mat2(1.0, 0.7, -0.7, 1.0) - 12.31;
    }
    return scratches;
}

// Swirls: rotating wavelet noise. phase animates, scale sets lacunarity.
float wavelet12(vec2 p, float phase, float scale) {
    float d = 0.0, s = 1.0, m = 0.0, a;
    for (float i = 0.0; i < 4.0; ++i) {
        vec2 q = p * s, g = fract(floor(q) * vec2(123.34, 233.53));
        g += dot(g, g + 23.234);
        a = fract(g.x * g.y) * 1e3;
        q = (fract(q) - 0.5) * mat2(cos(a), -sin(a), sin(a), cos(a));
        // Ascending edges: smoothstep with edge0 > edge1 is undefined in GLSL ES.
        d += sin(q.x * 10.0 + phase) * (1.0 - smoothstep(0.0, 0.25, dot(q, q))) / s;
        p = p * mat2(0.54, -0.84, 0.84, 0.54) + i;
        m += 1.0 / s;
        s *= scale;
    }
    return d / m;
}

float fbm12(vec2 p, int octaves) {
    float s = 0.0, m = 0.0, a = 1.0;
    for (int i = 0; i < octaves; i++) {
        float n = perlin12(p);
        s += a * n;
        m += a;
        a *= 0.5;
        p *= 2.0;
    }
    return s / m;
}

vec3 fbm_stone(vec2 p, int octaves) {
    vec3 s = vec3(0);
    float a = 1.0;
    for (int i = 0; i < 6; ++i) {
        s += a * perlin12d(p);
        a *= 0.5;
        p *= 2.0;
    }
    return s;
}

// Marble: domain-warped fbm.
float stone12(vec2 p) {
    return fbm12(p + fbm_stone(p, 6).yz * 0.4, 6);
}

vec2 fbm_paper(vec2 p, int octaves) {
    vec2 s = vec2(0);
    float m = 0.0, a = 1.0;
    for (int i = 0; i < octaves; i++) {
        s += a * clamp(perlin12d(p).yz * 0.5 + 0.5, vec2(0), vec2(1));
        m += a;
        a *= 0.8;
        p *= 2.0;
    }
    return s / m;
}

// Paper: fibrous accumulated gradient noise.
float paper12(vec2 p) {
    return length(fbm_paper(p, 10)) / 1.414 * 0.6 + 0.4;
}

vec2 fbm_wool(vec2 p, int octaves) {
    vec2 s = vec2(0.0);
    float m = 0.0, a = 1.0;
    for (int i = 0; i < octaves; i++) {
        vec2 n = perlin12d(p).yz;
        s += a * n;
        m += a;
        a *= 0.5;
        p *= 2.0;
    }
    return s / m;
}

// Weave: woven thread texture.
float wool12(vec2 p) {
    vec2 n = fbm_wool(p, 6);
    return max(abs(n.x), abs(n.y));
}

vec3 gullies(vec2 p, vec2 slope) {
    vec2 side_dir = vec2(-slope.y, slope.x) * 3.14159265;
    vec2 id = floor(p);
    p -= id;
    vec2 height_slope = vec2(0);
    float w_sum = 0.0;
    for (int x = -1; x <= 2; x++) {
        for (int y = -1; y <= 2; y++) {
            vec2 off = vec2(x, y);
            vec2 c = p - off - hash22(id + off) + 0.5;
            float dist2 = dot(c, c);
            float w = max(0.0, exp(-dist2 * 2.0) - 0.01111);
            w_sum += w;
            float t = dot(c, side_dir);
            height_slope += vec2(cos(t), -sin(t)) * w;
        }
    }
    return vec3(height_slope.x, height_slope.y * side_dir) / w_sum;
}

// Terrain: eroded heightfield (height in .x).
vec3 erosion12(vec2 p) {
    vec3 nd = perlin12d(p);
    float strength = 0.25, freq = 8.0, total = 1.0;
    for (int i = 0; i < 4; i++) {
        float len2 = dot(nd.yz, nd.yz);
        nd += gullies(p * freq, nd.yz * pow(len2, 0.5 * (0.5 - 1.0))) * strength * vec3(1, freq, freq);
        total += strength;
        strength *= 0.5;
        freq *= 2.0;
    }
    return nd / total;
}

#endif
