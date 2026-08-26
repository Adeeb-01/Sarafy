import { ActivityIndicator, Pressable, StyleProp, StyleSheet, Text, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { haptics } from '@/utils/haptics';
import { radius, spacing, typography, useAppTheme } from '@/theme';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function AppButton({ label, onPress, variant = 'primary', icon, loading = false, disabled = false, style, accessibilityHint }:
  { label: string; onPress: () => void; variant?: ButtonVariant; icon?: keyof typeof Feather.glyphMap; loading?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>; accessibilityHint?: string }) {
  const { colors } = useAppTheme();
  const inactive = disabled || loading;
  const backgroundColor = variant === 'primary' ? colors.primary : variant === 'danger' ? colors.danger : variant === 'secondary' ? colors.surfaceSecondary : 'transparent';
  const textColor = variant === 'primary' || variant === 'danger' ? colors.onPrimary : variant === 'ghost' ? colors.primary : colors.textPrimary;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={accessibilityHint} accessibilityState={{ disabled: inactive, busy: loading }} disabled={inactive}
      onPress={() => { haptics.tap(); onPress(); }}
      style={({ pressed }) => [styles.base, { backgroundColor }, variant === 'secondary' && { borderColor: colors.border, borderWidth: 1 }, pressed && styles.pressed, inactive && styles.disabled, style]}>
      {loading ? <ActivityIndicator color={textColor} /> : <>
        {icon && <Feather name={icon} size={18} color={textColor} />}
        <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78} maxFontSizeMultiplier={1.2} style={[typography.label, styles.label, { color: textColor }]}>{label}</Text>
      </>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: 44, paddingHorizontal: spacing.md, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs }, label: { minWidth: 0, flexShrink: 1 },
  pressed: { opacity: 0.86, transform: [{ scale: 0.98 }] }, disabled: { opacity: 0.48 },
});
