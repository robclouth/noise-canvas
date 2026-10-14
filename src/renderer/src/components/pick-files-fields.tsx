import { Checkbox, ScrollArea, Stack } from "@mantine/core";
import { useState, type RefObject } from "react";

/** One open file the dialog offers, in canvas order. */
export type PickFileOption = { id: string; label: string };

/** A list of open files to tick, writing each tick into `selection`. */
export const PickFilesFields = ({
  options,
  selection,
  onChange,
}: {
  options: PickFileOption[];
  selection: RefObject<string[]>;
  onChange?: (fileIds: string[]) => void;
}) => {
  const [picked, setPicked] = useState(selection.current);

  return (
    <ScrollArea.Autosize mah={280}>
      <Checkbox.Group
        value={picked}
        onChange={(value) => {
          selection.current = value;
          setPicked(value);
          onChange?.(value);
        }}
      >
        <Stack gap="xs">
          {options.map((option) => (
            <Checkbox key={option.id} value={option.id} label={option.label} size="xs" />
          ))}
        </Stack>
      </Checkbox.Group>
    </ScrollArea.Autosize>
  );
};
