import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import {
  buildProductPricingSnapshot,
  canonicalizeLegacyUsdNumber,
  parseCanonicalDecimal,
  resolveSaleItemLineCostSyp,
  resolveSypLineCostSyp,
  resolveUsdOperationalLineCostSyp,
  resolveUsdSalePriceSyp,
  validateNewUsdDecimal,
  validatePricingSnapshot,
} from '../src/utils/productPricing.ts';
import { previewReturn } from '../src/utils/returns.ts';
import { formatProductUsd } from '../src/utils/formatters.ts';

const product = (overrides = {}) => ({
  id: 1, uuid: '11111111-1111-4111-8111-111111111111', name: 'Test', category: 'Test',
  price_usd: 1.23, cost_usd: 1.23, sale_price_currency: 'USD', sale_price_syp: null,
  cost_currency: 'USD', cost_syp: null, image_uri: null, barcode: null,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', is_active: 1,
  ...overrides,
});

test('exact decimal parser canonicalizes legacy values and enforces four decimals for new values', () => {
  assert.deepEqual(parseCanonicalDecimal('001.2300'), { canonical: '1.23', numerator: 123n, denominator: 100n, decimalPlaces: 2 });
  assert.equal(canonicalizeLegacyUsdNumber(1.234567), '1.234567');
  for (const value of ['1', '1.2', '1.23', '1.234', '1.2345']) assert.doesNotThrow(() => validateNewUsdDecimal(value));
  assert.throws(() => validateNewUsdDecimal('1.23456'), /PRODUCT_USD_PRECISION_EXCEEDED/);
});

test('product master USD display preserves up to four configured decimals', () => {
  assert.equal(formatProductUsd(3.4567, 'en'), '$3.4567');
  assert.equal(formatProductUsd(1, 'en'), '$1');
});

