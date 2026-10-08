import { getParameterDef } from "@renderer/parameters";
import type { GenerateInput } from "../components/generate-fields";
import type { AspectId } from "../lib/image-export";
import type { ColormapId } from "../lib/image-export-colormaps";
import type { LengthUnit } from "../lib/length-values";

/** The settings the app's dialogs keep from one opening to the next. */
export interface DialogSettings {
  newFileSampleRate: number;
  newFileBpm: number;
  newFileLengthBeats: number;
  splitParts: number;
  silenceUnit: LengthUnit;
  silenceBeats: number;
  silenceSeconds: number;
  fileLengthUnit: LengthUnit;
  fileLengthBeats: number;
  fileLengthSeconds: number;
  generatePrompt: string;
  generateStrength: number;
  generateInput: GenerateInput;
  imageExportColour: ColormapId;
  imageExportShape: AspectId;
  imageExportSize: number;
  imageExportPoster: boolean;
}

export const createDialogSettingsSlice = (): DialogSettings => ({
  newFileSampleRate: getParameterDef("newFileSampleRate").default,
  newFileBpm: getParameterDef("newFileBpm").default,
  newFileLengthBeats: getParameterDef("newFileLengthBeats").default,
  splitParts: getParameterDef("splitParts").default,
  silenceUnit: getParameterDef("silenceUnit").default,
  silenceBeats: getParameterDef("silenceBeats").default,
  silenceSeconds: getParameterDef("silenceSeconds").default,
  fileLengthUnit: getParameterDef("fileLengthUnit").default,
  fileLengthBeats: getParameterDef("fileLengthBeats").default,
  fileLengthSeconds: getParameterDef("fileLengthSeconds").default,
  generatePrompt: getParameterDef("generatePrompt").default,
  generateStrength: getParameterDef("generateStrength").default,
  generateInput: getParameterDef("generateInput").default,
  imageExportColour: getParameterDef("imageExportColour").default,
  imageExportShape: getParameterDef("imageExportShape").default,
  imageExportSize: getParameterDef("imageExportSize").default,
  imageExportPoster: getParameterDef("imageExportPoster").default,
});
