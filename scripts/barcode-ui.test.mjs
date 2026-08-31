import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createProductBarcodeMap, findBarcodeConflict, findProductByExactBarcode, normalizeBarcode } from '../src/utils/barcode.ts';
import { BARCODE_SCAN_COOLDOWN_MS, createBarcodeScanGate } from '../src/utils/barcodeScanGate.ts';
import { addCartLine, calculateCartSubtotal } from '../src/utils/salesUiState.ts';

test('barcode normalization trims only outer whitespace and preserves empty, zeros, case, and alphanumeric data', () => {
  assert.equal(normalizeBarcode(' 00123 '), '00123');
  assert.equal(normalizeBarcode('ABC-001'), 'ABC-001');
  assert.equal(normalizeBarcode(' AbC '), 'AbC');
  assert.equal(normalizeBarcode('   '), null);
  assert.equal(normalizeBarcode(null), null);
});

test('scan gate rejects duplicate frames, unlocks different barcodes promptly, and rearms the same barcode after 800ms', () => {
  const gate = createBarcodeScanGate();
  assert.equal(gate.begin('A', 0), 'A');
  assert.equal(gate.begin('A', 1), null, 'processing lock blocks callbacks');
  gate.complete('A', 10);
  assert.equal(gate.begin('A', 700), null);
  assert.equal(gate.begin('B', 701), 'B', 'a different barcode is accepted promptly');
  gate.complete('B', 702);
  assert.equal(gate.begin('A', 703), 'A', 'the first barcode can be intentionally scanned after another item');
  gate.complete('A', 704);
  assert.equal(gate.begin('A', 800), null);
  assert.equal(gate.begin('A', 1601), 'A', 'same barcode rearms after it has not been observed for the cooldown');
  gate.complete('A', 1602);
  assert.equal(gate.begin(' ', 9999), null);
});

test('product barcode conflicts allow blank and same-product edits but reject create/edit collisions', () => {
  const products = [{ id: 1, name: 'A', barcode: '00123' }, { id: 2, name: 'B', barcode: null }];
  assert.equal(findBarcodeConflict(products, null), undefined);
  assert.equal(findBarcodeConflict(products, 'UNIQUE'), undefined);
  assert.equal(findBarcodeConflict(products, '00123')?.name, 'A');
  assert.equal(findBarcodeConflict(products, '00123', 1), undefined);
  assert.equal(findBarcodeConflict(products, '00123', 2)?.name, 'A');
});

test('exact scan lookup never returns a partial barcode match', () => {
  const map = createProductBarcodeMap([{ name: 'Long', barcode: '12345' }, { name: 'Exact', barcode: '123' }]);
  assert.equal(findProductByExactBarcode(map, '123')?.name, 'Exact');
  assert.equal(findProductByExactBarcode(new Map([['12345', { name: 'Long', barcode: '12345' }]]), '123'), undefined);
});

test('cashier scan sequence increments known items while unknown and inactive scans leave cart unchanged', () => {
  const activeA = { id: 1, name: 'A', barcode: 'A', is_active: 1, price: 10 };
  const activeB = { id: 2, name: 'B', barcode: 'B', is_active: 1, price: 20 };
  const inactive = { id: 3, name: 'Off', barcode: 'OFF', is_active: 0, price: 30 };
  const lookup = createProductBarcodeMap([activeA, activeB, inactive]);
  let cart = [];
  const scan = barcode => {
    const product = findProductByExactBarcode(lookup, barcode);
    if (!product || product.is_active === 0) return;
    cart = addCartLine(cart, { productId: product.id, quantity: 1, unitPriceSyp: product.price });
  };
  scan('A'); scan('B'); scan('A');
  assert.deepEqual(cart.map(line => [line.productId, line.quantity]), [[1, 2], [2, 1]]);
  const before = structuredClone(cart);
  scan('UNKNOWN'); scan('OFF');
  assert.deepEqual(cart, before);
  assert.equal(calculateCartSubtotal(cart), 40);
});

test('10k exact barcode lookup is O(1)-shaped and responsive', () => {
  const products = Array.from({ length: 10_000 }, (_, index) => ({ id: index, barcode: `BC-${index}` }));
  const started = performance.now();
  const map = createProductBarcodeMap(products);
  for (let index = 0; index < 10_000; index += 1) assert.equal(findProductByExactBarcode(map, `BC-${index}`)?.id, index);
  const elapsed = performance.now() - started;
  console.log(`barcode_lookup_10k_build_and_reads_ms=${elapsed.toFixed(2)}`);
  assert.ok(elapsed < 500);
});

test('native and shared scanner configuration include camera, exclude audio, and avoid QR', async () => {
  const [manifest, appJson, scanner, database, form, management, analyzer] = await Promise.all([
    readFile(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8'),
    readFile(new URL('../app.json', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/barcode/BarcodeScannerScreen.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/database/database.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/ProductFormModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/ProductManagementScreen.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/import/importAnalyzer.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(manifest, /android\.permission\.CAMERA/);
  assert.match(manifest, /android\.permission\.RECORD_AUDIO" tools:node="remove/);
  assert.match(appJson, /"recordAudioAndroid": false/);
  assert.doesNotMatch(scanner, /['"]qr['"]/);
  assert.match(scanner, /if \(!visible\) return null/);
  assert.match(database, /withExclusiveTransactionAsync/);
  assert.match(database, /WHERE barcode = \? AND id <> \?/);
  assert.doesNotMatch(form, /keyboardType="numeric"/);
  assert.match(management, /product\.barcode === exactScanBarcode/);
  assert.match(analyzer, /existingByUuid\.uuid !== existingByBarcode\.uuid/);
});
