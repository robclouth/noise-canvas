export interface LinkPhaseOffset {
  offset: number;
  playbackRate: number;
}

export function computeLinkOffset(
  phaseBeats: number,
  linkTempo: number,
  fileBpm: number,
  loopStart: number,
  loopEnd: number,
): LinkPhaseOffset {
  const secondsPerBeat = 60 / fileBpm;
  const loopLen = loopEnd - loopStart;
  const phaseSeconds = phaseBeats * secondsPerBeat;
  const offset = loopStart + (loopLen > 0 ? phaseSeconds % loopLen : 0);
  const playbackRate = linkTempo / fileBpm;
  return { offset, playbackRate };
}

export function computeSyncError(
  phase1: number,
  phase2: number,
  quantum: number,
  elapsedRealSeconds: number,
  linkTempo: number,
  fileBpm: number,
  loopStart: number,
  loopEnd: number,
): number {
  const r1 = computeLinkOffset(phase1, linkTempo, fileBpm, loopStart, loopEnd);
  const r2 = computeLinkOffset(phase2, linkTempo, fileBpm, loopStart, loopEnd);

  const loopLen = loopEnd - loopStart;
  const expectedAdvance = elapsedRealSeconds * r1.playbackRate;
  let actualAdvance = r2.offset - r1.offset;
  if (actualAdvance < 0) actualAdvance += loopLen;

  const expectedMod = expectedAdvance % loopLen;
  let error = actualAdvance - expectedMod;
  if (error > loopLen / 2) error -= loopLen;
  if (error < -loopLen / 2) error += loopLen;

  return error;
}
