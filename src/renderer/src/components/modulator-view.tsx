import { View } from "@react-three/drei";

const Scene = () => {
  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <meshBasicMaterial color="hotpink" />
    </mesh>
  );
};

export const ModulatorView = () => {
  return (
    <View style={{ height: 128 }}>
      <Scene />
    </View>
  );
};
