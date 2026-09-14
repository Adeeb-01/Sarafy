import * as SQLite from 'expo-sqlite';
import { CashSession, CashSessionHistoryRow, CashSessionReturnSummary, CashSessionSummary, ExchangeRateHistoryEntry, Expense, ExpenseCategory, ExpenseCategoryTotal, ExpenseQuery, InventoryDetail, InventoryHealthReport, InventoryListItem, InventoryMetrics, InventoryMovement, InventoryMovementType, InventoryQuery, InvoiceQuery, PaymentInput, Product, ProductInput, PurchaseReceipt, PurchaseReceiptInput, PurchaseReceiptItem, PurchaseReceiptQuery, PurchaseReturn, PurchaseReturnInput, PurchaseReturnQuery, ReturnSelection, Sale, SaleItem, SaleItemInput, SalePayment, SaleReturn, SaleReturnItem, Settings, Supplier, SupplierInput, SupplierSort, SuspendedSale, SuspendedSaleItem, SuspendedSaleSummary } from '@/types';
import { createDeterministicUuid, createUuid, isUuid } from '@/utils/uuid';
import { cleanupTemporaryProductImages, deleteProductImage, isStoredProductImagePath, migrateLegacyProductImage, saveProductImage } from '@/media/productImageStorage';
import { normalizeBarcode } from '@/utils/barcode';
import { deriveReturnStatus, previewReturn, returnedQuantities } from '@/utils/returns';
import { DEFAULT_EXPENSE_CATEGORIES, OTHER_EXPENSE_CATEGORY_UUID } from '@/i18n/expenseCategories';
import { calculateSettlement } from '@/utils/multiCurrency';

const dbPromise = SQLite.openDatabaseAsync('sarafy.db');
export const getDatabase = () => dbPromise;
export const SCHEMA_VERSION = 16;

export { OTHER_EXPENSE_CATEGORY_UUID } from '@/i18n/expenseCategories';

