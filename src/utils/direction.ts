import { Language } from '@/types';

export const isRtlLanguage = (language: Language) => language === 'ar';
export const rowDirection = (rtl: boolean) => rtl ? 'row-reverse' as const : 'row' as const;
export const textDirection = (rtl: boolean) => rtl ? 'right' as const : 'left' as const;
