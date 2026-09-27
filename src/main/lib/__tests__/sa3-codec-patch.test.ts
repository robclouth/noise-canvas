import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { floatOutputPatch, functionPatch } from "../sa3-codec-patch";

const fixture = (name: string): Buffer => readFileSync(join(__dirname, "fixtures", name));

describe("Stable Audio 3 codec patch", () => {
  it("writes the attention function byte for byte as the patch checked against ONNX Runtime", () => {
    expect(Buffer.from(functionPatch()).equals(fixture("sa3-function-patch.bin"))).toBe(true);
  });

  it("writes the float decoder output byte for byte as the patch checked against ONNX Runtime", () => {
    expect(Buffer.from(floatOutputPatch()).equals(fixture("sa3-float-output-patch.bin"))).toBe(true);
  });
});
