import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { getDatabase } from '@/database/database';
import { ExchangeRateHistoryEntry, Expense, ExpenseCategory, Product, Sale, SaleItem, SaleReturn, SaleReturnItem, Settings, SuspendedSale, SuspendedSaleItem } from '@/types';
import { ImportPayload, PortableCategory } from '@/import/importTypes';
import { createDeterministicUuid, isUuid } from '@/utils/uuid';
import { readSarafyArchive, writeSarafyArchive } from './backupArchive';
import { assertReadableNonEmptyFile, ensureBackupDirectory, getBackupDirectory } from './backupStorage';
import { isStoredProductImagePath } from '@/media/productImageStorage';

const BACKUP_VERSION = 5;
const SCHEMA_VERSION = 11;
const APPLICATION_ID = 'com.sarafy.catalog';
const ROOT = getBackupDirectory().uri;
const PRE_IMPORT_LIMIT = 5;

export interface BackupManifest {
  format: 'sarafy-backup';
  backupVersion: number;
  schemaVersion: number;
  applicationId: typeof APPLICATION_ID;
  appVersion: string;
  createdAt: string;
  backupType: 'manual' | 'pre-import';
  reason: string;
  includes: { dataJson: true; productImages: boolean; drafts?: boolean };
  counts: { products: number; categories: number; sales: number; saleItems: number; expenses: number; images: number; drafts?: number; draftItems?: number; returns?: number; returnItems?: number; expenseCategories?: number; exchangeRateHistory?: number };
}

export interface SarafyBackup {
  manifest: BackupManifest;
  data: ImportPayload;
  archiveUri?: string;
}

export async function collectPortableData(): Promise<ImportPayload> {
  const db = await getDatabase();
  const [products, categories, settingsRows, salesRows, saleItems, expenses, draftRows, draftItems, returnRows, returnItems, expenseCategories, exchangeRateHistory] = await Promise.all([
    db.getAllAsync<Product>('SELECT * FROM products ORDER BY id'),
    db.getAllAsync<PortableCategory>('SELECT id,uuid,name,created_at,updated_at FROM categories ORDER BY id'),
    db.getAllAsync<{ key: string; value: string }>('SELECT key,value FROM settings'),
    db.getAllAsync<Omit<Sale, 'items'>>('SELECT * FROM sales ORDER BY id'),
    db.getAllAsync<SaleItem>('SELECT * FROM sale_items ORDER BY id'),
    db.getAllAsync<Expense>('SELECT e.*,c.uuid AS category_uuid FROM expenses e JOIN expense_categories c ON c.id=e.category_id ORDER BY e.id'),
    db.getAllAsync<Omit<SuspendedSale, 'items'>>('SELECT * FROM sale_drafts ORDER BY id'),
    db.getAllAsync<SuspendedSaleItem>('SELECT * FROM sale_draft_items ORDER BY id'),
    db.getAllAsync<Omit<SaleReturn, 'items'>>('SELECT * FROM sale_returns ORDER BY id'),
    db.getAllAsync<SaleReturnItem>('SELECT ri.*,si.product_name,si.barcode_snapshot FROM sale_return_items ri JOIN sale_items si ON si.id=ri.sale_item_id ORDER BY ri.id'),
    db.getAllAsync<ExpenseCategory>('SELECT * FROM expense_categories ORDER BY id'),
    db.getAllAsync<ExchangeRateHistoryEntry>('SELECT * FROM exchange_rate_history ORDER BY id'),
  ]);
  const stored = Object.fromEntries(settingsRows.map(row => [row.key, JSON.parse(row.value)])) as Partial<Settings>;
  const settings: Settings = {
    exchangeRate: stored.exchangeRate ?? 15000,
    isRoundingEnabled: stored.isRoundingEnabled ?? true,
    roundingTarget: stored.roundingTarget ?? 500,
    language: stored.language ?? 'ar',
  };
  const saleItemsBySale = new Map<number, SaleItem[]>();
  for (const item of saleItems) {
    const items = saleItemsBySale.get(item.sale_id);
    if (items) items.push(item);
    else saleItemsBySale.set(item.sale_id, [item]);
  }
  const itemsByDraft = new Map<number, SuspendedSaleItem[]>();
  for (const item of draftItems) {
    const items = itemsByDraft.get(item.draft_id);
    if (items) items.push(item); else itemsByDraft.set(item.draft_id, [item]);
  }
  const saleUuidById = new Map(salesRows.map(sale => [sale.id, sale.uuid]));
  const saleItemUuidById = new Map(saleItems.map(item => [item.id, item.uuid]));
  const returnItemsByReturn = new Map<number, SaleReturnItem[]>();
  for (const item of returnItems) returnItemsByReturn.set(item.return_id, [...(returnItemsByReturn.get(item.return_id) ?? []), item]);
  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    products, categories, settings, expenseCategories, exchangeRateHistory,
    sales: salesRows.map(sale => ({ ...sale, items: saleItemsBySale.get(sale.id) ?? [] })),
    expenses,
    drafts: draftRows.map(draft => ({ ...draft, items: itemsByDraft.get(draft.id) ?? [] })),
    returns: returnRows.map(record => ({
      uuid: record.uuid, sale_uuid: saleUuidById.get(record.sale_id) ?? '', refund_total_syp: record.refund_total_syp,
      returned_cost_syp: record.returned_cost_syp, created_at: record.created_at, updated_at: record.updated_at,
      items: (returnItemsByReturn.get(record.id) ?? []).map(item => ({ uuid: item.uuid, sale_item_uuid: saleItemUuidById.get(item.sale_item_id) ?? '', quantity: item.quantity, refund_amount_syp: item.refund_amount_syp, cost_reversal_syp: item.cost_reversal_syp, created_at: item.created_at, updated_at: item.updated_at })),
    })),
  };
}

