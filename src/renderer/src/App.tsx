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
  bpmAtom,
  brushHeightAtom,
  brushTypeAtom,
  brushWidthAtom,
  gridSizeAtom,
  isPlayingAtom,
  normalizeAtom,
  openAudioFile,
  runAnalysis,
  spectrogramDataAtom,
  snapXAtom,
  snapYAtom,
} from "./store";
import { playbackTimeAtom, playAudio, stopAudio } from "./audio-manager";
import { BrushType, brushes } from "./components/brushes";
import { BrushParameter } from "./components/brushes/base-brush";
import { Input } from "./components/ui/input";

const ParameterControl = ({ parameter }: { parameter: BrushParameter }) => {
  const [value, setValue] = useAtom(parameter.atom);
  return (
    <div key={parameter.label} className="flex flex-col gap-2">
      <label htmlFor={parameter.label} className="text-sm font-medium">
        {parameter.label}: {parameter.formatValue(value)}
      </label>
      <Slider
        id={parameter.label}
        min={parameter.min}
        max={parameter.max}
        step={parameter.step}
        value={parameter.isLog ? [Math.log2(value)] : [value]}
        onValueChange={([val]) => setValue(parameter.isLog ? Math.pow(2, val) : val)}
      />
    </div>
  );
};

const formatTime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  const ms = Math.floor((seconds % 1) * 1000)
    .toString()
    .padStart(3, "0");
  return `${h}:${m}:${s}:${ms}`;
};

const testFilePath = "/Users/rob/Documents/Projects/Music/Tools/Noise Canvas/input/voice.wav";

