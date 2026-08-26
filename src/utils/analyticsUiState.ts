import type { Language } from '@/types';
import type { AnalyticsPeriod } from '@/utils/salesAnalytics';
import { formatNumber } from '@/utils/formatters';
import { uiText } from '@/i18n/ui';

export const analyticsPeriodLabel = (period: AnalyticsPeriod, language: Language) => {
  const copy = uiText(language).analytics;
  return period === 'day' ? copy.today : period === 'week' ? copy.thisWeek : copy.thisMonth;
};

export const formatCompactAxisValue = (value: number, language: Language) => {
  if (!Number.isFinite(value)) return formatNumber(0, language);
  const absolute = Math.abs(value);
  const copy = uiText(language).analytics;
  const units = [{ limit: 1_000_000_000, divisor: 1_000_000_000, suffix: copy.billion }, { limit: 1_000_000, divisor: 1_000_000, suffix: copy.million }, { limit: 1_000, divisor: 1_000, suffix: copy.thousand }];
  const unit = units.find(item => absolute >= item.limit);
  if (!unit) return formatNumber(value, language);
  const scaled = value / unit.divisor;
  const digits = Math.abs(scaled) < 10 && scaled % 1 !== 0 ? 1 : 0;
  return `${formatNumber(scaled, language, digits)}${language === 'ar' ? ' ' : ''}${unit.suffix}`;
};

export const formatTrendAxisDate = (date: Date, period: AnalyticsPeriod, language: Language) => {
  const locale = language === 'ar' ? 'ar-SY' : 'en-US';
  if (period === 'month') return new Intl.DateTimeFormat(locale, { day: 'numeric' }).format(date);
  return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date);
};

export const formatTrendTooltipDate = (date: Date, language: Language) => new Intl.DateTimeFormat(
  language === 'ar' ? 'ar-SY' : 'en-US',
  { weekday: 'short', month: 'short', day: 'numeric' },
).format(date);

export const trendAccessibilitySummary = (
  points: { value: number }[],
  period: AnalyticsPeriod,
  language: Language,
) => {
  const highest = points.reduce((maximum, point) => Math.max(maximum, Number.isFinite(point.value) ? point.value : 0), 0);
  const total = points.reduce((sum, point) => sum + (Number.isFinite(point.value) ? point.value : 0), 0);
  const periodLabel = analyticsPeriodLabel(period, language);
  return uiText(language).analytics.trendSummary(periodLabel, formatNumber(total, language), formatNumber(points.length, language), formatNumber(highest, language));
};
