import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  allocateIntegerByLargestRemainder,
  allocatePurchaseSypByLargestRemainder,
  cumulativeHalfUpAllocation,
  incrementalHalfUpAllocation,
  proportionalCarryingAllocation,
  relieveWeightedAverageCarryingValue,
  roundHalfUpRatio,
  splitCarryingValueAtZero,
  usdCentsToSyp,
} from '../src/accounting/accountingMath.ts';
import { ACCOUNTING_V19_SCHEMA_SQL, SYSTEM_ACCOUNTS } from '../src/accounting/accountingSchema.ts';
import { auditAccountingHealth, buildAccountLedger, buildAccountingReconciliation, buildBalanceSheet, buildProfitAndLoss, buildTrialBalance, readGeneralJournal, readJournalDetail } from '../src/accounting/accountingReports.ts';
import { activateAccountingCutover, addCashUsd, consumeSupplierPositionLayers, createSupplierPositionLayer, postJournalEntry, removeCashUsd, signedControlTransitionLines } from '../src/accounting/accountingCore.ts';

const databaseSource = await readFile(new URL('../src/database/database.ts', import.meta.url), 'utf8');
const coreSource = await readFile(new URL('../src/accounting/accountingCore.ts', import.meta.url), 'utf8');
const reportSource = await readFile(new URL('../src/accounting/accountingReports.ts', import.meta.url), 'utf8');
const backupSource = await readFile(new URL('../src/backup/backupManager.ts', import.meta.url), 'utf8');
const restoreSource = await readFile(new URL('../src/import/fullRestoreInserter.ts', import.meta.url), 'utf8');
const analyzerSource = await readFile(new URL('../src/import/importAnalyzer.ts', import.meta.url), 'utf8');
const importerSource = await readFile(new URL('../src/import/jsonImporter.ts', import.meta.url), 'utf8');
const excelSource = await readFile(new URL('../src/utils/excel.ts', import.meta.url), 'utf8');
const accountingReportSource = await readFile(new URL('../src/utils/accountingReport.ts', import.meta.url), 'utf8');
const accountingScreenSource = await readFile(new URL('../src/screens/AccountingScreen.tsx', import.meta.url), 'utf8');
const inventoryScreenSource = await readFile(new URL('../src/screens/InventoryScreen.tsx', import.meta.url), 'utf8');

function accountingDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE products(id INTEGER PRIMARY KEY);
    CREATE TABLE suppliers(id INTEGER PRIMARY KEY);
    CREATE TABLE customers(id INTEGER PRIMARY KEY);
    CREATE TABLE cash_sessions(id INTEGER PRIMARY KEY,closed_at TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE customer_account_balances(customer_id INTEGER PRIMARY KEY,balance_syp INTEGER NOT NULL);
    CREATE TABLE supplier_account_balances(supplier_id INTEGER PRIMARY KEY,balance_usd_cents INTEGER NOT NULL);
    CREATE TABLE inventory_balances(product_id INTEGER PRIMARY KEY,tracking_enabled INTEGER NOT NULL,quantity INTEGER NOT NULL);
    CREATE TABLE sales(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,net_total_syp INTEGER NOT NULL,on_account_syp INTEGER NOT NULL DEFAULT 0,change_syp INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sale_items(id INTEGER PRIMARY KEY,sale_id INTEGER NOT NULL,accounting_cogs_syp INTEGER);
    CREATE TABLE sale_returns(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,refund_total_syp INTEGER NOT NULL);
    CREATE TABLE sale_return_items(id INTEGER PRIMARY KEY,return_id INTEGER NOT NULL,accounting_restored_cogs_syp INTEGER);
    CREATE TABLE expenses(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,amount_syp INTEGER NOT NULL);
    CREATE TABLE purchase_receipts(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,received_at TEXT NOT NULL,accounting_total_syp INTEGER);
    CREATE TABLE purchase_returns(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,accounting_inventory_relief_syp INTEGER,accounting_position_relief_syp INTEGER,accounting_advance_created_syp INTEGER,accounting_variance_syp INTEGER);
    CREATE TABLE supplier_payments(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,occurred_at TEXT NOT NULL);
    CREATE TABLE customer_payments(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,occurred_at TEXT NOT NULL);
    CREATE TABLE inventory_movements(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
    ${ACCOUNTING_V19_SCHEMA_SQL}`);
  db.prepare("INSERT INTO settings(key,value) VALUES('exchangeRate','15000')").run();
  const account = db.prepare(`INSERT INTO gl_accounts
    (uuid,code,system_key,name_ar,name_en,account_type,normal_side,is_system,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,1,1,'2026-01-01','2026-01-01')`);
  const balance = db.prepare(`INSERT INTO gl_account_balances
    (account_id,debit_total_syp,credit_total_syp,net_balance_syp,updated_at) VALUES(?,0,0,0,'2026-01-01')`);
  for (const [index, row] of SYSTEM_ACCOUNTS.entries()) {
    const inserted = account.run(`20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, row.code, row.systemKey, row.nameAr, row.nameEn, row.accountType, row.normalSide);
    balance.run(inserted.lastInsertRowid);
  }
  db.prepare(`INSERT INTO accounting_settings
    (id,accounting_enabled,accounting_started_at,functional_currency,cutover_exchange_rate_syp_per_usd,opening_journal_entry_id,created_at,updated_at)
    VALUES(1,0,NULL,'SYP',NULL,NULL,'2026-01-01','2026-01-01')`).run();
  return db;
}

