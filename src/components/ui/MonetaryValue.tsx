import { StyleProp, StyleSheet, Text, TextStyle, View, ViewStyle } from 'react-native';
import { Language } from '@/types';
import { formatNumber } from '@/utils/formatters';
import { fonts, typography, useAppTheme } from '@/theme';

export const monetaryFontSizeFor = (formattedValue: string, compact = true) => {
  const length = Array.from(formattedValue).length;
  if (!compact) return length <= 7 ? 24 : length <= 10 ? 21 : length <= 13 ? 18 : 16;
  return length <= 5 ? 23 : length <= 7 ? 21 : length <= 10 ? 18 : length <= 13 ? 15 : 14;
};

export function MonetaryValue({ value, language, currencyLabel, compact = true, inline = false, style, textStyle, currencyTextStyle }: { value: number; language: Language; currencyLabel: string; compact?: boolean; inline?: boolean; style?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle>; currencyTextStyle?: StyleProp<TextStyle> }) {
  const { colors } = useAppTheme(); const formatted = formatNumber(value, language); const fontSize = monetaryFontSizeFor(formatted, compact);
  return <View accessibilityLabel={`${formatted} ${currencyLabel}`} style={[styles.wrap, inline && styles.inline, style]}>
    <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={inline ? 0.62 : 0.9} maxFontSizeMultiplier={1.2} style={[typography.numericLarge, styles.value, inline && styles.inlineValue, { color: colors.textPrimary, fontSize, lineHeight: fontSize + 7 }, textStyle]}>{formatted}</Text>
    <Text numberOfLines={1} style={[typography.caption, { color: colors.primary }, currencyTextStyle]}>{currencyLabel}</Text>
  </View>;
}

const styles = StyleSheet.create({ wrap: { minWidth: 0, alignItems: 'center', justifyContent: 'center', gap: 0 }, inline: { flexDirection: 'row', gap: 3 }, value: { width: '100%', textAlign: 'center', writingDirection: 'ltr', fontFamily: fonts.bold, fontVariant: ['tabular-nums'] }, inlineValue: { width: undefined, flexShrink: 1 } });
