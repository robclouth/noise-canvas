import type { ZustandGet, ZustandSet } from "./types";

export interface LinkState {
  linkEnabled: boolean;
  linkQuantum: number;
  linkLatencyMs: number;

  linkTempo: number;
  linkIsPlaying: boolean;
  linkNumPeers: number;

  setLinkEnabled: (enabled: boolean) => void;
  setLinkQuantum: (quantum: number) => void;
  setLinkLatencyMs: (ms: number) => void;

  onLinkTempoChanged: (tempo: number) => void;
  onLinkStartStopChanged: (isPlaying: boolean) => void;
  onLinkNumPeersChanged: (numPeers: number) => void;
}

export const LINK_PERSISTED_KEYS = ["linkEnabled", "linkQuantum", "linkLatencyMs"] as const;

export const createLinkSlice = (set: ZustandSet, _get: ZustandGet): LinkState => ({
  linkEnabled: false,
  linkQuantum: 4,
  linkLatencyMs: 0,
  linkTempo: 120,
  linkIsPlaying: false,
  linkNumPeers: 0,

  setLinkEnabled: (enabled) => set({ linkEnabled: enabled }),
  setLinkQuantum: (quantum) => set({ linkQuantum: quantum }),
  setLinkLatencyMs: (ms) => set({ linkLatencyMs: ms }),

  onLinkTempoChanged: (tempo) => set({ linkTempo: tempo }),
  onLinkStartStopChanged: (isPlaying) => set({ linkIsPlaying: isPlaying }),
  onLinkNumPeersChanged: (numPeers) => set({ linkNumPeers: numPeers }),
});
