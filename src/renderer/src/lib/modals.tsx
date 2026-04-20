import { Stack, Text, TextInput } from "@mantine/core";
import { modals, openContextModal } from "@mantine/modals";
import type { ReactNode, RefObject } from "react";

export { openContextModal };

type ConfirmModalParams = Parameters<typeof modals.openConfirmModal>[0];

export function openConfirmModal(params: ConfirmModalParams): string {
  let active = true;

  const cleanup = () => {
    if (!active) return;
    active = false;
    document.removeEventListener("keydown", handleKeyDown, true);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!active) return;
    if (e.key !== "Enter") return;
    if (e.isComposing) return;
    const target = e.target as HTMLElement | null;
    if (target?.tagName === "TEXTAREA") return;
    if (target?.isContentEditable) return;

    const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
    if (dialogs.length === 0) return;
    const topDialog = dialogs[dialogs.length - 1];
    const buttons = topDialog.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
    if (buttons.length === 0) return;
    const confirmButton = buttons[buttons.length - 1];
    e.preventDefault();
    e.stopPropagation();
    confirmButton.click();
  };

  const id = modals.openConfirmModal({
    ...params,
    onConfirm: () => {
      cleanup();
      params.onConfirm?.();
    },
    onCancel: () => {
      cleanup();
      params.onCancel?.();
    },
    onClose: () => {
      cleanup();
      params.onClose?.();
    },
  });

  setTimeout(() => {
    if (active) document.addEventListener("keydown", handleKeyDown, true);
  }, 50);

  return id;
}

type OpenConfirmOptions = {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void;
  onClose?: () => void;
};

export function openConfirm({
  title,
  message,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
  onClose,
}: OpenConfirmOptions): string {
  const children = typeof message === "string" ? <Text size="sm">{message}</Text> : message;
  return openConfirmModal({
    title,
    children,
    labels: { confirm: confirmLabel, cancel: cancelLabel },
    confirmProps: { size: "xs", color: danger ? "red" : undefined },
    cancelProps: { size: "xs" },
    onConfirm,
    onCancel,
    onClose,
  });
}

type OpenPromptOptions = {
  title: string;
  label?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: (value: string) => void | Promise<void>;
  onCancel?: () => void;
  onClose?: () => void;
};

export function openPrompt({
  title,
  label,
  defaultValue,
  placeholder,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
  onClose,
}: OpenPromptOptions): string {
  const inputRef: RefObject<HTMLInputElement | null> = { current: null };
  return openConfirmModal({
    title,
    children: (
      <Stack gap="xs">
        {label != null && (typeof label === "string" ? <Text size="sm">{label}</Text> : label)}
        <TextInput ref={inputRef} defaultValue={defaultValue} placeholder={placeholder} data-autofocus />
      </Stack>
    ),
    labels: { confirm: confirmLabel, cancel: cancelLabel },
    confirmProps: { size: "xs", color: danger ? "red" : undefined },
    cancelProps: { size: "xs" },
    onConfirm: async () => {
      const value = inputRef.current?.value?.trim() ?? "";
      if (!value) return;
      await onConfirm(value);
    },
    onCancel,
    onClose,
  });
}
