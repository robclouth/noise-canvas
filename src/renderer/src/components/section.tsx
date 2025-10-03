import { useStore } from "@/store";
import { Collapse, Divider, Stack } from "@mantine/core";
import { ChevronDown, ChevronRight } from "lucide-react";

export const Section = ({ children, label }: { children: React.ReactNode; label: string }) => {
  const sectionCollapsed = useStore((state) => state.sectionCollapsed);
  const setSectionCollapsed = useStore((state) => state.setSectionCollapsed);

  const isCollapsed = sectionCollapsed[label] ?? false;

  return (
    <Stack gap={2}>
      <Divider
        label={
          <div
            style={{ display: "flex", alignItems: "center", gap: "4px", cursor: "pointer", userSelect: "none" }}
            onClick={() => setSectionCollapsed(label, !isCollapsed)}
          >
            {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            <span>{label}</span>
          </div>
        }
        labelPosition="left"
        style={{ cursor: "pointer" }}
        onClick={() => setSectionCollapsed(label, !isCollapsed)}
      />
      <Collapse in={!isCollapsed}>
        <Stack gap={2} mt={4}>
          {children}
        </Stack>
      </Collapse>
    </Stack>
  );
};
