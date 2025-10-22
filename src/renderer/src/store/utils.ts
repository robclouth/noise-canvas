import { NUM_MODULATORS } from "../lib/constants";
import type {
  BooleanParameter,
  ModulatorAmountParameters,
  NumberParameter,
  OptionsParameter,
  SliderScale,
  ZustandGet,
  ZustandSet,
} from "./types";

// utils/normalizers.ts
const EPS = 1e-9;

// Helper to generate unique file IDs
export function generateFileId(): string {
  return `file_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

export function makeNormalizersNumber(cfg: {
  min: number;
  max: number;
  scale?: SliderScale;
  leftValue?: { value: number };
  rightValue?: { value: number };
}) {
  const { min, max, scale = "linear", leftValue, rightValue } = cfg;

  const valueToNormalized = (value: number) => {
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
  };

  const normalizedToValue = (normalizedValue: number) => {
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
  };

  return {
    toNormalized(value: number) {
      return valueToNormalized(value);
    },
    fromNormalized(normalizedValue: number) {
      return normalizedToValue(normalizedValue);
    },
  };
}

export function makeNormalizersBoolean() {
  return {
    toNormalized(value: boolean) {
      return value ? 1 : 0;
    },
    fromNormalized(normalizedValue: number) {
      return normalizedValue >= 0.5;
    },
  };
}

export type NumberParamConfig = Omit<
  NumberParameter,
  "setValue" | "resetValue" | "toNormalized" | "fromNormalized" | "modulatorParamKeys"
> & { kind: "number" };

export type BooleanParamConfig = Omit<
  BooleanParameter,
  "setValue" | "resetValue" | "toNormalized" | "fromNormalized"
> & { kind: "boolean" };

export type OptionsParamConfig<T = string> = Omit<OptionsParameter<T>, "setValue" | "resetValue"> & { kind: "options" };

export type ParamConfig = NumberParamConfig | BooleanParamConfig | OptionsParamConfig<any>;

type ModOpts = { modulatable?: boolean };

export function makeCreateParameter<S extends Record<string, any>>(set: ZustandSet, get: ZustandGet) {
  function createModulatorAmountParams(baseKey: string) {
    const o: Record<string, any> = {};
    for (let i = 0; i < NUM_MODULATORS; i++) {
      const k = `${baseKey}Mod${i + 1}Amount`;
      o[k] = {
        kind: "number" as const,
        name: `Mod ${i + 1} Amount`,
        label: `Mod ${i + 1}`,
        description:
          "The amount of modulation to apply. 0% is no modulation and only the value of the parameter is used, 100% is full modulation and the current value of the modulated parameter is ignored.",
        value: 0,
        min: -100,
        max: 100,
        step: 0.1,
        unit: "%",

        toNormalized: (v?: number) => {
          const x = typeof v === "number" ? v : 0;
          return x * 100;
        },
        fromNormalized: (n: number) => n * 100,

        setValue: (v: number) => set((state: any) => ({ [k]: { ...state[k], value: v } })),
        resetValue: () => set((state: any) => ({ [k]: { ...state[k], value: 0 } })),
      };
    }
    return o;
  }

  function createParam<K extends keyof S & string>(
    key: K,
    config: NumberParamConfig,
    opts?: ModOpts,
  ): Pick<S, K> & Partial<S>;
  function createParam<K extends keyof S & string>(
    key: K,
    config: BooleanParamConfig,
    opts?: { modulatable?: false },
  ): Pick<S, K>;
  function createParam<T, K extends keyof S & string>(
    key: K,
    config: OptionsParamConfig<T>,
    opts?: { modulatable?: false },
  ): Pick<S, K>;

  function createParam<K extends keyof S & string>(key: K, config: ParamConfig, opts?: ModOpts): any {
    const out: Record<string, any> = {};

    if (config.kind === "number") {
      const { toNormalized, fromNormalized } = makeNormalizersNumber({
        min: config.min,
        max: config.max,
        scale: config.scale,
        leftValue: config.leftValue,
        rightValue: config.rightValue,
      });

      const param: NumberParameter = {
        ...config,
        toNormalized: (value?: number) => toNormalized(value ?? get()[key as any].value),
        fromNormalized: (normalizedValue: number) => fromNormalized(normalizedValue),
        setValue: (v: number) => set((state: any) => ({ [key]: { ...state[key], value: v } })),
        resetValue: () => set((state: any) => ({ [key]: { ...state[key], value: config.value } })),
        modulatorParamKeys: opts?.modulatable
          ? Array.from({ length: NUM_MODULATORS }).map(
              (_, i) => `${String(key)}Mod${i + 1}Amount` as keyof ModulatorAmountParameters,
            )
          : undefined,
      };

      out[key] = param;

      if (opts?.modulatable) {
        Object.assign(out, createModulatorAmountParams(String(key)));
      }

      return out;
    }

    if (config.kind === "boolean") {
      const { toNormalized, fromNormalized } = makeNormalizersBoolean();

      const param: BooleanParameter = {
        ...config,
        toNormalized: (value?: boolean) => toNormalized(value ?? get()[key as any].value),
        fromNormalized: (normalizedValue: number) => fromNormalized(normalizedValue),
        setValue: (v: boolean) => set((state: any) => ({ [key]: { ...state[key], value: v } })),
        resetValue: () => set((state: any) => ({ [key]: { ...state[key], value: config.value } })),
      };

      out[key] = param;
      return out;
    }

    const param: OptionsParameter<any> = {
      ...config,
      setValue: (v: any) => set((state: any) => ({ [key]: { ...state[key], value: v } })),
      resetValue: () => set((state: any) => ({ [key]: { ...state[key], value: config.value } })),
    };

    out[key] = param;
    return out;
  }

  return createParam;
}
