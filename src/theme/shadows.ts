import { Platform } from 'react-native';

export const shadows = {
  none: {},
  card: Platform.select({
    ios: { shadowColor: '#111827', shadowOpacity: 0.1, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
    android: { elevation: 2 },
    default: { boxShadow: '0 3px 8px rgba(17,24,39,0.10)' },
  }) ?? {},
  sheet: Platform.select({
    ios: { shadowColor: '#000000', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: -3 } },
    android: { elevation: 12 },
    default: { boxShadow: '0 -4px 8px rgba(0,0,0,0.16)' },
  }) ?? {},
} as const;
