import { afterEach, expect, it, vi } from "vitest";
import { ViewMotion } from "../view-motion";

afterEach(() => vi.useRealTimers());

it("stays live across repeated transforms and emits only start and stop", () => {
  vi.useFakeTimers();
  const motion = new ViewMotion();
  const states: boolean[] = [];
  motion.subscribe(() => states.push(motion.active));
  for (let i = 0; i < 10; i++) {
    motion.touch();
    vi.advanceTimersByTime(100);
    expect(motion.active).toBe(true);
  }
  expect(states).toEqual([true]);
  vi.advanceTimersByTime(180);
  expect(motion.active).toBe(false);
  expect(states).toEqual([true, false]);
  motion.dispose();
});

it("cancels the deadline when the view is removed", () => {
  vi.useFakeTimers();
  const motion = new ViewMotion();
  const changed = vi.fn();
  motion.subscribe(changed);
  motion.touch();
  motion.dispose();
  vi.advanceTimersByTime(500);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
