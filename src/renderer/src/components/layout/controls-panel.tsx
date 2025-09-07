import {
  brushHeightAtom,
  brushIntensityAtom,
  brushWidthAtom,
  featherXAtom,
  featherYAtom,
  gridSizeAtom,
  gridSizeYAtom,
  normalizeAtom,
  offsetLockAtom,
  offsetXAtom,
  offsetYAtom,
  panAtom,
  snapXAtom,
  snapYAtom,
} from "@/store";
import { Flex, Switch, Divider } from "@mantine/core";
import { useAtom } from "jotai";
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

  return (
    <Flex direction="column" w={300} p="xs" gap={0}>
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
      <Divider my="sm" label="Offset" labelPosition="center" />
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
      <Divider my="sm" label="Output" labelPosition="center" />
      <Switch size="xs" label="Normalize" checked={normalize} onChange={(e) => setNormalize(e.currentTarget.checked)} />
    </Flex>
  );
}
