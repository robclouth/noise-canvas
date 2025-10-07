import abstract1 from "@/assets/textures/Abstract 1.jpg";
import alienMetal from "@/assets/textures/Alien Metal.jpg";
import bismuth from "@/assets/textures/Bismuth.jpg";
import cells1 from "@/assets/textures/Cells 1.jpg";
import crystals from "@/assets/textures/Crystals.jpg";
import fabric1 from "@/assets/textures/Fabric 1.jpg";
import filaments from "@/assets/textures/Filaments.jpg";
import hexes from "@/assets/textures/Hexes.jpg";
import metal1 from "@/assets/textures/Metal 1.jpg";
import pattern1 from "@/assets/textures/Pattern 1.jpg";
import pattern2 from "@/assets/textures/Pattern 2.jpg";
import pattern3 from "@/assets/textures/Pattern 3.jpg";
import pattern4 from "@/assets/textures/Pattern 4.jpg";
import pattern5 from "@/assets/textures/Pattern 5.jpg";
import pattern6 from "@/assets/textures/Pattern 6.jpg";
import pattern7 from "@/assets/textures/Pattern 7.jpg";
import pattern8 from "@/assets/textures/Pattern 8.jpg";
import pattern9 from "@/assets/textures/Pattern 9.jpg";
import rock from "@/assets/textures/Rock.jpg";
import roots from "@/assets/textures/Roots.jpg";
import spots1 from "@/assets/textures/Spots 1.jpg";
import stones from "@/assets/textures/Stones.jpg";
import tubes from "@/assets/textures/Tubes.jpg";
import water1 from "@/assets/textures/Water 1.jpg";
import water2 from "@/assets/textures/Water 2.jpg";
import water3 from "@/assets/textures/Water 3.jpg";
import { useTexture } from "@react-three/drei";
import { useStore } from "@renderer/store";
import { LinearFilter, RepeatWrapping } from "three";
import { getFolders } from "./folders";

const TEXTURE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "bmp", "webp"];

let allTextures: {
  user: Array<{ path: string; filename: string }>;
  factory: Array<{ path: string; filename: string }>;
} | null = null;

export async function getTextures() {
  if (allTextures) {
    return allTextures;
  }

  const scanDirectory = async (dir: string, relativePath = ""): Promise<Array<{ path: string; filename: string }>> => {
    const textures: Array<{ path: string; filename: string }> = [];

    try {
      const entries = await window.nodeFs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;

        const fullPath = window.nodePath.join(dir, entry.name);
        const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          // Recursively scan subdirectories
          const subImages = await scanDirectory(fullPath, relPath);
          textures.push(...subImages);
        } else {
          // Check if it's an image file
          const ext = entry.name.toLowerCase().split(".").pop();
          if (ext && TEXTURE_EXTENSIONS.includes(ext)) {
            textures.push({
              path: `file://${fullPath}`,
              filename: entry.name,
            });
          }
        }
      }
    } catch (error) {
      console.error("Error scanning directory:", dir, error);
    }

    return textures;
  };

  const { texturesDir } = await getFolders();
  const textures = await scanDirectory(texturesDir);
  allTextures = {
    factory: [
      { path: abstract1, filename: "Abstract 1" },
      { path: alienMetal, filename: "Alien Metal" },
      { path: bismuth, filename: "Bismuth" },
      { path: cells1, filename: "Cells 1" },
      { path: crystals, filename: "Crystals" },
      { path: fabric1, filename: "Fabric 1" },
      { path: filaments, filename: "Filaments" },
      { path: hexes, filename: "Hexes" },
      { path: metal1, filename: "Metal 1" },
      { path: pattern1, filename: "Pattern 1" },
      { path: pattern2, filename: "Pattern 2" },
      { path: pattern3, filename: "Pattern 3" },
      { path: pattern4, filename: "Pattern 4" },
      { path: pattern5, filename: "Pattern 5" },
      { path: pattern6, filename: "Pattern 6" },
      { path: pattern7, filename: "Pattern 7" },
      { path: pattern8, filename: "Pattern 8" },
      { path: pattern9, filename: "Pattern 9" },
      { path: rock, filename: "Rock" },
      { path: roots, filename: "Roots" },
      { path: spots1, filename: "Spots 1" },
      { path: stones, filename: "Stones" },
      { path: tubes, filename: "Tubes" },
      { path: water1, filename: "Water 1" },
      { path: water2, filename: "Water 2" },
      { path: water3, filename: "Water 3" },
    ],
    user: textures,
  };
  return allTextures;
}

export function useModulatorTexture(modulatorIndex: number) {
  const modulatorImagePath = useStore((state) => state[`modulator${modulatorIndex + 1}ImagePath`]);

  const texture = useTexture(modulatorImagePath ? `${modulatorImagePath}` : alienMetal);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  return texture;
}
