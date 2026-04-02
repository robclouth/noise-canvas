import { useStore } from "@/store";
import { Box, Group, Text } from "@mantine/core";
import type { FileParameterValue } from "@renderer/parameters";
import { getFileColor } from "@renderer/store/files";
import type { ParameterKey } from "@renderer/store/types";
import { MoveHorizontal, MoveVertical, X } from "lucide-react";
import { memo, useCallback } from "react";
import { NumboxControl } from "./numbox-control";

type FileParameterControlProps = {
  labelComponent: React.ReactNode;
  value: FileParameterValue;
  setValue: (value: FileParameterValue) => void;
  paramKey: ParameterKey;
};

const linearNormalize = (value: number, min: number, max: number) => (value - min) / (max - min);
const linearDenormalize = (norm: number, min: number, max: number) => norm * (max - min) + min;

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

  // Dummy label for the offset numboxes (they sit inline, no individual labels)
  const emptyLabel = <></>;

  return (
    <Group gap={"xs"} wrap="nowrap" h={24} align="center">
      {labelComponent}

      {/* Time position (displayed as 0-100%, stored as 0-1 UV) */}
      <NumboxControl
        labelComponent={emptyLabel}
        value={(value?.timeUv ?? 0) * 100}
        setValue={(pct) => {
          if (value) setValue({ ...value, timeUv: pct / 100 });
        }}
        min={0}
        max={100}
        step={0.1}
        unit="%"
        disabled={!hasValue}
        rightIcon={<MoveHorizontal size={9} style={{ opacity: 0.5 }} />}
        toNormalized={(v) => v / 100}
        fromNormalized={(n) => n * 100}
      />

      {/* Pitch position (displayed as 0-100%, stored as 0-1 UV) */}
      <NumboxControl
        labelComponent={emptyLabel}
        value={(value?.pitchUv ?? 0) * 100}
        setValue={(pct) => {
          if (value) setValue({ ...value, pitchUv: pct / 100 });
        }}
        min={0}
        max={100}
        step={0.1}
        unit="%"
        disabled={!hasValue}
        rightIcon={<MoveVertical size={9} style={{ opacity: 0.5 }} />}
        toNormalized={(v) => v / 100}
        fromNormalized={(n) => n * 100}
      />

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
