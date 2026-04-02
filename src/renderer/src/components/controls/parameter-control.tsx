import type { ParameterKey } from "@/store/types";
import { useEffectId } from "@renderer/contexts/effect-context";
import { getParameterDef, isEffectParameter } from "@renderer/parameters";
import { selectEffectParameter, selectParameter, useStore } from "@renderer/store";
import { getContextualModAmountParamKeys, getModAmountParamKeys } from "@renderer/store/modulators";
import { denormalizeParameterValue, normalizeParameterValue } from "@renderer/store/utils";
import { memo } from "react";
import { useShallow } from "zustand/shallow";
import type { FileParameterValue } from "@renderer/parameters";
import { FileParameterControl } from "./file-parameter-control";
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

export const ParameterControl = memo(function ParameterControl({
  labelWidth = 70,
  disabled,
  color,
  paramKey,
  labelPosition,
}: ParameterControlProps) {
  const parameter = getParameterDef(paramKey);
  const { kind } = parameter;
  const isModulatable = kind === "number" && "modulatable" in parameter && parameter.modulatable;

  // Get effect ID from context if we're inside an effect
  const effectId = useEffectId();
  const isEffectParam = isEffectParameter(paramKey);
  const useEffectScope = effectId !== null && isEffectParam;

  // Combine selectors into a single subscription with shallow comparison
  const { isModulated, parameterValue, setParameter } = useStore(
    useShallow((state) => {
      // Check if parameter is modulated
      let modulated = false;
      if (isModulatable) {
        const patternKeys = getModAmountParamKeys(paramKey);
        const contextualKeys = getContextualModAmountParamKeys(paramKey);

        for (const key of patternKeys) {
          const amount = useEffectScope ? selectEffectParameter(effectId, key)(state) : selectParameter(key)(state);
          if (amount !== 0) {
            modulated = true;
            break;
          }
        }

        if (!modulated) {
          for (const key of contextualKeys) {
            const amount = useEffectScope ? selectEffectParameter(effectId, key)(state) : selectParameter(key)(state);
            if (amount !== 0) {
              modulated = true;
              break;
            }
          }
        }
      }

      // Get parameter value
      const value = useEffectScope
        ? selectEffectParameter(effectId, paramKey)(state)
        : selectParameter(paramKey)(state);

      return {
        isModulated: modulated,
        parameterValue: value,
        setParameter: state.setParameter,
      };
    }),
  );

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

  if (kind === "file") {
    return (
      <FileParameterControl
        labelComponent={labelComponent}
        value={parameterValue as FileParameterValue}
        setValue={handleSetValue}
        paramKey={paramKey}
      />
    );
  }

  return null;
});
