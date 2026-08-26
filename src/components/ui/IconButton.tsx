import { Pressable, StyleProp, StyleSheet, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { radius, useAppTheme } from '@/theme';
import { haptics } from '@/utils/haptics';

export function IconButton({ icon, label, hint, onPress, disabled = false, tone = 'default', style }:
  { icon: keyof typeof Feather.glyphMap; label: string; hint?: string; onPress: () => void; disabled?: boolean; tone?: 'default' | 'primary' | 'danger'; style?: StyleProp<ViewStyle> }) {
  const { colors } = useAppTheme();
  const color = tone === 'danger' ? colors.danger : tone === 'primary' ? colors.primary : colors.textSecondary;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} accessibilityState={{ disabled }} disabled={disabled} hitSlop={6}
    onPress={() => { haptics.tap(); onPress(); }} style={({ pressed }) => [styles.base, { backgroundColor: colors.surfaceSecondary }, pressed && styles.pressed, disabled && styles.disabled, style]}>
    <Feather name={icon} size={20} color={color} />
  </Pressable>;
}

const styles = StyleSheet.create({ base: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' }, pressed: { opacity: 0.76, transform: [{ scale: 0.94 }] }, disabled: { opacity: 0.4 } });
