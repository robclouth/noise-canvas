import { useStore } from "@renderer/store";
import { ProgressModal } from "./progress-modal";

/**
 * Shows how far a large grid fill has got, and offers to stop it. Cancelling
 * puts back the pixels from before the fill started, so nothing is committed.
 */
export const FillProgressModal = () => {
  const progress = useStore((state) => state.fillProgress);
  const cancelFill = useStore((state) => state.cancelFill);
  return <ProgressModal title="Filling grid" unit="strokes" progress={progress} onCancel={cancelFill} />;
};
