import type * as SQLite from 'expo-sqlite';
import { SYSTEM_ACCOUNTS, type GlAccountType, type GlNormalSide } from './accountingSchema.ts';
import { requireSafeInteger } from './accountingMath.ts';

export interface AccountingSettingsView {
  accounting_enabled: number;
  accounting_started_at: string | null;
  functional_currency: 'SYP';
  cutover_exchange_rate_syp_per_usd: number | null;
  opening_journal_entry_id: number | null;
}

export interface TrialBalanceRow {
  accountId: number;
  code: string;
  systemKey: string;
  nameAr: string;
  nameEn: string;
  accountType: GlAccountType;
  normalSide: GlNormalSide;
  debitTotalSyp: number;
  creditTotalSyp: number;
  debitBalanceSyp: number;
  creditBalanceSyp: number;
}

export interface TrialBalanceReport {
  asOf: string | null;
  rows: TrialBalanceRow[];
  totalDebitSyp: number;
  totalCreditSyp: number;
  balanced: boolean;
}

export interface JournalListRow {
  id: number;
  uuid: string;
  sourceType: string;
  sourceId: number | null;
  sourceUuid: string | null;
  reference: string | null;
  occurredAt: string;
  description: string;
  totalDebitSyp: number;
  totalCreditSyp: number;
}

export interface JournalLineView {
  id: number;
  uuid: string;
  accountId: number;
  accountCode: string;
  accountSystemKey: string;
  accountNameAr: string;
  accountNameEn: string;
  debitSyp: number;
  creditSyp: number;
  sourceCurrency: 'SYP' | 'USD' | null;
  sourceAmountMinor: number | null;
  exchangeRateSypPerUsd: number | null;
  memo: string | null;
}

export interface JournalDetail extends JournalListRow { lines: JournalLineView[] }

export interface AccountLedgerRow extends JournalLineView {
  journalEntryId: number;
  occurredAt: string;
  reference: string | null;
  sourceType: string;
  sourceId: number | null;
  description: string;
  runningBalanceSyp: number;
}

export interface AccountLedgerReport {
  account: Pick<TrialBalanceRow, 'accountId' | 'code' | 'systemKey' | 'nameAr' | 'nameEn' | 'accountType' | 'normalSide'>;
  from: string | null;
  to: string | null;
  broughtForwardSyp: number;
  rows: AccountLedgerRow[];
  endingBalanceSyp: number;
}

export interface ProfitAndLossReport {
  from: string | null;
  to: string | null;
  salesRevenueSyp: number;
  salesReturnsSyp: number;
  netSalesSyp: number;
  cogsSyp: number;
  grossProfitSyp: number;
  operatingExpensesSyp: number;
  inventoryValuationVarianceSyp: number;
  inventoryAdjustmentNetSyp: number;
  cashOverShortNetSyp: number;
  realizedFxNetSyp: number;
  netProfitSyp: number;
}

export interface BalanceSheetReport {
  asOf: string | null;
  valid: boolean;
  blockedReasons: string[];
  assetsSyp: number;
  liabilitiesSyp: number;
  openingEquitySyp: number;
  ownerContributionsSyp: number;
  ownerDrawingsSyp: number;
  priorPeriodAdjustmentSyp: number;
  currentEarningsSyp: number;
  equitySyp: number;
  liabilitiesAndEquitySyp: number;
}

export interface AccountingHealthReport {
  ok: boolean;
  checkedAt: string;
  enabled: boolean;
  issues: string[];
  journalEntries: number;
  journalLines: number;
  totalDebitSyp: number;
  totalCreditSyp: number;
}

export type AccountingReconciliationKey = 'CASH_SYP' | 'CASH_USD' | 'ACCOUNTS_RECEIVABLE' | 'CUSTOMER_CREDITS' | 'INVENTORY' | 'ACCOUNTS_PAYABLE' | 'SUPPLIER_ADVANCES';
export interface AccountingReconciliationRow {
  key: AccountingReconciliationKey;
  controlSyp: number;
  ledgerSyp: number;
  differenceSyp: number;
  matched: boolean;
  reason: string | null;
}
export interface AccountingReconciliationReport { enabled: boolean; ok: boolean; rows: AccountingReconciliationRow[] }

function safe(value: number, code: string) { requireSafeInteger(value, code); return value }
function normalized(value: number, code: string) { safe(value, code); return value === 0 ? 0 : value }
function periodSql(alias: string, from?: string | null, to?: string | null) {
  const clauses: string[] = []; const values: string[] = [];
  if (from) { clauses.push(`${alias}>=?`); values.push(from); }
  if (to) { clauses.push(`${alias}<=?`); values.push(to); }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', values };
}

export async function readAccountingSettings(db: SQLite.SQLiteDatabase) {
  const row = await db.getFirstAsync<AccountingSettingsView>('SELECT accounting_enabled,accounting_started_at,functional_currency,cutover_exchange_rate_syp_per_usd,opening_journal_entry_id FROM accounting_settings WHERE id=1');
  if (!row) throw new Error('ACCOUNTING_SETTINGS_MISSING');
  return row;
}

