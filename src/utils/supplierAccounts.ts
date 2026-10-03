import type { PaymentMode, SupplierPaymentInput } from '@/types';
import { normalizeNumericInput } from './numerals.ts';

export function parseSignedUsdToCents(value: string): number | null {
  const normalized = normalizeNumericInput(value, { allowDecimal: true, allowNegative: true });
  if (!/^-?\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
  const negative = normalized.startsWith('-'); const [whole = '0', fraction = ''] = normalized.replace('-', '').split('.');
  try { const result = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0')) * (negative ? -1 : 1); return Number.isSafeInteger(result) ? result : null; } catch { return null; }
}

export function sypToUsdCentsHalfUp(sypAmount: number, rateSypPerUsd: number): number {
  if (!Number.isSafeInteger(sypAmount) || sypAmount < 0 || !Number.isSafeInteger(rateSypPerUsd) || rateSypPerUsd <= 0) {
    throw new Error('INVALID_SUPPLIER_PAYMENT');
  }
  const value = (BigInt(sypAmount) * 100n + BigInt(rateSypPerUsd) / 2n) / BigInt(rateSypPerUsd);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('INVALID_SUPPLIER_PAYMENT');
  return result;
}

export function normalizeSupplierPaymentInput(input: SupplierPaymentInput): SupplierPaymentInput {
  return input.mode === 'SYP' ? { ...input, usdCents: 0 }
    : input.mode === 'USD' ? { ...input, sypAmount: 0 }
      : input;
}

export function calculateSupplierPaymentEquivalent(input: SupplierPaymentInput, rateSypPerUsd: number) {
  const normalized = normalizeSupplierPaymentInput(input);
  if (!Number.isSafeInteger(normalized.sypAmount) || normalized.sypAmount < 0 || !Number.isSafeInteger(normalized.usdCents) || normalized.usdCents < 0) {
    throw new Error('INVALID_SUPPLIER_PAYMENT');
  }
  if ((normalized.mode === 'SYP' && normalized.sypAmount <= 0) ||
      (normalized.mode === 'USD' && normalized.usdCents <= 0) ||
      (normalized.mode === 'MIXED' && (normalized.sypAmount <= 0 || normalized.usdCents <= 0))) {
    throw new Error('INVALID_SUPPLIER_PAYMENT');
  }
  const sypUsdCents = normalized.sypAmount ? sypToUsdCentsHalfUp(normalized.sypAmount, rateSypPerUsd) : 0;
  const totalUsdCents = sypUsdCents + normalized.usdCents;
  if (!Number.isSafeInteger(totalUsdCents) || totalUsdCents <= 0) throw new Error('INVALID_SUPPLIER_PAYMENT');
  return { input: normalized, sypUsdCents, totalUsdCents };
}

export function supplierPaymentMode(sypAmount: number, usdCents: number): PaymentMode {
  return sypAmount > 0 && usdCents > 0 ? 'MIXED' : usdCents > 0 ? 'USD' : 'SYP';
}
