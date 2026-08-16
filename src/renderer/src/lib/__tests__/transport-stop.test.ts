import { beforeEach, describe, expect, it, vi } from "vitest";

// The player Tone hands back, with the state the handler reads.
const player = vi.hoisted(() => ({
  state: "started" as "started" | "stopped",
  onstop: (() => {}) as () => void,
  volume: { value: 0 },
  connect: () => {},
  toDestination() {
    return this;
  },
}));

vi.mock("tone", () => ({
  Player: class {
    constructor() {
      return player;
    }
  },
  Meter: class {
    getValue() {
      return 0;
    }
  },
  now: () => 0,
  getContext: () => ({ rawContext: { state: "running" } }),
  getTransport: () => ({ bpm: { value: 120 } }),
  start: async () => {},
}));
vi.mock("../host", () => ({ host: { env: { platform: "darwin" }, link: undefined } }));
vi.mock("../../store/files", () => ({ openFiles: {}, activeLoopRegion: () => null }));

import { createAudioSlice } from "../../store/audio";
import type { State, ZustandGet, ZustandSet } from "../../store/types";

/**
 * Tone stops the outgoing source on every restart, so the player's stop
 * callback fires for a buffer hot-swap or a scrub as well as for the end of the
 * file. Only the end leaves no source running — a position test cannot tell the
 * two apart when a restart lands within a fade of the end.
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
    isPlaying: true,
    loop: false,
    stopAudio: vi.fn(),
    ...overrides,
  } as unknown as State;

  return { get, state: () => state };
}

describe("the player's stop callback", () => {
  beforeEach(() => {
    player.state = "started";
    player.onstop = () => {};
  });

  it("stops the transport when the file has played to its end", () => {
    const { get } = makeStore();
    get().getPlayer();

    // Nothing is running: the source ended rather than being replaced.
    player.state = "stopped";
    player.onstop();

    expect(get().stopAudio).toHaveBeenCalled();
  });

  it("keeps playing when a restart replaced the source", () => {
    const { get } = makeStore();
    get().getPlayer();

    // A buffer hot-swap or a scrub already started the incoming source before
    // the outgoing one's stop callback arrives.
    player.state = "started";
    player.onstop();

    expect(get().stopAudio).not.toHaveBeenCalled();
  });

  it("leaves a looping transport alone at the end of a pass", () => {
    const { get } = makeStore({ loop: true });
    get().getPlayer();

    player.state = "stopped";
    player.onstop();

    expect(get().stopAudio).not.toHaveBeenCalled();
  });

  it("does nothing once the transport is already stopped", () => {
    const { get } = makeStore({ isPlaying: false });
    get().getPlayer();

    player.state = "stopped";
    player.onstop();

    expect(get().stopAudio).not.toHaveBeenCalled();
  });
});
