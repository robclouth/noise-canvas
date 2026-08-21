import { Group, Select, Text } from "@mantine/core";
import { CONTROL_ROW_GAP, CONTROL_ROW_HEIGHT, VALUE_WIDTH } from "@renderer/lib/ui-density";
import { Check, ChevronDown } from "lucide-react";
import { ReactNode, useRef } from "react";

const DESCRIBED_DROPDOWN_WIDTH = 320;
const PLAIN_DROPDOWN_WIDTH = 120;
const DESCRIBED_DROPDOWN_HEIGHT = 340;
/** Tick, label and line each hold their own column so the rows read as a table. */
const DESCRIBED_OPTION_COLUMNS = "11px 54px 1fr";

export const SelectControl = <T,>({
  labelComponent,
  options,
  value,
  setValue,
  color = "orange",
  dropdownZIndex,
}: {
  labelComponent: ReactNode;
  value: T;
  options: readonly { value: T; label: string; group?: string; description?: string }[];
  setValue: (value: T) => void;
  labelWidth?: number | string;
  color?: string;
  dropdownZIndex?: number;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (val: string | null) => {
    if (val !== null) {
      const option = options.find((o) => String(o.value) === val);
      if (option) {
        setValue(option.value);
      }
    }
    inputRef.current?.blur();
  };

  const descriptions = new Map(
    options.filter((o) => o.description).map((o) => [String(o.value), o.description as string]),
  );

  // Options carrying a group name render as headed sections, in the order the
  // groups first appear; ungrouped lists stay a flat item list.
  const items = options.map((o) => ({ value: String(o.value), label: o.label }));
  const groups: { group: string; items: typeof items }[] = [];
  for (const option of options) {
    if (!option.group) continue;
    const item = { value: String(option.value), label: option.label };
    const existing = groups.find((g) => g.group === option.group);
    if (existing) existing.items.push(item);
    else groups.push({ group: option.group, items: [item] });
  }
  const data = options.length > 0 && options.every((o) => o.group) ? groups : items;

  return (
    <Group gap={CONTROL_ROW_GAP} wrap="nowrap" h={CONTROL_ROW_HEIGHT}>
      {labelComponent}
      <Select
        ref={inputRef}
        color={color}
        size="xs"
        variant="unstyled"
        style={{
          borderRadius: 2,
          border: `1px solid #666`,
          backgroundColor: "#2c2c2c",
        }}
        w={VALUE_WIDTH}
        data={data}
        value={String(value)}
        onChange={handleChange}
        scrollAreaProps={{ type: "always" }}
        maxDropdownHeight={descriptions.size > 0 ? DESCRIBED_DROPDOWN_HEIGHT : undefined}
        comboboxProps={{
          width: descriptions.size > 0 ? DESCRIBED_DROPDOWN_WIDTH : PLAIN_DROPDOWN_WIDTH,
          position: "bottom-start",
          zIndex: dropdownZIndex,
        }}
        styles={
          descriptions.size > 0
            ? {
                dropdown: { padding: 3 },
                option: { paddingBlock: 4, paddingInline: 6, borderRadius: 2 },
                groupLabel: {
                  fontSize: 9,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  paddingInline: 6,
                },
              }
            : undefined
        }
        renderOption={
          descriptions.size > 0
            ? ({ option, checked }) => (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: DESCRIBED_OPTION_COLUMNS,
                    columnGap: 6,
                    alignItems: "baseline",
                  }}
                >
                  <div style={{ alignSelf: "center", lineHeight: 0 }}>{checked && <Check size={9} />}</div>
                  <Text size="xs" style={{ lineHeight: 1.5 }}>
                    {option.label}
                  </Text>
                  <Text size="xs" c="dimmed" style={{ fontSize: 10, lineHeight: 1.5 }}>
                    {descriptions.get(option.value)}
                  </Text>
                </div>
              )
            : undefined
        }
        rightSectionWidth={12}
        rightSection={<ChevronDown size={10} color="var(--mantine-color-text)" />}
      />
    </Group>
  );
};
