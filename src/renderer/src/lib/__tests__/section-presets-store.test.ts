import { describe, expect, it, vi } from "vitest";

vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("@renderer/lib/factory-section-presets", () => ({ factorySectionPresets: [] }));
vi.mock("@renderer/lib/folders", () => ({ getFolders: vi.fn() }));
vi.mock("@renderer/lib/host", () => ({
  host: { fs: {}, path: { join: (...parts: string[]) => parts.join("/") }, env: { platform: "darwin" } },
}));
vi.mock("@renderer/store", () => ({ getEffectParameterValue: vi.fn(), getParameterValue: vi.fn() }));
vi.mock("@renderer/store/files", () => ({ openReferencedPaths: vi.fn() }));

import type { SectionPreset, SectionTarget } from "../section-presets";
import { createSectionPresetsSlice } from "../../store/section-presets";
import { openReferencedPaths } from "../../store/files";
import type { ParameterKey, State, ZustandGet, ZustandSet } from "../../store/types";

const KEYS: ParameterKey[] = ["convolveIrFile", "convolveIrSize", "convolveGainDb"];
const TARGET: SectionTarget = { scope: "effect:convolve", effectId: "e1" };

const preset = (values: Record<string, unknown>): SectionPreset => ({
  id: "p1",
  scope: "effect:convolve",
  name: "Hall",
  description: "",
  isFactory: true,
  color: { hue: "grape", variation: 0 },
  values,
});

function applyWith(values: Record<string, unknown>) {
  const setParameter = vi.fn();
  const get = (() => ({ sectionPresets: [preset(values)], setParameter }) as unknown as State) as ZustandGet;
  const slice = createSectionPresetsSlice(vi.fn() as unknown as ZustandSet, get);

  slice.applySectionPreset("p1", TARGET, KEYS);
  return setParameter;
}

describe("applying a section preset", () => {
  it("never clears a file parameter the preset leaves out", () => {
    const setParameter = applyWith({ convolveIrSize: 256 });

    expect(setParameter.mock.calls.map(([key]) => key)).toEqual(["convolveIrSize", "convolveGainDb"]);
    expect(openReferencedPaths).toHaveBeenCalledWith([], expect.anything());
  });

  it("writes and opens a file the preset does name", () => {
    const setParameter = applyWith({ convolveIrFile: { path: "/ir/hall.wav" } });

    expect(setParameter).toHaveBeenCalledWith("convolveIrFile", { path: "/ir/hall.wav" }, "e1");
    expect(openReferencedPaths).toHaveBeenCalledWith(["/ir/hall.wav"], expect.anything());
  });
});
