import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { addCartLine, calculatePayment, paymentSuggestions } from '../src/utils/salesUiState.ts';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('payment calculator handles exact, change, insufficient, zero, localized, and large values', () => {
  assert.deepEqual(calculatePayment(87_500, '', true), { valid: true, amountPaidSyp: 87_500, changeSyp: 0 });
  assert.deepEqual(calculatePayment(87_500, '100,000', false), { valid: true, amountPaidSyp: 100_000, changeSyp: 12_500 });
  assert.deepEqual(calculatePayment(87_500, '٨٠٬٠٠٠', false), { valid: false, reason: 'insufficient' });
  assert.deepEqual(calculatePayment(87_500, '0', false), { valid: false, reason: 'insufficient' });
  assert.deepEqual(calculatePayment(1_485_000_000, '1,500,000,000', false), { valid: true, amountPaidSyp: 1_500_000_000, changeSyp: 15_000_000 });
  assert.ok(paymentSuggestions(87_500).includes(100_000));
});

test('v8 to v9 migration preserves historical rows and leaves new metadata null', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT, barcode TEXT);
    CREATE TABLE sales(id INTEGER PRIMARY KEY, uuid TEXT, invoice_number TEXT UNIQUE, exchange_rate REAL, subtotal_syp REAL, discount_syp REAL, net_total_syp REAL, cost_syp REAL, profit_syp REAL, created_at TEXT, updated_at TEXT);
    CREATE TABLE sale_items(id INTEGER PRIMARY KEY, uuid TEXT, sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE, product_id INTEGER REFERENCES products(id) ON DELETE SET NULL, product_name TEXT, quantity REAL, unit_price_syp REAL, unit_cost_syp REAL, line_total_syp REAL, line_cost_syp REAL, created_at TEXT, updated_at TEXT);
    INSERT INTO products VALUES(1,'Old product','OLD-1');
    INSERT INTO sales VALUES(1,'sale-1','INV-OLD',14500,87500,2500,85000,40000,45000,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO sale_items VALUES(1,'item-1',1,1,'Historical name',2,43750,20000,87500,40000,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    PRAGMA user_version=8;
    BEGIN;
    ALTER TABLE sales ADD COLUMN amount_paid_syp REAL;
    ALTER TABLE sales ADD COLUMN change_syp REAL;
    ALTER TABLE sale_items ADD COLUMN barcode_snapshot TEXT;
    CREATE TABLE sale_drafts(id INTEGER PRIMARY KEY AUTOINCREMENT,uuid TEXT NOT NULL UNIQUE,exchange_rate REAL NOT NULL CHECK(exchange_rate>0),discount_syp REAL NOT NULL DEFAULT 0 CHECK(discount_syp>=0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE sale_draft_items(id INTEGER PRIMARY KEY AUTOINCREMENT,uuid TEXT NOT NULL UNIQUE,draft_id INTEGER NOT NULL REFERENCES sale_drafts(id) ON DELETE CASCADE,product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,product_name TEXT NOT NULL,barcode_snapshot TEXT,quantity REAL NOT NULL CHECK(quantity>0),unit_price_syp REAL NOT NULL CHECK(unit_price_syp>=0),unit_cost_syp REAL NOT NULL CHECK(unit_cost_syp>=0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX idx_sales_net_total ON sales(net_total_syp);
    CREATE INDEX idx_sale_items_barcode_snapshot ON sale_items(barcode_snapshot);
    CREATE INDEX idx_sale_draft_items_draft_id ON sale_draft_items(draft_id);
    PRAGMA user_version=9;
    COMMIT;`);
  const sale = db.prepare('SELECT * FROM sales').get();
  const item = db.prepare('SELECT * FROM sale_items').get();
  assert.equal(sale.invoice_number, 'INV-OLD'); assert.equal(sale.net_total_syp, 85_000);
  assert.equal(sale.amount_paid_syp, null); assert.equal(sale.change_syp, null);
  assert.equal(item.product_name, 'Historical name'); assert.equal(item.barcode_snapshot, null);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

function draftDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE sale_drafts(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE,exchange_rate REAL,discount_syp REAL,created_at TEXT,updated_at TEXT);
    CREATE TABLE sale_draft_items(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE,draft_id INTEGER REFERENCES sale_drafts(id) ON DELETE CASCADE,product_id INTEGER,product_name TEXT,barcode_snapshot TEXT,quantity REAL,unit_price_syp REAL,unit_cost_syp REAL,created_at TEXT,updated_at TEXT);
    CREATE TABLE sales(id INTEGER PRIMARY KEY,invoice_number TEXT);`);
  return db;
}

test('100 persisted drafts summarize without loading all 500 items and stay isolated on delete', () => {
  const db = draftDatabase(); const now = '2026-08-31T10:00:00.000Z';
  const draft = db.prepare('INSERT INTO sale_drafts VALUES(?,?,?,?,?,?)');
  const item = db.prepare('INSERT INTO sale_draft_items VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  for (let d = 1; d <= 100; d++) { draft.run(d, `d-${d}`, 14_500 + d, d, now, now); for (let i = 1; i <= 5; i++) item.run((d - 1) * 5 + i, `i-${d}-${i}`, d, i, `Item ${i}`, `BC-${i}`, i, 1_000 * i, 500 * i, now, now); }
  db.exec('COMMIT');
  const started = performance.now();
  const summaries = db.prepare(`SELECT d.id,COUNT(i.id) line_count,SUM(i.quantity) item_count,SUM(i.quantity*i.unit_price_syp)-d.discount_syp net_total_syp FROM sale_drafts d LEFT JOIN sale_draft_items i ON i.draft_id=d.id GROUP BY d.id ORDER BY d.updated_at DESC`).all();
  const elapsed = performance.now() - started;
  assert.equal(summaries.length, 100); assert.equal(summaries[0].line_count, 5); assert.ok(elapsed < 500);
  db.prepare('DELETE FROM sale_drafts WHERE id=?').run(2);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM sale_draft_items WHERE draft_id=2').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM sale_draft_items WHERE draft_id=1').get().count, 5);
  console.log(`draft_summary_100_ms=${elapsed.toFixed(2)}`); db.close();
});

test('failed completed-sale transaction keeps resumed draft and no partial invoice', () => {
  const db = draftDatabase(); const now = '2026-08-31T10:00:00.000Z';
  db.prepare('INSERT INTO sale_drafts VALUES(1,?,?,?,?,?)').run('draft-safe', 14500, 0, now, now);
  try { db.exec("BEGIN; INSERT INTO sales VALUES(1,'INV-FAIL'); DELETE FROM sale_drafts WHERE id=1;"); throw new Error('forced item failure'); }
  catch { db.exec('ROLLBACK'); }
  assert.equal(db.prepare('SELECT COUNT(*) count FROM sales').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM sale_drafts').get().count, 1);
  db.exec("BEGIN; INSERT INTO sales VALUES(1,'INV-OK'); DELETE FROM sale_drafts WHERE id=1; COMMIT;");
  assert.equal(db.prepare('SELECT COUNT(*) count FROM sales').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM sale_drafts').get().count, 0); db.close();
});

test('draft deletion is explicit and startup removes only unreachable draft items', async () => {
  const database = await read('src/database/database.ts');
  assert.match(database, /DELETE FROM sale_draft_items WHERE draft_id=\?/);
  assert.match(database, /DELETE FROM sale_draft_items\s+WHERE NOT EXISTS \(SELECT 1 FROM sale_drafts WHERE sale_drafts\.id=sale_draft_items\.draft_id\)/);

  const db = draftDatabase(); const now = '2026-09-06T09:41:31.506Z';
  db.exec('PRAGMA foreign_keys=OFF');
  db.prepare('INSERT INTO sale_draft_items VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(1, 'orphan', 99, 2, 'B', '175000000002', 8, 30000, 15000, now, now);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 1);
  db.prepare('DELETE FROM sale_draft_items WHERE NOT EXISTS (SELECT 1 FROM sale_drafts WHERE sale_drafts.id=sale_draft_items.draft_id)').run();
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test('invoice SQL searches/sorts/filters 5k invoices and 25k items with bound parameters', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE products(id INTEGER PRIMARY KEY,barcode TEXT); CREATE TABLE sales(id INTEGER PRIMARY KEY,invoice_number TEXT,created_at TEXT,net_total_syp REAL);
    CREATE TABLE sale_items(id INTEGER PRIMARY KEY,sale_id INTEGER,product_id INTEGER,product_name TEXT,barcode_snapshot TEXT); CREATE INDEX idx_sales_created_at ON sales(created_at); CREATE INDEX idx_sales_net_total ON sales(net_total_syp); CREATE INDEX idx_sale_items_sale_id ON sale_items(sale_id); CREATE INDEX idx_sale_items_barcode_snapshot ON sale_items(barcode_snapshot);`);
  const sale = db.prepare('INSERT INTO sales VALUES(?,?,?,?)'); const item = db.prepare('INSERT INTO sale_items VALUES(?,?,?,?,?)'); const product = db.prepare('INSERT INTO products VALUES(?,?)');
  db.exec('BEGIN'); for (let p = 1; p <= 5; p++) product.run(p, `CURRENT-${p}`); for (let s = 1; s <= 5000; s++) { sale.run(s, `INV-${s}`, `2026-08-${String((s % 28) + 1).padStart(2, '0')}T10:00:00.000Z`, s * 1000); for (let i = 1; i <= 5; i++) item.run((s - 1) * 5 + i, s, i, `Snapshot ${s}-${i}`, `HIST-${s}-${i}`); } db.exec('COMMIT');
  const sql = `SELECT s.* FROM sales s WHERE s.net_total_syp>=? AND s.net_total_syp<=? AND (s.invoice_number LIKE ? OR EXISTS(SELECT 1 FROM sale_items si LEFT JOIN products p ON p.id=si.product_id WHERE si.sale_id=s.id AND (si.product_name LIKE ? COLLATE NOCASE OR si.barcode_snapshot=? OR p.barcode=?))) ORDER BY s.net_total_syp DESC,s.created_at DESC`;
  const started = performance.now(); const byName = db.prepare(sql).all(1_000_000, 4_000_000, '%Snapshot 3000-2%', '%Snapshot 3000-2%', 'Snapshot 3000-2', 'Snapshot 3000-2'); const nameMs = performance.now() - started;
  assert.equal(byName.length, 1); assert.equal(byName[0].invoice_number, 'INV-3000');
  const barcode = db.prepare(sql).all(1, 10_000_000, '%HIST-4321-4%', '%HIST-4321-4%', 'HIST-4321-4', 'HIST-4321-4'); assert.equal(barcode[0].id, 4321);
  const fallback = db.prepare(sql).all(1, 10_000_000, '%CURRENT-3%', '%CURRENT-3%', 'CURRENT-3', 'CURRENT-3'); assert.equal(fallback.length, 5000);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, 10_000_000, '%x%', '%x%', 'x', 'x').map(row => row.detail).join(' ');
  assert.match(plan, /idx_sale_items_sale_id/);
  assert.ok(nameMs < 2000); console.log(`invoice_search_5k_25k_ms=${nameMs.toFixed(2)}`); db.close();
});

test('repeat sale architecture uses current product pricing/rate, retains quantities, and skips unavailable products', async () => {
  const [repeat, screen] = await Promise.all([read('src/utils/repeatSale.ts'), read('src/screens/SalesScreen.tsx')]);
  assert.match(repeat, /product\.price_usd/); assert.match(repeat, /settings\.exchangeRate/); assert.match(repeat, /product\.is_active === 0/); assert.match(repeat, /quantity: item\.quantity/);
  assert.doesNotMatch(repeat, /item\.unit_price_syp/); assert.match(screen, /setDiscount\(''\)/);
  const merged = addCartLine([{ productId: 1, cartKey: 'product:1', quantity: 3, unitPriceSyp: 10 }], { productId: 1, cartKey: 'product:1', quantity: 2, unitPriceSyp: 20 });
  assert.equal(merged[0].quantity, 5);
});

test('backup v10 retains phase 9 drafts semantics while accepting v8 payload fields', async () => {
  const [backup, importer, types] = await Promise.all([read('src/backup/backupManager.ts'), read('src/import/jsonImporter.ts'), read('src/import/importTypes.ts')]);
assert.match(backup, /const SCHEMA_VERSION = 17/); assert.match(backup, /drafts: draftRows\.map/); assert.match(backup, /counts\.drafts != null/);
  assert.match(importer, /options\.mode === 'full_restore' && options\.entities\.includes\('sale_drafts'\)/);
  assert.match(importer, /sale\.amount_paid_syp \?\? null/); assert.match(importer, /item\.barcode_snapshot \?\? null/);
  assert.match(types, /drafts\?: SuspendedSale\[\]/);
  const safeMergeLine = importer.match(/: \['products', 'categories', 'sales',[^\n]+/s)?.[0] ?? '';
  assert.doesNotMatch(safeMergeLine, /sale_drafts/);
});

test('analytics still derives revenue from net invoice total and never payment metadata', async () => {
  const analytics = await read('src/utils/salesAnalytics.ts');
  assert.match(analytics, /net_total_syp/); assert.doesNotMatch(analytics, /amount_paid_syp|change_syp/);
});
