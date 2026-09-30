import type * as SQLite from 'expo-sqlite';
import { createUuid } from '../utils/uuid.ts';
import { relieveWeightedAverageCarryingValue, requireSafeInteger } from './accountingMath.ts';

export type JournalSourceType = 'opening' | 'sale' | 'sale_return' | 'expense' | 'purchase' | 'supplier_return' | 'supplier_payment' | 'customer_payment' | 'inventory_adjustment' | 'cash_adjustment' | 'reversal';
export type SystemAccountKey = 'CASH_SYP' | 'CASH_USD' | 'ACCOUNTS_RECEIVABLE' | 'CUSTOMER_CREDITS' | 'INVENTORY' | 'SUPPLIER_ADVANCES' | 'ACCOUNTS_PAYABLE' | 'OPENING_EQUITY' | 'OWNER_CONTRIBUTIONS' | 'OWNER_DRAWINGS' | 'PRIOR_PERIOD_ADJUSTMENT' | 'SALES_REVENUE' | 'SALES_RETURNS' | 'REALIZED_FX_GAIN' | 'INVENTORY_ADJUSTMENT_GAIN' | 'COGS' | 'OPERATING_EXPENSE' | 'INVENTORY_VALUATION_VARIANCE' | 'INVENTORY_ADJUSTMENT_LOSS' | 'CASH_OVER_SHORT' | 'REALIZED_FX_LOSS';

export interface JournalLineInput { account: SystemAccountKey; debitSyp?: number; creditSyp?: number; sourceCurrency?: 'SYP' | 'USD' | null; sourceAmountMinor?: number | null; exchangeRateSypPerUsd?: number | null; memo?: string | null }
export interface JournalEntryInput { sourceType: JournalSourceType; sourceId?: number | null; sourceUuid?: string | null; reference?: string | null; occurredAt: string; description: string; reversalOfEntryId?: number | null; lines: readonly JournalLineInput[] }
export type JournalPostResult = { classification: 'POSTED'; journalEntryId: number } | { classification: 'ZERO_EFFECT_NO_JOURNAL'; journalEntryId: null };
export interface CutoverCustomerPosition { customerId: number; balanceSyp: number }
export interface CutoverSupplierPosition { supplierId: number; balanceUsdCents: number; carryingValueSyp: number }
export interface CutoverInventoryPosition { productId: number; quantity: number; carryingValueSyp: number }
export interface AccountingCutoverInput { cashSyp: number; cashUsdCents: number; cashUsdCarryingSyp: number; currentExchangeRateSypPerUsd: number; customers: readonly CutoverCustomerPosition[]; suppliers: readonly CutoverSupplierPosition[]; inventory: readonly CutoverInventoryPosition[]; confirmedAt?: string }
export type InventoryValueSourceType = 'opening' | 'purchase' | 'sale' | 'sale_return' | 'supplier_return' | 'stock_in' | 'stock_out' | 'adjustment';
export interface InventoryValueChange {
  sourceType: InventoryValueSourceType;
  sourceId?: number | null;
  sourceItemId?: number | null;
  productId: number;
  quantityDelta: number;
  valueDeltaSyp: number;
  occurredAt: string;
}

interface AccountingSettingsRow { accounting_enabled: number; accounting_started_at: string | null }
interface AccountRow { id: number; system_key: SystemAccountKey }

function checkedNonnegative(value: number, code: string) { requireSafeInteger(value, code); if (value < 0) throw new Error(code); return value }
function checkedPositive(value: number, code: string) { checkedNonnegative(value, code); if (value === 0) throw new Error(code); return value }
function checkedIsoDate(value: string, code: string) { if (!value || !Number.isFinite(Date.parse(value))) throw new Error(code); return value }

export async function accountingIsEnabled(transaction: SQLite.SQLiteDatabase) {
  const row = await transaction.getFirstAsync<AccountingSettingsRow>('SELECT accounting_enabled,accounting_started_at FROM accounting_settings WHERE id=1');
  if (!row) throw new Error('ACCOUNTING_SETTINGS_MISSING');
  return row.accounting_enabled === 1;
}

