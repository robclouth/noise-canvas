import { createContext, useContext, ReactNode } from "react";

type EffectContextValue = {
  effectId: string;
};

const EffectContext = createContext<EffectContextValue | null>(null);

/**
 * Get the current effect ID from context.
 * Returns null if not within an EffectProvider (e.g., in non-effect UI contexts).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useEffectId(): string | null {
  const context = useContext(EffectContext);
  return context?.effectId ?? null;
}

/**
 * Provides the current effect ID to child components.
 * Used to scope parameter reads/writes to a specific effect instance.
 */
export function EffectProvider({ effectId, children }: { effectId: string; children: ReactNode }) {
  return <EffectContext.Provider value={{ effectId }}>{children}</EffectContext.Provider>;
}
