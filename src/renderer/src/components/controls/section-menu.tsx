import { ActionIcon, Button, Divider, Menu, Stack, Text } from "@mantine/core";
import { parameterDefs } from "@renderer/parameters";
import { getModulationParamKeys, getParameterValue, useStore } from "@renderer/store";
import { ParameterKey } from "@renderer/store/types";
import { MoreVertical } from "lucide-react";
import { useState } from "react";
import {
  randomizeBooleanParameter,
  randomizeEffectOrder,
  randomizeNumberParameter,
  randomizeOptionsParameter,
} from "../../lib/randomize";
import { NumboxControl } from "./numbox-control";
import { SwitchControl } from "./switch-control";

type SectionMenuProps = {
  storageKey: string;
  parameterKeys?: ParameterKey[];
  includeEffectOrder?: boolean;
};

/**
 * SectionMenu provides a trigger (three dots) and a menu for section-level actions.
 * Shows reset and randomize section controls.
 */
export const SectionMenu = ({
  storageKey,
  parameterKeys,
  includeEffectOrder,
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
        setParameter(key, def.default);
        // Also reset modulation amounts for modulatable params
        if (def.kind === "number" && def.modulatable) {
          const modKeys = getModulationParamKeys(key);
          modKeys.forEach((modKey) => {
            const modDef = parameterDefs[modKey];
            if (modDef) {
              setParameter(modKey, modDef.default);
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
      const currentValue = getParameterValue(state, key);

      let newValue: any;
      switch (def.kind) {
        case "number":
          newValue = randomizeNumberParameter(currentValue, def.min, def.max, amount);
          break;
        case "options":
          newValue = randomizeOptionsParameter(
            currentValue,
            def.options.map((o: { value: any }) => o.value),
            amount,
          );
          break;
        case "boolean":
          newValue = randomizeBooleanParameter(currentValue, amount);
          break;
        default:
          return;
      }

      setParameter(key, newValue);

      // Also randomize modulation amounts if enabled and parameter is modulatable
      if (modulationEnabled && def.kind === "number" && def.modulatable) {
        const modKeys = getModulationParamKeys(key);
        modKeys.forEach((modKey) => {
          const modDef = parameterDefs[modKey];
          if (modDef && modDef.kind === "number") {
            const newModValue = randomizeNumberParameter(0, modDef.min, modDef.max, amount);
            setParameter(modKey, newModValue);
          }
        });
      }
    });

    // Randomize effect order if enabled
    if (includeEffectOrder) {
      const state = useStore.getState();
      const currentOrder = state.effectOrder as { effect: string; enabled: boolean }[];
      const newOrder = randomizeEffectOrder(currentOrder, amount);
      setParameter("effectOrder" as ParameterKey, newOrder);
    }
  };

  return (
    <Menu opened={opened} onChange={setOpened} position="right-start" withArrow withinPortal={false}>
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

      <Menu.Dropdown p={8} >
        <Stack gap={2}>
          {/* Reset button */}
          <Button
            onClick={(e) => {
              e.stopPropagation();
              handleReset();
            }}
            variant="subtle"
            color="gray"
            size="xs"
          >
            Reset
          </Button>

          {/* Randomize section */}
          {parameterKeys && (
            <>
              <Divider label="Randomize" my={4} />
              <NumboxControl
                labelComponent={<Text size="xs" w={70}>Amount</Text>}
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
                labelComponent={<Text size="xs" w={70}>Include Mod.</Text>}
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


