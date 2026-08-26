import { createContext, PropsWithChildren, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { darkColors, lightColors, ThemeColors } from '@/theme/colors';

export type ThemeMode = 'light' | 'dark';
type ThemeContextValue = { colors: ThemeColors; mode: ThemeMode; isDark: boolean };
const ThemeContext = createContext<ThemeContextValue>({ colors: lightColors, mode: 'light', isDark: false });

export function ThemeProvider({ children, mode }: PropsWithChildren<{ mode?: ThemeMode }>) {
  const systemMode = useColorScheme();
  const resolvedMode: ThemeMode = mode ?? (systemMode === 'dark' ? 'dark' : 'light');
  const value = useMemo(() => ({ colors: resolvedMode === 'dark' ? darkColors : lightColors, mode: resolvedMode, isDark: resolvedMode === 'dark' }), [resolvedMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useAppTheme = () => useContext(ThemeContext);
