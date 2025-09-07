import { Flex, NumberInput, Slider, Switch, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { bpmAtom, gridSizeAtom, gridSizeYAtom, normalizeAtom, snapXAtom, snapYAtom } from "@/store";

export function ControlsPanel() {
  const [snapX, setSnapX] = useAtom(snapXAtom);
  const [snapY, setSnapY] = useAtom(snapYAtom);
  const [gridSize, setGridSize] = useAtom(gridSizeAtom);
  const [gridSizeY, setGridSizeY] = useAtom(gridSizeYAtom);
  const [normalize, setNormalize] = useAtom(normalizeAtom);
  const [bpm, setBpm] = useAtom(bpmAtom);

  const formattedGridSize = gridSize < 1 ? `1/${1 / gridSize}` : `${gridSize} beats`;
  const formattedGridSizeY = `${gridSizeY.toFixed(1)} semitones`;

  return (
    <Flex direction="column" w={256} p="xs" gap="md" c="gray.2" bg="dark.7">
      <Switch label="Snap Time" checked={snapX} onChange={(e) => setSnapX(e.currentTarget.checked)} />
      <div>
        <Text size="sm">Grid Size: {formattedGridSize}</Text>
        <Slider
          value={Math.log2(gridSize)}
          onChange={(val) => setGridSize(Math.pow(2, val))}
          min={-6}
          max={2}
          step={1}
        />
      </div>
      <Switch label="Snap Pitch" checked={snapY} onChange={(e) => setSnapY(e.currentTarget.checked)} />
      <div>
        <Text size="sm">Grid Size: {formattedGridSizeY}</Text>
        <Slider value={gridSizeY} onChange={setGridSizeY} min={0.1} max={12} step={0.1} />
      </div>
      <Switch label="Normalize Output" checked={normalize} onChange={(e) => setNormalize(e.currentTarget.checked)} />
      <NumberInput label="BPM" value={bpm} onChange={(val) => setBpm(val as number)} min={30} max={300} />
    </Flex>
  );
}
