import { getDatabase } from '@/database/database';
import { ImportIssue, ImportOptions, ImportPayload, ImportPreview } from './importTypes';
import { isUuid } from '@/utils/uuid';

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
    const byBarcode = new Map(localProducts.filter(row => !!row.barcode).map(row => [row.barcode as string, row]));
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
      const existing = byUuid.get(product.uuid) ?? (product.barcode ? byBarcode.get(product.barcode) : undefined);
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
  const barcodeRows = payload.products.filter(product => !!product.barcode);
  const barcodeCounts = new Map<string, number>();
  barcodeRows.forEach(product => barcodeCounts.set(product.barcode ?? '', (barcodeCounts.get(product.barcode ?? '') ?? 0) + 1));
  barcodeRows.forEach((product, index) => {
    if ((barcodeCounts.get(product.barcode ?? '') ?? 0) > 1) {
      summary.conflicts += 1;
      issues.push({ entity: 'products', row: index + 1, field: 'barcode', value: product.barcode ?? '', code: 'DUPLICATE_BARCODE', action: 'review' });
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
