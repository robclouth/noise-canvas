import { ActionIcon, Box, Group, Menu, UnstyledButton } from "@mantine/core";
import { helpProps, type UiControlName } from "@renderer/lib/ui-controls";
import { MoreVertical } from "lucide-react";
import { useState } from "react";

/** Marks the wrapper whose hover reveals a row's menu. */
export const LIST_ROW_HOST = "list-row-host";

/** Width of the colour bar down the left edge of a row that has one. */
const ACCENT_BAR_WIDTH = 3;

/** Row body height, held even for rows with no keycap so a list stays even. */
const BODY_HEIGHT = { normal: 22, dense: 16 };
const PAD_Y = { normal: 4, dense: 2 };

/** Total height one row occupies, for sizing a list's scroll area. */
export const LIST_ROW_HEIGHT = BODY_HEIGHT.normal + PAD_Y.normal * 2;
export const LIST_ROW_DENSE_HEIGHT = BODY_HEIGHT.dense + PAD_Y.dense * 2;

export interface ListRowProps {
  children: React.ReactNode;
  help: UiControlName;
  /** Colour of the bar down the left edge. Rows without one leave it out. */
  accent?: string;
  active?: boolean;
  outlined?: boolean;
  onClick?: () => void;
  /** Drag-and-drop blocks drag-starts on real buttons, so rows in a draggable list render as divs. */
  asDiv?: boolean;
  editing?: boolean;
  /** Tighter row, for lists inside a dropdown rather than a panel. */
  dense?: boolean;
}

/**
 * The pressable shell every list row in the app shares: hover highlight, active
 * background, and an optional colour bar. Trailing controls belong outside it,
 * positioned over the row, since a button cannot nest inside a button.
 */
export function ListRow({ children, help, accent, active, outlined, onClick, asDiv, editing, dense }: ListRowProps) {
  const size = dense ? "dense" : "normal";
  return (
    <UnstyledButton
      component={asDiv ? "div" : "button"}
      role={asDiv ? "button" : undefined}
      onClick={onClick}
      px={dense ? 8 : "xs"}
      py={PAD_Y[size]}
      className={editing ? undefined : "effect-button"}
      {...helpProps(help)}
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius: "var(--mantine-radius-sm)",
        background: active ? "var(--mantine-color-dark-6)" : undefined,
        outline: outlined ? "1px dashed var(--mantine-color-orange-5)" : undefined,
        outlineOffset: -1,
        flex: 1,
        minWidth: 0,
        textAlign: "left",
        cursor: editing ? "text" : "pointer",
      }}
    >
      {accent && (
        <Box
          style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: ACCENT_BAR_WIDTH, background: accent }}
        />
      )}
      <Group gap={6} wrap="nowrap" align="center" mih={BODY_HEIGHT[size]}>
        {children}
      </Group>
    </UnstyledButton>
  );
}

/**
 * The ⋮ menu on a list row. Hidden until the row is pointed at, and held open
 * while its own dropdown is, since a portalled dropdown takes the pointer off
 * the row it belongs to.
 */
export function ListRowMenu({ help, children }: { help: UiControlName; children: React.ReactNode }) {
  const [opened, setOpened] = useState(false);

  return (
    <Box className="list-row-menu" data-open={opened ? "true" : undefined}>
      <Menu withinPortal position="right-start" shadow="md" opened={opened} onChange={setOpened}>
        <Menu.Target>
          <ActionIcon {...helpProps(help)} size="xs" variant="subtle" color="gray" onClick={(e) => e.stopPropagation()}>
            <MoreVertical size={12} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>{children}</Menu.Dropdown>
      </Menu>
    </Box>
  );
}
