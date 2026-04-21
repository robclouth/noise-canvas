// Shared edge mode logic for effects that sample beyond brush boundaries.
// edgeMode values: 0=Cut, 1=Bleed, 2=Wrap, 3=Clamp, 4=Reflect, 5=Invert

vec2 applyEdgeMode(vec2 sourceUv, int edgeMode, out bool useZero, out bool invertSample) {
    useZero = false;
    invertSample = false;

    vec2 sourceBrushBottomLeft = brushBottomLeftUv + vec2(sourceOffsetX, sourceOffsetY);
    vec2 localUv = sourceUv - sourceBrushBottomLeft;
    vec2 safeSize = max(brushSizeUv, vec2(1e-6));

    bool insideBrush = (brushSizeUv.x == 0.0 || (localUv.x >= 0.0 && localUv.x < brushSizeUv.x)) &&
                       (brushSizeUv.y == 0.0 || (localUv.y >= 0.0 && localUv.y < brushSizeUv.y));

    if (insideBrush) {
        return sourceUv;
    }

    if (edgeMode == 0) {
        // Cut: silence out-of-bounds samples
        useZero = true;
        return sourceUv;
    } else if (edgeMode == 1) {
        // Bleed: sample freely beyond brush bounds, but zero outside file
        if (sourceUv.x < 0.0 || sourceUv.x > 1.0 || sourceUv.y < 0.0 || sourceUv.y > 1.0) {
            useZero = true;
        }
        return sourceUv;
    } else if (edgeMode == 2) {
        // Wrap: tile within brush bounds
        vec2 wrappedLocal = fract(localUv / safeSize) * safeSize;
        return sourceBrushBottomLeft + wrappedLocal;
    } else if (edgeMode == 3) {
        // Clamp: nearest edge (no-flux boundary)
        vec2 clampedLocal = clamp(localUv, vec2(0.0), safeSize - vec2(1e-6));
        return sourceBrushBottomLeft + clampedLocal;
    } else if (edgeMode == 4) {
        // Reflect: single reflection at boundary, then clamp
        vec2 reflected = localUv;
        if (localUv.x < 0.0) reflected.x = -localUv.x;
        else if (localUv.x >= safeSize.x) reflected.x = 2.0 * safeSize.x - localUv.x - 1e-6;
        if (localUv.y < 0.0) reflected.y = -localUv.y;
        else if (localUv.y >= safeSize.y) reflected.y = 2.0 * safeSize.y - localUv.y - 1e-6;
        reflected = clamp(reflected, vec2(0.0), safeSize - vec2(1e-6));
        return sourceBrushBottomLeft + reflected;
    } else if (edgeMode == 5) {
        // Invert: sample beyond bounds but negate (creates interference)
        invertSample = true;
        return sourceUv;
    }

    return sourceUv;
}

vec4 sampleWithEdgeMode(vec2 sourceUv, vec2 destUv, float offsetX, float offsetY, int edgeMode) {
    bool useZero, invertSample;
    vec2 edgeUv = applyEdgeMode(sourceUv, edgeMode, useZero, invertSample);
    if (useZero) {
        return vec4(0.0);
    }
    vec4 result = getTransformedSample(edgeUv, destUv, 1.0, 1.0, offsetX, offsetY);
    if (invertSample) {
        return -result;
    }
    return result;
}