function asyncDb(db) {
  return {
    getAllAsync: async (sql, ...parameters) => db.prepare(sql).all(...parameters),
    getFirstAsync: async (sql, ...parameters) => db.prepare(sql).get(...parameters),
    runAsync: async (sql, ...parameters) => {
      const result = db.prepare(sql).run(...parameters);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
  };
}

function insertBalancedJournal(db, { uuid, sourceType, sourceId, occurredAt, lines }) {
  const entry = db.prepare(`INSERT INTO journal_entries(uuid,source_type,source_id,occurred_at,created_at,description_snapshot)
    VALUES(?,?,?,?,?,'Test journal')`).run(uuid, sourceType, sourceId, occurredAt, occurredAt);
  const insert = db.prepare(`INSERT INTO journal_lines(uuid,journal_entry_id,account_id,debit_syp,credit_syp,created_at)
    VALUES(?,?,?,?,?,?)`);
  for (const [index, line] of lines.entries()) {
    const accountId = db.prepare('SELECT id FROM gl_accounts WHERE system_key=?').get(line.account).id;
    insert.run(`${uuid}-line-${index}`, entry.lastInsertRowid, accountId, line.debit ?? 0, line.credit ?? 0, occurredAt);
    db.prepare(`UPDATE gl_account_balances SET debit_total_syp=debit_total_syp+?,credit_total_syp=credit_total_syp+?,net_balance_syp=net_balance_syp+?-? WHERE account_id=?`)
      .run(line.debit ?? 0, line.credit ?? 0, line.debit ?? 0, line.credit ?? 0, accountId);
  }
  return Number(entry.lastInsertRowid);
}

function timingStats(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return { min: Number(sorted[0].toFixed(2)), median: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)), max: Number(sorted.at(-1).toFixed(2)) };
}

async function measure(operation, runs = 5) {
  await operation();
  const values = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now(); await operation(); values.push(performance.now() - started);
  }
  return timingStats(values);
}

test('BigInt currency conversion uses deterministic half-up integer semantics', () => {
  assert.equal(roundHalfUpRatio(1n, 2n), 1n);
  assert.equal(roundHalfUpRatio(4n, 3n), 1n);
  assert.equal(usdCentsToSyp(1, 150), 2);
  assert.equal(usdCentsToSyp(2500, 15000), 375000);
  assert.throws(() => usdCentsToSyp(Number.MAX_SAFE_INTEGER, 15000), /OVERFLOW/);
});

test('cumulative allocation preserves exact staged and final totals', () => {
  const allocations = [
    incrementalHalfUpAllocation(10001, 0, 1, 3),
    incrementalHalfUpAllocation(10001, 1, 2, 3),
    incrementalHalfUpAllocation(10001, 2, 3, 3),
  ];
  assert.deepEqual(allocations, [3334, 3333, 3334]);
  assert.equal(allocations.reduce((sum, value) => sum + value, 0), 10001);
  assert.equal(cumulativeHalfUpAllocation(10001, 3, 3), 10001);
});

test('largest-remainder purchase allocation is exact and stable on ties', () => {
  const forward = allocatePurchaseSypByLargestRemainder([
    { key: 'b', usdCents: 1 }, { key: 'a', usdCents: 1 }, { key: 'c', usdCents: 1 },
  ], 150);
  assert.equal(forward.totalSyp, 5);
  assert.deepEqual(forward.allocations.map(row => [row.key, row.accountingSyp]), [['b', 2], ['a', 2], ['c', 1]]);
  const reversed = allocatePurchaseSypByLargestRemainder([
    { key: 'c', usdCents: 1 }, { key: 'b', usdCents: 1 }, { key: 'a', usdCents: 1 },
  ], 150);
  assert.deepEqual(Object.fromEntries(forward.allocations.map(row => [row.key, row.accountingSyp])), Object.fromEntries(reversed.allocations.map(row => [row.key, row.accountingSyp])));
});

test('generic largest-remainder allocation preserves exact carrying basis', () => {
  const allocations = allocateIntegerByLargestRemainder(10_001, [
    { key: 3, weight: 1 }, { key: 1, weight: 1 }, { key: 2, weight: 1 },
  ]);
  assert.deepEqual(allocations, [{ key: 3, amount: 3333 }, { key: 1, amount: 3334 }, { key: 2, amount: 3334 }]);
  assert.equal(allocations.reduce((sum, row) => sum + row.amount, 0), 10_001);
});

test('weighted-average and zero-crossing allocations preserve residuals', () => {
  assert.equal(proportionalCarryingAllocation(10001, 1, 3), 3334);
  assert.equal(relieveWeightedAverageCarryingValue(3, 10001, 2), 6667);
  assert.equal(relieveWeightedAverageCarryingValue(1, 3334, 1), 3334);
  assert.deepEqual(splitCarryingValueAtZero(15001, 2, 3), { payableConsiderationSyp: 10001, advanceConsiderationSyp: 5000 });
});

