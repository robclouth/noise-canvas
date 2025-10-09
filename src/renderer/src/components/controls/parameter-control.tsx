import {
  AnyParameter,
  BooleanParameter,
  ContinuousNumberParameter,
  DiscreteNumberParameter,
  OptionsParameter,
} from "@/types";
import { Text } from "@mantine/core";
import { ParameterKey, useStore } from "@renderer/store";
import { Tooltip } from "../tooltip";
import { SelectControl } from "./select-control";
import { SliderControl } from "./slider-control";
import { SwitchControl } from "./switch-control";

function isOptionsParameter(p: AnyParameter<any>): p is OptionsParameter<any> {
  return "options" in p;
}

function isContinuousNumberParameter(p: AnyParameter<any>): p is ContinuousNumberParameter {
  return "min" in p;
}

function isDiscreteNumberParameter(p: AnyParameter<any>): p is DiscreteNumberParameter {
  return "values" in p;
}

function isBooleanParameter(p: AnyParameter<any>): p is BooleanParameter {
  return typeof p.value === "boolean";
}

export type ParameterControlProps = {
  paramKey: ParameterKey;
  labelWidth?: number;
  disabled?: boolean;
  color?: string;
};

export const ParameterControl = ({ labelWidth = 70, disabled, color, paramKey }: ParameterControlProps) => {
  const isModulated = useStore((state) => {
    return state[paramKey]?.modulatorParamKeys
      ?.map((key) => {
        return state[key].value;
      })
      .some((amount) => amount !== 0);
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

  if (isContinuousNumberParameter(parameter)) {
    return (
      <SliderControl
        labelComponent={labelComponent}
        value={parameter.value}
        setValue={parameter.setValue}
        min={parameter.min}
        max={parameter.max}
        step={parameter.step}
        unit={parameter.unit}
        disabled={disabled}
        modulatorParamKeys={parameter.modulatorParamKeys}
        color={color}
      />
    );
  }
  if (isDiscreteNumberParameter(parameter)) {
    return (
      <SliderControl
        labelComponent={labelComponent}
        value={parameter.value}
        setValue={parameter.setValue}
        min={0}
        max={parameter.values.length - 1}
        marks={parameter.values.map((v) => ({ value: v.value, label: v.label }))}
        unit={parameter.unit}
        disabled={disabled}
        modulatorParamKeys={parameter.modulatorParamKeys}
        color={color}
      />
    );
  }
  if (isBooleanParameter(parameter)) {
    return <SwitchControl labelComponent={labelComponent} value={parameter.value} setValue={parameter.setValue} />;
  }
  return null;
};
