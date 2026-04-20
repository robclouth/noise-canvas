import { ActionIcon, Box, Divider, Group, Menu, Stack, Text, useMantineTheme } from "@mantine/core";
import { openPrompt } from "@renderer/lib/modals";
import { getParameterDef, isEffectParameter, parameterDefs } from "@renderer/parameters";
import { getMacroValueIndex, getModulationParamKeys, useStore } from "@renderer/store";
import {
  getContextualModAmountParamKeys,
  getMacroAmountParamKeys,
  getModAmountParamKeys,
} from "@renderer/store/modulators";
import { ParameterKey } from "@renderer/store/types";
import { Link2, Pencil, RotateCcw } from "lucide-react";
import React, { useState } from "react";

const EMPTY_STRING_ARRAY: readonly string[] = [];
import { Tooltip } from "../tooltip";
import { ParameterControl } from "./parameter-control";
import { SectionMenu } from "./section-menu";
import { SwitchControl } from "./switch-control";

type ParamMenuProps = {
  paramKey: ParameterKey;
  labelWidth?: number;
  isModulated?: boolean;
  effectId?: string;
  displayLabel?: string;
  children?: React.ReactNode; // Not used, but accepted for flexibility
};

/**
 * ParamMenu wraps a parameter label with a click-to-open menu.
 * Shows modulation controls (if modulatable), reset, exclude from randomisation, and step linking.
 */
