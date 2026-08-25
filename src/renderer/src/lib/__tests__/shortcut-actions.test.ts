import { beforeEach, describe, expect, it } from "vitest";

import { BEAT_VALUES, ONSETS_GRID_VALUE, PITCH_VALUES } from "../constants";
import type { EffectItem, EffectType } from "../../effects/types";
import { getEffectParameterDefaults, getParameterDef } from "../../parameters";
import { getParameterValue, useStore } from "../../store";
import { makeEmptyBrush } from "../../store/brush-factory";
import type { ParameterKey } from "../../store/types";
import { cycleParameterMark, randomizeBrush } from "../shortcut-actions";

const SIZE_TIME = "brushSizeTime" as ParameterKey;
const INTENSITY = "brushIntensity" as ParameterKey;

function effectItem(id: string, effect: EffectType): EffectItem {
  return { id, effect, enabled: true, params: getEffectParameterDefaults(effect) };
}

/** Puts a single brush with `effects` in its only step into the live store. */
function installBrush(...effects: EffectItem[]): void {
  const brush = makeEmptyBrush("test-palette");
  useStore.setState({
    brushes: [brush],
    activeBrushIndex: 0,
    activeStepIndex: 0,
    randomizationAmounts: {},
    excludedFromRandomization: [],
  });
  useStore.getState().setParameter("effects", effects);
}

const sizeTimeDef = getParameterDef(SIZE_TIME);
const sizeTimeMarks = (sizeTimeDef.kind === "number" ? (sizeTimeDef.marks ?? []) : [])
  .map((mark) => mark.value)
  .sort((a, b) => a - b);
const readSizeTime = () => getParameterValue(useStore.getState(), SIZE_TIME) as number;

describe("cycling a parameter through its marks", () => {
  beforeEach(() => installBrush());

  it("steps to the next mark above and below", () => {
    useStore.getState().setParameter(SIZE_TIME, sizeTimeMarks[3]);
    cycleParameterMark(SIZE_TIME, 1);
    expect(readSizeTime()).toBe(sizeTimeMarks[4]);
    cycleParameterMark(SIZE_TIME, -1);
    expect(readSizeTime()).toBe(sizeTimeMarks[3]);
  });

  it("lands on a mark from a value between two of them", () => {
    useStore.getState().setParameter(SIZE_TIME, (sizeTimeMarks[3] + sizeTimeMarks[4]) / 2);
    cycleParameterMark(SIZE_TIME, 1);
    expect(readSizeTime()).toBe(sizeTimeMarks[4]);
  });

  it("holds at the ends rather than wrapping round", () => {
    useStore.getState().setParameter(SIZE_TIME, sizeTimeMarks[sizeTimeMarks.length - 1]);
    cycleParameterMark(SIZE_TIME, 1);
    expect(readSizeTime()).toBe(sizeTimeMarks[sizeTimeMarks.length - 1]);

    useStore.getState().setParameter(SIZE_TIME, sizeTimeMarks[0]);
    cycleParameterMark(SIZE_TIME, -1);
    expect(readSizeTime()).toBe(sizeTimeMarks[0]);
  });
});

describe("randomising the brush", () => {
  const chain = () =>
    (getParameterValue(useStore.getState(), "effects") as EffectItem[]).map(({ id, enabled }) => ({ id, enabled }));

  beforeEach(() => installBrush(effectItem("blur-a", "blur"), effectItem("dyn", "dynamics")));

  it("leaves the effect chain's order and enabled states alone", () => {
    const before = chain();
    randomizeBrush(false);
    expect(chain()).toEqual(before);
  });

  it("holds back the parameters the user excluded", () => {
    useStore.setState({ excludedFromRandomization: [INTENSITY as string] });
    useStore.getState().setParameter(INTENSITY, 42);
    randomizeBrush(true);
    expect(getParameterValue(useStore.getState(), INTENSITY)).toBe(42);
  });

  it("skips a section whose amount is down to nothing", () => {
    useStore.setState({ randomizationAmounts: { "section-Envelope": 0 } });
    useStore.getState().setParameter(INTENSITY, 42);
    randomizeBrush(false);
    expect(getParameterValue(useStore.getState(), INTENSITY)).toBe(42);
  });
});

describe("cycling the grid", () => {
  const GRID_BEATS = "gridSizeBeats" as ParameterKey;
  const GRID_SEMIS = "gridSizeSemis" as ParameterKey;
  const read = (key: ParameterKey) => getParameterValue(useStore.getState(), key) as number;

  beforeEach(() => installBrush());

  it("reaches the stops that sit outside the beat and semitone tables", () => {
    useStore.getState().setParameter(GRID_SEMIS, PITCH_VALUES[0].value);
    cycleParameterMark(GRID_SEMIS, -1);
    expect(read(GRID_SEMIS)).toBe(0);

    useStore.getState().setParameter(GRID_BEATS, BEAT_VALUES[0].value);
    cycleParameterMark(GRID_BEATS, -1);
    expect(read(GRID_BEATS)).toBe(ONSETS_GRID_VALUE);
  });

  it("steps from a value the control left between two stops", () => {
    useStore.getState().setParameter(GRID_SEMIS, 5.5);
    cycleParameterMark(GRID_SEMIS, -1);
    expect(read(GRID_SEMIS)).toBe(5);

    useStore.getState().setParameter(GRID_SEMIS, 5.5);
    cycleParameterMark(GRID_SEMIS, 1);
    expect(read(GRID_SEMIS)).toBe(6);
  });
});
