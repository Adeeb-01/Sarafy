import { Easing, ReduceMotion } from 'react-native-reanimated';

export const motion = {
  duration: { instant: 0, fast: 150, normal: 200, slow: 250 },
  easing: Easing.out(Easing.exp),
  spring: { damping: 22, stiffness: 260, mass: 0.8, reduceMotion: ReduceMotion.System },
} as const;
