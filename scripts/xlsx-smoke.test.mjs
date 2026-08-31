import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';

test('SheetJS 0.20.3 preserves Sarafy workbook data through write/read', () => {
  assert.equal(XLSX.version, '0.20.3');
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet([
    { name: 'منتج تجريبي', category: 'اختبار', price_usd: 12.5, barcode: '0012345678905' },
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Products');

  const base64 = XLSX.write(workbook, { bookType: 'xlsx', type: 'base64' });
  const restored = XLSX.read(base64, { type: 'base64' });
  const rows = XLSX.utils.sheet_to_json(restored.Sheets.Products, { raw: true });

  assert.deepEqual(rows, [{ name: 'منتج تجريبي', category: 'اختبار', price_usd: 12.5, barcode: '0012345678905' }]);
  assert.equal(restored.Sheets.Products.D2.t, 's');
});