test('signed customer controls cross receivable and credit without losing value', () => {
  assert.deepEqual(signedControlTransitionLines(10_000, 4_000, 'ACCOUNTS_RECEIVABLE', 'CUSTOMER_CREDITS'), [
    { account: 'ACCOUNTS_RECEIVABLE', creditSyp: 6_000 }, { account: 'CUSTOMER_CREDITS', debitSyp: 0 },
  ]);
  assert.deepEqual(signedControlTransitionLines(4_000, -1_500, 'ACCOUNTS_RECEIVABLE', 'CUSTOMER_CREDITS'), [
    { account: 'ACCOUNTS_RECEIVABLE', creditSyp: 4_000 }, { account: 'CUSTOMER_CREDITS', creditSyp: 1_500 },
  ]);
  assert.deepEqual(signedControlTransitionLines(-1_500, 2_000, 'ACCOUNTS_RECEIVABLE', 'CUSTOMER_CREDITS'), [
    { account: 'ACCOUNTS_RECEIVABLE', debitSyp: 2_000 }, { account: 'CUSTOMER_CREDITS', debitSyp: 1_500 },
  ]);
});

test('USD cash carrying value is weighted-average and exact on final relief', async () => {
  const db = accountingDb(); const api = asyncDb(db); const at = '2026-01-01T00:00:00.000Z';
  await activateAccountingCutover(api, { cashSyp: 0, cashUsdCents: 0, cashUsdCarryingSyp: 0, currentExchangeRateSypPerUsd: 15000, customers: [], suppliers: [], inventory: [], confirmedAt: at });
  await addCashUsd(api, 100, 15_000, 15_000, at);
  await addCashUsd(api, 100, 15_500, 15_500, at);
  const partial = await removeCashUsd(api, 100, 16_000, at);
  assert.equal(partial.carryingReliefSyp, 15_250);
  assert.deepEqual({ ...db.prepare('SELECT cash_usd_cents,cash_usd_carrying_syp FROM cash_control WHERE id=1').get() }, { cash_usd_cents: 100, cash_usd_carrying_syp: 15_250 });
  const final = await removeCashUsd(api, 100, 16_000, at);
  assert.equal(final.carryingReliefSyp, 15_250);
  assert.deepEqual({ ...db.prepare('SELECT cash_usd_cents,cash_usd_carrying_syp FROM cash_control WHERE id=1').get() }, { cash_usd_cents: 0, cash_usd_carrying_syp: 0 });
  db.close();
});

test('supplier foreign positions consume FIFO and preserve exact native and carrying residuals', async () => {
  const db = accountingDb(); const api = asyncDb(db); const at = '2026-01-01T00:00:00.000Z';
  db.prepare('INSERT INTO suppliers(id) VALUES(1)').run();
  await createSupplierPositionLayer(api, { supplierId: 1, positionType: 'PAYABLE', sourceType: 'purchase', sourceId: 1, nativeUsdCents: 100, carryingSyp: 15_000, exchangeRateSypPerUsd: 15_000, occurredAt: at });
  await createSupplierPositionLayer(api, { supplierId: 1, positionType: 'PAYABLE', sourceType: 'purchase', sourceId: 2, nativeUsdCents: 100, carryingSyp: 15_500, exchangeRateSypPerUsd: 15_500, occurredAt: '2026-01-02T00:00:00.000Z' });
  const relief = await consumeSupplierPositionLayers(api, { supplierId: 1, positionType: 'PAYABLE', sourceType: 'supplier_payment', sourceId: 3, nativeUsdCents: 150, occurredAt: '2026-01-03T00:00:00.000Z' });
  assert.equal(relief, 22_750);
  assert.deepEqual(db.prepare('SELECT remaining_usd_cents,remaining_carrying_syp FROM supplier_foreign_position_layers ORDER BY id').all().map(row => ({ ...row })), [
    { remaining_usd_cents: 0, remaining_carrying_syp: 0 }, { remaining_usd_cents: 50, remaining_carrying_syp: 7_750 },
  ]);
  assert.deepEqual({ ...db.prepare('SELECT SUM(native_usd_cents) native,SUM(carrying_value_syp) carrying FROM supplier_foreign_allocations').get() }, { native: 150, carrying: 22_750 });
  db.close();
});

test('v19 accounting schema seeds the locked chart and rejects invalid journals', () => {
  const db = accountingDb();
  assert.equal(SYSTEM_ACCOUNTS.length, 21);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM gl_accounts').get().count, 21);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM gl_account_balances').get().count, 21);
  assert.deepEqual({ ...db.prepare('SELECT accounting_enabled,functional_currency,opening_journal_entry_id FROM accounting_settings').get() }, { accounting_enabled: 0, functional_currency: 'SYP', opening_journal_entry_id: null });
  const entry = db.prepare(`INSERT INTO journal_entries(uuid,source_type,source_id,occurred_at,created_at,description_snapshot)
    VALUES('entry-1','sale',1,'2026-01-01','2026-01-01','Sale')`).run();
  const cash = db.prepare("SELECT id FROM gl_accounts WHERE system_key='CASH_SYP'").get().id;
  assert.throws(() => db.prepare(`INSERT INTO journal_lines(uuid,journal_entry_id,account_id,debit_syp,credit_syp,created_at)
    VALUES('line-zero',?,?,0,0,'2026-01-01')`).run(entry.lastInsertRowid, cash));
  assert.throws(() => db.prepare(`INSERT INTO journal_lines(uuid,journal_entry_id,account_id,debit_syp,credit_syp,created_at)
    VALUES('line-double',?,?,1,1,'2026-01-01')`).run(entry.lastInsertRowid, cash));
  db.close();
});