async function migratePortableIdentity() {
  const db = await dbPromise;
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((version?.user_version ?? 0) >= 8) return;
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

async function migrateExpensesAndRatesV11() {
  const db = await dbPromise;
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((version?.user_version ?? 0) > SCHEMA_VERSION) throw new Error('DATABASE_NEWER_THAN_APP');
  if ((version?.user_version ?? 0) >= 11) return;
  await db.withExclusiveTransactionAsync(async transaction => {
    await transaction.execAsync(`
      CREATE TABLE expense_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        name_ar TEXT NOT NULL,
        name_en TEXT,
        is_system INTEGER NOT NULL DEFAULT 0 CHECK(is_system IN (0,1)),
        is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE exchange_rate_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        old_rate REAL NOT NULL CHECK(old_rate > 0),
        new_rate REAL NOT NULL CHECK(new_rate > 0),
        created_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    for (const [uuid, nameAr, nameEn] of DEFAULT_EXPENSE_CATEGORIES) {
      await transaction.runAsync(`INSERT INTO expense_categories
        (uuid,name_ar,name_en,is_system,is_active,created_at,updated_at) VALUES(?,?,?,1,1,?,?)`,
      uuid, nameAr, nameEn, now, now);
    }
    const expenseColumns = await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(expenses)');
    if (!expenseColumns.some(column => column.name === 'category_id')) {
      await transaction.execAsync('ALTER TABLE expenses ADD COLUMN category_id INTEGER REFERENCES expense_categories(id) ON DELETE RESTRICT');
    }
    if (!expenseColumns.some(column => column.name === 'note')) {
      await transaction.execAsync('ALTER TABLE expenses ADD COLUMN note TEXT');
    }
    await transaction.runAsync(`UPDATE expenses SET category_id=(SELECT id FROM expense_categories WHERE uuid=?) WHERE category_id IS NULL`, OTHER_EXPENSE_CATEGORY_UUID);
    await transaction.execAsync(`
      CREATE INDEX idx_expenses_category_id ON expenses(category_id);
      CREATE INDEX idx_expense_categories_active ON expense_categories(is_active);
      CREATE INDEX idx_exchange_rate_history_created_at ON exchange_rate_history(created_at);
      PRAGMA user_version = 11;
    `);
  });
}

async function migrateCashSessionsV12() {
  const db = await dbPromise;
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((version?.user_version ?? 0) > SCHEMA_VERSION) throw new Error('DATABASE_NEWER_THAN_APP');
  if ((version?.user_version ?? 0) >= 12) return;
  await db.withExclusiveTransactionAsync(async transaction => {
    await transaction.execAsync(`
      CREATE TABLE cash_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        opening_cash_syp INTEGER NOT NULL CHECK(opening_cash_syp >= 0),
        closing_actual_cash_syp INTEGER CHECK(closing_actual_cash_syp >= 0),
        closing_sales_total_syp INTEGER,
        closing_refunds_total_syp INTEGER,
        closing_expenses_total_syp INTEGER,
        closing_expected_cash_syp INTEGER,
        closing_difference_syp INTEGER,
        opening_note TEXT,
        closing_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_cash_sessions_uuid ON cash_sessions(uuid);
      CREATE INDEX idx_cash_sessions_opened_at ON cash_sessions(opened_at);
      CREATE INDEX idx_cash_sessions_closed_at ON cash_sessions(closed_at);
      CREATE UNIQUE INDEX idx_cash_sessions_single_open ON cash_sessions((1)) WHERE closed_at IS NULL;
    `);
    const salesColumns = await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(sales)');
    if (!salesColumns.some(column => column.name === 'cash_session_id')) await transaction.execAsync('ALTER TABLE sales ADD COLUMN cash_session_id INTEGER REFERENCES cash_sessions(id) ON DELETE RESTRICT');
    const expenseColumns = await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(expenses)');
    if (!expenseColumns.some(column => column.name === 'cash_session_id')) await transaction.execAsync('ALTER TABLE expenses ADD COLUMN cash_session_id INTEGER REFERENCES cash_sessions(id) ON DELETE RESTRICT');
    const returnColumns = await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(sale_returns)');
    if (!returnColumns.some(column => column.name === 'cash_session_id')) await transaction.execAsync('ALTER TABLE sale_returns ADD COLUMN cash_session_id INTEGER REFERENCES cash_sessions(id) ON DELETE RESTRICT');
    await transaction.execAsync(`
      CREATE INDEX idx_sales_cash_session_id ON sales(cash_session_id);
      CREATE INDEX idx_expenses_cash_session_id ON expenses(cash_session_id);
      CREATE INDEX idx_sale_returns_cash_session_id ON sale_returns(cash_session_id);
      PRAGMA user_version = 12;
    `);
  });
}

async function migrateMultiCurrencyV13() {
  const db = await dbPromise;
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((version?.user_version ?? 0) > SCHEMA_VERSION) throw new Error('DATABASE_NEWER_THAN_APP');
  if ((version?.user_version ?? 0) >= 13) return;
  await db.withExclusiveTransactionAsync(async transaction => {
    await transaction.execAsync(`CREATE TABLE sale_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT NOT NULL UNIQUE,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
      currency TEXT NOT NULL CHECK(currency IN ('SYP','USD')),
      amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
      syp_equivalent INTEGER NOT NULL CHECK(syp_equivalent >= 0),
      exchange_rate_syp_per_usd INTEGER,
      created_at TEXT NOT NULL,
      CHECK((currency='SYP' AND exchange_rate_syp_per_usd IS NULL AND amount_minor=syp_equivalent) OR
            (currency='USD' AND exchange_rate_syp_per_usd IS NOT NULL AND exchange_rate_syp_per_usd>0)),
      UNIQUE(sale_id,currency)
    );
    CREATE INDEX idx_sale_payments_sale_id ON sale_payments(sale_id);
    CREATE UNIQUE INDEX idx_sale_payments_uuid ON sale_payments(uuid);`);
    const sessionColumns = await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(cash_sessions)');
    const additions = [
      ['opening_cash_usd_cents', 'INTEGER NOT NULL DEFAULT 0 CHECK(opening_cash_usd_cents >= 0)'],
      ['closing_actual_cash_usd_cents', 'INTEGER CHECK(closing_actual_cash_usd_cents >= 0)'],
      ['closing_expected_cash_usd_cents', 'INTEGER CHECK(closing_expected_cash_usd_cents >= 0)'],
      ['closing_difference_usd_cents', 'INTEGER'],
      ['closing_cash_received_syp', 'INTEGER CHECK(closing_cash_received_syp >= 0)'],
      ['closing_cash_received_usd_cents', 'INTEGER CHECK(closing_cash_received_usd_cents >= 0)'],
      ['closing_change_given_syp', 'INTEGER CHECK(closing_change_given_syp >= 0)'],
    ] as const;
    for (const [name, definition] of additions) if (!sessionColumns.some(column => column.name === name)) await transaction.execAsync(`ALTER TABLE cash_sessions ADD COLUMN ${name} ${definition}`);
    const legacySales = await transaction.getAllAsync<{ id: number; uuid: string; amount_paid_syp: number; created_at: string }>('SELECT id,uuid,amount_paid_syp,created_at FROM sales WHERE amount_paid_syp IS NOT NULL ORDER BY id');
    for (const sale of legacySales) {
      if (!Number.isSafeInteger(sale.amount_paid_syp) || sale.amount_paid_syp < 0) throw new Error('INVALID_LEGACY_PAYMENT');
      await transaction.runAsync(`INSERT INTO sale_payments(uuid,sale_id,currency,amount_minor,syp_equivalent,exchange_rate_syp_per_usd,created_at)
        VALUES(?,?,'SYP',?,?,NULL,?)`, createDeterministicUuid(`sale-payment:syp:${sale.uuid}`), sale.id, sale.amount_paid_syp, sale.amount_paid_syp, sale.created_at);
    }
    await transaction.execAsync('PRAGMA user_version = 13');
  });
}

async function migrateInventoryV14() {
  const db = await dbPromise;
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((version?.user_version ?? 0) > SCHEMA_VERSION) throw new Error('DATABASE_NEWER_THAN_APP');
  if ((version?.user_version ?? 0) >= 14) return;
  await db.withExclusiveTransactionAsync(async transaction => {
    await transaction.execAsync(`
      CREATE TABLE inventory_balances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL UNIQUE REFERENCES products(id) ON DELETE RESTRICT,
        tracking_enabled INTEGER NOT NULL DEFAULT 0 CHECK(tracking_enabled IN (0,1)),
        quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
        low_stock_threshold INTEGER CHECK(low_stock_threshold IS NULL OR low_stock_threshold >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE inventory_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_uuid_snapshot TEXT NOT NULL,
        product_name_snapshot TEXT NOT NULL,
        barcode_snapshot TEXT,
        movement_type TEXT NOT NULL CHECK(movement_type IN ('opening','stock_in','stock_out','adjustment','sale','return')),
        quantity_delta INTEGER NOT NULL CHECK(quantity_delta <> 0),
        quantity_before INTEGER NOT NULL CHECK(quantity_before >= 0),
        quantity_after INTEGER NOT NULL CHECK(quantity_after >= 0),
        sale_item_id INTEGER REFERENCES sale_items(id) ON DELETE RESTRICT,
        return_item_id INTEGER REFERENCES sale_return_items(id) ON DELETE RESTRICT,
        note TEXT,
        created_at TEXT NOT NULL,
        CHECK(quantity_after = quantity_before + quantity_delta)
      );
      CREATE INDEX IF NOT EXISTS idx_inventory_balances_tracking_quantity ON inventory_balances(tracking_enabled,quantity);
      CREATE INDEX IF NOT EXISTS idx_inventory_movements_product_created ON inventory_movements(product_id,created_at DESC,id DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_movements_sale_item ON inventory_movements(sale_item_id) WHERE sale_item_id IS NOT NULL AND movement_type='sale';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_movements_return_item ON inventory_movements(return_item_id) WHERE return_item_id IS NOT NULL AND movement_type='return';
      PRAGMA user_version = 14;
    `);
  });
}

async function migratePurchasesV15() {
  const db = await dbPromise;
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((version?.user_version ?? 0) > SCHEMA_VERSION) throw new Error('DATABASE_NEWER_THAN_APP');
  if ((version?.user_version ?? 0) >= 15) return;
  await db.withExclusiveTransactionAsync(async transaction => {
    await transaction.execAsync(`
      CREATE TABLE suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
        phone TEXT,
        address TEXT,
        note TEXT,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE purchase_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
        supplier_uuid_snapshot TEXT NOT NULL,
        supplier_name_snapshot TEXT NOT NULL,
        reference_number TEXT,
        note TEXT,
        received_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE purchase_receipt_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        purchase_receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id) ON DELETE RESTRICT,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_uuid_snapshot TEXT NOT NULL,
        product_name_snapshot TEXT NOT NULL,
        barcode_snapshot TEXT,
        quantity INTEGER NOT NULL CHECK(quantity > 0),
        unit_cost_usd_cents INTEGER NOT NULL CHECK(unit_cost_usd_cents >= 0),
        line_total_usd_cents INTEGER NOT NULL CHECK(line_total_usd_cents >= 0),
        created_at TEXT NOT NULL,
        UNIQUE(purchase_receipt_id,product_uuid_snapshot),
        CHECK(line_total_usd_cents = quantity * unit_cost_usd_cents)
      );
      ALTER TABLE inventory_movements RENAME TO inventory_movements_v14;
      CREATE TABLE inventory_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_uuid_snapshot TEXT NOT NULL,
        product_name_snapshot TEXT NOT NULL,
        barcode_snapshot TEXT,
        movement_type TEXT NOT NULL CHECK(movement_type IN ('opening','stock_in','stock_out','adjustment','sale','return','purchase')),
        quantity_delta INTEGER NOT NULL CHECK(quantity_delta <> 0),
        quantity_before INTEGER NOT NULL CHECK(quantity_before >= 0),
        quantity_after INTEGER NOT NULL CHECK(quantity_after >= 0),
        sale_item_id INTEGER REFERENCES sale_items(id) ON DELETE RESTRICT,
        return_item_id INTEGER REFERENCES sale_return_items(id) ON DELETE RESTRICT,
        purchase_receipt_item_id INTEGER REFERENCES purchase_receipt_items(id) ON DELETE RESTRICT,
        note TEXT,
        created_at TEXT NOT NULL,
        CHECK(quantity_after = quantity_before + quantity_delta),
        CHECK((movement_type='purchase' AND purchase_receipt_item_id IS NOT NULL AND sale_item_id IS NULL AND return_item_id IS NULL) OR
              (movement_type<>'purchase' AND purchase_receipt_item_id IS NULL))
      );
      INSERT INTO inventory_movements(id,uuid,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,movement_type,quantity_delta,quantity_before,quantity_after,sale_item_id,return_item_id,note,created_at)
        SELECT id,uuid,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,movement_type,quantity_delta,quantity_before,quantity_after,sale_item_id,return_item_id,note,created_at FROM inventory_movements_v14;
      DROP TABLE inventory_movements_v14;
      CREATE INDEX idx_suppliers_name ON suppliers(name COLLATE NOCASE);
      CREATE INDEX idx_suppliers_active ON suppliers(is_active);
      CREATE INDEX idx_purchase_receipts_supplier_id ON purchase_receipts(supplier_id);
      CREATE INDEX idx_purchase_receipts_received_at ON purchase_receipts(received_at DESC,id DESC);
      CREATE INDEX idx_purchase_receipt_items_receipt_id ON purchase_receipt_items(purchase_receipt_id);
      CREATE INDEX idx_purchase_receipt_items_product_id ON purchase_receipt_items(product_id);
      CREATE INDEX IF NOT EXISTS idx_inventory_balances_tracking_quantity ON inventory_balances(tracking_enabled,quantity);
      CREATE INDEX idx_inventory_movements_product_created ON inventory_movements(product_id,created_at DESC,id DESC);
      CREATE UNIQUE INDEX idx_inventory_movements_sale_item ON inventory_movements(sale_item_id) WHERE sale_item_id IS NOT NULL AND movement_type='sale';
      CREATE UNIQUE INDEX idx_inventory_movements_return_item ON inventory_movements(return_item_id) WHERE return_item_id IS NOT NULL AND movement_type='return';
      CREATE UNIQUE INDEX idx_inventory_movements_purchase_item ON inventory_movements(purchase_receipt_item_id) WHERE purchase_receipt_item_id IS NOT NULL AND movement_type='purchase';
      PRAGMA user_version = 15;
    `);
  });
}

async function migratePurchaseReturnsV16() {
  const db = await dbPromise;
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((version?.user_version ?? 0) > SCHEMA_VERSION) throw new Error('DATABASE_NEWER_THAN_APP');
  if ((version?.user_version ?? 0) >= 16) return;
  await db.withExclusiveTransactionAsync(async transaction => {
    await transaction.execAsync(`
      CREATE TABLE purchase_returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        purchase_receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id) ON DELETE RESTRICT,
        supplier_uuid_snapshot TEXT NOT NULL,
        supplier_name_snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL,
        total_quantity INTEGER NOT NULL CHECK(total_quantity > 0),
        total_value_usd_cents INTEGER NOT NULL CHECK(total_value_usd_cents >= 0),
        reference_number TEXT,
        note TEXT
      );
      CREATE TABLE purchase_return_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        purchase_return_id INTEGER NOT NULL REFERENCES purchase_returns(id) ON DELETE RESTRICT,
        purchase_receipt_item_id INTEGER NOT NULL REFERENCES purchase_receipt_items(id) ON DELETE RESTRICT,
        product_uuid_snapshot TEXT NOT NULL,
        product_name_snapshot TEXT NOT NULL,
        barcode_snapshot TEXT,
        quantity INTEGER NOT NULL CHECK(quantity > 0),
        unit_cost_usd_cents INTEGER NOT NULL CHECK(unit_cost_usd_cents >= 0),
        line_total_usd_cents INTEGER NOT NULL CHECK(line_total_usd_cents >= 0),
        created_at TEXT NOT NULL,
        UNIQUE(purchase_return_id,purchase_receipt_item_id),
        CHECK(line_total_usd_cents = quantity * unit_cost_usd_cents)
      );
      ALTER TABLE inventory_movements RENAME TO inventory_movements_v15;
      CREATE TABLE inventory_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_uuid_snapshot TEXT NOT NULL,
        product_name_snapshot TEXT NOT NULL,
        barcode_snapshot TEXT,
        movement_type TEXT NOT NULL CHECK(movement_type IN ('opening','stock_in','stock_out','adjustment','sale','return','purchase','purchase_return')),
        quantity_delta INTEGER NOT NULL CHECK(quantity_delta <> 0),
        quantity_before INTEGER NOT NULL CHECK(quantity_before >= 0),
        quantity_after INTEGER NOT NULL CHECK(quantity_after >= 0),
        sale_item_id INTEGER REFERENCES sale_items(id) ON DELETE RESTRICT,
        return_item_id INTEGER REFERENCES sale_return_items(id) ON DELETE RESTRICT,
        purchase_receipt_item_id INTEGER REFERENCES purchase_receipt_items(id) ON DELETE RESTRICT,
        purchase_return_item_id INTEGER REFERENCES purchase_return_items(id) ON DELETE RESTRICT,
        note TEXT,
        created_at TEXT NOT NULL,
        CHECK(quantity_after = quantity_before + quantity_delta),
        CHECK((movement_type='purchase' AND purchase_receipt_item_id IS NOT NULL AND purchase_return_item_id IS NULL AND sale_item_id IS NULL AND return_item_id IS NULL) OR
              (movement_type='purchase_return' AND purchase_return_item_id IS NOT NULL AND purchase_receipt_item_id IS NULL AND sale_item_id IS NULL AND return_item_id IS NULL) OR
              (movement_type NOT IN ('purchase','purchase_return') AND purchase_receipt_item_id IS NULL AND purchase_return_item_id IS NULL))
      );
      INSERT INTO inventory_movements(id,uuid,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,movement_type,quantity_delta,quantity_before,quantity_after,sale_item_id,return_item_id,purchase_receipt_item_id,note,created_at)
        SELECT id,uuid,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,movement_type,quantity_delta,quantity_before,quantity_after,sale_item_id,return_item_id,purchase_receipt_item_id,note,created_at FROM inventory_movements_v15;
      DROP TABLE inventory_movements_v15;
      CREATE INDEX idx_purchase_returns_receipt_id ON purchase_returns(purchase_receipt_id);
      CREATE INDEX idx_purchase_returns_created_at ON purchase_returns(created_at DESC,id DESC);
      CREATE INDEX idx_purchase_return_items_return_id ON purchase_return_items(purchase_return_id);
      CREATE INDEX idx_purchase_return_items_purchase_item_id ON purchase_return_items(purchase_receipt_item_id);
      CREATE INDEX IF NOT EXISTS idx_inventory_balances_tracking_quantity ON inventory_balances(tracking_enabled,quantity);
      CREATE INDEX idx_inventory_movements_product_created ON inventory_movements(product_id,created_at DESC,id DESC);
      CREATE UNIQUE INDEX idx_inventory_movements_sale_item ON inventory_movements(sale_item_id) WHERE sale_item_id IS NOT NULL AND movement_type='sale';
      CREATE UNIQUE INDEX idx_inventory_movements_return_item ON inventory_movements(return_item_id) WHERE return_item_id IS NOT NULL AND movement_type='return';
      CREATE UNIQUE INDEX idx_inventory_movements_purchase_item ON inventory_movements(purchase_receipt_item_id) WHERE purchase_receipt_item_id IS NOT NULL AND movement_type='purchase';
      CREATE UNIQUE INDEX idx_inventory_movements_purchase_return_item ON inventory_movements(purchase_return_item_id) WHERE purchase_return_item_id IS NOT NULL AND movement_type='purchase_return';
      PRAGMA user_version = 16;
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
  await migrateExpensesAndRatesV11();
  await migrateCashSessionsV12();
  await migrateMultiCurrencyV13();
  await migrateInventoryV14();
  await migratePurchasesV15();
  await migratePurchaseReturnsV16();
  await db.runAsync(`DELETE FROM sale_draft_items
    WHERE NOT EXISTS (SELECT 1 FROM sale_drafts WHERE sale_drafts.id=sale_draft_items.draft_id)`);
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
  return db.getAllAsync<Product>(`SELECT p.*,COALESCE(b.tracking_enabled,0) AS inventory_tracking_enabled,b.quantity AS inventory_quantity,b.low_stock_threshold
    FROM products p LEFT JOIN inventory_balances b ON b.product_id=p.id ORDER BY p.created_at DESC`);
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
  return db.getFirstAsync<Product>(`SELECT p.*,COALESCE(b.tracking_enabled,0) AS inventory_tracking_enabled,b.quantity AS inventory_quantity,b.low_stock_threshold
    FROM products p LEFT JOIN inventory_balances b ON b.product_id=p.id WHERE p.barcode = ? LIMIT 1`, barcode);
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
  const current = await db.getFirstAsync<{ image_uri: string | null; has_inventory: number }>(
    `SELECT p.image_uri,CASE WHEN EXISTS(SELECT 1 FROM inventory_balances b WHERE b.product_id=p.id)
      OR EXISTS(SELECT 1 FROM inventory_movements m WHERE m.product_id=p.id) THEN 1 ELSE 0 END AS has_inventory
     FROM products p WHERE p.id=?`, id,
  );
  if (!current) return;
  if (current.has_inventory) {
    await db.runAsync('UPDATE products SET is_active=0,updated_at=? WHERE id=?', new Date().toISOString(), id);
    return;
  }
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

