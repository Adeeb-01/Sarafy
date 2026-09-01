import type { ReturnPreview, ReturnSelection, ReturnStatus, Sale, SaleItem, SaleReturn } from '@/types';

export function requireSafeInteger(value: number, code = 'RETURN_UNSAFE_INTEGER') {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

function toNumber(value: bigint) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('RETURN_UNSAFE_INTEGER');
  return result;
}

export function allocateInvoiceDiscount(sale: Pick<Sale, 'subtotal_syp' | 'discount_syp' | 'net_total_syp' | 'items'>) {
  const subtotal = requireSafeInteger(sale.subtotal_syp);
  const discount = requireSafeInteger(sale.discount_syp);
  requireSafeInteger(sale.net_total_syp);
  const lines = sale.items.map(item => ({ id: item.id, gross: requireSafeInteger(item.line_total_syp) }));
  if (lines.reduce((sum, line) => sum + line.gross, 0) !== subtotal || subtotal - discount !== sale.net_total_syp) {
    throw new Error('RETURN_INVOICE_TOTAL_MISMATCH');
  }
  if (subtotal === 0) {
    if (discount !== 0) throw new Error('RETURN_INVOICE_TOTAL_MISMATCH');
    return new Map(lines.map(line => [line.id, 0]));
  }
  const denominator = BigInt(subtotal);
  const ranked = lines.map(line => {
    const numerator = BigInt(discount) * BigInt(line.gross);
    return { ...line, share: numerator / denominator, remainder: numerator % denominator };
  });
  const baseTotal = ranked.reduce((sum, line) => sum + line.share, 0n);
  let residual = BigInt(discount) - baseTotal;
  ranked.sort((a, b) => a.remainder === b.remainder ? a.id - b.id : a.remainder > b.remainder ? -1 : 1);
  for (const line of ranked) {
    if (residual <= 0n) break;
    line.share += 1n;
    residual -= 1n;
  }
  return new Map(ranked.map(line => [line.id, toNumber(line.share)]));
}

export function cumulativeAmount(total: number, soldQuantity: number, beforeQuantity: number, currentQuantity: number) {
  requireSafeInteger(total);
  requireSafeInteger(soldQuantity, 'RETURN_UNSAFE_QUANTITY');
  requireSafeInteger(beforeQuantity, 'RETURN_UNSAFE_QUANTITY');
  requireSafeInteger(currentQuantity, 'RETURN_UNSAFE_QUANTITY');
  if (soldQuantity <= 0 || currentQuantity <= 0 || beforeQuantity + currentQuantity > soldQuantity) throw new Error('RETURN_QUANTITY_EXCEEDED');
  const totalBig = BigInt(total);
  const soldBig = BigInt(soldQuantity);
  const before = totalBig * BigInt(beforeQuantity) / soldBig;
  const after = totalBig * BigInt(beforeQuantity + currentQuantity) / soldBig;
  return toNumber(after - before);
}

export function returnedQuantities(returns: SaleReturn[]) {
  const map = new Map<number, number>();
  for (const item of returns.flatMap(record => record.items)) {
    map.set(item.sale_item_id, (map.get(item.sale_item_id) ?? 0) + item.quantity);
  }
  return map;
}

export function deriveReturnStatus(items: SaleItem[], returns: SaleReturn[]): ReturnStatus {
  const quantities = returnedQuantities(returns);
  const returned = items.reduce((sum, item) => sum + (quantities.get(item.id) ?? 0), 0);
  if (returned <= 0) return 'none';
  return items.every(item => (quantities.get(item.id) ?? 0) >= item.quantity) ? 'full' : 'partial';
}

export function previewReturn(sale: Sale, selections: ReturnSelection[], previousReturns = sale.returns ?? []): ReturnPreview {
  const discounts = allocateInvoiceDiscount(sale);
  const previous = returnedQuantities(previousReturns);
  const seen = new Set<number>();
  const items = selections.filter(selection => selection.quantity > 0).map(selection => {
    if (seen.has(selection.saleItemId)) throw new Error('RETURN_DUPLICATE_ITEM');
    seen.add(selection.saleItemId);
    const item = sale.items.find(candidate => candidate.id === selection.saleItemId);
    if (!item) throw new Error('RETURN_ITEM_NOT_FOUND');
    const before = previous.get(item.id) ?? 0;
    const lineNet = requireSafeInteger(item.line_total_syp) - (discounts.get(item.id) ?? 0);
    return {
      saleItemId: item.id,
      quantity: selection.quantity,
      refundAmountSyp: cumulativeAmount(lineNet, item.quantity, before, selection.quantity),
      costReversalSyp: cumulativeAmount(requireSafeInteger(item.line_cost_syp), item.quantity, before, selection.quantity),
    };
  });
  if (!items.length) return { items: [], refundTotalSyp: 0, returnedCostSyp: 0 };
  return {
    items,
    refundTotalSyp: requireSafeInteger(items.reduce((sum, item) => sum + item.refundAmountSyp, 0)),
    returnedCostSyp: requireSafeInteger(items.reduce((sum, item) => sum + item.costReversalSyp, 0)),
  };
}
