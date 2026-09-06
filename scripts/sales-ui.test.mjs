import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { calculateCartSubtotal, changeCartLineQuantity, clampCartDiscount, isCartLineUnavailable, parseLocalizedNumber, setCartLineQuantity } from '../src/utils/salesUiState.ts';

const makeCart = count => Array.from({ length: count }, (_, index) => ({ productId: index + 1, quantity: 1, unitPriceSyp: (index + 1) * 100 }));

for (const count of [1, 10, 50]) {
  test(`cart totals stay deterministic with ${count} item${count === 1 ? '' : 's'}`, () => {
    const cart = makeCart(count);
    const expected = 100 * count * (count + 1) / 2;
    assert.equal(calculateCartSubtotal(cart), expected);
    assert.equal(cart.length, count);
  });
}

test('rapid repeated quantity updates do not lose increments and zero removes the line', () => {
  let cart = makeCart(1);
  for (let index = 0; index < 250; index += 1) cart = changeCartLineQuantity(cart, 1, 1);
  assert.equal(cart[0]?.quantity, 251);
  for (let index = 0; index < 251; index += 1) cart = changeCartLineQuantity(cart, 1, -1);
  assert.deepEqual(cart, []);
  assert.equal(setCartLineQuantity(makeCart(1), 1, 1_500)[0]?.quantity, 999);
});

test('localized number input and fixed SYP discount retain existing clamp behavior', () => {
  assert.equal(parseLocalizedNumber('١٥٬٥٠٠'), 15_500);
  assert.equal(parseLocalizedNumber('15,500'), 15_500);
  assert.equal(clampCartDiscount(-10, 1_000), 0);
  assert.equal(clampCartDiscount(1_500, 1_000), 1_000);
});

test('resumed cart line is blocked above current stock and becomes valid at the limit', () => {
  assert.equal(isCartLineUnavailable({ isAvailable: true, quantity: 8, availableQuantity: 5 }), true);
  assert.equal(isCartLineUnavailable({ isAvailable: true, quantity: 5, availableQuantity: 5 }), false);
  assert.equal(isCartLineUnavailable({ isAvailable: false, quantity: 1 }), true);
  assert.equal(isCartLineUnavailable({ isAvailable: true, quantity: 999 }), false);
});

test('completed invoice UI uses persisted snapshots and sale creation remains transactional', async () => {
  const [database, views, invoice] = await Promise.all([
    readFile(new URL('../src/database/database.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/sales/SalesViews.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/utils/invoice.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(database, /with(?:Exclusive)?TransactionAsync/);
  assert.match(database, /INSERT INTO sale_items/);
  assert.match(database, /item\.productName/);
  assert.match(database, /item\.unitPriceSyp/);
  assert.match(database, /item\.unitCostSyp/);
  assert.match(views, /item\.product_name/);
  assert.match(views, /item\.unit_price_syp/);
  assert.match(views, /item\.unit_cost_syp/);
  assert.doesNotMatch(views, /state\.products/);
  assert.match(invoice, /item\.product_name/);
  assert.match(invoice, /item\.unit_price_syp/);
  assert.match(invoice, /item\.line_total_syp/);
  assert.doesNotMatch(invoice, /import\s+\{[^}]*\bProduct\b[^}]*\}\s+from/);
});
