import { NumberInput, SimpleGrid, Stack, Text, TextInput } from "@mantine/core";
import { modals, openContextModal } from "@mantine/modals";
import { BANDS_PER_OCTAVE_VALUES } from "@renderer/lib/constants";
import { useState, type ReactNode, type RefObject } from "react";
import { SelectControl } from "@renderer/components/controls/select-control";

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

type OpenReanalyzePromptOptions = {
  initialBandsPerOctave: number;
  onConfirm: (bandsPerOctave: number) => void | Promise<void>;
  onCancel?: () => void;
  onClose?: () => void;
};

const RESOLUTION_OPTIONS = BANDS_PER_OCTAVE_VALUES.map((o) => ({ value: String(o.value), label: o.label }));

// eslint-disable-next-line react-refresh/only-export-components
const ReanalyzeBody = ({ initial, onChange }: { initial: number; onChange: (v: number) => void }) => {
  const [value, setValue] = useState(initial);
  return (
    <SelectControl
      labelComponent={
        <Text size="xs" ta="right" c="dark.0" truncate="end" style={{ width: 70 }}>
          Resolution
        </Text>
      }
      value={String(value)}
      options={RESOLUTION_OPTIONS}
      dropdownZIndex={1001}
      setValue={(v) => {
        const n = parseInt(v);
        setValue(n);
        onChange(n);
      }}
    />
  );
};

export function openReanalyzePrompt({
  initialBandsPerOctave,
  onConfirm,
  onCancel,
  onClose,
}: OpenReanalyzePromptOptions): string {
  let chosen = initialBandsPerOctave;

  return openConfirmModal({
    title: "Re-analyze File",
    children: (
      <ReanalyzeBody
        initial={initialBandsPerOctave}
        onChange={(v) => {
          chosen = v;
        }}
      />
    ),
    labels: { confirm: "Re-analyze", cancel: "Cancel" },
    confirmProps: { size: "xs" },
    cancelProps: { size: "xs" },
    onConfirm: async () => {
      await onConfirm(chosen);
    },
    onCancel,
    onClose,
  });
}
