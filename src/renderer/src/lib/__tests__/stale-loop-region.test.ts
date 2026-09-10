import { beforeEach, describe, expect, it, vi } from "vitest";

const player = vi.hoisted(() => ({
  state: "stopped" as "started" | "stopped",
  buffer: null as unknown,
  playbackRate: 1,
  loop: false,
  loopStart: 0,
  loopEnd: 0,
  volume: { value: 0 },
  started: [] as number[][],
  onstop: (() => {}) as () => void,
  stop: () => {},
  dispose: () => {},
  connect() {
    return this;
  },
  toDestination() {
    return this;
  },
  start(...args: number[]) {
    player.started.push(args);
  },
  restart(...args: number[]) {
    player.started.push(args);
  },
}));

const files = vi.hoisted(() => ({ openFiles: {} as Record<string, unknown> }));

vi.mock("tone", () => ({
  Player: class {
    constructor() {
      return player;
    }
  },
  ToneAudioBuffer: class {},
  Gain: class {
    gain = {
      value: 1,
      rampTo(value: number) {
        this.value = value;
      },
      setValueAtTime(value: number) {
        this.value = value;
      },
    };
    dispose() {
      this.gain.value = 0;
    }
    connect() {
      return this;
    }
    toDestination() {
      return this;
    }
  },
  Meter: class {
    getValue() {
      return 0;
    }
  },
  now: () => 0,
  getContext: () => ({ rawContext: { state: "running", currentTime: 0 } }),
  getTransport: () => ({ bpm: { value: 120 } }),
  start: async () => {},
}));

vi.mock("../host", () => ({
  host: {
    env: { platform: "darwin" },
    link: { isEnabled: () => false },
  },
}));

vi.mock("../../store/files", () => ({
  openFiles: files.openFiles,
  activeLoopRegion: (state: { activeFileId: string | null; filesLoopRegion: Record<string, LoopRegion | null> }) =>
    state.activeFileId ? (state.filesLoopRegion?.[state.activeFileId] ?? null) : null,
}));

import { createAudioSlice, releaseLayerVoices } from "../../store/audio";
import type { LoopRegion, State, ZustandGet, ZustandSet } from "../../store/types";

/**
 * A loop region measured against an older, longer file can outlive a resize.
 * Playback must bound the window by the buffer instead of handing Tone loop
 * points past the end.
 */

function makeStore(overrides: Partial<State> = {}) {
  let state: State;
  const set: ZustandSet = (partial) => {
    const next = typeof partial === "function" ? partial(state) : partial;
    state = next === state ? state : ({ ...state, ...next } as State);
  };
  const get: ZustandGet = () => state;

  const audio = createAudioSlice(set, get);
  state = {
    ...audio,
    activeFileId: "f1",
    fileGroups: {},
    fileGroupOfFile: {},
    filesMuted: {},
    filesSoloed: {},
    filesVolumeDb: {},
    isPlaying: false,
    loop: true,
    linkEnabled: false,
    filepathsBpm: { "/audio/a.wav": 120 },
    filesPlaybackStartTime: { f1: 0 },
    filesSelection: {},
    filesLoopRegion: {},
    stopAudio: vi.fn(),
    ...overrides,
  } as unknown as State;

  return { get, audio };
}

function openFile(durationSeconds: number) {
  files.openFiles["f1"] = {
    id: "f1",
    filePath: "/audio/a.wav",
    audioBuffer: {
      duration: durationSeconds,
      numberOfChannels: 1,
      sampleRate: 48000,
      length: Math.round(durationSeconds * 48000),
      getChannelData: () => new Float32Array(1),
    },
  };
}

describe("playback with a loop region past the buffer", () => {
  beforeEach(() => {
    releaseLayerVoices();
    player.started = [];
    player.loop = false;
    player.loopStart = 0;
    player.loopEnd = 0;
    for (const id of Object.keys(files.openFiles)) delete files.openFiles[id];
  });

  it("keeps the loop points and offset inside the buffer", async () => {
    const { audio } = makeStore({
      filesLoopRegion: { f1: { start: 2.5, end: 4 } },
      filesPlaybackStartTime: { f1: 2.5 },
    } as Partial<State>);
    openFile(2.5);

    await audio.togglePlayback();

    expect(player.loopEnd).toBeLessThanOrEqual(2.5);
    expect(player.loopStart).toBeLessThanOrEqual(player.loopEnd);
    expect(player.started.length).toBeGreaterThan(0);
    const [, offset] = player.started[0];
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThanOrEqual(2.5);
  });

  it("clamps a loop end past the buffer while keeping a valid start", async () => {
    const { audio } = makeStore({
      filesLoopRegion: { f1: { start: 1, end: 4 } },
      filesPlaybackStartTime: { f1: 1.5 },
    } as Partial<State>);
    openFile(2.5);

    await audio.togglePlayback();

    expect(player.loopStart).toBe(1);
    expect(player.loopEnd).toBe(2.5);
    const [, offset] = player.started[0];
    expect(offset).toBe(1.5);
  });
});