test('quantity-only zero-value inventory evidence is valid and exact', () => {
  const db = accountingDb();
  db.prepare('INSERT INTO products(id) VALUES(1)').run();
  db.prepare("INSERT INTO inventory_value_balances(product_id,quantity_snapshot,carrying_value_syp,updated_at) VALUES(1,5,0,'2026-01-01')").run();
  db.prepare(`INSERT INTO inventory_value_movements
    (uuid,product_id,source_type,source_id,source_item_id,quantity_delta,quantity_before,quantity_after,value_delta_syp,value_before_syp,value_after_syp,created_at)
    VALUES('movement-1',1,'purchase',1,1,5,0,5,0,0,0,'2026-01-01')`).run();
  assert.deepEqual({ ...db.prepare('SELECT quantity_delta,value_delta_syp,value_after_syp FROM inventory_value_movements').get() }, { quantity_delta: 5, value_delta_syp: 0, value_after_syp: 0 });
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
});

test('migration is one v18 to v19 schema-only step and cutover honors zero policy', () => {
  assert.match(databaseSource, /export const SCHEMA_VERSION = 19/);
  assert.match(databaseSource, /async function migrateAccountingCoreV19/);
  assert.match(databaseSource, /await migrateCustomerAccountsV18\(\);\s*await migrateAccountingCoreV19\(\)/);
  assert.match(databaseSource, /INSERT INTO accounting_settings[\s\S]*VALUES\(1,0,NULL,'SYP',NULL,NULL/);
  assert.match(databaseSource, /PRAGMA user_version = 19/);
  assert.doesNotMatch(databaseSource.slice(databaseSource.indexOf('async function migrateAccountingCoreV19'), databaseSource.indexOf('export async function initializeDatabase')), /INSERT INTO journal_entries|INSERT INTO inventory_value_movements|UPDATE sales|UPDATE purchase_receipts/);
  assert.match(coreSource, /if \(nonzero\.length === 0\) return \{ classification: 'ZERO_EFFECT_NO_JOURNAL', journalEntryId: null \}/);
  assert.match(coreSource, /opening_journal_entry_id=\?/);
  assert.match(coreSource, /posted\.journalEntryId/);
});

test('journal, ledger, trial balance and P&L are GL-derived and integer exact', async () => {
  const db = accountingDb(); const api = asyncDb(db);
  const saleId = insertBalancedJournal(db, { uuid: 'sale-journal', sourceType: 'sale', sourceId: 1, occurredAt: '2026-01-02T00:00:00.000Z', lines: [
    { account: 'CASH_SYP', debit: 90_000 }, { account: 'SALES_REVENUE', credit: 90_000 },
  ] });
  insertBalancedJournal(db, { uuid: 'expense-journal', sourceType: 'expense', sourceId: 1, occurredAt: '2026-01-03T00:00:00.000Z', lines: [
    { account: 'OPERATING_EXPENSE', debit: 10_000 }, { account: 'CASH_SYP', credit: 10_000 },
  ] });
  const journal = await readGeneralJournal(api);
  assert.equal(journal.length, 2);
  assert.equal((await readJournalDetail(api, saleId)).lines.length, 2);
  const trial = await buildTrialBalance(api);
  assert.equal(trial.balanced, true);
  assert.equal(trial.totalDebitSyp, trial.totalCreditSyp);
  const cashId = db.prepare("SELECT id FROM gl_accounts WHERE system_key='CASH_SYP'").get().id;
  const ledger = await buildAccountLedger(api, cashId);
  assert.deepEqual(ledger.rows.map(row => row.runningBalanceSyp), [90_000, 80_000]);
  const profit = await buildProfitAndLoss(api);
  assert.equal(profit.netSalesSyp, 90_000);
  assert.equal(profit.operatingExpensesSyp, 10_000);
  assert.equal(profit.netProfitSyp, 80_000);
  db.close();
});

test('posting engine omits complete zero effects and posts one immutable balanced source', async () => {
  const db = accountingDb(); const api = asyncDb(db);
  const zero = await postJournalEntry(api, { sourceType: 'sale', sourceId: 1, sourceUuid: 'source-zero', occurredAt: '2026-01-01T00:00:00.000Z', description: 'Zero sale', lines: [
    { account: 'SALES_REVENUE', creditSyp: 0 }, { account: 'CASH_SYP', debitSyp: 0 },
  ] });
  assert.deepEqual(zero, { classification: 'ZERO_EFFECT_NO_JOURNAL', journalEntryId: null });
  assert.equal(db.prepare('SELECT COUNT(*) count FROM journal_entries').get().count, 0);
  const posted = await postJournalEntry(api, { sourceType: 'sale', sourceId: 2, sourceUuid: 'source-posted', occurredAt: '2026-01-01T00:00:00.000Z', description: 'Sale', lines: [
    { account: 'CASH_SYP', debitSyp: 1000 }, { account: 'SALES_REVENUE', creditSyp: 1000 },
  ] });
  assert.equal(posted.classification, 'POSTED');
  assert.deepEqual({ ...db.prepare('SELECT SUM(debit_syp) debit,SUM(credit_syp) credit FROM journal_lines').get() }, { debit: 1000, credit: 1000 });
  assert.throws(() => db.prepare("INSERT INTO journal_entries(uuid,source_type,source_id,occurred_at,created_at,description_snapshot) VALUES('duplicate','sale',2,'x','x','x')").run(), /UNIQUE/);
  db.close();
});

test('zero cutover enables accounting without a fabricated journal while nonzero cutover posts exactly one', async () => {
  const zeroDb = accountingDb(); const zero = await activateAccountingCutover(asyncDb(zeroDb), {
    cashSyp: 0, cashUsdCents: 0, cashUsdCarryingSyp: 0, currentExchangeRateSypPerUsd: 15000,
    customers: [], suppliers: [], inventory: [], confirmedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(zero, { openingJournalEntryId: null, zeroCutover: true });
  assert.deepEqual({ ...zeroDb.prepare('SELECT accounting_enabled,opening_journal_entry_id FROM accounting_settings').get() }, { accounting_enabled: 1, opening_journal_entry_id: null });
  assert.equal(zeroDb.prepare('SELECT COUNT(*) count FROM journal_entries').get().count, 0);
  zeroDb.close();

  const db = accountingDb();
  db.exec(`INSERT INTO products(id) VALUES(1); INSERT INTO suppliers(id) VALUES(1); INSERT INTO customers(id) VALUES(1);
    INSERT INTO inventory_balances(product_id,tracking_enabled,quantity) VALUES(1,1,2);
    INSERT INTO supplier_account_balances(supplier_id,balance_usd_cents) VALUES(1,100);
    INSERT INTO customer_account_balances(customer_id,balance_syp) VALUES(1,-50);`);
  const result = await activateAccountingCutover(asyncDb(db), {
    cashSyp: 1000, cashUsdCents: 100, cashUsdCarryingSyp: 15000, currentExchangeRateSypPerUsd: 15000,
    customers: [{ customerId: 1, balanceSyp: -50 }], suppliers: [{ supplierId: 1, balanceUsdCents: 100, carryingValueSyp: 15000 }],
    inventory: [{ productId: 1, quantity: 2, carryingValueSyp: 20000 }], confirmedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(result.zeroCutover, false);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM journal_entries WHERE source_type='opening'").get().count, 1);
  const totals = db.prepare('SELECT SUM(debit_syp) debit,SUM(credit_syp) credit FROM journal_lines').get();
  assert.equal(totals.debit, totals.credit);
  assert.equal(db.prepare('SELECT opening_journal_entry_id FROM accounting_settings').get().opening_journal_entry_id, result.openingJournalEntryId);
  db.close();
});

test('cash adjustments are immutable GL sources and cannot run inside a drawer session', () => {
  assert.match(databaseSource, /export async function createCashAdjustment/);
  assert.match(databaseSource, /CASH_ADJUSTMENT_ACTIVE_SESSION/);
  assert.match(databaseSource, /OWNER_CONTRIBUTIONS/);
  assert.match(databaseSource, /OWNER_DRAWINGS/);
  assert.match(databaseSource, /CASH_OVER_SHORT/);
  assert.match(databaseSource, /sourceType: 'cash_adjustment'/);
});

test('full backup and restore preserve authoritative accounting state with portable references', () => {
  for (const table of ['accounting_settings', 'accounting_cutover_positions', 'gl_accounts', 'journal_entries', 'journal_lines', 'gl_account_balances', 'inventory_value_balances', 'inventory_value_movements', 'cash_control', 'supplier_foreign_position_layers', 'supplier_foreign_allocations', 'cash_adjustments']) {
    assert.match(backupSource, new RegExp(table));
  }
  assert.match(restoreSource, /ACCOUNTING_CHART_MISMATCH/);
  assert.match(restoreSource, /ACCOUNTING_BALANCE_CACHE_MISMATCH/);
  assert.match(restoreSource, /ACCOUNTING_JOURNAL_UNBALANCED/);
  assert.match(restoreSource, /ACCOUNTING_CUTOVER_POLICY_INVALID/);
  assert.match(restoreSource, /ACCOUNTING_OPENING_JOURNAL_MISMATCH/);
  assert.match(restoreSource, /opening_journal_uuid/);
});

test('safe merge explicitly isolates the General Ledger and operational carrying state', () => {
  assert.match(analyzerSource, /GENERAL_LEDGER_SKIPPED_OPERATIONAL_FINANCE/);
  assert.match(analyzerSource, /options\.mode !== 'full_restore' && payload\.accounting/);
  assert.doesNotMatch(analyzerSource, /INSERT INTO journal_entries/);
});

test('Excel accounting sheets are report-only and cannot mutate the General Ledger', () => {
  for (const sheet of ['Chart of Accounts', 'General Journal', 'Journal Lines', 'Trial Balance']) assert.match(excelSource, new RegExp(sheet));
  const importSection = excelSource.slice(excelSource.indexOf('export async function pickExcel'));
  assert.doesNotMatch(importSection, /journal_entries|journal_lines|gl_account_balances|accounting_settings/);
});

test('Excel accounting report export includes release-gate control and financial sheets', () => {
  for (const sheet of ['Profit & Loss', 'Balance Sheet', 'Reconciliation', 'Inventory Valuation', 'Cash Control', 'Supplier Positions']) {
    assert.match(excelSource, new RegExp(sheet));
  }
  assert.match(excelSource, /customerReceivableSyp/);
  assert.match(excelSource, /supplierPayableSyp/);
  assert.match(excelSource, /difference_syp/);
});

test('accounting UI wires activation, immutable reports, health, ledger, PDF and cash adjustment', () => {
  assert.match(accountingScreenSource, /getAccountingCutoverPreview/);
  assert.match(accountingScreenSource, /activateAccounting/);
  assert.match(accountingScreenSource, /getGeneralJournal/);
  assert.match(accountingScreenSource, /getAccountLedger/);
  assert.match(accountingScreenSource, /getTrialBalance/);
  assert.match(accountingScreenSource, /getProfitAndLoss/);
  assert.match(accountingScreenSource, /getBalanceSheet/);
  assert.match(accountingScreenSource, /auditAccountingHealth/);
  assert.match(accountingScreenSource, /createCashAdjustment/);
  assert.match(accountingScreenSource, /shareTrialBalance/);
  assert.match(accountingScreenSource, /shareAccountLedger/);
  assert.match(accountingReportSource, /@page\{margin:28px\}/);
  assert.match(accountingReportSource, /thead\{display:table-header-group\}/);
  assert.match(accountingReportSource, /tr\{break-inside:avoid\}/);
});

test('post-cutover inventory increases require an explicit SYP carrying value in UI and database', () => {
  assert.match(databaseSource, /ACCOUNTING_INVENTORY_VALUE_REQUIRED/);
  assert.match(inventoryScreenSource, /accountingValueRequired/);
  assert.match(inventoryScreenSource, /needsAccountingValue/);
  assert.match(inventoryScreenSource, /accountingOpeningValueSyp|parsedAccountingValue/);
  assert.match(reportSource, /INVENTORY_CONTROL_MISMATCH/);
});

test('posted journals and locked system-account identities are immutable in SQLite', async () => {
  const db = accountingDb(); const api = asyncDb(db);
  db.prepare("INSERT INTO sales(id,uuid,created_at,net_total_syp) VALUES(1,'sale-source','2026-01-02',1000)").run();
  const posted = await postJournalEntry(api, { sourceType: 'sale', sourceId: 1, sourceUuid: 'sale-source', occurredAt: '2026-01-02T00:00:00.000Z', description: 'Sale', lines: [
    { account: 'CASH_SYP', debitSyp: 1000 }, { account: 'SALES_REVENUE', creditSyp: 1000 },
  ] });
  db.prepare("UPDATE accounting_settings SET accounting_enabled=1,accounting_started_at='2026-01-01',cutover_exchange_rate_syp_per_usd=15000 WHERE id=1").run();
  assert.throws(() => db.prepare("UPDATE journal_entries SET reference='changed' WHERE id=?").run(posted.journalEntryId), /JOURNAL_ENTRY_IMMUTABLE/);
  assert.throws(() => db.prepare('DELETE FROM journal_lines WHERE journal_entry_id=?').run(posted.journalEntryId), /JOURNAL_LINE_IMMUTABLE/);
  assert.throws(() => db.prepare("UPDATE gl_accounts SET code='9999' WHERE system_key='CASH_SYP'").run(), /SYSTEM_ACCOUNT_IMMUTABLE/);
  assert.throws(() => db.prepare("DELETE FROM gl_accounts WHERE system_key='CASH_SYP'").run(), /SYSTEM_ACCOUNT_IMMUTABLE/);
  db.close();
});

test('reversal identity is exact and a journal cannot be reversed twice', async () => {
  const db = accountingDb(); const api = asyncDb(db);
  db.prepare("INSERT INTO sales(id,uuid,created_at,net_total_syp) VALUES(1,'sale-source','2026-01-02',1000)").run();
  const original = await postJournalEntry(api, { sourceType: 'sale', sourceId: 1, sourceUuid: 'sale-source', occurredAt: '2026-01-02T00:00:00.000Z', description: 'Sale', lines: [
    { account: 'CASH_SYP', debitSyp: 1000 }, { account: 'SALES_REVENUE', creditSyp: 1000 },
  ] });
  const originalUuid = db.prepare('SELECT uuid FROM journal_entries WHERE id=?').get(original.journalEntryId).uuid;
  await postJournalEntry(api, { sourceType: 'reversal', sourceId: original.journalEntryId, sourceUuid: originalUuid, reversalOfEntryId: original.journalEntryId, occurredAt: '2026-01-03T00:00:00.000Z', description: 'Reversal', lines: [
    { account: 'SALES_REVENUE', debitSyp: 1000 }, { account: 'CASH_SYP', creditSyp: 1000 },
  ] });
  await assert.rejects(postJournalEntry(api, { sourceType: 'reversal', sourceId: original.journalEntryId, sourceUuid: originalUuid, reversalOfEntryId: original.journalEntryId, occurredAt: '2026-01-04T00:00:00.000Z', description: 'Duplicate reversal', lines: [
    { account: 'SALES_REVENUE', debitSyp: 1000 }, { account: 'CASH_SYP', creditSyp: 1000 },
  ] }), /UNIQUE/);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM journal_entries WHERE source_type='reversal'").get().count, 1);
  db.close();
});

test('accounting health validates zero cutover, control caches and balance-sheet identity', async () => {
  const db = accountingDb(); const api = asyncDb(db);
  await activateAccountingCutover(api, { cashSyp: 0, cashUsdCents: 0, cashUsdCarryingSyp: 0, currentExchangeRateSypPerUsd: 15000, customers: [], suppliers: [], inventory: [], confirmedAt: '2026-01-01T00:00:00.000Z' });
  const healthy = await auditAccountingHealth(api);
  assert.equal(healthy.ok, true, healthy.issues.join(','));
  const balanceSheet = await buildBalanceSheet(api);
  assert.equal(balanceSheet.valid, true);
  assert.equal(balanceSheet.assetsSyp, balanceSheet.liabilitiesAndEquitySyp);
  db.prepare("UPDATE gl_account_balances SET net_balance_syp=1 WHERE account_id=(SELECT id FROM gl_accounts WHERE system_key='CASH_SYP')").run();
  const corrupted = await auditAccountingHealth(api);
  assert.equal(corrupted.ok, false);
  assert.ok(corrupted.issues.includes('GL_BALANCE_CACHE_MISMATCH'));
  assert.ok(corrupted.issues.includes('CASH_CONTROL_MISMATCH'));
  db.close();
});

test('control-account reconciliation exposes exact subledger, ledger and difference values', async () => {
  const db = accountingDb(); const api = asyncDb(db);
  await activateAccountingCutover(api, { cashSyp: 2500, cashUsdCents: 0, cashUsdCarryingSyp: 0, currentExchangeRateSypPerUsd: 15000, customers: [], suppliers: [], inventory: [], confirmedAt: '2026-01-01T00:00:00.000Z' });
  const healthy = await buildAccountingReconciliation(api);
  assert.equal(healthy.enabled, true);
  assert.equal(healthy.ok, true);
  assert.equal(healthy.rows.length, 7);
  assert.deepEqual(healthy.rows.find(row => row.key === 'CASH_SYP'), { key: 'CASH_SYP', controlSyp: 2500, ledgerSyp: 2500, differenceSyp: 0, matched: true, reason: null });
  db.prepare("UPDATE gl_account_balances SET net_balance_syp=2400 WHERE account_id=(SELECT id FROM gl_accounts WHERE system_key='CASH_SYP')").run();
  const mismatched = await buildAccountingReconciliation(api);
  assert.equal(mismatched.ok, false);
  assert.deepEqual(mismatched.rows.find(row => row.key === 'CASH_SYP'), { key: 'CASH_SYP', controlSyp: 2500, ledgerSyp: 2400, differenceSyp: -100, matched: false, reason: 'CONTROL_LEDGER_DIFFERENCE' });
  db.close();
});

test('portable journal validation rejects invalid sources, duplicate sources and malformed reversals before restore', () => {
  assert.match(importerSource, /const sourceTypes = new Set\(\['opening', 'sale', 'sale_return'/);
  assert.match(importerSource, /sourceIdentities\.has\(identity\)/);
  assert.match(importerSource, /entry\.source_uuid !== originalUuid/);
  assert.match(importerSource, /reversalTargets\.has\(originalUuid\)/);
  assert.match(importerSource, /INVALID_ACCOUNTING_REVERSAL/);
});

test('GL fault injection rolls back source, header, lines and cache at every posting boundary', async () => {
  for (const boundary of ['INSERT INTO journal_entries', 'INSERT INTO journal_lines', 'UPDATE gl_account_balances']) {
    const db = accountingDb(); const base = asyncDb(db); let injected = false;
    const api = { ...base, runAsync: async (sql, ...parameters) => {
      const result = await base.runAsync(sql, ...parameters);
      if (!injected && sql.includes(boundary)) { injected = true; throw new Error('INJECTED_ACCOUNTING_FAILURE'); }
      return result;
    } };
    db.exec('BEGIN');
    try {
      db.prepare("INSERT INTO sales(id,uuid,created_at,net_total_syp) VALUES(1,'sale-source','2026-01-02',1000)").run();
      await postJournalEntry(api, { sourceType: 'sale', sourceId: 1, sourceUuid: 'sale-source', occurredAt: '2026-01-02T00:00:00.000Z', description: 'Sale', lines: [
        { account: 'CASH_SYP', debitSyp: 1000 }, { account: 'SALES_REVENUE', creditSyp: 1000 },
      ] });
      assert.fail(`fault was not injected at ${boundary}`);
    } catch (error) {
      assert.match(String(error), /INJECTED_ACCOUNTING_FAILURE/);
      db.exec('ROLLBACK');
    }
    assert.equal(db.prepare('SELECT COUNT(*) count FROM sales').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM journal_entries').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM journal_lines').get().count, 0);
    assert.equal(db.prepare('SELECT SUM(debit_total_syp+credit_total_syp) total FROM gl_account_balances').get().total, 0);
    db.close();
  }
});

test('journal UI exposes localized date, source and account filters and scrollable history', () => {
  assert.match(accountingScreenSource, /accountId/);
  assert.match(accountingScreenSource, /PeriodTabs/);
  assert.match(accountingScreenSource, /sourceLabel/);
  assert.match(accountingScreenSource, /section === 'journal' && <ScrollView/);
  assert.match(accountingScreenSource, /getGeneralJournal\(\{ \.\.\.range, sourceType, accountId/);
  assert.match(accountingScreenSource, /getAccountingReconciliation/);
  assert.match(accountingScreenSource, /controlValue/);
  assert.match(accountingScreenSource, /ledgerValue/);
  assert.match(accountingScreenSource, /difference/);
});

test('purchase functional-currency residuals use immutable insertion sequence, never random UUID order', () => {
  assert.match(databaseSource, /map\(\(item, sequence\) => \(\{ item, uuid: createUuid\(\), sequence/);
  assert.match(databaseSource, /key: plan\.sequence/);
  assert.doesNotMatch(databaseSource, /stablePlans = \[\.\.\.itemPlans\]\.sort[\s\S]{0,120}uuid/);
});

test('50k journals and 100k lines keep reporting, source lookup and health bounded', async () => {
  const db = accountingDb(); const api = asyncDb(db);
  await activateAccountingCutover(api, { cashSyp: 0, cashUsdCents: 0, cashUsdCarryingSyp: 0, currentExchangeRateSypPerUsd: 15000, customers: [], suppliers: [], inventory: [], confirmedAt: '2026-01-01T00:00:00.000Z' });
  const cashId = db.prepare("SELECT id FROM gl_accounts WHERE system_key='CASH_SYP'").get().id;
  const revenueId = db.prepare("SELECT id FROM gl_accounts WHERE system_key='SALES_REVENUE'").get().id;
  const insertSale = db.prepare('INSERT INTO sales(id,uuid,created_at,net_total_syp,on_account_syp,change_syp) VALUES(?,?,?,?,0,0)');
  const insertEntry = db.prepare("INSERT INTO journal_entries(uuid,source_type,source_id,source_uuid,reference,occurred_at,created_at,description_snapshot) VALUES(?,'sale',?,?,?,?,?,'Synthetic sale')");
  const insertLine = db.prepare('INSERT INTO journal_lines(uuid,journal_entry_id,account_id,debit_syp,credit_syp,created_at) VALUES(?,?,?,?,?,?)');
  db.exec('BEGIN');
  for (let id = 1; id <= 50_000; id += 1) {
    const sourceUuid = `perf-sale-${id}`; const occurredAt = `2026-02-${String((id % 28) + 1).padStart(2, '0')}T${String(id % 24).padStart(2, '0')}:00:00.000Z`;
    insertSale.run(id, sourceUuid, occurredAt, 1);
    const entryId = insertEntry.run(`perf-journal-${id}`, id, sourceUuid, `INV-${id}`, occurredAt, occurredAt).lastInsertRowid;
    insertLine.run(`perf-line-d-${id}`, entryId, cashId, 1, 0, occurredAt);
    insertLine.run(`perf-line-c-${id}`, entryId, revenueId, 0, 1, occurredAt);
  }
  db.exec('COMMIT');
  db.prepare('UPDATE gl_account_balances SET debit_total_syp=50000,net_balance_syp=50000 WHERE account_id=?').run(cashId);
  db.prepare('UPDATE gl_account_balances SET credit_total_syp=50000,net_balance_syp=-50000 WHERE account_id=?').run(revenueId);
  db.prepare("UPDATE cash_control SET cash_syp=50000,updated_at='2026-02-28T23:00:00.000Z' WHERE id=1").run();
  const performanceReport = {
    journalHistory: await measure(() => readGeneralJournal(api, { limit: 2000 })),
    accountLedger: await measure(() => buildAccountLedger(api, cashId)),
    trialBalance: await measure(() => buildTrialBalance(api)),
    profitLoss: await measure(() => buildProfitAndLoss(api)),
    sourceLookup: await measure(() => api.getFirstAsync("SELECT id FROM journal_entries WHERE source_type='sale' AND source_id=?", 25_000)),
    healthAudit: await measure(() => auditAccountingHealth(api)),
    reconciliation: await measure(() => buildAccountingReconciliation(api)),
  };
  const health = await auditAccountingHealth(api);
  assert.equal(health.ok, true, health.issues.join(','));
  assert.equal(health.journalEntries, 50_000);
  assert.equal(health.journalLines, 100_000);
  assert.equal((await buildTrialBalance(api)).balanced, true);
  assert.equal((await buildProfitAndLoss(api)).netProfitSyp, 50_000);
  const plans = {
    journal: db.prepare(`EXPLAIN QUERY PLAN SELECT je.id,(SELECT SUM(jl.debit_syp) FROM journal_lines jl WHERE jl.journal_entry_id=je.id) debit FROM journal_entries je ORDER BY je.occurred_at DESC,je.id DESC LIMIT 2000`).all().map(row => row.detail),
    ledger: db.prepare(`EXPLAIN QUERY PLAN SELECT jl.id FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE jl.account_id=? ORDER BY je.occurred_at,je.id,jl.id`).all(cashId).map(row => row.detail),
    source: db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM journal_entries WHERE source_type='sale' AND source_id=?`).all(25_000).map(row => row.detail),
  };
  assert.ok(plans.source.some(detail => detail.includes('idx_journal_entries_source')));
  assert.ok(plans.ledger.some(detail => detail.includes('idx_journal_lines_account_entry')));
  assert.ok(plans.journal.some(detail => detail.includes('idx_journal_entries_occurred')));
  console.log(`PHASE20_PERFORMANCE=${JSON.stringify(performanceReport)}`);
  console.log(`PHASE20_QUERY_PLANS=${JSON.stringify(plans)}`);
  db.close();
});
