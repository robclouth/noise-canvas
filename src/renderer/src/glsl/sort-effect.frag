#include "effect-common.glsl"

uniform int sortDirection;
uniform int sortOrder;
uniform int sortBy;
uniform int sortStereoMode;
uniform int sortAxis;        // 0=horizontal, 1=vertical (independent of passIndexOffset)
uniform int passIndexOffset; // 0=even pairs, 1=odd pairs

// metric == 0: magnitude (linear)
// metric == 1: phase
// metric == 2: dB (log magnitude, 20/ln(10) ≈ 8.68589)
// metric == 3: instantaneous frequency deviation (pre-computed, passed as extraMetric)
// metric == 4: pan (normalized L-R magnitude, computed from full stereo texel)
float getMetric(vec2 texelPolar, int metric, float extraMetric) {
  if (metric == 0) return getMag(texelPolar);
  if (metric == 1) return getPhase(texelPolar);
  if (metric == 2) return log(getMag(texelPolar) + 1e-9) * 8.68589;
  return extraMetric;
}

// Pan requires both channels; returns a value in [-1, +1].
float getPanMetric(vec4 fullTexel) {
    float L = getMag(fullTexel.rg);
    float R = getMag(fullTexel.ba);
    return (L - R) / (L + R + 1e-9);
}

// Linked-mode metric: averages L and R, or returns pan for metric 4.
float getLinkedMetric(vec4 fullTexel, int metric, float extraMetric) {
    if (metric == 4) return getPanMetric(fullTexel);
    return (getMetric(fullTexel.rg, metric, extraMetric) + getMetric(fullTexel.ba, metric, extraMetric)) / 2.0;
}

bool shouldSwap(float metricA, float metricB, int order) {
  return (order == 0) ? metricA > metricB : metricA < metricB;
}

vec2 sortChannel(vec2 myTexel, vec2 neighborTexel, int passPhase, int myPhaseIndex, float myExtra, float neighborExtra) {
    int myParity = myPhaseIndex % 2;
    bool isLeft = (myParity == passPhase);

    float myMetric    = getMetric(myTexel, sortBy, myExtra);
    float theirMetric = getMetric(neighborTexel, sortBy, neighborExtra);

    if (isLeft) {
        return shouldSwap(myMetric, theirMetric, sortOrder) ? neighborTexel : myTexel;
    } else {
        return shouldSwap(theirMetric, myMetric, sortOrder) ? neighborTexel : myTexel;
    }
}

// Computes the instantaneous frequency deviation (in radians) for a bin.
// Returns the average absolute deviation across L and R channels.
float computeInstFreqDev(vec4 texel, int linearIdx, int bandIdx, float bandHz, float timeStepFrames, int timeIdx, ivec2 texSize) {
    if (timeIdx <= 0) return 0.0;

    int prevLinear = linearIdx - 1;
    ivec2 prevPixel = clamp(ivec2(prevLinear % texSize.x, prevLinear / texSize.x), ivec2(0), texSize - ivec2(1));

    int prevBand = int(round(texelFetch(destInverseMapTex, prevPixel, 0).g));
    if (prevBand != bandIdx) return 0.0;

    vec4 prevTex = texelFetch(destSpectrogramTex, prevPixel, 0);

    // Reduce nominal advance to [-π, π] so it's comparable to the stored phase difference.
    // Without mod(), nominalAdvance can be many multiples of 2π and the comparison breaks.
    float nominalModular = mod(TWO_PI * bandHz * timeStepFrames / destSampleRate, TWO_PI);
    if (nominalModular > PI) nominalModular -= TWO_PI; // map to [-π, π]

    float devL = abs(unwrapPhase((texel.g - prevTex.g) - nominalModular));
    float devR = abs(unwrapPhase((texel.a - prevTex.a) - nominalModular));

    return (devL + devR) * 0.5;
}

