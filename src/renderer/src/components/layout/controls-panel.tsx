import { gridSizeAtom, gridSizeYAtom, normalizeAtom, snapXAtom, snapYAtom } from "@/store";
import { Flex, Switch } from "@mantine/core";
import { useAtom } from "jotai";
import { LabeledSlider } from "../controls/slider-control";

export function ControlsPanel() {
  const [snapX, setSnapX] = useAtom(snapXAtom);
  const [snapY, setSnapY] = useAtom(snapYAtom);
  const [gridSize, setGridSize] = useAtom(gridSizeAtom);
  const [gridSizeY, setGridSizeY] = useAtom(gridSizeYAtom);
  const [normalize, setNormalize] = useAtom(normalizeAtom);

  return (
    <Flex direction="column" w={300} p="xs" gap="xs">
      <Switch size="xs" label="Normalize" checked={normalize} onChange={(e) => setNormalize(e.currentTarget.checked)} />
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
    </Flex>
  );
}
