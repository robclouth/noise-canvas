import type { ParameterKey } from "@/store/types";
import { Text } from "@mantine/core";
import { useStore } from "@renderer/store";
import { isBooleanParameter, isNumberParameter, isOptionsParameter } from "@renderer/store/utils";
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
  const isModulated = useStore((state) => {
    return (
      isNumberParameter(state[paramKey]) &&
      state[paramKey]?.modulatorParamKeys
        ?.map((key) => {
          return state[key].value;
        })
        .some((amount) => amount !== 0)
    );
  });

  const parameter = useStore((state) => state[paramKey]);
  if (!parameter) return null;
  const { description, label, resetValue } = parameter;

  const labelComponent = (
    <Tooltip label={description}>
      <Text
        size="xs"
        w={labelWidth}
        lineClamp={1}
        truncate="end"
        onDoubleClick={() => resetValue()}
        c={isModulated ? "blue" : "dark.0"}
      >
        {label}
      </Text>
    </Tooltip>
  );

  if (isOptionsParameter(parameter)) {
    return (
      <SelectControl
        labelComponent={labelComponent}
        value={parameter.value}
        options={parameter.options}
        setValue={parameter.setValue}
        resetValue={parameter.resetValue}
        labelWidth={60}
      />
    );
  }

  if (isNumberParameter(parameter)) {
    return (
      <SliderControl
        labelComponent={labelComponent}
        value={parameter.value}
        setValue={parameter.setValue}
        min={parameter.min}
        max={parameter.max}
        step={parameter.step}
        unit={parameter.unit}
        marks={parameter.marks}
        disabled={disabled}
        modulatorParamKeys={parameter.modulatorParamKeys}
        color={color}
        leftValue={parameter.leftValue}
        rightValue={parameter.rightValue}
        fromNormalized={parameter.fromNormalized}
        toNormalized={parameter.toNormalized}
      />
    );
  }

  if (isBooleanParameter(parameter)) {
    return <SwitchControl labelComponent={labelComponent} value={parameter.value} setValue={parameter.setValue} />;
  }
  return null;
};
