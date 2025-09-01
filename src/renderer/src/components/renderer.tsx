import { extend } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { useRef } from "react";
import { spectrogramDataAtom } from "../store";
import { DisplayMaterial } from "./spectrogram-material";

// This is required to use our custom material as a JSX component
const Material = extend(DisplayMaterial);

export const Renderer = () => {
  const spectrogramData = useAtomValue(spectrogramDataAtom);
  const materialRef = useRef<typeof DisplayMaterial>(null);

  // useFrame(() => {
  //   if (materialRef.current) {
  //     // You can animate uniforms here, e.g., for scrolling
  //   }
  // });

  if (!spectrogramData) {
    return (
      <mesh>
        <planeGeometry args={[2, 2]} />
        <meshBasicMaterial color="black" />
      </mesh>
    );
  }

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <Material ref={materialRef} key={DisplayMaterial.key} {...spectrogramData} />
    </mesh>
  );
};
