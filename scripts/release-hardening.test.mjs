import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as XLSX from 'xlsx';

const root = new URL('../', import.meta.url);
const read = relative => readFile(new URL(relative, root), 'utf8');

async function runtimeSources(directory = new URL('src/', root)) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources = [];
  for (const entry of entries) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) sources.push(...await runtimeSources(url));
    else if (/\.(ts|tsx)$/.test(entry.name)) sources.push([url.pathname, await readFile(url, 'utf8')]);
  }
  return sources;
}

test('unused visual packages stay removed and Expo identity stays fixed', async () => {
  const [packageJson, appJson, gradle] = await Promise.all([
    read('package.json').then(JSON.parse), read('app.json'), read('android/app/build.gradle'),
  ]);
  assert.equal(packageJson.dependencies['expo-blur'], undefined);
  assert.equal(packageJson.dependencies['expo-linear-gradient'], undefined);
  assert.match(appJson, /"package": "com\.sarafy\.catalog"/);
  assert.match(gradle, /applicationId ['"]com\.sarafy\.catalog['"]/);
});

test('runtime remains offline and Expo Updates stays disabled', async () => {
  const sources = await runtimeSources();
  sources.push(['/App.tsx', await read('App.tsx')]);
  const runtime = sources.map(([path, source]) => `${path}\n${source}`).join('\n');
  assert.doesNotMatch(runtime, /\bfetch\s*\(|\baxios\b|XMLHttpRequest|WebSocket|https?:\/\//);
  const [packageJson, manifest] = await Promise.all([read('package.json').then(JSON.parse), read('android/app/src/main/AndroidManifest.xml')]);
  assert.equal(packageJson.dependencies['expo-updates'], undefined);
  assert.match(manifest, /expo\.modules\.updates\.ENABLED" android:value="false"/);
});

test('storage writes keep bounded inputs, safe paths, checksums, and free-space guards', async () => {
  const [archive, images, backups, excel, storageSafety] = await Promise.all([
    read('src/backup/backupArchive.ts'), read('src/media/productImageStorage.ts'),
    read('src/backup/backupManager.ts'), read('src/utils/excel.ts'), read('src/utils/storageSafety.ts'),
  ]);
  assert.match(archive, /headerLength > 50 \* 1024 \* 1024/);
  assert.match(archive, /image\.size > 15 \* 1024 \* 1024/);
  assert.match(archive, /BACKUP_CHECKSUM_MISMATCH/);
  assert.match(archive, /IMAGE_CHECKSUM_MISMATCH/);
  assert.match(archive, /isStoredProductImagePath\(image\.relativePath\)/);
  assert.match(images, /SAFE_RELATIVE = \/\^media\\\/products\\\//);
  assert.match(images, /validateProductImageContent/);
  assert.match(images, /INVALID_IMAGE_CONTENT/);
  assert.match(images, /readBytes\(16\)/);
  assert.match(archive, /validateProductImageContent\(temporary\.uri\)/);
  assert.match(backups, /> 100 \* 1024 \* 1024/);
  assert.match(excel, /> 25 \* 1024 \* 1024/);
  assert.match(storageSafety, /Paths\.availableDiskSpace/);
  assert.match(archive, /assertAvailableDiskSpace/);
  assert.match(images, /assertAvailableDiskSpace/);
  assert.match(excel, /assertAvailableDiskSpace/);
});

test('full restore batches portable rows and resolves UUID maps once per table', async () => {
  const [importer, fullRestore] = await Promise.all([
    read('src/import/jsonImporter.ts'),
    read('src/import/fullRestoreInserter.ts'),
  ]);
  assert.match(importer, /insertFullRestorePayload\(transaction, payload, options\.entities\)/);
  assert.ok(importer.indexOf('insertFullRestorePayload(transaction') < importer.indexOf("if (options.entities.includes('cash_sessions'))"));
  assert.match(fullRestore, /const MAX_BATCH_BINDINGS = 900/);
  assert.match(fullRestore, /for \(let offset = 0; offset < rows\.length; offset \+= batchSize\)/);
  assert.match(fullRestore, /INSERT INTO \$\{table\}.*batch\.map/s);
  assert.match(fullRestore, /loadIdByUuid\(transaction, 'sale_items'\)/);
  assert.match(fullRestore, /loadIdByUuid\(transaction, 'purchase_receipt_items'\)/);
  assert.match(fullRestore, /PAYMENT_SETTLEMENT_CONFLICT/);
  assert.match(fullRestore, /RETURN_QUANTITY_EXCEEDED/);
  assert.match(fullRestore, /INVALID_INVENTORY_LEDGER/);
  assert.doesNotMatch(fullRestore, /for \([^)]*\) \{[\s\S]{0,240}getFirstAsync/);
});

test('completed portable identity migration is not replayed on every large-database startup', async () => {
  const database = await read('src/database/database.ts');
  const start = database.indexOf('async function migratePortableIdentity()');
  const transaction = database.indexOf('withExclusiveTransactionAsync', start);
  const guard = database.indexOf("if ((version?.user_version ?? 0) >= 8) return", start);
  assert.ok(start >= 0 && guard > start && guard < transaction);
});

test('purchase history virtualizes the high-volume supplier filter strip', async () => {
  const purchases = await read('src/screens/PurchasesScreen.tsx');
  assert.match(purchases, /const supplierFilters = useMemo<\(Supplier \| null\)\[]>/);
  assert.match(purchases, /<FlatList horizontal data=\{supplierFilters\}/);
  assert.match(purchases, /keyExtractor=\{item => item\?\.uuid \?\? 'all'\}/);
  assert.match(purchases, /initialNumToRender=\{12\} maxToRenderPerBatch=\{12\} windowSize=\{5\} removeClippedSubviews/);
});

test('sensitive runtime errors stay development-only and timers clean up', async () => {
  const [database, backups, snackbar] = await Promise.all([
    read('src/database/database.ts'), read('src/backup/backupManager.ts'), read('src/components/ui/Snackbar.tsx'),
  ]);
  assert.match(database, /if \(__DEV__\) console\.error\('\[ProductImageCleanupFailed\]'/);
  assert.match(database, /if \(__DEV__\) console\.error\('\[InvalidStoredSetting\]'/);
  assert.match(backups, /if \(__DEV__\) \{\s*console\.error\('\[SarafyBackupWriteFailed\]'/);
  assert.match(snackbar, /useEffect\(\(\) => \(\) => \{ if \(timeout\.current\) clearTimeout\(timeout\.current\); \}, \[\]\)/);
});

test('10k product search remains bounded in plain JS', () => {
  const products = Array.from({ length: 10_000 }, (_, index) => ({
    name: `Product ${index}`, category: `Category ${index % 50}`, barcode: index % 2 ? null : `BC${index}`,
  }));
  const samples = [];
  for (let iteration = 0; iteration < 25; iteration += 1) {
    const started = performance.now();
    const matches = products.filter(product => product.name.toLowerCase().includes('999') || product.category.toLowerCase().includes('999') || product.barcode?.includes('999'));
    samples.push(performance.now() - started);
    assert.ok(matches.length > 0);
  }
  samples.sort((left, right) => left - right);
  const median = samples[Math.floor(samples.length / 2)];
  console.log(`product_search_10k_median_ms=${median.toFixed(2)}`);
  assert.ok(median < 250);
});

test('large backup-shaped payload stays below the existing 50MB header limit', () => {
  const products = Array.from({ length: 10_000 }, (_, index) => ({ id: index + 1, uuid: `product-${index}`, name: `Product ${index}`, category: `Category ${index % 50}`, price_usd: 10, cost_usd: 5, image_uri: null, barcode: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', is_active: 1 }));
  const sales = Array.from({ length: 5_000 }, (_, index) => ({ id: index + 1, uuid: `sale-${index}`, invoice_number: `INV-${index}`, exchange_rate: 15_000, subtotal_syp: 50_000, discount_syp: 0, net_total_syp: 50_000, cost_syp: 25_000, profit_syp: 25_000, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', items: Array.from({ length: 5 }, (_, itemIndex) => ({ id: index * 5 + itemIndex + 1, uuid: `item-${index}-${itemIndex}`, sale_id: index + 1, product_id: itemIndex + 1, product_name: `Product ${itemIndex}`, quantity: 1, unit_price_syp: 10_000, unit_cost_syp: 5_000, line_total_syp: 10_000, line_cost_syp: 5_000, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' })) }));
  const expenses = Array.from({ length: 1_000 }, (_, index) => ({ id: index + 1, uuid: `expense-${index}`, description: `Expense ${index}`, amount_syp: 1_000, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }));
  const started = performance.now();
  const json = JSON.stringify({ version: 4, exportedAt: '2026-01-01T00:00:00.000Z', products, categories: [], settings: {}, sales, expenses });
  const elapsed = performance.now() - started;
  const bytes = Buffer.byteLength(json);
  console.log(`backup_payload_bytes=${bytes} backup_stringify_ms=${elapsed.toFixed(2)}`);
  assert.ok(bytes < 50 * 1024 * 1024);
});

test('10k-row Excel workbook round-trips within the 25MB import cap', () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => ({ uuid: `product-${index}`, id: index + 1, name: `Product ${index}`, category: `Category ${index % 50}`, price_usd: index + 1, cost_usd: index / 2, barcode: `BC${index}` }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Products');
  const started = performance.now();
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
  const parsed = XLSX.read(bytes, { type: 'buffer' });
  const parsedRows = XLSX.utils.sheet_to_json(parsed.Sheets.Products);
  const elapsed = performance.now() - started;
  console.log(`excel_10k_bytes=${bytes.length} excel_10k_roundtrip_ms=${elapsed.toFixed(2)}`);
  assert.equal(parsedRows.length, 10_000);
  assert.ok(bytes.length < 25 * 1024 * 1024);
});

const hardeningUuid = (prefix, value) => `${prefix}-${String(value).padStart(8, '0')}`;

function measure(operation) {
  operation();
  const samples = [];
  for (let run = 0; run < 7; run += 1) {
    const started = performance.now();
    operation();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return {
    min: Number(samples[0].toFixed(2)),
    median: Number(samples[3].toFixed(2)),
    max: Number(samples[6].toFixed(2)),
  };
}

function createHighVolumeDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE products(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,name TEXT NOT NULL,category TEXT,barcode TEXT,is_active INTEGER NOT NULL);
    CREATE INDEX idx_products_name ON products(name);
    CREATE TABLE inventory_balances(product_id INTEGER PRIMARY KEY REFERENCES products(id),quantity INTEGER NOT NULL CHECK(quantity>=0));
    CREATE TABLE sales(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,invoice_number TEXT NOT NULL,subtotal_syp INTEGER NOT NULL,discount_syp INTEGER NOT NULL,net_total_syp INTEGER NOT NULL,cost_syp INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX idx_sales_created_at ON sales(created_at DESC,id DESC);
    CREATE TABLE sale_items(id INTEGER PRIMARY KEY,sale_id INTEGER NOT NULL REFERENCES sales(id),product_id INTEGER REFERENCES products(id),quantity INTEGER NOT NULL,line_total_syp INTEGER NOT NULL,line_cost_syp INTEGER NOT NULL);
    CREATE INDEX idx_sale_items_sale_id ON sale_items(sale_id);
    CREATE TABLE sale_payments(id INTEGER PRIMARY KEY,sale_id INTEGER NOT NULL REFERENCES sales(id),method TEXT NOT NULL,amount_syp INTEGER NOT NULL,amount_usd_cents INTEGER NOT NULL,syp_equivalent INTEGER NOT NULL,change_syp INTEGER NOT NULL,exchange_rate INTEGER NOT NULL);
    CREATE INDEX idx_sale_payments_sale_id ON sale_payments(sale_id);
    CREATE TABLE sale_returns(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,sale_id INTEGER NOT NULL REFERENCES sales(id),refund_total_syp INTEGER NOT NULL,returned_cost_syp INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX idx_sale_returns_created_at ON sale_returns(created_at DESC,id DESC);
    CREATE INDEX idx_sale_returns_sale_id ON sale_returns(sale_id);
    CREATE TABLE sale_return_items(id INTEGER PRIMARY KEY,return_id INTEGER NOT NULL REFERENCES sale_returns(id),sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),quantity INTEGER NOT NULL);
    CREATE INDEX idx_sale_return_items_return_id ON sale_return_items(return_id);
    CREATE INDEX idx_sale_return_items_sale_item_id ON sale_return_items(sale_item_id);
    CREATE TABLE cash_sessions(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,opened_at TEXT NOT NULL,closed_at TEXT,opening_cash_syp INTEGER NOT NULL,closing_expected_cash_syp INTEGER,closing_actual_cash_syp INTEGER,closing_difference_syp INTEGER,opening_cash_usd_cents INTEGER NOT NULL,closing_expected_cash_usd_cents INTEGER,closing_actual_cash_usd_cents INTEGER,closing_difference_usd_cents INTEGER);
    CREATE INDEX idx_cash_sessions_opened_at ON cash_sessions(opened_at DESC,id DESC);
    CREATE TABLE suppliers(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,name TEXT NOT NULL,is_active INTEGER NOT NULL);
    CREATE INDEX idx_suppliers_name ON suppliers(name);
    CREATE TABLE purchase_receipts(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,supplier_id INTEGER REFERENCES suppliers(id),supplier_name_snapshot TEXT NOT NULL,received_at TEXT NOT NULL,total_value_usd_cents INTEGER NOT NULL);
    CREATE INDEX idx_purchase_receipts_received_at ON purchase_receipts(received_at DESC,id DESC);
    CREATE INDEX idx_purchase_receipts_supplier_id ON purchase_receipts(supplier_id);
    CREATE TABLE purchase_receipt_items(id INTEGER PRIMARY KEY,purchase_receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id),product_id INTEGER REFERENCES products(id),quantity INTEGER NOT NULL,unit_cost_usd_cents INTEGER NOT NULL,line_total_usd_cents INTEGER NOT NULL);
    CREATE INDEX idx_purchase_receipt_items_receipt_id ON purchase_receipt_items(purchase_receipt_id);
    CREATE TABLE purchase_returns(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,purchase_receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id),supplier_id INTEGER REFERENCES suppliers(id),created_at TEXT NOT NULL,total_quantity INTEGER NOT NULL,total_value_usd_cents INTEGER NOT NULL);
    CREATE INDEX idx_purchase_returns_created_at ON purchase_returns(created_at DESC,id DESC);
    CREATE INDEX idx_purchase_returns_supplier_id ON purchase_returns(supplier_id);
    CREATE TABLE purchase_return_items(id INTEGER PRIMARY KEY,purchase_return_id INTEGER NOT NULL REFERENCES purchase_returns(id),purchase_receipt_item_id INTEGER NOT NULL REFERENCES purchase_receipt_items(id),quantity INTEGER NOT NULL,unit_cost_usd_cents INTEGER NOT NULL);
    CREATE INDEX idx_purchase_return_items_return_id ON purchase_return_items(purchase_return_id);
    CREATE INDEX idx_purchase_return_items_purchase_item_id ON purchase_return_items(purchase_receipt_item_id);
    CREATE TABLE expenses(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,category_id INTEGER NOT NULL,amount_syp INTEGER NOT NULL,created_at TEXT NOT NULL,note TEXT);
    CREATE INDEX idx_expenses_created_at ON expenses(created_at DESC,id DESC);
    CREATE TABLE inventory_movements(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,product_id INTEGER NOT NULL REFERENCES products(id),movement_type TEXT NOT NULL,quantity_before INTEGER NOT NULL,quantity_delta INTEGER NOT NULL,quantity_after INTEGER NOT NULL,sale_item_id INTEGER REFERENCES sale_items(id),return_item_id INTEGER REFERENCES sale_return_items(id),purchase_receipt_item_id INTEGER REFERENCES purchase_receipt_items(id),purchase_return_item_id INTEGER REFERENCES purchase_return_items(id),created_at TEXT NOT NULL,CHECK(quantity_after=quantity_before+quantity_delta));
    CREATE INDEX idx_inventory_movements_product_created ON inventory_movements(product_id,created_at DESC,id DESC);
    CREATE UNIQUE INDEX idx_inventory_movement_sale ON inventory_movements(sale_item_id) WHERE sale_item_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_inventory_movement_return ON inventory_movements(return_item_id) WHERE return_item_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_inventory_movement_purchase ON inventory_movements(purchase_receipt_item_id) WHERE purchase_receipt_item_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_inventory_movement_purchase_return ON inventory_movements(purchase_return_item_id) WHERE purchase_return_item_id IS NOT NULL;`);

  const product = db.prepare('INSERT INTO products VALUES(?,?,?,?,?,1)');
  const balance = db.prepare('INSERT INTO inventory_balances VALUES(?,13)');
  const sale = db.prepare('INSERT INTO sales VALUES(?,?,?,?,?,?,?,?)');
  const saleItem = db.prepare('INSERT INTO sale_items VALUES(?,?,?,?,?,?)');
  const payment = db.prepare('INSERT INTO sale_payments VALUES(?,?,?,?,?,?,?,?)');
  const customerReturn = db.prepare('INSERT INTO sale_returns VALUES(?,?,?,?,?,?)');
  const customerReturnItem = db.prepare('INSERT INTO sale_return_items VALUES(?,?,?,1)');
  const session = db.prepare('INSERT INTO cash_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  const supplier = db.prepare('INSERT INTO suppliers VALUES(?,?,?,1)');
  const receipt = db.prepare('INSERT INTO purchase_receipts VALUES(?,?,?,?,?,?)');
  const receiptItem = db.prepare('INSERT INTO purchase_receipt_items VALUES(?,?,?,?,?,?)');
  const supplierReturn = db.prepare('INSERT INTO purchase_returns VALUES(?,?,?,?,?,?,?)');
  const supplierReturnItem = db.prepare('INSERT INTO purchase_return_items VALUES(?,?,?,?,?)');
  const expense = db.prepare('INSERT INTO expenses VALUES(?,?,?,?,?,?)');
  const movement = db.prepare('INSERT INTO inventory_movements VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');

  db.exec('BEGIN');
  for (let id = 1; id <= 5_000; id += 1) {
    product.run(id, hardeningUuid('product', id), `Product ${String(id).padStart(5, '0')}`, `Category ${id % 50}`, `BC${String(id).padStart(8, '0')}`);
    balance.run(id);
  }
  for (let id = 1; id <= 1_000; id += 1) supplier.run(id, hardeningUuid('supplier', id), `Supplier ${String(id).padStart(4, '0')}`);
  for (let id = 1; id <= 10_000; id += 1) {
    const day = String((id % 28) + 1).padStart(2, '0');
    const createdAt = `2026-09-${day}T${String(id % 24).padStart(2, '0')}:00:00.000Z`;
    sale.run(id, hardeningUuid('sale', id), `INV-${String(id).padStart(6, '0')}`, 31_000, 1_000, 30_000, 18_000, createdAt);
    payment.run(id, id, id % 3 === 0 ? 'mixed' : id % 3 === 1 ? 'syp' : 'usd', id % 3 === 2 ? 0 : 30_000, id % 3 === 2 ? 200 : 0, 30_000, 0, 15_000);
    for (let line = 0; line < 3; line += 1) {
      const itemId = (id - 1) * 3 + line + 1;
      saleItem.run(itemId, id, ((itemId - 1) % 5_000) + 1, 2, 10_000, 6_000);
    }
  }
  for (let id = 1; id <= 5_000; id += 1) {
    const createdAt = `2026-09-${String((id % 28) + 1).padStart(2, '0')}T12:00:00.000Z`;
    customerReturn.run(id, hardeningUuid('return', id), id, 5_000, 3_000, createdAt);
    customerReturnItem.run(id, id, (id - 1) * 3 + 1);
    session.run(id, hardeningUuid('session', id), createdAt, createdAt, 500_000, 530_000, 529_000, -1_000, 5_000, 5_200, 5_200, 0);
    receipt.run(id, hardeningUuid('receipt', id), ((id - 1) % 1_000) + 1, `Supplier ${String(((id - 1) % 1_000) + 1).padStart(4, '0')}`, createdAt, 6_600);
    for (let line = 0; line < 3; line += 1) {
      const itemId = (id - 1) * 3 + line + 1;
      receiptItem.run(itemId, id, ((itemId - 1) % 5_000) + 1, 10, 220, 2_200);
    }
    supplierReturn.run(id, hardeningUuid('purchase-return', id), id, ((id - 1) % 1_000) + 1, createdAt, 1, 220);
    supplierReturnItem.run(id, id, (id - 1) * 3 + 1, 1, 220);
    expense.run(id, hardeningUuid('expense', id), (id % 7) + 1, 1_000 + id, createdAt, `Expense note ${id}`);
  }
  for (let productId = 1; productId <= 5_000; productId += 1) {
    const ids = Array.from({ length: 5 }, (_, offset) => (productId - 1) * 5 + offset + 1);
    const saleItemId = (productId - 1) * 3 + 1;
    movement.run(ids[0], hardeningUuid('movement', ids[0]), productId, 'opening', 0, 10, 10, null, null, null, null, '2026-01-01');
    movement.run(ids[1], hardeningUuid('movement', ids[1]), productId, 'purchase', 10, 5, 15, null, null, productId, null, '2026-02-01');
    movement.run(ids[2], hardeningUuid('movement', ids[2]), productId, 'sale', 15, -2, 13, saleItemId, null, null, null, '2026-03-01');
    movement.run(ids[3], hardeningUuid('movement', ids[3]), productId, 'return', 13, 1, 14, null, productId, null, null, '2026-04-01');
    movement.run(ids[4], hardeningUuid('movement', ids[4]), productId, 'purchase_return', 14, -1, 13, null, null, null, productId, '2026-05-01');
  }
  db.exec('COMMIT');
  return db;
}

test('release high-volume dataset remains relationally valid and query paths stay measured', () => {
  const db = createHighVolumeDatabase();
  const queries = {
    productList: ['SELECT id,uuid,name,category,barcode FROM products WHERE is_active=1 ORDER BY name LIMIT 200', []],
    productSearch: ["SELECT id,name,barcode FROM products WHERE name LIKE ? OR barcode LIKE ? ORDER BY name LIMIT 100", ['%04999%', '%04999%']],
    invoiceNewest: ['SELECT id,invoice_number,net_total_syp,created_at FROM sales ORDER BY created_at DESC,id DESC LIMIT 200', []],
    invoiceOldest: ['SELECT id,invoice_number,net_total_syp,created_at FROM sales ORDER BY created_at ASC,id ASC LIMIT 200', []],
    invoiceFilter: ['SELECT id,invoice_number,net_total_syp,created_at FROM sales WHERE created_at>=? AND created_at<? ORDER BY created_at DESC,id DESC', ['2026-09-07', '2026-09-14']],
    invoiceDetail: ['SELECT si.*,sp.method,sp.amount_syp,sp.amount_usd_cents,sp.syp_equivalent,sp.change_syp FROM sale_items si LEFT JOIN sale_payments sp ON sp.sale_id=si.sale_id WHERE si.sale_id=? ORDER BY si.id', [5_000]],
    cashHistory: ['SELECT id,uuid,opened_at,closed_at,closing_expected_cash_syp,closing_difference_syp,closing_expected_cash_usd_cents,closing_difference_usd_cents FROM cash_sessions ORDER BY opened_at DESC,id DESC', []],
    cashDetail: ['SELECT * FROM cash_sessions WHERE id=?', [2_500]],
    inventoryProducts: ['SELECT p.id,p.name,b.quantity FROM products p JOIN inventory_balances b ON b.product_id=p.id WHERE b.quantity<=? ORDER BY b.quantity,p.name LIMIT 200', [13]],
    inventoryMovements: ['SELECT movement_type,quantity_before,quantity_delta,quantity_after,created_at FROM inventory_movements WHERE product_id=? ORDER BY created_at DESC,id DESC', [2_500]],
    supplierList: ['SELECT s.id,s.name,COUNT(pr.id) receipt_count FROM suppliers s LEFT JOIN purchase_receipts pr ON pr.supplier_id=s.id GROUP BY s.id ORDER BY s.name', []],
    supplierSearch: ['SELECT id,uuid,name FROM suppliers WHERE name LIKE ? ORDER BY name LIMIT 100', ['%0500%']],
    purchaseHistory: ['SELECT id,uuid,supplier_name_snapshot,received_at,total_value_usd_cents FROM purchase_receipts ORDER BY received_at DESC,id DESC', []],
    purchaseDetail: ['SELECT * FROM purchase_receipt_items WHERE purchase_receipt_id=? ORDER BY id', [2_500]],
    supplierReturnHistory: ['SELECT id,uuid,purchase_receipt_id,created_at,total_quantity,total_value_usd_cents FROM purchase_returns ORDER BY created_at DESC,id DESC', []],
    supplierDetail: ['SELECT pr.id,pr.received_at,pr.total_value_usd_cents FROM purchase_receipts pr WHERE pr.supplier_id=? ORDER BY pr.received_at DESC,id DESC', [500]],
    analyticsToday: ["SELECT COALESCE(SUM(net_total_syp),0) FROM sales WHERE created_at>='2026-09-10' AND created_at<'2026-09-11'", []],
    analyticsWeek: ["SELECT COALESCE(SUM(net_total_syp),0) FROM sales WHERE created_at>='2026-09-07' AND created_at<'2026-09-14'", []],
    analyticsMonth: ["SELECT COALESCE(SUM(net_total_syp),0) FROM sales WHERE created_at>='2026-09-01' AND created_at<'2026-10-01'", []],
    healthAudit: ['SELECT COUNT(*) invalid FROM inventory_movements WHERE quantity_after<>quantity_before+quantity_delta', []],
  };
  const report = {};
  for (const [name, [sql, args]] of Object.entries(queries)) report[name] = measure(() => db.prepare(sql).all(...args));
  const backupTables = ['products','inventory_balances','sales','sale_items','sale_payments','sale_returns','sale_return_items','cash_sessions','suppliers','purchase_receipts','purchase_receipt_items','purchase_returns','purchase_return_items','expenses','inventory_movements'];
  let backupJson = '';
  report.backupCreation = measure(() => { backupJson = JSON.stringify(Object.fromEntries(backupTables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]))); });
  report.restorePreview = measure(() => { const parsed = JSON.parse(backupJson); assert.equal(parsed.sales.length, 10_000); assert.equal(parsed.inventory_movements.length, 25_000); });

  assert.deepEqual(Object.fromEntries(backupTables.map(table => [table, Number(db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count)])), {
    products: 5_000, inventory_balances: 5_000, sales: 10_000, sale_items: 30_000, sale_payments: 10_000,
    sale_returns: 5_000, sale_return_items: 5_000, cash_sessions: 5_000, suppliers: 1_000,
    purchase_receipts: 5_000, purchase_receipt_items: 15_000, purchase_returns: 5_000,
    purchase_return_items: 5_000, expenses: 5_000, inventory_movements: 25_000,
  });
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM inventory_balances WHERE quantity<0').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM inventory_movements WHERE quantity_after<>quantity_before+quantity_delta').get().count, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM inventory_balances b WHERE b.quantity<>(SELECT m.quantity_after FROM inventory_movements m WHERE m.product_id=b.product_id ORDER BY m.created_at DESC,m.id DESC LIMIT 1)`).get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE sp.syp_equivalent-sp.change_syp<>s.net_total_syp').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM sale_return_items ri JOIN sale_items si ON si.id=ri.sale_item_id GROUP BY ri.sale_item_id HAVING SUM(ri.quantity)>si.quantity').all().length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM purchase_return_items ri JOIN purchase_receipt_items pi ON pi.id=ri.purchase_receipt_item_id GROUP BY ri.purchase_receipt_item_id HAVING SUM(ri.quantity)>pi.quantity').all().length, 0);
  assert.ok(Buffer.byteLength(backupJson) < 50 * 1024 * 1024);

  const plans = {
    invoiceNewest: db.prepare(`EXPLAIN QUERY PLAN ${queries.invoiceNewest[0]}`).all().map(row => row.detail),
    cashHistory: db.prepare(`EXPLAIN QUERY PLAN ${queries.cashHistory[0]}`).all().map(row => row.detail),
    inventoryMovements: db.prepare(`EXPLAIN QUERY PLAN ${queries.inventoryMovements[0]}`).all(2_500).map(row => row.detail),
    purchaseHistory: db.prepare(`EXPLAIN QUERY PLAN ${queries.purchaseHistory[0]}`).all().map(row => row.detail),
    supplierReturns: db.prepare(`EXPLAIN QUERY PLAN ${queries.supplierReturnHistory[0]}`).all().map(row => row.detail),
  };
  assert.match(plans.invoiceNewest.join(' '), /idx_sales_created_at/);
  assert.match(plans.cashHistory.join(' '), /idx_cash_sessions_opened_at/);
  assert.match(plans.inventoryMovements.join(' '), /idx_inventory_movements_product_created/);
  assert.match(plans.purchaseHistory.join(' '), /idx_purchase_receipts_received_at/);
  assert.match(plans.supplierReturns.join(' '), /idx_purchase_returns_created_at/);
  console.log(`RELEASE_HIGH_VOLUME=${JSON.stringify(report)}`);
  console.log(`RELEASE_QUERY_PLANS=${JSON.stringify(plans)}`);
  db.close();
});

function createFaultDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE products(id INTEGER PRIMARY KEY,stock INTEGER NOT NULL CHECK(stock>=0)); INSERT INTO products VALUES(1,100);
    CREATE TABLE sales(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE); CREATE TABLE sale_items(id INTEGER PRIMARY KEY,sale_id INTEGER REFERENCES sales(id),quantity INTEGER); CREATE TABLE sale_payments(id INTEGER PRIMARY KEY,sale_id INTEGER REFERENCES sales(id));
    CREATE TABLE sale_returns(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE,sale_id INTEGER REFERENCES sales(id)); CREATE TABLE sale_return_items(id INTEGER PRIMARY KEY,return_id INTEGER REFERENCES sale_returns(id),quantity INTEGER,restock_quantity INTEGER);
    CREATE TABLE purchase_receipts(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE); CREATE TABLE purchase_receipt_items(id INTEGER PRIMARY KEY,receipt_id INTEGER REFERENCES purchase_receipts(id),quantity INTEGER);
    CREATE TABLE purchase_returns(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE,receipt_id INTEGER REFERENCES purchase_receipts(id)); CREATE TABLE purchase_return_items(id INTEGER PRIMARY KEY,return_id INTEGER REFERENCES purchase_returns(id),quantity INTEGER);
    CREATE TABLE inventory_movements(id INTEGER PRIMARY KEY,source_type TEXT,source_id INTEGER,delta INTEGER,UNIQUE(source_type,source_id));
    CREATE TABLE cash_sessions(id INTEGER PRIMARY KEY,closed_at TEXT,expected_syp INTEGER,actual_syp INTEGER);
    INSERT INTO cash_sessions VALUES(1,NULL,NULL,NULL);`);
  return db;
}

function transactional(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try { operation(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function injectedFailure(stage, expectedStage) { if (stage === expectedStage) throw new Error(`INJECTED_${stage}`); }

test('test-only fault injection rolls every business transaction back at each boundary', () => {
  const matrices = {
    sale: ['after_header','after_items','after_payments','before_inventory','before_commit'],
    purchase: ['after_header','after_items','before_inventory','before_commit'],
    customerReturn: ['after_header','after_items','before_restock','before_commit'],
    supplierReturn: ['after_header','after_items','before_movement','before_commit'],
    sessionClose: ['after_recompute','before_snapshot','before_commit'],
  };
  for (const [operation, stages] of Object.entries(matrices)) {
    for (const stage of stages) {
      const db = createFaultDatabase();
      assert.throws(() => transactional(db, () => {
        if (operation === 'sale') {
          db.exec("INSERT INTO sales VALUES(1,'sale-1')"); injectedFailure(stage, 'after_header');
          db.exec('INSERT INTO sale_items VALUES(1,1,2)'); injectedFailure(stage, 'after_items');
          db.exec('INSERT INTO sale_payments VALUES(1,1)'); injectedFailure(stage, 'after_payments');
          injectedFailure(stage, 'before_inventory'); db.exec("UPDATE products SET stock=stock-2 WHERE id=1;INSERT INTO inventory_movements VALUES(1,'sale',1,-2)");
        } else if (operation === 'purchase') {
          db.exec("INSERT INTO purchase_receipts VALUES(1,'purchase-1')"); injectedFailure(stage, 'after_header');
          db.exec('INSERT INTO purchase_receipt_items VALUES(1,1,10)'); injectedFailure(stage, 'after_items');
          injectedFailure(stage, 'before_inventory'); db.exec("UPDATE products SET stock=stock+10 WHERE id=1;INSERT INTO inventory_movements VALUES(1,'purchase',1,10)");
        } else if (operation === 'customerReturn') {
          db.exec("INSERT INTO sales VALUES(1,'sale-1');INSERT INTO sale_items VALUES(1,1,2);INSERT INTO sale_returns VALUES(1,'return-1',1)"); injectedFailure(stage, 'after_header');
          db.exec('INSERT INTO sale_return_items VALUES(1,1,2,1)'); injectedFailure(stage, 'after_items');
          injectedFailure(stage, 'before_restock'); db.exec("UPDATE products SET stock=stock+1 WHERE id=1;INSERT INTO inventory_movements VALUES(1,'return',1,1)");
        } else if (operation === 'supplierReturn') {
          db.exec("INSERT INTO purchase_receipts VALUES(1,'purchase-1');INSERT INTO purchase_receipt_items VALUES(1,1,10);INSERT INTO purchase_returns VALUES(1,'supplier-return-1',1)"); injectedFailure(stage, 'after_header');
          db.exec('INSERT INTO purchase_return_items VALUES(1,1,4)'); injectedFailure(stage, 'after_items');
          injectedFailure(stage, 'before_movement'); db.exec("UPDATE products SET stock=stock-4 WHERE id=1;INSERT INTO inventory_movements VALUES(1,'purchase_return',1,-4)");
        } else {
          const expected = 100; injectedFailure(stage, 'after_recompute');
          injectedFailure(stage, 'before_snapshot'); db.prepare("UPDATE cash_sessions SET closed_at='x',expected_syp=?,actual_syp=? WHERE id=1").run(expected, expected);
        }
        injectedFailure(stage, 'before_commit');
      }), /INJECTED_/);
      assert.deepEqual({
        sales: Number(db.prepare('SELECT COUNT(*) count FROM sales').get().count), saleItems: Number(db.prepare('SELECT COUNT(*) count FROM sale_items').get().count), payments: Number(db.prepare('SELECT COUNT(*) count FROM sale_payments').get().count),
        returns: Number(db.prepare('SELECT COUNT(*) count FROM sale_returns').get().count), returnItems: Number(db.prepare('SELECT COUNT(*) count FROM sale_return_items').get().count),
        purchases: Number(db.prepare('SELECT COUNT(*) count FROM purchase_receipts').get().count), purchaseItems: Number(db.prepare('SELECT COUNT(*) count FROM purchase_receipt_items').get().count),
        supplierReturns: Number(db.prepare('SELECT COUNT(*) count FROM purchase_returns').get().count), supplierReturnItems: Number(db.prepare('SELECT COUNT(*) count FROM purchase_return_items').get().count),
        movements: Number(db.prepare('SELECT COUNT(*) count FROM inventory_movements').get().count), stock: Number(db.prepare('SELECT stock FROM products WHERE id=1').get().stock),
      }, { sales:0,saleItems:0,payments:0,returns:0,returnItems:0,purchases:0,purchaseItems:0,supplierReturns:0,supplierReturnItems:0,movements:0,stock:100 });
      assert.equal(db.prepare('SELECT closed_at FROM cash_sessions WHERE id=1').get().closed_at, null);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      db.close();
    }
  }
});

test('serialized rapid attempts commit each sale, purchase, return, movement and close once', () => {
  const db = createFaultDatabase();
  const sale = () => transactional(db, () => { db.exec("INSERT INTO sales VALUES(1,'sale-1');INSERT INTO sale_items VALUES(1,1,2);INSERT INTO sale_payments VALUES(1,1);UPDATE products SET stock=stock-2 WHERE id=1;INSERT INTO inventory_movements VALUES(1,'sale',1,-2)"); });
  sale(); assert.throws(sale);
  const purchase = () => transactional(db, () => { db.exec("INSERT INTO purchase_receipts VALUES(1,'purchase-1');INSERT INTO purchase_receipt_items VALUES(1,1,10);UPDATE products SET stock=stock+10 WHERE id=1;INSERT INTO inventory_movements VALUES(2,'purchase',1,10)"); });
  purchase(); assert.throws(purchase);
  const customerReturn = () => transactional(db, () => { const returned = Number(db.prepare('SELECT COALESCE(SUM(quantity),0) value FROM sale_return_items').get().value); if (returned >= 2) throw new Error('OVER_RETURN'); db.exec("INSERT INTO sale_returns VALUES(1,'return-1',1);INSERT INTO sale_return_items VALUES(1,1,2,1);UPDATE products SET stock=stock+1 WHERE id=1;INSERT INTO inventory_movements VALUES(3,'return',1,1)"); });
  customerReturn(); assert.throws(customerReturn, /OVER_RETURN/);
  const supplierReturn = () => transactional(db, () => { const returned = Number(db.prepare('SELECT COALESCE(SUM(quantity),0) value FROM purchase_return_items').get().value); if (returned >= 10) throw new Error('OVER_RETURN'); db.exec("INSERT INTO purchase_returns VALUES(1,'supplier-return-1',1);INSERT INTO purchase_return_items VALUES(1,1,10);UPDATE products SET stock=stock-10 WHERE id=1;INSERT INTO inventory_movements VALUES(4,'purchase_return',1,-10)"); });
  supplierReturn(); assert.throws(supplierReturn, /OVER_RETURN/);
  const close = () => transactional(db, () => { const changed = db.prepare("UPDATE cash_sessions SET closed_at='x',expected_syp=100,actual_syp=100 WHERE id=1 AND closed_at IS NULL").run(); if (changed.changes !== 1) throw new Error('ALREADY_CLOSED'); });
  close(); assert.throws(close, /ALREADY_CLOSED/);
  assert.deepEqual({ sales:Number(db.prepare('SELECT COUNT(*) count FROM sales').get().count), purchases:Number(db.prepare('SELECT COUNT(*) count FROM purchase_receipts').get().count), returns:Number(db.prepare('SELECT COUNT(*) count FROM sale_returns').get().count), supplierReturns:Number(db.prepare('SELECT COUNT(*) count FROM purchase_returns').get().count), movements:Number(db.prepare('SELECT COUNT(*) count FROM inventory_movements').get().count), stock:Number(db.prepare('SELECT stock FROM products').get().stock) }, { sales:1,purchases:1,returns:1,supplierReturns:1,movements:4,stock:99 });
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});
