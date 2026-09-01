import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';

const RUNS = 7;
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
};
const timed = fn => { const start = performance.now(); const value = fn(); return { value, ms: performance.now() - start }; };
const repeat = fn => { fn(); fn(); return stats(Array.from({ length: RUNS }, () => timed(fn).ms)); };
const round = value => Number(value.toFixed(2));
const printable = value => Object.fromEntries(Object.entries(value).map(([key, number]) => [key, round(number)]));

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF;
    CREATE TABLE products(id INTEGER PRIMARY KEY,barcode TEXT);
    CREATE INDEX idx_products_barcode ON products(barcode);
    CREATE TABLE sales(id INTEGER PRIMARY KEY,uuid TEXT,invoice_number TEXT UNIQUE,exchange_rate REAL,subtotal_syp INTEGER,discount_syp INTEGER,net_total_syp INTEGER,cost_syp INTEGER,profit_syp INTEGER,amount_paid_syp INTEGER,change_syp INTEGER,created_at TEXT,updated_at TEXT);
    CREATE INDEX idx_sales_created_at ON sales(created_at);
    CREATE INDEX idx_sales_net_total ON sales(net_total_syp);
    CREATE TABLE sale_items(id INTEGER PRIMARY KEY,uuid TEXT,sale_id INTEGER REFERENCES sales(id),product_id INTEGER REFERENCES products(id),product_name TEXT,barcode_snapshot TEXT,quantity INTEGER,unit_price_syp INTEGER,unit_cost_syp INTEGER,line_total_syp INTEGER,line_cost_syp INTEGER,created_at TEXT,updated_at TEXT);
    CREATE INDEX idx_sale_items_sale_id ON sale_items(sale_id);
    CREATE INDEX idx_sale_items_barcode_snapshot ON sale_items(barcode_snapshot);
    CREATE TABLE sale_returns(id INTEGER PRIMARY KEY,uuid TEXT,sale_id INTEGER REFERENCES sales(id),refund_total_syp INTEGER,returned_cost_syp INTEGER,created_at TEXT,updated_at TEXT);
    CREATE INDEX idx_sale_returns_sale_id ON sale_returns(sale_id);
    CREATE INDEX idx_sale_returns_created_at ON sale_returns(created_at);
    CREATE TABLE sale_return_items(id INTEGER PRIMARY KEY,uuid TEXT,return_id INTEGER REFERENCES sale_returns(id),sale_item_id INTEGER REFERENCES sale_items(id),quantity INTEGER,refund_amount_syp INTEGER,cost_reversal_syp INTEGER,created_at TEXT,updated_at TEXT);
    CREATE INDEX idx_sale_return_items_return_id ON sale_return_items(return_id);
    CREATE INDEX idx_sale_return_items_sale_item_id ON sale_return_items(sale_item_id);`);
  const product = db.prepare('INSERT INTO products VALUES(?,?)');
  const sale = db.prepare('INSERT INTO sales VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const item = db.prepare('INSERT INTO sale_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const record = db.prepare('INSERT INTO sale_returns VALUES(?,?,?,?,?,?,?)');
  const returnedItem = db.prepare('INSERT INTO sale_return_items VALUES(?,?,?,?,?,?,?,?,?)');
  const now = new Date(); now.setMinutes(0, 0, 0);
  db.exec('BEGIN');
  for (let id = 1; id <= 100; id++) product.run(id, `CUR-${id}`);
  for (let saleId = 1; saleId <= 5_000; saleId++) {
    const date = new Date(now); date.setDate(date.getDate() - ((saleId - 1) % 30)); const iso = date.toISOString();
    sale.run(saleId, `sale-${saleId}`, `INV-${String(saleId).padStart(6, '0')}`, 15_000, 50_000, 0, 50_000 + saleId, 30_000, 20_000 + saleId, 60_000, 10_000 - saleId, iso, iso);
    for (let line = 1; line <= 5; line++) {
      const itemId = (saleId - 1) * 5 + line;
      item.run(itemId, `item-${itemId}`, saleId, ((saleId + line) % 100) + 1, `Product ${line}`, `BC-${saleId}-${line}`, 2, 5_000, 3_000, 10_000, 6_000, iso, iso);
    }
  }
  for (let returnId = 1; returnId <= 1_000; returnId++) {
    const iso = new Date(now.getTime() - (returnId % 7) * 86_400_000).toISOString();
    record.run(returnId, `return-${returnId}`, returnId, 15_000, 9_000, iso, iso);
    for (let line = 1; line <= 3; line++) {
      const returnItemId = (returnId - 1) * 3 + line;
      returnedItem.run(returnItemId, `return-item-${returnItemId}`, returnId, (returnId - 1) * 5 + line, 1, 5_000, 3_000, iso, iso);
    }
  }
  db.exec('COMMIT');
  return { db, now };
}

const orderSql = { newest: 's.created_at DESC', oldest: 's.created_at ASC', highest: 's.net_total_syp DESC, s.created_at DESC', lowest: 's.net_total_syp ASC, s.created_at DESC' };
function salesSql(query, optimized) {
  const where = []; const params = []; const search = query.search ?? '';
  if (search) {
    const like = `%${search}%`;
    where.push(optimized ? `(s.invoice_number LIKE ? OR s.id IN (
      SELECT si.sale_id FROM sale_items si
      WHERE si.product_name LIKE ? COLLATE NOCASE OR si.barcode_snapshot=? OR si.product_id IN (SELECT p.id FROM products p WHERE p.barcode=?)
    ))` : `(s.invoice_number LIKE ? OR EXISTS (
      SELECT 1 FROM sale_items si LEFT JOIN products p ON p.id=si.product_id
      WHERE si.sale_id=s.id AND (si.product_name LIKE ? COLLATE NOCASE OR si.barcode_snapshot=? OR p.barcode=?)
    ))`);
    params.push(like, like, search, search);
  }
  if (query.start) { where.push('s.created_at >= ?'); params.push(query.start); }
  if (query.min != null) { where.push('s.net_total_syp >= ?'); params.push(query.min); }
  if (query.max != null) { where.push('s.net_total_syp <= ?'); params.push(query.max); }
  return { sql: `SELECT s.* FROM sales s${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderSql[query.sort ?? 'newest']}`, params };
}

function queryRows(db, query, optimized) { const built = salesSql(query, optimized); return db.prepare(built.sql).all(...built.params); }
function legacyHydrate(db, sales) {
  let queryCount = 1; const items = []; const returns = []; const returnItems = [];
  for (let offset = 0; offset < sales.length; offset += 800) {
    const ids = sales.slice(offset, offset + 800).map(row => row.id); const marks = ids.map(() => '?').join(',');
    queryCount += 1; items.push(...db.prepare(`SELECT * FROM sale_items WHERE sale_id IN (${marks}) ORDER BY id`).all(...ids));
    queryCount += 1; const headers = db.prepare(`SELECT * FROM sale_returns WHERE sale_id IN (${marks}) ORDER BY created_at DESC,id DESC`).all(...ids); returns.push(...headers);
    for (let returnOffset = 0; returnOffset < headers.length; returnOffset += 800) {
      const returnIds = headers.slice(returnOffset, returnOffset + 800).map(row => row.id); queryCount += 1;
      returnItems.push(...db.prepare(`SELECT ri.*,si.product_name,si.barcode_snapshot FROM sale_return_items ri JOIN sale_items si ON si.id=ri.sale_item_id WHERE ri.return_id IN (${returnIds.map(() => '?').join(',')}) ORDER BY ri.id`).all(...returnIds));
    }
  }
  return compose(sales, items, returns, returnItems, queryCount);
}
function optimizedHydrate(db, sales, allSelected = false) {
  if (!sales.length) return { rows: [], queryCount: 1, counts: { sales: 0, items: 0, returns: 0, returnItems: 0 } };
  const saleIds = JSON.stringify(sales.map(row => row.id));
  const items = allSelected ? db.prepare('SELECT * FROM sale_items').all() : db.prepare('SELECT * FROM sale_items WHERE sale_id IN (SELECT value FROM json_each(?))').all(saleIds);
  const returns = allSelected ? db.prepare('SELECT * FROM sale_returns').all() : db.prepare('SELECT * FROM sale_returns WHERE sale_id IN (SELECT value FROM json_each(?))').all(saleIds);
  const returnItems = returns.length ? (allSelected ? db.prepare('SELECT ri.*,si.product_name,si.barcode_snapshot FROM sale_return_items ri JOIN sale_items si ON si.id=ri.sale_item_id').all() : db.prepare(`SELECT ri.*,si.product_name,si.barcode_snapshot FROM sale_return_items ri JOIN sale_items si ON si.id=ri.sale_item_id WHERE ri.return_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(returns.map(row => row.id)))) : [];
  return compose(sales, items, returns, returnItems, returns.length ? 4 : 3);
}
function summaryHydrate(db, sales) {
  if (!sales.length) return { rows: [], queryCount: 1, counts: { sales: 0, itemSummaries: 0, returnSummaries: 0 }, mapEntries: 0 };
  const ids = JSON.stringify(sales.map(row => row.id));
  const itemSummaries = db.prepare(`SELECT sale_id,COUNT(*) line_count,SUM(quantity) sold_quantity
    FROM sale_items WHERE sale_id IN (SELECT value FROM json_each(?)) GROUP BY sale_id`).all(ids);
  const returnSummaries = db.prepare(`WITH headers AS (
      SELECT sale_id,SUM(refund_total_syp) refund_total_syp,SUM(returned_cost_syp) returned_cost_syp
      FROM sale_returns WHERE sale_id IN (SELECT value FROM json_each(?)) GROUP BY sale_id
    ), quantities AS (
      SELECT sr.sale_id,SUM(ri.quantity) returned_quantity FROM sale_returns sr
      JOIN sale_return_items ri ON ri.return_id=sr.id
      WHERE sr.sale_id IN (SELECT value FROM json_each(?)) GROUP BY sr.sale_id
    )
    SELECT h.sale_id,h.refund_total_syp,h.returned_cost_syp,COALESCE(q.returned_quantity,0) returned_quantity
    FROM headers h LEFT JOIN quantities q ON q.sale_id=h.sale_id`).all(ids, ids);
  return composeSummaries(sales, itemSummaries, returnSummaries);
}
function composeSummaries(sales, itemSummaries, returnSummaries) {
  const itemsBySale = new Map(itemSummaries.map(row => [row.sale_id, row]));
  const returnsBySale = new Map(returnSummaries.map(row => [row.sale_id, row]));
  return { rows: sales.map(header => { const item = itemsBySale.get(header.id); const record = returnsBySale.get(header.id); const sold = item?.sold_quantity ?? 0; const returned = record?.returned_quantity ?? 0; return { ...header, items: [], returns: [], item_count: sold, line_count: item?.line_count ?? 0, return_summary: { refund_total_syp: record?.refund_total_syp ?? 0, returned_cost_syp: record?.returned_cost_syp ?? 0, returned_quantity: returned, sold_quantity: sold, status: returned === 0 ? 'none' : returned === sold ? 'full' : 'partial' } }; }), queryCount: 3, counts: { sales: sales.length, itemSummaries: itemSummaries.length, returnSummaries: returnSummaries.length }, mapEntries: itemsBySale.size + returnsBySale.size };
}
function compose(sales, items, returns, returnItems, queryCount) {
  const itemsBySale = new Map(); const itemsByReturn = new Map(); const returnsBySale = new Map(); const returnedByItem = new Map();
  for (const row of items) (itemsBySale.get(row.sale_id) ?? itemsBySale.set(row.sale_id, []).get(row.sale_id)).push(row);
  for (const row of returnItems) { (itemsByReturn.get(row.return_id) ?? itemsByReturn.set(row.return_id, []).get(row.return_id)).push(row); returnedByItem.set(row.sale_item_id, (returnedByItem.get(row.sale_item_id) ?? 0) + row.quantity); }
  for (const header of returns) { const record = { ...header, items: itemsByReturn.get(header.id) ?? [] }; (returnsBySale.get(header.sale_id) ?? returnsBySale.set(header.sale_id, []).get(header.sale_id)).push(record); }
  for (const group of itemsBySale.values()) group.sort((a, b) => a.id - b.id);
  for (const group of itemsByReturn.values()) group.sort((a, b) => a.id - b.id);
  for (const group of returnsBySale.values()) group.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  const rows = sales.map(header => { const saleItems = itemsBySale.get(header.id) ?? []; const records = returnsBySale.get(header.id) ?? []; const sold = saleItems.reduce((sum, row) => sum + row.quantity, 0); const returned = saleItems.reduce((sum, row) => sum + (returnedByItem.get(row.id) ?? 0), 0); return { ...header, items: saleItems, returns: records, return_summary: { refund_total_syp: records.reduce((sum, row) => sum + row.refund_total_syp, 0), returned_cost_syp: records.reduce((sum, row) => sum + row.returned_cost_syp, 0), returned_quantity: returned, sold_quantity: sold, status: returned === 0 ? 'none' : returned === sold ? 'full' : 'partial' } }; });
  return { rows, queryCount, counts: { sales: sales.length, items: items.length, returns: returns.length, returnItems: returnItems.length }, mapEntries: itemsBySale.size + itemsByReturn.size + returnsBySale.size + returnedByItem.size };
}

