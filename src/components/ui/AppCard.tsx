import { PropsWithChildren, ReactNode } from 'react';
import { Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { radius, shadows, spacing, typography, useAppTheme } from '@/theme';
import { haptics } from '@/utils/haptics';

export function AppCard({ children, style, elevated = false }: PropsWithChildren<{ style?: StyleProp<ViewStyle>; elevated?: boolean }>) {
  const { colors } = useAppTheme();
  return <View style={[styles.card, { backgroundColor: colors.surface }, elevated && shadows.card, style]}>{children}</View>;
}

export function MetricCard({ label, value, valueNode, change, icon, onPress, rtl = false, accessibilityLabel, accessibilityHint, style, compact = false }: { label: string; value: string; valueNode?: ReactNode; change?: string; icon?: keyof typeof Feather.glyphMap; onPress?: () => void; rtl?: boolean; accessibilityLabel?: string; accessibilityHint?: string; style?: StyleProp<ViewStyle>; compact?: boolean }) {
  const { colors } = useAppTheme();
  const body = <AppCard style={[styles.metric, compact && styles.metricCompact, style]}>
    <View style={[styles.metricHeader, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>{icon && <Feather name={icon} size={18} color={colors.primary} />}<Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78} maxFontSizeMultiplier={1.2} style={[typography.caption, styles.metricLabel, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{label}</Text></View>
    {valueNode ?? <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.65} maxFontSizeMultiplier={1.2} style={[typography.numericLarge, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{value}</Text>}
    {change && <Text style={[typography.caption, { color: change.trim().startsWith('-') ? colors.danger : colors.success }]}>{change}</Text>}
  </AppCard>;
  if (!onPress) return body;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? `${label}: ${value}`} accessibilityHint={accessibilityHint} onPress={() => { haptics.tap(); onPress(); }} style={({ pressed }) => pressed && styles.pressed}>{body}</Pressable>;
}

export const InteractiveMetricCard = MetricCard;

const styles = StyleSheet.create({ card: { borderRadius: radius.md, overflow: 'hidden' }, metric: { minHeight: 98, padding: spacing.sm, gap: spacing.xxs, justifyContent: 'space-between' }, metricCompact: { minHeight: 88, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs }, metricHeader: { minWidth: 0, alignItems: 'center', gap: spacing.xs }, metricLabel: { minWidth: 0, flex: 1 }, pressed: { opacity: 0.82, transform: [{ scale: 0.985 }] } });
