import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
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
