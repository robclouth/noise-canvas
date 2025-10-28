import { Group, Select, Text } from "@mantine/core";
import { getTextures } from "@renderer/lib/textures";
import { getOptionsParameterDef } from "@renderer/parameters";
import { useStore } from "@renderer/store";
import type { ParameterKey } from "@renderer/store/types";
import { ChevronDown } from "lucide-react";
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
  const shape = useStore((state) => state[paramKey]);
  const shapeDef = getOptionsParameterDef(paramKey);

  const textureParamKey = `modulator${modulatorIndex}TexturePath` as ParameterKey;
  const texturePath = useStore((state) => state[textureParamKey] as string);

  const [optionGroups, setOptionGroups] = useState<
    Array<{ group: string; items: Array<{ value: string; label: string }> }>
  >([]);

  useEffect(() => {
    if (optionGroups.length === 0) {
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
    }
  }, [optionGroups.length]);

  // Get current select value
  const getCurrentValue = () => {
    if (shape === 12 && texturePath) {
      return `texture:${texturePath}`;
    }
    return String(shape);
  };

  // Handle selection change
  const handleChange = (value: string | null) => {
    if (!value) return;

    const setParameter = useStore.getState().setParameter;

    if (value.startsWith("texture:")) {
      // Texture selected
      const texturePathValue = value.replace("texture:", "");
      setParameter(paramKey, 12);
      setParameter(textureParamKey, texturePathValue);
    } else {
      // Standard shape selected
      setParameter(paramKey, parseInt(value));
      setParameter(textureParamKey, null);
    }
  };

  return (
    <Group gap={"xs"} wrap="nowrap" h={25}>
      <Tooltip label={shapeDef.description}>
        <Text
          size="xs"
          w={70}
          lineClamp={1}
          truncate="end"
          onDoubleClick={() => useStore.getState().setParameter(paramKey, shapeDef.default)}
        >
          {shapeDef.label}
        </Text>
      </Tooltip>
      <Select
        size="xs"
        variant="unstyled"
        width={190}
        data={optionGroups}
        value={getCurrentValue()}
        onChange={handleChange}
        maxDropdownHeight={400}
        scrollAreaProps={{ type: "always" }}
        rightSection={<ChevronDown size={10} color="var(--mantine-color-text)" />}
        style={{ width: 190 }}
      />
    </Group>
  );
};
