import { Box, Button, Group, Modal, Progress, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useState } from "react";
import type { ProgressInfo, UpdateInfo } from "electron-updater";
import { host } from "../lib/host";
import { APP_MODAL_PROPS } from "../lib/modals";
import { ipcOn } from "../lib/ipc";

export function UpdateNotification() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [updateReady, setUpdateReady] = useState(false);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // Update available
    const unsubUpdateAvailable = ipcOn("update-available", (info: UpdateInfo) => {
      console.log("Update available:", info);
      setUpdateInfo(info);
      setShowModal(true);

      notifications.show({
        id: "update-available",
        title: "Update Available",
        message: `Version ${info.version} is ready to download`,
        color: "blue",
        autoClose: false,
      });
    });
    unsubscribers.push(unsubUpdateAvailable);

    // Update not available
    const unsubUpdateNotAvailable = ipcOn("update-not-available", () => {
      console.log("No update available");

      notifications.show({
        id: "no-update-available",
        title: "No Update Available",
        message: `You are using the latest version`,
        autoClose: true,
      });
    });
    unsubscribers.push(unsubUpdateNotAvailable);

    // Download progress
    const unsubDownloadProgress = ipcOn("download-progress", (progressInfo: ProgressInfo) => {
      setDownloadProgress(Math.round(progressInfo.percent));
    });
    unsubscribers.push(unsubDownloadProgress);

    // Update downloaded
    const unsubUpdateDownloaded = ipcOn("update-downloaded", (info: UpdateInfo) => {
      console.log("Update downloaded:", info);
      setIsDownloading(false);
      setUpdateReady(true);
      setShowModal(true);

      notifications.hide("update-downloading");
      notifications.show({
        id: "update-ready",
        title: "Update Ready",
        message: "The update has been downloaded. Restart to install.",
        color: "green",
        autoClose: false,
      });
    });
    unsubscribers.push(unsubUpdateDownloaded);

    // Update error
    const unsubUpdateError = ipcOn("update-error", (error: string) => {
      console.error("Update error:", error);
      setIsDownloading(false);

      notifications.show({
        id: "update-error",
        title: "Update Error",
        message: error,
        color: "red",
        autoClose: 5000,
      });
    });
    unsubscribers.push(unsubUpdateError);

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, []);

  const handleDownloadUpdate = async () => {
    setIsDownloading(true);
    setShowModal(false);
    setDownloadProgress(0);

    notifications.show({
      id: "update-downloading",
      title: "Downloading Update",
      message: "Please wait while the update is being downloaded...",
      color: "blue",
      autoClose: false,
      loading: true,
    });

    try {
      await host.updater.downloadUpdate();
    } catch (error) {
      console.error("Failed to download update:", error);
      setIsDownloading(false);
      notifications.hide("update-downloading");
    }
  };

  const handleInstallUpdate = () => {
    host.updater.quitAndInstall();
  };

  // The feed gives one HTML blob for a single release, or one entry per version
  // when the updater runs with fullChangelog on.
  const formatReleaseNotes = (notes: UpdateInfo["releaseNotes"]) => {
    if (!notes) return null;
    if (typeof notes === "string") {
      return <div dangerouslySetInnerHTML={{ __html: notes }} />;
    }
    return notes.map(({ version, note }) => (
      <Stack key={version} gap={2}>
        <Text size="xs" fw={600}>
          {version}
        </Text>
        {note && <div dangerouslySetInnerHTML={{ __html: note }} />}
      </Stack>
    ));
  };

  // Update Ready Modal
  if (updateReady) {
    return (
      <Modal
        {...APP_MODAL_PROPS}
        opened={showModal}
        onClose={() => setShowModal(false)}
        title="Update Ready to Install"
        size="sm"
        centered
      >
        <Stack gap="sm">
          <Text size="sm">
            Version <strong>{updateInfo?.version}</strong> has been downloaded.
          </Text>
          <Text size="xs" c="dimmed">
            The app restarts to finish installing.
          </Text>
          <Group justify="flex-end">
            <Button size="xs" variant="default" onClick={() => setShowModal(false)}>
              Later
            </Button>
            <Button size="xs" onClick={handleInstallUpdate}>
              Restart & Install
            </Button>
          </Group>
        </Stack>
      </Modal>
    );
  }

  // Update Available Modal
  if (updateInfo && !isDownloading) {
    return (
      <Modal
        {...APP_MODAL_PROPS}
        opened={showModal}
        onClose={() => setShowModal(false)}
        title="Update Available"
        size="sm"
        centered
      >
        <Stack gap="sm">
          <Text size="sm">
            Version <strong>{updateInfo.version}</strong> is now available.
          </Text>

          {updateInfo.releaseName && (
            <Text size="xs" c="dimmed">
              {updateInfo.releaseName}
            </Text>
          )}

          {updateInfo.releaseNotes && (
            <Stack gap={4}>
              <Text size="xs" fw={600}>
                What&apos;s new
              </Text>
              <Box className="release-notes" style={{ maxHeight: 260, overflowY: "auto" }}>
                {formatReleaseNotes(updateInfo.releaseNotes)}
              </Box>
            </Stack>
          )}

          <Group justify="flex-end">
            <Button size="xs" variant="default" onClick={() => setShowModal(false)}>
              Skip
            </Button>
            <Button size="xs" onClick={handleDownloadUpdate}>
              Download
            </Button>
          </Group>
        </Stack>
      </Modal>
    );
  }

  // Downloading Progress Notification (handled by notifications, not modal)
  if (isDownloading) {
    return (
      <Modal
        {...APP_MODAL_PROPS}
        opened={true}
        onClose={() => {}}
        title="Downloading Update"
        size="sm"
        centered
        closeOnClickOutside={false}
        closeOnEscape={false}
        withCloseButton={false}
      >
        <Stack gap="sm">
          <Text size="sm">Version {updateInfo?.version}</Text>
          <Progress value={downloadProgress} animated />
          <Text size="xs" ta="center" c="dimmed">
            {downloadProgress}%
          </Text>
        </Stack>
      </Modal>
    );
  }

  return null;
}
