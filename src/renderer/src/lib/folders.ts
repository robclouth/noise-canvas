import { host } from "./host";

const PRESETS_FOLDER_NAME = "Noise Canvas";
const PRESETS_SUBFOLDER_NAME = "Presets";
const EFFECTS_SUBFOLDER_NAME = "Effects";
const MODULATORS_SUBFOLDER_NAME = "Modulators";
const PALETTES_SUBFOLDER_NAME = "Palettes";
const TEXTURES_SUBFOLDER_NAME = "Textures";

let appDir: string;
let presetsDir: string;
let effectPresetsDir: string;
let modulatorPresetsDir: string;
let palettesDir: string;
let texturesDir: string;

/**
 * Root of the user's preset tree. The Electron app keeps it in the Documents
 * folder; the extension host may only write inside the per-extension storage
 * directory Live hands it, so the tree lives there instead.
 */
async function getAppDir(): Promise<string> {
  if (host.env.isExtension) return await host.dialogs.getUserDataPath();
  return host.path.join(await getDocumentsDir(), PRESETS_FOLDER_NAME);
}

async function getDocumentsDir(): Promise<string> {
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

  return documentsDir;
}

export async function getFolders() {
  if (appDir && presetsDir && effectPresetsDir && modulatorPresetsDir && palettesDir && texturesDir) {
    return { appDir, presetsDir, effectPresetsDir, modulatorPresetsDir, palettesDir, texturesDir };
  }

  appDir = await getAppDir();
  presetsDir = host.path.join(appDir, PRESETS_SUBFOLDER_NAME);
  effectPresetsDir = host.path.join(presetsDir, EFFECTS_SUBFOLDER_NAME);
  modulatorPresetsDir = host.path.join(presetsDir, MODULATORS_SUBFOLDER_NAME);
  palettesDir = host.path.join(appDir, PALETTES_SUBFOLDER_NAME);
  texturesDir = host.path.join(appDir, TEXTURES_SUBFOLDER_NAME);

  console.log("App directories:", {
    appDir,
    presetsDir,
    effectPresetsDir,
    modulatorPresetsDir,
    palettesDir,
    texturesDir,
  });

  await Promise.all([
    host.fs.mkdir(presetsDir, { recursive: true }),
    host.fs.mkdir(effectPresetsDir, { recursive: true }),
    host.fs.mkdir(modulatorPresetsDir, { recursive: true }),
    host.fs.mkdir(palettesDir, { recursive: true }),
    host.fs.mkdir(texturesDir, { recursive: true }),
  ]);

  return { appDir, presetsDir, effectPresetsDir, modulatorPresetsDir, palettesDir, texturesDir };
}
