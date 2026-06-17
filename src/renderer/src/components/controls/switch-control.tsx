import { Box, Group, Text, useMantineTheme } from "@mantine/core";
import { CONTROL_ROW_GAP, CONTROL_ROW_HEIGHT, VALUE_WIDTH, WIDGET_HEIGHT } from "@renderer/lib/ui-density";
import { ReactNode } from "react";

export const SwitchControl = ({
  labelComponent,
  value,
  setValue,
  color = "orange",
}: {
  labelComponent: ReactNode;
  value: boolean;
  setValue: (value: boolean) => void;
  color?: string;
}) => {
  const theme = useMantineTheme();
  const themeColor = theme.colors[color]?.[6] || color;

  return (
    <Group gap={CONTROL_ROW_GAP} wrap="nowrap" h={CONTROL_ROW_HEIGHT} align="center">
      {labelComponent}
      <Box
        onClick={() => setValue(!value)}
        style={{
          position: "relative",
          width: VALUE_WIDTH,
          height: WIDGET_HEIGHT,
          cursor: "pointer",
          overflow: "hidden",
          borderRadius: 2,
          border: `1px solid #666`,
          backgroundColor: value ? themeColor : "#2c2c2c",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "background-color 0.15s ease",
        }}
      >
        <Text
          size="xs"
          style={{
            fontSize: "var(--ui-font-xs)",
            lineHeight: 1,
            color: "#fff",
            userSelect: "none",
            fontWeight: 500,
          }}
        >
          {value ? "On" : "Off"}
        </Text>
      </Box>
    </Group>
  );
};
