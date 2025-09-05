import { Canvas } from "@react-three/fiber";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { PlayIcon, SquareIcon } from "lucide-react";
import { MouseEventHandler, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DataTexture, FloatType, NearestFilter, RGBAFormat, RGBFormat, RGFormat, Vector2 } from "three";
import { playAudio, playbackTimeAtom, stopAudio } from "./audio-manager";
import { BrushType, brushes } from "./components/brushes";
import { BrushParameter, SelectParameter, SliderParameter } from "./components/brushes/base-brush";
import { screenToZoomed, zoomedToScreen } from "./components/brushes/common";
import { Renderer, RendererHandle } from "./components/renderer";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./components/ui/resizable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Slider } from "./components/ui/slider";
import { Toaster } from "./components/ui/sonner";
import { Switch } from "./components/ui/switch";
import {
  bandsPerOctaveAtom,
  bpmAtom,
  brushHeightAtom,
  brushTypeAtom,
  brushWidthAtom,
  featherXAtom,
  featherYAtom,
  fminAtom,
  gridSizeAtom,
  gridSizeYAtom,
  isPlayingAtom,
  mouseUvAtom,
  normalizeAtom,
  scrollAtom,
  snapXAtom,
  snapYAtom,
  spectrogramDataAtom,
  store,
  zoomPowerAtom,
} from "./store";