function inventoryStatusSql(alias = 'b') {
  return `CASE WHEN ${alias}.quantity=0 THEN 'out_of_stock' WHEN ${alias}.low_stock_threshold IS NOT NULL AND ${alias}.quantity<=${alias}.low_stock_threshold THEN 'low_stock' ELSE 'in_stock' END`;
}

export async function getInventory(query: InventoryQuery = {}): Promise<InventoryListItem[]> {
  const db = await dbPromise;
  const where = ['b.tracking_enabled=1'];
  const parameters: Array<string | number> = [];
  const search = query.search?.trim();
  if (search) { where.push('(p.name LIKE ? COLLATE NOCASE OR p.barcode=?)'); parameters.push(`%${search}%`, normalizeBarcode(search) ?? search); }
  if (query.status && query.status !== 'all') { where.push(`${inventoryStatusSql()}=?`); parameters.push(query.status); }
  const orderBy = { name: 'p.name COLLATE NOCASE ASC,p.id ASC', lowest: 'b.quantity ASC,p.name COLLATE NOCASE ASC', highest: 'b.quantity DESC,p.name COLLATE NOCASE ASC' }[query.sort ?? 'name'];
  return db.getAllAsync<InventoryListItem>(`SELECT b.*,p.uuid AS product_uuid,p.name AS product_name,p.barcode,p.is_active,${inventoryStatusSql()} AS status
    FROM inventory_balances b JOIN products p ON p.id=b.product_id WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`, ...parameters);
}

export async function getInventoryMetrics(): Promise<InventoryMetrics> {
  const db = await dbPromise;
  const row = await db.getFirstAsync<{ tracked: number; low_stock: number; out_of_stock: number }>(`SELECT COUNT(*) AS tracked,
    SUM(CASE WHEN quantity>0 AND low_stock_threshold IS NOT NULL AND quantity<=low_stock_threshold THEN 1 ELSE 0 END) AS low_stock,
    SUM(CASE WHEN quantity=0 THEN 1 ELSE 0 END) AS out_of_stock FROM inventory_balances WHERE tracking_enabled=1`);
  return { tracked: row?.tracked ?? 0, lowStock: row?.low_stock ?? 0, outOfStock: row?.out_of_stock ?? 0 };
}

export async function getInventoryDetail(productId: number): Promise<InventoryDetail | null> {
  const db = await dbPromise;
  const balance = await db.getFirstAsync<InventoryListItem>(`SELECT b.*,p.uuid AS product_uuid,p.name AS product_name,p.barcode,p.is_active,${inventoryStatusSql()} AS status
    FROM inventory_balances b JOIN products p ON p.id=b.product_id WHERE b.product_id=? AND b.tracking_enabled=1`, productId);
  if (!balance) return null;
  const movements = await db.getAllAsync<InventoryMovement>('SELECT * FROM inventory_movements WHERE product_id=? ORDER BY created_at DESC,id DESC LIMIT 100', productId);
  return { ...balance, movements };
}

export async function enableInventoryTracking(productId: number, openingQuantity: number, threshold: number | null, note?: string | null) {
  if (![productId, openingQuantity].every(Number.isSafeInteger) || productId <= 0 || openingQuantity < 0 || (threshold != null && (!Number.isSafeInteger(threshold) || threshold < 0))) throw new Error('INVALID_INVENTORY_INPUT');
  const db = await dbPromise; const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async transaction => {
    const product = await transaction.getFirstAsync<Product>('SELECT * FROM products WHERE id=? AND is_active<>0', productId);
    if (!product) throw new Error('PRODUCT_NOT_FOUND');
    const existing = await transaction.getFirstAsync<{ tracking_enabled: number }>('SELECT tracking_enabled FROM inventory_balances WHERE product_id=?', productId);
    if (existing?.tracking_enabled) throw new Error('INVENTORY_ALREADY_ENABLED');
    await transaction.runAsync(`INSERT INTO inventory_balances(product_id,tracking_enabled,quantity,low_stock_threshold,created_at,updated_at) VALUES(?,1,?,?,?,?)
      ON CONFLICT(product_id) DO UPDATE SET tracking_enabled=1,quantity=excluded.quantity,low_stock_threshold=excluded.low_stock_threshold,updated_at=excluded.updated_at`, productId, openingQuantity, threshold, now, now);
    if (openingQuantity > 0) await transaction.runAsync(`INSERT INTO inventory_movements(uuid,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,movement_type,quantity_delta,quantity_before,quantity_after,note,created_at)
      VALUES(?,?,?,?,?,'opening',?,0,?,?,?)`, createUuid(), product.id, product.uuid, product.name, product.barcode, openingQuantity, openingQuantity, note?.trim() || null, now);
  });
}

