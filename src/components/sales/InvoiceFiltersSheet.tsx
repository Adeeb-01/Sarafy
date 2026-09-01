import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AppButton, AppInput, BottomSheet, SegmentedControl } from '@/components/ui';
import { uiText } from '@/i18n';
import { InvoicePeriod, InvoiceQuery, InvoiceSort, Language } from '@/types';
import { spacing, typography, useAppTheme } from '@/theme';
import { parseLocalizedNumber } from '@/utils/salesUiState';

export function InvoiceFiltersSheet({ visible, value, language, onClose, onApply }:
  { visible: boolean; value: InvoiceQuery; language: Language; onClose: () => void; onApply: (query: InvoiceQuery) => void }) {
  const copy = uiText(language); const rtl = language === 'ar'; const { colors } = useAppTheme();
  const [period, setPeriod] = useState<InvoicePeriod>(value.period ?? 'all');
  const [sort, setSort] = useState<InvoiceSort>(value.sort ?? 'newest');
  const [min, setMin] = useState(value.minAmount == null ? '' : String(value.minAmount));
  const [max, setMax] = useState(value.maxAmount == null ? '' : String(value.maxAmount));
  useEffect(() => { if (visible) { setPeriod(value.period ?? 'all'); setSort(value.sort ?? 'newest'); setMin(value.minAmount == null ? '' : String(value.minAmount)); setMax(value.maxAmount == null ? '' : String(value.maxAmount)); } }, [value, visible]);
  const periods = [{ value: 'all' as const, label: copy.common.all }, { value: 'today' as const, label: copy.sales.today }, { value: 'week' as const, label: copy.sales.thisWeek }, { value: 'month' as const, label: copy.sales.thisMonth }];
  const sorts = [{ value: 'newest' as const, label: copy.sales.newest }, { value: 'oldest' as const, label: copy.sales.oldest }, { value: 'highest' as const, label: copy.sales.highest }, { value: 'lowest' as const, label: copy.sales.lowest }];
  const apply = () => onApply({ ...value, period, sort, minAmount: min.trim() ? parseLocalizedNumber(min) : null, maxAmount: max.trim() ? parseLocalizedNumber(max) : null });
  return <BottomSheet visible={visible} onClose={onClose} title={copy.sales.invoiceFilters} rtl={rtl} keyboardAware>
    <View style={styles.content}><Text style={[typography.label, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.period}</Text><SegmentedControl options={periods} value={period} onChange={setPeriod} rtl={rtl} compactLabels accessibilityLabel={copy.sales.period} />
      <Text style={[typography.label, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{copy.sales.sort}</Text><SegmentedControl options={sorts} value={sort} onChange={setSort} rtl={rtl} compactLabels accessibilityLabel={copy.sales.sort} />
      <View style={[styles.amounts, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><AppInput label={copy.sales.minAmount} value={min} onChangeText={setMin} keyboardType="number-pad" rtl={rtl} style={styles.technicalInput} containerStyle={styles.amount} /><AppInput label={copy.sales.maxAmount} value={max} onChangeText={setMax} keyboardType="number-pad" rtl={rtl} style={styles.technicalInput} containerStyle={styles.amount} /></View>
      <View style={[styles.actions, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><AppButton label={copy.sales.clearFilters} variant="secondary" onPress={() => { setPeriod('all'); setSort('newest'); setMin(''); setMax(''); }} style={styles.action} /><AppButton label={copy.sales.applyFilters} icon="filter" onPress={apply} style={styles.action} /></View>
    </View>
  </BottomSheet>;
}

const styles = StyleSheet.create({ content: { paddingBottom: spacing.xs, gap: spacing.xs }, amounts: { gap: spacing.xs }, amount: { flex: 1, minWidth: 0 }, technicalInput: { writingDirection: 'ltr' }, actions: { gap: spacing.xs, paddingTop: spacing.xs }, action: { flex: 1 } });
