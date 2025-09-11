import { BrushPanel } from "@/components/layout/brush-panel";
import { CanvasPanel } from "@/components/layout/canvas-panel";
import { ControlsPanel } from "@/components/layout/controls-panel";
import { destroy, init } from "@/store";
import { Flex } from "@mantine/core";
import { useEffect } from "react";

function App(): React.JSX.Element {
  useEffect(() => {
    init();
    return () => {
      destroy();
    };
  }, []);

  return (
    <Flex h="100vh" w="100vw" bg="dark.8" c="gray.2">
      <BrushPanel />
      <CanvasPanel />
      <ControlsPanel />
    </Flex>
  );
}

export default App;
