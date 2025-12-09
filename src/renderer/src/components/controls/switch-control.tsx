import { Box, Group, Text } from "@mantine/core";
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
  return (
    <Group gap={"xs"} wrap="nowrap" h={24} align="center">
      {labelComponent}
      <Box
        onClick={() => setValue(!value)}
        style={{
          position: "relative",
          width: 70,
          height: 20,
          cursor: "pointer",
          overflow: "hidden",
          borderRadius: 2,
          border: `1px solid #666`,
          backgroundColor: value ? color : "#2c2c2c",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "background-color 0.15s ease",
        }}
      >
        <Text
          size="xs"
          style={{
            fontSize: 11,
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
