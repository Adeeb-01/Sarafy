import type { Language } from '@/types';
import { normalizeNumericOutput } from './numerals.ts';

const NUMBER_LOCALE = 'en-US-u-nu-latn';
const formatterCache = new Map<string, Intl.NumberFormat>();
const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function numberFormatter(options: Intl.NumberFormatOptions) {
  const key = JSON.stringify(options);
  const cached = formatterCache.get(key);
  if (cached) return cached;
  const formatter = new Intl.NumberFormat(NUMBER_LOCALE, { numberingSystem: 'latn', ...options });
  formatterCache.set(key, formatter);
  return formatter;
}

function dateFormatter(language: Language, options: Intl.DateTimeFormatOptions) {
  const locale = language === 'ar' ? 'ar-SY-u-ca-gregory-nu-latn' : 'en-US-u-ca-gregory-nu-latn';
  const key = `${locale}:${JSON.stringify(options)}`;
  const cached = dateFormatterCache.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(locale, { calendar: 'gregory', numberingSystem: 'latn', ...options });
  dateFormatterCache.set(key, formatter);
  return formatter;
}

export const formatNumber = (value: number, _language: Language, digits = 0) => normalizeNumericOutput(
  numberFormatter({ maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value),
);

export const formatDecimal = (value: number, _language: Language, minimumFractionDigits = 0, maximumFractionDigits = 2) =>
  normalizeNumericOutput(numberFormatter({ minimumFractionDigits, maximumFractionDigits }).format(value));

export const formatUsd = (value: number, _language: Language) => normalizeNumericOutput(
  numberFormatter({
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
  }).format(value),
);

export const formatProductUsd = (value: number, _language: Language) => normalizeNumericOutput(
  numberFormatter({
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  }).format(value),
);

export function formatUsdCents(cents: number, _language: Language = 'en') {
  if (!Number.isSafeInteger(cents)) throw new Error('INVALID_USD_CENTS');
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  return `${sign}${formatNumber(whole, 'en')}.${fraction} USD`;
}

export function formatPercent(value: number, language: Language, maximumFractionDigits = 1, showPositiveSign = false) {
  if (!Number.isFinite(value)) return '';
  const normalized = Math.abs(value) < 0.5 * 10 ** -maximumFractionDigits ? 0 : value;
  const sign = showPositiveSign && normalized > 0 ? '+' : '';
  return `${sign}${formatDecimal(normalized, language, 0, maximumFractionDigits)}%`;
}

export function formatDate(value: string | number | Date, language: Language, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }) {
  return normalizeNumericOutput(dateFormatter(language, options).format(new Date(value)));
}

export function formatTime(value: string | number | Date, language: Language, options: Intl.DateTimeFormatOptions = { timeStyle: 'short' }) {
  return normalizeNumericOutput(dateFormatter(language, options).format(new Date(value)));
}

export function formatDateTime(value: string | number | Date, language: Language, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }) {
  return normalizeNumericOutput(dateFormatter(language, options).format(new Date(value)));
}

export function formatWeekday(value: string | number | Date, language: Language, width: 'short' | 'long' = 'short') {
  return formatDate(value, language, { weekday: width });
}
