import { useStore } from "@renderer/store";
import { lengthToSeconds, secondsToLength, type LengthKeys } from "@renderer/lib/length-values";
import { useEffect, useRef } from "react";
import { DialogControls } from "./dialog-controls";

/**
 * A length field with a beats/seconds unit, kept in the parameters `keys` names.
 * Switching unit converts the length at `bpm` rather than showing the other unit's last value.
 */
export const LengthFields = ({ keys, bpm }: { keys: LengthKeys; bpm: number }) => {
  const unit = useStore((state) => state[keys.unit]);
  const shownUnit = useRef(unit);

  useEffect(() => {
    const from = shownUnit.current;
    shownUnit.current = unit;
    if (from === unit) return;
    const state = useStore.getState();
    const seconds = lengthToSeconds(
      { unit: from, length: from === "beats" ? state[keys.beats] : state[keys.seconds] },
      bpm,
    );
    const converted = Math.round(secondsToLength(seconds, unit, bpm) * 1000) / 1000;
    state.setParameter(unit === "beats" ? keys.beats : keys.seconds, converted);
  }, [unit, keys, bpm]);

  return <DialogControls keys={[unit === "beats" ? keys.beats : keys.seconds, keys.unit]} />;
};