export const ParamMenu = ({
  paramKey,
  labelWidth = 70,
  isModulated = false,
  effectId,
  displayLabel,
}: ParamMenuProps) => {
  const theme = useMantineTheme();
  const [opened, setOpened] = useState(false);
  const [hovered, setHovered] = useState(false);

  const parameter = getParameterDef(paramKey);
  const isModulatable = parameter.kind === "number" && "modulatable" in parameter && parameter.modulatable;
  const contextualOnly = parameter.kind === "number" && parameter.modulationSourcesAllowed === "contextualOnly";
  const macroIndex = getMacroValueIndex(paramKey);
  const isMacro = macroIndex !== null;

  const excludedFromRandomization = useStore((state) => state.excludedFromRandomization);
  const linkedParams = useStore(
    (state) => state.brushes[state.activeBrushIndex]?.linkedParams ?? (EMPTY_STRING_ARRAY as string[]),
  );
  const macroNames = useStore(
    (state) => state.brushes[state.activeBrushIndex]?.macroNames ?? (EMPTY_STRING_ARRAY as string[]),
  );
  const setParamExcluded = useStore((state) => state.setParamExcluded);
  const setParamLinked = useStore((state) => state.setParamLinked);
  const setParameter = useStore((state) => state.setParameter);
  const renameMacro = useStore((state) => state.renameMacro);

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

  const handleRenameMacro = () => {
    if (macroIndex === null) return;
    const currentName = macroNames[macroIndex] ?? `Macro ${macroIndex + 1}`;
    openPrompt({
      title: `Rename "${currentName}"`,
      label: "Enter a new name:",
      defaultValue: currentName,
      confirmLabel: "Rename",
      onConfirm: (newName) => renameMacro(macroIndex, newName),
    });
  };

  const modulatorParamKeys = isModulatable && !contextualOnly ? getModAmountParamKeys(paramKey) : undefined;
  const contextualModParamKeys = isModulatable ? getContextualModAmountParamKeys(paramKey) : undefined;
  const macroAmountParamKeys = isModulatable && !contextualOnly ? getMacroAmountParamKeys(paramKey) : undefined;

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
              {displayLabel ?? parameter.label}
            </Text>
          </Group>
        </Menu.Target>
      </Tooltip>

      <Menu.Dropdown p={8}>
        <Stack gap={2}>
          <Group gap={4} mb={2}>
            <Tooltip label="Reset to default">
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  handleReset();
                }}
              >
                <RotateCcw size={14} />
              </ActionIcon>
            </Tooltip>
            {isMacro && (
              <Tooltip label="Rename">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRenameMacro();
                  }}
                >
                  <Pencil size={14} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>

          {/* Randomise and Step Linked toggles */}
          <Group gap={8} wrap="nowrap">
            <SwitchControl
              labelComponent={
                <Text size="xs" w={70}>
                  Randomise
                </Text>
              }
              value={!isExcluded}
              setValue={(value) => setParamExcluded(paramKey, !value)}
            />
            <SwitchControl
              labelComponent={
                <Text size="xs" w={70}>
                  Step Linked
                </Text>
              }
              value={isLinked}
              setValue={(value) => setParamLinked(paramKey, value)}
            />
          </Group>

          {/* Modulation section (if applicable) */}
          {isModulatable && contextualModParamKeys && (
            <>
              <Group gap={4} wrap="nowrap" align="center" h={24} mt={4}>
                <Text size="xs" c="dark.1">
                  Modulation
                </Text>
                <Divider style={{ flex: 1 }} color="dark.4" />
                <SectionMenu
                  storageKey={`param-${paramKey}-mod`}
                  parameterKeys={[
                    ...(modulatorParamKeys ?? []),
                    ...contextualModParamKeys,
                    ...(macroAmountParamKeys ?? []),
                  ]}
                />
              </Group>
              <Box style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
                {/* Row 1-3: Modulators | Pen (omitted for contextual-only params like macros) */}
                {modulatorParamKeys?.map((k, i) => {
                  const penKeys = contextualModParamKeys.filter(
                    (ck) => ck.endsWith("ModPressure") || ck.endsWith("ModTiltX") || ck.endsWith("ModTiltY"),
                  );
                  return (
                    <React.Fragment key={k}>
                      <ParameterControl paramKey={k} labelWidth={70} color="blue" />
                      {penKeys[i] ? <ParameterControl paramKey={penKeys[i]} labelWidth={70} color="violet" /> : <div />}
                    </React.Fragment>
                  );
                })}
                {/* If contextual-only (e.g. macros), still show pen keys in their own rows */}
                {!modulatorParamKeys &&
                  contextualModParamKeys
                    .filter((ck) => ck.endsWith("ModPressure") || ck.endsWith("ModTiltX") || ck.endsWith("ModTiltY"))
                    .map((k) => (
                      <React.Fragment key={k}>
                        <ParameterControl paramKey={k} labelWidth={70} color="violet" />
                        <div />
                      </React.Fragment>
                    ))}
                {/* Row 4: Iteration | Step */}
                {contextualModParamKeys
                  .filter((k) => k.endsWith("ModIteration"))
                  .map((k) => (
                    <ParameterControl key={k} paramKey={k} labelWidth={70} color="green" />
                  ))}
                {contextualModParamKeys
                  .filter((k) => k.endsWith("ModStep"))
                  .map((k) => (
                    <ParameterControl key={k} paramKey={k} labelWidth={70} color="green" />
                  ))}
                {/* Row 5: Time Pos. | Pitch Pos. */}
                {contextualModParamKeys
                  .filter((k) => k.endsWith("ModTime"))
                  .map((k) => (
                    <ParameterControl key={k} paramKey={k} labelWidth={70} color="green" />
                  ))}
                {contextualModParamKeys
                  .filter((k) => k.endsWith("ModPitch"))
                  .map((k) => (
                    <ParameterControl key={k} paramKey={k} labelWidth={70} color="green" />
                  ))}
                {/* Row 6: Randomize | (blank placeholder so macros start on a fresh row) */}
                {contextualModParamKeys
                  .filter((k) => k.endsWith("ModRandom"))
                  .map((k) => (
                    <ParameterControl key={k} paramKey={k} labelWidth={70} color="green" />
                  ))}
                {macroAmountParamKeys && <div />}
                {/* Rows 7-8: Macro 1 | Macro 2, Macro 3 | Macro 4 */}
                {macroAmountParamKeys?.map((k, i) => (
                  <ParameterControl
                    key={k}
                    paramKey={k}
                    labelWidth={70}
                    color="red"
                    displayLabel={macroNames[i] ?? `Macro ${i + 1}`}
                  />
                ))}
              </Box>
            </>
          )}
        </Stack>
      </Menu.Dropdown>
    </Menu>
  );
};
