import { BrushPanel } from "@/components/layout/brush-panel";
import { CanvasPanel } from "@/components/layout/canvas-panel";
import { ControlsPanel } from "@/components/layout/controls-panel";
import { TransportPanel } from "@/components/layout/transport-panel";
import { destroy, init } from "@/store";
import { Flex } from "@mantine/core";
import { useWindowEvent } from "@mantine/hooks";
import { useCallback, useEffect } from "react";
import { togglePlayback } from "./audio-manager";

function App(): React.JSX.Element {
  useEffect(() => {
    init();
    return () => {
      destroy();
    };
  }, []);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (
      event.code === "Space" &&
      !(event.target instanceof HTMLInputElement) &&
      !(event.target instanceof HTMLTextAreaElement)
    ) {
      event.preventDefault();
      togglePlayback();
    }
  }, []);

  useWindowEvent("keydown", handleKeyDown);

  return (
    <Flex h="100vh" w="100vw" bg="dark.8" c="gray.2">
      <BrushPanel />
      <Flex direction="column" flex={1}>
        <CanvasPanel />
        <TransportPanel />
      </Flex>
      <ControlsPanel />
    </Flex>
  );
}

export default App;