export async function adjustInventory(productId: number, mode: 'stock_in' | 'stock_out' | 'physical_count', quantity: number, note?: string | null) {
  if (!Number.isSafeInteger(productId) || productId <= 0 || !Number.isSafeInteger(quantity) || quantity < 0 || (mode !== 'physical_count' && quantity === 0)) throw new Error('INVALID_INVENTORY_INPUT');
  const db = await dbPromise; const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async transaction => {
    const row = await transaction.getFirstAsync<InventoryListItem>(`SELECT b.*,p.uuid AS product_uuid,p.name AS product_name,p.barcode,p.is_active,'in_stock' AS status FROM inventory_balances b JOIN products p ON p.id=b.product_id WHERE b.product_id=? AND b.tracking_enabled=1`, productId);
    if (!row) throw new Error('INVENTORY_NOT_TRACKED');
    const after = mode === 'stock_in' ? row.quantity + quantity : mode === 'stock_out' ? row.quantity - quantity : quantity;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('INSUFFICIENT_STOCK');
    const delta = after - row.quantity;
    if (delta === 0) return;
    const movementType: InventoryMovementType = mode === 'physical_count' ? 'adjustment' : mode;
    await transaction.runAsync('UPDATE inventory_balances SET quantity=?,updated_at=? WHERE product_id=? AND quantity=?', after, now, productId, row.quantity);
    await transaction.runAsync(`INSERT INTO inventory_movements(uuid,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,movement_type,quantity_delta,quantity_before,quantity_after,note,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, createUuid(), productId, row.product_uuid, row.product_name, row.barcode, movementType, delta, row.quantity, after, note?.trim() || null, now);
  });
}

export async function updateInventoryThreshold(productId: number, threshold: number | null) {
  if (threshold != null && (!Number.isSafeInteger(threshold) || threshold < 0)) throw new Error('INVALID_INVENTORY_INPUT');
  const db = await dbPromise;
  const result = await db.runAsync('UPDATE inventory_balances SET low_stock_threshold=?,updated_at=? WHERE product_id=? AND tracking_enabled=1', threshold, new Date().toISOString(), productId);
  if (!result.changes) throw new Error('INVENTORY_NOT_TRACKED');
}

export async function auditInventoryHealth(): Promise<InventoryHealthReport> {
  const db = await dbPromise;
  const row = await db.getFirstAsync<{ negative: number; arithmetic: number; latest: number; sale_duplicates: number; return_duplicates: number; purchase_duplicates: number; purchase_invalid: number; purchase_missing: number; purchase_return_duplicates: number; purchase_return_invalid: number; purchase_return_missing: number; purchase_over_return: number; purchase_return_orphans: number }>(`SELECT
    (SELECT COUNT(*) FROM inventory_balances WHERE quantity<0) AS negative,
    (SELECT COUNT(*) FROM inventory_movements WHERE quantity_after<>quantity_before+quantity_delta OR quantity_before<0 OR quantity_after<0) AS arithmetic,
    (SELECT COUNT(*) FROM inventory_balances b WHERE b.tracking_enabled=1 AND EXISTS(SELECT 1 FROM inventory_movements m WHERE m.product_id=b.product_id) AND b.quantity<>(SELECT m.quantity_after FROM inventory_movements m WHERE m.product_id=b.product_id ORDER BY m.id DESC LIMIT 1)) AS latest,
    (SELECT COUNT(*) FROM (SELECT sale_item_id FROM inventory_movements WHERE sale_item_id IS NOT NULL GROUP BY sale_item_id HAVING COUNT(*)>1)) AS sale_duplicates,
    (SELECT COUNT(*) FROM (SELECT return_item_id FROM inventory_movements WHERE return_item_id IS NOT NULL GROUP BY return_item_id HAVING COUNT(*)>1)) AS return_duplicates,
    (SELECT COUNT(*) FROM (SELECT purchase_receipt_item_id FROM inventory_movements WHERE purchase_receipt_item_id IS NOT NULL GROUP BY purchase_receipt_item_id HAVING COUNT(*)>1)) AS purchase_duplicates,
    (SELECT COUNT(*) FROM inventory_movements m LEFT JOIN purchase_receipt_items pi ON pi.id=m.purchase_receipt_item_id
      WHERE (m.movement_type='purchase' AND (pi.id IS NULL OR m.quantity_delta<>pi.quantity OR m.product_uuid_snapshot<>pi.product_uuid_snapshot)) OR (m.purchase_receipt_item_id IS NOT NULL AND m.movement_type<>'purchase')) AS purchase_invalid,
    (SELECT COUNT(*) FROM purchase_receipt_items pi WHERE NOT EXISTS(SELECT 1 FROM inventory_movements m WHERE m.purchase_receipt_item_id=pi.id AND m.movement_type='purchase')) AS purchase_missing,
    (SELECT COUNT(*) FROM (SELECT purchase_return_item_id FROM inventory_movements WHERE purchase_return_item_id IS NOT NULL GROUP BY purchase_return_item_id HAVING COUNT(*)>1)) AS purchase_return_duplicates,
    (SELECT COUNT(*) FROM inventory_movements m LEFT JOIN purchase_return_items ri ON ri.id=m.purchase_return_item_id
      WHERE (m.movement_type='purchase_return' AND (ri.id IS NULL OR m.quantity_delta<>-ri.quantity OR m.product_uuid_snapshot<>ri.product_uuid_snapshot)) OR (m.purchase_return_item_id IS NOT NULL AND m.movement_type<>'purchase_return')) AS purchase_return_invalid,
    (SELECT COUNT(*) FROM purchase_return_items ri WHERE NOT EXISTS(SELECT 1 FROM inventory_movements m WHERE m.purchase_return_item_id=ri.id AND m.movement_type='purchase_return')) AS purchase_return_missing,
    (SELECT COUNT(*) FROM purchase_receipt_items pi WHERE COALESCE((SELECT SUM(ri.quantity) FROM purchase_return_items ri WHERE ri.purchase_receipt_item_id=pi.id),0)>pi.quantity) AS purchase_over_return,
    (SELECT COUNT(*) FROM purchase_return_items ri LEFT JOIN purchase_receipt_items pi ON pi.id=ri.purchase_receipt_item_id WHERE pi.id IS NULL) AS purchase_return_orphans`);
  return { negativeBalances: row?.negative ?? 0, arithmeticMismatches: row?.arithmetic ?? 0, latestBalanceMismatches: row?.latest ?? 0, duplicateSaleMovements: row?.sale_duplicates ?? 0, duplicateReturnMovements: row?.return_duplicates ?? 0, duplicatePurchaseMovements: row?.purchase_duplicates ?? 0, invalidPurchaseMovements: row?.purchase_invalid ?? 0, missingPurchaseMovements: row?.purchase_missing ?? 0, duplicatePurchaseReturnMovements: row?.purchase_return_duplicates ?? 0, invalidPurchaseReturnMovements: row?.purchase_return_invalid ?? 0, missingPurchaseReturnMovements: row?.purchase_return_missing ?? 0, cumulativePurchaseOverReturns: row?.purchase_over_return ?? 0, orphanPurchaseReturnItems: row?.purchase_return_orphans ?? 0 };
}

function normalizeOptionalText(value: string | null | undefined, maxLength: number) {
  const normalized = value?.trim() || null;
  if ((normalized?.length ?? 0) > maxLength) throw new Error('TEXT_TOO_LONG');
  return normalized;
}

export async function getSuppliers(search = '', sort: SupplierSort = 'name', includeInactive = true): Promise<Supplier[]> {
  const db = await dbPromise; const where: string[] = []; const parameters: string[] = [];
  const term = search.trim();
  if (term) { where.push('(s.name LIKE ? COLLATE NOCASE OR COALESCE(s.phone,\'\') LIKE ?)'); parameters.push(`%${term}%`, `%${term}%`); }
  if (!includeInactive) where.push('s.is_active=1');
  const order = sort === 'newest' ? 's.created_at DESC,s.id DESC' : 's.name COLLATE NOCASE ASC,s.id ASC';
  return db.getAllAsync<Supplier>(`SELECT s.*,COUNT(pr.id) AS receipt_count,MAX(pr.received_at) AS latest_receipt_at,
    (SELECT COUNT(*) FROM purchase_returns sr WHERE sr.supplier_uuid_snapshot=s.uuid) AS return_count,
    (SELECT MAX(created_at) FROM purchase_returns sr WHERE sr.supplier_uuid_snapshot=s.uuid) AS latest_return_at
    FROM suppliers s LEFT JOIN purchase_receipts pr ON pr.supplier_id=s.id${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    GROUP BY s.id ORDER BY ${order}`, ...parameters);
}

export async function addSupplier(input: SupplierInput) {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new Error('INVALID_SUPPLIER_NAME');
  const phone = normalizeOptionalText(input.phone, 60); const address = normalizeOptionalText(input.address, 240); const note = normalizeOptionalText(input.note, 500);
  const db = await dbPromise; const now = new Date().toISOString();
  const result = await db.runAsync('INSERT INTO suppliers(uuid,name,phone,address,note,is_active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)', createUuid(), name, phone, address, note, now, now);
  return result.lastInsertRowId;
}

export async function updateSupplier(id: number, input: SupplierInput) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('SUPPLIER_NOT_FOUND');
  const name = input.name.trim(); if (!name || name.length > 120) throw new Error('INVALID_SUPPLIER_NAME');
  const db = await dbPromise; const result = await db.runAsync('UPDATE suppliers SET name=?,phone=?,address=?,note=?,updated_at=? WHERE id=?', name, normalizeOptionalText(input.phone, 60), normalizeOptionalText(input.address, 240), normalizeOptionalText(input.note, 500), new Date().toISOString(), id);
  if (!result.changes) throw new Error('SUPPLIER_NOT_FOUND');
}

export async function setSupplierActive(id: number, active: boolean): Promise<'archived' | 'restored'> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('SUPPLIER_NOT_FOUND');
  const db = await dbPromise; const result = await db.runAsync('UPDATE suppliers SET is_active=?,updated_at=? WHERE id=?', active ? 1 : 0, new Date().toISOString(), id);
  if (!result.changes) throw new Error('SUPPLIER_NOT_FOUND');
  return active ? 'restored' : 'archived';
}

function purchaseDateStart(period: PurchaseReceiptQuery['period']) {
  if (!period || period === 'all') return null;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  if (period === 'week') { const day = start.getDay(); start.setDate(start.getDate() - (day === 0 ? 6 : day - 1)); }
  else if (period === 'month') start.setDate(1);
  return start.toISOString();
}

const purchaseSummarySelect = `SELECT pr.id,pr.uuid,pr.supplier_id,pr.supplier_uuid_snapshot,pr.supplier_name_snapshot,pr.reference_number,pr.note,pr.received_at,pr.created_at,
  COUNT(pi.id) AS item_count,COALESCE(SUM(pi.quantity),0) AS total_quantity,COALESCE(SUM(pi.line_total_usd_cents),0) AS total_cost_usd_cents,
  COALESCE((SELECT SUM(ri.quantity) FROM purchase_returns sr JOIN purchase_return_items ri ON ri.purchase_return_id=sr.id WHERE sr.purchase_receipt_id=pr.id),0) AS returned_quantity,
  COALESCE((SELECT SUM(sr.total_value_usd_cents) FROM purchase_returns sr WHERE sr.purchase_receipt_id=pr.id),0) AS returned_value_usd_cents,
  CASE WHEN COALESCE((SELECT SUM(ri.quantity) FROM purchase_returns sr JOIN purchase_return_items ri ON ri.purchase_return_id=sr.id WHERE sr.purchase_receipt_id=pr.id),0)=0 THEN 'none'
       WHEN COALESCE((SELECT SUM(ri.quantity) FROM purchase_returns sr JOIN purchase_return_items ri ON ri.purchase_return_id=sr.id WHERE sr.purchase_receipt_id=pr.id),0)=SUM(pi.quantity) THEN 'full' ELSE 'partial' END AS return_status
  FROM purchase_receipts pr JOIN purchase_receipt_items pi ON pi.purchase_receipt_id=pr.id`;

export async function queryPurchaseReceipts(query: PurchaseReceiptQuery = {}): Promise<PurchaseReceipt[]> {
  const db = await dbPromise; const where: string[] = []; const parameters: Array<string | number> = [];
  if (query.limit != null && (!Number.isSafeInteger(query.limit) || query.limit <= 0 || query.limit > 10000)) throw new Error('INVALID_PURCHASE_QUERY');
  const search = query.search?.trim(); if (search) { const like = `%${search}%`; where.push('(pr.supplier_name_snapshot LIKE ? COLLATE NOCASE OR COALESCE(pr.reference_number,\'\') LIKE ? OR EXISTS(SELECT 1 FROM purchase_receipt_items psi WHERE psi.purchase_receipt_id=pr.id AND psi.product_name_snapshot LIKE ? COLLATE NOCASE))'); parameters.push(like, like, like); }
  const start = purchaseDateStart(query.period); if (start) { where.push('pr.received_at>=?'); parameters.push(start); }
  if (query.supplierId != null) { where.push('pr.supplier_id=?'); parameters.push(query.supplierId); }
  const order = { newest: 'pr.received_at DESC,pr.id DESC', oldest: 'pr.received_at ASC,pr.id ASC', highest: 'total_cost_usd_cents DESC,pr.id DESC', lowest: 'total_cost_usd_cents ASC,pr.id DESC' }[query.sort ?? 'newest'];
  return db.getAllAsync<PurchaseReceipt>(`${purchaseSummarySelect}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} GROUP BY pr.id ORDER BY ${order}${query.limit ? ' LIMIT ?' : ''}`, ...parameters, ...(query.limit ? [query.limit] : []));
}

export async function getPurchaseReceiptDetail(id: number): Promise<PurchaseReceipt | null> {
  const db = await dbPromise;
  const receipt = await db.getFirstAsync<PurchaseReceipt>(`${purchaseSummarySelect} WHERE pr.id=? GROUP BY pr.id`, id);
  if (!receipt) return null;
  const items = await db.getAllAsync<PurchaseReceipt['items'] extends Array<infer T> ? T : never>(`SELECT pi.*,
    COALESCE(SUM(ri.quantity),0) AS returned_quantity,pi.quantity-COALESCE(SUM(ri.quantity),0) AS remaining_returnable_quantity,
    COALESCE(b.quantity,0) AS inventory_quantity,MIN(pi.quantity-COALESCE(SUM(ri.quantity),0),COALESCE(b.quantity,0)) AS max_return_now
    FROM purchase_receipt_items pi
    LEFT JOIN purchase_return_items ri ON ri.purchase_receipt_item_id=pi.id
    LEFT JOIN inventory_balances b ON b.product_id=pi.product_id AND b.tracking_enabled=1
    WHERE pi.purchase_receipt_id=? GROUP BY pi.id ORDER BY pi.id`, id);
  const returns = await queryPurchaseReturns({ purchaseReceiptId: id, sort: 'newest' });
  return { ...receipt, items, returns };
}

export async function createPurchaseReceipt(input: PurchaseReceiptInput): Promise<PurchaseReceipt> {
  if (!Number.isSafeInteger(input.supplierId) || input.supplierId <= 0 || !input.items.length) throw new Error('INVALID_PURCHASE_RECEIPT');
  const reference = normalizeOptionalText(input.referenceNumber, 120); const note = normalizeOptionalText(input.note, 500);
  const productIds = new Set<number>();
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.productId) || item.productId <= 0 || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || !Number.isSafeInteger(item.unitCostUsdCents) || item.unitCostUsdCents < 0 || productIds.has(item.productId)) throw new Error('INVALID_PURCHASE_ITEM');
    const total = BigInt(item.quantity) * BigInt(item.unitCostUsdCents); if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_PURCHASE_ITEM');
    productIds.add(item.productId);
  }
  const db = await dbPromise; const now = new Date().toISOString(); let receiptId = 0;
  await db.withExclusiveTransactionAsync(async transaction => {
    const supplier = await transaction.getFirstAsync<Supplier>('SELECT * FROM suppliers WHERE id=? AND is_active=1', input.supplierId);
    if (!supplier) throw new Error('SUPPLIER_INACTIVE');
    const result = await transaction.runAsync(`INSERT INTO purchase_receipts(uuid,supplier_id,supplier_uuid_snapshot,supplier_name_snapshot,reference_number,note,received_at,created_at)
      VALUES(?,?,?,?,?,?,?,?)`, createUuid(), supplier.id, supplier.uuid, supplier.name, reference, note, now, now);
    receiptId = result.lastInsertRowId;
    for (const item of input.items) {
      const product = await transaction.getFirstAsync<Product & { tracking_enabled: number; quantity: number }>(`SELECT p.*,b.tracking_enabled,b.quantity FROM products p JOIN inventory_balances b ON b.product_id=p.id WHERE p.id=? AND p.is_active=1 AND b.tracking_enabled=1`, item.productId);
      if (!product) throw new Error('PRODUCT_NOT_TRACKED');
      const lineTotal = item.quantity * item.unitCostUsdCents;
      const itemResult = await transaction.runAsync(`INSERT INTO purchase_receipt_items(uuid,purchase_receipt_id,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,quantity,unit_cost_usd_cents,line_total_usd_cents,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, createUuid(), receiptId, product.id, product.uuid, product.name, product.barcode, item.quantity, item.unitCostUsdCents, lineTotal, now);
      const after = product.quantity + item.quantity; if (!Number.isSafeInteger(after)) throw new Error('INVALID_PURCHASE_ITEM');
      const changed = await transaction.runAsync('UPDATE inventory_balances SET quantity=?,updated_at=? WHERE product_id=? AND quantity=? AND tracking_enabled=1', after, now, product.id, product.quantity);
      if (!changed.changes) throw new Error('INVENTORY_CONCURRENT_UPDATE');
      await transaction.runAsync(`INSERT INTO inventory_movements(uuid,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,movement_type,quantity_delta,quantity_before,quantity_after,purchase_receipt_item_id,note,created_at)
        VALUES(?,?,?,?,?,'purchase',?,?,?,?,?,?)`, createUuid(), product.id, product.uuid, product.name, product.barcode, item.quantity, product.quantity, after, itemResult.lastInsertRowId, reference, now);
    }
  });
  const receipt = await getPurchaseReceiptDetail(receiptId); if (!receipt) throw new Error('PURCHASE_RECEIPT_NOT_FOUND'); return receipt;
}

