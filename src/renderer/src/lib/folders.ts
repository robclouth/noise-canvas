import { host } from "./host";

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

  const homeDir = host.os.homedir();
  let documentsDir: string;

  // Cross-platform Documents folder detection
  if (host.env.platform === "win32") {
    // Windows: Use Documents folder (standard location)
    documentsDir = host.path.join(homeDir, "Documents");
  } else if (host.env.platform === "darwin") {
    // macOS: Use Documents folder (standard location)
    documentsDir = host.path.join(homeDir, "Documents");
  } else {
    // Linux: Try XDG Documents dir first, fallback to ~/.config or ~/Documents
    const xdgDocuments = host.env.getEnv("XDG_DOCUMENTS_DIR");
    if (xdgDocuments) {
      documentsDir = xdgDocuments;
    } else {
      // Try to create Documents, but fallback to .config if it fails
      const potentialDocuments = host.path.join(homeDir, "Documents");
      try {
        await host.fs.access(potentialDocuments);
        documentsDir = potentialDocuments;
      } catch {
        // Documents doesn't exist, use .config instead (XDG Base Directory spec)
        const configDir = host.env.getEnv("XDG_CONFIG_HOME") || host.path.join(homeDir, ".config");
        documentsDir = configDir;
      }
    }
  }

  appDir = host.path.join(documentsDir, PRESETS_FOLDER_NAME);
  presetsDir = host.path.join(appDir, PRESETS_SUBFOLDER_NAME);
  texturesDir = host.path.join(appDir, TEXTURES_SUBFOLDER_NAME);

  console.log("App directories:", { appDir, presetsDir, texturesDir });

  await Promise.all([host.fs.mkdir(presetsDir, { recursive: true }), host.fs.mkdir(texturesDir, { recursive: true })]);

  return { appDir, presetsDir, texturesDir };
}