const SliderControl = ({ parameter }: { parameter: SliderParameter }) => {
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

const SelectControl = ({ parameter }: { parameter: SelectParameter }) => {
  const [value, setValue] = useAtom(parameter.atom);
  return (
    <div key={parameter.label} className="flex flex-col gap-2">
      <label htmlFor={parameter.label} className="text-sm font-medium">
        {parameter.label}
      </label>
      <Select value={value} onValueChange={(val) => setValue(val)}>
        <SelectTrigger>
          <SelectValue placeholder={parameter.label} />
        </SelectTrigger>
        <SelectContent>
          {parameter.options.map((key) => (
            <SelectItem key={key} value={key}>
              {key.charAt(0).toUpperCase() + key.slice(1)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

const ParameterControl = ({ parameter }: { parameter: BrushParameter }) => {
  switch (parameter.type) {
    case "slider":
      return <SliderControl parameter={parameter} />;
    case "select":
      return <SelectControl parameter={parameter} />;
    default:
      return null;
  }
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
  const [gridSizeY, setGridSizeY] = useAtom(gridSizeYAtom);
  const spectrogramData = useAtomValue(spectrogramDataAtom);
  const playbackTime = useAtomValue(playbackTimeAtom);
  const [zoomPower, setZoomPower] = useAtom(zoomPowerAtom);
  const [scroll, setScroll] = useAtom(scrollAtom);
  const [featherX, setFeatherX] = useAtom(featherXAtom);
  const [featherY, setFeatherY] = useAtom(featherYAtom);
  const setMouseUv = useSetAtom(mouseUvAtom);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const playbackLineRef = useRef<HTMLDivElement>(null);

  const rendererRef = useRef<RendererHandle>(null);
  const lastSnappedPositionRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    // Ensure brushType is valid, reset if not
    if (!brushes[brushType]) {
      setBrushType(Object.keys(brushes)[0] as BrushType);
    }
  }, [brushType, setBrushType]);

  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      // Dev mode: load a test file automatically.
      // We need to ask the main process to do this for us.
      // Note: This requires a path that is valid on the machine running the app.
      const params = {
        bandsPerOctave: store.get(bandsPerOctaveAtom),
        fmin: store.get(fminAtom),
      };
      window.api.loadFile("/Users/rob/Documents/Projects/Music/Tools/Noise Canvas Python/input/garage.mp3", params);
    }

    const unsubOpenFile = window.api.onOpenFile((path) => {
      const params = {
        bandsPerOctave: store.get(bandsPerOctaveAtom),
        fmin: store.get(fminAtom),
      };
      window.api.loadFile(path, params);
    });

    const unsubTriggerOpenFile = window.api.onTriggerOpenFile(async () => {
      try {
        const bandsPerOctave = store.get(bandsPerOctaveAtom);
        const fmin = store.get(fminAtom);
        await window.api.openFileAndAnalyze({ bandsPerOctave, fmin });
      } catch (error) {
        console.error("Analysis failed:", error);
        toast.error("Analysis Error", {
          description: "An error occurred while analyzing the audio.",
        });
      }
    });

    const unsubAnalysisComplete = window.api.onAnalysisComplete((payload) => {
      const packedDataTex = new DataTexture(
        new Float32Array(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength / 4),
        payload.textureWidth,
        payload.textureHeight,
        RGBAFormat,
        FloatType,
      );
      packedDataTex.internalFormat = "RGBA32F";
      packedDataTex.minFilter = NearestFilter;
      packedDataTex.magFilter = NearestFilter;
      packedDataTex.needsUpdate = true;

      const inverseMapTex = new DataTexture(
        new Float32Array(payload.inverseMap.buffer, payload.inverseMap.byteOffset, payload.inverseMap.byteLength / 4),
        payload.textureWidth,
        payload.textureHeight,
        RGFormat,
        FloatType,
      );
      inverseMapTex.internalFormat = "RG32F";
      inverseMapTex.minFilter = NearestFilter;
      inverseMapTex.magFilter = NearestFilter;
      inverseMapTex.needsUpdate = true;

      const metadataTex = new DataTexture(
        new Float32Array(
          payload.metadataTexture.buffer,
          payload.metadataTexture.byteOffset,
          payload.metadataTexture.byteLength / 4,
        ),
        payload.numBands,
        1,
        RGBFormat,
        FloatType,
      );
      metadataTex.internalFormat = "RGB32F";
      metadataTex.minFilter = NearestFilter;
      metadataTex.magFilter = NearestFilter;
      metadataTex.needsUpdate = true;

      store.set(spectrogramDataAtom, {
        packedDataTex,
        inverseMapTex,
        metadataTex,
        numFrames: payload.numFrames,
        numBands: payload.numBands,
        numChannels: payload.numChannels,
        sampleRate: payload.sampleRate,
        packedTextureSize: new Vector2(payload.textureWidth, payload.textureHeight),
        synthesisMetadata: {
          bandOffsets: payload.bandOffsets,
          bandStepLog2s: payload.bandStepLog2s,
          bandLengths: payload.bandLengths,
        },
      });
      window.api.clearUndoState();
    });

    const unsubAnalysisError = window.api.onAnalysisError(() => {
      toast.error("Analysis Error", {
        description: "An error occurred while analyzing the audio.",
      });
    });

    const unsubUndo = window.api.onUndoApplyState((data) => {
      rendererRef.current?.setFBOData(
        new Float32Array(data.buffer, data.byteOffset, data.byteLength / Float32Array.BYTES_PER_ELEMENT),
      );
    });

    const unsubRequestAudioForSaving = window.api.onRequestAudioForSaving(async () => {
      if (!rendererRef.current) {
        return;
      }
      const processedData = rendererRef.current.getFBOData();
      const spectrogramData = store.get(spectrogramDataAtom);
      if (!processedData || !spectrogramData) {
        return;
      }

      const analysisParams = {
        bandsPerOctave: store.get(bandsPerOctaveAtom),
        fmin: store.get(fminAtom),
      };
      const payload = {
        processedData: processedData.buffer,
        analysisMetadata: {
          numFrames: spectrogramData.numFrames,
          numChannels: spectrogramData.numChannels,
          numBands: spectrogramData.numBands,
          ...spectrogramData.synthesisMetadata,
        },
      };
      const normalize = store.get(normalizeAtom);

      try {
        await window.api.saveAudioData(payload, analysisParams, normalize);
        toast.success("File saved successfully!");
        console.log("File saved successfully!");
      } catch (e) {
        console.error("Failed to save audio", e);
        toast.error("Failed to save file", {
          description: e instanceof Error ? e.message : "An unknown error occurred.",
        });
      }
    });

    return () => {
      unsubOpenFile();
      unsubTriggerOpenFile();
      unsubAnalysisComplete();
      unsubAnalysisError();
      unsubUndo();
      unsubRequestAudioForSaving();
    };
  }, []);

  const handleTogglePlay = async (): Promise<void> => {
    if (isPlaying) {
      stopAudio();
    } else {
      await rendererRef.current?.triggerSynthesis();
      await playAudio();
      setIsPlaying(true);
    }
  };

  const getSnappedCoordinates = (event: React.MouseEvent<HTMLDivElement>): [number, number] | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;

    const zoomedX = screenToZoomed(new Vector2(x, y), zoomPower, scroll).x;

    if (!spectrogramData) {
      return [zoomedX, y];
    }

    let snappedX = zoomedX;
    let snappedY = y;

    // Snap X to the nearest grid line
    if (snapX) {
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const gridIntervalSeconds = (60 / bpm) * gridSize;
      const currentTime = zoomedX * totalDuration; // This is the center of the brush in seconds

      const brushWidthSeconds = brushWidth * (60.0 / bpm);
      const startTime = currentTime - brushWidthSeconds / 2.0;

      const snappedStartTime = Math.round(startTime / gridIntervalSeconds) * gridIntervalSeconds;
      const snappedCenterTime = snappedStartTime + brushWidthSeconds / 2.0;

      snappedX = snappedCenterTime / totalDuration;
    }

    // Snap Y to the nearest MIDI note
    if (snapY) {
      const bandsPerOctave = store.get(bandsPerOctaveAtom);
      const bandsPerSemitone = bandsPerOctave / 12;
      const gridIntervalBands = gridSizeY * bandsPerSemitone;
      const currentBand = y * spectrogramData.numBands;
      const snappedBand = Math.round(currentBand / gridIntervalBands) * gridIntervalBands;
      snappedY = snappedBand / spectrogramData.numBands;
    }

    return [snappedX, snappedY];
  };

  const performBrushStroke = (snappedX: number, snappedY: number, force = false): void => {
    if (!rendererRef.current) return;
    if (
      force ||
      !lastSnappedPositionRef.current ||
      lastSnappedPositionRef.current.x !== snappedX ||
      lastSnappedPositionRef.current.y !== snappedY
    ) {
      rendererRef.current.update(snappedX, snappedY);
      lastSnappedPositionRef.current = { x: snappedX, y: snappedY };
    }
  };

  const handleCanvasMouseDown: MouseEventHandler<HTMLDivElement> = (event) => {
    if (event.button === 0 && rendererRef.current) {
      // Left mouse button down
      const beforeState = rendererRef.current.getFBOData();
      if (beforeState) {
        // We'll capture the 'after' state on mouse up
        (event.currentTarget as any)._undoBeforeState = beforeState;
      }

      const coords = getSnappedCoordinates(event);
      if (coords) {
        performBrushStroke(coords[0], coords[1], true);
      }
    }
  };

  const handleCanvasMouseUp: MouseEventHandler<HTMLDivElement> = (event) => {
    if (event.button === 0 && rendererRef.current) {
      // Left mouse button up
      const beforeState = (event.currentTarget as any)._undoBeforeState;
      if (beforeState) {
        const afterState = rendererRef.current.getFBOData();
        if (afterState) {
          window.api.addUndoState({
            before: beforeState.buffer,
            after: afterState.buffer,
          });
        }
        delete (event.currentTarget as any)._undoBeforeState;
      }
    }
  };

  const handleMouseMove: MouseEventHandler<HTMLDivElement> = (event) => {
    const coords = getSnappedCoordinates(event);
    if (!coords) return;
    const [snappedX, snappedY] = coords;

    setMouseUv(new Vector2(snappedX, 1 - snappedY));

    if (event.buttons === 1) {
      performBrushStroke(snappedX, snappedY);
    }
  };

  const handleMouseLeave = () => {
    setMouseUv(null);
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
        const progress = playbackTime / totalDuration;
        const screenCoords = zoomedToScreen(new Vector2(progress, 0), zoomPower, scroll);
        const left = screenCoords.x * canvasSize.width;

        if (left < 0 || left > canvasSize.width) {
          playbackLineRef.current.style.display = "none";
        } else {
          playbackLineRef.current.style.display = "block";
          playbackLineRef.current.style.left = `${left}px`;
        }
      } else {
        playbackLineRef.current.style.display = "none";
      }
    }
  }, [playbackTime, isPlaying, spectrogramData, canvasSize, zoomPower, scroll]);

  return (
    <div className="h-screen w-screen bg-background text-foreground flex flex-col">
      <ResizablePanelGroup direction="horizontal">
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
        <ResizableHandle />
        <ResizablePanel className="flex">
          <ResizablePanelGroup direction="vertical" className="flex-1">
            <ResizablePanel>
              <div
                ref={canvasContainerRef}
                className="w-full h-full relative cursor-none"
                onMouseMove={handleMouseMove}
                onMouseLeave={handleMouseLeave}
                onMouseDown={handleCanvasMouseDown}
                onMouseUp={handleCanvasMouseUp}
              >
                <Canvas frameloop="demand">
                  <Renderer ref={rendererRef} />
                </Canvas>
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
              Grid X: {gridSize >= 1 ? `${gridSize} beats` : `1/${1 / gridSize} beats`}
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
          <div className="flex flex-col gap-2">
            <label htmlFor="grid-size-y-slider" className="text-sm font-medium">
              Grid Y: {gridSizeY} semitones
            </label>
            <Slider
              id="grid-size-y-slider"
              min={1}
              max={24}
              step={1}
              value={[gridSizeY]}
              onValueChange={([val]) => setGridSizeY(val)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="zoom-slider" className="text-sm font-medium">
              Zoom: {Math.pow(2, zoomPower).toFixed(2)}x
            </label>
            <Slider
              id="zoom-slider"
              min={0}
              max={4}
              step={0.1}
              value={[zoomPower]}
              onValueChange={([val]) => setZoomPower(val)}
            />
          </div>
          {zoomPower > 0 && (
            <div className="flex flex-col gap-2">
              <label htmlFor="scroll-slider" className="text-sm font-medium">
                Scroll
              </label>
              <Slider
                id="scroll-slider"
                min={0}
                max={1}
                step={0.001}
                value={[scroll]}
                onValueChange={([val]) => setScroll(val)}
              />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <label htmlFor="feather-x-slider" className="text-sm font-medium">
              Feather X: {(featherX * 100).toFixed(0)}%
            </label>
            <Slider
              id="feather-x-slider"
              min={0}
              max={1}
              step={0.01}
              value={[featherX]}
              onValueChange={([val]) => setFeatherX(val)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="feather-y-slider" className="text-sm font-medium">
              Feather Y: {(featherY * 100).toFixed(0)}%
            </label>
            <Slider
              id="feather-y-slider"
              min={0}
              max={1}
              step={0.01}
              value={[featherY]}
              onValueChange={([val]) => setFeatherY(val)}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <Toaster position="bottom-right" />
    </div>
  );
}

export default App;