function purchaseReturnDateStart(period: PurchaseReturnQuery['period']) {
  return purchaseDateStart(period);
}

const purchaseReturnSummarySelect = `SELECT sr.id,sr.uuid,sr.purchase_receipt_id,pr.uuid AS purchase_receipt_uuid,
  sr.supplier_uuid_snapshot,sr.supplier_name_snapshot,sr.created_at,sr.total_quantity,sr.total_value_usd_cents,sr.reference_number,sr.note
  FROM purchase_returns sr JOIN purchase_receipts pr ON pr.id=sr.purchase_receipt_id`;

export async function queryPurchaseReturns(query: PurchaseReturnQuery = {}): Promise<PurchaseReturn[]> {
  const db = await dbPromise; const where: string[] = []; const parameters: Array<string | number> = [];
  if (query.limit != null && (!Number.isSafeInteger(query.limit) || query.limit <= 0 || query.limit > 10000)) throw new Error('INVALID_PURCHASE_RETURN_QUERY');
  const search = query.search?.trim();
  if (search) { const like = `%${search}%`; where.push(`(sr.supplier_name_snapshot LIKE ? COLLATE NOCASE OR COALESCE(sr.reference_number,'') LIKE ? OR EXISTS(SELECT 1 FROM purchase_return_items ri WHERE ri.purchase_return_id=sr.id AND ri.product_name_snapshot LIKE ? COLLATE NOCASE))`); parameters.push(like, like, like); }
  const start = purchaseReturnDateStart(query.period); if (start) { where.push('sr.created_at>=?'); parameters.push(start); }
  if (query.supplierId != null) { where.push('pr.supplier_id=?'); parameters.push(query.supplierId); }
  if (query.purchaseReceiptId != null) { where.push('sr.purchase_receipt_id=?'); parameters.push(query.purchaseReceiptId); }
  const order = { newest: 'sr.created_at DESC,sr.id DESC', oldest: 'sr.created_at ASC,sr.id ASC', highest: 'sr.total_value_usd_cents DESC,sr.id DESC', lowest: 'sr.total_value_usd_cents ASC,sr.id DESC' }[query.sort ?? 'newest'];
  return db.getAllAsync<PurchaseReturn>(`${purchaseReturnSummarySelect}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}${query.limit ? ' LIMIT ?' : ''}`, ...parameters, ...(query.limit ? [query.limit] : []));
}

export async function getPurchaseReturnDetail(id: number): Promise<PurchaseReturn | null> {
  const db = await dbPromise;
  const record = await db.getFirstAsync<PurchaseReturn>(`${purchaseReturnSummarySelect} WHERE sr.id=?`, id);
  if (!record) return null;
  const items = await db.getAllAsync<NonNullable<PurchaseReturn['items']>[number]>('SELECT * FROM purchase_return_items WHERE purchase_return_id=? ORDER BY id', id);
  return { ...record, items };
}