async function buildBackup(type: BackupManifest['backupType'], reason: string): Promise<SarafyBackup> {
  const data = await collectPortableData();
  let imageCount = 0;
  const countedPaths = new Set<string>();
  for (const product of data.products) {
    if (!isStoredProductImagePath(product.image_uri) || countedPaths.has(product.image_uri)) continue;
    countedPaths.add(product.image_uri);
    const imageFile = new File(Paths.document, 'sarafy', product.image_uri);
    if (imageFile.exists && imageFile.size > 0) imageCount += 1;
  }
  return {
    manifest: {
      format: 'sarafy-backup', backupVersion: BACKUP_VERSION, schemaVersion: SCHEMA_VERSION,
      applicationId: APPLICATION_ID, appVersion: '1.0.0', createdAt: data.exportedAt,
      backupType: type, reason, includes: { dataJson: true, productImages: imageCount > 0, drafts: true },
      counts: {
        products: data.products.length, categories: data.categories.length, sales: data.sales.length,
        saleItems: data.sales.reduce((sum, sale) => sum + sale.items.length, 0),
        expenses: data.expenses.length, images: imageCount,
        drafts: data.drafts?.length ?? 0,
        draftItems: data.drafts?.reduce((sum, draft) => sum + draft.items.length, 0) ?? 0,
        returns: data.returns?.length ?? 0,
        returnItems: data.returns?.reduce((sum, record) => sum + record.items.length, 0) ?? 0,
        expenseCategories: data.expenseCategories?.length ?? 0,
        exchangeRateHistory: data.exchangeRateHistory?.length ?? 0,
      },
    },
    data,
  };
}

