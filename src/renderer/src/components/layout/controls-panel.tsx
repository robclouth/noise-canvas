import { beatValues } from "@/lib/constants";
import {
  activeFileAtom,
  bandsPerOctaveAtom,
  brushHeightAtom,
  brushSizeLockedToGridAtom,
  brushWidthAtom,
  gridSizeAtom,
  gridSizeYAtom,
  minFreqAtom,
  normalizeAtom,
  scaleTonicAtom,
  scaleTypeAtom,
  store,
} from "@/store";
import { Flex } from "@mantine/core";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { startCase } from "lodash-es";
import { useEffect } from "react";
import { ScaleType } from "tonal";
import { SelectControl } from "../controls/select-control";
import { SliderControl } from "../controls/slider-control";
import { SwitchControl } from "../controls/switch-control";
import { Section } from "../section";

export function ControlsPanel() {
  const [bandsPerOctave, setBandsPerOctave] = useAtom(bandsPerOctaveAtom);
  const activeFile = useAtomValue(activeFileAtom);

  const brushSizeLocked = useAtomValue(brushSizeLockedToGridAtom);
  const [gridSize] = useAtom(gridSizeAtom);
  const [gridSizeY] = useAtom(gridSizeYAtom);
  const setBrushWidth = useSetAtom(brushWidthAtom);
  const setBrushHeight = useSetAtom(brushHeightAtom);

  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  useEffect(() => {
    if (brushSizeLocked) {
      setBrushWidth(gridSize);
      setBrushHeight(gridSizeY);
    }
  }, [brushSizeLocked, gridSize, gridSizeY, setBrushWidth, setBrushHeight]);

  const handleAnalysisParamsChange = (value: string | null) => {
    if (value && activeFile) {
      const newBandsPerOctave = parseInt(value, 10);
      setBandsPerOctave(newBandsPerOctave);
      const params = {
        bandsPerOctave: newBandsPerOctave,
        fmin: store.get(minFreqAtom),
      };
      window.api.reanalyzeCurrentFile(params);
    }
  };

  return (
    <Flex direction="column" w={300} p="xs">
      <Section label="Analysis">
        <SelectControl
          label="Bands/oct"
          atom={bandsPerOctaveAtom}
          data={["12", "24", "36", "48", "60", "72", "84", "96"].map((value) => ({
            value,
            label: value,
          }))}
        />
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
      <Section label="Scale">
        <SelectControl label="Root" atom={scaleTonicAtom} data={noteNames} />
        <SelectControl
          label="Scale"
          atom={scaleTypeAtom}
          data={ScaleType.all().map(({ name }) => ({
            value: name,
            label: startCase(name),
          }))}
        />
      </Section>
      <Section label="Output">
        <SwitchControl label="Normalize" atom={normalizeAtom} />
      </Section>
    </Flex>
  );
}
