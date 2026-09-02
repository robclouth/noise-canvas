import { Checkbox, ScrollArea, Stack } from "@mantine/core";
import { useState, type RefObject } from "react";

/** One open file the dialog can bracket, in canvas order. */
export type GroupFileOption = { id: string; label: string };

/** The body of the Group Files dialog, writing each tick into `selection`. */
export const GroupFilesFields = ({
  options,
  selection,
  onChange,
}: {
  options: GroupFileOption[];
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