function debitOrCredit(account: SystemAccountKey, signedDebitEffect: number, metadata: Omit<JournalLineInput, 'account' | 'debitSyp' | 'creditSyp'> = {}): JournalLineInput {
  requireSafeInteger(signedDebitEffect, 'INVALID_ACCOUNTING_EFFECT');
  return signedDebitEffect >= 0
    ? { account, debitSyp: signedDebitEffect, ...metadata }
    : { account, creditSyp: -signedDebitEffect, ...metadata };
}

export function signedControlTransitionLines(
  before: number,
  after: number,
  positiveAccount: SystemAccountKey,
  negativeAccount: SystemAccountKey,
): JournalLineInput[] {
  requireSafeInteger(before, 'INVALID_CONTROL_BALANCE'); requireSafeInteger(after, 'INVALID_CONTROL_BALANCE');
  const beforePositive = Math.max(before, 0); const beforeNegative = Math.max(-before, 0);
  const afterPositive = Math.max(after, 0); const afterNegative = Math.max(-after, 0);
  return [
    debitOrCredit(positiveAccount, afterPositive - beforePositive),
    debitOrCredit(negativeAccount, beforeNegative - afterNegative),
  ];
}

export async function changeCashSyp(transaction: SQLite.SQLiteDatabase, deltaSyp: number, at: string): Promise<JournalLineInput> {
  requireSafeInteger(deltaSyp, 'INVALID_CASH_CONTROL_AMOUNT'); checkedIsoDate(at, 'INVALID_CASH_CONTROL_DATE');
  const row = await transaction.getFirstAsync<{ cash_syp: number }>('SELECT cash_syp FROM cash_control WHERE id=1');
  if (!row) throw new Error('CASH_CONTROL_MISSING');
  requireSafeInteger(row.cash_syp, 'INVALID_CASH_CONTROL_AMOUNT'); const after = row.cash_syp + deltaSyp;
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('INSUFFICIENT_BOOK_CASH');
  const changed = await transaction.runAsync('UPDATE cash_control SET cash_syp=?,updated_at=? WHERE id=1 AND cash_syp=?', after, at, row.cash_syp);
  if (changed.changes !== 1) throw new Error('CASH_CONTROL_CONCURRENT_UPDATE');
  return debitOrCredit('CASH_SYP', deltaSyp, { sourceCurrency: 'SYP', sourceAmountMinor: Math.abs(deltaSyp) });
}

export async function addCashUsd(
  transaction: SQLite.SQLiteDatabase,
  nativeUsdCents: number,
  carryingSyp: number,
  exchangeRateSypPerUsd: number,
  at: string,
): Promise<JournalLineInput> {
  checkedNonnegative(nativeUsdCents, 'INVALID_USD_CASH_AMOUNT'); checkedNonnegative(carryingSyp, 'INVALID_USD_CASH_CARRYING'); checkedPositive(exchangeRateSypPerUsd, 'INVALID_EXCHANGE_RATE');
  if (nativeUsdCents === 0 && carryingSyp !== 0) throw new Error('INVALID_USD_CASH_CARRYING');
  const row = await transaction.getFirstAsync<{ cash_usd_cents: number; cash_usd_carrying_syp: number }>('SELECT cash_usd_cents,cash_usd_carrying_syp FROM cash_control WHERE id=1');
  if (!row) throw new Error('CASH_CONTROL_MISSING');
  const nativeAfter = row.cash_usd_cents + nativeUsdCents; const carryingAfter = row.cash_usd_carrying_syp + carryingSyp;
  if (![row.cash_usd_cents, row.cash_usd_carrying_syp, nativeAfter, carryingAfter].every(Number.isSafeInteger)) throw new Error('INVALID_USD_CASH_CARRYING');
  const changed = await transaction.runAsync(`UPDATE cash_control SET cash_usd_cents=?,cash_usd_carrying_syp=?,updated_at=?
    WHERE id=1 AND cash_usd_cents=? AND cash_usd_carrying_syp=?`, nativeAfter, carryingAfter, at, row.cash_usd_cents, row.cash_usd_carrying_syp);
  if (changed.changes !== 1) throw new Error('CASH_CONTROL_CONCURRENT_UPDATE');
  return debitOrCredit('CASH_USD', carryingSyp, { sourceCurrency: 'USD', sourceAmountMinor: nativeUsdCents, exchangeRateSypPerUsd });
}

