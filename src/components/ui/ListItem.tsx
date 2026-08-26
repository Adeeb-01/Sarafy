import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { spacing, typography, useAppTheme } from '@/theme';
import { haptics } from '@/utils/haptics';

export function ListItem({ title, description, icon, onPress, rtl = false, tone = 'default', disabled = false, loading = false, haptic = 'tap', trailing }: { title: string; description?: string; icon?: keyof typeof Feather.glyphMap; onPress?: () => void; rtl?: boolean; tone?: 'default' | 'danger'; disabled?: boolean; loading?: boolean; haptic?: 'tap' | 'selection' | 'none'; trailing?: React.ReactNode }) {
  const { colors } = useAppTheme(); const color = tone === 'danger' ? colors.danger : colors.primary;
  const inactive = disabled || loading;
  return <Pressable accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={title} accessibilityHint={description} accessibilityState={onPress ? { disabled: inactive, busy: loading } : undefined} disabled={!onPress || inactive} onPress={() => { if (haptic !== 'none') haptics[haptic](); onPress?.(); }} style={({ pressed }) => [styles.row, { flexDirection: rtl ? 'row-reverse' : 'row', borderBottomColor: colors.border }, pressed && styles.pressed, inactive && styles.disabled]}>
    {icon && <View style={styles.icon}><Feather name={icon} size={18} color={tone === 'danger' ? color : colors.textSecondary} /></View>}
    <View style={styles.copy}><Text style={[typography.bodyMedium, { color: tone === 'danger' ? colors.danger : colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{title}</Text>{description && <Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{description}</Text>}</View>
    {loading ? <ActivityIndicator color={colors.primary} /> : trailing ?? (onPress && <Feather name={rtl ? 'chevron-left' : 'chevron-right'} size={20} color={colors.textMuted} />)}
  </Pressable>;
}

export function SectionHeader({ title, subtitle, actionLabel, onAction, rtl = false }: { title: string; subtitle?: string; actionLabel?: string; onAction?: () => void; rtl?: boolean }) {
  const { colors } = useAppTheme();
  return <View style={[styles.header, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><View style={styles.copy}><Text style={[typography.title, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{title}</Text>{subtitle && <Text style={[typography.caption, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{subtitle}</Text>}</View>{actionLabel && onAction && <Pressable accessibilityRole="button" accessibilityLabel={actionLabel} onPress={onAction} hitSlop={8} style={styles.headerAction}><Text style={[typography.label, { color: colors.primary }]}>{actionLabel}</Text></Pressable>}</View>;
}

const styles = StyleSheet.create({ row: { minHeight: 50, paddingHorizontal: spacing.sm, paddingVertical: spacing.xxs, alignItems: 'center', gap: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth }, icon: { width: 28, height: 44, alignItems: 'center', justifyContent: 'center' }, copy: { flex: 1, gap: 0 }, header: { minHeight: 44, alignItems: 'center', gap: spacing.xs }, headerAction: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }, pressed: { opacity: 0.72 }, disabled: { opacity: 0.45 } });
