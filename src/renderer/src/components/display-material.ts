import { shaderMaterial } from "@react-three/drei";
import { code, uniforms } from "./brushes/common";

export const DisplayMaterial = shaderMaterial(
  {
    ...uniforms,
    minDb: -70.0,
    maxDb: 0.0,
    bpm: 120.0,
    gridSize: 0.25,
  },
  /*glsl*/ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`,
  /*glsl*/ `
precision highp float;

// The refactored common code with new function names
${code}

// Uniforms specific to this display material
uniform float minDb;
uniform float maxDb;
uniform float bpm;
uniform float gridSize;

varying vec2 vUv;

float magnitudeToDb(float mag) {
    float logMag = 20.0 * log(mag + 1.0e-7) / log(10.0);
    float db = (logMag - minDb) / (maxDb - minDb);
    return clamp(db, 0.0, 1.0);
}

void main() {
    vec4 packedValue = samplePointFromScreen(vUv);

    vec2 leftComplex = packedValue.rg;
    float leftMag = length(leftComplex);
    float leftDb = magnitudeToDb(leftMag);
    
    vec3 color;
    if (numChannels == 1) {
        color = vec3(leftDb);
    } else {
        vec2 rightComplex = packedValue.ba;
        float rightMag = length(rightComplex);
        float rightDb = magnitudeToDb(rightMag);
        
        vec3 leftColor = vec3(leftDb, leftDb * 0.5, 0.0);
        vec3 rightColor = vec3(0.0, rightDb * 0.5, rightDb);
        color = leftColor + rightColor;
    }

    // Grid lines
    float gridIntervalSeconds = (60.0 / bpm) * gridSize;
    float totalDuration = numFrames / sampleRate;
    float gridWidthUv = gridIntervalSeconds / totalDuration;
    
    vec2 zoomedUv = screenToZoomed(vUv);
    float line = mod(zoomedUv.x, gridWidthUv);

    float lineThicknessUv = fwidth(zoomedUv.x);

    if (line < lineThicknessUv) {
        color = mix(color, vec3(1.0), 0.2);
    }

    // --- Brush Visualization ---
    if (brushCenterUv.x >= 0.0) {
        // Draw Brush Rectangle
        vec2 rectCenter = brushCenterUv;
        
        // Handle full width/height for rectangle
        vec2 correctedRectCenter = rectCenter;
        vec2 correctedBrushSize = brushSizeUv;
        if (brushSizeUv.x == 0.0) {
            correctedRectCenter.x = 0.5;
            correctedBrushSize.x = 1.0;
        }
        if (brushSizeUv.y == 0.0) {
            correctedRectCenter.y = 0.5;
            correctedBrushSize.y = 1.0;
        }

        vec2 halfSize = correctedBrushSize / 2.0;
        vec2 d = abs(zoomedUv - correctedRectCenter) - halfSize;
        float outside_dist = length(max(d, 0.0));
        float inside_dist = min(max(d.x, d.y), 0.0);
        float dist_to_border = outside_dist + inside_dist;

        float strokeWidthUv = fwidth(zoomedUv.x) * 1.5;

        float rect_alpha = 1.0 - smoothstep(0.0, strokeWidthUv, abs(dist_to_border));
        if (rect_alpha > 0.0) {
            color = mix(color, vec3(1.0), rect_alpha);
        }

        // Draw source rectangle (faint)
        vec2 effectiveOffset = offsetUv;
        if (brushSizeUv.x == 0.0) {
            effectiveOffset.x = 0.0;
        }
        if (brushSizeUv.y == 0.0) {
            effectiveOffset.y = 0.0;
        }
        vec2 sourceCenter = correctedRectCenter + effectiveOffset;
        vec2 sourceCenterScreen = zoomedToScreen(sourceCenter);

        if (sourceCenterScreen.x >= 0.0 && sourceCenterScreen.x <= 1.0 &&
            sourceCenterScreen.y >= 0.0 && sourceCenterScreen.y <= 1.0) {
            
            vec2 d_source = abs(zoomedUv - sourceCenter) - halfSize; // reuse halfSize from brush rect
            float outside_dist_source = length(max(d_source, 0.0));
            float inside_dist_source = min(max(d_source.x, d_source.y), 0.0);
            float dist_to_border_source = outside_dist_source + inside_dist_source;

            float source_rect_alpha = 1.0 - smoothstep(0.0, strokeWidthUv, abs(dist_to_border_source));
            if (source_rect_alpha > 0.0) {
                color = mix(color, vec3(1.0), source_rect_alpha * 0.3); // Fainter
            }
        }
    }

    gl_FragColor = vec4(color, 1.0);
}
`,
);
