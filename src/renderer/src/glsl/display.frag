precision highp float;
varying vec2 vUv;

#include "effect-common.glsl";

// Uniforms specific to this display material
uniform float minDb;
uniform float maxDb;
uniform float bpm;
uniform float gridSize;

uniform bool isSourceFile;
uniform bool isTargetFile;


float magnitudeToDb(float mag) {
    float logMag = 20.0 * log(mag + 1.0e-7) / log(10.0);
    float db = (logMag - minDb) / (maxDb - minDb);
    return clamp(db, 0.0, 1.0);
}

void main() {
    vec4 packedValue = getSourceSample(vUv);

    vec2 leftComplex = packedValue.rg;
    float leftMag = length(leftComplex);
    float leftDb = magnitudeToDb(leftMag);
    
    vec3 color;
    if (sourceChannelCount == 1) {
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
    float totalDuration = sourceFrameCount / sourceSampleRate;
    float gridWidthUv = gridIntervalSeconds / totalDuration;
    
    float line = mod(vUv.x, gridWidthUv);

    float lineThicknessUv = fwidth(vUv.x);

    if (line < lineThicknessUv) {
        color = mix(color, vec3(1.0), 0.2);
    }

    // --- Brush Area Visualization ---
    if (brushCenterUv.x >= 0.0) {
        // Common calculations for both rectangles
        vec2 rectCenter = brushCenterUv;
        
        vec2 correctedRectCenter = rectCenter;
        vec2 correctedBrushSize = brushSizeUv;
       
        vec2 halfSize = correctedBrushSize / 2.0;
        float strokeWidthUv = fwidth(vUv.x) * 1.5;

        // Draw Brush Area Rectangle (only if this is the active file)
        if (isTargetFile) {
            vec2 d = abs(vUv - correctedRectCenter) - halfSize;
            float outsideDist = length(max(d, 0.0));
            float insideDist = min(max(d.x, d.y), 0.0);
            float distToBorder = outsideDist + insideDist;

            float rectAlpha = 1.0 - smoothstep(0.0, strokeWidthUv, abs(distToBorder));
            if (rectAlpha > 0.0) {
                color = mix(color, vec3(1.0), rectAlpha);
            }
        }

        if (isSourceFile) {
          // Draw source rectangle (faint)
          vec2 effectiveOffset = vec2(sourceOffsetX.value, sourceOffsetY.value);

          vec2 sourceCenter = correctedRectCenter + effectiveOffset;
          vec2 sourceCenterScreen = sourceCenter;

          if (sourceCenterScreen.x >= 0.0 && sourceCenterScreen.x <= 1.0 &&
              sourceCenterScreen.y >= 0.0 && sourceCenterScreen.y <= 1.0) {
              
              vec2 dSource = abs(vUv - sourceCenter) - halfSize; // reuse halfSize from brush rect
              float outsideDistSource = length(max(dSource, 0.0));
              float insideDistSource = min(max(dSource.x, dSource.y), 0.0);
              float distToBorderSource = outsideDistSource + insideDistSource;

              float sourceRectAlpha = 1.0 - smoothstep(0.0, strokeWidthUv, abs(distToBorderSource));
              if (sourceRectAlpha > 0.0) {
                  color = mix(color, vec3(1.0), sourceRectAlpha * 0.3); // Fainter
              }
          }
        }
    }

    gl_FragColor = vec4(color, 1.0);
}