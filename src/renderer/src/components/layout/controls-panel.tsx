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
  sourceFileAtom,
  store,
} from "@/store";
import { Divider, Flex, Select, Text } from "@mantine/core";
import { atom, useAtom, useAtomValue } from "jotai";
import { RESET } from "jotai/utils";
import { brushes } from "../brushes";
import { SelectControl } from "../controls/select-control";
import { SliderControl } from "../controls/slider-control";
import { SwitchControl } from "../controls/switch-control";
import { beatValues, pitchValues } from "@/lib/constants";

const brushIntensityPercentAtom = atom(
  (get) => get(brushIntensityAtom) * 100,
  (_get, set, newValue: number | typeof RESET) => {
    set(brushIntensityAtom, newValue === RESET ? RESET : newValue / 100);
  },
);

const Section = ({ children, label }: { children: React.ReactNode; label: string }) => {
  return (
    <Flex direction="column" gap={2}>
      <Divider my={0} label={label} labelPosition="center" />
      {children}
    </Flex>
  );
};

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
    <Flex direction="column" w={300} p="xs" gap={"md"}>
      <Section label="Analysis">
        <Select
          label="Bands per octave"
          size="xs"
          value={bandsPerOctave.toString()}
          onChange={handleAnalysisParamsChange}
          data={["12", "24", "36", "48", "60", "72", "84", "96"]}
          disabled={!activeFile}
        />
      </Section>
      <Section label="Brush">
        <SliderControl label="Width" atom={brushWidthAtom} values={[...beatValues, { label: "Full", value: 0 }]} />
        <SliderControl label="Height" atom={brushHeightAtom} values={[...pitchValues, { label: "Full", value: 0 }]} />
        <SliderControl label="Intensity" atom={brushIntensityPercentAtom} min={0} max={100} step={1} unit="%" />
        <SliderControl label="Pan" atom={panAtom} min={-1} max={1} step={0.01} />
        <Text c="dimmed" size="xs" fs={"italic"}>
          Feather
        </Text>
        <SliderControl label="Time" atom={featherXAtom} min={0} max={100} step={1} unit="%" />
        <SliderControl label="Pitch" atom={featherYAtom} min={0} max={100} step={1} unit="%" />
      </Section>
      <Section label="Source">
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
        <SliderControl
          label="Time"
          atom={offsetXAtom}
          values={[
            ...beatValues.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse(),
            { label: "0 beats", value: 0 },
            ...beatValues,
          ]}
        />
        <SliderControl label="Pitch" atom={offsetYAtom} min={-48} max={48} step={1} unit=" semis" />
        <SwitchControl label="Lock Offset" atom={offsetLockAtom} />
      </Section>
      <Section label="Grid">
        <SliderControl label="Time" atom={gridSizeAtom} values={[{ label: "Off", value: 0 }, ...beatValues]} />
        <SliderControl
          label="Pitch"
          atom={gridSizeYAtom}
          values={[
            { label: "Off", value: 0 },
            { label: "1 semi", value: 1 },
            { label: "2 semis", value: 2 },
            { label: "3 semis", value: 3 },
            { label: "4 semis", value: 4 },
            { label: "6 semis", value: 6 },
            { label: "8 semis", value: 8 },
            { label: "12 semis", value: 12 },
            { label: "16 semis", value: 16 },
            { label: "24 semis", value: 24 },
            { label: "32 semis", value: 32 },
          ]}
        />
      </Section>
      <Section label="Musical">
        <SelectControl label="Root" atom={scaleRootAtom} data={noteNames} />
        <SelectControl label="Scale" atom={scaleTypeAtom} data={scaleNames} />
      </Section>
      <Section label="Output">
        <SwitchControl label="Normalize" atom={normalizeAtom} />
      </Section>
    </Flex>
  );
}