export async function readGeneralJournal(db: SQLite.SQLiteDatabase, input: { from?: string | null; to?: string | null; sourceType?: string | null; reference?: string | null; accountId?: number | null; limit?: number } = {}) {
  const where: string[] = []; const values: Array<string | number> = [];
  if (input.from) { where.push('je.occurred_at>=?'); values.push(input.from); }
  if (input.to) { where.push('je.occurred_at<=?'); values.push(input.to); }
  if (input.sourceType) { where.push('je.source_type=?'); values.push(input.sourceType); }
  if (input.reference?.trim()) { where.push('je.reference LIKE ?'); values.push(`%${input.reference.trim()}%`); }
  if (input.accountId != null) { safe(input.accountId, 'INVALID_ACCOUNT_ID'); where.push('EXISTS(SELECT 1 FROM journal_lines filter_line WHERE filter_line.journal_entry_id=je.id AND filter_line.account_id=?)'); values.push(input.accountId); }
  const limit = input.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new Error('INVALID_JOURNAL_LIMIT');
  const rows = await db.getAllAsync<{ id: number; uuid: string; source_type: string; source_id: number | null; source_uuid: string | null; reference: string | null; occurred_at: string; description_snapshot: string; total_debit_syp: number; total_credit_syp: number }>(`SELECT je.id,je.uuid,je.source_type,je.source_id,je.source_uuid,je.reference,je.occurred_at,je.description_snapshot,
    (SELECT SUM(total_line.debit_syp) FROM journal_lines total_line WHERE total_line.journal_entry_id=je.id) AS total_debit_syp,
    (SELECT SUM(total_line.credit_syp) FROM journal_lines total_line WHERE total_line.journal_entry_id=je.id) AS total_credit_syp
    FROM journal_entries je ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY je.occurred_at DESC,je.id DESC LIMIT ?`, ...values, limit);
  return rows.map(row => ({ id: row.id, uuid: row.uuid, sourceType: row.source_type, sourceId: row.source_id, sourceUuid: row.source_uuid,
    reference: row.reference, occurredAt: row.occurred_at, description: row.description_snapshot,
    totalDebitSyp: safe(row.total_debit_syp, 'INVALID_JOURNAL_TOTAL'), totalCreditSyp: safe(row.total_credit_syp, 'INVALID_JOURNAL_TOTAL') } satisfies JournalListRow));
}

export async function readJournalDetail(db: SQLite.SQLiteDatabase, id: number): Promise<JournalDetail | null> {
  safe(id, 'INVALID_JOURNAL_ID');
  const entry = await db.getFirstAsync<{ id: number; uuid: string; source_type: string; source_id: number | null; source_uuid: string | null; reference: string | null; occurred_at: string; description_snapshot: string; total_debit_syp: number; total_credit_syp: number }>(`SELECT je.id,je.uuid,je.source_type,je.source_id,je.source_uuid,je.reference,je.occurred_at,je.description_snapshot,
    SUM(jl.debit_syp) AS total_debit_syp,SUM(jl.credit_syp) AS total_credit_syp
    FROM journal_entries je JOIN journal_lines jl ON jl.journal_entry_id=je.id WHERE je.id=? GROUP BY je.id`, id);
  if (!entry) return null;
  const header: JournalListRow = { id: entry.id, uuid: entry.uuid, sourceType: entry.source_type, sourceId: entry.source_id, sourceUuid: entry.source_uuid,
    reference: entry.reference, occurredAt: entry.occurred_at, description: entry.description_snapshot,
    totalDebitSyp: safe(entry.total_debit_syp, 'INVALID_JOURNAL_TOTAL'), totalCreditSyp: safe(entry.total_credit_syp, 'INVALID_JOURNAL_TOTAL') };
  const rows = await db.getAllAsync<{ id: number; uuid: string; account_id: number; code: string; system_key: string; name_ar: string; name_en: string; debit_syp: number; credit_syp: number; source_currency: 'SYP' | 'USD' | null; source_amount_minor: number | null; exchange_rate_syp_per_usd: number | null; memo: string | null }>(`SELECT jl.id,jl.uuid,jl.account_id,a.code,a.system_key,a.name_ar,a.name_en,jl.debit_syp,jl.credit_syp,jl.source_currency,jl.source_amount_minor,jl.exchange_rate_syp_per_usd,jl.memo
    FROM journal_lines jl JOIN gl_accounts a ON a.id=jl.account_id WHERE jl.journal_entry_id=? ORDER BY jl.id`, id);
  return { ...header, lines: rows.map(row => ({ id: row.id, uuid: row.uuid, accountId: row.account_id, accountCode: row.code, accountSystemKey: row.system_key,
    accountNameAr: row.name_ar, accountNameEn: row.name_en, debitSyp: safe(row.debit_syp, 'INVALID_JOURNAL_LINE'), creditSyp: safe(row.credit_syp, 'INVALID_JOURNAL_LINE'),
    sourceCurrency: row.source_currency, sourceAmountMinor: row.source_amount_minor, exchangeRateSypPerUsd: row.exchange_rate_syp_per_usd, memo: row.memo })) };
}

export async function buildTrialBalance(db: SQLite.SQLiteDatabase, asOf?: string | null): Promise<TrialBalanceReport> {
  const rows = await db.getAllAsync<{ id: number; code: string; system_key: string; name_ar: string; name_en: string; account_type: GlAccountType; normal_side: GlNormalSide; debit: number; credit: number }>(`SELECT a.id,a.code,a.system_key,a.name_ar,a.name_en,a.account_type,a.normal_side,
    COALESCE(SUM(CASE WHEN ? IS NULL OR je.occurred_at<=? THEN jl.debit_syp ELSE 0 END),0) debit,
    COALESCE(SUM(CASE WHEN ? IS NULL OR je.occurred_at<=? THEN jl.credit_syp ELSE 0 END),0) credit
    FROM gl_accounts a LEFT JOIN journal_lines jl ON jl.account_id=a.id LEFT JOIN journal_entries je ON je.id=jl.journal_entry_id
    WHERE a.active=1 GROUP BY a.id ORDER BY a.code,a.id`, asOf ?? null, asOf ?? null, asOf ?? null, asOf ?? null);
  let totalDebitSyp = 0; let totalCreditSyp = 0;
  const mapped = rows.map(row => {
    const debit = safe(row.debit, 'INVALID_TRIAL_BALANCE'); const credit = safe(row.credit, 'INVALID_TRIAL_BALANCE'); const net = debit - credit;
    const debitBalanceSyp = Math.max(net, 0); const creditBalanceSyp = Math.max(-net, 0);
    totalDebitSyp += debitBalanceSyp; totalCreditSyp += creditBalanceSyp;
    if (![totalDebitSyp, totalCreditSyp].every(Number.isSafeInteger)) throw new Error('TRIAL_BALANCE_OVERFLOW');
    return { accountId: row.id, code: row.code, systemKey: row.system_key, nameAr: row.name_ar, nameEn: row.name_en,
      accountType: row.account_type, normalSide: row.normal_side, debitTotalSyp: debit, creditTotalSyp: credit, debitBalanceSyp, creditBalanceSyp };
  });
  return { asOf: asOf ?? null, rows: mapped, totalDebitSyp, totalCreditSyp, balanced: totalDebitSyp === totalCreditSyp };
}