function App(): React.JSX.Element {
  const [brushWidth, setBrushWidth] = useAtom(brushWidthAtom);
  const [brushHeight, setBrushHeight] = useAtom(brushHeightAtom);
  const [brushType, setBrushType] = useAtom(brushTypeAtom);
  const [isPlaying, setIsPlaying] = useAtom(isPlayingAtom);
  const [normalize, setNormalize] = useAtom(normalizeAtom);
  const [bpm, setBpm] = useAtom(bpmAtom);
  const [snapX, setSnapX] = useAtom(snapXAtom);
  const [snapY, setSnapY] = useAtom(snapYAtom);
  const [gridSize, setGridSize] = useAtom(gridSizeAtom);
  const spectrogramData = useAtomValue(spectrogramDataAtom);
  const playbackTime = useAtomValue(playbackTimeAtom);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const brushRef = useRef<HTMLDivElement>(null);
  const playbackLineRef = useRef<HTMLDivElement>(null);

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
    } else {
      await rendererRef.current?.triggerSynthesis();
      await playAudio();
      setIsPlaying(true);
    }
  };

  const applySnapping = (x: number, y: number): [number, number] => {
    if (!spectrogramData) {
      return [x, y];
    }

    let snappedX = x;
    let snappedY = y;

    // Snap X to the nearest grid line
    if (snapX) {
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const gridIntervalSeconds = (60 / bpm) * gridSize;
      const currentTime = x * totalDuration; // This is the center of the brush in seconds

      const brushWidthSeconds = brushWidth * (60.0 / bpm);
      const startTime = currentTime - brushWidthSeconds / 2.0;

      const snappedStartTime = Math.round(startTime / gridIntervalSeconds) * gridIntervalSeconds;
      const snappedCenterTime = snappedStartTime + brushWidthSeconds / 2.0;

      snappedX = snappedCenterTime / totalDuration;
    }

    // Snap Y to the nearest MIDI note
    if (snapY) {
      const maxFreq = spectrogramData.sampleRate / 2;
      // The y-coordinate is inverted (0 is top, 1 is bottom)
      const currentFreq = (1 - y) * maxFreq;

      if (currentFreq > 0) {
        // Convert frequency to MIDI note, snap, then convert back
        const midiNote = 69 + 12 * Math.log2(currentFreq / 440);
        const snappedMidiNote = Math.round(midiNote);
        const snappedFreq = 440 * Math.pow(2, (snappedMidiNote - 69) / 12);
        snappedY = 1 - snappedFreq / maxFreq;
      }
    }

    return [snappedX, snappedY];
  };

  const handleCanvasClick: MouseEventHandler<HTMLDivElement> = (event) => {
    if (rendererRef.current) {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const [snappedX, snappedY] = applySnapping(
        x / event.currentTarget.clientWidth,
        y / event.currentTarget.clientHeight,
      );
      rendererRef.current.update(snappedX, snappedY);
    }
  };

  const updateBrushPosition = useCallback(
    (x: number, y: number) => {
      if (brushRef.current && spectrogramData && canvasSize.width > 0 && canvasSize.height > 0) {
        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
        const brushWidthSeconds = brushWidth * (60.0 / bpm);
        const brushWidthUv = brushWidthSeconds / totalDuration;

        // Same conversion as in renderer
        const a4 = 440.0;
        const f_high = a4 * Math.pow(2.0, brushHeight / 2.0 / 12.0);
        const f_low = a4 * Math.pow(2.0, -brushHeight / 2.0 / 12.0);
        const brushHeightHz = f_high - f_low;
        const brushHeightUv = brushHeightHz / (spectrogramData.sampleRate / 2);

        const brushWidthPx = brushWidthUv * canvasSize.width;
        const brushHeightPx = brushHeightUv * canvasSize.height;

        brushRef.current.style.left = `${x - brushWidthPx / 2}px`;
        brushRef.current.style.top = `${y - brushHeightPx / 2}px`;
        brushRef.current.style.width = `${brushWidthPx}px`;
        brushRef.current.style.height = `${brushHeightPx}px`;
      }
    },
    [spectrogramData, brushWidth, brushHeight, canvasSize, bpm],
  );

  const handleMouseMove: MouseEventHandler<HTMLDivElement> = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const [snappedX, snappedY] = applySnapping(
      x / event.currentTarget.clientWidth,
      y / event.currentTarget.clientHeight,
    );
    const snappedPxX = snappedX * rect.width;
    const snappedPxY = snappedY * rect.height;

    if (rendererRef.current && event.buttons === 1) {
      rendererRef.current.update(snappedX, snappedY);
    }
    updateBrushPosition(snappedPxX, snappedPxY);
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

  useEffect(() => {
    if (playbackLineRef.current && spectrogramData && canvasSize.width > 0) {
      if (isPlaying) {
        playbackLineRef.current.style.display = "block";
        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
        const left = (playbackTime / totalDuration) * canvasSize.width;
        playbackLineRef.current.style.left = `${left}px`;
      } else {
        playbackLineRef.current.style.display = "none";
      }
    }
  }, [playbackTime, isPlaying, spectrogramData, canvasSize]);

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
              Brush Width: {brushWidth < 1 ? `1/${1 / brushWidth}` : brushWidth} beats
            </label>
            <Slider
              id="brush-width"
              min={-4}
              max={2}
              step={1}
              value={[Math.log2(brushWidth)]}
              onValueChange={([val]) => setBrushWidth(Math.pow(2, val))}
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="brush-height" className="text-sm font-medium">
              Brush Height: {brushHeight} semitones
            </label>
            <Slider
              id="brush-height"
              min={1}
              max={48}
              step={1}
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
          <div className="flex items-center justify-between">
            <label htmlFor="snap-x-switch" className="text-sm font-medium">
              Snap Time
            </label>
            <Switch id="snap-x-switch" checked={snapX} onCheckedChange={setSnapX} />
          </div>
          <div className="flex items-center justify-between">
            <label htmlFor="snap-y-switch" className="text-sm font-medium">
              Snap Pitch
            </label>
            <Switch id="snap-y-switch" checked={snapY} onCheckedChange={setSnapY} />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="grid-size-slider" className="text-sm font-medium">
              Grid Size: {gridSize >= 1 ? `${gridSize} beats` : `1/${1 / gridSize}`}
            </label>
            <Slider
              id="grid-size-slider"
              min={-6}
              max={2}
              step={1}
              value={[Math.log2(gridSize)]}
              onValueChange={([val]) => setGridSize(Math.pow(2, val))}
            />
          </div>
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
                  className="absolute border border-white pointer-events-none opacity-80"
                  style={{ display: "none" }}
                />
                <div
                  ref={playbackLineRef}
                  className="absolute top-0 w-px bg-white h-full pointer-events-none"
                  style={{ display: "none" }}
                />
              </div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel
              defaultSize={10}
              maxSize={10}
              minSize={10}
              className="flex items-center justify-center p-4 gap-4"
            >
              <Input type="number" className="w-24" value={bpm} onChange={(e) => setBpm(Number(e.target.value))} />
              <Button onClick={handleTogglePlay}>
                {isPlaying ? <SquareIcon className="h-6 w-6" /> : <PlayIcon className="h-6 w-6" />}
              </Button>
              <div className="font-mono text-lg">{formatTime(playbackTime)}</div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel className="max-w-64 min-w-64 p-2 flex flex-col gap-4 items-stretch">
          <Select value={brushType} onValueChange={(value) => setBrushType(value as BrushType)}>
            <SelectTrigger>
              <SelectValue placeholder="Brush" />
            </SelectTrigger>
            <SelectContent>
              {Object.keys(brushes).map((key) => (
                <SelectItem key={key} value={key}>
                  {key.charAt(0).toUpperCase() + key.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {brushes[brushType].parameters.map((param) => (
            <ParameterControl key={param.label} parameter={param} />
          ))}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

export default App;
