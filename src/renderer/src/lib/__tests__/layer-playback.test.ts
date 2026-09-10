import { beforeEach, describe, expect, it, vi } from "vitest";

/** One Tone player, recording what it was asked to play. */
interface FakePlayer {
  state: "started" | "stopped";
  buffer: { get: () => unknown } | null;
  playbackRate: number;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  volume: { value: number };
  gainNode: FakeGain | null;
  started: number[][];
  stopped: boolean;
  disposed: boolean;
  onstop: () => void;
  stop: () => void;
  dispose: () => void;
  connect: (gain: FakeGain) => FakePlayer;
  toDestination: () => FakePlayer;
  start: (...args: number[]) => void;
  restart: (...args: number[]) => void;
}

interface FakeGain {
  gain: { value: number; rampTo: (value: number) => void; setValueAtTime: (value: number) => void };
  dispose: () => void;
  connect: () => FakeGain;
  toDestination: () => FakeGain;
}

const made = vi.hoisted(() => ({ players: [] as unknown[], gains: [] as unknown[] }));
const files = vi.hoisted(() => ({ openFiles: {} as Record<string, unknown> }));

vi.mock("tone", () => {
  class Gain {
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
    constructor() {
      made.gains.push(this);
    }
  }

  class Player {
    state: "started" | "stopped" = "stopped";
    // Tone always hands back a ToneAudioBuffer, empty until one is assigned.
    buffer: { get: () => unknown } = { get: () => undefined };
    playbackRate = 1;
    loop = false;
    loopStart = 0;
    loopEnd = 0;
    volume = { value: 0 };
    gainNode: unknown = null;
    started: number[][] = [];
    stopped = false;
    disposed = false;
    onstop: () => void = () => {};
    constructor() {
      made.players.push(this);
    }
    stop() {
      this.stopped = true;
      this.state = "stopped";
    }
    dispose() {
      this.disposed = true;
    }
    connect(gain: unknown) {
      this.gainNode = gain;
      return this;
    }
    toDestination() {
      return this;
    }
    start(...args: number[]) {
      this.started.push(args);
      this.state = "started";
    }
    restart(...args: number[]) {
      this.started.push(args);
      this.state = "started";
    }
  }

  return {
    Player,
    Gain,
    ToneAudioBuffer: class {
      constructor(private readonly buffer: unknown) {}
      get() {
        return this.buffer;
      }
    },
    Meter: class {
      getValue() {
        return 0;
      }
    },
    now: () => 0,
    getContext: () => ({ rawContext: { state: "running", currentTime: 0 } }),
    getTransport: () => ({ bpm: { value: 120 }, setLoopPoints: () => {} }),
    start: async () => {},
  };
});

vi.mock("../host", () => ({
  host: { env: { platform: "darwin" }, link: { isEnabled: () => false } },
}));

vi.mock("../../store/files", () => ({
  openFiles: files.openFiles,
  activeLoopRegion: (state: { activeFileId: string | null; filesLoopRegion: Record<string, unknown> }) =>
    state.activeFileId ? (state.filesLoopRegion?.[state.activeFileId] ?? null) : null,
}));

import { createAudioSlice, releaseLayerVoices } from "../../store/audio";
import type { State, ZustandGet, ZustandSet } from "../../store/types";

/**
 * The layers of one stack sound together. Each takes its own player behind its
 * own gain, and every one of them starts on the same instant.
 */

const STACK = {
  g1: {
    id: "g1",
    method: "hpss" as const,
    label: "loop",
    originId: null,
    layerIds: ["f1", "f2", "f3"],
    hue: 200,
    syncView: true,
  },
};

function fakeBuffer(duration: number): unknown {
  return { duration, numberOfChannels: 1, length: duration * 48000, sampleRate: 48000 };
}

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
    layerStacks: STACK,
    stackOfLayer: { f1: "g1", f2: "g1", f3: "g1" },
    filesMuted: {},
    filesSoloed: {},
    filesVolumeDb: {},
    isPlaying: false,
    loop: false,
    linkEnabled: false,
    filepathsBpm: {},
    filesPlaybackStartTime: { f1: 0, f2: 0, f3: 0 },
    filesSelection: {},
    filesLoopRegion: {},
    selectionAudition: false,
    ...overrides,
  } as unknown as State;

  return { get };
}

/** The player each layer ended up with, by the order the voices were made. */
function playersByLayer(): FakePlayer[] {
  return made.players as FakePlayer[];
}

function gainOf(player: FakePlayer): number {
  return (player.gainNode as FakeGain).gain.value;
}

