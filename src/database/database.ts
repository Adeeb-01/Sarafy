import * as SQLite from 'expo-sqlite';
import { Expense, InvoiceQuery, Product, ProductInput, ReturnSelection, Sale, SaleItem, SaleItemInput, SaleReturn, SaleReturnItem, Settings, SuspendedSale, SuspendedSaleItem, SuspendedSaleSummary } from '@/types';
import { createUuid, isUuid } from '@/utils/uuid';
import { cleanupTemporaryProductImages, deleteProductImage, isStoredProductImagePath, migrateLegacyProductImage, saveProductImage } from '@/media/productImageStorage';
import { normalizeBarcode } from '@/utils/barcode';
import { deriveReturnStatus, previewReturn, returnedQuantities } from '@/utils/returns';

const dbPromise = SQLite.openDatabaseAsync('sarafy.db');
export const getDatabase = () => dbPromise;
export const SCHEMA_VERSION = 10;

async function migratePortableIdentity() {
  const db = await dbPromise;
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const tables = ['products', 'categories', 'sales', 'sale_items', 'expenses'] as const;
  await db.withExclusiveTransactionAsync(async transaction => {
    for (const table of tables) {
      const columns = await transaction.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
      if (!columns.some(item => item.name === 'uuid')) await transaction.execAsync(`ALTER TABLE ${table} ADD COLUMN uuid TEXT`);
      if (!columns.some(item => item.name === 'updated_at')) await transaction.execAsync(`ALTER TABLE ${table} ADD COLUMN updated_at TEXT`);
      if (table === 'sale_items' && !columns.some(item => item.name === 'created_at')) {
        await transaction.execAsync(`ALTER TABLE ${table} ADD COLUMN created_at TEXT`);
      }
      const rows = await transaction.getAllAsync<{ id: number; uuid: string | null }>(
        `SELECT id,uuid FROM ${table} ORDER BY id`,
      );
      const seen = new Set<string>();
      for (const row of rows) {
        const normalized = row.uuid?.trim() ?? '';
        const uuid = isUuid(normalized) && !seen.has(normalized) ? normalized : createUuid();
        seen.add(uuid);
        const now = new Date().toISOString();
        await transaction.runAsync(
          `UPDATE ${table} SET uuid=?, updated_at=COALESCE(NULLIF(trim(updated_at),''), created_at, ?)` +
          (table === 'sale_items' ? `, created_at=COALESCE(NULLIF(trim(created_at),''), ?)` : '') +
          ` WHERE id=?`,
          ...(table === 'sale_items' ? [uuid, now, now, row.id] : [uuid, now, row.id]),
        );
      }
      await transaction.execAsync(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_uuid ON ${table}(uuid)`);
    }
    const productColumns = await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(products)');
    if (!productColumns.some(item => item.name === 'is_active')) {
      await transaction.execAsync('ALTER TABLE products ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
    }
    await transaction.execAsync('CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active)');
    if ((version?.user_version ?? 0) < 8) await transaction.execAsync('PRAGMA user_version = 8');
  });
}

async function migrateSalesV9() {
  const db = await dbPromise;
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((version?.user_version ?? 0) > SCHEMA_VERSION) throw new Error('DATABASE_NEWER_THAN_APP');
  await db.withExclusiveTransactionAsync(async transaction => {
    const salesColumns = await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(sales)');
    if (!salesColumns.some(column => column.name === 'amount_paid_syp')) {
      await transaction.execAsync('ALTER TABLE sales ADD COLUMN amount_paid_syp REAL');
    }
    if (!salesColumns.some(column => column.name === 'change_syp')) {
      await transaction.execAsync('ALTER TABLE sales ADD COLUMN change_syp REAL');
    }
    const itemColumns = await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(sale_items)');
    if (!itemColumns.some(column => column.name === 'barcode_snapshot')) {
      await transaction.execAsync('ALTER TABLE sale_items ADD COLUMN barcode_snapshot TEXT');
    }
    await transaction.execAsync(`
      CREATE TABLE IF NOT EXISTS sale_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        exchange_rate REAL NOT NULL CHECK(exchange_rate > 0),
        discount_syp REAL NOT NULL DEFAULT 0 CHECK(discount_syp >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sale_draft_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        draft_id INTEGER NOT NULL REFERENCES sale_drafts(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_name TEXT NOT NULL,
        barcode_snapshot TEXT,
        quantity REAL NOT NULL CHECK(quantity > 0),
        unit_price_syp REAL NOT NULL CHECK(unit_price_syp >= 0),
        unit_cost_syp REAL NOT NULL CHECK(unit_cost_syp >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sales_net_total ON sales(net_total_syp);
      CREATE INDEX IF NOT EXISTS idx_sale_items_barcode_snapshot ON sale_items(barcode_snapshot);
      CREATE INDEX IF NOT EXISTS idx_sale_draft_items_draft_id ON sale_draft_items(draft_id);
      CREATE INDEX IF NOT EXISTS idx_sale_drafts_updated_at ON sale_drafts(updated_at);
    `);
    if ((version?.user_version ?? 0) < 9) await transaction.execAsync('PRAGMA user_version = 9');
  });
}

async function migrateReturnsV10() {
  const db = await dbPromise;
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((version?.user_version ?? 0) > SCHEMA_VERSION) throw new Error('DATABASE_NEWER_THAN_APP');
  if ((version?.user_version ?? 0) >= 10) return;
  await db.withExclusiveTransactionAsync(async transaction => {
    await transaction.execAsync(`
      CREATE TABLE sale_returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
        refund_total_syp INTEGER NOT NULL CHECK(refund_total_syp >= 0),
        returned_cost_syp INTEGER NOT NULL CHECK(returned_cost_syp >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sale_return_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        return_id INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
        sale_item_id INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
        quantity INTEGER NOT NULL CHECK(quantity > 0),
        refund_amount_syp INTEGER NOT NULL CHECK(refund_amount_syp >= 0),
        cost_reversal_syp INTEGER NOT NULL CHECK(cost_reversal_syp >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_sale_returns_sale_id ON sale_returns(sale_id);
      CREATE INDEX idx_sale_returns_created_at ON sale_returns(created_at);
      CREATE INDEX idx_sale_return_items_return_id ON sale_return_items(return_id);
      CREATE INDEX idx_sale_return_items_sale_item_id ON sale_return_items(sale_item_id);
      PRAGMA user_version = 10;
    `);
  });
}

export async function initializeDatabase() {
  const db = await dbPromise;
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price_usd REAL NOT NULL CHECK(price_usd >= 0),
      cost_usd REAL NOT NULL DEFAULT 0 CHECK(cost_usd >= 0),
      image_uri TEXT,
      barcode TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO categories (name, created_at)
      SELECT DISTINCT category, datetime('now') FROM products WHERE trim(category) <> '';
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT NOT NULL UNIQUE,
      exchange_rate REAL NOT NULL,
      subtotal_syp REAL NOT NULL,
      discount_syp REAL NOT NULL DEFAULT 0,
      net_total_syp REAL NOT NULL,
      cost_syp REAL NOT NULL,
      profit_syp REAL NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at);
    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      product_name TEXT NOT NULL,
      quantity REAL NOT NULL CHECK(quantity > 0),
      unit_price_syp REAL NOT NULL,
      unit_cost_syp REAL NOT NULL,
      line_total_syp REAL NOT NULL,
      line_cost_syp REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      amount_syp REAL NOT NULL CHECK(amount_syp >= 0),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_created_at ON expenses(created_at);
  `);
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(products)');
  if (!columns.some(column => column.name === 'cost_usd')) {
    await db.execAsync('ALTER TABLE products ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0');
  }
  await migratePortableIdentity();
  await migrateSalesV9();
  await migrateReturnsV10();
  const integrity = await db.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check');
  if (integrity?.integrity_check !== 'ok') throw new Error('DATABASE_INTEGRITY_CHECK_FAILED');
  const foreignKeys = await db.getAllAsync<{ table: string; rowid: number }>('PRAGMA foreign_key_check');
  if (foreignKeys.length) throw new Error('DATABASE_FOREIGN_KEY_CHECK_FAILED');
  const legacyImages = await db.getAllAsync<{ id: number; uuid: string; image_uri: string | null }>(
    "SELECT id,uuid,image_uri FROM products WHERE image_uri IS NOT NULL AND image_uri NOT LIKE 'media/products/%'",
  );
  for (const product of legacyImages) {
    const relative = await migrateLegacyProductImage(product.image_uri, product.uuid);
    if (relative !== product.image_uri) {
      await db.runAsync(
        'UPDATE products SET image_uri=?, updated_at=? WHERE id=?',
        relative, new Date().toISOString(), product.id,
      );
    }
  }
  await cleanupTemporaryProductImages();
}

export async function getProducts() {
  const db = await dbPromise;
  return db.getAllAsync<Product>('SELECT * FROM products ORDER BY created_at DESC');
}

export class ProductBarcodeConflictError extends Error {
  constructor(public readonly productName: string) {
    super('DUPLICATE_BARCODE');
    this.name = 'ProductBarcodeConflictError';
  }
}

export async function getProductByBarcode(barcodeValue: string) {
  const barcode = normalizeBarcode(barcodeValue);
  if (!barcode) return null;
  const db = await dbPromise;
  return db.getFirstAsync<Product>('SELECT * FROM products WHERE barcode = ? LIMIT 1', barcode);
}

export async function addProduct(input: ProductInput) {
  const db = await dbPromise;
  const now = new Date().toISOString();
  const uuid = createUuid();
  const imageUri = input.image_uri && !isStoredProductImagePath(input.image_uri)
    ? await saveProductImage(input.image_uri, uuid)
    : input.image_uri;
  try {
    const barcode = normalizeBarcode(input.barcode);
    let productId = 0;
    await db.withExclusiveTransactionAsync(async transaction => {
      if (barcode) {
        const duplicate = await transaction.getFirstAsync<{ name: string }>('SELECT name FROM products WHERE barcode = ? LIMIT 1', barcode);
        if (duplicate) throw new ProductBarcodeConflictError(duplicate.name);
      }
      const result = await transaction.runAsync(
        `INSERT INTO products (uuid,name,category,price_usd,cost_usd,image_uri,barcode,created_at,updated_at,is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        uuid, input.name.trim(), input.category.trim(), input.price_usd, input.cost_usd,
        imageUri, barcode, now, now,
      );
      productId = result.lastInsertRowId;
    });
    return productId;
  } catch (error) {
    if (imageUri !== input.image_uri) await deleteProductImage(imageUri);
    throw error;
  }
}

export async function updateProduct(id: number, input: ProductInput) {
  const db = await dbPromise;
  const current = await db.getFirstAsync<{ uuid: string; image_uri: string | null }>(
    'SELECT uuid,image_uri FROM products WHERE id=?', id,
  );
  if (!current) throw new Error('PRODUCT_NOT_FOUND');
  const imageUri = input.image_uri !== current.image_uri && input.image_uri && !isStoredProductImagePath(input.image_uri)
    ? await saveProductImage(input.image_uri, current.uuid)
    : input.image_uri;
  try {
    const barcode = normalizeBarcode(input.barcode);
    await db.withExclusiveTransactionAsync(async transaction => {
      if (barcode) {
        const duplicate = await transaction.getFirstAsync<{ name: string }>('SELECT name FROM products WHERE barcode = ? AND id <> ? LIMIT 1', barcode, id);
        if (duplicate) throw new ProductBarcodeConflictError(duplicate.name);
      }
      await transaction.runAsync(
        `UPDATE products SET name=?, category=?, price_usd=?, cost_usd=?, image_uri=?, barcode=?, updated_at=? WHERE id=?`,
        input.name.trim(), input.category.trim(), input.price_usd, input.cost_usd,
        imageUri, barcode, new Date().toISOString(), id,
      );
    });
  } catch (error) {
    if (imageUri !== current.image_uri) await deleteProductImage(imageUri);
    throw error;
  }
  if (imageUri !== current.image_uri && current.image_uri) {
    const references = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM products WHERE image_uri=?', current.image_uri,
    );
    if ((references?.count ?? 0) === 0) await deleteProductImage(current.image_uri);
  }
}

export async function deleteProduct(id: number) {
  const db = await dbPromise;
  const current = await db.getFirstAsync<{ image_uri: string | null }>(
    'SELECT image_uri FROM products WHERE id=?', id,
  );
  await db.runAsync('DELETE FROM products WHERE id = ?', id);
  const imageUri = current?.image_uri ?? null;
  if (!isStoredProductImagePath(imageUri)) return;
  const references = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM products WHERE image_uri=?', imageUri,
  );
  if ((references?.count ?? 0) === 0) {
    await deleteProductImage(imageUri).catch(error => {
      if (__DEV__) console.error('[ProductImageCleanupFailed]', error);
    });
  }
}

export async function getCategories() {
  const db = await dbPromise;
  const rows = await db.getAllAsync<{ name: string }>(
    'SELECT name FROM categories ORDER BY name COLLATE NOCASE',
  );
  return rows.map(row => row.name);
}

export async function addCategory(name: string) {
  const db = await dbPromise;
  const normalized = name.trim();
  if (!normalized) return;
  await db.runAsync(
    'INSERT OR IGNORE INTO categories (uuid, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    createUuid(), normalized, new Date().toISOString(), new Date().toISOString(),
  );
}

export async function loadSettings(defaults: Settings): Promise<Settings> {
  const db = await dbPromise;
  const rows = await db.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM settings');
  const settings = { ...defaults };
  for (const row of rows) {
    try {
      const value: unknown = JSON.parse(row.value);
      if (row.key === 'exchangeRate' && typeof value === 'number' && Number.isFinite(value) && value > 0) {
        settings.exchangeRate = value;
      } else if (row.key === 'isRoundingEnabled' && typeof value === 'boolean') {
        settings.isRoundingEnabled = value;
      } else if (row.key === 'roundingTarget' && (value === 5 || value === 10 || value === 500 || value === 1000)) {
        settings.roundingTarget = value;
      } else if (row.key === 'language' && (value === 'ar' || value === 'en')) {
        settings.language = value;
      }
    } catch (error) {
      if (__DEV__) console.error('[InvalidStoredSetting]', { key: row.key, error });
    }
  }
  return settings;
}

export async function saveSetting(key: keyof Settings, value: Settings[keyof Settings]) {
  const db = await dbPromise;
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key, JSON.stringify(value),
  );
}

export async function getSales(): Promise<Sale[]> {
  const db = await dbPromise;
  const sales = await db.getAllAsync<Omit<Sale, 'items'>>(
    'SELECT * FROM sales ORDER BY created_at DESC',
  );
  const items = await db.getAllAsync<SaleItem>('SELECT * FROM sale_items ORDER BY id');
  const bySale = new Map<number, SaleItem[]>();
  items.forEach(item => bySale.set(item.sale_id, [...(bySale.get(item.sale_id) ?? []), item]));
  return attachReturns(sales.map(sale => ({ ...sale, items: bySale.get(sale.id) ?? [] })));
}

export async function getReturns(saleId?: number): Promise<SaleReturn[]> {
  const db = await dbPromise;
  const headers = await db.getAllAsync<Omit<SaleReturn, 'items'>>(
    `SELECT * FROM sale_returns${saleId == null ? '' : ' WHERE sale_id=?'} ORDER BY created_at DESC,id DESC`,
    ...(saleId == null ? [] : [saleId]),
  );
  if (!headers.length) return [];
  const items: SaleReturnItem[] = [];
  for (let offset = 0; offset < headers.length; offset += 800) {
    const ids = headers.slice(offset, offset + 800).map(header => header.id);
    items.push(...await db.getAllAsync<SaleReturnItem>(`SELECT ri.*,si.product_name,si.barcode_snapshot
      FROM sale_return_items ri JOIN sale_items si ON si.id=ri.sale_item_id
      WHERE ri.return_id IN (${ids.map(() => '?').join(',')}) ORDER BY ri.id`, ...ids));
  }
  const byReturn = new Map<number, SaleReturnItem[]>();
  for (const item of items) byReturn.set(item.return_id, [...(byReturn.get(item.return_id) ?? []), item]);
  return headers.map(header => ({ ...header, items: byReturn.get(header.id) ?? [] }));
}

async function attachReturns(sales: Sale[]): Promise<Sale[]> {
  if (!sales.length) return [];
  const all: SaleReturn[] = [];
  for (let offset = 0; offset < sales.length; offset += 800) {
    const ids = sales.slice(offset, offset + 800).map(sale => sale.id);
    const db = await dbPromise;
    const headers = await db.getAllAsync<Omit<SaleReturn, 'items'>>(
      `SELECT * FROM sale_returns WHERE sale_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC,id DESC`, ...ids,
    );
    if (!headers.length) continue;
    const returnItems: SaleReturnItem[] = [];
    for (let returnOffset = 0; returnOffset < headers.length; returnOffset += 800) {
      const returnIds = headers.slice(returnOffset, returnOffset + 800).map(header => header.id);
      returnItems.push(...await db.getAllAsync<SaleReturnItem>(`SELECT ri.*,si.product_name,si.barcode_snapshot
        FROM sale_return_items ri JOIN sale_items si ON si.id=ri.sale_item_id
        WHERE ri.return_id IN (${returnIds.map(() => '?').join(',')}) ORDER BY ri.id`, ...returnIds));
    }
    const byReturn = new Map<number, SaleReturnItem[]>();
    for (const item of returnItems) byReturn.set(item.return_id, [...(byReturn.get(item.return_id) ?? []), item]);
    all.push(...headers.map(header => ({ ...header, items: byReturn.get(header.id) ?? [] })));
  }
  const bySale = new Map<number, SaleReturn[]>();
  for (const record of all) bySale.set(record.sale_id, [...(bySale.get(record.sale_id) ?? []), record]);
  return sales.map(sale => {
    const returns = bySale.get(sale.id) ?? [];
    const quantities = returnedQuantities(returns);
    return { ...sale, returns, return_summary: {
      refund_total_syp: returns.reduce((sum, record) => sum + record.refund_total_syp, 0),
      returned_cost_syp: returns.reduce((sum, record) => sum + record.returned_cost_syp, 0),
      returned_quantity: sale.items.reduce((sum, item) => sum + (quantities.get(item.id) ?? 0), 0),
      sold_quantity: sale.items.reduce((sum, item) => sum + item.quantity, 0),
      status: deriveReturnStatus(sale.items, returns),
    } };
  });
}

function invoiceDateStart(period: InvoiceQuery['period']) {
  if (!period || period === 'all') return null;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (period === 'week') {
    const day = start.getDay();
    start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
  } else if (period === 'month') start.setDate(1);
  return start.toISOString();
}

async function attachSaleItems(sales: Omit<Sale, 'items'>[]): Promise<Sale[]> {
  if (!sales.length) return [];
  const db = await dbPromise;
  const items: SaleItem[] = [];
  const ids = sales.map(sale => sale.id);
  for (let offset = 0; offset < ids.length; offset += 800) {
    const chunk = ids.slice(offset, offset + 800);
    items.push(...await db.getAllAsync<SaleItem>(
      `SELECT * FROM sale_items WHERE sale_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id`,
      ...chunk,
    ));
  }
  const bySale = new Map<number, SaleItem[]>();
  for (const item of items) {
    const group = bySale.get(item.sale_id);
    if (group) group.push(item); else bySale.set(item.sale_id, [item]);
  }
  return attachReturns(sales.map(sale => ({ ...sale, items: bySale.get(sale.id) ?? [] })));
}

export async function queryInvoices(query: InvoiceQuery): Promise<Sale[]> {
  const db = await dbPromise;
  const where: string[] = [];
  const parameters: (string | number)[] = [];
  const search = query.search?.trim() ?? '';
  if (search) {
    const like = `%${search}%`;
    where.push(`(s.invoice_number LIKE ? OR EXISTS (
      SELECT 1 FROM sale_items si LEFT JOIN products p ON p.id=si.product_id
      WHERE si.sale_id=s.id AND (si.product_name LIKE ? COLLATE NOCASE OR si.barcode_snapshot=? OR p.barcode=?)
    ))`);
    parameters.push(like, like, search, search);
  }
  const start = invoiceDateStart(query.period);
  if (start) { where.push('s.created_at >= ?'); parameters.push(start); }
  if (query.minAmount != null && Number.isFinite(query.minAmount)) { where.push('s.net_total_syp >= ?'); parameters.push(query.minAmount); }
  if (query.maxAmount != null && Number.isFinite(query.maxAmount)) { where.push('s.net_total_syp <= ?'); parameters.push(query.maxAmount); }
  const orderBy: Record<NonNullable<InvoiceQuery['sort']>, string> = {
    newest: 's.created_at DESC', oldest: 's.created_at ASC',
    highest: 's.net_total_syp DESC, s.created_at DESC', lowest: 's.net_total_syp ASC, s.created_at DESC',
  };
  const rows = await db.getAllAsync<Omit<Sale, 'items'>>(
    `SELECT s.* FROM sales s${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy[query.sort ?? 'newest']}`,
    ...parameters,
  );
  return attachSaleItems(rows);
}

export async function createSale(
  items: SaleItemInput[],
  exchangeRate: number,
  discountSyp = 0,
  amountPaidSyp?: number,
  draftId?: number,
) {
  if (!items.length) throw new Error('EMPTY_SALE');
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0 || items.some(item => !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || !Number.isSafeInteger(item.unitPriceSyp) || item.unitPriceSyp < 0 || !Number.isFinite(item.unitCostSyp) || item.unitCostSyp < 0)) {
    throw new Error('INVALID_SALE_DATA');
  }
  const db = await dbPromise;
  const subtotal = items.reduce((sum, item) => sum + item.unitPriceSyp * item.quantity, 0);
  const lineCosts = items.map(item => Math.round(item.unitCostSyp * item.quantity));
  const cost = lineCosts.reduce((sum, value) => sum + value, 0);
  if (![subtotal, cost, discountSyp].every(Number.isSafeInteger)) throw new Error('INVALID_SALE_DATA');
  const discount = Math.max(0, Math.min(discountSyp, subtotal));
  const net = subtotal - discount;
  const paid = amountPaidSyp ?? net;
  if (!Number.isSafeInteger(paid) || paid < net || paid < 0) throw new Error('INSUFFICIENT_PAYMENT');
  const change = paid - net;
  const profit = net - cost;
  const createdAt = new Date().toISOString();
  const invoiceNumber = `INV-${createdAt.replace(/\D/g, '').slice(0, 17)}`;
  let saleId = 0;
  await db.withExclusiveTransactionAsync(async transaction => {
    if (draftId != null) {
      const draft = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM sale_drafts WHERE id=?', draftId);
      if (!draft) throw new Error('DRAFT_NOT_FOUND');
      const productIds = [...new Set(items.map(item => item.productId).filter((id): id is number => id != null))];
      if (productIds.length !== new Set(items.map(item => item.productId)).size) throw new Error('DRAFT_HAS_UNAVAILABLE_ITEMS');
      const available = productIds.length ? await transaction.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) AS count FROM products WHERE is_active<>0 AND id IN (${productIds.map(() => '?').join(',')})`,
        ...productIds,
      ) : { count: 0 };
      if ((available?.count ?? 0) !== productIds.length) throw new Error('DRAFT_HAS_UNAVAILABLE_ITEMS');
    }
    const result = await transaction.runAsync(
      `INSERT INTO sales
       (uuid,invoice_number,exchange_rate,subtotal_syp,discount_syp,net_total_syp,cost_syp,profit_syp,amount_paid_syp,change_syp,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      createUuid(), invoiceNumber, exchangeRate, subtotal, discount, net, cost, profit, paid, change, createdAt, createdAt,
    );
    saleId = result.lastInsertRowId;
    for (const [index, item] of items.entries()) {
      await transaction.runAsync(
        `INSERT INTO sale_items
         (uuid,sale_id,product_id,product_name,barcode_snapshot,quantity,unit_price_syp,unit_cost_syp,line_total_syp,line_cost_syp,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        createUuid(), saleId, item.productId, item.productName, item.barcodeSnapshot, item.quantity,
        item.unitPriceSyp, item.unitCostSyp,
        item.unitPriceSyp * item.quantity, lineCosts[index] ?? 0, createdAt, createdAt,
      );
    }
    if (draftId != null) await transaction.runAsync('DELETE FROM sale_drafts WHERE id=?', draftId);
  });
  const sales = await getSales();
  const sale = sales.find(item => item.id === saleId);
  if (!sale) throw new Error('SALE_NOT_FOUND');
  return sale;
}

export async function createSaleReturn(saleId: number, selections: ReturnSelection[]): Promise<SaleReturn> {
  if (!Number.isSafeInteger(saleId) || saleId <= 0 || !selections.length) throw new Error('INVALID_RETURN');
  const db = await dbPromise;
  let returnId = 0;
  await db.withExclusiveTransactionAsync(async transaction => {
    const header = await transaction.getFirstAsync<Omit<Sale, 'items'>>('SELECT * FROM sales WHERE id=?', saleId);
    if (!header) throw new Error('SALE_NOT_FOUND');
    const saleItems = await transaction.getAllAsync<SaleItem>('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id', saleId);
    const returnHeaders = await transaction.getAllAsync<Omit<SaleReturn, 'items'>>('SELECT * FROM sale_returns WHERE sale_id=? ORDER BY id', saleId);
    const priorItems: SaleReturnItem[] = [];
    for (let offset = 0; offset < returnHeaders.length; offset += 800) {
      const ids = returnHeaders.slice(offset, offset + 800).map(record => record.id);
      priorItems.push(...await transaction.getAllAsync<SaleReturnItem>(
        `SELECT ri.*,si.product_name,si.barcode_snapshot FROM sale_return_items ri JOIN sale_items si ON si.id=ri.sale_item_id
         WHERE ri.return_id IN (${ids.map(() => '?').join(',')}) ORDER BY ri.id`, ...ids,
      ));
    }
    const byReturn = new Map<number, SaleReturnItem[]>();
    for (const item of priorItems) byReturn.set(item.return_id, [...(byReturn.get(item.return_id) ?? []), item]);
    const sale: Sale = { ...header, items: saleItems, returns: returnHeaders.map(record => ({ ...record, items: byReturn.get(record.id) ?? [] })) };
    const preview = previewReturn(sale, selections, sale.returns);
    if (!preview.items.length) throw new Error('EMPTY_RETURN');
    const now = new Date().toISOString();
    const inserted = await transaction.runAsync(
      'INSERT INTO sale_returns(uuid,sale_id,refund_total_syp,returned_cost_syp,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      createUuid(), saleId, preview.refundTotalSyp, preview.returnedCostSyp, now, now,
    );
    returnId = inserted.lastInsertRowId;
    for (const item of preview.items) await transaction.runAsync(
      `INSERT INTO sale_return_items(uuid,return_id,sale_item_id,quantity,refund_amount_syp,cost_reversal_syp,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?)`, createUuid(), returnId, item.saleItemId, item.quantity, item.refundAmountSyp, item.costReversalSyp, now, now,
    );
  });
  const record = (await getReturns()).find(item => item.id === returnId);
  if (!record) throw new Error('RETURN_NOT_FOUND');
  return record;
}

export async function suspendSale(items: SaleItemInput[], exchangeRate: number, discountSyp = 0, replaceDraftId?: number) {
  if (!items.length) throw new Error('EMPTY_DRAFT');
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) throw new Error('INVALID_EXCHANGE_RATE');
  if (items.some(item => !Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.unitPriceSyp) || item.unitPriceSyp < 0 || !Number.isFinite(item.unitCostSyp) || item.unitCostSyp < 0)) throw new Error('INVALID_DRAFT_DATA');
  const subtotal = items.reduce((sum, item) => sum + item.unitPriceSyp * item.quantity, 0);
  const discount = Math.max(0, Math.min(discountSyp, subtotal));
  const db = await dbPromise;
  const now = new Date().toISOString();
  let draftId = 0;
  await db.withExclusiveTransactionAsync(async transaction => {
    if (replaceDraftId != null) {
      const current = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM sale_drafts WHERE id=?', replaceDraftId);
      if (!current) throw new Error('DRAFT_NOT_FOUND');
    }
    const result = await transaction.runAsync(
      'INSERT INTO sale_drafts(uuid,exchange_rate,discount_syp,created_at,updated_at) VALUES(?,?,?,?,?)',
      createUuid(), exchangeRate, discount, now, now,
    );
    draftId = result.lastInsertRowId;
    for (const item of items) {
      await transaction.runAsync(
        `INSERT INTO sale_draft_items
         (uuid,draft_id,product_id,product_name,barcode_snapshot,quantity,unit_price_syp,unit_cost_syp,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        createUuid(), draftId, item.productId, item.productName, item.barcodeSnapshot,
        item.quantity, item.unitPriceSyp, item.unitCostSyp, now, now,
      );
    }
    if (replaceDraftId != null) await transaction.runAsync('DELETE FROM sale_drafts WHERE id=?', replaceDraftId);
  });
  return draftId;
}

export async function getSuspendedSaleSummaries(): Promise<SuspendedSaleSummary[]> {
  const db = await dbPromise;
  return db.getAllAsync<SuspendedSaleSummary>(`SELECT d.*,
    COUNT(i.id) AS line_count,
    COALESCE(SUM(i.quantity),0) AS item_count,
    COALESCE(SUM(i.quantity*i.unit_price_syp),0) AS subtotal_syp,
    MAX(0,COALESCE(SUM(i.quantity*i.unit_price_syp),0)-d.discount_syp) AS net_total_syp,
    COALESCE(GROUP_CONCAT(i.product_name, ' · '),'') AS item_preview
    FROM sale_drafts d LEFT JOIN sale_draft_items i ON i.draft_id=d.id
    GROUP BY d.id ORDER BY d.updated_at DESC`);
}

export async function getSuspendedSale(id: number): Promise<SuspendedSale | null> {
  const db = await dbPromise;
  const draft = await db.getFirstAsync<Omit<SuspendedSale, 'items'>>('SELECT * FROM sale_drafts WHERE id=?', id);
  if (!draft) return null;
  const items = await db.getAllAsync<SuspendedSaleItem>('SELECT * FROM sale_draft_items WHERE draft_id=? ORDER BY id', id);
  return { ...draft, items };
}

export async function deleteSuspendedSale(id: number) {
  const db = await dbPromise;
  const result = await db.runAsync('DELETE FROM sale_drafts WHERE id=?', id);
  if (!result.changes) throw new Error('DRAFT_NOT_FOUND');
}

export async function getExpenses() {
  const db = await dbPromise;
  return db.getAllAsync<Expense>('SELECT * FROM expenses ORDER BY created_at DESC');
}

export async function addExpense(description: string, amountSyp: number) {
  const db = await dbPromise;
  await db.runAsync(
    'INSERT INTO expenses (uuid,description,amount_syp,created_at,updated_at) VALUES (?,?,?,?,?)',
    createUuid(), description.trim(), amountSyp, new Date().toISOString(), new Date().toISOString(),
  );
}
