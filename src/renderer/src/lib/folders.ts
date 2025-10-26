const PRESETS_FOLDER_NAME = "Noise Canvas";
const PRESETS_SUBFOLDER_NAME = "Presets";
const TEXTURES_SUBFOLDER_NAME = "Textures";

let appDir: string;
let presetsDir: string;
let texturesDir: string;

export async function getFolders() {
  if (appDir && presetsDir && texturesDir) {
    return { appDir, presetsDir, texturesDir };
  }

  const homeDir = window.nodeOs.homedir();
  let documentsDir: string;

  // Cross-platform Documents folder detection
  if (process.platform === "win32") {
    // Windows: Use Documents folder (standard location)
    documentsDir = window.nodePath.join(homeDir, "Documents");
  } else if (process.platform === "darwin") {
    // macOS: Use Documents folder (standard location)
    documentsDir = window.nodePath.join(homeDir, "Documents");
  } else {
    // Linux: Try XDG Documents dir first, fallback to ~/.config or ~/Documents
    const xdgDocuments = process.env.XDG_DOCUMENTS_DIR;
    if (xdgDocuments) {
      documentsDir = xdgDocuments;
    } else {
      // Try to create Documents, but fallback to .config if it fails
      const potentialDocuments = window.nodePath.join(homeDir, "Documents");
      try {
        await window.nodeFs.access(potentialDocuments);
        documentsDir = potentialDocuments;
      } catch {
        // Documents doesn't exist, use .config instead (XDG Base Directory spec)
        const configDir = process.env.XDG_CONFIG_HOME || window.nodePath.join(homeDir, ".config");
        documentsDir = configDir;
      }
    }
  }

  appDir = window.nodePath.join(documentsDir, PRESETS_FOLDER_NAME);
  presetsDir = window.nodePath.join(appDir, PRESETS_SUBFOLDER_NAME);
  texturesDir = window.nodePath.join(appDir, TEXTURES_SUBFOLDER_NAME);

  console.log("App directories:", { appDir, presetsDir, texturesDir });

  await Promise.all([
    window.nodeFs.mkdir(presetsDir, { recursive: true }),
    window.nodeFs.mkdir(texturesDir, { recursive: true }),
  ]);

  return { appDir, presetsDir, texturesDir };
}