describe("playing a stack of layers", () => {
  beforeEach(() => {
    releaseLayerVoices();
    made.players.length = 0;
    made.gains.length = 0;
    files.openFiles.f1 = { id: "f1", filePath: "/a.wav", displayName: "a", audioBuffer: fakeBuffer(10) };
    files.openFiles.f2 = { id: "f2", filePath: "/b.wav", displayName: "b", audioBuffer: fakeBuffer(10) };
    files.openFiles.f3 = { id: "f3", filePath: "/c.wav", displayName: "c", audioBuffer: fakeBuffer(10) };
  });

  it("gives every layer a player, started on the same instant", async () => {
    const { get } = makeStore();
    await get().togglePlayback();

    const players = playersByLayer();
    expect(players).toHaveLength(3);
    for (const player of players) {
      expect(player.started).toHaveLength(1);
      expect(player.started[0][0]).toBe(0);
      expect(player.started[0][1]).toBe(0);
    }
  });

  it("holds a muted layer down and leaves the rest up", async () => {
    const { get } = makeStore({ filesMuted: { f2: true } } as Partial<State>);
    await get().togglePlayback();

    const [active, second, third] = playersByLayer();
    expect(gainOf(active)).toBe(1);
    expect(gainOf(second)).toBe(0);
    expect(gainOf(third)).toBe(1);
  });

  it("holds everything a solo leaves out down", async () => {
    const { get } = makeStore({ filesSoloed: { f3: true } } as Partial<State>);
    await get().togglePlayback();

    const [active, second, third] = playersByLayer();
    expect(gainOf(active)).toBe(0);
    expect(gainOf(second)).toBe(0);
    expect(gainOf(third)).toBe(1);
  });

  it("follows a mute made while the stack plays", async () => {
    const { get } = makeStore();
    await get().togglePlayback();
    const [, second] = playersByLayer();
    expect(gainOf(second)).toBe(1);

    // What the mute button does: write the flag, then push the mix down.
    get().filesMuted.f2 = true;
    get().applyLayerGains();

    expect(gainOf(second)).toBe(0);
  });

  it("leaves the other layers running when one layer's audio is swapped", async () => {
    const { get } = makeStore();
    await get().togglePlayback();
    const [, second, third] = playersByLayer();
    const before = [second.started.length, third.started.length];

    // What a commit does: the painted layer's buffer is replaced under the
    // running mix.
    get().swapPlayingBufferRaw(fakeBuffer(10) as AudioBuffer);

    expect([second.started.length, third.started.length]).toEqual(before);
  });

  it("plays a layer too short for a looped window once instead of looping it", async () => {
    files.openFiles.f3 = { id: "f3", filePath: "/c.wav", displayName: "c", audioBuffer: fakeBuffer(4) };
    const { get } = makeStore({ loop: true } as Partial<State>);
    await get().togglePlayback();

    const [, second, third] = playersByLayer();
    expect(second.loop).toBe(true);
    expect(third.loop).toBe(false);
    // It plays its own length rather than the window's.
    expect(third.started[0][2]).toBe(4);
  });

  it("drops the layers of a stack it has left", async () => {
    const { get } = makeStore();
    await get().togglePlayback();
    const [, second, third] = playersByLayer();

    get().stopAudio();

    expect(second.disposed).toBe(true);
    expect(third.disposed).toBe(true);
  });
  it("releases voices removed from the playing stack", async () => {
    const { get } = makeStore();
    await get().togglePlayback();
    const [active, second, third] = playersByLayer();
    get().layerStacks = { g1: { ...get().layerStacks.g1, layerIds: ["f1", "f3"] } };
    get().reconcileLayerPlayback();
    expect(second.disposed).toBe(true);
    expect(active.state).toBe("started");
    expect(third.state).toBe("started");
  });

  it("releases a closed background file and keeps the mix playing", async () => {
    const { get } = makeStore();
    await get().togglePlayback();
    const [, second] = playersByLayer();
    delete files.openFiles.f2;
    get().reconcileLayerPlayback();
    expect(second.disposed).toBe(true);
    expect(get().isPlaying).toBe(true);
  });

  it("stops and releases the previous stack when the active file leaves it", async () => {
    const { get } = makeStore();
    await get().togglePlayback();
    const players = playersByLayer();
    get().activeFileId = "outside";
    get().reconcileLayerPlayback();
    expect(get().isPlaying).toBe(false);
    expect(get().player).toBeNull();
    expect(players.every((player) => player.disposed)).toBe(true);
  });

  it("stops every voice even after the last file closes", async () => {
    const { get } = makeStore();
    await get().togglePlayback();
    const players = playersByLayer();
    get().activeFileId = null;
    get().stopAudio();
    expect(get().isPlaying).toBe(false);
    expect(players.every((player) => player.stopped && player.disposed)).toBe(true);
    expect(get().player).toBeNull();
  });

  it("keeps sibling playback running when the paint target changes", async () => {
    const { get } = makeStore();
    await get().togglePlayback();
    const [, second] = playersByLayer();
    get().activeFileId = "f2";
    get().reconcileLayerPlayback();
    expect(get().isPlaying).toBe(true);
    expect(get().player).toBe(second);
    expect(playersByLayer().every((player) => !player.disposed)).toBe(true);
  });

  it("releases the other-layer hold when a buffer swap throws", async () => {
    const { get } = makeStore();
    await get().togglePlayback();
    const [, second] = playersByLayer();
    const seek = get().setPlaybackTime;
    get().setPlaybackTime = () => {
      throw new Error("seek failed");
    };
    expect(() => get().swapPlayingBufferRaw(fakeBuffer(10) as AudioBuffer)).toThrow("seek failed");
    get().setPlaybackTime = seek;
    const before = second.started.length;
    get().setPlaybackTime(2);
    expect(second.started.length).toBe(before + 1);
  });
});
