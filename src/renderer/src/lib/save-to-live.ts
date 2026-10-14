import { host } from "@/lib/host";
import { useStore } from "@/store";
import { openFiles, snapshotSaveAudio } from "@/store/files";
import { selectLayerStack } from "@/store/layers";

// Renders the active file and hands its audio, the sum of its layers when it
// has them, to the host session, which encodes and imports it into the Live set
// as a new clip. No-op outside the extension (host.session is absent) or when
// no file is open.
export async function saveToLive(): Promise<void> {
  const state = useStore.getState();
  const activeFileId = state.activeFileId;
  if (!activeFileId || !host.session) return;
  await state.synthesizeFile(activeFileId);
  const fileId = selectLayerStack(state, activeFileId)?.ownerId ?? activeFileId;
  const audio = await snapshotSaveAudio(useStore.getState, fileId);
  if (!audio) return;
  await host.session.apply([
    { channels: audio.channels, sampleRate: audio.sampleRate, label: openFiles[fileId]?.displayName ?? "Edit" },
  ]);
}