export async function buildAccountLedger(db: SQLite.SQLiteDatabase, accountId: number, input: { from?: string | null; to?: string | null } = {}): Promise<AccountLedgerReport> {
  safe(accountId, 'INVALID_ACCOUNT_ID');
  const account = await db.getFirstAsync<{ id: number; code: string; system_key: string; name_ar: string; name_en: string; account_type: GlAccountType; normal_side: GlNormalSide }>('SELECT id,code,system_key,name_ar,name_en,account_type,normal_side FROM gl_accounts WHERE id=? AND active=1', accountId);
  if (!account) throw new Error('ACCOUNT_NOT_FOUND');
  const opening = input.from ? await db.getFirstAsync<{ balance: number }>(`SELECT COALESCE(SUM(jl.debit_syp-jl.credit_syp),0) balance FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE jl.account_id=? AND je.occurred_at<?`, accountId, input.from) : { balance: 0 };
  const period = periodSql('je.occurred_at', input.from, input.to);
  const rows = await db.getAllAsync<{ id: number; uuid: string; journal_entry_id: number; occurred_at: string; reference: string | null; source_type: string; source_id: number | null; description_snapshot: string; debit_syp: number; credit_syp: number; source_currency: 'SYP' | 'USD' | null; source_amount_minor: number | null; exchange_rate_syp_per_usd: number | null; memo: string | null }>(`SELECT jl.id,jl.uuid,jl.journal_entry_id,je.occurred_at,je.reference,je.source_type,je.source_id,je.description_snapshot,jl.debit_syp,jl.credit_syp,jl.source_currency,jl.source_amount_minor,jl.exchange_rate_syp_per_usd,jl.memo
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE jl.account_id=?${period.sql} ORDER BY je.occurred_at,je.id,jl.id`, accountId, ...period.values);
  let running = safe(opening?.balance ?? 0, 'INVALID_LEDGER_BALANCE');
  const mapped = rows.map(row => { running += row.debit_syp - row.credit_syp; safe(running, 'LEDGER_BALANCE_OVERFLOW'); return {
    id: row.id, uuid: row.uuid, accountId, accountCode: account.code, accountSystemKey: account.system_key, accountNameAr: account.name_ar, accountNameEn: account.name_en,
    debitSyp: row.debit_syp, creditSyp: row.credit_syp, sourceCurrency: row.source_currency, sourceAmountMinor: row.source_amount_minor, exchangeRateSypPerUsd: row.exchange_rate_syp_per_usd, memo: row.memo,
    journalEntryId: row.journal_entry_id, occurredAt: row.occurred_at, reference: row.reference, sourceType: row.source_type, sourceId: row.source_id, description: row.description_snapshot, runningBalanceSyp: running,
  }; });
  return { account: { accountId, code: account.code, systemKey: account.system_key, nameAr: account.name_ar, nameEn: account.name_en, accountType: account.account_type, normalSide: account.normal_side }, from: input.from ?? null, to: input.to ?? null, broughtForwardSyp: opening?.balance ?? 0, rows: mapped, endingBalanceSyp: running };
}

async function accountPeriodEffects(db: SQLite.SQLiteDatabase, from?: string | null, to?: string | null) {
  const period = periodSql('je.occurred_at', from, to);
  const rows = await db.getAllAsync<{ system_key: string; debit: number; credit: number }>(`SELECT a.system_key,COALESCE(SUM(jl.debit_syp),0) debit,COALESCE(SUM(jl.credit_syp),0) credit
    FROM gl_accounts a LEFT JOIN journal_lines jl ON jl.account_id=a.id LEFT JOIN journal_entries je ON je.id=jl.journal_entry_id
    WHERE 1=1${period.sql} GROUP BY a.id`, ...period.values);
  return new Map(rows.map(row => [row.system_key, safe(row.debit, 'INVALID_REPORT_TOTAL') - safe(row.credit, 'INVALID_REPORT_TOTAL')]));
}

export async function buildProfitAndLoss(db: SQLite.SQLiteDatabase, input: { from?: string | null; to?: string | null } = {}): Promise<ProfitAndLossReport> {
  const effects = await accountPeriodEffects(db, input.from, input.to); const value = (key: string) => effects.get(key) ?? 0;
  const salesRevenueSyp = -value('SALES_REVENUE'); const salesReturnsSyp = value('SALES_RETURNS'); const netSalesSyp = salesRevenueSyp - salesReturnsSyp;
  const cogsSyp = value('COGS'); const grossProfitSyp = netSalesSyp - cogsSyp; const operatingExpensesSyp = value('OPERATING_EXPENSE');
  const inventoryValuationVarianceSyp = value('INVENTORY_VALUATION_VARIANCE');
  const inventoryAdjustmentNetSyp = -value('INVENTORY_ADJUSTMENT_GAIN') - value('INVENTORY_ADJUSTMENT_LOSS');
  const cashOverShortNetSyp = -value('CASH_OVER_SHORT'); const realizedFxNetSyp = -value('REALIZED_FX_GAIN') - value('REALIZED_FX_LOSS');
  const netProfitSyp = grossProfitSyp - operatingExpensesSyp - inventoryValuationVarianceSyp + inventoryAdjustmentNetSyp + cashOverShortNetSyp + realizedFxNetSyp;
  [salesRevenueSyp, salesReturnsSyp, netSalesSyp, cogsSyp, grossProfitSyp, operatingExpensesSyp, inventoryValuationVarianceSyp, inventoryAdjustmentNetSyp, cashOverShortNetSyp, realizedFxNetSyp, netProfitSyp].forEach(valueToCheck => safe(valueToCheck, 'REPORT_TOTAL_OVERFLOW'));
  return { from: input.from ?? null, to: input.to ?? null,
    salesRevenueSyp: normalized(salesRevenueSyp, 'REPORT_TOTAL_OVERFLOW'), salesReturnsSyp: normalized(salesReturnsSyp, 'REPORT_TOTAL_OVERFLOW'),
    netSalesSyp: normalized(netSalesSyp, 'REPORT_TOTAL_OVERFLOW'), cogsSyp: normalized(cogsSyp, 'REPORT_TOTAL_OVERFLOW'), grossProfitSyp: normalized(grossProfitSyp, 'REPORT_TOTAL_OVERFLOW'),
    operatingExpensesSyp: normalized(operatingExpensesSyp, 'REPORT_TOTAL_OVERFLOW'), inventoryValuationVarianceSyp: normalized(inventoryValuationVarianceSyp, 'REPORT_TOTAL_OVERFLOW'),
    inventoryAdjustmentNetSyp: normalized(inventoryAdjustmentNetSyp, 'REPORT_TOTAL_OVERFLOW'), cashOverShortNetSyp: normalized(cashOverShortNetSyp, 'REPORT_TOTAL_OVERFLOW'),
    realizedFxNetSyp: normalized(realizedFxNetSyp, 'REPORT_TOTAL_OVERFLOW'), netProfitSyp: normalized(netProfitSyp, 'REPORT_TOTAL_OVERFLOW') };
}