export async function createPurchaseReturn(input: PurchaseReturnInput): Promise<PurchaseReturn> {
  if (!Number.isSafeInteger(input.purchaseReceiptId) || input.purchaseReceiptId <= 0 || !input.items.length) throw new Error('INVALID_PURCHASE_RETURN');
  const reference = normalizeOptionalText(input.referenceNumber, 120); const note = normalizeOptionalText(input.note, 500);
  const requested = new Map<number, number>();
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.purchaseReceiptItemId) || item.purchaseReceiptItemId <= 0 || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || requested.has(item.purchaseReceiptItemId)) throw new Error('INVALID_PURCHASE_RETURN_ITEM');
    requested.set(item.purchaseReceiptItemId, item.quantity);
  }
  const db = await dbPromise; const now = new Date().toISOString(); let returnId = 0;
  await db.withExclusiveTransactionAsync(async transaction => {
    const receipt = await transaction.getFirstAsync<PurchaseReceipt>('SELECT * FROM purchase_receipts WHERE id=?', input.purchaseReceiptId);
    if (!receipt) throw new Error('PURCHASE_RECEIPT_NOT_FOUND');
    const rows = await transaction.getAllAsync<PurchaseReceiptItem & { returned_quantity: number; inventory_quantity: number; tracking_enabled: number }>(`SELECT pi.*,
      COALESCE(SUM(ri.quantity),0) AS returned_quantity,COALESCE(b.quantity,0) AS inventory_quantity,COALESCE(b.tracking_enabled,0) AS tracking_enabled
      FROM purchase_receipt_items pi LEFT JOIN purchase_return_items ri ON ri.purchase_receipt_item_id=pi.id
      LEFT JOIN inventory_balances b ON b.product_id=pi.product_id
      WHERE pi.purchase_receipt_id=? GROUP BY pi.id`, input.purchaseReceiptId);
    const byId = new Map(rows.map(row => [row.id, row])); let totalQuantity = 0; let totalValue = 0;
    for (const [itemId, quantity] of requested) {
      const item = byId.get(itemId); if (!item) throw new Error('PURCHASE_RETURN_ITEM_NOT_FOUND');
      if (!item.product_id || item.tracking_enabled !== 1) throw new Error('PURCHASE_RETURN_PRODUCT_UNAVAILABLE');
      const remaining = item.quantity - item.returned_quantity;
      if (quantity > remaining) throw new Error('PURCHASE_OVER_RETURN');
      if (quantity > item.inventory_quantity) throw new Error('INSUFFICIENT_STOCK');
      const lineTotal = BigInt(quantity) * BigInt(item.unit_cost_usd_cents);
      if (lineTotal > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(totalQuantity + quantity) || BigInt(totalValue) + lineTotal > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_PURCHASE_RETURN_ITEM');
      totalQuantity += quantity; totalValue += Number(lineTotal);
    }
    const header = await transaction.runAsync(`INSERT INTO purchase_returns(uuid,purchase_receipt_id,supplier_uuid_snapshot,supplier_name_snapshot,created_at,total_quantity,total_value_usd_cents,reference_number,note)
      VALUES(?,?,?,?,?,?,?,?,?)`, createUuid(), receipt.id, receipt.supplier_uuid_snapshot, receipt.supplier_name_snapshot, now, totalQuantity, totalValue, reference, note);
    returnId = header.lastInsertRowId;
    for (const [itemId, quantity] of requested) {
      const item = byId.get(itemId)!; const after = item.inventory_quantity - quantity;
      const changed = await transaction.runAsync('UPDATE inventory_balances SET quantity=?,updated_at=? WHERE product_id=? AND tracking_enabled=1 AND quantity=?', after, now, item.product_id, item.inventory_quantity);
      if (!changed.changes) throw new Error('INVENTORY_CONCURRENT_UPDATE');
      const lineTotal = quantity * item.unit_cost_usd_cents;
      const inserted = await transaction.runAsync(`INSERT INTO purchase_return_items(uuid,purchase_return_id,purchase_receipt_item_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,quantity,unit_cost_usd_cents,line_total_usd_cents,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, createUuid(), returnId, item.id, item.product_uuid_snapshot, item.product_name_snapshot, item.barcode_snapshot, quantity, item.unit_cost_usd_cents, lineTotal, now);
      await transaction.runAsync(`INSERT INTO inventory_movements(uuid,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,movement_type,quantity_delta,quantity_before,quantity_after,purchase_return_item_id,note,created_at)
        VALUES(?,?,?,?,?,'purchase_return',?,?,?,?,?,?)`, createUuid(), item.product_id, item.product_uuid_snapshot, item.product_name_snapshot, item.barcode_snapshot, -quantity, item.inventory_quantity, after, inserted.lastInsertRowId, reference, now);
    }
  });
  const record = await getPurchaseReturnDetail(returnId); if (!record) throw new Error('PURCHASE_RETURN_NOT_FOUND'); return record;
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

export async function updateExchangeRate(newRate: number) {
  if (!Number.isFinite(newRate) || newRate <= 0 || Math.abs(newRate) > Number.MAX_SAFE_INTEGER) throw new Error('INVALID_EXCHANGE_RATE');
  const db = await dbPromise;
  let entry: ExchangeRateHistoryEntry | null = null;
  await db.withExclusiveTransactionAsync(async transaction => {
    const stored = await transaction.getFirstAsync<{ value: string }>("SELECT value FROM settings WHERE key='exchangeRate'");
    let oldRate = 15000;
    if (stored) {
      const parsed: unknown = JSON.parse(stored.value);
      if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0) throw new Error('INVALID_STORED_EXCHANGE_RATE');
      oldRate = parsed;
    }
    if (oldRate === newRate) return;
    const uuid = createUuid();
    const createdAt = new Date().toISOString();
    const result = await transaction.runAsync(
      'INSERT INTO exchange_rate_history(uuid,old_rate,new_rate,created_at) VALUES(?,?,?,?)',
      uuid, oldRate, newRate, createdAt,
    );
    await transaction.runAsync(
      "INSERT INTO settings(key,value) VALUES('exchangeRate',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify(newRate),
    );
    entry = { id: result.lastInsertRowId, uuid, old_rate: oldRate, new_rate: newRate, created_at: createdAt };
  });
  return entry;
}

export async function getExchangeRateHistory(limit?: number) {
  const db = await dbPromise;
  if (limit != null && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error('INVALID_HISTORY_LIMIT');
  return db.getAllAsync<ExchangeRateHistoryEntry>(
    `SELECT * FROM exchange_rate_history ORDER BY created_at DESC,id DESC${limit == null ? '' : ' LIMIT ?'}`,
    ...(limit == null ? [] : [limit]),
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
      `SELECT si.*,EXISTS(SELECT 1 FROM inventory_movements im WHERE im.sale_item_id=si.id AND im.movement_type='sale') AS inventory_sale_movement
       FROM sale_items si WHERE sale_id IN (${chunk.map(() => '?').join(',')}) ORDER BY si.id`,
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

async function attachInvoiceSummaries(sales: Omit<Sale, 'items'>[]): Promise<Sale[]> {
  if (!sales.length) return [];
  const db = await dbPromise;
  const idsJson = JSON.stringify(sales.map(sale => sale.id));
  const [itemSummaries, returnSummaries] = await Promise.all([
    db.getAllAsync<{ sale_id: number; line_count: number; sold_quantity: number }>(`SELECT sale_id,COUNT(*) AS line_count,SUM(quantity) AS sold_quantity
      FROM sale_items WHERE sale_id IN (SELECT value FROM json_each(?)) GROUP BY sale_id`, idsJson),
    db.getAllAsync<{ sale_id: number; refund_total_syp: number; returned_cost_syp: number; returned_quantity: number }>(`WITH headers AS (
        SELECT sale_id,SUM(refund_total_syp) AS refund_total_syp,SUM(returned_cost_syp) AS returned_cost_syp
        FROM sale_returns WHERE sale_id IN (SELECT value FROM json_each(?)) GROUP BY sale_id
      ), quantities AS (
        SELECT sr.sale_id,SUM(ri.quantity) AS returned_quantity FROM sale_returns sr
        JOIN sale_return_items ri ON ri.return_id=sr.id
        WHERE sr.sale_id IN (SELECT value FROM json_each(?)) GROUP BY sr.sale_id
      )
      SELECT h.sale_id,h.refund_total_syp,h.returned_cost_syp,COALESCE(q.returned_quantity,0) AS returned_quantity
      FROM headers h LEFT JOIN quantities q ON q.sale_id=h.sale_id`, idsJson, idsJson),
  ]);
  const itemsBySale = new Map(itemSummaries.map(row => [row.sale_id, row]));
  const returnsBySale = new Map(returnSummaries.map(row => [row.sale_id, row]));
  return sales.map(sale => {
    const itemSummary = itemsBySale.get(sale.id);
    const returnSummary = returnsBySale.get(sale.id);
    const sold = itemSummary?.sold_quantity ?? 0;
    const returned = returnSummary?.returned_quantity ?? 0;
    return { ...sale, items: [], returns: [], item_count: sold, line_count: itemSummary?.line_count ?? 0, return_summary: {
      refund_total_syp: returnSummary?.refund_total_syp ?? 0,
      returned_cost_syp: returnSummary?.returned_cost_syp ?? 0,
      returned_quantity: returned,
      sold_quantity: sold,
      status: returned === 0 ? 'none' : returned === sold ? 'full' : 'partial',
    } };
  });
}

export async function getInvoiceDetails(saleId: number): Promise<Sale | null> {
  if (!Number.isSafeInteger(saleId) || saleId <= 0) return null;
  const db = await dbPromise;
  const sale = await db.getFirstAsync<Omit<Sale, 'items'>>('SELECT * FROM sales WHERE id=?', saleId);
  if (!sale) return null;
  const detailed = (await attachSaleItems([sale]))[0];
  if (!detailed) return null;
  const payments = await db.getAllAsync<SalePayment>('SELECT * FROM sale_payments WHERE sale_id=? ORDER BY currency,id', saleId);
  return { ...detailed, payments };
}

export async function queryInvoices(query: InvoiceQuery): Promise<Sale[]> {
  const db = await dbPromise;
  const where: string[] = [];
  const parameters: (string | number)[] = [];
  const search = query.search?.trim() ?? '';
  if (search) {
    const like = `%${search}%`;
    where.push(`(s.invoice_number LIKE ? OR s.id IN (
      SELECT si.sale_id FROM sale_items si
      WHERE si.product_name LIKE ? COLLATE NOCASE OR si.barcode_snapshot=? OR si.product_id IN (
        SELECT p.id FROM products p WHERE p.barcode=?
      )
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
  return attachInvoiceSummaries(rows);
}

export async function createSale(
  items: SaleItemInput[],
  exchangeRate: number,
  discountSyp = 0,
  paymentInput?: PaymentInput | number,
  draftId?: number,
) {
  if (!items.length) throw new Error('EMPTY_SALE');
  if (!Number.isSafeInteger(exchangeRate) || exchangeRate <= 0 || items.some(item => !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || !Number.isSafeInteger(item.unitPriceSyp) || item.unitPriceSyp < 0 || !Number.isFinite(item.unitCostSyp) || item.unitCostSyp < 0)) {
    throw new Error('INVALID_SALE_DATA');
  }
  const db = await dbPromise;
  const subtotal = items.reduce((sum, item) => sum + item.unitPriceSyp * item.quantity, 0);
  const lineCosts = items.map(item => Math.round(item.unitCostSyp * item.quantity));
  const cost = lineCosts.reduce((sum, value) => sum + value, 0);
  if (![subtotal, cost, discountSyp].every(Number.isSafeInteger)) throw new Error('INVALID_SALE_DATA');
  const discount = Math.max(0, Math.min(discountSyp, subtotal));
  const net = subtotal - discount;
  const normalizedPayment: PaymentInput = typeof paymentInput === 'number'
    ? { mode: 'SYP', sypAmount: paymentInput, usdCents: 0 }
    : paymentInput ?? { mode: 'SYP', sypAmount: net, usdCents: 0 };
  const previewSettlement = calculateSettlement(net, exchangeRate, normalizedPayment);
  if (!previewSettlement.valid) throw new Error('INSUFFICIENT_PAYMENT');
  const profit = net - cost;
  const createdAt = new Date().toISOString();
  const invoiceNumber = `INV-${createdAt.replace(/\D/g, '').slice(0, 17)}`;
  let saleId = 0;
  await db.withExclusiveTransactionAsync(async transaction => {
    const activeSession = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM cash_sessions WHERE closed_at IS NULL LIMIT 1');
    if (!activeSession) throw new Error('CASH_SESSION_REQUIRED');
    const settlement = calculateSettlement(net, exchangeRate, normalizedPayment);
    if (!settlement.valid || settlement.totalTenderEquivalentSyp - settlement.changeSyp !== net) throw new Error('INVALID_PAYMENT_SETTLEMENT');
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
    const requestedByProduct = new Map<number, number>();
    for (const item of items) if (item.productId != null) requestedByProduct.set(item.productId, (requestedByProduct.get(item.productId) ?? 0) + item.quantity);
    const requestedIds = [...requestedByProduct.keys()];
    const trackedRows = requestedIds.length ? await transaction.getAllAsync<{ product_id: number; quantity: number; product_uuid: string; product_name: string; barcode: string | null }>(
      `SELECT b.product_id,b.quantity,p.uuid AS product_uuid,p.name AS product_name,p.barcode FROM inventory_balances b JOIN products p ON p.id=b.product_id
       WHERE b.tracking_enabled=1 AND b.product_id IN (${requestedIds.map(() => '?').join(',')})`, ...requestedIds,
    ) : [];
    const tracked = new Map(trackedRows.map(row => [row.product_id, row]));
    for (const [productId, requested] of requestedByProduct) {
      const stock = tracked.get(productId);
      if (stock && stock.quantity < requested) throw new Error('INSUFFICIENT_STOCK');
    }
    const result = await transaction.runAsync(
      `INSERT INTO sales
       (uuid,invoice_number,exchange_rate,subtotal_syp,discount_syp,net_total_syp,cost_syp,profit_syp,amount_paid_syp,change_syp,created_at,updated_at,cash_session_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      createUuid(), invoiceNumber, exchangeRate, subtotal, discount, net, cost, profit, settlement.totalTenderEquivalentSyp, settlement.changeSyp, createdAt, createdAt, activeSession.id,
    );
    saleId = result.lastInsertRowId;
    for (const [index, item] of items.entries()) {
      const insertedItem = await transaction.runAsync(
        `INSERT INTO sale_items
         (uuid,sale_id,product_id,product_name,barcode_snapshot,quantity,unit_price_syp,unit_cost_syp,line_total_syp,line_cost_syp,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        createUuid(), saleId, item.productId, item.productName, item.barcodeSnapshot, item.quantity,
        item.unitPriceSyp, item.unitCostSyp,
        item.unitPriceSyp * item.quantity, lineCosts[index] ?? 0, createdAt, createdAt,
      );
      if (item.productId != null) {
        const stock = tracked.get(item.productId);
        if (stock) {
          const before = stock.quantity; const after = before - item.quantity;
          if (after < 0) throw new Error('INSUFFICIENT_STOCK');
          const changed = await transaction.runAsync('UPDATE inventory_balances SET quantity=?,updated_at=? WHERE product_id=? AND quantity=?', after, createdAt, item.productId, before);
          if (changed.changes !== 1) throw new Error('INVENTORY_CONCURRENT_CHANGE');
          await transaction.runAsync(`INSERT INTO inventory_movements(uuid,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,movement_type,quantity_delta,quantity_before,quantity_after,sale_item_id,note,created_at)
            VALUES(?,?,?,?,?,'sale',?,?,?,?,NULL,?)`, createUuid(), item.productId, stock.product_uuid, item.productName, item.barcodeSnapshot, -item.quantity, before, after, insertedItem.lastInsertRowId, createdAt);
          stock.quantity = after;
        }
      }
    }
    for (const payment of settlement.payments) await transaction.runAsync(
      `INSERT INTO sale_payments(uuid,sale_id,currency,amount_minor,syp_equivalent,exchange_rate_syp_per_usd,created_at)
       VALUES(?,?,?,?,?,?,?)`, createUuid(), saleId, payment.currency, payment.amount_minor, payment.syp_equivalent, payment.exchange_rate_syp_per_usd, createdAt,
    );
    if (draftId != null) {
      await transaction.runAsync('DELETE FROM sale_draft_items WHERE draft_id=?', draftId);
      await transaction.runAsync('DELETE FROM sale_drafts WHERE id=?', draftId);
    }
  });
  const sale = await getInvoiceDetails(saleId);
  if (!sale) throw new Error('SALE_NOT_FOUND');
  return sale;
}

export async function createSaleReturn(saleId: number, selections: ReturnSelection[]): Promise<SaleReturn> {
  if (!Number.isSafeInteger(saleId) || saleId <= 0 || !selections.length) throw new Error('INVALID_RETURN');
  const db = await dbPromise;
  let returnId = 0;
  await db.withExclusiveTransactionAsync(async transaction => {
    const activeSession = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM cash_sessions WHERE closed_at IS NULL LIMIT 1');
    if (!activeSession) throw new Error('CASH_SESSION_REQUIRED');
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
      'INSERT INTO sale_returns(uuid,sale_id,refund_total_syp,returned_cost_syp,created_at,updated_at,cash_session_id) VALUES(?,?,?,?,?,?,?)',
      createUuid(), saleId, preview.refundTotalSyp, preview.returnedCostSyp, now, now, activeSession.id,
    );
    returnId = inserted.lastInsertRowId;
    const selectionByItem = new Map(selections.map(selection => [selection.saleItemId, selection]));
    for (const item of preview.items) {
      const selectedRestock = selectionByItem.get(item.saleItemId)?.restockQuantity ?? item.quantity;
      if (!Number.isSafeInteger(selectedRestock) || selectedRestock < 0 || selectedRestock > item.quantity) throw new Error('INVALID_RESTOCK_QUANTITY');
      const insertedItem = await transaction.runAsync(
        `INSERT INTO sale_return_items(uuid,return_id,sale_item_id,quantity,refund_amount_syp,cost_reversal_syp,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?)`, createUuid(), returnId, item.saleItemId, item.quantity, item.refundAmountSyp, item.costReversalSyp, now, now,
      );
      if (selectedRestock === 0) continue;
      const sold = saleItems.find(saleItem => saleItem.id === item.saleItemId);
      if (!sold?.product_id) continue;
      const eligible = await transaction.getFirstAsync<{ product_id: number }>("SELECT product_id FROM inventory_movements WHERE sale_item_id=? AND movement_type='sale' LIMIT 1", sold.id);
      if (!eligible) continue;
      const balance = await transaction.getFirstAsync<{ quantity: number; product_uuid: string; product_name: string; barcode: string | null }>(`SELECT b.quantity,p.uuid AS product_uuid,p.name AS product_name,p.barcode FROM inventory_balances b JOIN products p ON p.id=b.product_id WHERE b.product_id=? AND b.tracking_enabled=1`, sold.product_id);
      if (!balance) continue;
      const after = balance.quantity + selectedRestock;
      if (!Number.isSafeInteger(after)) throw new Error('INVALID_RESTOCK_QUANTITY');
      const changed = await transaction.runAsync('UPDATE inventory_balances SET quantity=?,updated_at=? WHERE product_id=? AND quantity=?', after, now, sold.product_id, balance.quantity);
      if (changed.changes !== 1) throw new Error('INVENTORY_CONCURRENT_CHANGE');
      await transaction.runAsync(`INSERT INTO inventory_movements(uuid,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,movement_type,quantity_delta,quantity_before,quantity_after,return_item_id,note,created_at)
        VALUES(?,?,?,?,?,'return',?,?,?,?,NULL,?)`, createUuid(), sold.product_id, balance.product_uuid, sold.product_name, sold.barcode_snapshot, selectedRestock, balance.quantity, after, insertedItem.lastInsertRowId, now);
    }
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
    if (replaceDraftId != null) {
      await transaction.runAsync('DELETE FROM sale_draft_items WHERE draft_id=?', replaceDraftId);
      await transaction.runAsync('DELETE FROM sale_drafts WHERE id=?', replaceDraftId);
    }
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
  await db.withExclusiveTransactionAsync(async transaction => {
    const draft = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM sale_drafts WHERE id=?', id);
    if (!draft) throw new Error('DRAFT_NOT_FOUND');
    await transaction.runAsync('DELETE FROM sale_draft_items WHERE draft_id=?', id);
    await transaction.runAsync('DELETE FROM sale_drafts WHERE id=?', id);
  });
}

const expenseSelect = `SELECT e.*,c.uuid AS category_uuid,c.name_ar AS category_name_ar,c.name_en AS category_name_en
  FROM expenses e JOIN expense_categories c ON c.id=e.category_id`;

export async function getExpenseCategories(includeInactive = true) {
  const db = await dbPromise;
  return db.getAllAsync<ExpenseCategory>(`SELECT * FROM expense_categories${includeInactive ? '' : ' WHERE is_active=1'} ORDER BY is_system DESC,id`);
}

export async function addExpenseCategory(nameAr: string, nameEn?: string | null) {
  const ar = nameAr.trim(); const en = nameEn?.trim() || null;
  if (!ar || ar.length > 60 || (en?.length ?? 0) > 60) throw new Error('INVALID_EXPENSE_CATEGORY');
  const db = await dbPromise; const now = new Date().toISOString();
  const duplicate = await db.getFirstAsync<{ id: number }>(`SELECT id FROM expense_categories
    WHERE name_ar=? COLLATE NOCASE OR (? IS NOT NULL AND name_en=? COLLATE NOCASE) LIMIT 1`, ar, en, en);
  if (duplicate) throw new Error('EXPENSE_CATEGORY_EXISTS');
  const result = await db.runAsync(`INSERT INTO expense_categories(uuid,name_ar,name_en,is_system,is_active,created_at,updated_at)
    VALUES(?,?,?,0,1,?,?)`, createUuid(), ar, en, now, now);
  return result.lastInsertRowId;
}

export async function renameExpenseCategory(id: number, nameAr: string, nameEn?: string | null) {
  const ar = nameAr.trim(); const en = nameEn?.trim() || null;
  if (!Number.isSafeInteger(id) || id <= 0 || !ar || ar.length > 60 || (en?.length ?? 0) > 60) throw new Error('INVALID_EXPENSE_CATEGORY');
  const db = await dbPromise;
  const category = await db.getFirstAsync<{ is_system: number }>('SELECT is_system FROM expense_categories WHERE id=?', id);
  if (!category) throw new Error('EXPENSE_CATEGORY_NOT_FOUND');
  if (category.is_system) throw new Error('SYSTEM_EXPENSE_CATEGORY_IMMUTABLE');
  const duplicate = await db.getFirstAsync<{ id: number }>(`SELECT id FROM expense_categories
    WHERE id<>? AND (name_ar=? COLLATE NOCASE OR (? IS NOT NULL AND name_en=? COLLATE NOCASE)) LIMIT 1`, id, ar, en, en);
  if (duplicate) throw new Error('EXPENSE_CATEGORY_EXISTS');
  await db.runAsync('UPDATE expense_categories SET name_ar=?,name_en=?,updated_at=? WHERE id=?', ar, en, new Date().toISOString(), id);
}

export async function setExpenseCategoryActive(id: number, active: boolean): Promise<'archived' | 'restored' | 'deleted'> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('INVALID_EXPENSE_CATEGORY');
  const db = await dbPromise;
  const category = await db.getFirstAsync<{ is_system: number }>('SELECT is_system FROM expense_categories WHERE id=?', id);
  if (!category) throw new Error('EXPENSE_CATEGORY_NOT_FOUND');
  if (active) { await db.runAsync('UPDATE expense_categories SET is_active=1,updated_at=? WHERE id=?', new Date().toISOString(), id); return 'restored'; }
  await db.runAsync('UPDATE expense_categories SET is_active=0,updated_at=? WHERE id=?', new Date().toISOString(), id);
  return 'archived';
}

export async function getExpenses() {
  const db = await dbPromise;
  return db.getAllAsync<Expense>(`${expenseSelect} ORDER BY e.created_at DESC,e.id DESC`);
}

function expenseDateStart(period: ExpenseQuery['period']) {
  if (!period || period === 'all') return null;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  if (period === 'week') { const day = start.getDay(); start.setDate(start.getDate() - (day === 0 ? 6 : day - 1)); }
  else if (period === 'month') start.setDate(1);
  return start.toISOString();
}

export async function queryExpenses(query: ExpenseQuery) {
  const db = await dbPromise; const where: string[] = []; const parameters: (string | number)[] = [];
  const search = query.search?.trim();
  if (search) { const like = `%${search}%`; where.push('(COALESCE(e.note,e.description) LIKE ? COLLATE NOCASE OR c.name_ar LIKE ? COLLATE NOCASE OR COALESCE(c.name_en,\'\') LIKE ? COLLATE NOCASE)'); parameters.push(like, like, like); }
  const start = expenseDateStart(query.period); if (start) { where.push('e.created_at>=?'); parameters.push(start); }
  if (query.categoryUuid) { where.push('c.uuid=?'); parameters.push(query.categoryUuid); }
  if (query.minAmount != null && Number.isFinite(query.minAmount)) { where.push('e.amount_syp>=?'); parameters.push(query.minAmount); }
  if (query.maxAmount != null && Number.isFinite(query.maxAmount)) { where.push('e.amount_syp<=?'); parameters.push(query.maxAmount); }
  const order: Record<NonNullable<ExpenseQuery['sort']>, string> = { newest: 'e.created_at DESC,e.id DESC', oldest: 'e.created_at ASC,e.id ASC', highest: 'e.amount_syp DESC,e.created_at DESC', lowest: 'e.amount_syp ASC,e.created_at DESC' };
  return db.getAllAsync<Expense>(`${expenseSelect}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order[query.sort ?? 'newest']}`, ...parameters);
}

export async function getExpenseTotalsByCategory(period: ExpenseQuery['period'] = 'all') {
  const db = await dbPromise; const start = expenseDateStart(period);
  return db.getAllAsync<ExpenseCategoryTotal>(`SELECT c.id AS categoryId,c.uuid AS categoryUuid,c.name_ar AS nameAr,c.name_en AS nameEn,SUM(e.amount_syp) AS totalSyp
    FROM expenses e JOIN expense_categories c ON c.id=e.category_id${start ? ' WHERE e.created_at>=?' : ''}
    GROUP BY c.id ORDER BY totalSyp DESC,c.id`, ...(start ? [start] : []));
}

export async function addExpense(categoryId: number, amountSyp: number, note?: string | null) {
  if (!Number.isSafeInteger(categoryId) || categoryId <= 0 || !Number.isSafeInteger(amountSyp) || amountSyp <= 0) throw new Error('INVALID_EXPENSE');
  const normalizedNote = note?.trim() || null;
  if ((normalizedNote?.length ?? 0) > 240) throw new Error('EXPENSE_NOTE_TOO_LONG');
  const db = await dbPromise;
  await db.withExclusiveTransactionAsync(async transaction => {
    const activeSession = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM cash_sessions WHERE closed_at IS NULL LIMIT 1');
    if (!activeSession) throw new Error('CASH_SESSION_REQUIRED');
    const category = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM expense_categories WHERE id=? AND is_active=1', categoryId);
    if (!category) throw new Error('EXPENSE_CATEGORY_INACTIVE');
    const now = new Date().toISOString();
    await transaction.runAsync(
      'INSERT INTO expenses (uuid,description,amount_syp,category_id,note,created_at,updated_at,cash_session_id) VALUES (?,?,?,?,?,?,?,?)',
      createUuid(), normalizedNote ?? '', amountSyp, categoryId, normalizedNote, now, now, activeSession.id,
    );
  });
}

const cashSessionSummarySelect = `SELECT cs.*,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(s.sales_total_syp,0) ELSE cs.closing_sales_total_syp END AS sales_total_syp,COALESCE(s.invoice_count,0) AS invoice_count,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(r.refunds_total_syp,0) ELSE cs.closing_refunds_total_syp END AS refunds_total_syp,COALESCE(r.return_count,0) AS return_count,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(e.expenses_total_syp,0) ELSE cs.closing_expenses_total_syp END AS expenses_total_syp,COALESCE(e.expense_count,0) AS expense_count,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(p.cash_received_syp,0) ELSE COALESCE(cs.closing_cash_received_syp,cs.closing_sales_total_syp,0) END AS cash_received_syp,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(p.cash_received_usd_cents,0) ELSE COALESCE(cs.closing_cash_received_usd_cents,0) END AS cash_received_usd_cents,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(s.change_given_syp,0) ELSE COALESCE(cs.closing_change_given_syp,0) END AS change_given_syp,
  CASE WHEN cs.closed_at IS NULL THEN cs.opening_cash_syp+COALESCE(p.cash_received_syp,0)-COALESCE(s.change_given_syp,0)-COALESCE(r.refunds_total_syp,0)-COALESCE(e.expenses_total_syp,0) ELSE cs.closing_expected_cash_syp END AS expected_cash_syp,
  CASE WHEN cs.closed_at IS NULL THEN cs.opening_cash_usd_cents+COALESCE(p.cash_received_usd_cents,0) ELSE COALESCE(cs.closing_expected_cash_usd_cents,0) END AS expected_cash_usd_cents
  FROM cash_sessions cs
  LEFT JOIN (SELECT cash_session_id,SUM(net_total_syp) AS sales_total_syp,SUM(COALESCE(change_syp,0)) AS change_given_syp,COUNT(*) AS invoice_count FROM sales WHERE cash_session_id IS NOT NULL GROUP BY cash_session_id) s ON s.cash_session_id=cs.id
  LEFT JOIN (SELECT s.cash_session_id,SUM(CASE WHEN sp.currency='SYP' THEN sp.amount_minor ELSE 0 END) AS cash_received_syp,SUM(CASE WHEN sp.currency='USD' THEN sp.amount_minor ELSE 0 END) AS cash_received_usd_cents FROM sales s JOIN sale_payments sp ON sp.sale_id=s.id WHERE s.cash_session_id IS NOT NULL GROUP BY s.cash_session_id) p ON p.cash_session_id=cs.id
  LEFT JOIN (SELECT cash_session_id,SUM(refund_total_syp) AS refunds_total_syp,COUNT(*) AS return_count FROM sale_returns WHERE cash_session_id IS NOT NULL GROUP BY cash_session_id) r ON r.cash_session_id=cs.id
  LEFT JOIN (SELECT cash_session_id,SUM(amount_syp) AS expenses_total_syp,COUNT(*) AS expense_count FROM expenses WHERE cash_session_id IS NOT NULL GROUP BY cash_session_id) e ON e.cash_session_id=cs.id`;

const cashSessionDetailSelect = `SELECT cs.*,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE((SELECT SUM(net_total_syp) FROM sales WHERE cash_session_id=cs.id),0) ELSE cs.closing_sales_total_syp END AS sales_total_syp,
  (SELECT COUNT(*) FROM sales WHERE cash_session_id=cs.id) AS invoice_count,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE((SELECT SUM(refund_total_syp) FROM sale_returns WHERE cash_session_id=cs.id),0) ELSE cs.closing_refunds_total_syp END AS refunds_total_syp,
  (SELECT COUNT(*) FROM sale_returns WHERE cash_session_id=cs.id) AS return_count,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE((SELECT SUM(amount_syp) FROM expenses WHERE cash_session_id=cs.id),0) ELSE cs.closing_expenses_total_syp END AS expenses_total_syp,
  (SELECT COUNT(*) FROM expenses WHERE cash_session_id=cs.id) AS expense_count,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE((SELECT SUM(sp.amount_minor) FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE s.cash_session_id=cs.id AND sp.currency='SYP'),0) ELSE COALESCE(cs.closing_cash_received_syp,cs.closing_sales_total_syp,0) END AS cash_received_syp,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE((SELECT SUM(sp.amount_minor) FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE s.cash_session_id=cs.id AND sp.currency='USD'),0) ELSE COALESCE(cs.closing_cash_received_usd_cents,0) END AS cash_received_usd_cents,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE((SELECT SUM(change_syp) FROM sales WHERE cash_session_id=cs.id),0) ELSE COALESCE(cs.closing_change_given_syp,0) END AS change_given_syp,
  CASE WHEN cs.closed_at IS NULL THEN cs.opening_cash_syp+COALESCE((SELECT SUM(sp.amount_minor) FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE s.cash_session_id=cs.id AND sp.currency='SYP'),0)-COALESCE((SELECT SUM(change_syp) FROM sales WHERE cash_session_id=cs.id),0)-COALESCE((SELECT SUM(refund_total_syp) FROM sale_returns WHERE cash_session_id=cs.id),0)-COALESCE((SELECT SUM(amount_syp) FROM expenses WHERE cash_session_id=cs.id),0) ELSE cs.closing_expected_cash_syp END AS expected_cash_syp,
  CASE WHEN cs.closed_at IS NULL THEN cs.opening_cash_usd_cents+COALESCE((SELECT SUM(sp.amount_minor) FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE s.cash_session_id=cs.id AND sp.currency='USD'),0) ELSE COALESCE(cs.closing_expected_cash_usd_cents,0) END AS expected_cash_usd_cents
  FROM cash_sessions cs`;

function validateCashAmount(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_CASH_AMOUNT');
}

function normalizeSessionNote(note?: string | null) {
  const normalized = note?.trim() || null;
  if ((normalized?.length ?? 0) > 240) throw new Error('SESSION_NOTE_TOO_LONG');
  return normalized;
}

export async function getActiveCashSession(): Promise<CashSessionSummary | null> {
  const db = await dbPromise;
  return db.getFirstAsync<CashSessionSummary>(`${cashSessionDetailSelect} WHERE cs.closed_at IS NULL LIMIT 1`);
}

export async function openCashSession(openingCashSyp: number, openingCashUsdCents = 0, openingNote?: string | null): Promise<CashSessionSummary> {
  validateCashAmount(openingCashSyp);
  validateCashAmount(openingCashUsdCents);
  const note = normalizeSessionNote(openingNote);
  const db = await dbPromise;
  let id = 0;
  await db.withExclusiveTransactionAsync(async transaction => {
    const active = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM cash_sessions WHERE closed_at IS NULL LIMIT 1');
    if (active) throw new Error('CASH_SESSION_ALREADY_OPEN');
    const now = new Date().toISOString();
    const result = await transaction.runAsync(`INSERT INTO cash_sessions
      (uuid,opened_at,opening_cash_syp,opening_cash_usd_cents,opening_note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
    createUuid(), now, openingCashSyp, openingCashUsdCents, note, now, now);
    id = result.lastInsertRowId;
  });
  const session = await getCashSessionDetail(id);
  if (!session) throw new Error('CASH_SESSION_NOT_FOUND');
  return session;
}

export async function closeCashSession(actualCashSyp: number, actualCashUsdCents = 0, closingNote?: string | null): Promise<CashSessionSummary> {
  validateCashAmount(actualCashSyp);
  validateCashAmount(actualCashUsdCents);
  const note = normalizeSessionNote(closingNote);
  const db = await dbPromise;
  let id = 0;
  await db.withExclusiveTransactionAsync(async transaction => {
    const active = await transaction.getFirstAsync<CashSession>('SELECT * FROM cash_sessions WHERE closed_at IS NULL LIMIT 1');
    if (!active) throw new Error('CASH_SESSION_NOT_FOUND');
    const totals = await transaction.getFirstAsync<{ sales: number; refunds: number; expenses: number; cash_syp: number; cash_usd: number; change_syp: number }>(`SELECT
      COALESCE((SELECT SUM(net_total_syp) FROM sales WHERE cash_session_id=?),0) AS sales,
      COALESCE((SELECT SUM(refund_total_syp) FROM sale_returns WHERE cash_session_id=?),0) AS refunds,
      COALESCE((SELECT SUM(amount_syp) FROM expenses WHERE cash_session_id=?),0) AS expenses,
      COALESCE((SELECT SUM(sp.amount_minor) FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE s.cash_session_id=? AND sp.currency='SYP'),0) AS cash_syp,
      COALESCE((SELECT SUM(sp.amount_minor) FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE s.cash_session_id=? AND sp.currency='USD'),0) AS cash_usd,
      COALESCE((SELECT SUM(change_syp) FROM sales WHERE cash_session_id=?),0) AS change_syp`, active.id, active.id, active.id, active.id, active.id, active.id);
    const sales = totals?.sales ?? 0; const refunds = totals?.refunds ?? 0; const expenses = totals?.expenses ?? 0;
    const cashSyp = totals?.cash_syp ?? 0; const cashUsd = totals?.cash_usd ?? 0; const changeSyp = totals?.change_syp ?? 0;
    const expected = active.opening_cash_syp + cashSyp - changeSyp - refunds - expenses;
    const expectedUsd = active.opening_cash_usd_cents + cashUsd;
    const difference = actualCashSyp - expected;
    const differenceUsd = actualCashUsdCents - expectedUsd;
    if (![sales, refunds, expenses, cashSyp, cashUsd, changeSyp, expected, expectedUsd, difference, differenceUsd].every(Number.isSafeInteger)) throw new Error('INVALID_CASH_TOTAL');
    const now = new Date().toISOString();
    const result = await transaction.runAsync(`UPDATE cash_sessions SET closed_at=?,closing_actual_cash_syp=?,
      closing_sales_total_syp=?,closing_refunds_total_syp=?,closing_expenses_total_syp=?,
      closing_expected_cash_syp=?,closing_difference_syp=?,closing_actual_cash_usd_cents=?,closing_expected_cash_usd_cents=?,
      closing_difference_usd_cents=?,closing_cash_received_syp=?,closing_cash_received_usd_cents=?,closing_change_given_syp=?,closing_note=?,updated_at=?
      WHERE id=? AND closed_at IS NULL`, now, actualCashSyp, sales, refunds, expenses, expected, difference, actualCashUsdCents, expectedUsd,
    differenceUsd, cashSyp, cashUsd, changeSyp, note, now, active.id);
    if (result.changes !== 1) throw new Error('CASH_SESSION_ALREADY_CLOSED');
    id = active.id;
  });
  const session = await getCashSessionDetail(id);
  if (!session) throw new Error('CASH_SESSION_NOT_FOUND');
  return session;
}

export async function getCashSessionHistory(sort: 'newest' | 'oldest' = 'newest'): Promise<CashSessionHistoryRow[]> {
  const db = await dbPromise;
  const direction = sort === 'oldest' ? 'ASC' : 'DESC';
  return db.getAllAsync<CashSessionHistoryRow>(`SELECT id,uuid,opened_at,closed_at,closing_difference_syp,closing_difference_usd_cents
    FROM cash_sessions WHERE closed_at IS NOT NULL ORDER BY opened_at ${direction},id ${direction}`);
}

export async function getCashSessionsForExport(): Promise<CashSessionSummary[]> {
  const db = await dbPromise;
  return db.getAllAsync<CashSessionSummary>(`${cashSessionSummarySelect} WHERE cs.closed_at IS NOT NULL ORDER BY cs.opened_at DESC,cs.id DESC`);
}

export async function getCashSessionDetail(id: number): Promise<CashSessionSummary | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const db = await dbPromise;
  return db.getFirstAsync<CashSessionSummary>(`${cashSessionDetailSelect} WHERE cs.id=?`, id);
}

export async function getCashSessionSales(id: number) {
  const db = await dbPromise;
  const rows = await db.getAllAsync<Omit<Sale, 'items'>>('SELECT * FROM sales WHERE cash_session_id=? ORDER BY created_at DESC,id DESC', id);
  return attachInvoiceSummaries(rows);
}

export async function getCashSessionExpenses(id: number) {
  const db = await dbPromise;
  return db.getAllAsync<Expense>(`${expenseSelect} WHERE e.cash_session_id=? ORDER BY e.created_at DESC,e.id DESC`, id);
}

export async function getCashSessionReturns(id: number): Promise<CashSessionReturnSummary[]> {
  const db = await dbPromise;
  return db.getAllAsync<CashSessionReturnSummary>('SELECT sr.*,s.invoice_number FROM sale_returns sr JOIN sales s ON s.id=sr.sale_id WHERE sr.cash_session_id=? ORDER BY sr.created_at DESC,sr.id DESC', id);
}

export async function deleteExpense(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('INVALID_EXPENSE');
  const db = await dbPromise;
  await db.withExclusiveTransactionAsync(async transaction => {
    const expense = await transaction.getFirstAsync<{ session_closed_at: string | null }>(`SELECT cs.closed_at AS session_closed_at FROM expenses e LEFT JOIN cash_sessions cs ON cs.id=e.cash_session_id WHERE e.id=?`, id);
    if (!expense) throw new Error('EXPENSE_NOT_FOUND');
    if (expense.session_closed_at) throw new Error('CLOSED_SESSION_EXPENSE_IMMUTABLE');
    await transaction.runAsync('DELETE FROM expenses WHERE id=?', id);
  });
}
