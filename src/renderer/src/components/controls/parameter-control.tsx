import { State, useStore } from "@/store";
import { AnyParameter, ContinuousNumberParameter, DiscreteNumberParameter, OptionsParameter } from "@/types";
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

export const ParameterControl = (props: ParameterControlProps) => {
  const parameter = useStore((state) => state[props.paramKey]) as AnyParameter<any>;

  if (!parameter) return null;

  if (isOptionsParameter(parameter)) {
    return (
      <SelectControl
        label={parameter.label}
        description={parameter.description}
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
        label={parameter.label}
        description={parameter.description}
        value={parameter.value}
        setValue={parameter.setValue}
        resetValue={parameter.resetValue}
        min={parameter.min}
        max={parameter.max}
        step={parameter.step}
        unit={parameter.unit}
        disabled={props.disabled}
        modulatorParamKey={parameter.modulatorParamKey}
        color={props.color}
        labelWidth={60}
      />
    );
  }
  if (isDiscreteNumberParameter(parameter)) {
    return (
      <SliderControl
        label={parameter.label}
        description={parameter.description}
        value={parameter.value}
        setValue={parameter.setValue}
        resetValue={parameter.resetValue}
        min={0}
        max={parameter.values.length - 1}
        marks={parameter.values.map((v) => ({ value: v.value, label: v.label }))}
        unit={parameter.unit}
        disabled={props.disabled}
        modulatorParamKey={parameter.modulatorParamKey}
        color={props.color}
        labelWidth={60}
      />
    );
  }
  return (
    <SwitchControl
      label={parameter.label}
      description={parameter.description}
      value={parameter.value}
      setValue={parameter.setValue}
      resetValue={parameter.resetValue}
      labelWidth={60}
    />
  );
};
