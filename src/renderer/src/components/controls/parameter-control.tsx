import type { ParameterKey } from "@/store/types";
import { Text } from "@mantine/core";
import { getParameterDef } from "@renderer/parameters";
import { useStore } from "@renderer/store";
import { getModAmountParamKeys } from "@renderer/store/modulators";
import { denormalizeParameterValue, normalizeParameterValue } from "@renderer/store/utils";
import { Tooltip } from "../tooltip";
import { SelectControl } from "./select-control";
import { SliderControl } from "./slider-control";
import { SwitchControl } from "./switch-control";

export type ParameterControlProps = {
  paramKey: ParameterKey;
  labelWidth?: number;
  disabled?: boolean;
  color?: string;
};

export const ParameterControl = ({ labelWidth = 70, disabled, color, paramKey }: ParameterControlProps) => {
  const parameter = getParameterDef(paramKey);
  const { kind, default: defaultValue, label, description } = parameter;
  const isModulatable = kind === "number" && "modulatable" in parameter && parameter.modulatable;

  const isModulated = useStore((state) => {
    return (
      isModulatable &&
      getModAmountParamKeys(paramKey)
        .map((key) => {
          return state[key];
        })
        .some((amount) => amount !== 0)
    );
  });

  const parameterValue = useStore((state) => state[paramKey]);
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
      />
    );
  }

  if (kind === "number") {
    return (
      <SliderControl
        labelComponent={labelComponent}
        value={parameterValue as number}
        setValue={(value) => setParameter(paramKey, value)}
        min={parameter.min}
        max={parameter.max}
        step={parameter.step}
        unit={parameter.unit}
        marks={parameter.marks}
        disabled={disabled}
        modulatorParamKeys={isModulatable ? getModAmountParamKeys(paramKey) : undefined}
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
