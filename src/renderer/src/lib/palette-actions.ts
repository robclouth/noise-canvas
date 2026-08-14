import { modals } from "@mantine/modals";

export function openPalettePicker() {
  modals.openContextModal({ modal: "palettePicker", title: "Open palette", innerProps: {} });
}
