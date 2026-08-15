import { NumberInput, SimpleGrid, Stack, Text, TextInput } from "@mantine/core";
import { modals, openContextModal } from "@mantine/modals";
import { type ReactNode, type RefObject } from "react";

export { openContextModal };

type ConfirmModalParams = Parameters<typeof modals.openConfirmModal>[0];

/**
 * Makes Enter press the last button in the topmost dialog. Returns the cleanup
 * that detaches it.
 */
function attachEnterToLastButton(): () => void {
  let active = true;

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
    // Every button, so a disabled confirm blocks Enter rather than handing it
    // to whichever button happens to sit before it.
    const buttons = topDialog.querySelectorAll<HTMLButtonElement>("button");
    if (buttons.length === 0) return;
    const confirmButton = buttons[buttons.length - 1];
    e.preventDefault();
    e.stopPropagation();
    if (confirmButton.disabled) return;
    confirmButton.click();
  };

  setTimeout(() => {
    if (active) document.addEventListener("keydown", handleKeyDown, true);
  }, 50);

  return () => {
    if (!active) return;
    active = false;
    document.removeEventListener("keydown", handleKeyDown, true);
  };
}

export function openConfirmModal(params: ConfirmModalParams): string {
  const cleanup = attachEnterToLastButton();

  const id = modals.openConfirmModal({
    ...params,
    // Not cleaned up here: a confirm that rejects its input leaves the dialog
    // open, and Enter has to keep working for the next attempt.
    onConfirm: () => params.onConfirm?.(),
    onCancel: () => {
      cleanup();
      params.onCancel?.();
    },
    onClose: () => {
      cleanup();
      params.onClose?.();
    },
  });

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
  const modalId: RefObject<string> = { current: "" };

  const confirmProps = { size: "xs", color: danger ? "red" : undefined } as const;
  const isBlank = (value: string | undefined) => (value ?? "").trim().length === 0;
  const blank: RefObject<boolean> = { current: isBlank(defaultValue) };

  modalId.current = openConfirmModal({
    title,
    children: (
      <Stack gap="xs">
        {label != null && (typeof label === "string" ? <Text size="sm">{label}</Text> : label)}
        <TextInput
          ref={inputRef}
          defaultValue={defaultValue}
          placeholder={placeholder}
          onChange={(event) => {
            const nowBlank = isBlank(event.currentTarget.value);
            if (nowBlank === blank.current) return;
            blank.current = nowBlank;
            modals.updateModal({
              modalId: modalId.current,
              confirmProps: { ...confirmProps, disabled: nowBlank },
            });
          }}
          data-autofocus
        />
      </Stack>
    ),
    labels: { confirm: confirmLabel, cancel: cancelLabel },
    confirmProps: { ...confirmProps, disabled: blank.current },
    cancelProps: { size: "xs" },
    onConfirm: async () => {
      const value = inputRef.current?.value?.trim() ?? "";
      if (!value) return;
      await onConfirm(value);
    },
    onCancel,
    onClose,
  });

  return modalId.current;
}

type NewFileValues = { sampleRate: number; bpm: number; lengthBeats: number };

type OpenNewFilePromptOptions = {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  defaults?: Partial<NewFileValues>;
  onConfirm: (values: NewFileValues) => void | Promise<void>;
  onCancel?: () => void;
  onClose?: () => void;
};

export function openNewFilePrompt({
  title = "New File",
  confirmLabel = "Create",
  cancelLabel = "Cancel",
  defaults,
  onConfirm,
  onCancel,
  onClose,
}: OpenNewFilePromptOptions): string {
  const sampleRateRef: RefObject<HTMLInputElement | null> = { current: null };
  const bpmRef: RefObject<HTMLInputElement | null> = { current: null };
  const lengthRef: RefObject<HTMLInputElement | null> = { current: null };

  return openConfirmModal({
    title,
    children: (
      <SimpleGrid cols={2} spacing="sm">
        <NumberInput
          ref={sampleRateRef}
          size="xs"
          label="Sample rate"
          defaultValue={defaults?.sampleRate ?? 44100}
          min={8000}
          max={192000}
          step={1000}
          variant="unstyled"
          hideControls
          data-autofocus
        />
        <NumberInput
          ref={bpmRef}
          size="xs"
          label="BPM"
          defaultValue={defaults?.bpm ?? 120}
          min={1}
          max={999}
          step={1}
          variant="unstyled"
          hideControls
        />
        <NumberInput
          ref={lengthRef}
          size="xs"
          label="Length beats"
          defaultValue={defaults?.lengthBeats ?? 16}
          min={1}
          max={64}
          step={1}
          variant="unstyled"
          hideControls
        />
      </SimpleGrid>
    ),
    labels: { confirm: confirmLabel, cancel: cancelLabel },
    confirmProps: { size: "xs" },
    cancelProps: { size: "xs" },
    onConfirm: async () => {
      const sampleRate = parseInt(sampleRateRef.current?.value ?? "");
      const bpm = parseInt(bpmRef.current?.value ?? "");
      const lengthBeats = parseInt(lengthRef.current?.value ?? "");
      if (!Number.isFinite(sampleRate) || !Number.isFinite(bpm) || !Number.isFinite(lengthBeats)) return;
      await onConfirm({ sampleRate, bpm, lengthBeats });
    },
    onCancel,
    onClose,
  });
}

type OpenSplitPartsPromptOptions = {
  defaultParts?: number;
  onConfirm: (parts: number) => void | Promise<void>;
  onCancel?: () => void;
  onClose?: () => void;
};

export function openSplitPartsPrompt({
  defaultParts = 4,
  onConfirm,
  onCancel,
  onClose,
}: OpenSplitPartsPromptOptions): string {
  const partsRef: RefObject<HTMLInputElement | null> = { current: null };

  return openConfirmModal({
    title: "Split into parts",
    children: (
      <Stack gap="xs">
        <Text size="sm" c="dimmed">
          Factorises the spectrogram into layers that each capture a recurring sound, ordered from lowest to highest.
          The parts stay linked and add back up to this file.
        </Text>
        <NumberInput
          ref={partsRef}
          size="xs"
          label="Parts"
          defaultValue={defaultParts}
          min={2}
          max={16}
          step={1}
          data-autofocus
        />
      </Stack>
    ),
    labels: { confirm: "Split", cancel: "Cancel" },
    confirmProps: { size: "xs" },
    cancelProps: { size: "xs" },
    onConfirm: async () => {
      const parts = parseInt(partsRef.current?.value ?? "");
      if (!Number.isFinite(parts)) return;
      await onConfirm(Math.min(16, Math.max(2, parts)));
    },
    onCancel,
    onClose,
  });
}