export async function removeCashUsd(
  transaction: SQLite.SQLiteDatabase,
  nativeUsdCents: number,
  exchangeRateSypPerUsd: number,
  at: string,
): Promise<{ line: JournalLineInput; carryingReliefSyp: number }> {
  checkedPositive(nativeUsdCents, 'INVALID_USD_CASH_AMOUNT'); checkedPositive(exchangeRateSypPerUsd, 'INVALID_EXCHANGE_RATE');
  const row = await transaction.getFirstAsync<{ cash_usd_cents: number; cash_usd_carrying_syp: number }>('SELECT cash_usd_cents,cash_usd_carrying_syp FROM cash_control WHERE id=1');
  if (!row) throw new Error('CASH_CONTROL_MISSING');
  const carryingReliefSyp = relieveWeightedAverageCarryingValue(row.cash_usd_cents, row.cash_usd_carrying_syp, nativeUsdCents);
  const nativeAfter = row.cash_usd_cents - nativeUsdCents; const carryingAfter = row.cash_usd_carrying_syp - carryingReliefSyp;
  const changed = await transaction.runAsync(`UPDATE cash_control SET cash_usd_cents=?,cash_usd_carrying_syp=?,updated_at=?
    WHERE id=1 AND cash_usd_cents=? AND cash_usd_carrying_syp=?`, nativeAfter, carryingAfter, at, row.cash_usd_cents, row.cash_usd_carrying_syp);
  if (changed.changes !== 1) throw new Error('CASH_CONTROL_CONCURRENT_UPDATE');
  return { line: debitOrCredit('CASH_USD', -carryingReliefSyp, { sourceCurrency: 'USD', sourceAmountMinor: nativeUsdCents, exchangeRateSypPerUsd }), carryingReliefSyp };
}

