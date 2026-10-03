import { memo } from 'react';
import { FlatList, Modal, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import type { ExchangeRateHistoryEntry, Language } from '@/types';
import { EmptyState } from '@/components/ui';
import { uiText } from '@/i18n';
import { formatDateTime, formatNumber } from '@/utils/formatters';
import { exchangeRateChangePercent, formatExchangeRateChange } from '@/utils/exchangeRate';
import { radius, spacing, typography, useAppTheme } from '@/theme';

export function RateHistoryScreen({ visible, entries, language, onClose }: { visible: boolean; entries: ExchangeRateHistoryEntry[]; language: Language; onClose: () => void }) {
  const { colors } = useAppTheme(); const rtl = language === 'ar'; const copy = uiText(language);
  return <Modal visible={visible} animationType="slide" onRequestClose={onClose}><SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
    <View style={[styles.header, { borderBottomColor: colors.border, flexDirection: rtl ? 'row-reverse' : 'row' }]}>
      <Text style={[typography.titleLarge, styles.title, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{copy.rate.history}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={copy.common.close} onPress={onClose} style={styles.close}><Feather name="x" size={22} color={colors.textSecondary} /></Pressable>
    </View>
    <FlatList data={entries} keyExtractor={item => item.uuid} renderItem={({ item }) => <RateHistoryRow item={item} language={language} />} contentContainerStyle={[styles.list, entries.length === 0 && styles.empty]} ItemSeparatorComponent={() => <View style={{ height: spacing.xs }} />} initialNumToRender={18} maxToRenderPerBatch={18} windowSize={7} removeClippedSubviews ListEmptyComponent={<EmptyState icon="clock" title={copy.rate.noHistory} description={copy.rate.history} />} />
  </SafeAreaView></Modal>;
}

const RateHistoryRow = memo(function RateHistoryRow({ item, language }: { item: ExchangeRateHistoryEntry; language: Language }) {
  const { colors } = useAppTheme(); const rtl = language === 'ar'; const copy = uiText(language); const percent = exchangeRateChangePercent(item.old_rate, item.new_rate) ?? 0; const rising = percent > 0;
  const formattedPercent = formatExchangeRateChange(item.old_rate, item.new_rate, language === 'ar' ? 'ar-SY' : 'en-US') ?? '0%';
  return <View accessibilityRole="text" accessibilityLabel={`${copy.rate.oldRate} ${item.old_rate}, ${copy.rate.newRate} ${item.new_rate}, ${formattedPercent}`} style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <View style={styles.rateLine}><View style={styles.rateTransition}><Text style={[typography.numericSmall, { color: colors.textSecondary, writingDirection: 'ltr' }]}>{formatNumber(item.old_rate, language)}</Text><Feather name="arrow-right" size={17} color={colors.textMuted} /><Text style={[typography.numericEmphasis, { color: colors.textPrimary, writingDirection: 'ltr' }]}>{formatNumber(item.new_rate, language)}</Text></View><View style={styles.spacer} /><Text style={[typography.label, { color: rising ? colors.warning : colors.primary, writingDirection: 'ltr' }]}>{formattedPercent}</Text></View>
    <Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left', writingDirection: 'ltr' }]}>{formatDateTime(item.created_at, language)}</Text>
  </View>;
});

const styles = StyleSheet.create({ screen: { flex: 1 }, header: { minHeight: 60, paddingHorizontal: spacing.md, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth }, title: { flex: 1 }, close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, list: { padding: spacing.md, paddingBottom: spacing.xxl }, empty: { flexGrow: 1, justifyContent: 'center' }, row: { minHeight: 76, padding: spacing.sm, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, gap: spacing.xxs }, rateLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs }, rateTransition: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs }, spacer: { flex: 1 } });
