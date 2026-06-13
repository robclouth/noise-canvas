import { Button, Group, Modal, Progress, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useState } from "react";
import { host } from "../lib/host";
import { ipcOn } from "../lib/ipc";

interface UpdateInfo {
  version: string;
  releaseDate?: string;
  releaseName?: string;
  releaseNotes?: string | string[];
}

interface ProgressInfo {
  bytesPerSecond: number;
  percent: number;
  transferred: number;
  total: number;
}

export function UpdateNotification() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [updateReady, setUpdateReady] = useState(false);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // Update available
    const unsubUpdateAvailable = ipcOn("update-available", (_event, info: UpdateInfo) => {
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
    const unsubDownloadProgress = ipcOn("download-progress", (_event, progressInfo: ProgressInfo) => {
      setDownloadProgress(Math.round(progressInfo.percent));
    });
    unsubscribers.push(unsubDownloadProgress);

    // Update downloaded
    const unsubUpdateDownloaded = ipcOn("update-downloaded", (_event, info: UpdateInfo) => {
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
    const unsubUpdateError = ipcOn("update-error", (_event, error: string) => {
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

  const formatReleaseNotes = (notes: string | string[] | undefined) => {
    if (!notes) return null;
    if (typeof notes === "string") {
      return <div dangerouslySetInnerHTML={{ __html: notes }} />;
    }
    return notes.map((note, index) => (
      <Text key={index} size="sm">
        {note}
      </Text>
    ));
  };

  // Update Ready Modal
  if (updateReady) {
    return (
      <Modal
        opened={showModal}
        onClose={() => setShowModal(false)}
        title={<Title order={3}>Update Ready to Install</Title>}
        centered
      >
        <Stack gap="md">
          <Text>
            Version <strong>{updateInfo?.version}</strong> has been downloaded and is ready to install.
          </Text>
          <Text size="sm" c="dimmed">
            The app will restart to complete the installation.
          </Text>
          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={() => setShowModal(false)}>
              Later
            </Button>
            <Button onClick={handleInstallUpdate}>Restart & Install</Button>
          </Group>
        </Stack>
      </Modal>
    );
  }

  // Update Available Modal
  if (updateInfo && !isDownloading) {
    return (
      <Modal
        opened={showModal}
        onClose={() => setShowModal(false)}
        title={<Title order={3}>Update Available</Title>}
        centered
        size="md"
      >
        <Stack gap="md">
          <Text>
            Version <strong>{updateInfo.version}</strong> is now available.
          </Text>

          {updateInfo.releaseName && (
            <Title order={4} c="dimmed">
              {updateInfo.releaseName}
            </Title>
          )}

          {updateInfo.releaseNotes && (
            <Stack gap="xs">
              <Text fw={500}>What&apos;s New:</Text>
              <div style={{ maxHeight: "300px", overflowY: "auto" }}>{formatReleaseNotes(updateInfo.releaseNotes)}</div>
            </Stack>
          )}

          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={() => setShowModal(false)}>
              Skip This Version
            </Button>
            <Button onClick={handleDownloadUpdate}>Download Update</Button>
          </Group>
        </Stack>
      </Modal>
    );
  }

  // Downloading Progress Notification (handled by notifications, not modal)
  if (isDownloading) {
    return (
      <Modal
        opened={true}
        onClose={() => {}}
        title={<Title order={3}>Downloading Update</Title>}
        centered
        closeOnClickOutside={false}
        closeOnEscape={false}
        withCloseButton={false}
      >
        <Stack gap="md">
          <Text>Downloading version {updateInfo?.version}...</Text>
          <Progress value={downloadProgress} size="lg" animated />
          <Text size="sm" ta="center" c="dimmed">
            {downloadProgress}%
          </Text>
        </Stack>
      </Modal>
    );
  }

  return null;
}
