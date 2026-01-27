import { ActionIcon, Box, Checkbox, Popover, Stack, Text } from "@mantine/core";
import { parameterDefs } from "@renderer/parameters";
import { getModulationParamKeys, getParameterValue, useStore } from "@renderer/store";
import { ParameterKey } from "@renderer/store/types";
import { Dice5 } from "lucide-react";
import { useCallback, useState } from "react";
import {
  randomizeBooleanParameter,
  randomizeEffectOrder,
  randomizeNumberParameter,
  randomizeOptionsParameter,
} from "../../lib/randomize";
import { NumboxControl } from "./numbox-control";

type RandomizeButtonProps = {
  parameterKeys: ParameterKey[];
  storageKey: string;
  includeEffectOrder?: boolean; // Whether to also randomize effectOrder
};

export const RandomizeButton = ({ parameterKeys, storageKey, includeEffectOrder }: RandomizeButtonProps) => {
  const [opened, setOpened] = useState(false);

  // Get randomization amount for this section (default to 100 if not set)
  const amount = useStore((state) => state.randomizationAmounts[storageKey] ?? 100);
  const setRandomizationAmount = useStore((state) => state.setRandomizationAmount);

  // Get modulation randomization toggle (stored as 0 or 100)
  const modulationEnabled = useStore((state) => (state.randomizationAmounts[`${storageKey}-mod`] ?? 0) > 0);
  const setModulationEnabled = (enabled: boolean) => setRandomizationAmount(`${storageKey}-mod`, enabled ? 100 : 0);

  const setParameter = useStore((state) => state.setParameter);

  const handleRandomize = useCallback(() => {
    if (amount <= 0) return;

    const state = useStore.getState();

    parameterKeys.forEach((key) => {
      const def = parameterDefs[key];
      if (!def) return;

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
            // Randomize from 0 (center) within the -100 to 100 range
            const newModValue = randomizeNumberParameter(0, modDef.min, modDef.max, amount);
            setParameter(modKey, newModValue);
          }
        });
      }
    });

    // Randomize effect order if enabled
    if (includeEffectOrder) {
      const currentOrder = getParameterValue(state, "effectOrder") as { effect: string; enabled: boolean }[];
      const newOrder = randomizeEffectOrder(currentOrder, amount);
      setParameter("effectOrder" as ParameterKey, newOrder);
    }
  }, [amount, parameterKeys, setParameter, modulationEnabled, includeEffectOrder]);

  // Calculate bar height based on amount (0-100%)
  const barHeight = (amount / 100) * 14;

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      withArrow
      position="bottom"
      clickOutsideEvents={["click", "mousedown", "touchstart"]}
    >
      <Popover.Target>
        <Box
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpened(true);
          }}
          style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
        >
          <ActionIcon
            variant="subtle"
            size="xs"
            color="gray"
            onClick={(e) => {
              e.stopPropagation();
              handleRandomize();
            }}
            title={`Randomize (Right-click to set amount: ${amount}%)`}
          >
            <Dice5 size={14} />
          </ActionIcon>
          {/* Vertical bar indicator */}
          <Box
            style={{
              width: 3,
              height: 14,
              backgroundColor: "#333",
              borderRadius: 1,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              justifyContent: "flex-end",
            }}
          >
            <Box
              style={{
                width: "100%",
                height: barHeight,
                backgroundColor: "var(--mantine-color-orange-6)",
                transition: "height 0.1s ease",
              }}
            />
          </Box>
        </Box>
      </Popover.Target>
      <Popover.Dropdown p={4} onClick={(e) => e.stopPropagation()}>
        <Stack gap={4}>
          <NumboxControl
            labelComponent={<Text size="xs">Rnd</Text>}
            value={amount}
            setValue={(val) => setRandomizationAmount(storageKey, val)}
            min={0}
            max={100}
            step={1}
            unit="%"
            toNormalized={(val) => val / 100}
            fromNormalized={(val) => val * 100}
          />
          <Checkbox
            size="xs"
            label="Modulation"
            checked={modulationEnabled}
            onChange={(e) => setModulationEnabled(e.currentTarget.checked)}
          />
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
};
