import { getModulationParamKeys } from "@renderer/store";
import { ParameterKey } from "@renderer/store/types";

/**
 * Randomizes a number parameter value with an additive bipolar variation.
 * Uses smart range calculation to ensure the value never exceeds [min, max].
 * Even at the edges of the range, the full randomization percentage is applied.
 */
export function randomizeNumberParameter(currentValue: number, min: number, max: number, amount: number): number {
  const range = max - min;
  const maxDelta = (range * amount) / 100;

  const roomUp = max - currentValue;
  const roomDown = currentValue - min;

  const maxUp = Math.min(maxDelta, roomUp);
  const maxDown = Math.min(maxDelta, roomDown);

  const totalRange = maxDown + maxUp;
  if (totalRange <= 0) return currentValue;

  const randomOffset = Math.random() * totalRange;
  const delta = randomOffset - maxDown;

  return currentValue + delta;
}

/**
 * Randomizes an options parameter by picking a random option.
 * The probability of changing is based on the amount.
 */
export function randomizeOptionsParameter<T>(currentValue: T, options: T[], amount: number): T {
  if (options.length <= 1) return currentValue;

  // amount% chance to change to a different option
  if (Math.random() * 100 > amount) return currentValue;

  const otherOptions = options.filter((opt) => opt !== currentValue);
  if (otherOptions.length === 0) return currentValue;

  const randomIndex = Math.floor(Math.random() * otherOptions.length);
  return otherOptions[randomIndex];
}

/**
 * Randomizes a boolean parameter.
 * At 0% amount: keeps current value
 * At 100% amount: 50/50 random true/false
 * Intermediate values interpolate between keeping current and random
 */
export function randomizeBooleanParameter(currentValue: boolean, amount: number): boolean {
  // amount% chance to pick a truly random value instead of keeping current
  if (Math.random() * 100 > amount) return currentValue;
  // Pick a random boolean (50/50)
  return Math.random() < 0.5;
}

/**
 * Randomize all modulation amounts for a parameter
 * Returns an object with the randomized modulation values
 */
export function randomizeModulationAmounts(paramKey: ParameterKey, amount: number): Record<ParameterKey, number> {
  const result: Record<ParameterKey, number> = {} as Record<ParameterKey, number>;

  const modKeys = getModulationParamKeys(paramKey);
  for (const key of modKeys) {
    // Modulation amounts are -100 to 100, randomize from 0
    result[key] = randomizeNumberParameter(0, -100, 100, amount);
  }

  return result;
}

/**
 * Shuffle an array using Fisher-Yates algorithm
 */
export function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Randomize effects order and enabled states
 * Returns a new effects array with shuffled order and randomized enabled states
 */
export function randomizeEffects(
  currentEffects: { id: string; effect: string; enabled: boolean; params: Record<string, unknown> }[],
  amount: number,
): { id: string; effect: string; enabled: boolean; params: Record<string, unknown> }[] {
  // Shuffle order based on amount
  let newEffects = [...currentEffects];
  if (Math.random() * 100 < amount) {
    newEffects = shuffleArray(newEffects);
  }

  // Randomize enabled states
  return newEffects.map((item) => ({
    ...item,
    enabled: randomizeBooleanParameter(item.enabled, amount),
  }));
}
