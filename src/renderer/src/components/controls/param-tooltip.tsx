import type { ParameterDef } from "@renderer/parameters";
import type { ParameterKey } from "@renderer/store/types";
import { getParameterDef } from "@renderer/parameters";
import { TooltipContent } from "../tooltip";

const formatNumber = (value: number, unit?: string) => `${parseFloat(value.toFixed(2))}${unit ?? ""}`;

/** Prefer a mark label over the raw number, so edge values read as "Grid"/"Full"/"Off". */
const formatBoundary = (value: number, parameter: Extract<ParameterDef, { kind: "number" }>) => {
  const mark = parameter.marks?.find((m) => m.value === value);
  if (mark && /^[^-\d.]/.test(mark.label)) return mark.label;
  return formatNumber(value, parameter.unit);
};

const describeDefault = (parameter: ParameterDef): string | null => {
  switch (parameter.kind) {
    case "number":
      return formatBoundary(parameter.default, parameter);
    case "boolean":
      return parameter.default ? "On" : "Off";
    case "options": {
      const option = parameter.options.find((o) => o.value === parameter.default);
      return option?.label ?? null;
    }
    default:
      return null;
  }
};

const buildMeta = (parameter: ParameterDef): string | null => {
  const parts: string[] = [];
  if (parameter.kind === "number") {
    parts.push(`${formatBoundary(parameter.min, parameter)} – ${formatBoundary(parameter.max, parameter)}`);
  }
  const defaultValue = describeDefault(parameter);
  if (defaultValue !== null) parts.push(`default ${defaultValue}`);
  return parts.length > 0 ? parts.join(" · ") : null;
};

const buildHints = (parameter: ParameterDef): string[] => {
  const hints: string[] = [];

  if (parameter.kind === "number") {
    hints.push("Drag up/down to change · Shift for fine steps · click to type");
    if (parameter.marks?.length) {
      hints.push("Ctrl while dragging snaps to preset values · right-click for the list");
    }
    if (parameter.modulatable) {
      hints.push("Click the label to modulate this parameter");
    }
  }

  hints.push("Double-click the label to reset");
  return hints;
};

/**
 * Full tooltip for a parameter: its name and description, the range and default
 * it accepts, and how to drive the control.
 */
export const ParamTooltipContent = ({ paramKey, displayLabel }: { paramKey: ParameterKey; displayLabel?: string }) => {
  const parameter = getParameterDef(paramKey);
  return (
    <TooltipContent
      // Renamed controls (macros) are known by their new name, not the built-in one.
      title={displayLabel ?? parameter.name}
      body={parameter.description}
      meta={buildMeta(parameter)}
      hints={buildHints(parameter)}
    />
  );
};