function fullRequest(db, query, optimized) { const sales = queryRows(db, query, optimized); return optimized ? summaryHydrate(db, sales) : legacyHydrate(db, sales); }
function plan(db, query, optimized) { const built = salesSql(query, optimized); return db.prepare(`EXPLAIN QUERY PLAN ${built.sql}`).all(...built.params).map(row => row.detail); }

test('phase 10.5 invoice benchmark and correctness matrix', () => {
  const { db, now } = fixture();
  const startDay = new Date(now); startDay.setHours(0, 0, 0, 0);
  const startWeek = new Date(startDay); const day = startWeek.getDay(); startWeek.setDate(startWeek.getDate() - (day === 0 ? 6 : day - 1));
  const startMonth = new Date(startDay); startMonth.setDate(1);
  const matrix = {
    'No filter': {}, 'Invoice ID': { search: 'INV-004321' }, 'Product name': { search: 'Product 3' }, Barcode: { search: 'BC-4321-3' },
    Today: { start: startDay.toISOString() }, Week: { start: startWeek.toISOString() }, Month: { start: startMonth.toISOString() },
    'Min amount': { min: 53_000 }, 'Max amount': { max: 52_000 }, Newest: { sort: 'newest' }, Oldest: { sort: 'oldest' }, Highest: { sort: 'highest' }, Lowest: { sort: 'lowest' },
  };
  const report = {};
  for (const [name, query] of Object.entries(matrix)) {
    const before = repeat(() => fullRequest(db, query, false)); const after = repeat(() => fullRequest(db, query, true));
    const legacy = fullRequest(db, query, false); const optimized = fullRequest(db, query, true);
    assert.deepEqual(optimized.rows.map(row => row.id), legacy.rows.map(row => row.id), `${name} ids/order`);
    assert.equal(new Set(optimized.rows.map(row => row.id)).size, optimized.rows.length, `${name} duplicate invoices`);
    assert.deepEqual(optimized.rows.map(row => row.return_summary.status), legacy.rows.map(row => row.return_summary.status), `${name} statuses`);
    report[name] = { before: printable(before), after: printable(after), rows: optimized.rows.length, queriesBefore: legacy.queryCount, queriesAfter: optimized.queryCount };
  }
  const noFilter = fullRequest(db, {}, true); assert.equal(noFilter.counts.sales, 5_000); assert.equal(noFilter.counts.itemSummaries, 5_000); assert.equal(noFilter.counts.returnSummaries, 1_000); assert.equal(noFilter.rows.filter(row => row.return_summary.status === 'partial').length, 1_000); assert.equal(noFilter.rows.filter(row => row.return_summary.status === 'none').length, 4_000);
  assert.ok(report['No filter'].after.median < 200); assert.ok(report['Product name'].after.median < 250);
  const composeSales = queryRows(db, {}, true); const ids = JSON.stringify(composeSales.map(row => row.id)); const composeItemSummaries = db.prepare('SELECT sale_id,COUNT(*) line_count,SUM(quantity) sold_quantity FROM sale_items WHERE sale_id IN (SELECT value FROM json_each(?)) GROUP BY sale_id').all(ids); const composeReturnSummaries = db.prepare(`WITH h AS (SELECT sale_id,SUM(refund_total_syp) refund_total_syp,SUM(returned_cost_syp) returned_cost_syp FROM sale_returns GROUP BY sale_id),q AS (SELECT sr.sale_id,SUM(ri.quantity) returned_quantity FROM sale_returns sr JOIN sale_return_items ri ON ri.return_id=sr.id GROUP BY sr.sale_id) SELECT h.*,q.returned_quantity FROM h LEFT JOIN q ON q.sale_id=h.sale_id`).all(); const itemSummaryMap = new Map(composeItemSummaries.map(row => [row.sale_id,row])); const returnSummaryMap = new Map(composeReturnSummaries.map(row => [row.sale_id,row]));
  const split = {
    baseSales: printable(repeat(() => queryRows(db, {}, true))), invoiceId: printable(repeat(() => queryRows(db, matrix['Invoice ID'], true))),
    productName: printable(repeat(() => queryRows(db, matrix['Product name'], true))), barcode: printable(repeat(() => queryRows(db, matrix.Barcode, true))),
    returnAggregation: printable(repeat(() => db.prepare('SELECT sale_id,SUM(refund_total_syp) refund,SUM(returned_cost_syp) cost FROM sale_returns GROUP BY sale_id').all())),
    statusDerivation: printable(repeat(() => composeSales.map(row => { const sold=itemSummaryMap.get(row.id)?.sold_quantity??0; const returned=returnSummaryMap.get(row.id)?.returned_quantity??0; return returned===0?'none':returned===sold?'full':'partial'; }))),
    finalComposition: printable(repeat(() => composeSummaries(composeSales, composeItemSummaries, composeReturnSummaries))),
    amount: printable(repeat(() => queryRows(db, matrix['Min amount'], true))), sort: printable(repeat(() => queryRows(db, matrix.Highest, true))),
  };
  const plans = { before: { noSearch: plan(db, {}, false), invoice: plan(db, matrix['Invoice ID'], false), product: plan(db, matrix['Product name'], false), barcode: plan(db, matrix.Barcode, false), newest: plan(db, matrix.Newest, false), oldest: plan(db, matrix.Oldest, false), highest: plan(db, matrix.Highest, false), lowest: plan(db, matrix.Lowest, false), period: plan(db, matrix.Week, false), amount: plan(db, matrix['Min amount'], false) }, after: { noSearch: plan(db, {}, true), invoice: plan(db, matrix['Invoice ID'], true), product: plan(db, matrix['Product name'], true), barcode: plan(db, matrix.Barcode, true), newest: plan(db, matrix.Newest, true), oldest: plan(db, matrix.Oldest, true), highest: plan(db, matrix.Highest, true), lowest: plan(db, matrix.Lowest, true), period: plan(db, matrix.Week, true), amount: plan(db, matrix['Min amount'], true), itemSummary: db.prepare('EXPLAIN QUERY PLAN SELECT sale_id,COUNT(*),SUM(quantity) FROM sale_items WHERE sale_id IN (SELECT value FROM json_each(?)) GROUP BY sale_id').all('[1,2,3]').map(row => row.detail), returnSummary: db.prepare(`EXPLAIN QUERY PLAN WITH headers AS (SELECT sale_id,SUM(refund_total_syp) refund FROM sale_returns WHERE sale_id IN (SELECT value FROM json_each(?)) GROUP BY sale_id),quantities AS (SELECT sr.sale_id,SUM(ri.quantity) returned FROM sale_returns sr JOIN sale_return_items ri ON ri.return_id=sr.id WHERE sr.sale_id IN (SELECT value FROM json_each(?)) GROUP BY sr.sale_id) SELECT h.sale_id,h.refund,q.returned FROM headers h LEFT JOIN quantities q ON q.sale_id=h.sale_id`).all('[1,2,3]','[1,2,3]').map(row => row.detail) } };
  console.log(`PHASE10_5_REPORT=${JSON.stringify({ dataset: { sales: 5_000, items: 25_000, returns: 1_000, returnItems: 3_000 }, report, split, plans, memory: { rowsBefore: 34_000, rowsAfter: 11_000, mapEntries: noFilter.mapEntries } })}`);
  db.close();
});