async function count(db: SQLite.SQLiteDatabase, sql: string, ...parameters: Array<string | number | null>) {
  return (await db.getFirstAsync<{ count: number }>(sql, ...parameters))?.count ?? 0;
}

export async function buildAccountingReconciliation(db: SQLite.SQLiteDatabase): Promise<AccountingReconciliationReport> {
  const settings = await readAccountingSettings(db);
  if (settings.accounting_enabled !== 1) return { enabled: false, ok: true, rows: [] };
  const [cash, ledgerRows, inventory, inventoryMismatch, customer, supplier, supplierBalances] = await Promise.all([
    db.getFirstAsync<{ cash_syp: number; cash_usd_carrying_syp: number }>('SELECT cash_syp,cash_usd_carrying_syp FROM cash_control WHERE id=1'),
    db.getAllAsync<{ system_key: AccountingReconciliationKey; net_balance_syp: number }>("SELECT a.system_key,b.net_balance_syp FROM gl_accounts a JOIN gl_account_balances b ON b.account_id=a.id WHERE a.system_key IN ('CASH_SYP','CASH_USD','ACCOUNTS_RECEIVABLE','CUSTOMER_CREDITS','INVENTORY','ACCOUNTS_PAYABLE','SUPPLIER_ADVANCES')"),
    db.getFirstAsync<{ total: number }>('SELECT COALESCE(SUM(carrying_value_syp),0) total FROM inventory_value_balances'),
    count(db, `SELECT COUNT(*) count FROM inventory_value_balances v JOIN inventory_balances b ON b.product_id=v.product_id WHERE v.quantity_snapshot<>b.quantity OR v.carrying_value_syp<0 OR (v.quantity_snapshot=0 AND v.carrying_value_syp<>0)`),
    db.getFirstAsync<{ receivable: number; credits: number }>('SELECT COALESCE(SUM(CASE WHEN balance_syp>0 THEN balance_syp ELSE 0 END),0) receivable,COALESCE(SUM(CASE WHEN balance_syp<0 THEN -balance_syp ELSE 0 END),0) credits FROM customer_account_balances'),
    db.getFirstAsync<{ payable_native: number; advance_native: number; payable_syp: number; advance_syp: number }>(`SELECT
      COALESCE((SELECT SUM(remaining_usd_cents) FROM supplier_foreign_position_layers WHERE position_type='PAYABLE'),0) payable_native,
      COALESCE((SELECT SUM(remaining_usd_cents) FROM supplier_foreign_position_layers WHERE position_type='ADVANCE'),0) advance_native,
      COALESCE((SELECT SUM(remaining_carrying_syp) FROM supplier_foreign_position_layers WHERE position_type='PAYABLE'),0) payable_syp,
      COALESCE((SELECT SUM(remaining_carrying_syp) FROM supplier_foreign_position_layers WHERE position_type='ADVANCE'),0) advance_syp`),
    db.getFirstAsync<{ payable: number; advances: number }>('SELECT COALESCE(SUM(CASE WHEN balance_usd_cents>0 THEN balance_usd_cents ELSE 0 END),0) payable,COALESCE(SUM(CASE WHEN balance_usd_cents<0 THEN -balance_usd_cents ELSE 0 END),0) advances FROM supplier_account_balances'),
  ]);
  const ledger = new Map(ledgerRows.map(row => [row.system_key, safe(row.net_balance_syp, 'INVALID_RECONCILIATION_VALUE')]));
  const make = (key: AccountingReconciliationKey, controlValue: number, reason: string | null = null): AccountingReconciliationRow => {
    const controlSyp = safe(controlValue, 'INVALID_RECONCILIATION_VALUE'); const ledgerSyp = ledger.get(key) ?? 0;
    const differenceSyp = safe(ledgerSyp - controlSyp, 'INVALID_RECONCILIATION_VALUE'); const matched = differenceSyp === 0 && reason == null;
    return { key, controlSyp, ledgerSyp, differenceSyp, matched, reason: matched ? null : reason ?? 'CONTROL_LEDGER_DIFFERENCE' };
  };
  const rows: AccountingReconciliationRow[] = [
    make('CASH_SYP', cash?.cash_syp ?? 0, cash ? null : 'CASH_CONTROL_MISSING'),
    make('CASH_USD', cash?.cash_usd_carrying_syp ?? 0, cash ? null : 'CASH_CONTROL_MISSING'),
    make('ACCOUNTS_RECEIVABLE', customer?.receivable ?? 0),
    make('CUSTOMER_CREDITS', -(customer?.credits ?? 0)),
    make('INVENTORY', inventory?.total ?? 0, inventoryMismatch ? 'INVENTORY_QUANTITY_CONTROL_MISMATCH' : null),
    make('ACCOUNTS_PAYABLE', -(supplier?.payable_syp ?? 0), supplier && supplierBalances && supplier.payable_native === supplierBalances.payable ? null : 'SUPPLIER_NATIVE_BALANCE_MISMATCH'),
    make('SUPPLIER_ADVANCES', supplier?.advance_syp ?? 0, supplier && supplierBalances && supplier.advance_native === supplierBalances.advances ? null : 'SUPPLIER_NATIVE_BALANCE_MISMATCH'),
  ];
  return { enabled: true, ok: rows.every(row => row.matched), rows };
}

