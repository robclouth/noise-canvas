import { useStore } from "@renderer/store";

// UI dimension knobs for the density system. Each value resolves to a CSS variable
// whose concrete size is defined per density in assets/main.css (:root = normal "md",
// [data-ui-size="sm"] = compact). Switching density flips the attribute; nothing here
// or at the call sites needs to branch. See store/app.ts `uiSize`.

// Current density as a Mantine size token, for components whose `size` prop should
// track density (e.g. ActionIcon, Button). Custom dimensions use the CSS vars below.
export const useUiSize = () => useStore((state) => state.uiSize);

// Height of a standard control row (label + control + value).
export const CONTROL_ROW_HEIGHT = "var(--ui-row-h)";

// Height of the value/toggle boxes (numbox, switch) that align in the right column.
export const WIDGET_HEIGHT = "var(--ui-widget-h)";

// Height of inline editable inputs nested inside widgets.
export const WIDGET_INPUT_HEIGHT = "var(--ui-widget-input-h)";

// Height of standalone text inputs (rename fields, sidebar inputs).
export const INPUT_HEIGHT = "var(--ui-input-h)";

// Width of the parameter label column (left side of a control row).
export const LABEL_WIDTH = "var(--ui-label-w)";

// Width of the value/control widgets in the right column.
export const VALUE_WIDTH = "var(--ui-value-w)";

// Horizontal gap between the label, control, and value columns within a control row.
export const CONTROL_ROW_GAP = "var(--ui-row-gap)";

// Width of the left brush panel.
export const BRUSH_PANEL_WIDTH = "var(--ui-panel-w)";

// Horizontal gap between the two control columns in the panel grids.
export const PANEL_COLUMN_SPACING = "var(--ui-col-spacing)";

// Vertical padding around each draggable effect in the effects list.
export const EFFECT_ITEM_PAD_Y = "var(--ui-effect-pad-y)";

// Padding and filename font size for the file header bar.
export const FILE_HEADER_PAD = "var(--ui-header-pad)";
export const FILE_HEADER_FONT = "var(--ui-header-font)";

// Bottom transport bar dimensions.
export const TRANSPORT_PAD = "var(--ui-transport-pad)";
export const TRANSPORT_GAP = "var(--ui-transport-gap)";
export const TRANSPORT_LABEL_WIDTH = "var(--ui-transport-label-w)";
export const TRANSPORT_TIME_WIDTH = "var(--ui-transport-time-w)";
