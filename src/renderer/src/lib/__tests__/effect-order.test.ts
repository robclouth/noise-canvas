import { describe, expect, it } from "vitest";
import {
  DEFAULT_EFFECT_ORDER,
  EFFECT_KEYS,
  EffectOrderItem,
  syncEffectOrder,
} from "../../effects/types";

describe("Effect Order", () => {
  describe("DEFAULT_EFFECT_ORDER", () => {
    it("should be an empty array", () => {
      expect(DEFAULT_EFFECT_ORDER).toEqual([]);
    });
  });

  describe("EFFECT_KEYS", () => {
    it("should include all expected effects", () => {
      expect(EFFECT_KEYS).toContain("dynamics");
      expect(EFFECT_KEYS).toContain("transform");
      expect(EFFECT_KEYS).toContain("overtones");
      expect(EFFECT_KEYS).toContain("blur");
      expect(EFFECT_KEYS).toContain("synthesize");
      expect(EFFECT_KEYS).toContain("evolve");
      expect(EFFECT_KEYS).toContain("passthrough");
    });
  });

  describe("syncEffectOrder", () => {
    it("should return empty array for undefined input", () => {
      const result = syncEffectOrder(undefined);
      expect(result).toEqual([]);
    });

    it("should return empty array for non-array input", () => {
      const result = syncEffectOrder(null as unknown as undefined);
      expect(result).toEqual([]);
    });

    it("should return empty array for empty array input", () => {
      const result = syncEffectOrder([]);
      expect(result).toEqual([]);
    });

    it("should preserve valid effects with their enabled state", () => {
      const input = [
        { id: "test-1", effect: "dynamics", enabled: true },
        { id: "test-2", effect: "blur", enabled: false },
      ];
      const result = syncEffectOrder(input);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: "test-1", effect: "dynamics", enabled: true, params: {} });
      expect(result[1]).toEqual({ id: "test-2", effect: "blur", enabled: false, params: {} });
    });

    it("should add unique IDs to entries missing them", () => {
      const input = [
        { effect: "dynamics", enabled: true },
        { effect: "transform", enabled: false },
      ];
      const result = syncEffectOrder(input);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBeDefined();
      expect(typeof result[0].id).toBe("string");
      expect(result[0].id.length).toBeGreaterThan(0);
      expect(result[1].id).toBeDefined();
      expect(result[0].id).not.toEqual(result[1].id);
    });

    it("should preserve existing IDs", () => {
      const input = [
        { id: "my-custom-id", effect: "dynamics", enabled: true },
        { effect: "blur", enabled: false },
      ];
      const result = syncEffectOrder(input);

      expect(result[0].id).toBe("my-custom-id");
      expect(result[1].id).not.toBe("my-custom-id");
    });

    it("should filter out passthrough effect", () => {
      const input = [
        { id: "test-1", effect: "dynamics", enabled: true },
        { id: "test-2", effect: "passthrough", enabled: true },
        { id: "test-3", effect: "blur", enabled: false },
      ];
      const result = syncEffectOrder(input);

      expect(result).toHaveLength(2);
      expect(result.find((item) => item.effect === "passthrough")).toBeUndefined();
    });

    it("should filter out invalid effect types", () => {
      const input = [
        { id: "test-1", effect: "dynamics", enabled: true },
        { id: "test-2", effect: "nonexistent", enabled: true },
        { id: "test-3", effect: "blur", enabled: false },
      ];
      const result = syncEffectOrder(input);

      expect(result).toHaveLength(2);
      expect(result.map((item) => item.effect)).toEqual(["dynamics", "blur"]);
    });

    it("should preserve order of effects", () => {
      const input = [
        { id: "1", effect: "blur", enabled: true },
        { id: "2", effect: "dynamics", enabled: true },
        { id: "3", effect: "transform", enabled: false },
        { id: "4", effect: "evolve", enabled: true },
      ];
      const result = syncEffectOrder(input);

      expect(result.map((item) => item.effect)).toEqual(["blur", "dynamics", "transform", "evolve"]);
    });

    it("should allow duplicate effects with different IDs", () => {
      const input = [
        { id: "dynamics-1", effect: "dynamics", enabled: true },
        { id: "dynamics-2", effect: "dynamics", enabled: false },
        { id: "dynamics-3", effect: "dynamics", enabled: true },
      ];
      const result = syncEffectOrder(input);

      expect(result).toHaveLength(3);
      expect(result.every((item) => item.effect === "dynamics")).toBe(true);
      expect(new Set(result.map((item) => item.id)).size).toBe(3);
    });
  });

  describe("EffectOrderItem type", () => {
    it("should have required fields: id, effect, enabled", () => {
      const item: EffectOrderItem = {
        id: "test-id",
        effect: "dynamics",
        enabled: true,
      };

      expect(item.id).toBe("test-id");
      expect(item.effect).toBe("dynamics");
      expect(item.enabled).toBe(true);
    });
  });
});
