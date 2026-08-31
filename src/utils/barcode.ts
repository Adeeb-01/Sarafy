import type { BarcodeType } from 'expo-camera';

export const SUPPORTED_RETAIL_BARCODE_TYPES: BarcodeType[] = [
  'ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'code93', 'itf14', 'codabar',
];

export function normalizeBarcode(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized || null;
}

export function findProductByExactBarcode<T extends { barcode: string | null }>(
  productsByBarcode: ReadonlyMap<string, T>,
  scannedValue: string,
): T | undefined {
  const barcode = normalizeBarcode(scannedValue);
  return barcode ? productsByBarcode.get(barcode) : undefined;
}

export function createProductBarcodeMap<T extends { barcode: string | null }>(products: readonly T[]) {
  const map = new Map<string, T>();
  products.forEach(product => {
    const barcode = normalizeBarcode(product.barcode);
    if (barcode && !map.has(barcode)) map.set(barcode, product);
  });
  return map;
}

export function findBarcodeConflict<T extends { id: number; barcode: string | null }>(
  products: readonly T[],
  value: string | null | undefined,
  excludedProductId?: number,
) {
  const barcode = normalizeBarcode(value);
  if (!barcode) return undefined;
  return products.find(product => product.id !== excludedProductId && normalizeBarcode(product.barcode) === barcode);
}
