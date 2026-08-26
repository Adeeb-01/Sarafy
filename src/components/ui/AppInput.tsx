import { forwardRef, ReactNode, useState } from 'react';
import { StyleProp, StyleSheet, Text, TextInput, TextInputProps, View, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { radius, spacing, typography, useAppTheme } from '@/theme';
import { IconButton } from '@/components/ui/IconButton';

type Props = TextInputProps & { label?: string; helper?: string; helperVisibility?: 'always' | 'focus'; error?: string; leadingIcon?: keyof typeof Feather.glyphMap; trailing?: ReactNode; containerStyle?: StyleProp<ViewStyle>; rtl?: boolean; subtleFocus?: boolean };

export const AppInput = forwardRef<TextInput, Props>(function AppInput({ label, helper, helperVisibility = 'always', error, leadingIcon, trailing, containerStyle, rtl = false, subtleFocus = false, style, ...props }, ref) {
  const { colors } = useAppTheme();
  const [focused, setFocused] = useState(false);
  return <View style={[styles.group, containerStyle]}>
    {label && <Text style={[typography.label, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{label}</Text>}
    <View style={[styles.shell, { backgroundColor: colors.surface, borderColor: error ? colors.danger : focused ? colors.primary : colors.border, borderWidth: focused && subtleFocus && !error ? StyleSheet.hairlineWidth : 1, flexDirection: rtl ? 'row-reverse' : 'row' }]}> 
      {leadingIcon && <Feather name={leadingIcon} size={20} color={focused ? colors.primary : colors.textMuted} />}
      <TextInput ref={ref} placeholderTextColor={colors.textMuted} {...props} onFocus={event => { setFocused(true); props.onFocus?.(event); }} onBlur={event => { setFocused(false); props.onBlur?.(event); }} style={[styles.input, typography.body, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }, style]} />
      {trailing}
    </View>
    {(error || (helper && (helperVisibility === 'always' || focused))) && <Text accessibilityLiveRegion={error ? 'polite' : undefined} style={[typography.caption, { color: error ? colors.danger : colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{error ?? helper}</Text>}
  </View>;
});

export function SearchInput({ value, onChangeText, placeholder, clearLabel, rtl }: { value: string; onChangeText: (value: string) => void; placeholder: string; clearLabel: string; rtl: boolean }) {
  return <AppInput accessibilityLabel={placeholder} value={value} onChangeText={onChangeText} placeholder={placeholder} rtl={rtl} leadingIcon="search" autoCorrect={false}
    trailing={value ? <IconButton icon="x" label={clearLabel} onPress={() => onChangeText('')} style={styles.clear} /> : undefined} />;
}

const styles = StyleSheet.create({ group: { gap: spacing.xxs }, shell: { minHeight: 48, borderWidth: 1, borderRadius: radius.md, alignItems: 'center', paddingHorizontal: spacing.sm, gap: spacing.xs }, input: { flex: 1, minHeight: 46, paddingVertical: 0 }, clear: { width: 44, height: 44, backgroundColor: 'transparent' } });
