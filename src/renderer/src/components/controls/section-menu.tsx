import { ActionIcon, Button, Divider, Group, Menu, Stack, Text } from "@mantine/core";
import { isEffectParameter, parameterDefs } from "@renderer/parameters";
import { getEffectParameterValue, getModulationParamKeys, getParameterValue, useStore } from "@renderer/store";
import { ParameterKey } from "@renderer/store/types";
import { Copy, MoreVertical, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Tooltip } from "../tooltip";
import {
  randomizeBooleanParameter,
  randomizeEffects,
  randomizeNumberParameter,
  randomizeOptionsParameter,
} from "../../lib/randomize";
import { NumboxControl } from "./numbox-control";
import { SwitchControl } from "./switch-control";

type SectionMenuProps = {
  storageKey: string;
  parameterKeys?: ParameterKey[];
  includeEffects?: boolean;
  onRemove?: () => void;
  onCopy?: () => void;
  effectId?: string;
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
}: SectionMenuProps) => {
  const [opened, setOpened] = useState(false);

  const setParameter = useStore((state) => state.setParameter);
  const excludedFromRandomization = useStore((state) => state.excludedFromRandomization);

  // Randomization amount for this section
  const amount = useStore((state) => state.randomizationAmounts[storageKey] ?? 100);
  const setRandomizationAmount = useStore((state) => state.setRandomizationAmount);
  const modulationEnabled = useStore((state) => (state.randomizationAmounts[`${storageKey}-mod`] ?? 0) > 0);
  const setModulationEnabled = (enabled: boolean) => setRandomizationAmount(`${storageKey}-mod`, enabled ? 100 : 0);

  const handleReset = () => {
    if (!parameterKeys) return;
    parameterKeys.forEach((key) => {
      const def = parameterDefs[key];
      if (def) {
        const useEffectScope = effectId && isEffectParameter(key);
        setParameter(key, def.default, useEffectScope ? effectId : undefined);
        // Also reset modulation amounts for modulatable params
        if (def.kind === "number" && def.modulatable) {
          const modKeys = getModulationParamKeys(key);
          modKeys.forEach((modKey) => {
            const modDef = parameterDefs[modKey];
            if (modDef) {
              setParameter(modKey, modDef.default, useEffectScope ? effectId : undefined);
            }
          });
        }
      }
    });
  };

  const handleRandomize = () => {
    if (!parameterKeys || amount <= 0) return;

    parameterKeys.forEach((key) => {
      // Skip excluded params
      if (excludedFromRandomization.includes(key as string)) return;

      const def = parameterDefs[key];
      if (!def) return;

      const state = useStore.getState();
      const useEffectScope = effectId && isEffectParameter(key);
      const currentValue = useEffectScope
        ? getEffectParameterValue(state, effectId, key)
        : getParameterValue(state, key);

      let newValue: unknown;
      switch (def.kind) {
        case "number":
          newValue = randomizeNumberParameter(currentValue as number, def.min, def.max, amount);
          break;
        case "options":
          newValue = randomizeOptionsParameter(
            currentValue,
            def.options.map((o: { value: unknown }) => o.value),
            amount,
          );
          break;
        case "boolean":
          newValue = randomizeBooleanParameter(currentValue as boolean, amount);
          break;
        default:
          return;
      }

      setParameter(key, newValue, useEffectScope ? effectId : undefined);

      // Also randomize modulation amounts if enabled and parameter is modulatable
      if (modulationEnabled && def.kind === "number" && def.modulatable) {
        const modKeys = getModulationParamKeys(key);
        modKeys.forEach((modKey) => {
          const modDef = parameterDefs[modKey];
          if (modDef && modDef.kind === "number") {
            const newModValue = randomizeNumberParameter(0, modDef.min, modDef.max, amount);
            setParameter(modKey, newModValue, useEffectScope ? effectId : undefined);
          }
        });
      }
    });

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
        >
          <MoreVertical size={14} />
        </ActionIcon>
      </Menu.Target>

      <Menu.Dropdown p={8}>
        <Stack gap={2}>
          {/* Action icons row */}
          <Group gap={4} justify="space-between" mb={2}>
            <Group gap={4}>
              {onCopy && (
                <Tooltip label="Duplicate">
                  <ActionIcon
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
                  </ActionIcon>
                </Tooltip>
              )}
              <Tooltip label="Reset to defaults">
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
            </Group>
            {onRemove && (
              <Tooltip label="Remove">
                <ActionIcon
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
                </ActionIcon>
              </Tooltip>
            )}
          </Group>

          {/* Randomize section */}
          {parameterKeys && (
            <>
              <Divider label="Randomize" my={4} />
              <NumboxControl
                labelComponent={
                  <Text size="xs" w={70}>
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
                  <Text size="xs" w={70}>
                    Include Mod.
                  </Text>
                }
                value={modulationEnabled}
                setValue={setModulationEnabled}
              />
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  handleRandomize();
                }}
                variant="subtle"
                color="gray"
                size="xs"
                mt={4}
              >
                Randomize
              </Button>
            </>
          )}
        </Stack>
      </Menu.Dropdown>
    </Menu>
  );
};
