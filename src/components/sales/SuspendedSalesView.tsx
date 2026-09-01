import { memo, useCallback } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { AppButton, EmptyState, MonetaryValue } from '@/components/ui';
import { uiText } from '@/i18n';
import { Language, SuspendedSaleSummary } from '@/types';
import { radius, spacing, typography, useAppTheme } from '@/theme';
import { formatNumber } from '@/utils/formatters';

export const SUSPENDED_ROW_HEIGHT = 150;

export function SuspendedSalesView({ drafts, language, bottomNavigationInset, busyId, onResume, onDelete }:
  { drafts: SuspendedSaleSummary[]; language: Language; bottomNavigationInset: number; busyId: number | null; onResume: (draft: SuspendedSaleSummary) => void; onDelete: (draft: SuspendedSaleSummary) => void }) {
  const copy = uiText(language);
  const renderItem = useCallback(({ item }: { item: SuspendedSaleSummary }) => <SuspendedRow draft={item} language={language} busy={busyId === item.id} onResume={onResume} onDelete={onDelete} />, [busyId, language, onDelete, onResume]);
  return <FlatList data={drafts} keyExtractor={draft => String(draft.id)} renderItem={renderItem} ItemSeparatorComponent={() => <View style={{ height: spacing.xs }} />}
    contentContainerStyle={[styles.list, { paddingBottom: bottomNavigationInset + spacing.md }, drafts.length === 0 && styles.grow]}
    initialNumToRender={10} maxToRenderPerBatch={10} windowSize={7} removeClippedSubviews
    ListEmptyComponent={<EmptyState icon="pause-circle" title={copy.sales.noSuspended} description={copy.sales.noSuspendedDescription} />} />;
}

const SuspendedRow = memo(function SuspendedRow({ draft, language, busy, onResume, onDelete }:
  { draft: SuspendedSaleSummary; language: Language; busy: boolean; onResume: (draft: SuspendedSaleSummary) => void; onDelete: (draft: SuspendedSaleSummary) => void }) {
  const { colors } = useAppTheme(); const copy = uiText(language); const rtl = language === 'ar';
  return <View style={[styles.row, { backgroundColor: colors.surface }]}>
    <View style={[styles.header, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><View style={[styles.pause, { backgroundColor: colors.warningSoft }]}><Feather name="pause" size={17} color={colors.warning} /></View><View style={styles.copy}><Text numberOfLines={1} style={[typography.bodyMedium, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{new Date(draft.updated_at).toLocaleString(language === 'ar' ? 'ar-SY' : 'en-US', { dateStyle: 'short', timeStyle: 'short' })}</Text><Text numberOfLines={1} style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.cartCount(formatNumber(draft.item_count, language))} · {draft.item_preview}</Text></View><MonetaryValue value={draft.net_total_syp} language={language} currencyLabel={copy.common.syp} inline style={{ flexDirection: rtl ? 'row-reverse' : 'row' }} textStyle={styles.money} /></View>
    <View style={[styles.actions, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><AppButton label={copy.sales.resumeSale} icon="play" onPress={() => onResume(draft)} loading={busy} style={styles.resume} /><Pressable accessibilityRole="button" accessibilityLabel={copy.sales.deleteDraft} disabled={busy} onPress={() => onDelete(draft)} style={({ pressed }) => [styles.delete, { backgroundColor: colors.dangerSoft }, pressed && styles.pressed]}><Feather name="trash-2" size={18} color={colors.danger} /></Pressable></View>
  </View>;
});

const styles = StyleSheet.create({
  list: { paddingHorizontal: spacing.md, paddingTop: spacing.xs }, grow: { flexGrow: 1, justifyContent: 'center' }, row: { minHeight: SUSPENDED_ROW_HEIGHT, padding: spacing.sm, borderRadius: radius.md, justifyContent: 'space-between', gap: spacing.sm },
  header: { alignItems: 'center', gap: spacing.xs }, pause: { width: 38, height: 38, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' }, copy: { minWidth: 0, flex: 1, gap: 2 }, money: { ...typography.numericCompact },
  actions: { gap: spacing.xs }, resume: { flex: 1 }, delete: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' }, pressed: { opacity: 0.74 },
});
