import { Stack, Textarea } from "@mantine/core";
import { useStore } from "@renderer/store";
import { DialogControls } from "./dialog-controls";

/** What the model hears: every band, or only the selection's. */
export type GenerateInput = "full-mix" | "selection";

/** What the Generate dialog collects. `strength` runs from 0 to 1. */
export type GenerateSettings = { prompt: string; strength: number; input: GenerateInput };

/** The body of the Generate dialog, kept in the Generate parameters. */
export const GenerateFields = ({ bandLimited }: { bandLimited: boolean }) => {
  const prompt = useStore((state) => state.generatePrompt);

  return (
    <Stack gap="sm">
      <Textarea
        label="Prompt"
        placeholder="warm analogue synth pad, slow attack"
        size="xs"
        autosize
        minRows={2}
        maxRows={5}
        data-autofocus
        value={prompt}
        onChange={(event) => useStore.getState().setParameter("generatePrompt", event.currentTarget.value)}
      />
      <DialogControls keys={bandLimited ? ["generateStrength", "generateInput"] : ["generateStrength"]} />
    </Stack>
  );
};