test('optimized status derivation distinguishes no, partial and full returns without N+1', () => {
  const db = new DatabaseSync(':memory:'); db.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY); CREATE TABLE sale_items(id INTEGER PRIMARY KEY,sale_id INTEGER,quantity INTEGER,product_name TEXT,barcode_snapshot TEXT); CREATE TABLE sale_returns(id INTEGER PRIMARY KEY,sale_id INTEGER,refund_total_syp INTEGER,returned_cost_syp INTEGER,created_at TEXT); CREATE TABLE sale_return_items(id INTEGER PRIMARY KEY,return_id INTEGER,sale_item_id INTEGER,quantity INTEGER); INSERT INTO sales VALUES(1),(2),(3); INSERT INTO sale_items VALUES(1,1,2,'A',NULL),(2,2,2,'B',NULL),(3,3,2,'C',NULL); INSERT INTO sale_returns VALUES(1,2,5,3,'x'),(2,3,10,6,'x'); INSERT INTO sale_return_items VALUES(1,1,2,1),(2,2,3,2);`); const result = summaryHydrate(db, db.prepare('SELECT * FROM sales ORDER BY id').all()); assert.deepEqual(result.rows.map(row => row.return_summary.status), ['none','partial','full']); assert.equal(result.queryCount, 3); db.close();
});

test('application invoice list uses compact summaries and hydrates one detail on demand', async () => {
  const database = await readFile(new URL('../src/database/database.ts', import.meta.url), 'utf8');
  const views = await readFile(new URL('../src/components/sales/SalesViews.tsx', import.meta.url), 'utf8');
  const screen = await readFile(new URL('../src/screens/SalesScreen.tsx', import.meta.url), 'utf8');
  assert.match(database, /return attachInvoiceSummaries\(rows\)/);
  assert.match(database, /export async function getInvoiceDetails[\s\S]*?attachSaleItems\(\[sale\]\)/);
  assert.match(database, /FROM sale_items WHERE sale_id IN \(SELECT value FROM json_each\(\?\)\) GROUP BY sale_id/);
  assert.match(database, /WITH headers AS/);
  assert.doesNotMatch(database.match(/export async function queryInvoices[\s\S]*?\n\}/)?.[0] ?? '', /attachSaleItems/);
  assert.match(views, /useDeferredValue\(search\)/);
  assert.match(screen, /state\.getInvoiceDetails\(sale\.id\)/);
});
