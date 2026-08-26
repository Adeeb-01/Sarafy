import type { Language } from '@/types';

export const formatNumber = (value: number, language: Language, digits = 0) =>
  new Intl.NumberFormat(language === 'ar' ? 'ar-SY' : 'en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);

export const formatUsd = (value: number, language: Language) =>
  new Intl.NumberFormat(language === 'ar' ? 'ar-SY' : 'en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value);
