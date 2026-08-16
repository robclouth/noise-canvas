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
  connect: () => {},
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
    link: {
      isEnabled: () => true,
      captureState: () => ({ tempo: 120, beat: 3.5, phase: 0.5 }),
    },
  },
}));

vi.mock("../../store/files", () => ({
  openFiles: files.openFiles,
  activeLoopRegion: () => null,
}));

import { createAudioSlice } from "../../store/audio";
import type { State, ZustandGet, ZustandSet } from "../../store/types";

/**
 * The Link start path takes the playback position modulo the span it is syncing
 * to. A zero-length buffer or loop makes that modulo NaN, and the NaN reaches
 * player.start as its offset.
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
    isPlaying: false,
    loop: false,
    linkEnabled: true,
    linkTempo: 120,
    linkQuantum: 4,
    linkLatencyMs: 0,
    filepathsBpm: { "/audio/a.wav": 120 },
    filesPlaybackStartTime: { f1: 0 },
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

describe("Link start with a zero-length span", () => {
  beforeEach(() => {
    player.started = [];
    for (const id of Object.keys(files.openFiles)) delete files.openFiles[id];
  });

  it("never hands player.start a NaN offset", async () => {
    const { audio } = makeStore();
    openFile(0);

    await audio.togglePlayback();

    for (const args of player.started) {
      for (const value of args) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("still phase-aligns a file that has a length", async () => {
    const { audio } = makeStore();
    openFile(4);

    await audio.togglePlayback();

    expect(player.started.length).toBeGreaterThan(0);
    const [, offset] = player.started[0];
    expect(Number.isFinite(offset)).toBe(true);
    // 3.5 beats at 120 BPM is 1.75 s, inside a 4 s file.
    expect(offset).toBeCloseTo(1.75, 6);
  });
});
