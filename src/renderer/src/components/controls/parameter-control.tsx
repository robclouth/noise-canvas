import { State, useStore } from "@/store";
import { AnyParameter, ContinuousNumberParameter, DiscreteNumberParameter, OptionsParameter } from "@/types";
import { Text } from "@mantine/core";
import { Tooltip } from "../tooltip";
import { SelectControl } from "./select-control";
import { SliderControl } from "./slider-control";
import { SwitchControl } from "./switch-control";

function isOptionsParameter<T>(p: AnyParameter<T>): p is OptionsParameter<T> {
  return "options" in p;
}

function isContinuousNumberParameter(p: AnyParameter<any>): p is ContinuousNumberParameter {
  return "min" in p;
}

function isDiscreteNumberParameter(p: AnyParameter<any>): p is DiscreteNumberParameter {
  return "values" in p;
}

export type ParameterControlProps = {
  paramKey: keyof State;
  labelWidth?: number;
  disabled?: boolean;
  color?: string;
};

export const ParameterControl = ({ labelWidth = 60, disabled, color, paramKey }: ParameterControlProps) => {
  const parameter = useStore((state) => state[paramKey]) as AnyParameter<any>;
  const modulator = useStore((state) => (parameter.modulatorParamKey ? state[parameter.modulatorParamKey] : undefined));
  const isModulated = modulator && typeof modulator === "object" && "value" in modulator && modulator.value !== 0;

  if (!parameter) return null;

  const labelComponent = (
    <Tooltip label={parameter.description}>
      <Text
        size="xs"
        w={labelWidth}
        lineClamp={1}
        truncate="end"
        onDoubleClick={() => parameter.resetValue()}
        c={isModulated ? "blue" : "dark.0"}
      >
        {parameter.label}
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
        modulatorParamKey={parameter.modulatorParamKey}
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
        modulatorParamKey={parameter.modulatorParamKey}
        color={color}
      />
    );
  }
  return <SwitchControl labelComponent={labelComponent} value={parameter.value} setValue={parameter.setValue} />;
};