async function writeBackup(type: BackupManifest['backupType'], reason: string) {
  let stage = 'ensure-directory';
  let temporaryUri: string | null = null;
  let finalUri: string | null = null;
  let finalWasPublished = false;
  try {
    const backupDirectory = ensureBackupDirectory();
    stage = 'build-backup';
    const backup = await buildBackup(type, reason);
    const stamp = `${backup.manifest.createdAt.replace(/\D/g, '').slice(0, 17)}-${Math.floor(Math.random() * 1_000_000)}`;
    const name = `${type}-${stamp}.sarafy`;
    const finalFile = new File(backupDirectory, name);
    const temporaryFile = new File(backupDirectory, `${name}.writing`);
    temporaryUri = temporaryFile.uri;
    finalUri = finalFile.uri;

    stage = 'create-temporary-file';
    if (finalFile.exists || temporaryFile.exists) throw new Error('BACKUP_NAME_COLLISION');
    temporaryFile.create();
    if (!temporaryFile.exists) throw new Error('BACKUP_TEMP_FILE_NOT_CREATED');

    stage = 'write-temporary-archive';
    const imageCount = await writeSarafyArchive(temporaryFile, backup, backup.data.products);
    if (imageCount !== backup.manifest.counts.images) throw new Error('BACKUP_IMAGE_COUNT_MISMATCH');

    stage = 'verify-temporary-archive';
    assertReadableNonEmptyFile(temporaryFile, 'BACKUP_TEMP_FILE_EMPTY');
    const verified = await readSarafyArchive<SarafyBackup>(temporaryFile.uri, true, new Set());
    if (verified.backup.manifest.createdAt !== backup.manifest.createdAt) throw new Error('BACKUP_VERIFY_FAILED');

    stage = 'publish-final-file';
    if (finalFile.exists) throw new Error('BACKUP_NAME_COLLISION');
    await temporaryFile.move(finalFile);
    finalWasPublished = true;

    stage = 'verify-final-file';
    assertReadableNonEmptyFile(finalFile, 'BACKUP_FINAL_FILE_EMPTY');
    const finalVerification = await readSarafyArchive<SarafyBackup>(finalFile.uri, true, new Set());
    if (finalVerification.backup.manifest.createdAt !== backup.manifest.createdAt) {
      throw new Error('BACKUP_FINAL_VERIFY_FAILED');
    }
    return { uri: finalFile.uri, name, backup };
  } catch (error) {
    const backupDirectory = getBackupDirectory();
    const temporaryFile = temporaryUri ? new File(temporaryUri) : null;
    const failedFinalFile = finalUri ? new File(finalUri) : null;
    if (__DEV__) {
      console.error('[SarafyBackupWriteFailed]', {
        stage,
        uri: temporaryUri ?? finalUri,
        backupDirectoryUri: backupDirectory.uri,
        backupDirectoryExists: backupDirectory.exists,
        temporaryFileExists: temporaryFile?.exists ?? false,
        temporaryFileSize: temporaryFile?.size ?? 0,
        finalFileExists: failedFinalFile?.exists ?? false,
        finalFileSize: failedFinalFile?.size ?? 0,
        originalError: error,
      });
    }
    if (temporaryFile?.exists) temporaryFile.delete();
    // This file was created by the failed operation, never an older backup.
    if (finalWasPublished && failedFinalFile?.exists) failedFinalFile.delete();
    throw error;
  }
}

export async function createManualBackup() {
  const result = await writeBackup('manual', 'user-requested');
  const finalFile = new File(result.uri);
  assertReadableNonEmptyFile(finalFile, 'BACKUP_FINAL_FILE_NOT_READABLE');
  return finalFile.uri;
}

export async function shareBackup(uri: string): Promise<void> {
  const finalFile = new File(uri);
  assertReadableNonEmptyFile(finalFile, 'BACKUP_FINAL_FILE_NOT_SHAREABLE');
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(finalFile.uri, { mimeType: 'application/octet-stream', dialogTitle: finalFile.name });
  }
}

export async function createPreImportBackup(reason: string): Promise<string> {
  const result = await writeBackup('pre-import', reason);
  await rotatePreImportBackups();
  return result.uri;
}

async function rotatePreImportBackups() {
  const files = ensureBackupDirectory().list()
    .filter((entry): entry is File => entry instanceof File && entry.name.startsWith('pre-import-') && entry.name.endsWith('.sarafy'))
    .sort((left, right) => right.name.localeCompare(left.name));
  for (const file of files.slice(PRE_IMPORT_LIMIT)) {
    file.delete();
  }
}

export async function pickSarafyBackup(): Promise<SarafyBackup | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets[0]) return null;
  const info = await FileSystem.getInfoAsync(result.assets[0].uri);
  if (!info.exists || ('size' in info ? info.size : 0) > 100 * 1024 * 1024) throw new Error('BACKUP_TOO_LARGE');
  let value: unknown;
  try {
    const archive = await readSarafyArchive<SarafyBackup>(result.assets[0].uri);
    value = { ...archive.backup, archiveUri: result.assets[0].uri };
  } catch {
    const raw = await FileSystem.readAsStringAsync(result.assets[0].uri, { encoding: FileSystem.EncodingType.UTF8 });
    value = JSON.parse(raw);
  }
  if (!value || typeof value !== 'object') throw new Error('INVALID_BACKUP');
  const candidate = value as Partial<SarafyBackup>;
  if (!candidate.manifest && 'products' in value) {
    return { ...migrateLegacyJsonBackup(value as Record<string, unknown>), archiveUri: result.assets[0].uri };
  }
  if (!candidate.manifest || !candidate.data ||
      candidate.manifest.format !== 'sarafy-backup' ||
      candidate.manifest.applicationId !== APPLICATION_ID) throw new Error('INVALID_BACKUP');
  if (candidate.manifest.backupVersion > BACKUP_VERSION || candidate.manifest.schemaVersion > SCHEMA_VERSION) {
    throw new Error('BACKUP_NEWER_THAN_APP');
  }
  const saleItemCount = candidate.data.sales.reduce((sum, sale) => sum + (Array.isArray(sale.items) ? sale.items.length : 0), 0);
  if (candidate.manifest.counts.products !== candidate.data.products.length ||
      candidate.manifest.counts.categories !== candidate.data.categories.length ||
      candidate.manifest.counts.sales !== candidate.data.sales.length ||
      candidate.manifest.counts.saleItems !== saleItemCount ||
      candidate.manifest.counts.expenses !== candidate.data.expenses.length ||
      (candidate.manifest.counts.drafts != null && candidate.manifest.counts.drafts !== (candidate.data.drafts?.length ?? 0)) ||
      (candidate.manifest.counts.draftItems != null && candidate.manifest.counts.draftItems !== (candidate.data.drafts?.reduce((sum, draft) => sum + draft.items.length, 0) ?? 0)) ||
      (candidate.manifest.counts.returns != null && candidate.manifest.counts.returns !== (candidate.data.returns?.length ?? 0)) ||
      (candidate.manifest.counts.returnItems != null && candidate.manifest.counts.returnItems !== (candidate.data.returns?.reduce((sum, record) => sum + record.items.length, 0) ?? 0)) ||
      (candidate.manifest.counts.expenseCategories != null && candidate.manifest.counts.expenseCategories !== (candidate.data.expenseCategories?.length ?? 0)) ||
      (candidate.manifest.counts.exchangeRateHistory != null && candidate.manifest.counts.exchangeRateHistory !== (candidate.data.exchangeRateHistory?.length ?? 0))) {
    throw new Error('BACKUP_COUNT_MISMATCH');
  }
  return candidate as SarafyBackup;
}

