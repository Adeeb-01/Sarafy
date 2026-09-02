import type { Language } from '../types/index.ts';
import type { AnalyticsPeriod, MetricComparison } from './salesAnalytics.ts';
import { formatNumber } from './formatters.ts';
import { uiText } from '../i18n/ui.ts';

export const analyticsPeriodLabel = (period: AnalyticsPeriod, language: Language) => {
  const copy = uiText(language).analytics;
  return period === 'day' ? copy.today : period === 'week' ? copy.thisWeek : copy.thisMonth;
};

export const comparisonPeriodLabel = (period: AnalyticsPeriod, language: Language) => {
  const copy = uiText(language).analytics;
  return period === 'day' ? copy.vsYesterday : period === 'week' ? copy.vsWeek : copy.vsMonth;
};

export const formatAnalyticsPercent = (value: number | null, language: Language) => {
  if (value == null || !Number.isFinite(value)) return null;
  const normalized = Math.abs(value) < 0.05 ? 0 : value;
  const capped = Math.abs(normalized) > 999 ? `${normalized < 0 ? '<-' : '>'}999` : `${normalized > 0 ? '+' : ''}${normalized.toLocaleString(language === 'ar' ? 'ar-SY' : 'en-US', { maximumFractionDigits: 1 })}`;
  return `${capped}%`;
};

export const formatComparison = (comparison: MetricComparison, language: Language) => {
  if (comparison.direction === 'same') return '0%';
  return formatAnalyticsPercent(comparison.percentageChange, language);
};

export const weekdayLabel = (day: number, language: Language, width: 'short' | 'long' = 'short') => {
  const sunday = new Date(2026, 7, 23 + day, 12);
  return new Intl.DateTimeFormat(language === 'ar' ? 'ar-SY' : 'en-US', { weekday: width }).format(sunday);
};

export const hourLabel = (hour: number, language: Language) => new Intl.DateTimeFormat(
  language === 'ar' ? 'ar-SY' : 'en-US', { hour: 'numeric', hour12: true },
).format(new Date(2026, 0, 1, hour));

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