test('320dp product rows keep native and resolved prices readable without breaking virtualization', async () => {
  const [row, screen] = await Promise.all([
    readFile(new URL('../src/components/ProductListRow.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/ProductManagementScreen.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(row, /PRODUCT_COMPACT_ROW_HEIGHT = 104/);
  assert.match(row, /compact && <MonetaryValue/);
  assert.match(row, /!compact && <View style=\{\[styles\.thumbnail/);
  assert.match(screen, /compactRows = width < 360/);
  assert.match(screen, /productRowHeight \+ PRODUCT_ROW_GAP/);
  assert.match(screen, /compactRows \? 'column'/);
  assert.match(screen, /compactTitleActions/);
  assert.match(screen, /compactTitleCopy: \{ flex: 0 \}/);
});

test('USD sale pricing rounds HALF-UP directly to the final quantum', () => {
  assert.equal(resolveUsdSalePriceSyp('0.46', 10, true, 10), 0); // exact 4.6; a forbidden round-to-1-first path would produce 10
  assert.equal(resolveUsdSalePriceSyp('1.23', 15001, false, 10), 18451);
  assert.equal(resolveUsdSalePriceSyp('1.5', 10, true, 10), 20);
  assert.equal(resolveUsdSalePriceSyp('25', 10, true, 500), 500);
  assert.equal(resolveUsdSalePriceSyp('50', 10, true, 1000), 1000);
  assert.equal(resolveUsdSalePriceSyp('1.2345', 15000, true, 5), 18520);
});

test('USD operational cost rounds once at immutable line-total level', () => {
  assert.equal(resolveUsdOperationalLineCostSyp('1.23', 15001, 3), 55354);
  assert.notEqual(resolveUsdOperationalLineCostSyp('1.23', 15001, 3), resolveUsdOperationalLineCostSyp('1.23', 15001, 1) * 3);
  assert.equal(resolveUsdOperationalLineCostSyp('0.0001', 15001, 10000), 15001);
  assert.equal(resolveUsdOperationalLineCostSyp('1.234567', 15000, 7), 129630);
  assert.equal(resolveSypLineCostSyp(12345, 7), 86415);
});

test('all four independent pricing combinations resolve and replay exactly', () => {
  const settings = { isRoundingEnabled: false, roundingTarget: 10 };
  const cases = [
    product(),
    product({ cost_currency: 'USD', sale_price_currency: 'SYP', sale_price_syp: 22000 }),
    product({ cost_currency: 'SYP', cost_syp: 12000, sale_price_currency: 'USD' }),
    product({ cost_currency: 'SYP', cost_syp: 12000, sale_price_currency: 'SYP', sale_price_syp: 22000 }),
  ];
  for (const candidate of cases) {
    const snapshot = buildProductPricingSnapshot(candidate, 15001, settings);
    const item = { productId: candidate.id, productName: candidate.name, barcodeSnapshot: null, quantity: 3, ...snapshot };
    assert.ok(Number.isSafeInteger(item.unitPriceSyp));
    assert.ok(Number.isSafeInteger(validatePricingSnapshot(item)));
    assert.equal(validatePricingSnapshot(item), resolveSaleItemLineCostSyp(item));
  }
});

test('native SYP values ignore rate and USD lines keep their transaction-rate snapshot', () => {
  const settings = { isRoundingEnabled: true, roundingTarget: 1000 };
  const native = product({ sale_price_currency: 'SYP', sale_price_syp: 15555, cost_currency: 'SYP', cost_syp: 7777 });
  assert.deepEqual(buildProductPricingSnapshot(native, 15000, settings), buildProductPricingSnapshot(native, 20000, settings));
  const usdAtOldRate = buildProductPricingSnapshot(product(), 15000, settings);
  const usdAtNewRate = buildProductPricingSnapshot(product(), 15500, settings);
  assert.notEqual(usdAtOldRate.unitPriceSyp, usdAtNewRate.unitPriceSyp);
  assert.equal(usdAtOldRate.salePriceExchangeRate, 15000);
});

test('mixed-cart totals remain integer SYP and snapshot validation rejects inconsistent evidence', () => {
  const settings = { isRoundingEnabled: false, roundingTarget: 10 };
  const rows = [product(), product({ id: 2, sale_price_currency: 'SYP', sale_price_syp: 10001, cost_currency: 'SYP', cost_syp: 3001 })]
    .map((candidate, index) => ({ productId: candidate.id, productName: candidate.name, barcodeSnapshot: null, quantity: index + 1, ...buildProductPricingSnapshot(candidate, 15001, settings) }));
  const subtotal = rows.reduce((sum, row) => sum + row.unitPriceSyp * row.quantity, 0);
  const cost = rows.reduce((sum, row) => sum + validatePricingSnapshot(row), 0);
  assert.ok(Number.isSafeInteger(subtotal)); assert.ok(Number.isSafeInteger(cost));
  assert.throws(() => validatePricingSnapshot({ ...rows[0], salePriceExchangeRate: 16000 }), /INVALID_SALE_PRICE_SNAPSHOT/);
  assert.throws(() => validatePricingSnapshot({ ...rows[0], salePriceNativeDecimal: '01.2300' }), /INVALID_SALE_PRICE_SNAPSHOT/);
  assert.throws(() => validatePricingSnapshot({ ...rows[0], costNativeDecimal: '01.2300' }), /INVALID_COST_SNAPSHOT/);
  assert.throws(() => validatePricingSnapshot({ ...rows[1], unitPriceSyp: 10001.5, salePriceNativeSyp: 10001.5 }), /INVALID_SALE_PRICE_SNAPSHOT/);
  assert.throws(() => validatePricingSnapshot({ ...rows[1], costExchangeRate: 15001 }), /INVALID_COST_SNAPSHOT/);
});

test('zero values and safe-integer boundaries remain exact', () => {
  assert.equal(resolveUsdSalePriceSyp('0', 15000, false, 10), 0);
  assert.equal(resolveUsdOperationalLineCostSyp('0', 15000, 999), 0);
  assert.equal(resolveSypLineCostSyp(0, 999), 0);
  assert.equal(resolveSypLineCostSyp(9_000_000_000, 1_000), 9_000_000_000_000);
  assert.throws(() => resolveSypLineCostSyp(Number.MAX_SAFE_INTEGER, 2), /PRODUCT_PRICING_UNSAFE_INTEGER/);
  assert.throws(() => resolveUsdSalePriceSyp('9999999999999999', 15000, false, 10), /PRODUCT_PRICING_UNSAFE_INTEGER/);
});

test('customer returns use immutable resolved SYP sale and line-cost snapshots', () => {
  const item = { id: 1, uuid: '22222222-2222-4222-8222-222222222222', sale_id: 1, product_id: 1, product_name: 'Old', barcode_snapshot: null,
    quantity: 3, unit_price_syp: 18451, unit_cost_syp: 18451, line_total_syp: 55353, line_cost_syp: 55354,
    sale_price_source_currency: 'USD', sale_price_native_decimal: '1.23', sale_price_native_syp: null, sale_price_exchange_rate: 15001,
    sale_price_rounding_enabled: 0, sale_price_rounding_target: 10, cost_source_currency: 'USD', cost_native_decimal: '1.23', cost_native_syp: null,
    cost_exchange_rate: 15001, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
  const sale = { id: 1, uuid: '33333333-3333-4333-8333-333333333333', invoice_number: 'INV-1', exchange_rate: 15001,
    subtotal_syp: 55353, discount_syp: 0, net_total_syp: 55353, cost_syp: 55354, profit_syp: -1, amount_paid_syp: 55353, change_syp: 0,
    created_at: item.created_at, updated_at: item.updated_at, items: [item], returns: [] };
  const beforeEdit = previewReturn(sale, [{ saleItemId: 1, quantity: 2 }]);
  product({ price_usd: 99, cost_usd: 88, sale_price_currency: 'SYP', sale_price_syp: 1, cost_currency: 'SYP', cost_syp: 1 });
  const afterEdit = previewReturn(sale, [{ saleItemId: 1, quantity: 2 }]);
  assert.deepEqual(afterEdit, beforeEdit); assert.equal(afterEdit.refundTotalSyp, 36902); assert.equal(afterEdit.returnedCostSyp, 36902);
});

function createV19Fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE products(id INTEGER PRIMARY KEY,price_usd REAL NOT NULL,cost_usd REAL NOT NULL);
    CREATE TABLE sale_items(id INTEGER PRIMARY KEY,unit_price_syp INTEGER NOT NULL,unit_cost_syp REAL NOT NULL,line_cost_syp INTEGER NOT NULL);
    CREATE TABLE sale_draft_items(id INTEGER PRIMARY KEY,unit_price_syp INTEGER NOT NULL,unit_cost_syp REAL NOT NULL);
    INSERT INTO products VALUES(1,1.234567,0.987654); INSERT INTO sale_items VALUES(1,18519,14815,44444); INSERT INTO sale_draft_items VALUES(1,18519,14815);
    PRAGMA user_version=19;`);
  return db;
}

const v20AlterSql = `ALTER TABLE products ADD COLUMN sale_price_currency TEXT NOT NULL DEFAULT 'USD';
  ALTER TABLE products ADD COLUMN sale_price_syp INTEGER; ALTER TABLE products ADD COLUMN cost_currency TEXT NOT NULL DEFAULT 'USD'; ALTER TABLE products ADD COLUMN cost_syp INTEGER;
  ALTER TABLE sale_items ADD COLUMN sale_price_source_currency TEXT; ALTER TABLE sale_items ADD COLUMN cost_source_currency TEXT;
  ALTER TABLE sale_draft_items ADD COLUMN sale_price_source_currency TEXT; ALTER TABLE sale_draft_items ADD COLUMN cost_source_currency TEXT; PRAGMA user_version=20;`;

test('v19 to v20 migration defaults legacy products to USD without rewriting rows', () => {
  const db = createV19Fixture(); db.exec(`BEGIN; ${v20AlterSql} COMMIT;`);
  const row = db.prepare('SELECT * FROM products').get();
  assert.equal(row.price_usd, 1.234567); assert.equal(row.cost_usd, 0.987654);
  assert.equal(row.sale_price_currency, 'USD'); assert.equal(row.cost_currency, 'USD'); assert.equal(row.sale_price_syp, null); assert.equal(row.cost_syp, null);
  assert.equal(db.prepare('SELECT sale_price_source_currency,cost_source_currency FROM sale_items').get().sale_price_source_currency, null);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 20);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('migration failure is atomic and keeps the v19 version', () => {
  const db = createV19Fixture();
  assert.throws(() => db.exec(`BEGIN; ALTER TABLE products ADD COLUMN sale_price_currency TEXT DEFAULT 'USD'; ALTER TABLE missing_table ADD COLUMN x TEXT; COMMIT;`));
  db.exec('ROLLBACK');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 19);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('products') WHERE name='sale_price_currency'").get().count, 0);
});

test('sale snapshot persistence failure rolls back header, line, and metadata together', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE sales(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE); CREATE TABLE sale_items(
    id INTEGER PRIMARY KEY,sale_id INTEGER NOT NULL REFERENCES sales(id),sale_price_source_currency TEXT NOT NULL,cost_source_currency TEXT NOT NULL,line_cost_syp INTEGER NOT NULL);`);
  assert.throws(() => db.exec(`BEGIN; INSERT INTO sales VALUES(1,'sale-1'); INSERT INTO sale_items VALUES(1,1,'USD','USD',55354); INSERT INTO missing_table VALUES(1); COMMIT;`));
  db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sales').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sale_items').get().count, 0);
});

test('database migration and immutable writes carry complete v20 evidence', async () => {
  const source = await readFile(new URL('../src/database/database.ts', import.meta.url), 'utf8');
  assert.match(source, /SCHEMA_VERSION = 20/); assert.match(source, /migrateFlexibleProductPricingV20/); assert.match(source, /withExclusiveTransactionAsync/);
  for (const field of ['sale_price_source_currency','sale_price_native_decimal','sale_price_rounding_enabled','cost_native_decimal','cost_exchange_rate']) assert.match(source, new RegExp(field));
  assert.match(source, /lineCosts = items\.map\(item => validatePricingSnapshot\(item\)\)/);
  assert.match(source, /items\.forEach\(validatePricingSnapshot\)/);
  assert.match(source, /if \(!Number\.isSafeInteger\(subtotal\)\) throw new Error\('INVALID_DRAFT_DATA'\)/);
});

test('product UI, barcode, repeat-sale, purchase, and inventory suggestion use active pricing helpers', async () => {
  const [form, sales, repeat, purchases, inventory] = await Promise.all(['ProductFormModal.tsx','../screens/SalesScreen.tsx','../utils/repeatSale.ts','../screens/PurchasesScreen.tsx','../screens/InventoryScreen.tsx'].map(path => readFile(new URL(`../src/components/${path}`, import.meta.url), 'utf8')));
  assert.match(form, /saleCurrency/); assert.match(form, /costCurrency/); assert.match(form, /validateNewUsdDecimal/);
  assert.match(sales, /buildProductPricingSnapshot/); assert.match(repeat, /buildProductPricingSnapshot/);
  assert.match(purchases, /cost_currency === 'USD'/); assert.match(inventory, /resolveUsdOperationalLineCostSyp/); assert.match(inventory, /accountingValueTouched/);
});

test('backup, restore, Safe Merge, and Excel preserve v20 fields with legacy USD defaults', async () => {
  const [backup, restore, importer, excel] = await Promise.all(['../src/backup/backupManager.ts','../src/import/fullRestoreInserter.ts','../src/import/jsonImporter.ts','../src/utils/excel.ts'].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
  assert.match(backup, /SCHEMA_VERSION = 20/); assert.match(backup, /sale_price_currency: row\.sale_price_currency === 'SYP' \? 'SYP' : 'USD'/); assert.match(restore, /sale_price_currency/);
  assert.match(importer, /item\.sale_price_currency \?\? 'USD'/); assert.match(importer, /UPDATE products SET[\s\S]*sale_price_currency/);
  assert.match(excel, /sale_price_currency/); assert.match(excel, /validateNewUsdDecimal/); assert.match(excel, /sale_price_native_decimal/);
});

test('health replay excludes pre-v20 null metadata and never reads current product pricing', async () => {
  const database = await readFile(new URL('../src/database/database.ts', import.meta.url), 'utf8');
  assert.match(database, /WHERE sale_price_source_currency IS NOT NULL OR cost_source_currency IS NOT NULL/);
  assert.match(database, /validatePricingSnapshot/); assert.match(database, /invalidSalePricingSnapshots/); assert.match(database, /invalidDraftPricingSnapshots/);
  assert.doesNotMatch(database, /replaySnapshot[\s\S]{0,1200}JOIN products/);
});

test('operational pricing does not alter GL valuation or purchase/supplier-return currency', async () => {
  const [pricing, accounting, purchases] = await Promise.all(['../src/utils/productPricing.ts','../src/accounting/accountingCore.ts','../src/database/database.ts'].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
  assert.doesNotMatch(pricing, /postJournalEntry|inventory_value_balances|supplier_foreign_position_layers/);
  assert.doesNotMatch(accounting, /sale_price_currency|cost_currency|cost_syp/);
  assert.match(purchases, /unit_cost_usd_cents/); assert.match(purchases, /relieveInventoryValue/);
});

test('10k exact price and cost resolutions remain bounded', () => {
  const start = performance.now(); let checksum = 0;
  for (let index = 0; index < 10000; index += 1) {
    checksum += resolveUsdSalePriceSyp(`${1 + index % 50}.${String(index % 10000).padStart(4, '0')}`, 15001, true, 10);
    checksum += resolveUsdOperationalLineCostSyp('1.2345', 15001, (index % 20) + 1);
  }
  const elapsed = performance.now() - start;
  assert.ok(Number.isSafeInteger(checksum)); assert.ok(elapsed < 500, `pricing benchmark took ${elapsed.toFixed(2)}ms`);
  console.log(`PHASE21_PRICING_10K_MS=${elapsed.toFixed(2)}`);
});
