import { Box, Button, Divider, Group, Menu, Stack, Text, useMantineTheme } from "@mantine/core";
import { getParameterDef, isEffectParameter, parameterDefs } from "@renderer/parameters";
import { getModulationParamKeys, useStore } from "@renderer/store";
import { getContextualModAmountParamKeys, getModAmountParamKeys } from "@renderer/store/modulators";
import { ParameterKey } from "@renderer/store/types";
import { Link2 } from "lucide-react";
import { useState } from "react";
import { Tooltip } from "../tooltip";
import { ParameterControl } from "./parameter-control";
import { SectionMenu } from "./section-menu";
import { SwitchControl } from "./switch-control";

type ParamMenuProps = {
  paramKey: ParameterKey;
  labelWidth?: number;
  isModulated?: boolean;
  effectId?: string;
  children?: React.ReactNode; // Not used, but accepted for flexibility
};

/**
 * ParamMenu wraps a parameter label with a click-to-open menu.
 * Shows modulation controls (if modulatable), reset, exclude from randomisation, and step linking.
 */
export const ParamMenu = ({ paramKey, labelWidth = 70, isModulated = false, effectId }: ParamMenuProps) => {
  const theme = useMantineTheme();
  const [opened, setOpened] = useState(false);
  const [hovered, setHovered] = useState(false);

  const parameter = getParameterDef(paramKey);
  const isModulatable = parameter.kind === "number" && "modulatable" in parameter && parameter.modulatable;

  const excludedFromRandomization = useStore((state) => state.excludedFromRandomization);
  const linkedParams = useStore((state) => state.slotLinkedParams[state.activeSlotIndex] ?? []);
  const setParamExcluded = useStore((state) => state.setParamExcluded);
  const setParamLinked = useStore((state) => state.setParamLinked);
  const setParameter = useStore((state) => state.setParameter);

  const isExcluded = excludedFromRandomization.includes(paramKey as string);
  const isLinked = linkedParams.includes(paramKey as string);

  const handleReset = () => {
    const useEffectScope = effectId && isEffectParameter(paramKey);
    setParameter(paramKey, parameter.default, useEffectScope ? effectId : undefined);
    const modKeys = getModulationParamKeys(paramKey);
    modKeys.forEach((modKey) => {
      const modDef = parameterDefs[modKey];
      if (modDef) {
        setParameter(modKey, modDef.default, useEffectScope ? effectId : undefined);
      }
    });
  };

  const modulatorParamKeys = isModulatable ? getModAmountParamKeys(paramKey) : undefined;
  const contextualModParamKeys = isModulatable ? getContextualModAmountParamKeys(paramKey) : undefined;

  return (
    <Menu opened={opened} onChange={setOpened} position="bottom" withArrow withinPortal={false}>
      <Tooltip label={parameter.description}>
        <Menu.Target>
          <Group
            gap={4}
            w={labelWidth}
            wrap="nowrap"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={() => setOpened(true)}
            onDoubleClick={handleReset}
            style={{ cursor: "pointer" }}
            justify="end"
          >
            {/* Chain link icon for linked params */}
            {isLinked && <Link2 size={10} style={{ flexShrink: 0, color: theme.colors.orange[5] }} />}
            {/* Blue dot for modulatable params */}
            {isModulatable && (
              <Box
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: "50%",
                  backgroundColor: theme.colors.blue[5],
                  flexShrink: 0,
                }}
              />
            )}
            {/* Label with hover brightness */}
            <Text
              size="xs"
              lineClamp={1}
              truncate="end"
              ta="right"
              c={isModulated ? "blue" : hovered || opened ? "white" : "dark.0"}
              style={{
                transition: "color 0.1s ease",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {parameter.label}
            </Text>
          </Group>
        </Menu.Target>
      </Tooltip>

      <Menu.Dropdown p={8}>
        <Stack gap={2}>
          {/* Reset button */}
          <Button onClick={handleReset} variant="subtle" color="gray" size="xs">
            Reset
          </Button>

          {/* Exclude from randomisation toggle */}
          <SwitchControl
            labelComponent={
              <Text size="xs" w={70}>
                Randomise
              </Text>
            }
            value={!isExcluded}
            setValue={(value) => setParamExcluded(paramKey, !value)}
          />

          {/* Step Linked toggle */}
          <SwitchControl
            labelComponent={
              <Text size="xs" w={70}>
                Step Linked
              </Text>
            }
            value={isLinked}
            setValue={(value) => setParamLinked(paramKey, value)}
          />

          {/* Modulation section (if applicable) */}
          {isModulatable && modulatorParamKeys && contextualModParamKeys && (
            <>
              <Group gap={4} wrap="nowrap" align="center" h={24} mt={4}>
                <Text size="xs" c="dark.1">
                  Modulation
                </Text>
                <Divider style={{ flex: 1 }} color="dark.4" />
                <SectionMenu
                  storageKey={`param-${paramKey}-mod`}
                  parameterKeys={[...modulatorParamKeys, ...contextualModParamKeys]}
                />
              </Group>
              <Stack gap={2}>
                {modulatorParamKeys.map((k) => (
                  <ParameterControl key={k} paramKey={k} labelWidth={70} color="blue" />
                ))}
                {contextualModParamKeys.map((k) => (
                  <ParameterControl key={k} paramKey={k} labelWidth={70} color="green" />
                ))}
              </Stack>
            </>
          )}
        </Stack>
      </Menu.Dropdown>
    </Menu>
  );
};


