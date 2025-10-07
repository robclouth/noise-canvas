import { Group, Select, Text } from "@mantine/core";
import { getTextures } from "@renderer/lib/textures";
import { ParameterKey, useStore } from "@renderer/store";
import { useEffect, useState } from "react";
import { Tooltip } from "../tooltip";

interface ModulatorShapeControlProps {
  paramKey: ParameterKey;
  modulatorIndex: number; // 1, 2, or 3
}

const STANDARD_SHAPES = [
  { value: "0", label: "Sine" },
  { value: "1", label: "Triangle" },
  { value: "2", label: "Square" },
  { value: "3", label: "Sawtooth" },
  { value: "4", label: "Pulse" },
  { value: "5", label: "Random" },
  { value: "6", label: "Smooth Noise" },
  { value: "7", label: "Cloud Noise" },
  { value: "8", label: "Glass Noise" },
  { value: "9", label: "Ghost Noise" },
  { value: "10", label: "Bubble Noise" },
  { value: "11", label: "Selected Scale" },
];

export const ModulatorShapeControl = ({ paramKey, modulatorIndex }: ModulatorShapeControlProps) => {
  const parameter = useStore((state) => state[paramKey]);
  const imagePath = useStore((state) => state[`modulator${modulatorIndex}ImagePath` as keyof typeof state] as string);
  const setImagePath = useStore(
    (state) => state[`setModulator${modulatorIndex}ImagePath` as keyof typeof state] as (path: string | null) => void,
  );
  const [optionGroups, setOptionGroups] = useState<
    Array<{ group: string; items: Array<{ value: string; label: string }> }>
  >([]);

  useEffect(() => {
    getTextures().then((textures) => {
      const groups: Array<{ group: string; items: Array<{ value: string; label: string }> }> = [
        { group: "Standard", items: STANDARD_SHAPES },
        {
          group: "Factory Textures",
          items: textures.factory.map((texture) => ({ value: `texture:${texture.path}`, label: texture.filename })),
        },
      ];

      // Only add user group if there are user textures
      if (textures.user.length > 0) {
        groups.push({
          group: "User",
          items: textures.user.map((texture) => ({ value: `texture:${texture.path}`, label: texture.filename })),
        });
      }

      setOptionGroups(groups);
    });
  }, []);

  // Get current select value
  const getCurrentValue = () => {
    if (parameter.value === 12 && imagePath) {
      return `texture:${imagePath}`;
    }
    return String(parameter.value);
  };

  // Handle selection change
  const handleChange = (value: string | null) => {
    if (!value || !parameter) return;

    if (value.startsWith("texture:")) {
      // Image selected
      const imagePathValue = value.replace("texture:", "");
      (parameter.setValue as (value: number) => void)(12);
      setImagePath(imagePathValue);
    } else {
      // Standard shape selected
      (parameter.setValue as (value: number) => void)(parseInt(value));
      setImagePath(null);
    }
  };

  // Safety check - don't render if parameter isn't loaded
  if (!parameter) {
    return null;
  }

  return (
    <Group gap={"xs"} wrap="nowrap" h={25}>
      <Tooltip label={parameter.description}>
        <Text size="xs" w={60} lineClamp={1} truncate="end" onDoubleClick={() => parameter.resetValue()}>
          {parameter.label}
        </Text>
      </Tooltip>
      <Select
        size="xs"
        variant="unstyled"
        flex={1}
        data={optionGroups}
        value={getCurrentValue()}
        onChange={handleChange}
        searchable
        maxDropdownHeight={400}
      />
    </Group>
  );
};
