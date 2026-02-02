import type { ParameterKey } from "@/store/types";
import { useEffectId } from "@renderer/contexts/effect-context";
import { getParameterDef, isEffectParameter } from "@renderer/parameters";
import { selectEffectParameter, selectParameter, useStore } from "@renderer/store";
import { getContextualModAmountParamKeys, getModAmountParamKeys } from "@renderer/store/modulators";
import { denormalizeParameterValue, normalizeParameterValue } from "@renderer/store/utils";
import { NumboxControl } from "./numbox-control";
import { ParamMenu } from "./param-menu";
import { SelectControl } from "./select-control";
import { SwitchControl } from "./switch-control";

export type ParameterControlProps = {
  paramKey: ParameterKey;
  labelWidth?: number;
  disabled?: boolean;
  color?: string;
  labelPosition?: "left" | "top";
};

export const ParameterControl = ({
  labelWidth = 70,
  disabled,
  color,
  paramKey,
  labelPosition,
}: ParameterControlProps) => {
  const parameter = getParameterDef(paramKey);
  const { kind } = parameter;
  const isModulatable = kind === "number" && "modulatable" in parameter && parameter.modulatable;

  // Get effect ID from context if we're inside an effect
  const effectId = useEffectId();
  const isEffectParam = isEffectParameter(paramKey);
  const useEffectScope = effectId !== null && isEffectParam;

  const isModulated = useStore((state) => {
    if (!isModulatable) return false;
    // Check pattern modulator amounts
    const patternModulated = getModAmountParamKeys(paramKey)
      .map((key) => {
        if (useEffectScope) {
          return selectEffectParameter(effectId, key)(state);
        }
        return selectParameter(key)(state);
      })
      .some((amount) => amount !== 0);
    // Check contextual modulator amounts
    const contextualModulated = getContextualModAmountParamKeys(paramKey)
      .map((key) => {
        if (useEffectScope) {
          return selectEffectParameter(effectId, key)(state);
        }
        return selectParameter(key)(state);
      })
      .some((amount) => amount !== 0);
    return patternModulated || contextualModulated;
  });

  // Use effect-scoped selector when inside effect context for effect parameters
  const parameterValue = useStore((state) => {
    if (useEffectScope) {
      return selectEffectParameter(effectId, paramKey)(state);
    }
    return selectParameter(paramKey)(state);
  });

  const setParameter = useStore((state) => state.setParameter);

  // Wrapper that passes effectId when appropriate
  const handleSetValue = (value: unknown) => {
    if (useEffectScope) {
      setParameter(paramKey, value, effectId);
    } else {
      setParameter(paramKey, value);
    }
  };

  // Use ParamMenu as the label component (it handles the label rendering internally)
  const labelComponent = (
    <ParamMenu paramKey={paramKey} labelWidth={labelWidth} isModulated={isModulated} effectId={effectId ?? undefined}>
      {parameter.label}
    </ParamMenu>
  );

  if (kind === "options") {
    return (
      <SelectControl
        labelComponent={labelComponent}
        value={parameterValue}
        options={parameter.options}
        setValue={handleSetValue}
        labelWidth={labelWidth}
        color={color}
      />
    );
  }

  if (kind === "number") {
    return (
      <NumboxControl
        labelComponent={labelComponent}
        labelPosition={labelPosition}
        value={parameterValue as number}
        setValue={handleSetValue}
        min={parameter.min}
        max={parameter.max}
        step={parameter.step}
        unit={parameter.unit}
        marks={parameter.marks}
        disabled={disabled}
        color={color}
        rightValue={parameter.rightValue}
        fromNormalized={(value) => denormalizeParameterValue(paramKey, value)}
        toNormalized={(value) => normalizeParameterValue(paramKey, value)}
      />
    );
  }

  if (kind === "boolean") {
    return (
      <SwitchControl
        labelComponent={labelComponent}
        value={parameterValue as boolean}
        setValue={handleSetValue}
        color={color}
      />
    );
  }
  return null;
};
