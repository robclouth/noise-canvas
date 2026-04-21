// Shared edge mode logic for effects that sample beyond brush boundaries.
// edgeMode values: 0=Cut, 1=Bleed, 2=Wrap, 3=Clamp, 4=Reflect, 5=Invert
//
// Two entry points:
//   applyEdgeModeAxis   — single-axis primitive working in brush-local space;
//                         sampling-model-agnostic (works for continuous UVs or
//                         integer band-local indices).
//   applyEdgeMode       — 2D UV wrapper that maps source UV ↔ dest UV and calls
//                         the axis primitive for each axis. Kept so existing
//                         callers (blur / clone / evolve via sampleWithEdgeMode)
//                         are unaffected.

// Applies edge-mode logic on a single axis. `localPos` is position relative to
// the brush start (0..brushSize is "inside"). Returns the (possibly remapped)
// local position; sets `useZero` for Cut and `invertSample` for Invert.
// Bleed is a no-op here — callers that need the file-bounds zero-pad apply it
// themselves based on their sampling model.
float applyEdgeModeAxis(float localPos, float brushSize, int edgeMode,
                        out bool useZero, out bool invertSample) {
    useZero = false;
    invertSample = false;

    if (brushSize <= 0.0) return localPos;
    if (localPos >= 0.0 && localPos < brushSize) return localPos;

    if (edgeMode == 0) {                                   // Cut
        useZero = true;
        return localPos;
    } else if (edgeMode == 1) {                            // Bleed
        return localPos;
    } else if (edgeMode == 2) {                            // Wrap
        float w = mod(localPos, brushSize);
        if (w < 0.0) w += brushSize;
        return w;
    } else if (edgeMode == 3) {                            // Clamp
        return clamp(localPos, 0.0, brushSize - 1e-6);
    } else if (edgeMode == 4) {                            // Reflect
        float r = localPos;
        if (r < 0.0) r = -r;
        else if (r >= brushSize) r = 2.0 * brushSize - r - 1e-6;
        return clamp(r, 0.0, brushSize - 1e-6);
    } else if (edgeMode == 5) {                            // Invert
        invertSample = true;
        return localPos;
    }
    return localPos;
}

vec2 applyEdgeMode(vec2 sourceUv, int edgeMode, out bool useZero, out bool invertSample) {
    useZero = false;
    invertSample = false;

    // Brush containment is defined in DEST UV space. Invert the source→dest
    // freq-preserving map (nonlinear when analyses differ), do the brush math
    // there, then forward-map back for wrap / clamp / reflect.
    vec2 destUv = sourceUvToDestUv(sourceUv);
    vec2 localUv = destUv - brushBottomLeftUv;

    bool zeroX = false, zeroY = false;
    bool invertX = false, invertY = false;
    float newLocalX = applyEdgeModeAxis(localUv.x, brushSizeUv.x, edgeMode, zeroX, invertX);
    float newLocalY = applyEdgeModeAxis(localUv.y, brushSizeUv.y, edgeMode, zeroY, invertY);

    useZero = zeroX || zeroY;
    invertSample = invertX || invertY;

    // Cut / Invert don't move the sample position; short-circuit the UV roundtrip.
    if (edgeMode == 0 || edgeMode == 5) return sourceUv;

    // Bleed: preserve the file-bounds zero so callers don't sample outside [0,1].
    if (edgeMode == 1) {
        if (sourceUv.x < 0.0 || sourceUv.x > 1.0 || sourceUv.y < 0.0 || sourceUv.y > 1.0) {
            useZero = true;
        }
        return sourceUv;
    }

    // Wrap / Clamp / Reflect: rebuild dest UV from the remapped locals, map back.
    vec2 newDestUv = brushBottomLeftUv + vec2(newLocalX, newLocalY);
    return destUvToSourceUv(newDestUv);
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
