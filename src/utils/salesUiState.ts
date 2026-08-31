export type QuantityLine = { productId: number; quantity: number; unitPriceSyp: number };

export function addCartLine<T extends QuantityLine>(cart: T[], line: T) {
  const existing = cart.some(item => item.productId === line.productId);
  if (existing) return cart.map(item => item.productId === line.productId ? { ...item, quantity: Math.min(999, item.quantity + 1) } : item);
  return [...cart, { ...line, quantity: 1 }];
}

export function setCartLineQuantity<T extends QuantityLine>(cart: T[], productId: number, quantity: number) {
  const nextQuantity = Math.max(0, Math.min(999, quantity));
  return cart.map(line => line.productId === productId ? { ...line, quantity: nextQuantity } : line).filter(line => line.quantity > 0);
}

export function changeCartLineQuantity<T extends QuantityLine>(cart: T[], productId: number, delta: number) {
  return cart.map(line => line.productId === productId ? { ...line, quantity: Math.max(0, Math.min(999, line.quantity + delta)) } : line).filter(line => line.quantity > 0);
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
