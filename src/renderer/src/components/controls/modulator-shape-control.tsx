import { Group, Select, Text } from "@mantine/core";
import { PATTERN_SHAPES } from "@renderer/lib/constants";
import { CONTROL_ROW_GAP, CONTROL_ROW_HEIGHT, LABEL_WIDTH, VALUE_WIDTH } from "@renderer/lib/ui-density";
import { getTextures } from "@renderer/lib/textures";
import { getOptionsParameterDef } from "@renderer/parameters";
import { selectParameter, useStore } from "@renderer/store";
import type { ParameterKey } from "@renderer/store/types";
import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Tooltip } from "../tooltip";

interface ModulatorShapeControlProps {
  paramKey: ParameterKey;
  modulatorIndex: number; // 1, 2, or 3
}

export const ModulatorShapeControl = ({ paramKey, modulatorIndex }: ModulatorShapeControlProps) => {
  const shape = useStore(selectParameter(paramKey));
  const shapeDef = getOptionsParameterDef(paramKey);
  const inputRef = useRef<HTMLInputElement>(null);

  const textureParamKey = `modulator${modulatorIndex}TexturePath` as ParameterKey;
  const texturePath = useStore(selectParameter(textureParamKey));

  const [optionGroups, setOptionGroups] = useState<
    Array<{ group: string; items: Array<{ value: string; label: string }> }>
  >([]);

  useEffect(() => {
    if (optionGroups.length === 0) {
      getTextures().then((textures) => {
        const groups: Array<{ group: string; items: Array<{ value: string; label: string }> }> = [
          { group: "Standard", items: PATTERN_SHAPES.map(({ value, label }) => ({ label, value: value.toString() })) },
          {
            group: "Factory Textures",
            items: textures.factory.map((texture) => ({ value: `texture:${texture.path}`, label: texture.filename })),
          },
        ];

        // Only add user group if there are user textures
        if (textures.user.length > 0) {
          groups.push({
            group: "User Textures",
            items: textures.user.map((texture) => ({ value: `texture:${texture.path}`, label: texture.filename })),
          });
        }

        setOptionGroups(groups);
      });
    }
  }, [optionGroups.length]);

  // Get current select value - memoized to ensure proper reactivity
  const currentValue = useMemo(() => {
    if (shape === 12 && texturePath) {
      return `texture:${texturePath}`;
    }
    return String(shape);
  }, [shape, texturePath]);

  const handleChange = (value: string | null) => {
    if (value) {
      const setParameter = useStore.getState().setParameter;
      if (value.startsWith("texture:")) {
        const texturePathValue = value.replace("texture:", "");
        setParameter(paramKey, 12);
        setParameter(textureParamKey, texturePathValue);
      } else {
        setParameter(paramKey, parseInt(value));
        setParameter(textureParamKey, null);
      }
    }
    inputRef.current?.blur();
  };

  return (
    <Group gap={CONTROL_ROW_GAP} wrap="nowrap" h={CONTROL_ROW_HEIGHT}>
      <Tooltip label={shapeDef.description}>
        <Text
          size="xs"
          w={LABEL_WIDTH}
          lineClamp={1}
          truncate="end"
          ta="right"
          onDoubleClick={() => useStore.getState().setParameter(paramKey, shapeDef.default)}
        >
          {shapeDef.label}
        </Text>
      </Tooltip>
      <Select
        ref={inputRef}
        size="xs"
        variant="unstyled"
        style={{ width: VALUE_WIDTH, borderRadius: 2, border: `1px solid #666`, backgroundColor: "#2c2c2c" }}
        data={optionGroups}
        value={currentValue}
        onChange={handleChange}
        maxDropdownHeight={400}
        comboboxProps={{ width: 120 }}
        scrollAreaProps={{ type: "always" }}
        rightSectionWidth={12}
        rightSection={<ChevronDown size={10} color="var(--mantine-color-text)" />}
      />
    </Group>
  );
};
