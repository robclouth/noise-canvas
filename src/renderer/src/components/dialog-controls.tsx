import type { ParameterKey } from "@/store/types";
import { SimpleGrid } from "@mantine/core";
import { ParameterControl } from "./controls/parameter-control";

/** A dialog's parameter controls, two to a row in order, so a control that only sometimes shows leaves no gap. */
export const DialogControls = ({ keys }: { keys: readonly ParameterKey[] }) => (
  <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
    {keys.map((key) => (
      <ParameterControl key={key} paramKey={key} plainLabel />
    ))}
  </SimpleGrid>
);
