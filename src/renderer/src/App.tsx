import { BrushPanel } from "@/components/layout/brush-panel";
import { CanvasPanel } from "@/components/layout/canvas-panel";
import { ControlsPanel } from "@/components/layout/controls-panel";
import { TransportPanel } from "@/components/layout/transport-panel";
import { Flex } from "@mantine/core";
import { useWindowEvent } from "@mantine/hooks";
import { Notifications } from "@mantine/notifications";
import { View } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { destroy, init } from "@renderer/api";
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
      <Notifications />
      <Canvas
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
        eventSource={document.getElementById("root")!}
        frameloop="demand"
      >
        <View.Port />
      </Canvas>
    </Flex>
  );
}

export default App;
