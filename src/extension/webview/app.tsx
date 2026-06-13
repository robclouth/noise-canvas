import { Canvas } from "@react-three/fiber";
import { host } from "@renderer/lib/host";
import commonGlsl from "@renderer/glsl/common.glsl";

// Phase 2 build-pipeline smoke test. Proves the renderer core's web toolchain —
// React + react-three-fiber + vite-plugin-glsl + the @host-impl seam resolving
// to the extension host — bundles and runs as a plain web page outside Electron.
// The real editor surface for a single clip replaces this in the spike phase.
export default function App() {
  return (
    <div style={{ position: "fixed", inset: 0, background: "#111" }}>
      <Canvas>
        <mesh>
          <planeGeometry args={[2, 2]} />
          <meshBasicMaterial color="hotpink" />
        </mesh>
      </Canvas>
      <div style={{ position: "absolute", top: 8, left: 8, color: "#888", font: "12px system-ui" }}>
        Noise Canvas extension webview — host platform: {host.env.platform}; core glsl bytes: {commonGlsl.length}
      </div>
    </div>
  );
}
