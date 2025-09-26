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
  modulatable?: boolean;
  modulatorParam?: keyof State;
};

export const ParameterControl = (props: ParameterControlProps) => {
  const parameter = useStore((state) => state[props.paramKey]) as AnyParameter<any>;

  if (!parameter) return null;

  if (isOptionsParameter(parameter)) {
    return (
      <SelectControl
        label={parameter.label}
        value={parameter.value}
        options={parameter.options}
        setValue={parameter.setValue}
        resetValue={parameter.resetValue}
      />
    );
  }

  if (isContinuousNumberParameter(parameter)) {
    return (
      <SliderControl
        label={parameter.label}
        value={parameter.value}
        setValue={parameter.setValue}
        resetValue={parameter.resetValue}
        min={parameter.min}
        max={parameter.max}
        step={parameter.step}
        unit={parameter.unit}
        disabled={props.disabled}
        modulatable={props.modulatable}
        modulatorParam={props.modulatorParam}
      />
    );
  }
  if (isDiscreteNumberParameter(parameter)) {
    return (
      <SliderControl
        label={parameter.label}
        value={parameter.value}
        setValue={parameter.setValue}
        resetValue={parameter.resetValue}
        min={parameter.values[0].value}
        max={parameter.values[parameter.values.length - 1].value}
        marks={parameter.values.map((v) => ({ value: v.value, label: v.label }))}
        unit={parameter.unit}
        disabled={props.disabled}
        modulatable={props.modulatable}
        modulatorParam={props.modulatorParam}
      />
    );
  }
  return (
    <SwitchControl
      label={parameter.label}
      value={parameter.value}
      setValue={parameter.setValue}
      resetValue={parameter.resetValue}
    />
  );
};
