import { Button, Center, Code, Group, Stack, Text, Title } from "@mantine/core";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { diag } from "../lib/diag-log";
import { host } from "../lib/host";

const ISSUES_URL = "https://github.com/robclouth/noise-canvas/issues";

/** The screen shown in place of the app when it cannot start or has crashed. */
export function AppFailure({ title, error, canReload }: { title: string; error: string; canReload: boolean }) {
  const hasLog = !host.env.isExtension;
  return (
    <Center h="100vh" p="xl">
      <Stack maw={560} gap="md">
        <Title order={3}>{title}</Title>
        <Text size="sm">
          {hasLog
            ? "Open an issue on GitHub and attach the log file. Show Log File opens the folder that holds it."
            : "Open an issue on GitHub and include the error below."}
        </Text>
        <Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 200, overflow: "auto" }}>
          {error}
        </Code>
        <Group gap="sm">
          {hasLog && <Button onClick={() => host.diag.revealLogFile()}>Show Log File</Button>}
          <Button variant="default" onClick={() => host.shell.openExternal(ISSUES_URL)}>
            Open an Issue
          </Button>
          {canReload && (
            <Button variant="default" onClick={() => window.location.reload()}>
              Reload
            </Button>
          )}
        </Group>
      </Stack>
    </Center>
  );
}

/** Shows `AppFailure` in place of its children once a render or effect under it throws. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    diag.error("renderer", "the app crashed", {
      message: error.message,
      stack: error.stack ?? null,
      componentStack: info.componentStack ?? null,
    });
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <AppFailure title="Noise Canvas Has Stopped" error={error.message} canReload />;
  }
}
