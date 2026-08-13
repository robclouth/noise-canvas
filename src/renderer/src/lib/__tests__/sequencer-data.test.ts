import { describe, expect, it } from "vitest";

const BPM = 120;
const DURATION = 4;
const BANDS_PER_OCTAVE = 12;
const NUM_BANDS = 48;
const STEPS = 4;

/** The first row of the sequencer's data texture, as the shader would sample it. */
async function seqTextureRow(seqData: string): Promise<number[]> {
  const { createStepStateView, useStore } = await import("../../store");
  const { buildModulatorUniforms } = await import("../modulator-utils");
  const { MAX_SEQ_STEPS_X } = await import("../constants");

  const { setParameter } = useStore.getState();
  setParameter("modulator1Mode", 2);
  setParameter("modulator1SeqStepsX", STEPS);
  setParameter("modulator1SeqStepsY", 1);
  setParameter("modulator1SeqData", seqData);

  const state = useStore.getState();
  const [modulator] = buildModulatorUniforms(
    BPM,
    DURATION,
    BANDS_PER_OCTAVE,
    NUM_BANDS,
    createStepStateView(state, state.activeStepIndex),
  );
  const data = modulator.seqDataTex.image.data as Float32Array;
  return Array.from(data.subarray(0, MAX_SEQ_STEPS_X)).slice(0, STEPS);
}

describe("sequencer data", () => {
  it("silences a step that is switched off, and leaves the others alone", async () => {
    const row = await seqTextureRow(
      JSON.stringify({ values: [[1, 0.5, 0.25, 0.75]], off: [[false, true, false, false]] }),
    );
    expect(row).toEqual([1, 0, 0.25, 0.75]);
  });

  it("plays a switched-off step's own value again once it is switched back on", async () => {
    const values = [[1, 0.5, 0.25, 0.75]];
    await seqTextureRow(JSON.stringify({ values, off: [[false, true, false, false]] }));
    const row = await seqTextureRow(JSON.stringify({ values, off: [[false, false, false, false]] }));
    expect(row).toEqual([1, 0.5, 0.25, 0.75]);
  });

  it("reads grids stored before steps could be switched off", async () => {
    expect(await seqTextureRow(JSON.stringify({ values: [[1, 0, 1, 0.5]] }))).toEqual([1, 0, 1, 0.5]);
  });
});
