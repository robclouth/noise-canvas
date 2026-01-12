import type { ParameterKey } from "@/store/types";
import { Text } from "@mantine/core";
import { getParameterDef } from "@renderer/parameters";
import { selectParameter, useStore } from "@renderer/store";
import { getContextualModAmountParamKeys, getModAmountParamKeys } from "@renderer/store/modulators";
import { denormalizeParameterValue, normalizeParameterValue } from "@renderer/store/utils";
import { Tooltip } from "../tooltip";
import { NumboxControl } from "./numbox-control";
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
  const { kind, default: defaultValue, label, description } = parameter;
  const isModulatable = kind === "number" && "modulatable" in parameter && parameter.modulatable;

  const isModulated = useStore((state) => {
    if (!isModulatable) return false;
    // Check pattern modulator amounts
    const patternModulated = getModAmountParamKeys(paramKey)
      .map((key) => {
        return selectParameter(key)(state);
      })
      .some((amount) => amount !== 0);
    // Check contextual modulator amounts
    const contextualModulated = getContextualModAmountParamKeys(paramKey)
      .map((key) => {
        return selectParameter(key)(state);
      })
      .some((amount) => amount !== 0);
    return patternModulated || contextualModulated;
  });

  const parameterValue = useStore(selectParameter(paramKey));
  const setParameter = useStore((state) => state.setParameter);

  const labelComponent = (
    <Tooltip label={description}>
      <Text
        size="xs"
        w={labelWidth}
        lineClamp={1}
        truncate="end"
        onDoubleClick={() => setParameter(paramKey, defaultValue)}
        c={isModulated ? "blue" : "dark.0"}
        ta="right"
      >
        {label}
      </Text>
    </Tooltip>
  );

  if (kind === "options") {
    return (
      <SelectControl
        labelComponent={labelComponent}
        value={parameterValue}
        options={parameter.options}
        setValue={(value) => setParameter(paramKey, value)}
        labelWidth={60}
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
        setValue={(value) => setParameter(paramKey, value)}
        min={parameter.min}
        max={parameter.max}
        step={parameter.step}
        unit={parameter.unit}
        marks={parameter.marks}
        disabled={disabled}
        modulatorParamKeys={isModulatable ? getModAmountParamKeys(paramKey) : undefined}
        contextualModParamKeys={isModulatable ? getContextualModAmountParamKeys(paramKey) : undefined}
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
        setValue={(value) => setParameter(paramKey, value)}
        color={color}
      />
    );
  }
  return null;
};
