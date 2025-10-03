export type Parameter<T> = {
  name: string;
  label: string;
  description: string;
  unit?: string;
  value: T;
  modulatorParamKeys?: ParameterKey[];
  setValue: (value: T) => void;
  resetValue: () => void;
};
