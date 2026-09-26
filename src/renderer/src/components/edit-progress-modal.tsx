import { useStore } from "@renderer/store";
import { ProgressModal } from "./progress-modal";

/**
 * Shows how far a slow edit has got, and offers to stop it. Cancelling takes
 * the stroke back, so nothing is committed.
 */
export const EditProgressModal = () => {
  const progress = useStore((state) => state.editProgress);
  const cancelEdit = useStore((state) => state.cancelEdit);
  return <ProgressModal title="Applying edit" unit="parts" progress={progress} onCancel={cancelEdit} />;
};
