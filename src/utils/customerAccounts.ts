import type { CustomerPaymentInput, PaymentMode } from '@/types';
import { normalizePaymentInput, usdCentsToSyp } from './multiCurrency.ts';

export function normalizeCustomerPaymentInput(input: CustomerPaymentInput): CustomerPaymentInput {
  const normalized = normalizePaymentInput(input);
  return { ...input, ...normalized };
}

export function calculateCustomerPaymentEquivalent(input: CustomerPaymentInput, rateSypPerUsd: number) {
  const normalized = normalizeCustomerPaymentInput(input);
  if (!Number.isSafeInteger(normalized.sypAmount) || normalized.sypAmount < 0 || !Number.isSafeInteger(normalized.usdCents) || normalized.usdCents < 0) throw new Error('INVALID_CUSTOMER_PAYMENT');
  if ((normalized.mode === 'SYP' && normalized.sypAmount <= 0) || (normalized.mode === 'USD' && normalized.usdCents <= 0) || (normalized.mode === 'MIXED' && (normalized.sypAmount <= 0 || normalized.usdCents <= 0))) throw new Error('INVALID_CUSTOMER_PAYMENT');
  const usdEquivalentSyp = normalized.usdCents ? usdCentsToSyp(normalized.usdCents, rateSypPerUsd) : 0;
  const totalSyp = normalized.sypAmount + usdEquivalentSyp;
  if (!Number.isSafeInteger(totalSyp) || totalSyp <= 0) throw new Error('INVALID_CUSTOMER_PAYMENT');
  return { input: normalized, usdEquivalentSyp, totalSyp };
}

export function customerPaymentMode(sypAmount: number, usdCents: number): PaymentMode {
  return sypAmount > 0 && usdCents > 0 ? 'MIXED' : usdCents > 0 ? 'USD' : 'SYP';
}

export function isValidImportedSaleSettlement(netTotalSyp: number, onAccountSyp: number, amountPaidSyp: number | null | undefined) {
  if (!Number.isSafeInteger(netTotalSyp) || netTotalSyp < 0 || !Number.isSafeInteger(onAccountSyp) || onAccountSyp < 0 || onAccountSyp > netTotalSyp) return false;
  return amountPaidSyp == null || (Number.isSafeInteger(amountPaidSyp) && amountPaidSyp >= netTotalSyp - onAccountSyp);
}
