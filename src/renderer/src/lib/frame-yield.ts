/** Longest run of copying, in milliseconds, before a long read lets a frame through. */
export const FRAME_YIELD_BUDGET_MS = 8;

/**
 * Yields to the event loop once `since` lies more than the budget in the
 * past, so a long copy spread over a loop leaves room for frames. Returns the
 * time the next stretch of work starts from.
 */
export async function yieldIfLong(since: number, budgetMs = FRAME_YIELD_BUDGET_MS): Promise<number> {
  if (performance.now() - since < budgetMs) return since;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return performance.now();
}