export async function auditAccountingHealth(db: SQLite.SQLiteDatabase): Promise<AccountingHealthReport> {
  const checkedAt = new Date().toISOString(); const settings = await readAccountingSettings(db); const enabled = settings.accounting_enabled === 1; const issues: string[] = [];
  const integrity = await db.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check'); if (integrity?.integrity_check !== 'ok') issues.push('SQLITE_INTEGRITY_FAILED');
  if ((await db.getAllAsync('PRAGMA foreign_key_check')).length) issues.push('SQLITE_FOREIGN_KEY_FAILED');
  const systemRows = await db.getAllAsync<{ system_key: string; code: string; name_ar: string; name_en: string; account_type: GlAccountType; normal_side: GlNormalSide; is_system: number; active: number }>('SELECT system_key,code,name_ar,name_en,account_type,normal_side,is_system,active FROM gl_accounts');
  const systemByKey = new Map(systemRows.map(row => [row.system_key, row]));
  if (systemRows.length !== SYSTEM_ACCOUNTS.length || SYSTEM_ACCOUNTS.some(account => {
    const row = systemByKey.get(account.systemKey);
    return !row || row.code !== account.code || row.name_ar !== account.nameAr || row.name_en !== account.nameEn ||
      row.account_type !== account.accountType || row.normal_side !== account.normalSide || row.is_system !== 1 || row.active !== 1;
  })) issues.push('SYSTEM_ACCOUNTS_INVALID');
  if (await count(db, `SELECT COUNT(*) count FROM gl_accounts a LEFT JOIN gl_account_balances b ON b.account_id=a.id WHERE b.account_id IS NULL`) ||
      await count(db, `SELECT COUNT(*) count FROM gl_account_balances b LEFT JOIN gl_accounts a ON a.id=b.account_id WHERE a.id IS NULL`) ||
      await count(db, 'SELECT COUNT(*) count FROM gl_account_balances') !== SYSTEM_ACCOUNTS.length) issues.push('SYSTEM_ACCOUNT_BALANCES_INVALID');
  const totals = await db.getFirstAsync<{ entries: number; lines: number; debit: number; credit: number }>('SELECT (SELECT COUNT(*) FROM journal_entries) entries,COUNT(jl.id) lines,COALESCE(SUM(jl.debit_syp),0) debit,COALESCE(SUM(jl.credit_syp),0) credit FROM journal_lines jl');
  const journalEntries = totals?.entries ?? 0; const journalLines = totals?.lines ?? 0; const totalDebitSyp = safe(totals?.debit ?? 0, 'INVALID_JOURNAL_TOTAL'); const totalCreditSyp = safe(totals?.credit ?? 0, 'INVALID_JOURNAL_TOTAL');
  if (totalDebitSyp !== totalCreditSyp) issues.push('TRIAL_BALANCE_UNBALANCED');
  if (await count(db, `SELECT COUNT(*) count FROM journal_lines WHERE typeof(debit_syp)<>'integer' OR typeof(credit_syp)<>'integer' OR debit_syp<0 OR credit_syp<0 OR (debit_syp>0)=(credit_syp>0) OR (source_amount_minor IS NOT NULL AND typeof(source_amount_minor)<>'integer') OR (exchange_rate_syp_per_usd IS NOT NULL AND (typeof(exchange_rate_syp_per_usd)<>'integer' OR exchange_rate_syp_per_usd<=0))`)) issues.push('JOURNAL_LINE_INVALID');
  if (await count(db, `SELECT COUNT(*) count FROM (SELECT je.id FROM journal_entries je LEFT JOIN journal_lines jl ON jl.journal_entry_id=je.id GROUP BY je.id HAVING COUNT(jl.id)<2 OR SUM(jl.debit_syp)<=0 OR SUM(jl.debit_syp)<>SUM(jl.credit_syp))`)) issues.push('JOURNAL_ENTRY_INVALID');
  if (await count(db, `SELECT COUNT(*) count FROM (SELECT source_type,source_id FROM journal_entries WHERE source_id IS NOT NULL GROUP BY source_type,source_id HAVING COUNT(*)>1)`)) issues.push('DUPLICATE_SOURCE_JOURNAL');
  if (await count(db, `SELECT COUNT(*) count FROM journal_entries je
    LEFT JOIN sales s ON je.source_type='sale' AND s.id=je.source_id
    LEFT JOIN sale_returns sr ON je.source_type='sale_return' AND sr.id=je.source_id
    LEFT JOIN expenses e ON je.source_type='expense' AND e.id=je.source_id
    LEFT JOIN purchase_receipts pr ON je.source_type='purchase' AND pr.id=je.source_id
    LEFT JOIN purchase_returns pret ON je.source_type='supplier_return' AND pret.id=je.source_id
    LEFT JOIN supplier_payments sp ON je.source_type='supplier_payment' AND sp.id=je.source_id
    LEFT JOIN customer_payments cp ON je.source_type='customer_payment' AND cp.id=je.source_id
    LEFT JOIN inventory_movements im ON je.source_type='inventory_adjustment' AND im.id=je.source_id
    LEFT JOIN cash_adjustments ca ON je.source_type='cash_adjustment' AND ca.id=je.source_id
    WHERE (je.source_type='opening' AND (je.source_id IS NOT NULL OR je.source_uuid IS NOT NULL))
       OR (je.source_type='sale' AND (s.id IS NULL OR je.source_uuid IS NULL OR je.source_uuid<>s.uuid))
       OR (je.source_type='sale_return' AND (sr.id IS NULL OR je.source_uuid IS NULL OR je.source_uuid<>sr.uuid))
       OR (je.source_type='expense' AND (e.id IS NULL OR je.source_uuid IS NULL OR je.source_uuid<>e.uuid))
       OR (je.source_type='purchase' AND (pr.id IS NULL OR je.source_uuid IS NULL OR je.source_uuid<>pr.uuid))
       OR (je.source_type='supplier_return' AND (pret.id IS NULL OR je.source_uuid IS NULL OR je.source_uuid<>pret.uuid))
       OR (je.source_type='supplier_payment' AND (sp.id IS NULL OR je.source_uuid IS NULL OR je.source_uuid<>sp.uuid))
       OR (je.source_type='customer_payment' AND (cp.id IS NULL OR je.source_uuid IS NULL OR je.source_uuid<>cp.uuid))
       OR (je.source_type='inventory_adjustment' AND (im.id IS NULL OR je.source_uuid IS NULL OR je.source_uuid<>im.uuid))
       OR (je.source_type='cash_adjustment' AND (ca.id IS NULL OR je.source_uuid IS NULL OR je.source_uuid<>ca.uuid))`)) issues.push('JOURNAL_SOURCE_INVALID');
  if (await count(db, `SELECT COUNT(*) count FROM journal_entries je LEFT JOIN journal_entries original ON original.id=je.reversal_of_entry_id
    WHERE (je.source_type='reversal' AND (original.id IS NULL OR original.source_type='reversal' OR je.source_id<>original.id OR je.source_uuid<>original.uuid))
       OR (je.source_type<>'reversal' AND je.reversal_of_entry_id IS NOT NULL)`)
      || await count(db, `SELECT COUNT(*) count FROM (SELECT reversal_of_entry_id FROM journal_entries WHERE reversal_of_entry_id IS NOT NULL GROUP BY reversal_of_entry_id HAVING COUNT(*)>1)`)) issues.push('JOURNAL_REVERSAL_INVALID');
  if (await count(db, `SELECT COUNT(*) count FROM gl_account_balances b JOIN gl_accounts a ON a.id=b.account_id WHERE b.debit_total_syp<>COALESCE((SELECT SUM(debit_syp) FROM journal_lines WHERE account_id=a.id),0) OR b.credit_total_syp<>COALESCE((SELECT SUM(credit_syp) FROM journal_lines WHERE account_id=a.id),0) OR b.net_balance_syp<>COALESCE((SELECT SUM(debit_syp-credit_syp) FROM journal_lines WHERE account_id=a.id),0)`)) issues.push('GL_BALANCE_CACHE_MISMATCH');
  const openingCount = await count(db, "SELECT COUNT(*) count FROM journal_entries WHERE source_type='opening'");
  const nonzeroCutover = await count(db, 'SELECT COUNT(*) count FROM accounting_cutover_positions WHERE native_amount_minor<>0 OR carrying_value_syp<>0') > 0;
  if (enabled) {
    if (!nonzeroCutover && (settings.opening_journal_entry_id != null || openingCount !== 0)) issues.push('ZERO_CUTOVER_JOURNAL_INVALID');
    if (nonzeroCutover && (settings.opening_journal_entry_id == null || openingCount !== 1 || !(await db.getFirstAsync('SELECT id FROM journal_entries WHERE id=? AND source_type=\'opening\'', settings.opening_journal_entry_id)))) issues.push('NONZERO_CUTOVER_JOURNAL_INVALID');
    if (nonzeroCutover && settings.opening_journal_entry_id != null) {
      const positions = await db.getAllAsync<{ position_type: string; carrying_value_syp: number }>('SELECT position_type,carrying_value_syp FROM accounting_cutover_positions');
      const expected = new Map<string, number>(); const add = (key: string, signedDebit: number) => expected.set(key, (expected.get(key) ?? 0) + signedDebit);
      for (const position of positions) {
        safe(position.carrying_value_syp, 'INVALID_CUTOVER_POSITION');
        if (position.position_type === 'CASH_SYP') add('CASH_SYP', position.carrying_value_syp);
        else if (position.position_type === 'CASH_USD') add('CASH_USD', position.carrying_value_syp);
        else if (position.position_type === 'CUSTOMER_RECEIVABLE') add('ACCOUNTS_RECEIVABLE', position.carrying_value_syp);
        else if (position.position_type === 'CUSTOMER_CREDIT') add('CUSTOMER_CREDITS', -position.carrying_value_syp);
        else if (position.position_type === 'SUPPLIER_PAYABLE') add('ACCOUNTS_PAYABLE', -position.carrying_value_syp);
        else if (position.position_type === 'SUPPLIER_ADVANCE') add('SUPPLIER_ADVANCES', position.carrying_value_syp);
        else if (position.position_type === 'INVENTORY') add('INVENTORY', position.carrying_value_syp);
      }
      const net = [...expected.values()].reduce((sum, value) => sum + value, 0); if (net !== 0) add('OPENING_EQUITY', -net);
      const actualRows = await db.getAllAsync<{ system_key: string; effect: number }>(`SELECT a.system_key,SUM(jl.debit_syp-jl.credit_syp) effect FROM journal_lines jl JOIN gl_accounts a ON a.id=jl.account_id WHERE jl.journal_entry_id=? GROUP BY a.id`, settings.opening_journal_entry_id);
      const actual = new Map(actualRows.map(row => [row.system_key, row.effect]));
      const keys = new Set([...expected.keys(), ...actual.keys()]);
      if ([...keys].some(key => (expected.get(key) ?? 0) !== (actual.get(key) ?? 0)) || [...actual.values()].some(value => value === 0)) issues.push('OPENING_JOURNAL_CUTOVER_MISMATCH');
    }
  } else {
    const disabledState = journalEntries + journalLines + await count(db, `SELECT
      (SELECT COUNT(*) FROM accounting_cutover_positions)+(SELECT COUNT(*) FROM inventory_value_balances)+
      (SELECT COUNT(*) FROM inventory_value_movements)+(SELECT COUNT(*) FROM cash_control)+
      (SELECT COUNT(*) FROM supplier_foreign_position_layers)+(SELECT COUNT(*) FROM supplier_foreign_allocations)+
      (SELECT COUNT(*) FROM cash_adjustments) count`);
    if (disabledState !== 0) issues.push('DISABLED_ACCOUNTING_HAS_STATE');
  }
  if (enabled && settings.accounting_started_at) {
    if (await count(db, "SELECT COUNT(*) count FROM journal_entries WHERE source_type<>'opening' AND occurred_at<?", settings.accounting_started_at)) issues.push('PRE_CUTOVER_SOURCE_POSTED');
    const missing = await count(db, `SELECT COUNT(*) count FROM (
      SELECT 'sale' type,id FROM sales WHERE created_at>=? AND (net_total_syp<>0 OR on_account_syp<>0 OR change_syp<>0 OR COALESCE((SELECT SUM(accounting_cogs_syp) FROM sale_items WHERE sale_id=sales.id),0)<>0)
      UNION ALL SELECT 'sale_return',id FROM sale_returns WHERE created_at>=? AND (refund_total_syp<>0 OR COALESCE((SELECT SUM(accounting_restored_cogs_syp) FROM sale_return_items WHERE return_id=sale_returns.id),0)<>0)
      UNION ALL SELECT 'expense',id FROM expenses WHERE created_at>=? AND amount_syp<>0
      UNION ALL SELECT 'purchase',id FROM purchase_receipts WHERE received_at>=? AND COALESCE(accounting_total_syp,0)<>0
      UNION ALL SELECT 'supplier_return',id FROM purchase_returns WHERE created_at>=? AND (COALESCE(accounting_inventory_relief_syp,0)<>0 OR COALESCE(accounting_position_relief_syp,0)<>0 OR COALESCE(accounting_advance_created_syp,0)<>0 OR COALESCE(accounting_variance_syp,0)<>0)
      UNION ALL SELECT 'supplier_payment',id FROM supplier_payments WHERE occurred_at>=?
      UNION ALL SELECT 'customer_payment',id FROM customer_payments WHERE occurred_at>=?
      UNION ALL SELECT 'cash_adjustment',id FROM cash_adjustments WHERE occurred_at>=?
      UNION ALL SELECT 'inventory_adjustment',source_id FROM inventory_value_movements WHERE created_at>=? AND source_type IN ('opening','stock_in','stock_out','adjustment') AND value_delta_syp<>0
    ) source WHERE NOT EXISTS(SELECT 1 FROM journal_entries je WHERE je.source_type=source.type AND je.source_id=source.id)`, ...Array(9).fill(settings.accounting_started_at));
    if (missing) issues.push('MISSING_NONZERO_SOURCE_JOURNAL');
  }
  const control = enabled ? await db.getFirstAsync<{ cash_syp: number; cash_usd_carrying_syp: number }>('SELECT cash_syp,cash_usd_carrying_syp FROM cash_control WHERE id=1') : null;
  const controls = enabled ? await db.getAllAsync<{ system_key: string; net_balance_syp: number }>("SELECT a.system_key,b.net_balance_syp FROM gl_accounts a JOIN gl_account_balances b ON b.account_id=a.id WHERE a.system_key IN ('CASH_SYP','CASH_USD','ACCOUNTS_RECEIVABLE','CUSTOMER_CREDITS','INVENTORY','ACCOUNTS_PAYABLE','SUPPLIER_ADVANCES')") : [];
  const controlMap = new Map(controls.map(row => [row.system_key, row.net_balance_syp]));
  if (enabled && (!control || control.cash_syp !== (controlMap.get('CASH_SYP') ?? 0) || control.cash_usd_carrying_syp !== (controlMap.get('CASH_USD') ?? 0))) issues.push('CASH_CONTROL_MISMATCH');
  if (enabled && await count(db, `SELECT COUNT(*) count FROM inventory_value_balances v JOIN inventory_balances b ON b.product_id=v.product_id WHERE typeof(v.quantity_snapshot)<>'integer' OR typeof(v.carrying_value_syp)<>'integer' OR v.quantity_snapshot<>b.quantity OR v.carrying_value_syp<0 OR (v.quantity_snapshot=0 AND v.carrying_value_syp<>0)`)) issues.push('INVENTORY_VALUE_QUANTITY_MISMATCH');
  if (enabled && await count(db, `SELECT COUNT(*) count FROM inventory_value_movements m WHERE typeof(m.quantity_delta)<>'integer' OR typeof(m.value_delta_syp)<>'integer' OR m.quantity_after<>m.quantity_before+m.quantity_delta OR m.value_after_syp<>m.value_before_syp+m.value_delta_syp OR m.quantity_before<0 OR m.quantity_after<0 OR m.value_before_syp<0 OR m.value_after_syp<0 OR (m.quantity_after=0 AND m.value_after_syp<>0)`)) issues.push('INVENTORY_VALUE_MOVEMENT_INVALID');
  if (enabled && await count(db, `SELECT COUNT(*) count FROM inventory_value_balances v WHERE EXISTS(SELECT 1 FROM inventory_value_movements m WHERE m.product_id=v.product_id) AND (v.quantity_snapshot<>(SELECT quantity_after FROM inventory_value_movements m WHERE m.product_id=v.product_id ORDER BY m.id DESC LIMIT 1) OR v.carrying_value_syp<>(SELECT value_after_syp FROM inventory_value_movements m WHERE m.product_id=v.product_id ORDER BY m.id DESC LIMIT 1))`)) issues.push('INVENTORY_VALUE_LATEST_MISMATCH');
  const inventoryValue = enabled ? (await db.getFirstAsync<{ total: number }>('SELECT COALESCE(SUM(carrying_value_syp),0) total FROM inventory_value_balances'))?.total ?? 0 : 0;
  if (enabled && inventoryValue !== (controlMap.get('INVENTORY') ?? 0)) issues.push('INVENTORY_CONTROL_MISMATCH');
  const customer = enabled ? await db.getFirstAsync<{ receivable: number; credits: number }>('SELECT COALESCE(SUM(CASE WHEN balance_syp>0 THEN balance_syp ELSE 0 END),0) receivable,COALESCE(SUM(CASE WHEN balance_syp<0 THEN -balance_syp ELSE 0 END),0) credits FROM customer_account_balances') : null;
  if (enabled && (!customer || customer.receivable !== (controlMap.get('ACCOUNTS_RECEIVABLE') ?? 0) || -customer.credits !== (controlMap.get('CUSTOMER_CREDITS') ?? 0))) issues.push('CUSTOMER_CONTROL_MISMATCH');
  const supplier = enabled ? await db.getFirstAsync<{ payable_native: number; advance_native: number; payable_syp: number; advance_syp: number }>(`SELECT
    COALESCE((SELECT SUM(remaining_usd_cents) FROM supplier_foreign_position_layers WHERE position_type='PAYABLE'),0) payable_native,
    COALESCE((SELECT SUM(remaining_usd_cents) FROM supplier_foreign_position_layers WHERE position_type='ADVANCE'),0) advance_native,
    COALESCE((SELECT SUM(remaining_carrying_syp) FROM supplier_foreign_position_layers WHERE position_type='PAYABLE'),0) payable_syp,
    COALESCE((SELECT SUM(remaining_carrying_syp) FROM supplier_foreign_position_layers WHERE position_type='ADVANCE'),0) advance_syp`) : null;
  const supplierBalances = enabled ? await db.getFirstAsync<{ payable: number; advances: number }>('SELECT COALESCE(SUM(CASE WHEN balance_usd_cents>0 THEN balance_usd_cents ELSE 0 END),0) payable,COALESCE(SUM(CASE WHEN balance_usd_cents<0 THEN -balance_usd_cents ELSE 0 END),0) advances FROM supplier_account_balances') : null;
  if (enabled && (!supplier || !supplierBalances || supplier.payable_native !== supplierBalances.payable || supplier.advance_native !== supplierBalances.advances || -supplier.payable_syp !== (controlMap.get('ACCOUNTS_PAYABLE') ?? 0) || supplier.advance_syp !== (controlMap.get('SUPPLIER_ADVANCES') ?? 0))) issues.push('SUPPLIER_CONTROL_MISMATCH');
  if (enabled && await count(db, 'SELECT COUNT(*) count FROM supplier_foreign_position_layers WHERE remaining_usd_cents=0 AND remaining_carrying_syp<>0')) issues.push('SUPPLIER_POSITION_RESIDUAL_INVALID');
  if (enabled && await count(db, `SELECT COUNT(*) count FROM supplier_foreign_position_layers l WHERE typeof(l.original_usd_cents)<>'integer' OR typeof(l.remaining_usd_cents)<>'integer' OR typeof(l.original_carrying_syp)<>'integer' OR typeof(l.remaining_carrying_syp)<>'integer' OR l.remaining_usd_cents<0 OR l.remaining_usd_cents>l.original_usd_cents OR l.remaining_carrying_syp<0 OR l.remaining_carrying_syp>l.original_carrying_syp OR l.original_usd_cents-l.remaining_usd_cents<>COALESCE((SELECT SUM(a.native_usd_cents) FROM supplier_foreign_allocations a WHERE a.layer_id=l.id),0) OR l.original_carrying_syp-l.remaining_carrying_syp<>COALESCE((SELECT SUM(a.carrying_value_syp) FROM supplier_foreign_allocations a WHERE a.layer_id=l.id),0)`)) issues.push('SUPPLIER_POSITION_ALLOCATION_MISMATCH');
  return { ok: issues.length === 0, checkedAt, enabled, issues, journalEntries, journalLines, totalDebitSyp, totalCreditSyp };
}

