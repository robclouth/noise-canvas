import { Divider, Stack } from "@mantine/core";

export const Section = ({ children, label }: { children: React.ReactNode; label: string }) => {
  return (
    <Stack gap={2}>
      <Divider
        label={
          <div style={{ display: "flex", alignItems: "center", gap: "4px", cursor: "pointer", userSelect: "none" }}>
            <span>{label}</span>
          </div>
        }
        labelPosition="left"
        style={{ cursor: "pointer" }}
      />
      <Stack gap={2} mt={4}>
        {children}
      </Stack>
    </Stack>
  );
};
