import * as SQLite from 'expo-sqlite';
import { Expense, Product, ProductInput, Sale, SaleItem, SaleItemInput, Settings } from '@/types';
import { createUuid, isUuid } from '@/utils/uuid';
import { cleanupTemporaryProductImages, deleteProductImage, isStoredProductImagePath, migrateLegacyProductImage, saveProductImage } from '@/media/productImageStorage';

const dbPromise = SQLite.openDatabaseAsync('sarafy.db');
export const getDatabase = () => dbPromise;

async function migratePortableIdentity() {
  const db = await dbPromise;
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
    await transaction.execAsync('PRAGMA user_version = 8');
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

export async function addProduct(input: ProductInput) {
  const db = await dbPromise;
  const now = new Date().toISOString();
  const uuid = createUuid();
  const imageUri = input.image_uri && !isStoredProductImagePath(input.image_uri)
    ? await saveProductImage(input.image_uri, uuid)
    : input.image_uri;
  try {
    const result = await db.runAsync(
      `INSERT INTO products (uuid,name,category,price_usd,cost_usd,image_uri,barcode,created_at,updated_at,is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      uuid,
      input.name.trim(), input.category.trim(), input.price_usd, input.cost_usd,
      imageUri, input.barcode?.trim() || null, now, now,
    );
    return result.lastInsertRowId;
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
    await db.runAsync(
      `UPDATE products SET name=?, category=?, price_usd=?, cost_usd=?, image_uri=?, barcode=?, updated_at=? WHERE id=?`,
      input.name.trim(), input.category.trim(), input.price_usd, input.cost_usd,
      imageUri, input.barcode?.trim() || null, new Date().toISOString(), id,
    );
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
  return sales.map(sale => ({ ...sale, items: bySale.get(sale.id) ?? [] }));
}

export async function createSale(
  items: SaleItemInput[],
  exchangeRate: number,
  discountSyp = 0,
) {
  if (!items.length) throw new Error('EMPTY_SALE');
  const db = await dbPromise;
  const subtotal = items.reduce((sum, item) => sum + item.unitPriceSyp * item.quantity, 0);
  const cost = items.reduce((sum, item) => sum + item.unitCostSyp * item.quantity, 0);
  const discount = Math.max(0, Math.min(discountSyp, subtotal));
  const net = subtotal - discount;
  const profit = net - cost;
  const createdAt = new Date().toISOString();
  const invoiceNumber = `INV-${createdAt.replace(/\D/g, '').slice(0, 17)}`;
  let saleId = 0;
  await db.withTransactionAsync(async () => {
    const result = await db.runAsync(
      `INSERT INTO sales
       (uuid,invoice_number,exchange_rate,subtotal_syp,discount_syp,net_total_syp,cost_syp,profit_syp,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      createUuid(), invoiceNumber, exchangeRate, subtotal, discount, net, cost, profit, createdAt, createdAt,
    );
    saleId = result.lastInsertRowId;
    for (const item of items) {
      await db.runAsync(
        `INSERT INTO sale_items
         (uuid,sale_id,product_id,product_name,quantity,unit_price_syp,unit_cost_syp,line_total_syp,line_cost_syp,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        createUuid(), saleId, item.productId, item.productName, item.quantity,
        item.unitPriceSyp, item.unitCostSyp,
        item.unitPriceSyp * item.quantity, item.unitCostSyp * item.quantity, createdAt, createdAt,
      );
    }
  });
  const sales = await getSales();
  const sale = sales.find(item => item.id === saleId);
  if (!sale) throw new Error('SALE_NOT_FOUND');
  return sale;
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
