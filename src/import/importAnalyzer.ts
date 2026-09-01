import { getDatabase } from '@/database/database';
import { ImportIssue, ImportOptions, ImportPayload, ImportPreview } from './importTypes';
import { isUuid } from '@/utils/uuid';
import { normalizeBarcode } from '@/utils/barcode';

const emptySummary = () => ({
  newRecords: 0, updatedRecords: 0, unchangedRecords: 0, conflicts: 0,
  duplicates: 0, invalidRecords: 0, newImages: 0, missingImages: 0, replacedImages: 0,
});

function comparable(value: object) {
  const copy = { ...value } as Record<string, unknown>;
  delete copy.id;
  delete copy.updated_at;
  return JSON.stringify(copy);
}

export async function analyzeImport(payload: ImportPayload, options: ImportOptions): Promise<ImportPreview> {
  const db = await getDatabase();
  const summary = emptySummary();
  const issues: ImportIssue[] = [];
  const analyze = async (entity: 'products' | 'sales' | 'expenses', records: Array<{ uuid: string; updated_at: string }>) => {
    if (!options.entities.includes(entity)) return;
    const local = await db.getAllAsync<Record<string, unknown> & { uuid: string; updated_at: string }>(`SELECT * FROM ${entity}`);
    const byUuid = new Map(local.map(row => [row.uuid, row]));
    const seen = new Set<string>();
    records.forEach((record, index) => {
      if (!isUuid(record.uuid)) {
        summary.invalidRecords += 1;
        issues.push({ entity, row: index + 1, field: 'uuid', value: String(record.uuid), code: 'INVALID_UUID', action: 'rejected' });
        return;
      }
      if (seen.has(record.uuid)) {
        summary.duplicates += 1;
        issues.push({ entity, row: index + 1, field: 'uuid', value: record.uuid, code: 'DUPLICATE_UUID', action: 'skipped' });
        return;
      }
      seen.add(record.uuid);
      const existing = byUuid.get(record.uuid);
      if (!existing) { summary.newRecords += 1; return; }
      if (comparable(existing) === comparable(record)) { summary.unchangedRecords += 1; return; }
      if (options.conflictStrategy === 'manual' || (
        options.conflictStrategy === 'newest' &&
        (!record.updated_at || !existing.updated_at)
      )) {
        summary.conflicts += 1;
        issues.push({ entity, row: index + 1, code: 'REVIEW_REQUIRED', action: 'review' });
      } else summary.updatedRecords += 1;
    });
  };
  if (options.entities.includes('products')) {
    const localProducts = await db.getAllAsync<Record<string, unknown> & { uuid: string; barcode: string | null; updated_at: string }>('SELECT * FROM products');
    const byUuid = new Map(localProducts.map(row => [row.uuid, row]));
    const byBarcode = new Map(localProducts.flatMap(row => { const barcode = normalizeBarcode(row.barcode); return barcode ? [[barcode, row] as const] : []; }));
    const seen = new Set<string>();
    payload.products.forEach((product, index) => {
      if (!isUuid(product.uuid)) {
        summary.invalidRecords += 1;
        issues.push({ entity: 'products', row: index + 1, field: 'uuid', code: 'INVALID_UUID', action: 'rejected' });
        return;
      }
      if (seen.has(product.uuid)) {
        summary.duplicates += 1;
        issues.push({ entity: 'products', row: index + 1, field: 'uuid', code: 'DUPLICATE_UUID', action: 'rejected' });
        return;
      }
      seen.add(product.uuid);
      const barcode = normalizeBarcode(product.barcode);
      const existingByUuid = byUuid.get(product.uuid);
      const existingByBarcode = barcode ? byBarcode.get(barcode) : undefined;
      if (existingByUuid && existingByBarcode && existingByUuid.uuid !== existingByBarcode.uuid) {
        summary.conflicts += 1;
        issues.push({ entity: 'products', row: index + 1, field: 'barcode', value: barcode ?? '', code: 'DUPLICATE_BARCODE', action: 'review' });
        return;
      }
      const existing = existingByUuid ?? existingByBarcode;
      if (!existing) summary.newRecords += 1;
      else if (comparable(existing) === comparable(product)) summary.unchangedRecords += 1;
      else if (options.conflictStrategy === 'manual' ||
        (options.conflictStrategy === 'newest' &&
          (!Number.isFinite(Date.parse(product.updated_at)) || !Number.isFinite(Date.parse(existing.updated_at))))) {
        summary.conflicts += 1;
        issues.push({ entity: 'products', row: index + 1, code: 'REVIEW_REQUIRED', action: 'review' });
      } else summary.updatedRecords += 1;
    });
  }
  const barcodeRows = payload.products.map((product, index) => ({ product, index, barcode: normalizeBarcode(product.barcode) })).filter(row => !!row.barcode);
  const barcodeCounts = new Map<string, number>();
  barcodeRows.forEach(row => barcodeCounts.set(row.barcode ?? '', (barcodeCounts.get(row.barcode ?? '') ?? 0) + 1));
  barcodeRows.forEach(row => {
    if ((barcodeCounts.get(row.barcode ?? '') ?? 0) > 1) {
      summary.conflicts += 1;
      issues.push({ entity: 'products', row: row.index + 1, field: 'barcode', value: row.barcode ?? '', code: 'DUPLICATE_BARCODE', action: 'review' });
    }
  });
  await analyze('sales', payload.sales);
  if (options.entities.includes('sale_items')) {
    const seenItems = new Set<string>();
    let itemRow = 0;
    for (const sale of payload.sales) {
      for (const item of sale.items) {
        itemRow += 1;
        if (!isUuid(item.uuid)) {
          summary.invalidRecords += 1;
          issues.push({ entity: 'sale_items', row: itemRow, field: 'uuid', code: 'INVALID_UUID', action: 'rejected' });
        } else if (seenItems.has(item.uuid)) {
          summary.duplicates += 1;
          issues.push({ entity: 'sale_items', row: itemRow, field: 'uuid', code: 'DUPLICATE_UUID', action: 'rejected' });
        }
        seenItems.add(item.uuid);
      }
    }
  }
  await analyze('expenses', payload.expenses);
  if (options.entities.includes('sale_returns')) {
    const localReturns = new Set((await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM sale_returns')).map(row => row.uuid));
    const localSales = new Set((await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM sales')).map(row => row.uuid));
    const localItems = new Set((await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM sale_items')).map(row => row.uuid));
    const payloadSales = new Set(payload.sales.map(sale => sale.uuid));
    const payloadItems = new Set(payload.sales.flatMap(sale => sale.items.map(item => item.uuid)));
    const seen = new Set<string>();
    (payload.returns ?? []).forEach((record, index) => {
      if (seen.has(record.uuid)) { summary.duplicates += 1; issues.push({ entity: 'sale_returns', row: index + 1, code: 'DUPLICATE_UUID', action: 'rejected' }); return; }
      seen.add(record.uuid);
      if (localReturns.has(record.uuid)) { summary.unchangedRecords += 1; return; }
      if (!localSales.has(record.sale_uuid) && !payloadSales.has(record.sale_uuid)) {
        summary.conflicts += 1; issues.push({ entity: 'sale_returns', row: index + 1, field: 'sale_uuid', code: 'RETURN_PARENT_MISSING', action: 'review' }); return;
      }
      const missingItem = record.items.find(item => !localItems.has(item.sale_item_uuid) && !payloadItems.has(item.sale_item_uuid));
      if (missingItem) { summary.conflicts += 1; issues.push({ entity: 'sale_return_items', row: index + 1, field: 'sale_item_uuid', value: missingItem.sale_item_uuid, code: 'RETURN_ITEM_PARENT_MISSING', action: 'review' }); return; }
      summary.newRecords += 1 + record.items.length;
    });
  }
  if (options.entities.includes('categories')) {
    const local = new Set((await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM categories')).map(row => row.uuid));
    const seen = new Set<string>();
    payload.categories.forEach((category, index) => {
      if (!isUuid(category.uuid)) {
        summary.invalidRecords += 1;
        issues.push({ entity: 'categories', row: index + 1, field: 'uuid', code: 'INVALID_UUID', action: 'rejected' });
      } else if (seen.has(category.uuid)) summary.duplicates += 1;
      else if (local.has(category.uuid)) summary.unchangedRecords += 1;
      else summary.newRecords += 1;
      seen.add(category.uuid);
    });
  }
  return { summary, issues, payload, options };
}
