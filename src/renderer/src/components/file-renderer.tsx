import {
  brushHeightAtom,
  brushIntensityAtom,
  brushTypeAtom,
  brushWidthAtom,
  featherXAtom,
  featherYAtom,
  filesBpmAtom,
  gridSizeAtom,
  mouseUvAtom,
  offsetXAtom,
  offsetYAtom,
  OpenFile,
  panAtom,
  scrollAtom,
  sourceFileAtom,
  store,
  zoomPowerAtom,
} from "@/store";
import { useFBO, View } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { isSynthesizingAtom, runSynthesis } from "@renderer/audio-manager";
import { debounce } from "lodash-es";
import { forwardRef, memo, RefObject, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { brushes } from "./brushes";
import { CommonUniforms, unitsToUv } from "./brushes/common";
import { copyMaterial } from "./copy-material";
import { DisplayMaterial } from "./display-material";

interface FileRendererProps {
  file: OpenFile;
  viewRef: RefObject<HTMLDivElement | null>;
}

export interface FileRendererHandle {
  renderStroke: (x: number, y: number, preview: boolean) => void;
  getFBOData: () => Float32Array;
  setFBOData: (data: Float32Array) => void;
  getTextures: () => {
    packed: THREE.WebGLRenderTarget;
    inverse: THREE.DataTexture;
    metadata: THREE.DataTexture;
  } | null;
  restoreOriginal: () => void;
  synthesize: () => void;
}

export const FileRenderer = memo(
  forwardRef<FileRendererHandle, FileRendererProps>(({ file, viewRef }, ref) => {
    const { spectrogramData } = file;
    const { gl, camera, invalidate } = useThree();

    const [sourceFile, setSourceFile] = useState(() => store.get(sourceFileAtom));

    useEffect(() => {
      const unsub = store.sub(sourceFileAtom, () => {
        setSourceFile(store.get(sourceFileAtom));
      });
      return unsub;
    }, []);

    const [packedDataTex, setPackedDataTex] = useState<THREE.DataTexture | null>(null);
    const [originalPackedDataTex, setOriginalPackedDataTex] = useState<THREE.DataTexture | null>(null);
    const [inverseMapTex, setInverseMapTex] = useState<THREE.DataTexture | null>(null);
    const [metadataTex, setMetadataTex] = useState<THREE.DataTexture | null>(null);

    const sourceFileData = useRef<{
      packed?: THREE.DataTexture;
      meta?: THREE.DataTexture;
    }>({});

    const mouseUv = useRef<THREE.Vector2 | null>(null);
    const displayMode = useRef<"preview" | "committed">("committed");
    const applyStroke = useRef(false);

    useEffect(() => {
      const unsubMouseUv = store.sub(mouseUvAtom, () => {
        mouseUv.current = store.get(mouseUvAtom);
      });
      const unsubBpms = store.sub(filesBpmAtom, () => {
        invalidate();
      });
      return () => {
        unsubMouseUv();
        unsubBpms();
      };
    }, []);

    const displayMaterial = useMemo(() => new DisplayMaterial(), []);

    const mesh = useRef<THREE.Mesh>(null!);
    const { scene: fboScene, mesh: fboMesh } = useMemo(() => {
      const scene = new THREE.Scene();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
      scene.add(mesh);
      return { scene, mesh };
    }, []);

    const fbo1 = useFBO(spectrogramData.textureWidth, spectrogramData.textureHeight, {
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    });

    const fbo2 = useFBO(spectrogramData.textureWidth, spectrogramData.textureHeight, {
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    });

    const passFbo = useFBO(spectrogramData.textureWidth, spectrogramData.textureHeight, {
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    });

    const pingPong = useRef(0);
    const isInitialized = useRef(false);

    const strokeParams = useRef<{ x: number; y: number; preview: boolean } | null>(null);

    useEffect(() => {
      if (sourceFile && sourceFile.filePath !== file.filePath) {
        const { packedData, metadata, textureWidth, textureHeight, numBands } = sourceFile.spectrogramData;
        const packed = new THREE.DataTexture(
          packedData,
          textureWidth,
          textureHeight,
          THREE.RGBAFormat,
          THREE.FloatType,
        );
        packed.internalFormat = "RGBA32F";
        packed.minFilter = THREE.NearestFilter;
        packed.magFilter = THREE.NearestFilter;
        packed.needsUpdate = true;
        const meta = new THREE.DataTexture(metadata, numBands, 1, THREE.RGBFormat, THREE.FloatType);
        meta.internalFormat = "RGB32F";
        meta.minFilter = THREE.NearestFilter;
        meta.magFilter = THREE.NearestFilter;
        meta.needsUpdate = true;
        sourceFileData.current = { packed, meta };
      } else {
        sourceFileData.current = {};
      }

      return () => {
        sourceFileData.current.packed?.dispose();
        sourceFileData.current.meta?.dispose();
      };
    }, [sourceFile, file.filePath]);

    useEffect(() => {
      isInitialized.current = false;
      const { packedData, inverseMap, metadata, textureWidth, textureHeight, numBands } = spectrogramData;

      const packed = new THREE.DataTexture(packedData, textureWidth, textureHeight, THREE.RGBAFormat, THREE.FloatType);
      packed.internalFormat = "RGBA32F";
      packed.minFilter = THREE.NearestFilter;
      packed.magFilter = THREE.NearestFilter;
      packed.needsUpdate = true;

      const inverse = new THREE.DataTexture(inverseMap, textureWidth, textureHeight, THREE.RGFormat, THREE.FloatType);
      inverse.internalFormat = "RG32F";
      inverse.minFilter = THREE.NearestFilter;
      inverse.magFilter = THREE.NearestFilter;
      inverse.needsUpdate = true;

      const meta = new THREE.DataTexture(metadata, numBands, 1, THREE.RGBFormat, THREE.FloatType);
      meta.internalFormat = "RGB32F";
      meta.minFilter = THREE.NearestFilter;
      meta.magFilter = THREE.NearestFilter;
      meta.needsUpdate = true;

      setPackedDataTex(packed);
      setOriginalPackedDataTex(packed.clone());
      setInverseMapTex(inverse);
      setMetadataTex(meta);

      return () => {
        packed.dispose();
        inverse.dispose();
        meta.dispose();
        setPackedDataTex(null);
        setOriginalPackedDataTex(null);
        setInverseMapTex(null);
        setMetadataTex(null);
      };
    }, [
      spectrogramData.packedData,
      spectrogramData.inverseMap,
      spectrogramData.metadata,
      spectrogramData.textureWidth,
      spectrogramData.textureHeight,
      spectrogramData.numBands,
    ]);

    const debouncedSynthesis = useMemo(() => debounce(runSynthesis, 500, { leading: false, trailing: true }), []);

    useEffect(() => {
      return () => {
        debouncedSynthesis.cancel();
      };
    }, [debouncedSynthesis]);

    useFrame(({ gl, camera }) => {
      if (!fboMesh || !spectrogramData || !packedDataTex || !inverseMapTex || !metadataTex || !fbo1 || !fbo2) return;

      // Initial copy
      if (!isInitialized.current) {
        fboMesh.material = copyMaterial;
        copyMaterial.uniforms.inputTex.value = packedDataTex;

        gl.setRenderTarget(fbo1);
        gl.render(fboScene, camera);
        gl.setRenderTarget(null);

        isInitialized.current = true;
        pingPong.current = 0;

        invalidate();

        window.api.addUndoState({ data: spectrogramData.packedData.buffer, filePath: file.filePath });
        debouncedSynthesis(file, spectrogramData.packedData);
      }

      if (!sourceFile) return;

      const brushType = store.get(brushTypeAtom);
      const gridSize = store.get(gridSizeAtom);
      const zoomPower = store.get(zoomPowerAtom);
      const scroll = store.get(scrollAtom);
      const pan = store.get(panAtom);
      const brushIntensity = store.get(brushIntensityAtom);
      const offsetX = store.get(offsetXAtom);
      const offsetY = store.get(offsetYAtom);
      const featherX = store.get(featherXAtom);
      const featherY = store.get(featherYAtom);
      const brushWidth = store.get(brushWidthAtom);
      const brushHeight = store.get(brushHeightAtom);
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const sourceTotalDuration = sourceFile.spectrogramData.numFrames / sourceFile.spectrogramData.sampleRate;

      const textures = sourceFile.rendererRef.current?.getTextures();

      if (!textures) return;

      const currentReadFBO = pingPong.current === 0 ? fbo1 : fbo2;
      const bpms = store.get(filesBpmAtom);
      const bpm = bpms[file.filePath] || 120;
      const sourceBpm = bpms[sourceFile.filePath] || 120;

      const commonUniforms: CommonUniforms = {
        sourceSpectrogramTex: textures.packed.texture,
        sourceSpectrogramTextureSize: sourceFile.spectrogramData.packedTextureSize,
        sourceInverseMapTex: textures.inverse,
        sourceMetadataTex: textures.metadata,
        sourceMinFreq: sourceFile.spectrogramData.minFreq,
        sourceBandsPerOctave: sourceFile.spectrogramData.bandsPerOctave,
        sourceFrameCount: sourceFile.spectrogramData.numFrames,
        sourceBandCount: sourceFile.spectrogramData.numBands,
        sourceChannelCount: sourceFile.spectrogramData.numChannels,
        sourceSampleRate: sourceFile.spectrogramData.sampleRate,
        destSpectrogramTex: currentReadFBO.texture,
        destSpectrogramTextureSize: spectrogramData.packedTextureSize,
        destInverseMapTex: inverseMapTex,
        destMetadataTex: metadataTex,
        destMinFreq: spectrogramData.minFreq,
        destBandsPerOctave: spectrogramData.bandsPerOctave,
        destFrameCount: spectrogramData.numFrames,
        destBandCount: spectrogramData.numBands,
        destChannelCount: spectrogramData.numChannels,
        destSampleRate: spectrogramData.sampleRate,
        originalSpectrogramTex: originalPackedDataTex,
        viewZoomPower: zoomPower,
        viewOffset: scroll,
        brushCenterUv: mouseUv.current || new THREE.Vector2(-1, -1),
        brushSizeUv: mouseUv.current
          ? unitsToUv(
              brushWidth,
              brushHeight,
              bpm,
              totalDuration,
              spectrogramData.bandsPerOctave,
              spectrogramData.numBands,
            )
          : new THREE.Vector2(0, 0),
        featherX: featherX / 100,
        featherY: featherY / 100,
        brushIntensity: brushIntensity,
        pan,
        offsetUv: unitsToUv(
          offsetX,
          offsetY,
          sourceBpm,
          sourceTotalDuration,
          sourceFile.spectrogramData.bandsPerOctave,
          sourceFile.spectrogramData.numBands,
        ),
        pi: Math.PI,
      };

      // Render stroke
      if (strokeParams.current && applyStroke.current) {
        const source = textures.packed;

        const destination = pingPong.current === 0 ? fbo2 : fbo1;
        const { preview } = strokeParams.current;

        const brush = brushes[brushType];
        const numPasses = brush.materials.length;

        let readBuffer = source;
        let writeBuffer = passFbo;

        for (let i = 0; i < numPasses; i++) {
          const material = brush.materials[i];
          fboMesh.material = material;

          // The final pass always writes to the main destination buffer.
          // For a single-pass effect, this is met on the first iteration.
          if (i === numPasses - 1) {
            writeBuffer = destination;
          }

          commonUniforms.sourceSpectrogramTex = readBuffer.texture;
          brush.updateUniforms(commonUniforms, i);

          gl.setRenderTarget(writeBuffer);
          gl.render(fboScene, camera);

          // Swap buffers for the next pass
          [readBuffer, writeBuffer] = [writeBuffer, readBuffer];
        }

        gl.setRenderTarget(null);

        if (!preview) {
          pingPong.current = 1 - pingPong.current;
          displayMode.current = "committed";

          store.set(isSynthesizingAtom, true);
          const buffer = getFBOData();
          debouncedSynthesis(file, buffer);
        }
      }

      // Update display material
      const currentFBO = pingPong.current === 0 ? fbo1 : fbo2;
      const nextFBO = pingPong.current === 0 ? fbo2 : fbo1;

      const displayUniforms = {
        ...commonUniforms,
        sourceSpectrogramTex: displayMode.current === "committed" ? currentFBO.texture : nextFBO.texture,
        sourceInverseMapTex: inverseMapTex,
        sourceMetadataTex: metadataTex,
        sourceMinFreq: spectrogramData.minFreq,
        sourceBandsPerOctave: spectrogramData.bandsPerOctave,
        sourceFrameCount: spectrogramData.numFrames,
        sourceBandCount: spectrogramData.numBands,
        sourceChannelCount: spectrogramData.numChannels,
        sourceSampleRate: spectrogramData.sampleRate,
        sourceSpectrogramTextureSize: spectrogramData.packedTextureSize,
        gridSize: gridSize,
        bpm: bpm,
      };

      displayUniforms.bpm = bpm;

      for (const [key, value] of Object.entries(displayUniforms)) {
        if (displayMaterial.uniforms[key]) {
          displayMaterial.uniforms[key].value = value;
        }
      }

      if (applyStroke.current) applyStroke.current = false;
    });

    const getFBOData = (): Float32Array => {
      const { packedTextureSize } = spectrogramData;
      const fboToRead = pingPong.current === 0 ? fbo1 : fbo2;
      const buffer = new Float32Array(packedTextureSize.x * packedTextureSize.y * 4);
      gl.getContext().finish();
      gl.readRenderTargetPixels(fboToRead, 0, 0, packedTextureSize.x, packedTextureSize.y, buffer);
      return buffer;
    };

    const setFBOData = (data: Float32Array) => {
      if (!spectrogramData || !fbo1 || !fbo2 || !fboMesh) return;
      const { packedTextureSize } = spectrogramData;

      pingPong.current = 0;

      const dataTex = new THREE.DataTexture(
        data,
        packedTextureSize.x,
        packedTextureSize.y,
        THREE.RGBAFormat,
        THREE.FloatType,
      );
      dataTex.needsUpdate = true;

      gl.initTexture(dataTex);

      fboMesh.material = copyMaterial;
      copyMaterial.uniforms.inputTex.value = dataTex;

      gl.setRenderTarget(fbo1);
      gl.render(fboScene, camera);
      gl.setRenderTarget(null);

      dataTex.dispose();

      applyStroke.current = false;
      displayMode.current = "committed";

      invalidate();
    };

    const getTextures = (): {
      packed: THREE.WebGLRenderTarget;
      inverse: THREE.DataTexture;
      metadata: THREE.DataTexture;
    } | null => {
      if (!fbo1 || !fbo2 || !inverseMapTex || !metadataTex) return null;
      return {
        packed: pingPong.current === 0 ? fbo1 : fbo2,
        inverse: inverseMapTex,
        metadata: metadataTex,
      };
    };

    const restoreOriginal = () => {
      if (!spectrogramData || !fbo1 || !fbo2 || !fboMesh || !originalPackedDataTex) return;

      pingPong.current = 0;

      fboMesh.material = copyMaterial;
      copyMaterial.uniforms.inputTex.value = originalPackedDataTex;

      gl.setRenderTarget(fbo1);
      gl.render(fboScene, camera);
      gl.setRenderTarget(null);

      isInitialized.current = false;

      invalidate();
      debouncedSynthesis(file, getFBOData());
    };

    const synthesize = () => {
      store.set(isSynthesizingAtom, true);
      const buffer = getFBOData();
      debouncedSynthesis(file, buffer);
    };

    useImperativeHandle(ref, () => ({
      renderStroke: (x: number, y: number, preview: boolean) => {
        strokeParams.current = { x, y, preview };
        if (preview) {
          displayMode.current = "preview";
        }
        applyStroke.current = true;

        invalidate();
      },
      getFBOData,
      setFBOData,
      getTextures,
      restoreOriginal,
      synthesize,
    }));

    if (!spectrogramData) {
      return null;
    }

    return (
      <View track={viewRef as RefObject<HTMLElement>}>
        <mesh ref={mesh}>
          <planeGeometry args={[2, 2]} />
          <primitive object={displayMaterial} attach="material" />
        </mesh>
      </View>
    );
  }),
);

FileRenderer.displayName = "FileRenderer";
