import { Stack, Text, TextInput, type ModalProps } from "@mantine/core";
import { modals, openContextModal } from "@mantine/modals";
import { type ReactNode, type RefObject } from "react";
import { PickFilesFields, type PickFileOption } from "../components/pick-files-fields";
import type { ParameterDialogBody, ParameterDialogProps } from "../components/parameter-dialog";
import { UI_LAYERS } from "./ui-layers";

export { openContextModal };

/**
 * The frame every dialog shares. Mantine's own modal defaults are set for a
 * page-sized type scale rather than this interface's, so the title and body
 * sizes are pinned here and applied both to the context modals, through
 * ModalsProvider, and to the few dialogs that render `<Modal>` themselves.
 */
export const APP_MODAL_PROPS: Partial<ModalProps> = {
  zIndex: UI_LAYERS.modal,
  size: "xs",
  shadow: "xl",
  styles: {
    title: { fontSize: 14, fontWeight: 600 },
    body: { fontSize: "var(--mantine-font-size-sm)" },
  },
};

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

/** What a dialog that keeps its values in parameters calls back with; the caller reads the values from the store. */
type ParameterPromptOptions = {
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
  onClose?: () => void;
};

function openParameterDialog(
  title: string,
  size: "sm" | "md",
  body: ParameterDialogBody,
  confirmLabel: string,
  { onConfirm, onCancel, onClose }: ParameterPromptOptions,
): string {
  const cleanup = attachEnterToLastButton();
  let confirmed = false;
  const innerProps: ParameterDialogProps = {
    body,
    confirmLabel,
    onConfirm: () => {
      confirmed = true;
      return onConfirm();
    },
  };
  return openContextModal({
    modal: "parameterDialog",
    title,
    size,
    innerProps,
    onClose: () => {
      cleanup();
      if (!confirmed) onCancel?.();
      onClose?.();
    },
  });
}

/** Opens New File, kept in the `newFile*` parameters. */
export function openNewFilePrompt(options: ParameterPromptOptions): string {
  return openParameterDialog("New File", "sm", { kind: "newFile" }, "Create", options);
}

/** Opens Split into Parts, kept in `splitParts`. */
export function openSplitPartsPrompt(options: ParameterPromptOptions): string {
  return openParameterDialog("Split into parts", "sm", { kind: "splitParts" }, "Split", options);
}

/** Opens Insert Silence, kept in the `silence*` parameters. */
export function openInsertSilencePrompt({ bpm, ...options }: ParameterPromptOptions & { bpm: number }): string {
  return openParameterDialog("Insert Silence", "sm", { kind: "insertSilence", bpm }, "Insert", options);
}

/** Opens Set Length, kept in the `fileLength*` parameters. */
export function openSetLengthPrompt({ bpm, ...options }: ParameterPromptOptions & { bpm: number }): string {
  return openParameterDialog("Set Length", "sm", { kind: "setLength", bpm }, "Set", options);
}

/** Opens Generate, kept in the `generate*` parameters. */
export function openGeneratePrompt({
  hasSelection,
  bandLimited,
  ...options
}: ParameterPromptOptions & {
  /** True when a selection exists, so the result lands in it rather than over the whole file. */
  hasSelection: boolean;
  /** True when the selection leaves some bands out, which offers the Input choice. */
  bandLimited: boolean;
}): string {
  return openParameterDialog("Generate", "md", { kind: "generate", hasSelection, bandLimited }, "Generate", options);
}

type OpenAddFilesAsLayersPromptOptions = {
  options: PickFileOption[];
  /** Files ticked when the dialog opens. */
  initial: string[];
  onConfirm: (fileIds: string[]) => void | Promise<void>;
  onCancel?: () => void;
  onClose?: () => void;
};

export function openAddFilesAsLayersPrompt({
  options,
  initial,
  onConfirm,
  onCancel,
  onClose,
}: OpenAddFilesAsLayersPromptOptions): string {
  const selection: RefObject<string[]> = { current: initial };
  const modalId: RefObject<string> = { current: "" };
  // Nothing ticked has nothing to add, so the button says so rather than
  // swallowing a click.
  const tooFew: RefObject<boolean> = { current: initial.length === 0 };
  const confirmProps = { size: "xs" } as const;

  modalId.current = openConfirmModal({
    title: "Add Files as Layers",
    size: "sm",
    children: (
      <Stack gap="xs">
        <Text size="sm" c="dimmed">
          Copies the files you pick into this file as layers. The files themselves stay as they are.
        </Text>
        <PickFilesFields
          options={options}
          selection={selection}
          onChange={(picked) => {
            const nowTooFew = picked.length === 0;
            if (nowTooFew === tooFew.current) return;
            tooFew.current = nowTooFew;
            modals.updateModal({
              modalId: modalId.current,
              confirmProps: { ...confirmProps, disabled: nowTooFew },
            });
          }}
        />
      </Stack>
    ),
    labels: { confirm: "Add", cancel: "Cancel" },
    confirmProps: { ...confirmProps, disabled: tooFew.current },
    cancelProps: { size: "xs" },
    onConfirm: async () => {
      if (selection.current.length === 0) return;
      await onConfirm(selection.current);
    },
    onCancel,
    onClose,
  });

  return modalId.current;
}
