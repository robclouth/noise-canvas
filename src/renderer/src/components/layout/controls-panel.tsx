import {
  activeFileAtom,
  bandsPerOctaveAtom,
  brushHeightAtom,
  brushIntensityAtom,
  brushTypeAtom,
  brushWidthAtom,
  featherXAtom,
  featherYAtom,
  fminAtom,
  gridSizeAtom,
  gridSizeYAtom,
  normalizeAtom,
  offsetLockAtom,
  offsetXAtom,
  offsetYAtom,
  openFilesAtom,
  panAtom,
  scaleRootAtom,
  scaleTypeAtom,
  snapXAtom,
  snapYAtom,
  sourceFileAtom,
  store,
} from "@/store";
import { Divider, Flex, Select } from "@mantine/core";
import { atom, useAtom, useAtomValue } from "jotai";
import { RESET } from "jotai/utils";
import { brushes } from "../brushes";
import { SelectControl } from "../controls/select-control";
import { SliderControl } from "../controls/slider-control";
import { SwitchControl } from "../controls/switch-control";

const brushIntensityPercentAtom = atom(
  (get) => get(brushIntensityAtom) * 100,
  (_get, set, newValue: number | typeof RESET) => {
    set(brushIntensityAtom, newValue === RESET ? RESET : newValue / 100);
  },
);

export function ControlsPanel() {
  const [bandsPerOctave, setBandsPerOctave] = useAtom(bandsPerOctaveAtom);
  const activeFile = useAtomValue(activeFileAtom);
  const files = useAtomValue(openFilesAtom);
  const [sourceFile, setSourceFile] = useAtom(sourceFileAtom);
  const brushType = useAtomValue(brushTypeAtom);

  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const scaleNames = ["Major", "Minor", "Pentatonic Major", "Pentatonic Minor", "Blues"];

  const brush = brushes[brushType];
  const supportsSource = brush && "sourceTexture" in brush.material.uniforms;

  const handleAnalysisParamsChange = (value: string | null) => {
    if (value && activeFile) {
      const newBandsPerOctave = parseInt(value, 10);
      setBandsPerOctave(newBandsPerOctave);
      const params = {
        bandsPerOctave: newBandsPerOctave,
        fmin: store.get(fminAtom),
      };
      window.api.reanalyzeCurrentFile(params);
    }
  };

  return (
    <Flex direction="column" w={300} p="xs" gap="xs">
      <Divider my="sm" label="Analysis" labelPosition="center" />
      <Select
        label="Bands per octave"
        size="xs"
        value={bandsPerOctave.toString()}
        onChange={handleAnalysisParamsChange}
        data={["12", "24", "36", "48", "60", "72", "84", "96"]}
        disabled={!activeFile}
      />
      <Divider my="sm" label="Brush" labelPosition="center" />
      <SliderControl label="Width" atom={brushWidthAtom} min={1 / 64} max={32} step={1 / 64} isLog unit=" beats" />
      <SliderControl label="Height" atom={brushHeightAtom} min={0.1} max={48} step={0.1} unit=" semi" />
      <SliderControl label="Intensity" atom={brushIntensityPercentAtom} min={0} max={100} step={1} unit="%" />
      <SliderControl label="Pan" atom={panAtom} min={-1} max={1} step={0.01} />
      <SliderControl label="Feather Time" atom={featherXAtom} min={0} max={100} step={1} unit="%" />
      <SliderControl label="Feather Pitch" atom={featherYAtom} min={0} max={100} step={1} unit="%" />
      <Divider my="sm" label="Source" labelPosition="center" />
      <Select
        size="xs"
        label="File"
        placeholder="Self"
        value={sourceFile?.filePath}
        onChange={(value) => setSourceFile(value ? files[value] : null)}
        disabled={!supportsSource}
        data={Object.values(files).map((file) => ({
          value: file.filePath,
          label: file.filePath.split("/").pop() || file.filePath,
        }))}
        clearable
      />
      <SliderControl label="Time" atom={offsetXAtom} min={-4} max={4} step={1 / 16} unit=" beats" />
      <SliderControl label="Pitch" atom={offsetYAtom} min={-12} max={12} step={0.1} unit=" semi" />
      <SwitchControl label="Lock Offset" atom={offsetLockAtom} />
      <Divider my="sm" label="Grid & Snap" labelPosition="center" />
      <SwitchControl label="Snap Time" atom={snapXAtom} />
      <SliderControl
        label="Grid Time"
        atom={gridSizeAtom}
        min={1 / 64}
        max={4}
        step={1 / 64}
        isLog
        logStep={1}
        unit=" beats"
      />
      <SwitchControl label="Snap Pitch" atom={snapYAtom} />
      <SliderControl label="Grid Pitch" atom={gridSizeYAtom} min={0.1} max={12} step={0.1} unit=" semi" />
      <Divider my="sm" label="Musical" labelPosition="center" />
      <SelectControl label="Root" atom={scaleRootAtom} data={noteNames} />
      <SelectControl label="Scale" atom={scaleTypeAtom} data={scaleNames} />
      <Divider my="sm" label="Output" labelPosition="center" />
      <SwitchControl label="Normalize" atom={normalizeAtom} />
    </Flex>
  );
}
