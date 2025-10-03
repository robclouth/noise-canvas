import { BrushPanel } from "@/components/layout/brush-panel";
import { useStore } from "@/store";
import { Group, ScrollArea, Stack } from "@mantine/core";
import { useWindowEvent } from "@mantine/hooks";
import { Notifications } from "@mantine/notifications";
import { View } from "@react-three/drei";
import { Canvas, RootState, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import { destroy, init } from "./api";
import { togglePlayback } from "./audio-manager";
import { CanvasPanel } from "./components/layout/canvas-panel";
import { ControlsPanel } from "./components/layout/controls-panel";
import { TransportPanel } from "./components/layout/transport-panel";

type Invalidator = RootState["invalidate"];

const CanvasInvalidator = ({ onReady }: { onReady: (invalidate: Invalidator) => void }) => {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    onReady(invalidate);
  }, [invalidate, onReady]);
  return null;
};

function App(): React.JSX.Element {
  const invalidateRef = useRef<Invalidator | null>(null);

  useEffect(() => {
    init();
    return () => {
      destroy();
    };
  }, []);

  // Invalidate canvas when layout changes (sections collapse/expand)
  const sectionCollapsed = useStore((state) => state.sectionCollapsed);
  const effectsEnabled = useStore((state) => state.effectsEnabled);

  useEffect(() => {
    // Invalidate multiple times during the animation for smooth updates
    const invalidate = () => invalidateRef.current?.();

    invalidate(); // Immediate
    requestAnimationFrame(() => {
      invalidate();
      requestAnimationFrame(invalidate);
    });

    // Continue invalidating every frame during the animation
    const startTime = Date.now();
    const animationDuration = 200; // Mantine Collapse default

    const intervalId = setInterval(() => {
      if (Date.now() - startTime > animationDuration) {
        clearInterval(intervalId);
      }
      invalidate();
    }, 16); // ~60fps

    return () => clearInterval(intervalId);
  }, [sectionCollapsed, effectsEnabled]);

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
    <Group h="100vh" w="100vw" wrap="nowrap" gap={0}>
      <Canvas
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
        eventSource={document.getElementById("root")!}
        frameloop="demand"
      >
        <View.Port />
        <CanvasInvalidator onReady={(invalidate) => (invalidateRef.current = invalidate)} />
      </Canvas>
      <ScrollArea w={300} miw={300} h="100%" onScrollPositionChange={() => invalidateRef.current?.()}>
        <BrushPanel />
      </ScrollArea>
      <Stack flex={1} h="100%" gap={0}>
        <ScrollArea flex={1} w="100%" onScrollPositionChange={() => invalidateRef.current?.()}>
          <CanvasPanel />
        </ScrollArea>
        <TransportPanel />
      </Stack>
      <ScrollArea w={300} miw={300} h="100%" onScrollPositionChange={() => invalidateRef.current?.()}>
        <ControlsPanel />
      </ScrollArea>
      <Notifications />
    </Group>
  );
}

export default App;
