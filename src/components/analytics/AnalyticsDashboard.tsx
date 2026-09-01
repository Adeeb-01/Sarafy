import { memo, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { EmptyState, MetricCard, MonetaryValue, SegmentedControl } from '@/components/ui';
import type { Expense, Language, Sale } from '@/types';
import { motion, radius, spacing, typography, useAppTheme } from '@/theme';
import { buildAnalytics, dailyRevenueSeries } from '@/utils/salesAnalytics';
import type { AnalyticsPeriod } from '@/utils/salesAnalytics';
import { analyticsPeriodLabel } from '@/utils/analyticsUiState';
import { formatNumber } from '@/utils/formatters';
import { haptics } from '@/utils/haptics';
import { AnalyticsDetailSheet } from '@/components/analytics/AnalyticsDetailSheet';
import type { AnalyticsDetail, AnalyticsMetricKey } from '@/components/analytics/AnalyticsDetailSheet';
import { SalesTrendChart } from '@/components/analytics/SalesTrendChart';
import { uiText } from '@/i18n';

export const AnalyticsDashboard = memo(function AnalyticsDashboard({ sales, expenses, language, bottomNavigationInset }: { sales: Sale[]; expenses: Expense[]; language: Language; bottomNavigationInset: number }) {
  const { colors } = useAppTheme();
  const rtl = language === 'ar';
  const copy = uiText(language);
  const [period, setPeriod] = useState<AnalyticsPeriod>('day');
  const [detail, setDetail] = useState<AnalyticsDetail | null>(null);
  const opacity = useSharedValue(1);
  const translateY = useSharedValue(0);
  const analytics = useMemo(() => buildAnalytics(sales, expenses, period), [expenses, period, sales]);
  const trend = useMemo(() => dailyRevenueSeries(sales, period), [period, sales]);
  const visibleTopProducts = analytics.topProducts;
  const periodLabel = analyticsPeriodLabel(period, language);
  const currencyLabel = copy.common.syp;
  const periodOptions = [
    { value: 'day' as const, label: copy.analytics.today },
    { value: 'week' as const, label: copy.analytics.week },
    { value: 'month' as const, label: copy.analytics.month },
  ];

  useEffect(() => {
    opacity.value = 0.62;
    translateY.value = 5;
    opacity.value = withTiming(1, { duration: motion.duration.fast, easing: motion.easing, reduceMotion: ReduceMotion.System });
    translateY.value = withTiming(0, { duration: motion.duration.fast, easing: motion.easing, reduceMotion: ReduceMotion.System });
  }, [opacity, period, translateY]);
  const transitionStyle = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ translateY: translateY.value }] }));
  const openMetric = (metric: AnalyticsMetricKey) => setDetail({ kind: 'metric', metric });
  const metricAccessibility = (label: string, value: string) => copy.analytics.metricAccessibility(label, value, periodLabel);

  return <View style={[styles.flex, { backgroundColor: colors.background }]}>
    <ScrollView style={styles.flex} showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, { paddingBottom: bottomNavigationInset + spacing.xl }]}>
      <View style={styles.period}><SegmentedControl options={periodOptions} value={period} onChange={setPeriod} rtl={rtl} subtle accessibilityLabel={copy.analytics.period} /></View>
      <Animated.View style={[styles.dashboard, transitionStyle]}>
        <Pressable accessibilityRole="button" accessibilityLabel={metricAccessibility(copy.analytics.netProfit, `${formatNumber(analytics.netProfit, language)} ${currencyLabel}`)} accessibilityHint={copy.analytics.openNetProfit} onPress={() => { haptics.tap(); openMetric('netProfit'); }} style={({ pressed }) => [styles.hero, { backgroundColor: colors.surface }, pressed && styles.pressed]}>
          <View style={[styles.heroLayout, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>
            <View style={[styles.heroIcon, { backgroundColor: analytics.netProfit < 0 ? colors.dangerSoft : colors.primarySoft }]}><Feather name="activity" size={20} color={analytics.netProfit < 0 ? colors.danger : colors.primary} /></View>
            <View style={styles.heroCopy}>
              <Text style={[typography.title, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{copy.analytics.netProfit}</Text>
              <Text style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{periodLabel}</Text>
              <MonetaryValue value={analytics.netProfit} language={language} currencyLabel={currencyLabel} compact={false} inline style={[styles.heroMoney, { alignSelf: rtl ? 'flex-end' : 'flex-start', flexDirection: rtl ? 'row-reverse' : 'row' }]} textStyle={analytics.netProfit < 0 ? { color: colors.danger } : undefined} currencyTextStyle={{ color: colors.textMuted }} />
            </View>
            <View style={styles.heroChevron}><Feather name={rtl ? 'chevron-left' : 'chevron-right'} size={20} color={colors.textMuted} /></View>
          </View>
        </Pressable>

        <AnalyticsSectionTitle title={copy.analytics.coreMetrics} rtl={rtl} />
        <View style={[styles.metricGrid, { flexDirection: rtl ? 'row-reverse' : 'row' }]}>
          <MetricSlot label={copy.analytics.revenue} value={analytics.revenue} icon="credit-card" metric="revenue" analyticsLabel={metricAccessibility(copy.analytics.revenue, `${formatNumber(analytics.revenue, language)} ${currencyLabel}`)} language={language} onOpen={openMetric} />
          <MetricSlot label={copy.analytics.grossProfit} value={analytics.grossProfit} icon="trending-up" metric="grossProfit" analyticsLabel={metricAccessibility(copy.analytics.grossProfit, `${formatNumber(analytics.grossProfit, language)} ${currencyLabel}`)} language={language} onOpen={openMetric} negative={analytics.grossProfit < 0} />
          <MetricSlot label={copy.analytics.expenses} value={analytics.expenses} icon="minus-circle" metric="expenses" analyticsLabel={metricAccessibility(copy.analytics.operatingExpenses, `${formatNumber(analytics.expenses, language)} ${currencyLabel}`)} language={language} onOpen={openMetric} />
          <View style={styles.metricSlot}><MetricCard compact label={copy.analytics.invoiceCount} value={formatNumber(analytics.invoiceCount, language)} icon="file-text" rtl={rtl} onPress={() => openMetric('invoiceCount')} accessibilityLabel={metricAccessibility(copy.analytics.invoiceCount, formatNumber(analytics.invoiceCount, language))} accessibilityHint={copy.analytics.openInvoices} /></View>
        </View>

        <View style={[styles.sectionDivider, { backgroundColor: colors.border }]} />
        <AnalyticsSectionTitle title={copy.analytics.trend} subtitle={periodLabel} rtl={rtl} />
        {analytics.hasActivity ? <SalesTrendChart points={trend} period={period} language={language} /> : <View style={[styles.compactEmpty, { backgroundColor: colors.surfaceSecondary }]}><EmptyState icon="bar-chart-2" title={copy.analytics.noSales} description={copy.analytics.noSalesDescription} /></View>}

        <AnalyticsSectionTitle title={copy.analytics.summary} rtl={rtl} />
        <View style={[styles.summaryBand, { backgroundColor: colors.surfaceSecondary, flexDirection: rtl ? 'row-reverse' : 'row' }]}>
          <SummaryStat label={copy.analytics.invoices} value={analytics.invoiceCount} language={language} rtl={rtl} />
          <SummaryStat label={copy.analytics.itemsSold} value={analytics.itemCount} language={language} rtl={rtl} />
          <SummaryStat label={copy.analytics.averageInvoice} value={analytics.averageInvoice} currencyLabel={currencyLabel} language={language} rtl={rtl} />
        </View>

        <AnalyticsSectionTitle title={copy.analytics.topProducts} rtl={rtl} />
        {visibleTopProducts.length > 0 ? <View style={[styles.ranking, { borderColor: colors.border }]}>{visibleTopProducts.map((product, index) => <TopProductRow key={product.name} product={product} rank={index + 1} maximumRevenue={visibleTopProducts[0]?.revenue ?? 0} language={language} last={index === visibleTopProducts.length - 1} onPress={() => setDetail({ kind: 'product', product, rank: index + 1 })} />)}</View> : <View style={[styles.compactEmpty, { backgroundColor: colors.surfaceSecondary }]}><EmptyState icon="package" title={copy.analytics.noTopProducts} description={copy.analytics.noTopProductsDescription} /></View>}
      </Animated.View>
    </ScrollView>
    <AnalyticsDetailSheet detail={detail} analytics={analytics} period={period} language={language} onClose={() => setDetail(null)} />
  </View>;
});

function MetricSlot({ label, value, icon, metric, analyticsLabel, language, onOpen, negative = false }: { label: string; value: number; icon: keyof typeof Feather.glyphMap; metric: AnalyticsMetricKey; analyticsLabel: string; language: Language; onOpen: (metric: AnalyticsMetricKey) => void; negative?: boolean }) {
  const { colors } = useAppTheme(); const rtl = language === 'ar'; const copy = uiText(language); const currencyLabel = copy.common.syp;
  return <View style={styles.metricSlot}><MetricCard compact label={label} value={`${formatNumber(value, language)} ${currencyLabel}`} valueNode={<MonetaryValue value={value} language={language} currencyLabel={currencyLabel} inline style={[styles.metricMoney, { flexDirection: rtl ? 'row-reverse' : 'row' }]} textStyle={negative ? { color: colors.danger } : undefined} />} icon={icon} rtl={rtl} onPress={() => onOpen(metric)} accessibilityLabel={analyticsLabel} accessibilityHint={copy.analytics.openMetric} /></View>;
}

function AnalyticsSectionTitle({ title, subtitle, rtl }: { title: string; subtitle?: string; rtl: boolean }) {
  const { colors } = useAppTheme();
  return <View style={[styles.sectionTitle, { flexDirection: rtl ? 'row-reverse' : 'row' }]}><Text style={[typography.title, styles.sectionTitleText, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{title}</Text>{subtitle && <Text style={[typography.caption, { color: colors.textMuted }]}>{subtitle}</Text>}</View>;
}

function SummaryStat({ label, value, language, currencyLabel, rtl }: { label: string; value: number; language: Language; currencyLabel?: string; rtl: boolean }) {
  const { colors } = useAppTheme();
  return <View style={styles.summaryStat}><Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} maxFontSizeMultiplier={1.2} style={[typography.caption, styles.summaryLabel, { color: colors.textMuted, textAlign: 'center' }]}>{label}</Text><View style={styles.summaryValue}>{currencyLabel ? <MonetaryValue value={value} language={language} currencyLabel={currencyLabel} inline style={[styles.summaryMoney, { flexDirection: rtl ? 'row-reverse' : 'row' }]} textStyle={styles.summaryMoneyText} /> : <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} maxFontSizeMultiplier={1.2} style={[typography.numericMedium, { color: colors.textPrimary, textAlign: 'center' }]}>{formatNumber(value, language)}</Text>}</View></View>;
}

type TopProduct = ReturnType<typeof buildAnalytics>['topProducts'][number];
const TopProductRow = memo(function TopProductRow({ product, rank, maximumRevenue, language, last, onPress }: { product: TopProduct; rank: number; maximumRevenue: number; language: Language; last: boolean; onPress: () => void }) {
  const { colors } = useAppTheme(); const rtl = language === 'ar'; const copy = uiText(language); const progress = maximumRevenue > 0 ? Math.max(0, Math.min(100, product.revenue / maximumRevenue * 100)) : 0;
  const accessible = copy.analytics.rankAccessibility(formatNumber(rank, language), product.name, formatNumber(product.quantity, language), formatNumber(product.revenue, language));
  return <Pressable accessibilityRole="button" accessibilityLabel={accessible} accessibilityHint={copy.analytics.openProduct} onPress={() => { haptics.tap(); onPress(); }} style={({ pressed }) => [styles.productRow, { flexDirection: rtl ? 'row-reverse' : 'row', borderBottomColor: colors.border, borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth }, pressed && styles.pressed]}><View style={[styles.rank, { backgroundColor: colors.primarySoft }]}><Text style={[typography.label, { color: colors.primary }]}>{formatNumber(rank, language)}</Text></View><View style={styles.productCopy}><Text numberOfLines={1} ellipsizeMode="tail" style={[typography.bodyMedium, { color: colors.textPrimary, textAlign: rtl ? 'right' : 'left' }]}>{product.name}</Text><Text numberOfLines={1} style={[typography.caption, { color: colors.textMuted, textAlign: rtl ? 'right' : 'left' }]}>{copy.analytics.itemsCount(formatNumber(product.quantity, language))}</Text><View style={[styles.progressTrack, { backgroundColor: colors.surfaceSecondary }]}><View style={[styles.progressFill, { backgroundColor: colors.primary, width: `${progress}%` }]} /></View></View><MonetaryValue value={product.revenue} language={language} currencyLabel={copy.common.syp} inline style={[styles.productMoney, { flexDirection: rtl ? 'row-reverse' : 'row' }]} textStyle={styles.productMoneyText} /></Pressable>;
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: spacing.md, paddingTop: spacing.xs },
  period: { height: 52, paddingVertical: spacing.xxs },
  dashboard: { gap: spacing.md },
  hero: { minHeight: 92, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.md, justifyContent: 'center' },
  heroLayout: { minWidth: 0, alignItems: 'flex-start', gap: spacing.xs },
  heroIcon: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  heroCopy: { minWidth: 0, flex: 1 },
  heroMoney: { maxWidth: '100%', justifyContent: 'flex-start', marginTop: spacing.xxs },
  heroChevron: { width: 20, height: 44, alignItems: 'center', justifyContent: 'center' },
  metricGrid: { flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.xs },
  metricSlot: { width: '48.5%' },
  metricMoney: { justifyContent: 'flex-start' },
  sectionTitle: { minHeight: 28, alignItems: 'center', justifyContent: 'space-between', gap: spacing.xs },
  sectionTitleText: { minWidth: 0, flex: 1 },
  sectionDivider: { height: StyleSheet.hairlineWidth },
  compactEmpty: { borderRadius: radius.md, overflow: 'hidden' },
  summaryBand: { justifyContent: 'space-between', borderRadius: radius.md, padding: spacing.xxs, gap: spacing.xxs },
  summaryStat: { minWidth: 0, flex: 1, minHeight: 68, paddingVertical: spacing.xxs, justifyContent: 'center', gap: 0 },
  summaryLabel: { minHeight: 20 },
  summaryValue: { minHeight: 32, justifyContent: 'center' },
  summaryMoney: { alignSelf: 'stretch', justifyContent: 'center' },
  summaryMoneyText: { ...typography.numericCompact },
  ranking: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  productRow: { minHeight: 78, paddingHorizontal: spacing.xs, paddingVertical: spacing.xxs, alignItems: 'center', gap: spacing.xs },
  rank: { width: 32, height: 32, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  productCopy: { minWidth: 0, flex: 1, gap: 0 },
  progressTrack: { height: 10, borderRadius: radius.pill, overflow: 'hidden', marginTop: spacing.xxs },
  progressFill: { height: '100%', borderRadius: radius.pill },
  productMoney: { width: 96, justifyContent: 'flex-end' },
  productMoneyText: { ...typography.numericSmall },
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
});
