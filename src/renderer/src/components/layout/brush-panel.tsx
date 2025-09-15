import { brushes } from "@/components/brushes";
import { ParameterControl } from "@/components/controls/parameter-control";
import { SelectControl } from "@/components/controls/select-control";
import { brushTypeAtom } from "@/store";
import { Flex } from "@mantine/core";
import { useAtom } from "jotai";

export function BrushPanel() {
  const [brushType] = useAtom(brushTypeAtom);

  const brush = brushes[brushType];
  return (
    <Flex direction="column" w={300} p="xs" gap={0}>
      <SelectControl
        label="Brush"
        atom={brushTypeAtom}
        data={Object.keys(brushes).map((key) => ({
          value: key,
          label: key.charAt(0).toUpperCase() + key.slice(1),
        }))}
      />
      {brush ? brush.parameters.map((param) => <ParameterControl key={param.label} parameter={param} />) : null}
    </Flex>
  );
}
