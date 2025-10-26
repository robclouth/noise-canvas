import { parameterDefs } from "@renderer/parameters";
import type { ParameterKey } from "./types";

// utils/normalizers.ts
const EPS = 1e-9;

// Helper to generate unique file IDs
export function generateFileId(): string {
  return `file_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

export function normalizeParameterValue(paramKey: ParameterKey, value: number): number {
  const parameterDef = parameterDefs[paramKey];
  if (parameterDef.kind !== "number") {
    throw new Error(`Parameter ${paramKey} is not a number parameter`);
  }

  const { min, max, scale = "linear", leftValue, rightValue } = parameterDef;
  if (leftValue && value === leftValue.value) return 0;
  if (rightValue && value === rightValue.value) return 1;
  const clampedValue = Math.min(Math.max(value, min), max);

  if (scale === "log") {
    // If the configured minimum is <= 0 we can't use a plain log because
    // log(0) is -Infinity. Use a log1p mapping across [0..max] which is
    // smooth near zero. Otherwise use the traditional log mapping across
    // [min..max].
    if (min <= 0) {
      const maxLog = Math.log1p(Math.max(max, EPS));
      const valLog = Math.log1p(Math.max(clampedValue, 0));
      return valLog / maxLog;
    }

    const logMin = Math.log(Math.max(min, EPS));
    const logMax = Math.log(Math.max(max, EPS));
    const logValue = Math.log(Math.max(clampedValue, min));
    return (logValue - logMin) / (logMax - logMin);
  }

  if (scale === "logBipolar") {
    const sign = clampedValue < 0 ? -1 : 1;
    const absValue = Math.abs(clampedValue);
    const maxAbs = Math.max(Math.abs(min), Math.abs(max), EPS);
    const normMagnitude = Math.log1p(absValue) / Math.log1p(maxAbs);
    return sign === -1 ? 0.5 - 0.5 * normMagnitude : 0.5 + 0.5 * normMagnitude;
  }

  // linear
  return (clampedValue - min) / (max - min);
}

export function denormalizeParameterValue(paramKey: ParameterKey, normalizedValue: number): number {
  const parameterDef = parameterDefs[paramKey];
  if (parameterDef.kind !== "number") {
    throw new Error(`Parameter ${paramKey} is not a number parameter`);
  }

  const { min, max, scale = "linear", leftValue, rightValue } = parameterDef;

  if (leftValue && normalizedValue <= 0) return leftValue.value;
  if (rightValue && normalizedValue >= 1) return rightValue.value;

  if (scale === "log") {
    if (min <= 0) {
      const maxLog = Math.log1p(Math.max(max, EPS));
      const absValue = Math.expm1(normalizedValue * maxLog);
      return absValue;
    }

    const logMin = Math.log(Math.max(min, EPS));
    const logMax = Math.log(Math.max(max, EPS));
    const logValue = logMin + normalizedValue * (logMax - logMin);
    return Math.exp(logValue);
  }

  if (scale === "logBipolar") {
    const sign = normalizedValue < 0.5 ? -1 : 1;
    const absNormalized = Math.abs((normalizedValue - 0.5) * 2);
    const maxAbs = Math.max(Math.abs(min), Math.abs(max), EPS);
    const absValue = Math.expm1(absNormalized * Math.log1p(maxAbs));
    return sign * absValue;
  }

  // linear
  return min + normalizedValue * (max - min);
}
