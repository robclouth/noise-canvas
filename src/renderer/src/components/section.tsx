import { Divider, Stack } from "@mantine/core";

export const Section = ({ children, label }: { children: React.ReactNode; label: string }) => {
  return (
    <Stack gap={2}>
      <Divider label={label} labelPosition="center" />
      {children}
    </Stack>
  );
};
