import { SimpleGrid } from "@mantine/core";
import { NUM_MACROS } from "@renderer/lib/constants";
import { useStore } from "@renderer/store";
import { ParameterKey } from "@renderer/store/types";
import { ParameterControl } from "./parameter-control";

const MACRO_KEYS = Array.from({ length: NUM_MACROS }, (_, i) => `macro${i + 1}Value` as ParameterKey);
const EMPTY_NAMES: readonly string[] = [];

export const MacroControls = () => {
  const macroNames = useStore(
    (state) => state.brushes[state.activeBrushIndex]?.macroNames ?? (EMPTY_NAMES as string[]),
  );
  return (
    <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
      {MACRO_KEYS.map((key, i) => (
        <ParameterControl
          key={key}
          paramKey={key}
          labelWidth={70}
          color="red"
          displayLabel={macroNames[i] ?? `Macro ${i + 1}`}
        />
      ))}
    </SimpleGrid>
  );
};
