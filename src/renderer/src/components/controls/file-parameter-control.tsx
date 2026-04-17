import { useStore } from "@/store";
import { Box, Group, Text } from "@mantine/core";
import type { FileParameterValue } from "@renderer/parameters";
import { getFileColor } from "@renderer/store/files";
import type { ParameterKey } from "@renderer/store/types";
import { X } from "lucide-react";
import { memo, useCallback } from "react";

type FileParameterControlProps = {
  labelComponent: React.ReactNode;
  value: FileParameterValue;
  setValue: (value: FileParameterValue) => void;
  paramKey: ParameterKey;
};

export const FileParameterControl = memo(function FileParameterControl({
  labelComponent,
  value,
  setValue,
  paramKey,
}: FileParameterControlProps) {
  const pickingFileParam = useStore((state) => state.pickingFileParam);
  const isPicking = pickingFileParam === paramKey;

  const filename = value ? value.path.split("/").pop() || value.path : "Self";
  const hasValue = value !== null;
  const fileColor = hasValue ? getFileColor(value.path) : undefined;

  const handlePickClick = useCallback(() => {
    if (isPicking) {
      useStore.getState().setPickingFileParam(null);
    } else {
      useStore.getState().setPickingFileParam(paramKey);
    }
  }, [isPicking, paramKey]);

  return (
    <Group gap={"xs"} wrap="nowrap" h={24} align="center">
      {labelComponent}

      {/* File name button */}
      <Box
        onClick={handlePickClick}
        onMouseEnter={() => {
          if (value?.path) useStore.getState().setHighlightedSourcePath(value.path);
        }}
        onMouseLeave={() => {
          useStore.getState().setHighlightedSourcePath(null);
        }}
        style={{
          position: "relative",
          width: 70,
          height: 20,
          cursor: "pointer",
          overflow: "hidden",
          borderRadius: 2,
          border: `1px solid ${isPicking ? "var(--mantine-color-orange-6)" : "#666"}`,
          borderLeft: fileColor ? `3px solid ${fileColor}` : undefined,
          backgroundColor: isPicking ? "rgba(255, 140, 0, 0.1)" : "#2c2c2c",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 4px",
          flexShrink: 0,
        }}
      >
        <Text
          size="xs"
          style={{
            fontSize: 11,
            lineHeight: 1,
            color: isPicking ? "var(--mantine-color-orange-6)" : hasValue ? "#fff" : "#888",
            pointerEvents: "none",
            userSelect: "none",
            textAlign: "center",
            width: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {isPicking ? "Click..." : filename}
        </Text>

        {hasValue && !isPicking && (
          <Box
            onClick={(e) => {
              e.stopPropagation();
              setValue(null);
            }}
            style={{
              position: "absolute",
              right: 2,
              top: "50%",
              transform: "translateY(-50%)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              opacity: 0.5,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = "1";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = "0.5";
            }}
          >
            <X size={8} />
          </Box>
        )}
      </Box>
    </Group>
  );
});