export async function restoreBackupImages(backup: SarafyBackup) {
  if (!backup.archiveUri || !backup.manifest.includes.productImages) return 0;
  const db = await getDatabase();
  const paths = await db.getAllAsync<{ image_uri: string | null }>('SELECT image_uri FROM products WHERE image_uri IS NOT NULL');
  const allowed = new Set(paths.map(row => row.image_uri).filter((path): path is string => !!path));
  const result = await readSarafyArchive<SarafyBackup>(backup.archiveUri, true, allowed);
  return result.extractedImages;
}

export async function cleanupPickedBackup(backup: SarafyBackup) {
  if (!backup.archiveUri || !FileSystem.cacheDirectory || !backup.archiveUri.startsWith(FileSystem.cacheDirectory)) return;
  await FileSystem.deleteAsync(backup.archiveUri, { idempotent: true });
}

function migrateLegacyJsonBackup(value: Record<string, unknown>): SarafyBackup {
  const productsRaw = Array.isArray(value.products) ? value.products : [];
  const salesRaw = Array.isArray(value.sales) ? value.sales : [];
  const expensesRaw = Array.isArray(value.expenses) ? value.expenses : [];
  const categoriesRaw = Array.isArray(value.categories) ? value.categories : [];
  const now = new Date().toISOString();
  const products: Product[] = productsRaw.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as Record<string, unknown>;
    if (typeof row.name !== 'string' || typeof row.category !== 'string' || typeof row.price_usd !== 'number') return [];
    const createdAt = typeof row.created_at === 'string' ? row.created_at : now;
    const id = typeof row.id === 'number' ? row.id : index + 1;
    return [{
      id,
      uuid: isUuid(row.uuid) ? row.uuid : createDeterministicUuid(`legacy:product:${id}:${row.name}`),
      name: row.name, category: row.category, price_usd: row.price_usd,
      cost_usd: typeof row.cost_usd === 'number' ? row.cost_usd : 0,
      image_uri: isStoredProductImagePath(typeof row.image_uri === 'string' ? row.image_uri : null) ? row.image_uri as string : null,
      barcode: typeof row.barcode === 'string' ? row.barcode : null,
      created_at: createdAt,
      updated_at: typeof row.updated_at === 'string' ? row.updated_at : createdAt,
      is_active: row.is_active === 0 ? 0 : 1,
    }];
  });
  const categoryNames = Array.from(new Set([
    ...categoriesRaw.filter((name): name is string => typeof name === 'string' && !!name.trim()),
    ...products.map(product => product.category),
  ].map(name => name.trim()).filter(Boolean)));
  const categories: PortableCategory[] = categoryNames
    .map(name => ({
      uuid: createDeterministicUuid(`legacy:category:${name.toLocaleLowerCase()}`),
      name, created_at: now, updated_at: now,
    }));
  const sales: Sale[] = salesRaw.flatMap((raw, saleIndex) => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as Record<string, unknown>;
    if (typeof row.invoice_number !== 'string' || typeof row.created_at !== 'string') return [];
    const id = typeof row.id === 'number' ? row.id : saleIndex + 1;
    const itemsRaw = Array.isArray(row.items) ? row.items : [];
    const items: SaleItem[] = itemsRaw.flatMap((rawItem, itemIndex) => {
      if (!rawItem || typeof rawItem !== 'object') return [];
      const item = rawItem as Record<string, unknown>;
      return [{
        id: typeof item.id === 'number' ? item.id : itemIndex + 1,
        uuid: isUuid(item.uuid) ? item.uuid : createDeterministicUuid(`legacy:item:${row.invoice_number}:${itemIndex}`),
        sale_id: id, product_id: typeof item.product_id === 'number' ? item.product_id : null,
        product_name: String(item.product_name ?? ''), barcode_snapshot: typeof item.barcode_snapshot === 'string' ? item.barcode_snapshot : null,
        quantity: Number(item.quantity ?? 0),
        unit_price_syp: Number(item.unit_price_syp ?? 0), unit_cost_syp: Number(item.unit_cost_syp ?? 0),
        line_total_syp: Number(item.line_total_syp ?? 0), line_cost_syp: Number(item.line_cost_syp ?? 0),
        created_at: row.created_at as string,
        updated_at: typeof item.updated_at === 'string' ? item.updated_at : row.created_at as string,
      }];
    });
    return [{
      id, uuid: isUuid(row.uuid) ? row.uuid : createDeterministicUuid(`legacy:sale:${row.invoice_number}`),
      invoice_number: row.invoice_number, exchange_rate: Number(row.exchange_rate ?? 0),
      subtotal_syp: Number(row.subtotal_syp ?? 0), discount_syp: Number(row.discount_syp ?? 0),
      net_total_syp: Number(row.net_total_syp ?? 0), cost_syp: Number(row.cost_syp ?? 0),
      profit_syp: Number(row.profit_syp ?? 0), created_at: row.created_at,
      amount_paid_syp: typeof row.amount_paid_syp === 'number' ? row.amount_paid_syp : null,
      change_syp: typeof row.change_syp === 'number' ? row.change_syp : null,
      updated_at: typeof row.updated_at === 'string' ? row.updated_at : row.created_at, items,
    }];
  });
  const expenses: Expense[] = expensesRaw.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as Record<string, unknown>;
    if (typeof row.description !== 'string') return [];
    const createdAt = typeof row.created_at === 'string' ? row.created_at : now;
    const id = typeof row.id === 'number' ? row.id : index + 1;
    return [{
      id, uuid: isUuid(row.uuid) ? row.uuid : createDeterministicUuid(`legacy:expense:${id}:${createdAt}`),
      description: row.description, amount_syp: Number(row.amount_syp ?? 0),
      created_at: createdAt, updated_at: typeof row.updated_at === 'string' ? row.updated_at : createdAt,
    }];
  });
  const settings: Settings = value.settings && typeof value.settings === 'object'
    ? value.settings as Settings
    : { exchangeRate: 15000, isRoundingEnabled: true, roundingTarget: 500 as const, language: 'ar' as const };
  const data: ImportPayload = { version: BACKUP_VERSION, exportedAt: now, products, categories, settings, sales, expenses };
  return {
    manifest: {
      format: 'sarafy-backup', backupVersion: BACKUP_VERSION, schemaVersion: SCHEMA_VERSION,
      applicationId: APPLICATION_ID, appVersion: 'legacy', createdAt: now, backupType: 'manual',
      reason: 'legacy-json-migration', includes: { dataJson: true, productImages: false },
      counts: {
        products: products.length, categories: categories.length, sales: sales.length,
        saleItems: sales.reduce((sum, sale) => sum + sale.items.length, 0),
        expenses: expenses.length, images: 0,
      },
    },
    data,
  };
}

export async function readStoredBackup(uri: string): Promise<SarafyBackup> {
  if (!uri.startsWith(ROOT) || uri.includes('..')) throw new Error('UNSAFE_BACKUP_PATH');
  const result = await readSarafyArchive<SarafyBackup>(uri);
  return { ...result.backup, archiveUri: uri };
}

export async function listAutomaticBackups() {
  return ensureBackupDirectory().list()
    .filter((entry): entry is File => entry instanceof File && entry.name.startsWith('pre-import-') && entry.name.endsWith('.sarafy'))
    .sort((left, right) => right.name.localeCompare(left.name))
    .map(file => ({ name: file.name, uri: file.uri, size: file.exists ? file.size : 0 }));
}