void main() {
    ivec2 texSize = textureSize(destSpectrogramTex, 0);
    ivec2 myPixel = clamp(ivec2(floor(vUv * vec2(texSize))), ivec2(0), texSize - ivec2(1));
    vec4 currentTexel = texelFetch(destSpectrogramTex, myPixel, 0);

    ProcessingUvs coords = getProcessingUvs(vUv);
    float weight = getBrushWeight(coords.dest);
    if (weight <= 0.0) {
        outColor = currentTexel;
        return;
    }

    // In single-direction mode, passes whose axis doesn't match are no-ops.
    if (sortDirection != 2 && sortAxis != sortDirection) {
        outColor = currentTexel;
        return;
    }

    // Read inverse map: .r = frameIndex (i * timeStep), .g = bandIndex
    vec2 invData = texelFetch(destInverseMapTex, myPixel, 0).rg;
    int bandIndex = int(round(invData.g));
    bandIndex = clamp(bandIndex, 0, int(destBandCount) - 1);

    vec4 meta = fetchBandMetadata(destMetadataTex, float(bandIndex));
    int bandLength = int(round(meta.g));
    float timeStep = exp2(meta.b);
    float bandHz   = meta.a;

    int timeIdx = int(round(invData.r / timeStep));

    if (timeIdx < 0 || timeIdx >= bandLength) {
        outColor = applyBrush(currentTexel, currentTexel, weight, coords.dest, vUv);
        return;
    }

    int linearIdx = myPixel.y * texSize.x + myPixel.x;

    // Pre-compute instFreqDev for current pixel (only when needed)
    float myInstFreqDev = (sortBy == 3)
        ? computeInstFreqDev(currentTexel, linearIdx, bandIndex, bandHz, timeStep, timeIdx, texSize)
        : 0.0;

    vec4 sortedTexel = currentTexel;

    if (sortAxis == 0) {
        // Horizontal: sort adjacent time samples within the same band.
        int myParity = timeIdx % 2;
        bool isLeft = (myParity == passIndexOffset);
        int neighborTimeIdx = isLeft ? timeIdx + 1 : timeIdx - 1;

        if (neighborTimeIdx >= 0 && neighborTimeIdx < bandLength) {
            int neighborLinear = linearIdx + (isLeft ? 1 : -1);
            ivec2 neighborPixel = clamp(
                ivec2(neighborLinear % texSize.x, neighborLinear / texSize.x),
                ivec2(0), texSize - ivec2(1)
            );

            vec2 neighborInvRG = texelFetch(destInverseMapTex, neighborPixel, 0).rg;
            int neighborBand = int(round(neighborInvRG.g));
            if (neighborBand != bandIndex) {
                outColor = applyBrush(currentTexel, currentTexel, weight, coords.dest, vUv);
                return;
            }

            // Only swap if neighbor is also inside the brush
            float nU = neighborInvRG.r / max(destFrameCount, 1.0);
            float nV = 1.0 - (neighborInvRG.g + 0.5) / max(destBandCount, 1.0);
            if (getBrushWeight(vec2(nU, nV)) <= 0.0) {
                outColor = applyBrush(currentTexel, currentTexel, weight, coords.dest, vUv);
                return;
            }

            vec4 neighborTexel = texelFetch(destSpectrogramTex, neighborPixel, 0);

            float neighborInstFreqDev = (sortBy == 3)
                ? computeInstFreqDev(neighborTexel, neighborLinear, bandIndex, bandHz, timeStep, neighborTimeIdx, texSize)
                : 0.0;

            if (sortStereoMode == 0 || sortBy == 4) {
                float myMetric = getLinkedMetric(currentTexel, sortBy, myInstFreqDev);
                float neighborMetric = getLinkedMetric(neighborTexel, sortBy, neighborInstFreqDev);
                bool swap = isLeft
                    ? shouldSwap(myMetric, neighborMetric, sortOrder)
                    : shouldSwap(neighborMetric, myMetric, sortOrder);
                if (swap) sortedTexel = neighborTexel;
            } else {
                sortedTexel.rg = sortChannel(currentTexel.rg, neighborTexel.rg, passIndexOffset, timeIdx, myInstFreqDev, neighborInstFreqDev);
                sortedTexel.ba = sortChannel(currentTexel.ba, neighborTexel.ba, passIndexOffset, timeIdx, myInstFreqDev, neighborInstFreqDev);
            }
        }
    } else {
        // Vertical: sort across bands at the equivalent time position.
        int myParity = bandIndex % 2;
        bool isLeft = (myParity == passIndexOffset);
        int neighborBandIdx = isLeft ? bandIndex + 1 : bandIndex - 1;

        if (neighborBandIdx >= 0 && neighborBandIdx < int(destBandCount)) {
            vec4 neighborMeta = fetchBandMetadata(destMetadataTex, float(neighborBandIdx));
            int neighborBandStart = int(round(neighborMeta.r));
            int neighborBandLength = int(round(neighborMeta.g));

            float absoluteFrames = float(timeIdx) * timeStep;
            int neighborTimeIdx = int(floor(absoluteFrames / exp2(neighborMeta.b)));
            neighborTimeIdx = clamp(neighborTimeIdx, 0, neighborBandLength - 1);

            int neighborLinear = neighborBandStart + neighborTimeIdx;
            ivec2 neighborPixel = clamp(
                ivec2(neighborLinear % texSize.x, neighborLinear / texSize.x),
                ivec2(0), texSize - ivec2(1)
            );

            vec2 neighborInvRG = texelFetch(destInverseMapTex, neighborPixel, 0).rg;
            int neighborBandCheck = int(round(neighborInvRG.g));
            if (neighborBandCheck != neighborBandIdx) {
                outColor = applyBrush(currentTexel, currentTexel, weight, coords.dest, vUv);
                return;
            }

            // Only swap if neighbor is also inside the brush
            float nU = neighborInvRG.r / max(destFrameCount, 1.0);
            float nV = 1.0 - (float(neighborBandIdx) + 0.5) / max(destBandCount, 1.0);
            if (getBrushWeight(vec2(nU, nV)) <= 0.0) {
                outColor = applyBrush(currentTexel, currentTexel, weight, coords.dest, vUv);
                return;
            }

            vec4 neighborTexel = texelFetch(destSpectrogramTex, neighborPixel, 0);

            float neighborInstFreqDev = (sortBy == 3)
                ? computeInstFreqDev(neighborTexel, neighborLinear, neighborBandIdx, neighborMeta.a, exp2(neighborMeta.b), neighborTimeIdx, texSize)
                : 0.0;

            if (sortStereoMode == 0 || sortBy == 4) {
                float myMetric = getLinkedMetric(currentTexel, sortBy, myInstFreqDev);
                float neighborMetric = getLinkedMetric(neighborTexel, sortBy, neighborInstFreqDev);
                bool swap = isLeft
                    ? shouldSwap(myMetric, neighborMetric, sortOrder)
                    : shouldSwap(neighborMetric, myMetric, sortOrder);
                if (swap) sortedTexel = neighborTexel;
            } else {
                sortedTexel.rg = sortChannel(currentTexel.rg, neighborTexel.rg, passIndexOffset, bandIndex, myInstFreqDev, neighborInstFreqDev);
                sortedTexel.ba = sortChannel(currentTexel.ba, neighborTexel.ba, passIndexOffset, bandIndex, myInstFreqDev, neighborInstFreqDev);
            }
        }
    }

    outColor = applyBrush(currentTexel, sortedTexel, weight, coords.dest, vUv);

    if (any(isnan(outColor)) || any(isinf(outColor))) {
        outColor = currentTexel;
    }
}