export async function recordInventoryValueChange(transaction: SQLite.SQLiteDatabase, input: InventoryValueChange) {
  checkedPositive(input.productId, 'INVALID_INVENTORY_VALUE'); requireSafeInteger(input.quantityDelta, 'INVALID_INVENTORY_VALUE'); requireSafeInteger(input.valueDeltaSyp, 'INVALID_INVENTORY_VALUE');
  if (input.quantityDelta === 0) throw new Error('INVALID_INVENTORY_VALUE');
  const row = await transaction.getFirstAsync<{ quantity_snapshot: number; carrying_value_syp: number }>('SELECT quantity_snapshot,carrying_value_syp FROM inventory_value_balances WHERE product_id=?', input.productId);
  if (!row) throw new Error('INVENTORY_VALUE_BALANCE_MISSING');
  const quantityAfter = row.quantity_snapshot + input.quantityDelta; const valueAfter = row.carrying_value_syp + input.valueDeltaSyp;
  if (![quantityAfter, valueAfter].every(Number.isSafeInteger) || quantityAfter < 0 || valueAfter < 0 || (quantityAfter === 0 && valueAfter !== 0)) throw new Error('INVALID_INVENTORY_VALUE');
  const changed = await transaction.runAsync(`UPDATE inventory_value_balances SET quantity_snapshot=?,carrying_value_syp=?,updated_at=?
    WHERE product_id=? AND quantity_snapshot=? AND carrying_value_syp=?`, quantityAfter, valueAfter, input.occurredAt, input.productId, row.quantity_snapshot, row.carrying_value_syp);
  if (changed.changes !== 1) throw new Error('INVENTORY_VALUE_CONCURRENT_UPDATE');
  await transaction.runAsync(`INSERT INTO inventory_value_movements
    (uuid,product_id,source_type,source_id,source_item_id,quantity_delta,quantity_before,quantity_after,value_delta_syp,value_before_syp,value_after_syp,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, createUuid(), input.productId, input.sourceType, input.sourceId ?? null, input.sourceItemId ?? null,
  input.quantityDelta, row.quantity_snapshot, quantityAfter, input.valueDeltaSyp, row.carrying_value_syp, valueAfter, input.occurredAt);
  return { quantityBefore: row.quantity_snapshot, quantityAfter, valueBeforeSyp: row.carrying_value_syp, valueAfterSyp: valueAfter };
}

export async function relieveInventoryValue(
  transaction: SQLite.SQLiteDatabase,
  input: Omit<InventoryValueChange, 'quantityDelta' | 'valueDeltaSyp'> & { quantityOut: number },
) {
  checkedPositive(input.quantityOut, 'INVALID_INVENTORY_VALUE');
  const row = await transaction.getFirstAsync<{ quantity_snapshot: number; carrying_value_syp: number }>('SELECT quantity_snapshot,carrying_value_syp FROM inventory_value_balances WHERE product_id=?', input.productId);
  if (!row) throw new Error('INVENTORY_VALUE_BALANCE_MISSING');
  const relief = relieveWeightedAverageCarryingValue(row.quantity_snapshot, row.carrying_value_syp, input.quantityOut);
  await recordInventoryValueChange(transaction, { ...input, quantityDelta: -input.quantityOut, valueDeltaSyp: -relief });
  return relief;
}

export async function createSupplierPositionLayer(
  transaction: SQLite.SQLiteDatabase,
  input: { supplierId: number; positionType: 'PAYABLE' | 'ADVANCE'; sourceType: 'purchase' | 'supplier_return' | 'supplier_payment'; sourceId: number; nativeUsdCents: number; carryingSyp: number; exchangeRateSypPerUsd?: number | null; occurredAt: string },
) {
  checkedPositive(input.supplierId, 'INVALID_SUPPLIER_POSITION'); checkedPositive(input.sourceId, 'INVALID_SUPPLIER_POSITION');
  checkedPositive(input.nativeUsdCents, 'INVALID_SUPPLIER_POSITION'); checkedNonnegative(input.carryingSyp, 'INVALID_SUPPLIER_POSITION');
  if (input.exchangeRateSypPerUsd != null) checkedPositive(input.exchangeRateSypPerUsd, 'INVALID_EXCHANGE_RATE');
  return transaction.runAsync(`INSERT INTO supplier_foreign_position_layers
    (uuid,supplier_id,position_type,source_type,source_id,original_usd_cents,remaining_usd_cents,original_carrying_syp,remaining_carrying_syp,exchange_rate_syp_per_usd,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, createUuid(), input.supplierId, input.positionType, input.sourceType, input.sourceId,
  input.nativeUsdCents, input.nativeUsdCents, input.carryingSyp, input.carryingSyp, input.exchangeRateSypPerUsd ?? null, input.occurredAt, input.occurredAt);
}

export async function consumeSupplierPositionLayers(
  transaction: SQLite.SQLiteDatabase,
  input: { supplierId: number; positionType: 'PAYABLE' | 'ADVANCE'; sourceType: 'purchase' | 'supplier_return' | 'supplier_payment'; sourceId: number; nativeUsdCents: number; occurredAt: string },
) {
  checkedPositive(input.nativeUsdCents, 'INVALID_SUPPLIER_POSITION');
  const layers = await transaction.getAllAsync<{ id: number; remaining_usd_cents: number; remaining_carrying_syp: number }>(`SELECT id,remaining_usd_cents,remaining_carrying_syp FROM supplier_foreign_position_layers
    WHERE supplier_id=? AND position_type=? AND remaining_usd_cents>0 ORDER BY created_at,id`, input.supplierId, input.positionType);
  let remaining = input.nativeUsdCents; let carryingReliefSyp = 0;
  for (const layer of layers) {
    if (remaining === 0) break;
    const native = Math.min(remaining, layer.remaining_usd_cents);
    const carrying = relieveWeightedAverageCarryingValue(layer.remaining_usd_cents, layer.remaining_carrying_syp, native);
    const nativeAfter = layer.remaining_usd_cents - native; const carryingAfter = layer.remaining_carrying_syp - carrying;
    const changed = await transaction.runAsync(`UPDATE supplier_foreign_position_layers SET remaining_usd_cents=?,remaining_carrying_syp=?,updated_at=?
      WHERE id=? AND remaining_usd_cents=? AND remaining_carrying_syp=?`, nativeAfter, carryingAfter, input.occurredAt, layer.id, layer.remaining_usd_cents, layer.remaining_carrying_syp);
    if (changed.changes !== 1) throw new Error('SUPPLIER_POSITION_CONCURRENT_UPDATE');
    await transaction.runAsync(`INSERT INTO supplier_foreign_allocations(uuid,layer_id,source_type,source_id,native_usd_cents,carrying_value_syp,created_at)
      VALUES(?,?,?,?,?,?,?)`, createUuid(), layer.id, input.sourceType, input.sourceId, native, carrying, input.occurredAt);
    remaining -= native; carryingReliefSyp += carrying;
    if (!Number.isSafeInteger(carryingReliefSyp)) throw new Error('SUPPLIER_POSITION_OVERFLOW');
  }
  if (remaining !== 0) throw new Error('SUPPLIER_POSITION_LAYERS_INSUFFICIENT');
  return carryingReliefSyp;
}

export async function postJournalEntry(transaction: SQLite.SQLiteDatabase, input: JournalEntryInput): Promise<JournalPostResult> {
  checkedIsoDate(input.occurredAt, 'INVALID_JOURNAL_DATE');
  if (input.sourceType === 'opening') { if (input.sourceId != null) throw new Error('INVALID_OPENING_SOURCE'); }
  else checkedPositive(input.sourceId ?? 0, 'INVALID_JOURNAL_SOURCE');
  if (input.sourceType === 'reversal') {
    if (input.reversalOfEntryId == null || input.sourceId !== input.reversalOfEntryId) throw new Error('INVALID_REVERSAL_SOURCE');
    const original = await transaction.getFirstAsync<{ uuid: string }>('SELECT uuid FROM journal_entries WHERE id=? AND source_type<>\'reversal\'', input.reversalOfEntryId);
    if (!original || input.sourceUuid !== original.uuid) throw new Error('INVALID_REVERSAL_SOURCE');
  } else if (input.reversalOfEntryId != null) throw new Error('INVALID_REVERSAL_SOURCE');
  if (!input.description.trim()) throw new Error('INVALID_JOURNAL_ENTRY');
  const effects = new Map<SystemAccountKey, { netDebit: number; lines: JournalLineInput[] }>();
  for (const line of input.lines) {
    const debit = line.debitSyp ?? 0; const credit = line.creditSyp ?? 0;
    checkedNonnegative(debit, 'INVALID_JOURNAL_LINE'); checkedNonnegative(credit, 'INVALID_JOURNAL_LINE');
    if (debit > 0 && credit > 0) throw new Error('INVALID_JOURNAL_LINE');
    if (line.sourceAmountMinor != null) checkedNonnegative(line.sourceAmountMinor, 'INVALID_JOURNAL_SOURCE_AMOUNT');
    if (line.exchangeRateSypPerUsd != null) checkedPositive(line.exchangeRateSypPerUsd, 'INVALID_JOURNAL_EXCHANGE_RATE');
    if (line.sourceCurrency === 'USD' && (line.sourceAmountMinor == null || line.exchangeRateSypPerUsd == null)) throw new Error('INVALID_JOURNAL_FX_METADATA');
    if (debit === 0 && credit === 0) continue;
    const prior = effects.get(line.account) ?? { netDebit: 0, lines: [] };
    prior.netDebit += debit - credit;
    if (!Number.isSafeInteger(prior.netDebit)) throw new Error('JOURNAL_TOTAL_OVERFLOW');
    prior.lines.push(line); effects.set(line.account, prior);
  }
  const nonzero: JournalLineInput[] = [];
  for (const [account, effect] of effects) {
    if (effect.netDebit === 0) continue;
    const metadata = effect.lines.length === 1 ? effect.lines[0] : undefined;
    nonzero.push(debitOrCredit(account, effect.netDebit, metadata ? {
      sourceCurrency: metadata.sourceCurrency,
      sourceAmountMinor: metadata.sourceAmountMinor,
      exchangeRateSypPerUsd: metadata.exchangeRateSypPerUsd,
      memo: metadata.memo,
    } : {}));
  }
  if (nonzero.length === 0) return { classification: 'ZERO_EFFECT_NO_JOURNAL', journalEntryId: null };
  let debitTotal = 0; let creditTotal = 0;
  for (const line of nonzero) {
    debitTotal += line.debitSyp ?? 0; creditTotal += line.creditSyp ?? 0;
    if (!Number.isSafeInteger(debitTotal) || !Number.isSafeInteger(creditTotal)) throw new Error('JOURNAL_TOTAL_OVERFLOW');
  }
  if (debitTotal <= 0 || debitTotal !== creditTotal) throw new Error('UNBALANCED_JOURNAL');
  const keys = [...new Set(nonzero.map(line => line.account))];
  const accounts = await transaction.getAllAsync<AccountRow>(`SELECT id,system_key FROM gl_accounts WHERE active=1 AND system_key IN (${keys.map(() => '?').join(',')})`, ...keys);
  const accountIds = new Map(accounts.map(account => [account.system_key, account.id]));
  if (accountIds.size !== keys.length) throw new Error('SYSTEM_ACCOUNT_MISSING');
  const createdAt = new Date().toISOString();
  const entry = await transaction.runAsync(`INSERT INTO journal_entries(uuid,source_type,source_id,source_uuid,reference,occurred_at,created_at,description_snapshot,reversal_of_entry_id)
    VALUES(?,?,?,?,?,?,?,?,?)`, createUuid(), input.sourceType, input.sourceId ?? null, input.sourceUuid ?? null, input.reference ?? null, input.occurredAt, createdAt, input.description.trim(), input.reversalOfEntryId ?? null);
  for (const line of nonzero) {
    const debit = line.debitSyp ?? 0; const credit = line.creditSyp ?? 0; const accountId = accountIds.get(line.account);
    if (!accountId) throw new Error('SYSTEM_ACCOUNT_MISSING');
    await transaction.runAsync(`INSERT INTO journal_lines(uuid,journal_entry_id,account_id,debit_syp,credit_syp,source_currency,source_amount_minor,exchange_rate_syp_per_usd,memo,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, createUuid(), entry.lastInsertRowId, accountId, debit, credit, line.sourceCurrency ?? null, line.sourceAmountMinor ?? null, line.exchangeRateSypPerUsd ?? null, line.memo?.trim() || null, createdAt);
    const updated = await transaction.runAsync(`UPDATE gl_account_balances SET debit_total_syp=debit_total_syp+?,credit_total_syp=credit_total_syp+?,net_balance_syp=net_balance_syp+?-?,updated_at=? WHERE account_id=?`, debit, credit, debit, credit, createdAt, accountId);
    if (updated.changes !== 1) throw new Error('GL_BALANCE_CACHE_MISSING');
  }
  return { classification: 'POSTED', journalEntryId: entry.lastInsertRowId };
}

function requireExactIds(actualIds: readonly number[], confirmedIds: readonly number[], code: string) {
  const actual = [...actualIds].sort((a, b) => a - b); const confirmed = [...confirmedIds].sort((a, b) => a - b);
  if (actual.length !== confirmed.length || actual.some((id, index) => id !== confirmed[index])) throw new Error(code);
}

async function insertCutoverPosition(transaction: SQLite.SQLiteDatabase, type: string, entityType: string, entityId: number, native: number, carrying: number, at: string) {
  await transaction.runAsync(`INSERT INTO accounting_cutover_positions(uuid,position_type,entity_type,entity_id,native_amount_minor,carrying_value_syp,created_at) VALUES(?,?,?,?,?,?,?)`, createUuid(), type, entityType, entityId, native, carrying, at);
}

export async function activateAccountingCutover(transaction: SQLite.SQLiteDatabase, input: AccountingCutoverInput) {
  checkedNonnegative(input.cashSyp, 'INVALID_CUTOVER_CASH'); checkedNonnegative(input.cashUsdCents, 'INVALID_CUTOVER_USD_CASH'); checkedNonnegative(input.cashUsdCarryingSyp, 'INVALID_CUTOVER_USD_CARRYING'); checkedPositive(input.currentExchangeRateSypPerUsd, 'INVALID_CUTOVER_EXCHANGE_RATE');
  if ((input.cashUsdCents === 0) !== (input.cashUsdCarryingSyp === 0)) throw new Error('INVALID_CUTOVER_USD_CARRYING');
  const at = checkedIsoDate(input.confirmedAt ?? new Date().toISOString(), 'INVALID_CUTOVER_DATE');
  const settings = await transaction.getFirstAsync<AccountingSettingsRow>('SELECT accounting_enabled,accounting_started_at FROM accounting_settings WHERE id=1');
  if (!settings || settings.accounting_enabled !== 0 || settings.accounting_started_at != null) throw new Error('ACCOUNTING_ALREADY_ENABLED');
  if (await transaction.getFirstAsync('SELECT id FROM cash_sessions WHERE closed_at IS NULL LIMIT 1')) throw new Error('ACCOUNTING_CUTOVER_ACTIVE_SESSION');
  const storedRate = await transaction.getFirstAsync<{ value: string }>("SELECT value FROM settings WHERE key='exchangeRate'");
  const parsedRate: unknown = storedRate ? JSON.parse(storedRate.value) : 15000;
  if (!Number.isSafeInteger(parsedRate) || parsedRate !== input.currentExchangeRateSypPerUsd) throw new Error('ACCOUNTING_CUTOVER_RATE_CHANGED');
  const customers = await transaction.getAllAsync<{ customer_id: number; balance_syp: number }>('SELECT customer_id,balance_syp FROM customer_account_balances ORDER BY customer_id');
  requireExactIds(customers.map(row => row.customer_id), input.customers.map(row => row.customerId), 'CUTOVER_CUSTOMER_SET_MISMATCH');
  const customerInput = new Map(input.customers.map(row => [row.customerId, row]));
  for (const row of customers) { requireSafeInteger(row.balance_syp, 'INVALID_CUSTOMER_BALANCE'); if (customerInput.get(row.customer_id)?.balanceSyp !== row.balance_syp) throw new Error('CUTOVER_CUSTOMER_BALANCE_MISMATCH'); }
  const suppliers = await transaction.getAllAsync<{ supplier_id: number; balance_usd_cents: number }>('SELECT supplier_id,balance_usd_cents FROM supplier_account_balances ORDER BY supplier_id');
  requireExactIds(suppliers.map(row => row.supplier_id), input.suppliers.map(row => row.supplierId), 'CUTOVER_SUPPLIER_SET_MISMATCH');
  const supplierInput = new Map(input.suppliers.map(row => [row.supplierId, row]));
  for (const row of suppliers) { const confirmed = supplierInput.get(row.supplier_id); requireSafeInteger(row.balance_usd_cents, 'INVALID_SUPPLIER_BALANCE'); if (!confirmed || confirmed.balanceUsdCents !== row.balance_usd_cents) throw new Error('CUTOVER_SUPPLIER_BALANCE_MISMATCH'); checkedNonnegative(confirmed.carryingValueSyp, 'INVALID_SUPPLIER_CARRYING_VALUE'); if ((confirmed.balanceUsdCents === 0) !== (confirmed.carryingValueSyp === 0)) throw new Error('INVALID_SUPPLIER_CARRYING_VALUE'); }
  const inventory = await transaction.getAllAsync<{ product_id: number; quantity: number }>('SELECT product_id,quantity FROM inventory_balances WHERE tracking_enabled=1 ORDER BY product_id');
  requireExactIds(inventory.map(row => row.product_id), input.inventory.map(row => row.productId), 'CUTOVER_INVENTORY_SET_MISMATCH');
  const inventoryInput = new Map(input.inventory.map(row => [row.productId, row]));
  for (const row of inventory) { const confirmed = inventoryInput.get(row.product_id); checkedNonnegative(row.quantity, 'INVALID_INVENTORY_QUANTITY'); if (!confirmed || confirmed.quantity !== row.quantity) throw new Error('CUTOVER_INVENTORY_QUANTITY_MISMATCH'); checkedNonnegative(confirmed.carryingValueSyp, 'INVALID_INVENTORY_CARRYING_VALUE'); if (confirmed.quantity === 0 && confirmed.carryingValueSyp !== 0) throw new Error('INVALID_INVENTORY_CARRYING_VALUE'); }
  const lines: JournalLineInput[] = [];
  await insertCutoverPosition(transaction, 'CASH_SYP', 'GLOBAL', 0, input.cashSyp, input.cashSyp, at); await insertCutoverPosition(transaction, 'CASH_USD', 'GLOBAL', 0, input.cashUsdCents, input.cashUsdCarryingSyp, at);
  lines.push({ account: 'CASH_SYP', debitSyp: input.cashSyp }, { account: 'CASH_USD', debitSyp: input.cashUsdCarryingSyp, sourceCurrency: 'USD', sourceAmountMinor: input.cashUsdCents, exchangeRateSypPerUsd: input.currentExchangeRateSypPerUsd });
  for (const position of input.customers) { requireSafeInteger(position.balanceSyp, 'INVALID_CUSTOMER_BALANCE'); const amount = Math.abs(position.balanceSyp); if (position.balanceSyp >= 0) { await insertCutoverPosition(transaction, 'CUSTOMER_RECEIVABLE', 'CUSTOMER', position.customerId, amount, amount, at); lines.push({ account: 'ACCOUNTS_RECEIVABLE', debitSyp: amount }); } else { await insertCutoverPosition(transaction, 'CUSTOMER_CREDIT', 'CUSTOMER', position.customerId, amount, amount, at); lines.push({ account: 'CUSTOMER_CREDITS', creditSyp: amount }); } }
  for (const position of input.suppliers) { const native = Math.abs(position.balanceUsdCents); if (!Number.isSafeInteger(native)) throw new Error('INVALID_SUPPLIER_BALANCE'); const payable = position.balanceUsdCents >= 0; await insertCutoverPosition(transaction, payable ? 'SUPPLIER_PAYABLE' : 'SUPPLIER_ADVANCE', 'SUPPLIER', position.supplierId, native, position.carryingValueSyp, at); lines.push({ account: payable ? 'ACCOUNTS_PAYABLE' : 'SUPPLIER_ADVANCES', ...(payable ? { creditSyp: position.carryingValueSyp } : { debitSyp: position.carryingValueSyp }), sourceCurrency: 'USD', sourceAmountMinor: native, exchangeRateSypPerUsd: input.currentExchangeRateSypPerUsd }); if (native > 0) await transaction.runAsync(`INSERT INTO supplier_foreign_position_layers(uuid,supplier_id,position_type,source_type,source_id,original_usd_cents,remaining_usd_cents,original_carrying_syp,remaining_carrying_syp,exchange_rate_syp_per_usd,created_at,updated_at) VALUES(?,?,?,'cutover',NULL,?,?,?,?,?,?,?)`, createUuid(), position.supplierId, payable ? 'PAYABLE' : 'ADVANCE', native, native, position.carryingValueSyp, position.carryingValueSyp, input.currentExchangeRateSypPerUsd, at, at); }
  for (const position of input.inventory) { await insertCutoverPosition(transaction, 'INVENTORY', 'PRODUCT', position.productId, position.quantity, position.carryingValueSyp, at); await transaction.runAsync('INSERT INTO inventory_value_balances(product_id,quantity_snapshot,carrying_value_syp,updated_at) VALUES(?,?,?,?)', position.productId, position.quantity, position.carryingValueSyp, at); lines.push({ account: 'INVENTORY', debitSyp: position.carryingValueSyp }); }
  await transaction.runAsync('INSERT INTO cash_control(id,cash_syp,cash_usd_cents,cash_usd_carrying_syp,updated_at) VALUES(1,?,?,?,?)', input.cashSyp, input.cashUsdCents, input.cashUsdCarryingSyp, at);
  const debit = lines.reduce((sum, line) => sum + (line.debitSyp ?? 0), 0); const credit = lines.reduce((sum, line) => sum + (line.creditSyp ?? 0), 0);
  if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) throw new Error('CUTOVER_TOTAL_OVERFLOW');
  if (debit > credit) lines.push({ account: 'OPENING_EQUITY', creditSyp: debit - credit }); if (credit > debit) lines.push({ account: 'OPENING_EQUITY', debitSyp: credit - debit });
  const posted = await postJournalEntry(transaction, { sourceType: 'opening', occurredAt: at, reference: 'CUTOVER', description: 'Accounting opening cutover', lines });
  const updated = await transaction.runAsync(`UPDATE accounting_settings SET accounting_enabled=1,accounting_started_at=?,functional_currency='SYP',cutover_exchange_rate_syp_per_usd=?,opening_journal_entry_id=?,updated_at=? WHERE id=1 AND accounting_enabled=0`, at, input.currentExchangeRateSypPerUsd, posted.journalEntryId, at);
  if (updated.changes !== 1) throw new Error('ACCOUNTING_ALREADY_ENABLED');
  return { openingJournalEntryId: posted.journalEntryId, zeroCutover: posted.classification === 'ZERO_EFFECT_NO_JOURNAL' };
}
