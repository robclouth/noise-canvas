import type { ParameterKey } from "@/store/types";
import { useEffectId } from "@renderer/contexts/effect-context";
import { getParameterDef, isEffectParameter } from "@renderer/parameters";
import { getEffectParameterValue, getMacroValueIndex, getParameterValue, useStore } from "@renderer/store";
import { denormalizeParameterValue, normalizeParameterValue } from "@renderer/store/utils";
import {
  formatParameterValue,
  hasDynamicSources,
  macroTargets,
  resolvedStaticValue,
  scopedStateView,
  totalModulationWeight,
} from "@renderer/lib/macro-targets";
import { LABEL_WIDTH } from "@renderer/lib/ui-density";
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
  labelWidth?: number | string;
  disabled?: boolean;
  color?: string;
  labelPosition?: "left" | "top";
  displayLabel?: string;
};

export const ParameterControl = memo(function ParameterControl({
  labelWidth = LABEL_WIDTH,
  disabled,
  color,
  paramKey,
  labelPosition,
  displayLabel,
}: ParameterControlProps) {
  const parameter = getParameterDef(paramKey);
  const { kind } = parameter;
  const isModulatable = kind === "number" && "modulatable" in parameter && parameter.modulatable;

  // Get effect ID from context if we're inside an effect
  const effectId = useEffectId();
  const isEffectParam = isEffectParameter(paramKey);
  const useEffectScope = effectId !== null && isEffectParam;

  const macroIndex = getMacroValueIndex(paramKey);

  // Combine selectors into a single subscription with shallow comparison
  const { isModulated, parameterValue, setParameter, display, dimmed, targetSummary } = useStore(
    useShallow((state) => {
      const value = useEffectScope
        ? getEffectParameterValue(state, effectId, paramKey)
        : getParameterValue(state, paramKey);

      // A macro knob reads as the value of its one target, or as a percentage
      // when it drives several. With no target it is greyed out.
      if (macroIndex !== null) {
        const targets = macroTargets(state, macroIndex).map((target) => {
          const view = scopedStateView(state, target.stepIndex, target.effectId);
          const resolved = hasDynamicSources(view, target.key)
            ? null
            : formatParameterValue(target.key, resolvedStaticValue(view, target.key));
          return { name: getParameterDef(target.key).name, resolved };
        });
        const only = targets.length === 1 ? targets[0] : null;
        const knobView = scopedStateView(state, state.activeStepIndex);
        return {
          isModulated: totalModulationWeight(knobView, paramKey) > 0,
          parameterValue: value,
          setParameter: state.setParameter,
          display: only?.resolved ?? undefined,
          dimmed: targets.length === 0,
          targetSummary:
            targets.length > 0
              ? targets
                  .map((target) => (target.resolved ? `${target.name} ${target.resolved}` : target.name))
                  .join(" · ")
              : undefined,
        };
      }

      if (!isModulatable) {
        return {
          isModulated: false,
          parameterValue: value,
          setParameter: state.setParameter,
          display: undefined,
          dimmed: false,
          targetSummary: undefined,
        };
      }

      // Past a total weight of 1 the base value no longer reaches the shader, so
      // the box dims and, when every source is static, shows the resolved value.
      const view = scopedStateView(state, state.activeStepIndex, useEffectScope ? effectId : undefined);
      const weight = totalModulationWeight(view, paramKey);
      const fullyModulated = weight >= 1;
      const resolved =
        fullyModulated && !hasDynamicSources(view, paramKey)
          ? formatParameterValue(paramKey, resolvedStaticValue(view, paramKey))
          : undefined;
      return {
        isModulated: weight > 0,
        parameterValue: value,
        setParameter: state.setParameter,
        display: resolved,
        dimmed: fullyModulated,
        targetSummary: undefined,
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
    <ParamMenu
      paramKey={paramKey}
      labelWidth={labelWidth}
      isModulated={isModulated}
      effectId={effectId ?? undefined}
      displayLabel={displayLabel}
      displayDescription={targetSummary}
      dimmed={dimmed}
    >
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
        leftValue={parameter.leftValue}
        rightValue={parameter.rightValue}
        displayValue={display}
        dimmed={dimmed}
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
