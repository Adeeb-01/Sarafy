import { Product, Sale, SaleItemInput, Settings } from '@/types';
import { calculateSypPrice } from '@/utils/priceCalculator';
import { addCartLine } from '@/utils/salesUiState';

export type RepeatCartLine = SaleItemInput & { cartKey: string; isAvailable: boolean };

export function buildRepeatedSaleCart(existingCart: RepeatCartLine[], sale: Sale, products: Product[], settings: Settings) {
  const productsById = new Map(products.map(product => [product.id, product]));
  let cart = existingCart;
  let addedProducts = 0;
  const unavailableNames: string[] = [];
  for (const item of sale.items) {
    const product = item.product_id == null ? undefined : productsById.get(item.product_id);
    if (!product || product.is_active === 0) {
      unavailableNames.push(item.product_name);
      continue;
    }
    cart = addCartLine(cart, {
      productId: product.id,
      cartKey: `product:${product.id}`,
      productName: product.name,
      barcodeSnapshot: product.barcode,
      isAvailable: true,
      quantity: item.quantity,
      unitPriceSyp: calculateSypPrice({ priceUsd: product.price_usd, exchangeRate: settings.exchangeRate, isRoundingEnabled: settings.isRoundingEnabled, roundingTarget: settings.roundingTarget }),
      unitCostSyp: product.cost_usd * settings.exchangeRate,
    });
    addedProducts += 1;
  }
  return { cart, addedProducts, unavailableNames };
}
