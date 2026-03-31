import { describe, expect, it } from "vitest";
import { computeLinkOffset, computeSyncError } from "../link-sync";

describe("Link sync", () => {
  describe("computeLinkOffset", () => {
    it("phase 0 should map to loop start", () => {
      const { offset } = computeLinkOffset(0, 120, 120, 0, 2);
      expect(offset).toBeCloseTo(0, 5);
    });

    it("phase 0 should map to loop start with non-zero loopStart", () => {
      const { offset } = computeLinkOffset(0, 120, 120, 1.5, 3.5);
      expect(offset).toBeCloseTo(1.5, 5);
    });

    it("phase 2 at 120 BPM should map to 1 second into the loop", () => {
      // 2 beats at 120 BPM = 2 * 60/120 = 1 second
      const { offset } = computeLinkOffset(2, 120, 120, 0, 2);
      expect(offset).toBeCloseTo(1, 5);
    });

    it("phase should wrap within loop length", () => {
      // 4-beat phase at 120 BPM = 2 seconds, loop is 2 seconds → wraps to 0
      const { offset } = computeLinkOffset(4, 120, 120, 0, 2);
      expect(offset).toBeCloseTo(0, 5);
    });

    it("playback rate should be linkTempo / fileBpm", () => {
      const { playbackRate } = computeLinkOffset(0, 130, 120, 0, 2);
      expect(playbackRate).toBeCloseTo(130 / 120, 5);
    });

    it("different tempos should not affect the offset (only the rate)", () => {
      // Phase 2 beats = 2 beats into the bar, regardless of Link tempo
      // In the file's time domain: 2 * 60/140 = 0.857s
      const r1 = computeLinkOffset(2, 120, 140, 0, 1.714);
      const r2 = computeLinkOffset(2, 160, 140, 0, 1.714);
      expect(r1.offset).toBeCloseTo(r2.offset, 5);
      // But rates differ
      expect(r1.playbackRate).not.toBeCloseTo(r2.playbackRate);
    });

    it("offset should always be within loop bounds", () => {
      for (let phase = 0; phase < 4; phase += 0.1) {
        const { offset } = computeLinkOffset(phase, 133, 140, 2.0, 3.714);
        expect(offset).toBeGreaterThanOrEqual(2.0);
        expect(offset).toBeLessThan(3.714 + 0.001);
      }
    });
  });

  describe("computeSyncError", () => {
    it("should report zero error for consistent phase advancement", () => {
      // At 120 BPM, 0.5 seconds = 1 beat of advancement
      // Phase goes from 1.0 to 2.0
      const error = computeSyncError(1.0, 2.0, 4, 0.5, 120, 120, 0, 2);
      expect(Math.abs(error)).toBeLessThan(0.001);
    });

    it("should report zero error with tempo mismatch (rate-adjusted)", () => {
      // Link at 130 BPM, file at 120 BPM, rate = 130/120
      // In 0.5 real seconds, Link advances 130/60 * 0.5 = 1.083 beats
      // Phase goes from 0 to 1.083
      const error = computeSyncError(0, 1.083, 4, 0.5, 130, 120, 0, 2);
      expect(Math.abs(error)).toBeLessThan(0.001);
    });

    it("should detect misalignment", () => {
      // Phase says we advanced 1 beat, but real time says we should have
      // advanced 2 beats worth. Error = 1 beat = 0.5 seconds at 120 BPM.
      const error = computeSyncError(0, 1.0, 4, 1.0, 120, 120, 0, 2);
      expect(Math.abs(error)).toBeCloseTo(0.5, 1);
    });

    it("should handle phase wrapping across quantum boundary", () => {
      // Phase wraps from 3.5 to 0.5 (crossed the bar)
      // That's 1 beat of advancement = 0.5 seconds at 120 BPM
      const error = computeSyncError(3.5, 0.5, 4, 0.5, 120, 120, 0, 2);
      expect(Math.abs(error)).toBeLessThan(0.001);
    });
  });

  describe("real-world scenarios", () => {
    it("user's reported case: 140 BPM file, 133 BPM Link", () => {
      // Loop: 0 to 6.857s (16 beats at 140 BPM)
      const fileBpm = 140;
      const linkTempo = 133;
      const loopStart = 0;
      const loopEnd = 6.857;

      // At phase 0 (downbeat), should start at loop start
      const r0 = computeLinkOffset(0, linkTempo, fileBpm, loopStart, loopEnd);
      expect(r0.offset).toBeCloseTo(loopStart, 3);
      expect(r0.playbackRate).toBeCloseTo(133 / 140, 5);

      // At phase 2 (half bar), should be 2 beats into the loop
      const r2 = computeLinkOffset(2, linkTempo, fileBpm, loopStart, loopEnd);
      const expectedOffset = 2 * 60 / fileBpm; // 0.857s
      expect(r2.offset).toBeCloseTo(expectedOffset, 3);
    });

    it("1-beat loop should cycle correctly with phase", () => {
      const fileBpm = 140;
      const oneBeat = 60 / fileBpm; // 0.4286s
      const loopStart = 0;
      const loopEnd = oneBeat;

      // Phase 0.5 should be halfway through the 1-beat loop
      const r = computeLinkOffset(0.5, 130, fileBpm, loopStart, loopEnd);
      expect(r.offset).toBeCloseTo(oneBeat / 2, 3);

      // Phase 1.0 should wrap back to loop start
      const r2 = computeLinkOffset(1.0, 130, fileBpm, loopStart, loopEnd);
      expect(r2.offset).toBeCloseTo(loopStart, 3);
    });
  });
});
