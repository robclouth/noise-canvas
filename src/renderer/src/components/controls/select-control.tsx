import { Select } from "@mantine/core";
import { useAtom } from "jotai";
import { SelectParameter } from "@/components/brushes/base-brush";

export const SelectControl = ({ parameter }: { parameter: SelectParameter }) => {
  const [value, setValue] = useAtom(parameter.atom);
  const data = parameter.options.map((key) => ({
    value: key,
    label: key.charAt(0).toUpperCase() + key.slice(1),
  }));

  return (
    <Select
      key={parameter.label}
      label={parameter.label}
      data={data}
      value={value}
      onChange={(val) => setValue(val || parameter.options[0])}
    />
  );
};
