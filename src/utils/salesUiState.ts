export type QuantityLine = { productId: number | null; quantity: number; unitPriceSyp: number; cartKey?: string };

const lineKey = (line: QuantityLine) => line.cartKey ?? `product:${line.productId}`;

export function addCartLine<T extends QuantityLine>(cart: T[], line: T) {
  const key = lineKey(line);
  const existing = cart.some(item => lineKey(item) === key);
  if (existing) return cart.map(item => lineKey(item) === key ? { ...item, quantity: Math.min(999, item.quantity + line.quantity) } : item);
  return [...cart, { ...line, quantity: Math.max(1, Math.min(999, line.quantity)) }];
}

export function setCartLineQuantity<T extends QuantityLine>(cart: T[], key: string | number, quantity: number) {
  const nextQuantity = Math.max(0, Math.min(999, quantity));
  return cart.map(line => (lineKey(line) === key || line.productId === key) ? { ...line, quantity: nextQuantity } : line).filter(line => line.quantity > 0);
}

export function changeCartLineQuantity<T extends QuantityLine>(cart: T[], key: string | number, delta: number) {
  return cart.map(line => (lineKey(line) === key || line.productId === key) ? { ...line, quantity: Math.max(0, Math.min(999, line.quantity + delta)) } : line).filter(line => line.quantity > 0);
}

export function calculateCartSubtotal(cart: QuantityLine[]) {
  return cart.reduce((sum, line) => sum + line.unitPriceSyp * line.quantity, 0);
}

export function clampCartDiscount(discount: number, subtotal: number) {
  return Number.isFinite(discount) ? Math.max(0, Math.min(discount, subtotal)) : 0;
}

export function parseLocalizedNumber(value: string) {
  const normalized = value.replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))).replace(/[٬,\s]/g, '').replace('٫', '.');
  return Number(normalized);
}

export type PaymentCalculation =
  | { valid: true; amountPaidSyp: number; changeSyp: number }
  | { valid: false; reason: 'invalid' | 'negative' | 'insufficient' };

export function calculatePayment(totalSyp: number, rawAmount: string, exactPayment: boolean): PaymentCalculation {
  const amount = exactPayment ? totalSyp : parseLocalizedNumber(rawAmount);
  if (!Number.isFinite(amount)) return { valid: false, reason: 'invalid' };
  if (amount < 0) return { valid: false, reason: 'negative' };
  if (amount < totalSyp) return { valid: false, reason: 'insufficient' };
  return { valid: true, amountPaidSyp: amount, changeSyp: amount - totalSyp };
}

export function paymentSuggestions(totalSyp: number) {
  if (!Number.isFinite(totalSyp) || totalSyp <= 0) return [];
  const magnitudes = totalSyp < 10_000 ? [1_000, 5_000, 10_000] : totalSyp < 100_000 ? [5_000, 10_000, 25_000, 50_000] : [10_000, 25_000, 50_000, 100_000];
  const values = magnitudes.map(step => Math.ceil(totalSyp / step) * step).filter(value => value >= totalSyp);
  return [...new Set(values)].slice(0, 3);
}
