import { Divider, Flex } from "@mantine/core";

export const Section = ({ children, label }: { children: React.ReactNode; label: string }) => {
  return (
    <Flex direction="column" gap={2}>
      <Divider label={label} labelPosition="center" />
      {children}
    </Flex>
  );
};
