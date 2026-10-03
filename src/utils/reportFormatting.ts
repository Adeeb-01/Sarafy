import type { Language } from '@/types';
import { formatDateTime, formatNumber } from '@/utils/formatters';

export const REPORT_NUMERIC_CSS = '.num,.money,.id{direction:ltr;unicode-bidi:isolate;font-variant-numeric:tabular-nums}';

export const formatReportDateTime = (value: string | number | Date, language: Language) => formatDateTime(value, language);

export const formatReportSyp = (value: number, language: Language, label: string) => `${formatNumber(Math.round(value), language)} ${label}`;
