import { ActionIcon, Box, Divider, Group, Menu, ScrollArea, Stack, Text, useMantineTheme } from "@mantine/core";
import { resolveBrushColor } from "@renderer/lib/colors";
import { openConfirm, openPrompt } from "@renderer/lib/modals";
import type { SectionPreset, SectionScope, SectionTarget } from "@renderer/lib/section-presets";
import { LABEL_WIDTH } from "@renderer/lib/ui-density";
import { helpProps } from "@renderer/lib/ui-controls";
import { getParameterValue, useStore } from "@renderer/store";
import { randomizeSectionParameters, resetSectionParameters } from "@renderer/store/section-actions";
import { ParameterKey } from "@renderer/store/types";
import { Copy, MoreVertical, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { randomizeEffects } from "../../lib/randomize";
import { SectionHeading } from "../section-heading";
import { Tooltip } from "../tooltip";
import { HelpActionIcon, HelpButton } from "./help-control";
import { LIST_ROW_DENSE_HEIGHT, LIST_ROW_HOST, ListRow, ListRowMenu } from "./list-row";
import { NumboxControl } from "./numbox-control";
import { SwitchControl } from "./switch-control";

/** Presets a column shows before it starts scrolling. */
const MAX_VISIBLE_PRESETS = 10;

type SectionMenuProps = {
  storageKey: string;
  parameterKeys?: ParameterKey[];
  includeEffects?: boolean;
  onRemove?: () => void;
  onCopy?: () => void;
  effectId?: string;
  /** Adds the presets column, listing the presets saved for this scope. */
  presetScope?: SectionScope;
  /** 1-based modulator a modulator-scope preset is written to. */
  modulatorIndex?: number;
};

/**
 * SectionMenu provides a trigger (three dots) and a menu for section-level actions.
 * Shows reset and randomize section controls.
 */
export const SectionMenu = ({
  storageKey,
  parameterKeys,
  includeEffects,
  onRemove,
  onCopy,
  effectId,
  presetScope,
  modulatorIndex,
}: SectionMenuProps) => {
  const [opened, setOpened] = useState(false);
  const theme = useMantineTheme();

  const setParameter = useStore((state) => state.setParameter);
  const excludedFromRandomization = useStore((state) => state.excludedFromRandomization);

  const sectionPresets = useStore((state) => state.sectionPresets);
  const applySectionPreset = useStore((state) => state.applySectionPreset);
  const saveSectionPreset = useStore((state) => state.saveSectionPreset);
  const duplicateSectionPreset = useStore((state) => state.duplicateSectionPreset);
  const renameSectionPreset = useStore((state) => state.renameSectionPreset);
  const deleteSectionPreset = useStore((state) => state.deleteSectionPreset);

  const presets = useMemo(
    () => (presetScope ? sectionPresets.filter((preset) => preset.scope === presetScope) : []),
    [sectionPresets, presetScope],
  );

  const target: SectionTarget | null = presetScope ? { scope: presetScope, effectId, modulatorIndex } : null;
  const showPresets = target !== null && parameterKeys !== undefined;

  const handleDuplicate = (preset: SectionPreset) => {
    setOpened(false);
    openPrompt({
      title: `Duplicate "${preset.name}"`,
      label: "Enter a name:",
      defaultValue: `${preset.name} copy`,
      confirmLabel: "Save",
      onConfirm: (name) => duplicateSectionPreset(preset.id, name),
    });
  };

  const handleRename = (preset: SectionPreset) => {
    setOpened(false);
    openPrompt({
      title: `Rename "${preset.name}"`,
      label: "Enter a new name:",
      defaultValue: preset.name,
      confirmLabel: "Rename",
      onConfirm: (name) => renameSectionPreset(preset.id, name),
    });
  };

  const handleDelete = (preset: SectionPreset) => {
    setOpened(false);
    openConfirm({
      title: `Delete "${preset.name}"?`,
      message: "This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => deleteSectionPreset(preset.id),
    });
  };

  const handleSaveAs = () => {
    if (!target || !parameterKeys) return;
    setOpened(false);
    openPrompt({
      title: "Save preset",
      label: "Name",
      confirmLabel: "Save",
      onConfirm: (name) => saveSectionPreset(name, target, parameterKeys),
    });
  };

  // Randomization amount for this section
  const amount = useStore((state) => state.randomizationAmounts[storageKey] ?? 100);
  const setRandomizationAmount = useStore((state) => state.setRandomizationAmount);
  const modulationEnabled = useStore((state) => (state.randomizationAmounts[`${storageKey}-mod`] ?? 0) > 0);
  const setModulationEnabled = (enabled: boolean) => setRandomizationAmount(`${storageKey}-mod`, enabled ? 100 : 0);

  const handleReset = () => {
    if (!parameterKeys) return;
    resetSectionParameters(parameterKeys, effectId, useStore.getState, setParameter);
  };

  const handleRandomize = () => {
    if (!parameterKeys || amount <= 0) return;

    randomizeSectionParameters(
      parameterKeys,
      effectId,
      { amount, modulationEnabled, excluded: excludedFromRandomization },
      useStore.getState,
      setParameter,
    );

    // Randomize effects if enabled
    if (includeEffects) {
      const state = useStore.getState();
      const currentEffects = getParameterValue(state, "effects") as {
        id: string;
        effect: string;
        enabled: boolean;
        params: Record<string, unknown>;
      }[];
      const newEffects = randomizeEffects(currentEffects, amount);
      setParameter("effects" as ParameterKey, newEffects);
    }
  };

  return (
    <Menu opened={opened} onChange={setOpened} position="right-start" withArrow>
      <Menu.Target>
        <ActionIcon
          onClick={(e) => {
            e.stopPropagation();
            setOpened(true);
          }}
          variant="transparent"
          color="gray.5"
          size="xs"
          {...helpProps("section-menu")}
        >
          <MoreVertical size={14} />
        </ActionIcon>
      </Menu.Target>

      <Menu.Dropdown p={8}>
        <Group gap={8} align="stretch" wrap="nowrap">
          <Stack gap={2} flex={1}>
            {/* Action icons row */}
            <Group gap={4} justify="space-between" mb={2}>
              <Group gap={4}>
                {onCopy && (
                  <HelpActionIcon
                    help="effect-duplicate"
                    variant="subtle"
                    color="gray"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpened(false);
                      onCopy();
                    }}
                  >
                    <Copy size={14} />
                  </HelpActionIcon>
                )}
                <HelpActionIcon
                  help="effect-reset"
                  variant="subtle"
                  color="gray"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleReset();
                  }}
                >
                  <RotateCcw size={14} />
                </HelpActionIcon>
              </Group>
              {onRemove && (
                <HelpActionIcon
                  help="effect-remove"
                  variant="subtle"
                  color="red"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpened(false);
                    onRemove();
                  }}
                >
                  <Trash2 size={14} />
                </HelpActionIcon>
              )}
            </Group>

            {/* Randomize section */}
            {parameterKeys && (
              <>
                <SectionHeading label="Randomise" />
                <NumboxControl
                  labelComponent={
                    <Text size="xs" w={LABEL_WIDTH}>
                      Amount
                    </Text>
                  }
                  value={amount}
                  setValue={(val) => setRandomizationAmount(storageKey, val)}
                  min={0}
                  max={100}
                  step={1}
                  unit="%"
                  toNormalized={(val) => val / 100}
                  fromNormalized={(val) => val * 100}
                />
                <SwitchControl
                  labelComponent={
                    <Text size="xs" w={LABEL_WIDTH}>
                      Include Mod.
                    </Text>
                  }
                  value={modulationEnabled}
                  setValue={setModulationEnabled}
                />
                <HelpButton
                  help="section-randomize"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRandomize();
                  }}
                  variant="subtle"
                  color="gray"
                  size="xs"
                  mt={4}
                >
                  Randomise
                </HelpButton>
              </>
            )}
          </Stack>

          {showPresets && (
            <>
              <Divider orientation="vertical" />
              <Stack gap={2} w={112}>
                <SectionHeading
                  label="Presets"
                  trailing={
                    <HelpActionIcon
                      help="section-save-preset"
                      size="xs"
                      variant="subtle"
                      color="gray"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSaveAs();
                      }}
                    >
                      <Plus size={12} />
                    </HelpActionIcon>
                  }
                />
                <ScrollArea.Autosize mah={LIST_ROW_DENSE_HEIGHT * MAX_VISIBLE_PRESETS} scrollbarSize={4} type="auto">
                  <Stack gap={0}>
                    {presets.map((preset) => (
                      <Tooltip
                        key={preset.id}
                        label={preset.description}
                        disabled={!preset.description}
                        position="right"
                      >
                        <Group
                          className={LIST_ROW_HOST}
                          gap={0}
                          wrap="nowrap"
                          align="center"
                          style={{ position: "relative" }}
                        >
                          <ListRow
                            help="section-preset"
                            dense
                            accent={resolveBrushColor(preset.color, theme)}
                            onClick={() => {
                              setOpened(false);
                              applySectionPreset(preset.id, target, parameterKeys);
                            }}
                          >
                            <Text size="xs" truncate style={{ flex: 1, minWidth: 0 }}>
                              {preset.name}
                            </Text>
                          </ListRow>
                          <Box style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)" }}>
                            <ListRowMenu help="preset-menu">
                              <Menu.Item onClick={() => handleDuplicate(preset)}>Duplicate…</Menu.Item>
                              {!preset.isFactory && (
                                <>
                                  <Menu.Item onClick={() => handleRename(preset)}>Rename…</Menu.Item>
                                  <Menu.Divider />
                                  <Menu.Item color="red" onClick={() => handleDelete(preset)}>
                                    Delete…
                                  </Menu.Item>
                                </>
                              )}
                            </ListRowMenu>
                          </Box>
                        </Group>
                      </Tooltip>
                    ))}
                  </Stack>
                </ScrollArea.Autosize>
              </Stack>
            </>
          )}
        </Group>
      </Menu.Dropdown>
    </Menu>
  );
};
