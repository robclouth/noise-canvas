import { ActionIcon, Box, Flex, NumberInput, Paper, Select, Slider, Stack, Switch, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { Canvas } from "@react-three/fiber";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Play, Square } from "lucide-react";
import { MouseEventHandler, useEffect, useRef, useState } from "react";
import { DataTexture, FloatType, NearestFilter, RGBAFormat, RGBFormat, RGFormat, Vector2 } from "three";
import { playAudio, playbackTimeAtom, stopAudio } from "./audio-manager";
import { BrushType, brushes } from "./components/brushes";
import { BrushParameter, SelectParameter, SliderParameter } from "./components/brushes/base-brush";
import { screenToZoomed, zoomedToScreen } from "./components/brushes/common";
import { Renderer, RendererHandle } from "./components/renderer";
import {
  bandsPerOctaveAtom,
  bpmAtom,
  brushHeightAtom,
  brushIntensityAtom,
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

const BRUSH_WIDTH_MAX_LOG2 = 8;
const BRUSH_HEIGHT_MAX = 128;

const SliderControl = ({ parameter }: { parameter: SliderParameter }) => {
  const [value, setValue] = useAtom(parameter.atom);
  return (
    <div key={parameter.label}>
      <Text size="sm">
        {parameter.label}: {parameter.formatValue(value)}
      </Text>
      <Slider
        label={null}
        min={parameter.min}
        max={parameter.max}
        step={parameter.step}
        value={parameter.isLog ? Math.log2(value) : value}
        onChange={(val) => setValue(parameter.isLog ? Math.pow(2, val) : val)}
      />
    </div>
  );
};

const SelectControl = ({ parameter }: { parameter: SelectParameter }) => {
  const [value, setValue] = useAtom(parameter.atom);
  const data = parameter.options.map((key) => ({
    value: key,
    label: key.charAt(0).toUpperCase() + key.slice(1),
  }));

  return (
    <Select
      key={parameter.label}
      label={parameter.label}
      data={data}
      value={value}
      onChange={(val) => setValue(val || parameter.options[0])}
    />
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
  const [brushIntensity, setBrushIntensity] = useAtom(brushIntensityAtom);
  const setMouseUv = useSetAtom(mouseUvAtom);
  const setSpectrogramData = useSetAtom(spectrogramDataAtom);
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
      const params = {
        bandsPerOctave: store.get(bandsPerOctaveAtom),
        fmin: store.get(fminAtom),
      };
      window.api.loadFile("/Users/rob/Documents/Projects/Music/Tools/Noise Canvas Python/input/voice.wav", params);
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
        notifications.show({
          title: "Analysis Error",
          message: "An error occurred while analyzing the audio.",
          color: "red",
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

      setSpectrogramData({
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
      notifications.show({
        title: "Analysis Error",
        message: "An error occurred while analyzing the audio.",
        color: "red",
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
        notifications.show({
          title: "Success",
          message: "File saved successfully!",
          color: "green",
        });
        console.log("File saved successfully!");
      } catch (e) {
        console.error("Failed to save audio", e);
        notifications.show({
          title: "Failed to save file",
          message: e instanceof Error ? e.message : "An unknown error occurred.",
          color: "red",
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
  }, [setSpectrogramData]);

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
    <Flex h="100vh" w="100vw" bg="dark.8" c="gray.2">
      <Paper w={256} p="md" radius={0} bg="dark.7">
        <Stack>
          <Select
            label="Brush"
            data={Object.keys(brushes).map((key) => ({
              value: key,
              label: key.charAt(0).toUpperCase() + key.slice(1),
            }))}
            value={brushType}
            onChange={(value) => setBrushType(value as BrushType)}
          />

          {brushes[brushType].parameters.map((param) => (
            <ParameterControl key={param.label} parameter={param} />
          ))}
        </Stack>
      </Paper>

      <Flex direction="column" style={{ flex: 1 }}>
        <Box
          style={{ flex: 1, position: "relative", cursor: "none" }}
          ref={canvasContainerRef}
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
            style={{
              position: "absolute",
              top: 0,
              width: "1px",
              backgroundColor: "white",
              height: "100%",
              pointerEvents: "none",
              display: "none", // Initially hidden
            }}
          />
        </Box>

        <Paper h={80} p="md" radius={0} bg="dark.7">
          <Flex align="center" justify="center" gap="md">
            <NumberInput w={100} value={bpm} onChange={(val) => setBpm(Number(val))} />
            <ActionIcon onClick={handleTogglePlay} size="lg">
              {isPlaying ? <Square /> : <Play />}
            </ActionIcon>
            <Text ff="monospace" size="xl">
              {formatTime(playbackTime)}
            </Text>
          </Flex>
        </Paper>
      </Flex>

      <Paper w={256} p="md" radius={0} bg="dark.7">
        <Stack>
          <div>
            <Text size="sm">
              Brush Width:{" "}
              {brushWidth === Infinity ? "Full" : (brushWidth < 1 ? `1/${1 / brushWidth}` : brushWidth) + " beats"}
            </Text>
            <Slider
              label={null}
              min={-4}
              max={BRUSH_WIDTH_MAX_LOG2 + 1}
              step={1}
              value={brushWidth === Infinity ? BRUSH_WIDTH_MAX_LOG2 + 1 : Math.log2(brushWidth)}
              onChange={(val) => {
                if (val === BRUSH_WIDTH_MAX_LOG2 + 1) {
                  setBrushWidth(Infinity);
                } else {
                  setBrushWidth(Math.pow(2, val));
                }
              }}
            />
          </div>
          <div>
            <Text size="sm">Brush Height: {brushHeight === Infinity ? "Full" : `${brushHeight} semitones`}</Text>
            <Slider
              label={null}
              min={1}
              max={BRUSH_HEIGHT_MAX + 1}
              step={1}
              value={brushHeight === Infinity ? BRUSH_HEIGHT_MAX + 1 : brushHeight}
              onChange={(val) => {
                if (val === BRUSH_HEIGHT_MAX + 1) {
                  setBrushHeight(Infinity);
                } else {
                  setBrushHeight(val);
                }
              }}
            />
          </div>
          <div>
            <Text size="sm">Intensity: {(brushIntensity * 100).toFixed(0)}%</Text>
            <Slider label={null} min={0.01} max={1} step={0.01} value={brushIntensity} onChange={setBrushIntensity} />
          </div>
          <Switch
            checked={normalize}
            onChange={(e) => setNormalize(e.currentTarget.checked)}
            label="Normalize output"
          />
          <Switch checked={snapX} onChange={(e) => setSnapX(e.currentTarget.checked)} label="Snap Time" />
          <Switch checked={snapY} onChange={(e) => setSnapY(e.currentTarget.checked)} label="Snap Pitch" />
          <div>
            <Text size="sm">Grid X: {gridSize >= 1 ? `${gridSize} beats` : `1/${1 / gridSize} beats`}</Text>
            <Slider
              label={null}
              min={-6}
              max={2}
              step={1}
              value={Math.log2(gridSize)}
              onChange={(val) => setGridSize(Math.pow(2, val))}
            />
          </div>
          <div>
            <Text size="sm">Grid Y: {gridSizeY} semitones</Text>
            <Slider label={null} min={1} max={24} step={1} value={gridSizeY} onChange={setGridSizeY} />
          </div>
          <div>
            <Text size="sm">Zoom: {Math.pow(2, zoomPower).toFixed(2)}x</Text>
            <Slider label={null} min={0} max={4} step={0.1} value={zoomPower} onChange={setZoomPower} />
          </div>
          {zoomPower > 0 && (
            <div>
              <Text size="sm">Scroll</Text>
              <Slider label={null} min={0} max={1} step={0.001} value={scroll} onChange={setScroll} />
            </div>
          )}
          <div>
            <Text size="sm">Feather X: {(featherX * 100).toFixed(0)}%</Text>
            <Slider label={null} min={0} max={1} step={0.01} value={featherX} onChange={setFeatherX} />
          </div>
          <div>
            <Text size="sm">Feather Y: {(featherY * 100).toFixed(0)}%</Text>
            <Slider label={null} min={0} max={1} step={0.01} value={featherY} onChange={setFeatherY} />
          </div>
        </Stack>
      </Paper>
    </Flex>
  );
}

export default App;
