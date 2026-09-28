import type { CashSession, CashSessionSummary } from '@/types';

export function calculateExpectedCash(openingCashSyp: number, salesTotalSyp: number, refundsTotalSyp: number, expensesTotalSyp: number) {
  if (![openingCashSyp, salesTotalSyp, refundsTotalSyp, expensesTotalSyp].every(Number.isSafeInteger) || openingCashSyp < 0 || salesTotalSyp < 0 || refundsTotalSyp < 0 || expensesTotalSyp < 0) throw new Error('INVALID_CASH_TOTAL');
  const expected = openingCashSyp + salesTotalSyp - refundsTotalSyp - expensesTotalSyp;
  if (!Number.isSafeInteger(expected)) throw new Error('INVALID_CASH_TOTAL');
  return expected;
}

export function calculateExpectedCashWithSettlements(openingCashSyp: number, cashReceivedSyp: number, changeGivenSyp: number, cashRefundsSyp: number, expensesSyp: number, supplierPaymentsSyp: number, customerPaymentsSyp: number) {
  const values = [openingCashSyp, cashReceivedSyp, changeGivenSyp, cashRefundsSyp, expensesSyp, supplierPaymentsSyp, customerPaymentsSyp];
  if (!values.every(Number.isSafeInteger) || values.some(value => value < 0)) throw new Error('INVALID_CASH_TOTAL');
  const expected = openingCashSyp + cashReceivedSyp - changeGivenSyp - cashRefundsSyp - expensesSyp - supplierPaymentsSyp + customerPaymentsSyp;
  if (!Number.isSafeInteger(expected)) throw new Error('INVALID_CASH_TOTAL');
  return expected;
}

export function calculateCashDifference(actualCashSyp: number, expectedCashSyp: number) {
  if (!Number.isSafeInteger(actualCashSyp) || actualCashSyp < 0 || !Number.isSafeInteger(expectedCashSyp)) throw new Error('INVALID_CASH_TOTAL');
  const difference = actualCashSyp - expectedCashSyp;
  if (!Number.isSafeInteger(difference)) throw new Error('INVALID_CASH_TOTAL');
  return difference;
}

export function cashDifferenceStatus(differenceSyp: number): 'balanced' | 'surplus' | 'shortage' {
  return differenceSyp === 0 ? 'balanced' : differenceSyp > 0 ? 'surplus' : 'shortage';
}

export function cashSessionDurationMs(session: Pick<CashSession, 'opened_at' | 'closed_at'>, now = Date.now()) {
  const opened = Date.parse(session.opened_at); const ended = session.closed_at ? Date.parse(session.closed_at) : now;
  return Number.isFinite(opened) && Number.isFinite(ended) ? Math.max(0, ended - opened) : 0;
}

export function closedSessionHeadline(session: CashSessionSummary) {
  if (!session.closed_at) return session;
  return { ...session, sales_total_syp: session.closing_sales_total_syp ?? 0, refunds_total_syp: session.closing_refunds_total_syp ?? 0, expenses_total_syp: session.closing_expenses_total_syp ?? 0, expected_cash_syp: session.closing_expected_cash_syp ?? session.opening_cash_syp };
}
