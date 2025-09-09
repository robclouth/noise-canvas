import {
  activeFileAtom,
  bandsPerOctaveAtom,
  brushHeightAtom,
  brushIntensityAtom,
  brushTypeAtom,
  brushWidthAtom,
  featherXAtom,
  featherYAtom,
  openFilesAtom,
  fminAtom,
  gridSizeAtom,
  gridSizeYAtom,
  normalizeAtom,
  offsetLockAtom,
  offsetXAtom,
  offsetYAtom,
  panAtom,
  scaleRootAtom,
  scaleTypeAtom,
  snapXAtom,
  snapYAtom,
  sourceFileIdAtom,
  store,
} from "@/store";
import { Flex, Switch, Divider, Select } from "@mantine/core";
import { useAtom, useAtomValue } from "jotai";
import { brushes } from "../brushes";
import { LabeledSlider } from "../controls/slider-control";

export function ControlsPanel() {
  const [snapX, setSnapX] = useAtom(snapXAtom);
  const [snapY, setSnapY] = useAtom(snapYAtom);
  const [gridSize, setGridSize] = useAtom(gridSizeAtom);
  const [gridSizeY, setGridSizeY] = useAtom(gridSizeYAtom);
  const [normalize, setNormalize] = useAtom(normalizeAtom);
  const [offsetX, setOffsetX] = useAtom(offsetXAtom);
  const [offsetY, setOffsetY] = useAtom(offsetYAtom);
  const [offsetLock, setOffsetLock] = useAtom(offsetLockAtom);
  const [brushWidth, setBrushWidth] = useAtom(brushWidthAtom);
  const [brushHeight, setBrushHeight] = useAtom(brushHeightAtom);
  const [featherX, setFeatherX] = useAtom(featherXAtom);
  const [featherY, setFeatherY] = useAtom(featherYAtom);
  const [brushIntensity, setBrushIntensity] = useAtom(brushIntensityAtom);
  const [pan, setPan] = useAtom(panAtom);
  const [scaleRoot, setScaleRoot] = useAtom(scaleRootAtom);
  const [scaleType, setScaleType] = useAtom(scaleTypeAtom);
  const [bandsPerOctave, setBandsPerOctave] = useAtom(bandsPerOctaveAtom);
  const activeFile = useAtomValue(activeFileAtom);
  const files = useAtomValue(openFilesAtom);
  const [sourceFileId, setSourceFileId] = useAtom(sourceFileIdAtom);
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
      <LabeledSlider
        label="Width"
        value={brushWidth}
        onChange={setBrushWidth}
        min={1 / 64}
        max={32}
        step={1 / 64}
        isLog
        unit=" beats"
      />
      <LabeledSlider
        label="Height"
        value={brushHeight}
        onChange={setBrushHeight}
        min={0.1}
        max={48}
        step={0.1}
        unit=" semi"
      />
      <LabeledSlider
        label="Intensity"
        value={brushIntensity * 100}
        onChange={(v) => setBrushIntensity(v / 100)}
        min={0}
        max={100}
        step={1}
        unit="%"
      />
      <LabeledSlider label="Pan" value={pan} onChange={setPan} min={-1} max={1} step={0.01} />
      <LabeledSlider label="Feather Time" value={featherX} onChange={setFeatherX} min={0} max={100} step={1} unit="%" />
      <LabeledSlider
        label="Feather Pitch"
        value={featherY}
        onChange={setFeatherY}
        min={0}
        max={100}
        step={1}
        unit="%"
      />
      <Divider my="sm" label="Source" labelPosition="center" />
      <Select
        size="xs"
        label="File"
        placeholder="Self"
        value={sourceFileId}
        onChange={setSourceFileId}
        disabled={!supportsSource}
        data={files.map((file) => ({
          value: file.id,
          label: file.filePath.split("/").pop() || file.filePath,
        }))}
        clearable
      />
      <LabeledSlider label="Time" value={offsetX} onChange={setOffsetX} min={-4} max={4} step={1 / 16} unit=" beats" />
      <LabeledSlider label="Pitch" value={offsetY} onChange={setOffsetY} min={-12} max={12} step={0.1} unit=" semi" />
      <Switch
        size="xs"
        label="Lock Offset"
        checked={offsetLock}
        onChange={(e) => setOffsetLock(e.currentTarget.checked)}
      />
      <Divider my="sm" label="Grid & Snap" labelPosition="center" />
      <Switch size="xs" label="Snap Time" checked={snapX} onChange={(e) => setSnapX(e.currentTarget.checked)} />
      <LabeledSlider
        label="Grid Time"
        value={gridSize}
        onChange={setGridSize}
        min={1 / 64}
        max={4}
        step={1 / 64}
        isLog
        logStep={1}
        unit=" beats"
      />
      <Switch size="xs" label="Snap Pitch" checked={snapY} onChange={(e) => setSnapY(e.currentTarget.checked)} />
      <LabeledSlider
        label="Grid Pitch"
        value={gridSizeY}
        onChange={setGridSizeY}
        min={0.1}
        max={12}
        step={0.1}
        unit=" semi"
      />
      <Divider my="sm" label="Musical" labelPosition="center" />
      <Select
        label="Root"
        size="xs"
        value={scaleRoot}
        onChange={(value) => setScaleRoot(value || "C")}
        data={noteNames}
      />
      <Select
        label="Scale"
        size="xs"
        value={scaleType}
        onChange={(value) => setScaleType(value || "Major")}
        data={scaleNames}
      />
      <Divider my="sm" label="Output" labelPosition="center" />
      <Switch size="xs" label="Normalize" checked={normalize} onChange={(e) => setNormalize(e.currentTarget.checked)} />
    </Flex>
  );
}
