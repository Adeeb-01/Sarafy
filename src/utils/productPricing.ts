import type { Product, ProductPricingCurrency, SaleItemInput, Settings } from '@/types';

export type ExactDecimal = { canonical: string; numerator: bigint; denominator: bigint; decimalPlaces: number };

function expandExponent(value: string) {
  const match = value.match(/^(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/);
  if (!match) return value;
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  const exponent = Number(match[3]);
  const digits = `${whole}${fraction}`;
  const point = whole.length + exponent;
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${digits}${'0'.repeat(point - digits.length)}`;
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function parseCanonicalDecimal(input: string): ExactDecimal {
  const expanded = expandExponent(input.trim());
  if (!/^\d+(?:\.\d+)?$/.test(expanded)) throw new Error('INVALID_PRODUCT_USD_DECIMAL');
  const [wholeRaw = '0', fractionRaw = ''] = expanded.split('.');
  const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0';
  const fraction = fractionRaw.replace(/0+$/, '');
  const canonical = fraction ? `${whole}.${fraction}` : whole;
  const denominator = 10n ** BigInt(fraction.length);
  return { canonical, numerator: BigInt(`${whole}${fraction}`), denominator, decimalPlaces: fraction.length };
}

export function canonicalizeLegacyUsdNumber(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error('INVALID_PRODUCT_USD_VALUE');
  return parseCanonicalDecimal(value.toString()).canonical;
}

export function validateNewUsdDecimal(input: string, maxDecimalPlaces = 4) {
  const parsed = parseCanonicalDecimal(input);
  const expanded = expandExponent(input.trim());
  const fraction = expanded.split('.')[1] ?? '';
  if (fraction.length > maxDecimalPlaces) throw new Error('PRODUCT_USD_PRECISION_EXCEEDED');
  return parsed;
}

export function roundHalfUpRatio(numerator: bigint, denominator: bigint) {
  if (numerator < 0n || denominator <= 0n) throw new Error('INVALID_PRICING_RATIO');
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function safeNumber(value: bigint) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('PRODUCT_PRICING_UNSAFE_INTEGER');
  return result;
}

export function roundExactToTargetHalfUp(numerator: bigint, denominator: bigint, target: number) {
  if (!Number.isSafeInteger(target) || target <= 0) throw new Error('INVALID_ROUNDING_TARGET');
  return safeNumber(roundHalfUpRatio(numerator, denominator * BigInt(target)) * BigInt(target));
}

export function resolveUsdSalePriceSyp(nativeDecimal: string, exchangeRate: number, roundingEnabled: boolean, roundingTarget: number) {
  if (!Number.isSafeInteger(exchangeRate) || exchangeRate <= 0) throw new Error('INVALID_EXCHANGE_RATE');
  const parsed = parseCanonicalDecimal(nativeDecimal);
  return roundExactToTargetHalfUp(parsed.numerator * BigInt(exchangeRate), parsed.denominator, roundingEnabled ? roundingTarget : 1);
}

export function resolveUsdOperationalLineCostSyp(nativeDecimal: string, exchangeRate: number, quantity: number) {
  if (!Number.isSafeInteger(exchangeRate) || exchangeRate <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('INVALID_PRODUCT_COST_RESOLUTION');
  const parsed = parseCanonicalDecimal(nativeDecimal);
  return safeNumber(roundHalfUpRatio(parsed.numerator * BigInt(exchangeRate) * BigInt(quantity), parsed.denominator));
}

export function resolveSypLineCostSyp(nativeSyp: number, quantity: number) {
  if (!Number.isSafeInteger(nativeSyp) || nativeSyp < 0 || !Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('INVALID_PRODUCT_COST_RESOLUTION');
  return safeNumber(BigInt(nativeSyp) * BigInt(quantity));
}

export function activeSalePriceSyp(product: Product, settings: Pick<Settings, 'exchangeRate' | 'isRoundingEnabled' | 'roundingTarget'>) {
  if (product.sale_price_currency === 'SYP') {
    if (!Number.isSafeInteger(product.sale_price_syp) || (product.sale_price_syp ?? -1) < 0) throw new Error('INVALID_PRODUCT_SALE_PRICE');
    return product.sale_price_syp as number;
  }
  return resolveUsdSalePriceSyp(canonicalizeLegacyUsdNumber(product.price_usd), settings.exchangeRate, settings.isRoundingEnabled, settings.roundingTarget);
}

export function activeUnitCostPreviewSyp(product: Product, exchangeRate: number) {
  if (product.cost_currency === 'SYP') {
    if (!Number.isSafeInteger(product.cost_syp) || (product.cost_syp ?? -1) < 0) throw new Error('INVALID_PRODUCT_COST');
    return product.cost_syp as number;
  }
  return resolveUsdOperationalLineCostSyp(canonicalizeLegacyUsdNumber(product.cost_usd), exchangeRate, 1);
}

export function buildProductPricingSnapshot(product: Product, exchangeRate: number, settings: Pick<Settings, 'isRoundingEnabled' | 'roundingTarget'>): Pick<SaleItemInput,
  'unitPriceSyp' | 'unitCostSyp' | 'salePriceSourceCurrency' | 'salePriceNativeDecimal' | 'salePriceNativeSyp' |
  'salePriceExchangeRate' | 'salePriceRoundingEnabled' | 'salePriceRoundingTarget' | 'costSourceCurrency' |
  'costNativeDecimal' | 'costNativeSyp' | 'costExchangeRate'> {
  const saleCurrency: ProductPricingCurrency = product.sale_price_currency ?? 'USD';
  const costCurrency: ProductPricingCurrency = product.cost_currency ?? 'USD';
  const saleNativeDecimal = saleCurrency === 'USD' ? canonicalizeLegacyUsdNumber(product.price_usd) : null;
  const saleNativeSyp = saleCurrency === 'SYP' ? product.sale_price_syp : null;
  const costNativeDecimal = costCurrency === 'USD' ? canonicalizeLegacyUsdNumber(product.cost_usd) : null;
  const costNativeSyp = costCurrency === 'SYP' ? product.cost_syp : null;
  const unitPriceSyp = saleCurrency === 'SYP'
    ? resolveSypLineCostSyp(saleNativeSyp ?? -1, 1)
    : resolveUsdSalePriceSyp(saleNativeDecimal ?? '', exchangeRate, settings.isRoundingEnabled, settings.roundingTarget);
  const unitCostSyp = costCurrency === 'SYP'
    ? resolveSypLineCostSyp(costNativeSyp ?? -1, 1)
    : resolveUsdOperationalLineCostSyp(costNativeDecimal ?? '', exchangeRate, 1);
  return {
    unitPriceSyp, unitCostSyp,
    salePriceSourceCurrency: saleCurrency,
    salePriceNativeDecimal: saleNativeDecimal,
    salePriceNativeSyp: saleNativeSyp,
    salePriceExchangeRate: saleCurrency === 'USD' ? exchangeRate : null,
    salePriceRoundingEnabled: saleCurrency === 'USD' ? settings.isRoundingEnabled : null,
    salePriceRoundingTarget: saleCurrency === 'USD' ? settings.roundingTarget : null,
    costSourceCurrency: costCurrency,
    costNativeDecimal,
    costNativeSyp,
    costExchangeRate: costCurrency === 'USD' ? exchangeRate : null,
  };
}

export function resolveSaleItemLineCostSyp(item: SaleItemInput) {
  if (item.costSourceCurrency === 'USD' && item.costNativeDecimal != null && item.costExchangeRate != null) {
    return resolveUsdOperationalLineCostSyp(item.costNativeDecimal, item.costExchangeRate, item.quantity);
  }
  if (item.costSourceCurrency === 'SYP' && item.costNativeSyp != null) return resolveSypLineCostSyp(item.costNativeSyp, item.quantity);
  const legacy = Math.round(item.unitCostSyp * item.quantity);
  if (!Number.isSafeInteger(legacy) || legacy < 0) throw new Error('INVALID_SALE_DATA');
  return legacy;
}

export function validatePricingSnapshot(item: SaleItemInput) {
  const hasSaleSnapshot = item.salePriceSourceCurrency != null;
  const hasCostSnapshot = item.costSourceCurrency != null;
  if (hasSaleSnapshot !== hasCostSnapshot) throw new Error('INCOMPLETE_PRODUCT_PRICING_SNAPSHOT');
  if (item.salePriceSourceCurrency === 'USD') {
    if (item.salePriceNativeDecimal == null || parseCanonicalDecimal(item.salePriceNativeDecimal).canonical !== item.salePriceNativeDecimal ||
      item.salePriceExchangeRate == null || item.salePriceRoundingEnabled == null || item.salePriceRoundingTarget == null ||
      item.salePriceNativeSyp != null ||
      resolveUsdSalePriceSyp(item.salePriceNativeDecimal, item.salePriceExchangeRate, item.salePriceRoundingEnabled, item.salePriceRoundingTarget) !== item.unitPriceSyp) throw new Error('INVALID_SALE_PRICE_SNAPSHOT');
  } else if (item.salePriceSourceCurrency === 'SYP') {
    if (!Number.isSafeInteger(item.salePriceNativeSyp) || (item.salePriceNativeSyp ?? -1) < 0 || item.salePriceNativeSyp !== item.unitPriceSyp ||
      item.salePriceNativeDecimal != null || item.salePriceExchangeRate != null || item.salePriceRoundingEnabled != null || item.salePriceRoundingTarget != null) throw new Error('INVALID_SALE_PRICE_SNAPSHOT');
  }
  if (item.costSourceCurrency === 'USD') {
    if (item.costNativeDecimal == null || parseCanonicalDecimal(item.costNativeDecimal).canonical !== item.costNativeDecimal || item.costExchangeRate == null || item.costNativeSyp != null) throw new Error('INVALID_COST_SNAPSHOT');
  } else if (item.costSourceCurrency === 'SYP') {
    if (item.costNativeSyp == null || item.costNativeDecimal != null || item.costExchangeRate != null) throw new Error('INVALID_COST_SNAPSHOT');
  }
  return resolveSaleItemLineCostSyp(item);
}
