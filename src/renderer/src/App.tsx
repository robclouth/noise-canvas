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
import { useAtom, useAtomValue } from "jotai";
import { PlayIcon, SquareIcon } from "lucide-react";
import { MouseEventHandler, useCallback, useEffect, useRef, useState } from "react";
import { Renderer, RendererHandle } from "./components/renderer";
import { Button } from "./components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./components/ui/resizable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Slider } from "./components/ui/slider";
import { Switch } from "./components/ui/switch";
import {
  blurXAtom,
  blurYAtom,
  brushHeightAtom,
  brushTypeAtom,
  BrushType,
  brushWidthAtom,
  gainAmountAtom,
  isPlayingAtom,
  normalizeAtom,
  openAudioFile,
  runAnalysis,
  spectrogramDataAtom,
} from "./store";
import { playAudio, stopAudio } from "./audio-manager";

const testFilePath = "/Users/rob/Documents/Projects/Music/Tools/Noise Canvas/input/voice.wav";

function App(): React.JSX.Element {
  const [brushWidth, setBrushWidth] = useAtom(brushWidthAtom);
  const [brushHeight, setBrushHeight] = useAtom(brushHeightAtom);
  const [brushType, setBrushType] = useAtom(brushTypeAtom);
  const [gainAmount, setGainAmount] = useAtom(gainAmountAtom);
  const [blurX, setBlurX] = useAtom(blurXAtom);
  const [blurY, setBlurY] = useAtom(blurYAtom);
  const [isPlaying, setIsPlaying] = useAtom(isPlayingAtom);
  const [normalize, setNormalize] = useAtom(normalizeAtom);
  const spectrogramData = useAtomValue(spectrogramDataAtom);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const brushRef = useRef<HTMLDivElement>(null);

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

  const updateBrushPosition = useCallback(
    (x: number, y: number) => {
      if (brushRef.current && spectrogramData && canvasSize.width > 0 && canvasSize.height > 0) {
        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
        const brushWidthUv = brushWidth / totalDuration;
        const brushHeightUv = brushHeight / (spectrogramData.sampleRate / 2);

        const brushWidthPx = brushWidthUv * canvasSize.width;
        const brushHeightPx = brushHeightUv * canvasSize.height;

        brushRef.current.style.left = `${x - brushWidthPx / 2}px`;
        brushRef.current.style.top = `${y - brushHeightPx / 2}px`;
        brushRef.current.style.width = `${brushWidthPx}px`;
        brushRef.current.style.height = `${brushHeightPx}px`;
      }
    },
    [spectrogramData, brushWidth, brushHeight, canvasSize],
  );

  const handleMouseMove: MouseEventHandler<HTMLDivElement> = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    if (rendererRef.current && event.buttons === 1) {
      rendererRef.current.update(x / event.currentTarget.clientWidth, y / event.currentTarget.clientHeight);
    }
    updateBrushPosition(x, y);
  };

  const handleMouseEnter = () => {
    if (brushRef.current) {
      brushRef.current.style.display = "block";
    }
  };

  const handleMouseLeave = () => {
    if (brushRef.current) {
      brushRef.current.style.display = "none";
    }
  };

  useEffect(() => {
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCanvasSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });

    if (canvasContainerRef.current) {
      resizeObserver.observe(canvasContainerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

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
          <Select value={brushType} onValueChange={(value) => setBrushType(value as BrushType)}>
            <SelectTrigger>
              <SelectValue placeholder="Brush" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="gain">Gain</SelectItem>
              <SelectItem value="blur">Blur</SelectItem>
            </SelectContent>
          </Select>

          {brushType === "gain" && (
            <div className="flex flex-col gap-2">
              <label htmlFor="gain-amount" className="text-sm font-medium">
                Gain Amount: {gainAmount.toFixed(2)}
              </label>
              <Slider
                id="gain-amount"
                min={0}
                max={10}
                step={0.1}
                value={[gainAmount]}
                onValueChange={([val]) => setGainAmount(val)}
              />
            </div>
          )}

          {brushType === "blur" && (
            <>
              <div className="flex flex-col gap-2">
                <label htmlFor="blur-x" className="text-sm font-medium">
                  Blur X: {blurX.toFixed(3)}s
                </label>
                <Slider
                  id="blur-x"
                  min={0}
                  max={0.1}
                  step={0.001}
                  value={[blurX]}
                  onValueChange={([val]) => setBlurX(val)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="blur-y" className="text-sm font-medium">
                  Blur Y: {blurY.toFixed(0)} Hz
                </label>
                <Slider
                  id="blur-y"
                  min={0}
                  max={1000}
                  step={10}
                  value={[blurY]}
                  onValueChange={([val]) => setBlurY(val)}
                />
              </div>
            </>
          )}
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel className="flex">
          <ResizablePanelGroup direction="vertical" className="flex-1">
            <ResizablePanel>
              <div
                ref={canvasContainerRef}
                className="w-full h-full relative cursor-none"
                onMouseMove={handleMouseMove}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                onClick={handleCanvasClick}
              >
                <Canvas frameloop="demand">
                  <Renderer ref={rendererRef} />
                </Canvas>
                <div
                  ref={brushRef}
                  className="absolute border border-white pointer-events-none"
                  style={{ display: "none" }}
                />
              </div>
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
