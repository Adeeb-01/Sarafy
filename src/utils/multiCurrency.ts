import type { Language, PaymentInput, PaymentMode, PaymentSettlement } from '@/types';

function normalizeDigits(value: string) {
  return value.trim()
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/٫/g, '.')
    .replace(/,/g, '.');
}

export function parseUsdToCents(value: string): number | null {
  const normalized = normalizeDigits(value);
  if (!/^(?:\d+)(?:\.\d{0,2})?$/.test(normalized)) return null;
  const [whole = '0', fraction = ''] = normalized.split('.');
  try {
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
    const result = Number(cents);
    return Number.isSafeInteger(result) ? result : null;
  } catch { return null; }
}

export function formatUsdCents(cents: number, language: Language = 'en') {
  if (!Number.isSafeInteger(cents)) throw new Error('INVALID_USD_CENTS');
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const value = `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')} USD`;
  return language === 'ar' ? value : value;
}

export function usdCentsToSyp(cents: number, rateSypPerUsd: number) {
  if (!Number.isSafeInteger(cents) || cents < 0 || !Number.isSafeInteger(rateSypPerUsd) || rateSypPerUsd <= 0) throw new Error('INVALID_PAYMENT_AMOUNT');
  const converted = (BigInt(cents) * BigInt(rateSypPerUsd) + 50n) / 100n;
  const result = Number(converted);
  if (!Number.isSafeInteger(result)) throw new Error('INVALID_PAYMENT_AMOUNT');
  return result;
}

export function minimumUsdCentsToCover(totalSyp: number, rateSypPerUsd: number) {
  if (!Number.isSafeInteger(totalSyp) || totalSyp < 0 || !Number.isSafeInteger(rateSypPerUsd) || rateSypPerUsd <= 0) throw new Error('INVALID_PAYMENT_AMOUNT');
  if (totalSyp === 0) return 0;
  const numerator = BigInt(totalSyp) * 100n - 50n;
  const cents = (numerator + BigInt(rateSypPerUsd) - 1n) / BigInt(rateSypPerUsd);
  let result = Number(cents < 0n ? 0n : cents);
  if (!Number.isSafeInteger(result)) throw new Error('INVALID_PAYMENT_AMOUNT');
  while (result > 0 && usdCentsToSyp(result - 1, rateSypPerUsd) >= totalSyp) result -= 1;
  while (usdCentsToSyp(result, rateSypPerUsd) < totalSyp) result += 1;
  if (!Number.isSafeInteger(result)) throw new Error('INVALID_PAYMENT_AMOUNT');
  return result;
}

export function normalizePaymentInput(input: PaymentInput): PaymentInput {
  return input.mode === 'SYP' ? { mode: 'SYP', sypAmount: input.sypAmount, usdCents: 0 }
    : input.mode === 'USD' ? { mode: 'USD', sypAmount: 0, usdCents: input.usdCents }
      : input;
}

export function calculateSettlement(totalSyp: number, rateSypPerUsd: number, rawInput: PaymentInput): PaymentSettlement {
  if (!Number.isSafeInteger(totalSyp) || totalSyp < 0) throw new Error('INVALID_PAYMENT_AMOUNT');
  const input = normalizePaymentInput(rawInput);
  if (!Number.isSafeInteger(input.sypAmount) || input.sypAmount < 0 || !Number.isSafeInteger(input.usdCents) || input.usdCents < 0) throw new Error('INVALID_PAYMENT_AMOUNT');
  const usdEquivalent = usdCentsToSyp(input.usdCents, rateSypPerUsd);
  const totalTenderEquivalentSyp = input.sypAmount + usdEquivalent;
  if (!Number.isSafeInteger(totalTenderEquivalentSyp)) throw new Error('INVALID_PAYMENT_AMOUNT');
  const remainingSyp = Math.max(0, totalSyp - totalTenderEquivalentSyp);
  const changeSyp = Math.max(0, totalTenderEquivalentSyp - totalSyp);
  const payments: PaymentSettlement['payments'] = [];
  if (input.mode !== 'USD') payments.push({ currency: 'SYP', amount_minor: input.sypAmount, syp_equivalent: input.sypAmount, exchange_rate_syp_per_usd: null });
  if (input.mode !== 'SYP') payments.push({ currency: 'USD', amount_minor: input.usdCents, syp_equivalent: usdEquivalent, exchange_rate_syp_per_usd: rateSypPerUsd });
  return { mode: input.mode, payments, totalTenderEquivalentSyp, changeSyp, remainingSyp, valid: remainingSyp === 0 };
}

export function derivePaymentMode(payments: Array<{ currency: 'SYP' | 'USD' }>): PaymentMode | null {
  const syp = payments.some(payment => payment.currency === 'SYP'); const usd = payments.some(payment => payment.currency === 'USD');
  return syp && usd ? 'MIXED' : usd ? 'USD' : syp ? 'SYP' : null;
}
