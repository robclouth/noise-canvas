import { Flex } from "@mantine/core";
import { useAtom } from "jotai";
import { useEffect } from "react";
import { BrushType, brushes } from "@/components/brushes";
import { CanvasPanel } from "@/components/layout/canvas-panel";
import { ControlsPanel } from "@/components/layout/controls-panel";
import { BrushPanel } from "@/components/layout/brush-panel";
import { useIpcListeners } from "@/hooks/use-ipc-listeners";
import { brushTypeAtom } from "@/store";

function App(): React.JSX.Element {
  const [brushType, setBrushType] = useAtom(brushTypeAtom);

  // Initialize IPC listeners
  useIpcListeners();

  // Ensure brushType is valid, reset if not
  useEffect(() => {
    if (!brushes[brushType]) {
      setBrushType(Object.keys(brushes)[0] as BrushType);
    }
  }, [brushType, setBrushType]);

  return (
    <Flex h="100vh" w="100vw" bg="dark.8" c="gray.2">
      <BrushPanel />
      <CanvasPanel />
      <ControlsPanel />
    </Flex>
  );
}

export default App;
