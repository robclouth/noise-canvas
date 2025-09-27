import { Texture, Vector2 } from "three";

export type ParameterUniform = {
  value: number;
  minValue: number;
  maxValue: number;
  modulationAmount: number;
};

export type CommonUniforms = {
  sourceSpectrogramTex: Texture;
  sourceSpectrogramTextureSize: Vector2;
  sourceInverseMapTex: Texture;
  sourceMetadataTex: Texture;
  sourceMinFreq: number;
  sourceBandsPerOctave: number;
  sourceFrameCount: number;
  sourceBandCount: number;
  sourceChannelCount: number;
  sourceSampleRate: number;
  destSpectrogramTex: Texture;
  destSpectrogramTextureSize: Vector2;
  destInverseMapTex: Texture;
  destMetadataTex: Texture;
  destMinFreq: number;
  destBandsPerOctave: number;
  destFrameCount: number;
  destBandCount: number;
  destChannelCount: number;
  destSampleRate: number;
  originalSpectrogramTex: Texture | null;
  brushCenterUv: Vector2;
  brushSizeUv: Vector2;
  viewZoomPower: number;
  viewOffset: number;
  featherX: number;
  featherY: number;
  brushIntensity: ParameterUniform;
  offsetUv: Vector2;
  pan: number;
  panMod: number;
  bpm: number;
  blendMode: number;
  modulatorMode: number;
  modulatorPatternShape: number;
  modulatorPatternRate: Vector2;
  modulatorPatternRadial: boolean;
};

export const defaultValues: CommonUniforms = {
  sourceSpectrogramTex: new Texture(),
  sourceInverseMapTex: new Texture(),
  sourceMetadataTex: new Texture(),
  sourceFrameCount: 0,
  sourceBandCount: 0,
  sourceSpectrogramTextureSize: new Vector2(0, 0),
  sourceChannelCount: 1,
  sourceSampleRate: 44100.0,
  sourceMinFreq: 20.0,
  sourceBandsPerOctave: 24.0,
  destSpectrogramTex: new Texture(),
  destInverseMapTex: new Texture(),
  destMetadataTex: new Texture(),
  destFrameCount: 0,
  destBandCount: 0,
  destSpectrogramTextureSize: new Vector2(0, 0),
  destChannelCount: 1,
  destSampleRate: 44100.0,
  destMinFreq: 20.0,
  destBandsPerOctave: 24.0,
  originalSpectrogramTex: new Texture(),
  brushCenterUv: new Vector2(0.5, 0.5),
  brushSizeUv: new Vector2(0.1, 0.1),
  viewZoomPower: 0.0,
  viewOffset: 0.0,
  featherX: 0.5,
  featherY: 0.5,
  brushIntensity: {
    value: 1.0,
    minValue: 0.0,
    maxValue: 1.0,
    modulationAmount: 0.0,
  },
  offsetUv: new Vector2(0, 0),
  pan: 0.0,
  panMod: 0.0,
  bpm: 120.0,
  blendMode: 0,
  modulatorMode: 0,
  modulatorPatternShape: 0,
  modulatorPatternRate: new Vector2(1.0, 1.0),
  modulatorPatternRadial: false,
};

export function unitsToUv(
  beats: number,
  semitones: number,
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  numBands: number,
): Vector2 {
  const seconds = beats * (60.0 / bpm);
  const u = seconds / totalDuration;

  const bandsPerSemitone = bandsPerOctave / 12;
  const shiftInBands = semitones * bandsPerSemitone;
  const v = shiftInBands / numBands;

  return new Vector2(u, v);
}

export function uvToUnits(
  u: number,
  v: number,
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  numBands: number,
) {
  const seconds = u * totalDuration;
  const beats = seconds / (60.0 / bpm);

  const bandsPerSemitone = bandsPerOctave / 12;
  const semitones = (v * numBands) / bandsPerSemitone;

  return [beats, semitones];
}

export const screenToZoomed = (screenUv: Vector2, viewZoomPower: number, viewOffset: number): Vector2 => {
  const zoom = Math.pow(2, viewZoomPower);
  if (zoom <= 1) {
    return screenUv.clone();
  }
  const viewWidth = 1.0 / zoom;
  const viewStartX = viewOffset * (1.0 - viewWidth);
  return new Vector2(viewStartX + screenUv.x * viewWidth, screenUv.y);
};

export const zoomedToScreen = (zoomedUv: Vector2, viewZoomPower: number, viewOffset: number): Vector2 => {
  const zoom = Math.pow(2, viewZoomPower);
  if (zoom <= 1) {
    return zoomedUv.clone();
  }
  const viewWidth = 1.0 / zoom;
  const viewStartX = viewOffset * (1.0 - viewWidth);
  return new Vector2((zoomedUv.x - viewStartX) / viewWidth, zoomedUv.y);
};
