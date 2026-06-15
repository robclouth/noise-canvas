import { host } from "@/lib/host";
import { useStore } from "@/store";
import { openFiles } from "@/store/files";

// Renders the active file and hands its audio to the host session, which encodes
// and imports it into the Live set as a new clip. No-op outside the extension
// (host.session is absent) or when no file is open.
export async function saveToLive(): Promise<void> {
  const state = useStore.getState();
  const fileId = state.activeFileId;
  if (!fileId || !host.session) return;
  await state.synthesizeFile(fileId);
  const file = openFiles[fileId];
  const buffer = file?.audioBuffer;
  if (!buffer) return;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  await host.session.apply([{ channels, sampleRate: buffer.sampleRate, label: file?.displayName ?? "Edit" }]);
}
