import { getDatabase } from '@/database/database';
import { createPreImportBackup } from '@/backup/backupManager';
import { ImportOptions, ImportPayload, ImportPreview, ImportResult } from './importTypes';
import { isUuid } from '@/utils/uuid';
import { isStoredProductImagePath } from '@/media/productImageStorage';
import { normalizeBarcode } from '@/utils/barcode';

const SETTING_KEYS = ['exchangeRate', 'isRoundingEnabled', 'roundingTarget', 'language'] as const;

function shouldUseImported(localUpdated: string, importedUpdated: string, options: ImportOptions) {
  if (options.conflictStrategy === 'keep_local' || options.conflictStrategy === 'manual') return false;
  if (options.conflictStrategy === 'use_imported') return true;
  return Date.parse(importedUpdated) > Date.parse(localUpdated);
}

let importRunning = false;

async function executeImportInternal(preview: ImportPreview): Promise<ImportResult> {
  assertImportPayload(preview.payload);
  if (preview.summary.invalidRecords || preview.summary.duplicates ||
      preview.issues.some(issue => issue.code === 'DUPLICATE_BARCODE') ||
      (preview.options.conflictStrategy === 'manual' && preview.summary.conflicts)) {
    throw new Error('IMPORT_REQUIRES_REVIEW');
  }
  const backupId = await createPreImportBackup(`import:${preview.options.mode}`);
  if (!backupId) throw new Error('PRE_IMPORT_BACKUP_FAILED');
  const db = await getDatabase();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const { payload, options } = preview;
  await db.withExclusiveTransactionAsync(async transaction => {
    if (options.mode === 'full_restore') {
      await transaction.runAsync('DELETE FROM sale_items');
      await transaction.runAsync('DELETE FROM sales');
      await transaction.runAsync('DELETE FROM expenses');
      await transaction.runAsync('DELETE FROM products');
      await transaction.runAsync('DELETE FROM categories');
      if (options.entities.includes('settings')) await transaction.runAsync('DELETE FROM settings');
    }
    if (options.entities.includes('categories')) {
      for (const item of payload.categories) {
        const local = await transaction.getFirstAsync<{ uuid: string; updated_at: string }>(
          'SELECT uuid,updated_at FROM categories WHERE uuid=? OR name=? COLLATE NOCASE LIMIT 1',
          item.uuid, item.name,
        );
        if (!local) {
          await transaction.runAsync('INSERT INTO categories(uuid,name,created_at,updated_at) VALUES(?,?,?,?)', item.uuid, item.name, item.created_at, item.updated_at);
          inserted += 1;
        } else if (shouldUseImported(local.updated_at, item.updated_at, options)) {
          await transaction.runAsync('UPDATE categories SET name=?,updated_at=? WHERE uuid=?', item.name, item.updated_at, local.uuid);
          updated += 1;
        } else skipped += 1;
      }
    }
    const importedProductIds = new Map<number, string>();
    const localProductByImportedId = new Map<number, number>();
    if (options.entities.includes('products')) {
      for (const item of payload.products) {
        const barcode = normalizeBarcode(item.barcode);
        importedProductIds.set(item.id, item.uuid);
        const local = await transaction.getFirstAsync<{ id: number; uuid: string; updated_at: string }>(
          'SELECT id,uuid,updated_at FROM products WHERE uuid=? OR (barcode IS NOT NULL AND barcode=?) LIMIT 1',
          item.uuid, barcode,
        );
        if (!local) {
          const result = await transaction.runAsync(
            `INSERT INTO products(uuid,name,category,price_usd,cost_usd,image_uri,barcode,created_at,updated_at,is_active)
             VALUES(?,?,?,?,?,?,?,?,?,?)`,
            item.uuid, item.name, item.category, item.price_usd, item.cost_usd, item.image_uri,
            barcode, item.created_at, item.updated_at, item.is_active ?? 1,
          );
          localProductByImportedId.set(item.id, result.lastInsertRowId);
          inserted += 1;
        } else if (shouldUseImported(local.updated_at, item.updated_at, options)) {
          await transaction.runAsync(
            `UPDATE products SET name=?,category=?,price_usd=?,cost_usd=?,barcode=?,updated_at=?,is_active=? WHERE uuid=?`,
            item.name, item.category, item.price_usd, item.cost_usd, barcode,
            item.updated_at, item.is_active ?? 1, local.uuid,
          );
          localProductByImportedId.set(item.id, local.id);
          updated += 1;
        } else {
          localProductByImportedId.set(item.id, local.id);
          skipped += 1;
        }
      }
    }
    for (const [oldId, uuid] of importedProductIds) {
      if (localProductByImportedId.has(oldId)) continue;
      const row = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM products WHERE uuid=?', uuid);
      if (row) localProductByImportedId.set(oldId, row.id);
    }
    if (options.entities.includes('sales')) {
      for (const sale of payload.sales) {
        const local = await transaction.getFirstAsync<{ id: number; updated_at: string }>('SELECT id,updated_at FROM sales WHERE uuid=?', sale.uuid);
        let saleId = local?.id;
        let saleWasInserted = false;
        if (!local) {
          const invoiceCollision = await transaction.getFirstAsync<{ uuid: string }>('SELECT uuid FROM sales WHERE invoice_number=?', sale.invoice_number);
          const invoiceNumber = invoiceCollision && invoiceCollision.uuid !== sale.uuid
            ? `${sale.invoice_number}-${sale.uuid.slice(0, 8)}`
            : sale.invoice_number;
          const result = await transaction.runAsync(
            `INSERT INTO sales(uuid,invoice_number,exchange_rate,subtotal_syp,discount_syp,net_total_syp,cost_syp,profit_syp,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?)`,
            sale.uuid, invoiceNumber, sale.exchange_rate, sale.subtotal_syp, sale.discount_syp,
            sale.net_total_syp, sale.cost_syp, sale.profit_syp, sale.created_at, sale.updated_at,
          );
          saleId = result.lastInsertRowId; saleWasInserted = true; inserted += 1;
        } else skipped += 1; // Completed invoices are immutable snapshots.
        if (saleId && saleWasInserted && options.entities.includes('sale_items')) {
          for (const item of sale.items) {
            const exists = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM sale_items WHERE uuid=?', item.uuid);
            if (exists) { skipped += 1; continue; }
            await transaction.runAsync(
              `INSERT INTO sale_items(uuid,sale_id,product_id,product_name,quantity,unit_price_syp,unit_cost_syp,line_total_syp,line_cost_syp,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
              item.uuid, saleId, item.product_id ? localProductByImportedId.get(item.product_id) ?? null : null,
              item.product_name, item.quantity, item.unit_price_syp, item.unit_cost_syp,
              item.line_total_syp, item.line_cost_syp, item.created_at, item.updated_at,
            );
            inserted += 1;
          }
        }
      }
    }
    if (options.entities.includes('expenses')) {
      for (const item of payload.expenses) {
        const local = await transaction.getFirstAsync<{ updated_at: string }>('SELECT updated_at FROM expenses WHERE uuid=?', item.uuid);
        if (!local) {
          await transaction.runAsync('INSERT INTO expenses(uuid,description,amount_syp,created_at,updated_at) VALUES(?,?,?,?,?)', item.uuid, item.description, item.amount_syp, item.created_at, item.updated_at);
          inserted += 1;
        } else if (shouldUseImported(local.updated_at, item.updated_at, options)) {
          await transaction.runAsync('UPDATE expenses SET description=?,amount_syp=?,updated_at=? WHERE uuid=?', item.description, item.amount_syp, item.updated_at, item.uuid);
          updated += 1;
        } else skipped += 1;
      }
    }
    if (options.entities.includes('settings') && options.importSettings) {
      for (const key of SETTING_KEYS) {
        await transaction.runAsync(
          'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          key, JSON.stringify(payload.settings[key]),
        );
      }
    }
    const fk = await transaction.getAllAsync<{ table: string; rowid: number }>('PRAGMA foreign_key_check');
    if (fk.length) throw new Error('FOREIGN_KEY_CHECK_FAILED');
  });
  return {
    success: true, backupId, inserted, updated, skipped,
    rejected: preview.summary.invalidRecords, conflicts: preview.summary.conflicts,
    warnings: preview.issues.filter(issue => issue.action !== 'rejected'),
    errors: preview.issues.filter(issue => issue.action === 'rejected'),
  };
}

export async function executeImport(preview: ImportPreview): Promise<ImportResult> {
  if (importRunning) throw new Error('IMPORT_ALREADY_RUNNING');
  importRunning = true;
  try {
    return await executeImportInternal(preview);
  } finally {
    importRunning = false;
  }
}

export function defaultImportOptions(mode: ImportOptions['mode'] = 'safe_merge'): ImportOptions {
  return {
    mode,
    conflictStrategy: 'newest',
    entities: mode === 'full_restore'
      ? ['products', 'categories', 'settings', 'sales', 'sale_items', 'expenses', 'product_images']
      : ['products', 'categories', 'sales', 'sale_items', 'expenses', 'product_images'],
    importSettings: mode === 'full_restore',
  };
}

export function assertImportPayload(value: unknown): asserts value is ImportPayload {
  if (!value || typeof value !== 'object') throw new Error('INVALID_BACKUP');
  const payload = value as Partial<ImportPayload>;
  if (!Array.isArray(payload.products) || !Array.isArray(payload.categories) ||
      !Array.isArray(payload.sales) || !Array.isArray(payload.expenses) ||
      !payload.settings || typeof payload.version !== 'number') throw new Error('INVALID_BACKUP');
  if (payload.version > 4) throw new Error('BACKUP_NEWER_THAN_APP');
  const validDate = (input: unknown) => typeof input === 'string' && Number.isFinite(Date.parse(input));
  const finite = (input: unknown) => typeof input === 'number' && Number.isFinite(input);
  for (const product of payload.products) {
    if (!product || !isRecord(product) || !isUuid(product.uuid) || typeof product.name !== 'string' ||
        !product.name.trim() || typeof product.category !== 'string' || !product.category.trim() ||
        !finite(product.price_usd) || product.price_usd < 0 || !finite(product.cost_usd) || product.cost_usd < 0 ||
        !validDate(product.created_at) || !validDate(product.updated_at) ||
        (product.image_uri !== null && !isStoredProductImagePath(product.image_uri)) ||
        (product.barcode !== null && typeof product.barcode !== 'string')) {
      throw new Error('INVALID_PRODUCT');
    }
  }
  for (const category of payload.categories) {
    if (!category || !isRecord(category) || !isUuid(category.uuid) || typeof category.name !== 'string' ||
        !category.name.trim() || !validDate(category.created_at) || !validDate(category.updated_at)) {
      throw new Error('INVALID_CATEGORY');
    }
  }
  for (const sale of payload.sales) {
    if (!sale || !isRecord(sale) || !isUuid(sale.uuid) || typeof sale.invoice_number !== 'string' ||
        !sale.invoice_number.trim() || !validDate(sale.created_at) || !validDate(sale.updated_at) ||
        !finite(sale.exchange_rate) || sale.exchange_rate <= 0 || !Array.isArray(sale.items)) {
      throw new Error('INVALID_SALE');
    }
    for (const item of sale.items) {
      if (!item || !isRecord(item) || !isUuid(item.uuid) || typeof item.product_name !== 'string' ||
          !finite(item.quantity) || item.quantity <= 0 || !finite(item.unit_price_syp) ||
          !finite(item.unit_cost_syp) || !finite(item.line_total_syp) || !finite(item.line_cost_syp) ||
          !validDate(item.created_at) || !validDate(item.updated_at)) throw new Error('INVALID_SALE_ITEM');
    }
  }
  for (const expense of payload.expenses) {
    if (!expense || !isRecord(expense) || !isUuid(expense.uuid) || typeof expense.description !== 'string' ||
        !finite(expense.amount_syp) || expense.amount_syp < 0 ||
        !validDate(expense.created_at) || !validDate(expense.updated_at)) throw new Error('INVALID_EXPENSE');
  }
  const settings = payload.settings;
  if (!isRecord(settings) || Object.keys(settings).some(key => !SETTING_KEYS.includes(key as typeof SETTING_KEYS[number])) ||
      !finite(settings.exchangeRate) || settings.exchangeRate <= 0 ||
      typeof settings.isRoundingEnabled !== 'boolean' ||
      ![5, 10, 500, 1000].includes(settings.roundingTarget) ||
      !['ar', 'en'].includes(settings.language)) throw new Error('INVALID_SETTINGS');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
