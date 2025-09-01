import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "@/components/ui/menubar";
import { Canvas } from "@react-three/fiber";
import { useAtom } from "jotai";
import { PlayIcon, SquareIcon } from "lucide-react";
import { MouseEventHandler, useEffect, useRef } from "react";
import { Renderer, RendererHandle } from "./components/renderer";
import { Button } from "./components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./components/ui/resizable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Slider } from "./components/ui/slider";
import { Switch } from "./components/ui/switch";
import { brushHeightAtom, brushWidthAtom, isPlayingAtom, normalizeAtom, openAudioFile, runAnalysis } from "./store";
import { playAudio, stopAudio } from "./audio-manager";

const testFilePath = "/Users/rob/Documents/Projects/Music/Tools/Noise Canvas/input/voice.wav";

function App(): React.JSX.Element {
  const [brushWidth, setBrushWidth] = useAtom(brushWidthAtom);
  const [brushHeight, setBrushHeight] = useAtom(brushHeightAtom);
  const [isPlaying, setIsPlaying] = useAtom(isPlayingAtom);
  const [normalize, setNormalize] = useAtom(normalizeAtom);

  useEffect(() => {
    runAnalysis(testFilePath);
    console.log("testFilePath", testFilePath);
  }, []);

  const rendererRef = useRef<RendererHandle>(null);

  const handleOpenFile = (): void => {
    openAudioFile();
  };

  const handleTogglePlay = async (): Promise<void> => {
    if (isPlaying) {
      stopAudio();
      setIsPlaying(false);
    } else {
      await rendererRef.current?.triggerSynthesis();
      await playAudio();
      setIsPlaying(true);
    }
  };

  const handleCanvasClick: MouseEventHandler<HTMLDivElement> = (event) => {
    if (rendererRef.current) {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      rendererRef.current.update(x / event.currentTarget.clientWidth, y / event.currentTarget.clientHeight);
    }
  };

  const handleMouseMove: MouseEventHandler<HTMLDivElement> = (event) => {
    if (rendererRef.current && event.buttons === 1) {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      rendererRef.current.update(x / event.currentTarget.clientWidth, y / event.currentTarget.clientHeight);
    }
  };

  return (
    <div className="h-screen w-screen bg-background text-foreground flex flex-col">
      <Menubar>
        <MenubarMenu>
          <MenubarTrigger>File</MenubarTrigger>
          <MenubarContent>
            <MenubarItem>
              New <MenubarShortcut>⌘N</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={handleOpenFile}>
              Open <MenubarShortcut>⌘O</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem>
              Save <MenubarShortcut>⌘S</MenubarShortcut>
            </MenubarItem>
            <MenubarItem>
              Save As... <MenubarShortcut>⇧⌘S</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem>
              Exit <MenubarShortcut>⌘Q</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>Edit</MenubarTrigger>
          <MenubarContent>
            <MenubarItem>
              Undo <MenubarShortcut>⌘Z</MenubarShortcut>
            </MenubarItem>
            <MenubarItem>
              Redo <MenubarShortcut>⇧⌘Z</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem>
              Cut <MenubarShortcut>⌘X</MenubarShortcut>
            </MenubarItem>
            <MenubarItem>
              Copy <MenubarShortcut>⌘C</MenubarShortcut>
            </MenubarItem>
            <MenubarItem>
              Paste <MenubarShortcut>⌘V</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>View</MenubarTrigger>
          <MenubarContent>
            <MenubarItem>Zoom In</MenubarItem>
            <MenubarItem>Zoom Out</MenubarItem>
            <MenubarSeparator />
            <MenubarItem>Full Screen</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>Tools</MenubarTrigger>
          <MenubarContent>
            <MenubarItem>Settings</MenubarItem>
            <MenubarItem>Preferences</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>
      <ResizablePanelGroup direction="horizontal">
        <ResizablePanel className="max-w-64 min-w-64 p-2 flex flex-col gap-4 items-stretch">
          <div className="flex flex-col gap-2">
            <label htmlFor="brush-width" className="text-sm font-medium">
              Brush Width: {brushWidth.toFixed(2)}s
            </label>
            <Slider
              id="brush-width"
              min={0.01}
              max={2}
              step={0.01}
              value={[brushWidth]}
              onValueChange={([val]) => setBrushWidth(val)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="brush-height" className="text-sm font-medium">
              Brush Height: {brushHeight.toFixed(0)} Hz
            </label>
            <Slider
              id="brush-height"
              min={10}
              max={20000}
              step={10}
              value={[brushHeight]}
              onValueChange={([val]) => setBrushHeight(val)}
            />
          </div>
          <div className="flex items-center justify-between">
            <label htmlFor="normalize-switch" className="text-sm font-medium">
              Normalize output
            </label>
            <Switch id="normalize-switch" checked={normalize} onCheckedChange={setNormalize} />
          </div>
          <Select>
            <SelectTrigger>
              <SelectValue placeholder="Brush" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="gain">Gain</SelectItem>
            </SelectContent>
          </Select>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel className="flex">
          <ResizablePanelGroup direction="vertical" className="flex-1">
            <ResizablePanel>
              <Canvas onClick={handleCanvasClick} onMouseMove={handleMouseMove} frameloop="demand">
                <Renderer ref={rendererRef} />
              </Canvas>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize={20} maxSize={50} minSize={10} className="flex items-center justify-center p-4">
              <Button onClick={handleTogglePlay}>
                {isPlaying ? <SquareIcon className="h-6 w-6" /> : <PlayIcon className="h-6 w-6" />}
              </Button>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

export default App;
