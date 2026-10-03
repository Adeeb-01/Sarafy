import { forwardRef, ReactNode, useState } from 'react';
import { StyleProp, StyleSheet, Text, TextInput, TextInputProps, View, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { radius, spacing, technicalText, typography, useAppTheme } from '@/theme';
import { IconButton } from '@/components/ui/IconButton';
import { normalizeIdentifierDigits, sanitizeNumericInput } from '@/utils/numerals';

type NumericMode = 'integer' | 'decimal' | 'signed-decimal' | 'identifier';
type Props = TextInputProps & { label?: string; helper?: string; helperVisibility?: 'always' | 'focus'; error?: string; leadingIcon?: keyof typeof Feather.glyphMap; trailing?: ReactNode; containerStyle?: StyleProp<ViewStyle>; rtl?: boolean; subtleFocus?: boolean; numericMode?: NumericMode };

export const AppInput = forwardRef<TextInput, Props>(function AppInput({ label, helper, helperVisibility = 'always', error, leadingIcon, trailing, containerStyle, rtl = false, subtleFocus = false, numericMode, keyboardType, onChangeText, style, ...props }, ref) {
  const { colors } = useAppTheme();
  const [focused, setFocused] = useState(false);
  const resolvedNumericMode = numericMode ?? (keyboardType === 'decimal-pad' ? 'decimal' : keyboardType === 'number-pad' || keyboardType === 'numeric' ? 'integer' : keyboardType === 'numbers-and-punctuation' ? 'signed-decimal' : keyboardType === 'phone-pad' ? 'identifier' : undefined);
  const changeText = (value: string) => {
    if (!resolvedNumericMode) { onChangeText?.(value); return; }
    if (resolvedNumericMode === 'identifier') { onChangeText?.(normalizeIdentifierDigits(value)); return; }
    onChangeText?.(sanitizeNumericInput(value, {
      allowDecimal: resolvedNumericMode === 'decimal' || resolvedNumericMode === 'signed-decimal',
      allowNegative: resolvedNumericMode === 'signed-decimal',
    }));
  };
  return <View style={[styles.group, containerStyle]}>
    {label && <Text style={[typography.label, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{label}</Text>}
    <View style={[styles.shell, { backgroundColor: colors.surface, borderColor: error ? colors.danger : focused ? colors.primary : colors.border, borderWidth: focused && subtleFocus && !error ? StyleSheet.hairlineWidth : 1, flexDirection: rtl ? 'row-reverse' : 'row' }]}> 
      {leadingIcon && <Feather name={leadingIcon} size={20} color={focused ? colors.primary : colors.textMuted} />}
      <TextInput ref={ref} placeholderTextColor={colors.textMuted} {...props} keyboardType={keyboardType} onChangeText={changeText} onFocus={event => { setFocused(true); props.onFocus?.(event); }} onBlur={event => { setFocused(false); props.onBlur?.(event); }} style={[styles.input, typography.body, { color: colors.textPrimary, textAlign: resolvedNumericMode ? 'left' : rtl ? 'right' : 'left' }, resolvedNumericMode && technicalText, style]} />
      {trailing}
    </View>
    {(error || (helper && (helperVisibility === 'always' || focused))) && <Text accessibilityLiveRegion={error ? 'polite' : undefined} style={[typography.caption, { color: error ? colors.danger : colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{error ?? helper}</Text>}
  </View>;
});

export function SearchInput({ value, onChangeText, placeholder, clearLabel, rtl }: { value: string; onChangeText: (value: string) => void; placeholder: string; clearLabel: string; rtl: boolean }) {
  return <AppInput accessibilityLabel={placeholder} value={value} onChangeText={text => onChangeText(normalizeIdentifierDigits(text))} placeholder={placeholder} rtl={rtl} leadingIcon="search" autoCorrect={false}
    trailing={value ? <IconButton icon="x" label={clearLabel} onPress={() => onChangeText('')} style={styles.clear} /> : undefined} />;
}

const styles = StyleSheet.create({ group: { gap: spacing.xxs }, shell: { minHeight: 48, borderWidth: 1, borderRadius: radius.md, alignItems: 'center', paddingHorizontal: spacing.sm, gap: spacing.xs }, input: { flex: 1, minHeight: 46, paddingVertical: 0 }, clear: { width: 44, height: 44, backgroundColor: 'transparent' } });