export async function buildBalanceSheet(db: SQLite.SQLiteDatabase, asOf?: string | null): Promise<BalanceSheetReport> {
  const [trial, health, profit] = await Promise.all([buildTrialBalance(db, asOf), auditAccountingHealth(db), buildProfitAndLoss(db, { to: asOf })]);
  const byKey = new Map(trial.rows.map(row => [row.systemKey, row.debitBalanceSyp - row.creditBalanceSyp]));
  const account = (key: string) => byKey.get(key) ?? 0;
  const assetsSyp = trial.rows.filter(row => row.accountType === 'ASSET').reduce((sum, row) => sum + row.debitBalanceSyp - row.creditBalanceSyp, 0);
  const liabilitiesSyp = -trial.rows.filter(row => row.accountType === 'LIABILITY').reduce((sum, row) => sum + row.debitBalanceSyp - row.creditBalanceSyp, 0);
  const openingEquitySyp = -account('OPENING_EQUITY'); const ownerContributionsSyp = -account('OWNER_CONTRIBUTIONS'); const ownerDrawingsSyp = account('OWNER_DRAWINGS'); const priorPeriodAdjustmentSyp = -account('PRIOR_PERIOD_ADJUSTMENT');
  const currentEarningsSyp = profit.netProfitSyp; const equitySyp = openingEquitySyp + ownerContributionsSyp - ownerDrawingsSyp + priorPeriodAdjustmentSyp + currentEarningsSyp; const liabilitiesAndEquitySyp = liabilitiesSyp + equitySyp;
  const blockedReasons = [...health.issues]; if (!trial.balanced) blockedReasons.push('TRIAL_BALANCE_UNBALANCED'); if (assetsSyp !== liabilitiesAndEquitySyp) blockedReasons.push('BALANCE_SHEET_IDENTITY_FAILED');
  return { asOf: asOf ?? null, valid: blockedReasons.length === 0, blockedReasons: [...new Set(blockedReasons)],
    assetsSyp: normalized(assetsSyp, 'REPORT_TOTAL_OVERFLOW'), liabilitiesSyp: normalized(liabilitiesSyp, 'REPORT_TOTAL_OVERFLOW'),
    openingEquitySyp: normalized(openingEquitySyp, 'REPORT_TOTAL_OVERFLOW'), ownerContributionsSyp: normalized(ownerContributionsSyp, 'REPORT_TOTAL_OVERFLOW'),
    ownerDrawingsSyp: normalized(ownerDrawingsSyp, 'REPORT_TOTAL_OVERFLOW'), priorPeriodAdjustmentSyp: normalized(priorPeriodAdjustmentSyp, 'REPORT_TOTAL_OVERFLOW'),
    currentEarningsSyp: normalized(currentEarningsSyp, 'REPORT_TOTAL_OVERFLOW'), equitySyp: normalized(equitySyp, 'REPORT_TOTAL_OVERFLOW'),
    liabilitiesAndEquitySyp: normalized(liabilitiesAndEquitySyp, 'REPORT_TOTAL_OVERFLOW') };
}
