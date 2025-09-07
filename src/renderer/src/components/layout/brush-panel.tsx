import { BrushType, brushes } from "@/components/brushes";
import { brushTypeAtom } from "@/store";
import { Flex, Select } from "@mantine/core";
import { useAtom } from "jotai";
import { ParameterControl } from "../controls/parameter-control";

export function BrushPanel() {
  const [brushType, setBrushType] = useAtom(brushTypeAtom);
  return (
    <Flex direction="column" w={300} p="xs" gap="xs">
      <Select
        size="xs"
        value={brushType}
        onChange={(value) => setBrushType(value as BrushType)}
        data={Object.keys(brushes).map((key) => ({
          value: key,
          label: key.charAt(0).toUpperCase() + key.slice(1),
        }))}
      />
      {brushes[brushType].parameters.map((param) => (
        <ParameterControl key={param.label} parameter={param} />
      ))}
    </Flex>
  );
}
