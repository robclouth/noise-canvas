import { openConfirm } from "@renderer/lib/modals";
import { startWalkthrough } from "@renderer/lib/walkthrough";
import { useStore } from "@renderer/store";
import { useEffect } from "react";
import { ipcOn } from "../lib/ipc";

/**
 * Offers the walkthrough once on a fresh install, and runs it on demand from
 * Help → Run Walkthrough. Renders nothing itself; driver.js owns the overlay.
 */
export function Walkthrough({ ready }: { ready: boolean }): null {
  // Help → Run Walkthrough, available whether or not it has been seen.
  useEffect(() => {
    return ipcOn("run-walkthrough", () => {
      void startWalkthrough();
    });
  }, []);

  // The offer waits for shader warmup, so the prompt isn't buried under the
  // loading overlay on the very first launch — which is exactly when it shows.
  useEffect(() => {
    if (!ready) return;
    if (useStore.getState().walkthroughSeen) return;

    openConfirm({
      title: "Welcome to Noise Canvas",
      message:
        "Hey, it's Rob. This is a tool for spectrally destroying samples — you paint effects straight onto a picture of a sound. Want a quick tour of where everything is?",
      confirmLabel: "Show me",
      cancelLabel: "No thanks",
      onConfirm: () => {
        void startWalkthrough();
      },
      // Declining still counts as answered; Help → Run Walkthrough remains.
      onCancel: () => useStore.getState().setWalkthroughSeen(true),
      onClose: () => useStore.getState().setWalkthroughSeen(true),
    });
  }, [ready]);

  return null;
}
