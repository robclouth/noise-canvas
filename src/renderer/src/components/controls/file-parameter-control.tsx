import { useStore } from "@/store";
import { Box, Group, Text } from "@mantine/core";
import { openContextModal } from "@renderer/lib/modals";
import { CONTROL_ROW_GAP, CONTROL_ROW_HEIGHT, VALUE_WIDTH, WIDGET_HEIGHT } from "@renderer/lib/ui-density";
import { useEffectId } from "@renderer/contexts/effect-context";
import { getParameterDef, type FileParameterValue } from "@renderer/parameters";
import { getFileColor, openFiles } from "@renderer/store/files";
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
  const effectId = useEffectId();
  const pickingFileParam = useStore((state) => state.pickingFileParam);
  const pickingEffectId = useStore((state) => state.pickingEffectId);
  const def = getParameterDef(paramKey);
  const pickMode = def.kind === "file" ? def.pickMode : "canvas";
  const isCanvasPicking =
    pickMode === "canvas" && pickingFileParam === paramKey && pickingEffectId === (effectId ?? null);

  const filename = value ? value.path.split("/").pop() || value.path : "Self";
  const hasValue = value !== null;
  const fileColor = hasValue ? getFileColor(value.path) : undefined;
  const isHighlighted = isCanvasPicking;
  const isMissing = useStore((state) => {
    if (!value?.path) return false;
    return !state.openFileIds.some((id) => openFiles[id]?.filePath === value.path);
  });

  const handlePickClick = useCallback(() => {
    if (pickMode === "modal") {
      openContextModal({
        modal: "filePicker",
        title: "Choose file",
        innerProps: {
          currentPath: value?.path ?? null,
          resolve: (path: string | null) => {
            setValue(path ? { path } : null);
          },
        },
      });
      return;
    }
    // Canvas pick: toggle the pick mode; user then clicks on a file canvas.
    if (isCanvasPicking) {
      useStore.getState().setPickingFileParam(null);
    } else {
      useStore.getState().setPickingFileParam(paramKey, effectId);
    }
  }, [pickMode, isCanvasPicking, paramKey, effectId, value, setValue]);

  return (
    <Group gap={CONTROL_ROW_GAP} wrap="nowrap" h={CONTROL_ROW_HEIGHT} align="center">
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
          width: VALUE_WIDTH,
          height: WIDGET_HEIGHT,
          cursor: "pointer",
          overflow: "hidden",
          borderRadius: 2,
          border: `1px solid ${
            isHighlighted ? "var(--mantine-color-orange-6)" : isMissing ? "var(--mantine-color-red-6)" : "#666"
          }`,
          borderLeft: fileColor
            ? `3px solid ${isMissing ? "var(--mantine-color-red-6)" : fileColor}`
            : `1px solid ${
                isHighlighted ? "var(--mantine-color-orange-6)" : isMissing ? "var(--mantine-color-red-6)" : "#666"
              }`,
          backgroundColor: isHighlighted ? "rgba(255, 140, 0, 0.1)" : "#2c2c2c",
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
            color: isHighlighted ? "var(--mantine-color-orange-6)" : hasValue ? "#fff" : "#888",
            pointerEvents: "none",
            userSelect: "none",
            textAlign: "center",
            width: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {isCanvasPicking ? "Click..." : filename}
        </Text>

        {hasValue && !isCanvasPicking && (
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
