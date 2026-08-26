import { StyleSheet, Text, View } from 'react-native';
import { BottomSheet, MonetaryValue } from '@/components/ui';
import type { Language } from '@/types';
import { radius, spacing, typography, useAppTheme } from '@/theme';
import type { AnalyticsPeriod, buildAnalytics } from '@/utils/salesAnalytics';
import { analyticsPeriodLabel } from '@/utils/analyticsUiState';
import { formatNumber } from '@/utils/formatters';
import { uiText } from '@/i18n';

type AnalyticsResult = ReturnType<typeof buildAnalytics>;
type TopProduct = AnalyticsResult['topProducts'][number];
export type AnalyticsMetricKey = 'netProfit' | 'revenue' | 'grossProfit' | 'expenses' | 'invoiceCount';
export type AnalyticsDetail = { kind: 'metric'; metric: AnalyticsMetricKey } | { kind: 'product'; product: TopProduct; rank: number };

export function AnalyticsDetailSheet({ detail, analytics, period, language, onClose }: { detail: AnalyticsDetail | null; analytics: AnalyticsResult; period: AnalyticsPeriod; language: Language; onClose: () => void }) {
  const { colors } = useAppTheme();
  const rtl = language === 'ar';
  const copy = uiText(language);
  if (!detail) return null;
  if (detail.kind === 'product') {
    return <BottomSheet visible onClose={onClose} title={detail.product.name} rtl={rtl}><View style={styles.content}>
      <PlainRow label={copy.analytics.rank} value={`#${formatNumber(detail.rank, language)}`} rtl={rtl} />
      <PlainRow label={copy.analytics.itemsSold} value={formatNumber(detail.product.quantity, language)} rtl={rtl} />
      <MoneyRow label={copy.analytics.revenue} value={detail.product.revenue} language={language} />
      <Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.analytics.periodLabel(analyticsPeriodLabel(period, language))}</Text>
    </View></BottomSheet>;
  }

  const titles: Record<AnalyticsMetricKey, string> = { netProfit: copy.analytics.netProfitDetails, revenue: copy.analytics.revenueDetails, grossProfit: copy.analytics.grossProfitDetails, expenses: copy.analytics.expensesDetails, invoiceCount: copy.analytics.invoiceDetails };
  const productCosts = analytics.revenue - analytics.grossProfit;
  return <BottomSheet visible onClose={onClose} title={titles[detail.metric]} rtl={rtl}><View style={styles.content}>
    {detail.metric === 'netProfit' && <View style={[styles.formula, { backgroundColor: colors.surfaceSecondary }]}>
      <MoneyRow label={copy.analytics.revenue} value={analytics.revenue} language={language} />
      <MoneyRow operator="−" label={copy.analytics.productCosts} value={productCosts} language={language} />
      <MoneyRow operator="=" label={copy.analytics.grossProfit} value={analytics.grossProfit} language={language} />
      <MoneyRow operator="−" label={copy.analytics.expenses} value={analytics.expenses} language={language} />
      <MoneyRow operator="=" label={copy.analytics.netProfit} value={analytics.netProfit} language={language} strong negative={analytics.netProfit < 0} />
    </View>}
    {detail.metric === 'revenue' && <><MoneyRow label={copy.analytics.revenue} value={analytics.revenue} language={language} strong /><PlainRow label={copy.analytics.invoiceCount} value={formatNumber(analytics.invoiceCount, language)} rtl={rtl} /><MoneyRow label={copy.analytics.averageInvoice} value={analytics.averageInvoice} language={language} /></>}
    {detail.metric === 'grossProfit' && <View style={[styles.formula, { backgroundColor: colors.surfaceSecondary }]}><MoneyRow label={copy.analytics.revenue} value={analytics.revenue} language={language} /><MoneyRow operator="−" label={copy.analytics.productCosts} value={productCosts} language={language} /><MoneyRow operator="=" label={copy.analytics.grossProfit} value={analytics.grossProfit} language={language} strong negative={analytics.grossProfit < 0} /></View>}
    {detail.metric === 'expenses' && <MoneyRow label={copy.analytics.operatingExpenses} value={analytics.expenses} language={language} strong />}
    {detail.metric === 'invoiceCount' && <><PlainRow label={copy.analytics.invoiceCount} value={formatNumber(analytics.invoiceCount, language)} rtl={rtl} /><PlainRow label={copy.analytics.itemsSold} value={formatNumber(analytics.itemCount, language)} rtl={rtl} /><MoneyRow label={copy.analytics.averageInvoice} value={analytics.averageInvoice} language={language} /></>}
    <Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.analytics.periodLabel(analyticsPeriodLabel(period, language))}</Text>
  </View></BottomSheet>;
}

function MoneyRow({ label, value, language, operator, strong = false, negative = false }: { label: string; value: number; language: Language; operator?: string; strong?: boolean; negative?: boolean }) {
  const { colors } = useAppTheme(); const rtl = language === 'ar'; const copy = uiText(language);
  return <View style={[styles.row, strong && styles.strongRow, { flexDirection: rtl ? 'row-reverse' : 'row', borderBottomColor: colors.border, borderTopColor: colors.border }]}>{operator ? <Text style={[styles.operator, typography.bodyMedium, { color: colors.textMuted }]}>{operator}</Text> : <View style={styles.operator} />}<Text style={[strong ? typography.bodyMedium : typography.body, styles.rowLabel, { color: strong ? colors.textPrimary : colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{label}</Text><MonetaryValue value={value} language={language} currencyLabel={copy.common.syp} inline style={[styles.rowMoney, { flexDirection: rtl ? 'row-reverse' : 'row' }]} textStyle={[strong ? styles.strongMoneyText : styles.moneyText, negative && { color: colors.danger }]} /></View>;
}

function PlainRow({ label, value, rtl }: { label: string; value: string; rtl: boolean }) {
  const { colors } = useAppTheme();
  return <View style={[styles.row, { flexDirection: rtl ? 'row-reverse' : 'row', borderBottomColor: colors.border }]}><Text style={[styles.rowLabel, typography.body, { color: colors.textSecondary, textAlign: rtl ? 'right' : 'left' }]}>{label}</Text><Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} style={[typography.numericMedium, { color: colors.textPrimary, writingDirection: 'ltr' }]}>{value}</Text></View>;
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xs, gap: spacing.xxs },
  formula: { paddingHorizontal: spacing.sm, borderRadius: radius.md },
  row: { minHeight: 44, alignItems: 'center', gap: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  strongRow: { minHeight: 50, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: 0 },
  operator: { width: 16, textAlign: 'center' },
  rowLabel: { minWidth: 0, flex: 1 },
  rowMoney: { maxWidth: '54%', justifyContent: 'flex-end' },
  moneyText: { ...typography.numericCompact },
  strongMoneyText: { ...typography.numericMedium },
});
