import * as SQLite from 'expo-sqlite';
import { CashSession, CashSessionHistoryRow, CashSessionReturnSummary, CashSessionSummary, Customer, CustomerAccountEntry, CustomerAccountHealthReport, CustomerAccountSummary, CustomerInput, CustomerPayment, CustomerPaymentInput, ExchangeRateHistoryEntry, Expense, ExpenseCategory, ExpenseCategoryTotal, ExpenseQuery, InventoryDetail, InventoryHealthReport, InventoryListItem, InventoryMetrics, InventoryMovement, InventoryMovementType, InventoryQuery, InvoiceQuery, PaymentInput, Product, ProductInput, PurchaseReceipt, PurchaseReceiptInput, PurchaseReceiptItem, PurchaseReceiptQuery, PurchaseReturn, PurchaseReturnInput, PurchaseReturnQuery, ReturnSelection, Sale, SaleAccountInput, SaleItem, SaleItemInput, SalePayment, SaleReturn, SaleReturnItem, Settings, Supplier, SupplierAccountEntry, SupplierAccountHealthReport, SupplierAccountSummary, SupplierInput, SupplierPayment, SupplierPaymentInput, SupplierSort, SuspendedSale, SuspendedSaleItem, SuspendedSaleSummary } from '@/types';
import { createDeterministicUuid, createUuid, isUuid } from '@/utils/uuid';
import { cleanupTemporaryProductImages, deleteProductImage, isStoredProductImagePath, migrateLegacyProductImage, saveProductImage } from '@/media/productImageStorage';
import { normalizeBarcode } from '@/utils/barcode';
import { deriveReturnStatus, previewReturn, returnedQuantities } from '@/utils/returns';
import { DEFAULT_EXPENSE_CATEGORIES, OTHER_EXPENSE_CATEGORY_UUID } from '@/i18n/expenseCategories';
import { calculateSettlement } from '@/utils/multiCurrency';
import { calculateSupplierPaymentEquivalent } from '@/utils/supplierAccounts';
import { calculateCustomerPaymentEquivalent } from '@/utils/customerAccounts';
import { ACCOUNTING_V19_SCHEMA_SQL, SYSTEM_ACCOUNTS } from '@/accounting/accountingSchema';
import {
  accountingIsEnabled,
  addCashUsd,
  activateAccountingCutover,
  AccountingCutoverInput,
  changeCashSyp,
  consumeSupplierPositionLayers,
  createSupplierPositionLayer,
  postJournalEntry,
  recordInventoryValueChange,
  removeCashUsd,
  relieveInventoryValue,
  signedControlTransitionLines,
} from '@/accounting/accountingCore';
import type { JournalLineInput } from '@/accounting/accountingCore';
import { allocateIntegerByLargestRemainder, allocatePurchaseSypByLargestRemainder, incrementalHalfUpAllocation, splitCarryingValueAtZero, usdCentsToSyp } from '@/accounting/accountingMath';
import {
  auditAccountingHealth as auditAccountingHealthReport,
  buildAccountingReconciliation,
  buildAccountLedger,
  buildBalanceSheet,
  buildProfitAndLoss,
  buildTrialBalance,
  readAccountingSettings,
  readGeneralJournal,
  readJournalDetail,
} from '@/accounting/accountingReports';

const dbPromise = SQLite.openDatabaseAsync('sarafy.db');
export const getDatabase = () => dbPromise;
export const SCHEMA_VERSION = 19;

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

async function migrateSupplierAccountsV17() {
  const db = await dbPromise;
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((version?.user_version ?? 0) > SCHEMA_VERSION) throw new Error('DATABASE_NEWER_THAN_APP');
  if ((version?.user_version ?? 0) >= 17) return;
  await db.withExclusiveTransactionAsync(async transaction => {
    const supplierColumns = await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(suppliers)');
    if (!supplierColumns.some(column => column.name === 'accounting_enabled')) await transaction.execAsync('ALTER TABLE suppliers ADD COLUMN accounting_enabled INTEGER NOT NULL DEFAULT 0 CHECK(accounting_enabled IN (0,1))');
    if (!supplierColumns.some(column => column.name === 'accounting_started_at')) await transaction.execAsync('ALTER TABLE suppliers ADD COLUMN accounting_started_at TEXT');
    const sessionColumns = await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(cash_sessions)');
    if (!sessionColumns.some(column => column.name === 'closing_supplier_payments_syp')) await transaction.execAsync('ALTER TABLE cash_sessions ADD COLUMN closing_supplier_payments_syp INTEGER NOT NULL DEFAULT 0 CHECK(closing_supplier_payments_syp>=0)');
    if (!sessionColumns.some(column => column.name === 'closing_supplier_payments_usd_cents')) await transaction.execAsync('ALTER TABLE cash_sessions ADD COLUMN closing_supplier_payments_usd_cents INTEGER NOT NULL DEFAULT 0 CHECK(closing_supplier_payments_usd_cents>=0)');
    await transaction.execAsync(`
      CREATE TABLE supplier_account_balances (
        supplier_id INTEGER PRIMARY KEY REFERENCES suppliers(id) ON DELETE RESTRICT,
        balance_usd_cents INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE supplier_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
        cash_session_id INTEGER NOT NULL REFERENCES cash_sessions(id) ON DELETE RESTRICT,
        payment_mode TEXT NOT NULL CHECK(payment_mode IN ('SYP','USD','MIXED')),
        total_usd_equivalent_cents INTEGER NOT NULL CHECK(total_usd_equivalent_cents>0),
        exchange_rate_syp_per_usd INTEGER CHECK(exchange_rate_syp_per_usd>0),
        supplier_name_snapshot TEXT NOT NULL,
        note TEXT,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        balance_after_usd_cents INTEGER NOT NULL,
        CHECK((payment_mode='USD' AND exchange_rate_syp_per_usd IS NULL) OR (payment_mode IN ('SYP','MIXED') AND exchange_rate_syp_per_usd IS NOT NULL))
      );
      CREATE TABLE supplier_payment_tenders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        supplier_payment_id INTEGER NOT NULL REFERENCES supplier_payments(id) ON DELETE RESTRICT,
        currency TEXT NOT NULL CHECK(currency IN ('SYP','USD')),
        amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
        usd_equivalent_cents INTEGER NOT NULL CHECK(usd_equivalent_cents>0),
        exchange_rate_syp_per_usd INTEGER CHECK(exchange_rate_syp_per_usd>0),
        created_at TEXT NOT NULL,
        UNIQUE(supplier_payment_id,currency),
        CHECK((currency='SYP' AND exchange_rate_syp_per_usd IS NOT NULL) OR (currency='USD' AND exchange_rate_syp_per_usd IS NULL AND amount_minor=usd_equivalent_cents))
      );
      CREATE TABLE supplier_account_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
        type TEXT NOT NULL CHECK(type IN ('opening','purchase','purchase_return','payment')),
        delta_usd_cents INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        supplier_name_snapshot TEXT NOT NULL,
        purchase_receipt_id INTEGER REFERENCES purchase_receipts(id) ON DELETE RESTRICT,
        purchase_return_id INTEGER REFERENCES purchase_returns(id) ON DELETE RESTRICT,
        supplier_payment_id INTEGER REFERENCES supplier_payments(id) ON DELETE RESTRICT,
        note_snapshot TEXT,
        CHECK((type='opening' AND purchase_receipt_id IS NULL AND purchase_return_id IS NULL AND supplier_payment_id IS NULL) OR
              (type='purchase' AND purchase_receipt_id IS NOT NULL AND purchase_return_id IS NULL AND supplier_payment_id IS NULL AND delta_usd_cents>=0) OR
              (type='purchase_return' AND purchase_receipt_id IS NULL AND purchase_return_id IS NOT NULL AND supplier_payment_id IS NULL AND delta_usd_cents<=0) OR
              (type='payment' AND purchase_receipt_id IS NULL AND purchase_return_id IS NULL AND supplier_payment_id IS NOT NULL AND delta_usd_cents<0))
      );
      CREATE UNIQUE INDEX idx_supplier_account_opening ON supplier_account_entries(supplier_id) WHERE type='opening';
      CREATE UNIQUE INDEX idx_supplier_account_purchase ON supplier_account_entries(purchase_receipt_id) WHERE purchase_receipt_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_supplier_account_purchase_return ON supplier_account_entries(purchase_return_id) WHERE purchase_return_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_supplier_account_payment ON supplier_account_entries(supplier_payment_id) WHERE supplier_payment_id IS NOT NULL;
      CREATE INDEX idx_supplier_account_entries_supplier_date ON supplier_account_entries(supplier_id,occurred_at DESC,id DESC);
      CREATE INDEX idx_supplier_account_entries_supplier_type ON supplier_account_entries(supplier_id,type);
      CREATE INDEX idx_supplier_payments_supplier_date ON supplier_payments(supplier_id,occurred_at DESC,id DESC);
      CREATE INDEX idx_supplier_payments_session ON supplier_payments(cash_session_id);
      CREATE INDEX idx_supplier_payment_tenders_payment ON supplier_payment_tenders(supplier_payment_id);
      PRAGMA user_version = 17;
    `);
  });
}

async function migrateCustomerAccountsV18() {
  const db = await dbPromise;
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((version?.user_version ?? 0) > SCHEMA_VERSION) throw new Error('DATABASE_NEWER_THAN_APP');
  if ((version?.user_version ?? 0) >= 18) return;
  await db.withExclusiveTransactionAsync(async transaction => {
    const saleColumns = await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(sales)');
    if (!saleColumns.some(column => column.name === 'customer_id')) await transaction.execAsync('ALTER TABLE sales ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE RESTRICT');
    if (!saleColumns.some(column => column.name === 'customer_uuid_snapshot')) await transaction.execAsync('ALTER TABLE sales ADD COLUMN customer_uuid_snapshot TEXT');
    if (!saleColumns.some(column => column.name === 'customer_name_snapshot')) await transaction.execAsync('ALTER TABLE sales ADD COLUMN customer_name_snapshot TEXT');
    if (!saleColumns.some(column => column.name === 'on_account_syp')) await transaction.execAsync('ALTER TABLE sales ADD COLUMN on_account_syp INTEGER NOT NULL DEFAULT 0 CHECK(on_account_syp>=0)');
    const returnColumns = await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(sale_returns)');
    if (!returnColumns.some(column => column.name === 'customer_account_credit_syp')) await transaction.execAsync('ALTER TABLE sale_returns ADD COLUMN customer_account_credit_syp INTEGER NOT NULL DEFAULT 0 CHECK(customer_account_credit_syp>=0)');
    const sessionColumns = await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(cash_sessions)');
    if (!sessionColumns.some(column => column.name === 'closing_customer_payments_syp')) await transaction.execAsync('ALTER TABLE cash_sessions ADD COLUMN closing_customer_payments_syp INTEGER NOT NULL DEFAULT 0 CHECK(closing_customer_payments_syp>=0)');
    if (!sessionColumns.some(column => column.name === 'closing_customer_payments_usd_cents')) await transaction.execAsync('ALTER TABLE cash_sessions ADD COLUMN closing_customer_payments_usd_cents INTEGER NOT NULL DEFAULT 0 CHECK(closing_customer_payments_usd_cents>=0)');
    await transaction.execAsync(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        phone TEXT,
        note TEXT,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
        accounting_enabled INTEGER NOT NULL DEFAULT 0 CHECK(accounting_enabled IN (0,1)),
        accounting_started_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_customers_active_name ON customers(is_active,name COLLATE NOCASE,id);
      CREATE TABLE customer_account_balances (
        customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE RESTRICT,
        balance_syp INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE customer_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
        cash_session_id INTEGER NOT NULL REFERENCES cash_sessions(id) ON DELETE RESTRICT,
        payment_mode TEXT NOT NULL CHECK(payment_mode IN ('SYP','USD','MIXED')),
        total_syp_equivalent INTEGER NOT NULL CHECK(total_syp_equivalent>0),
        exchange_rate_syp_per_usd INTEGER CHECK(exchange_rate_syp_per_usd>0),
        customer_name_snapshot TEXT NOT NULL,
        note TEXT,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        balance_after_syp INTEGER NOT NULL,
        CHECK((payment_mode='SYP' AND exchange_rate_syp_per_usd IS NULL) OR (payment_mode IN ('USD','MIXED') AND exchange_rate_syp_per_usd IS NOT NULL))
      );
      CREATE TABLE customer_payment_tenders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        customer_payment_id INTEGER NOT NULL REFERENCES customer_payments(id) ON DELETE RESTRICT,
        currency TEXT NOT NULL CHECK(currency IN ('SYP','USD')),
        amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
        syp_equivalent INTEGER NOT NULL CHECK(syp_equivalent>0),
        exchange_rate_syp_per_usd INTEGER CHECK(exchange_rate_syp_per_usd>0),
        created_at TEXT NOT NULL,
        UNIQUE(customer_payment_id,currency),
        CHECK((currency='SYP' AND exchange_rate_syp_per_usd IS NULL AND amount_minor=syp_equivalent) OR (currency='USD' AND exchange_rate_syp_per_usd IS NOT NULL))
      );
      CREATE TABLE customer_account_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
        type TEXT NOT NULL CHECK(type IN ('opening','sale','sale_return','payment')),
        delta_syp INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        customer_name_snapshot TEXT NOT NULL,
        sale_id INTEGER REFERENCES sales(id) ON DELETE RESTRICT,
        sale_return_id INTEGER REFERENCES sale_returns(id) ON DELETE RESTRICT,
        customer_payment_id INTEGER REFERENCES customer_payments(id) ON DELETE RESTRICT,
        note_snapshot TEXT,
        CHECK((type='opening' AND sale_id IS NULL AND sale_return_id IS NULL AND customer_payment_id IS NULL) OR
          (type='sale' AND sale_id IS NOT NULL AND sale_return_id IS NULL AND customer_payment_id IS NULL AND delta_syp>0) OR
          (type='sale_return' AND sale_id IS NULL AND sale_return_id IS NOT NULL AND customer_payment_id IS NULL AND delta_syp<0) OR
          (type='payment' AND sale_id IS NULL AND sale_return_id IS NULL AND customer_payment_id IS NOT NULL AND delta_syp<0))
      );
      CREATE UNIQUE INDEX idx_customer_account_opening ON customer_account_entries(customer_id) WHERE type='opening';
      CREATE UNIQUE INDEX idx_customer_account_sale ON customer_account_entries(sale_id) WHERE sale_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_customer_account_sale_return ON customer_account_entries(sale_return_id) WHERE sale_return_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_customer_account_payment ON customer_account_entries(customer_payment_id) WHERE customer_payment_id IS NOT NULL;
      CREATE INDEX idx_customer_account_entries_customer_date ON customer_account_entries(customer_id,occurred_at DESC,id DESC);
      CREATE INDEX idx_customer_account_entries_customer_type ON customer_account_entries(customer_id,type);
      CREATE INDEX idx_customer_payments_customer_date ON customer_payments(customer_id,occurred_at DESC,id DESC);
      CREATE INDEX idx_customer_payments_session ON customer_payments(cash_session_id);
      CREATE INDEX idx_customer_payment_tenders_payment ON customer_payment_tenders(customer_payment_id);
      CREATE INDEX idx_sales_customer_id ON sales(customer_id);
      PRAGMA user_version = 18;
    `);
  });
}

async function addColumnsIfMissing(
  transaction: SQLite.SQLiteDatabase,
  table: string,
  additions: readonly (readonly [name: string, definition: string])[],
) {
  const columns = await transaction.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  const existing = new Set(columns.map(column => column.name));
  for (const [name, definition] of additions) {
    if (!existing.has(name)) await transaction.execAsync(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

async function migrateAccountingCoreV19() {
  const db = await dbPromise;
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((version?.user_version ?? 0) > SCHEMA_VERSION) throw new Error('DATABASE_NEWER_THAN_APP');
  if ((version?.user_version ?? 0) >= 19) return;
  await db.withExclusiveTransactionAsync(async transaction => {
    await addColumnsIfMissing(transaction, 'purchase_receipts', [
      ['accounting_exchange_rate_syp_per_usd', 'INTEGER CHECK(accounting_exchange_rate_syp_per_usd IS NULL OR accounting_exchange_rate_syp_per_usd>0)'],
      ['accounting_total_syp', 'INTEGER CHECK(accounting_total_syp IS NULL OR accounting_total_syp>=0)'],
      ['accounting_advance_usd_cents', 'INTEGER CHECK(accounting_advance_usd_cents IS NULL OR accounting_advance_usd_cents>=0)'],
      ['accounting_advance_syp', 'INTEGER CHECK(accounting_advance_syp IS NULL OR accounting_advance_syp>=0)'],
      ['accounting_payable_usd_cents', 'INTEGER CHECK(accounting_payable_usd_cents IS NULL OR accounting_payable_usd_cents>=0)'],
      ['accounting_payable_syp', 'INTEGER CHECK(accounting_payable_syp IS NULL OR accounting_payable_syp>=0)'],
    ]);
    await addColumnsIfMissing(transaction, 'purchase_receipt_items', [
      ['accounting_line_syp', 'INTEGER CHECK(accounting_line_syp IS NULL OR accounting_line_syp>=0)'],
      ['accounting_advance_usd_cents', 'INTEGER CHECK(accounting_advance_usd_cents IS NULL OR accounting_advance_usd_cents>=0)'],
      ['accounting_advance_syp', 'INTEGER CHECK(accounting_advance_syp IS NULL OR accounting_advance_syp>=0)'],
      ['accounting_payable_usd_cents', 'INTEGER CHECK(accounting_payable_usd_cents IS NULL OR accounting_payable_usd_cents>=0)'],
      ['accounting_payable_syp', 'INTEGER CHECK(accounting_payable_syp IS NULL OR accounting_payable_syp>=0)'],
    ]);
    await addColumnsIfMissing(transaction, 'purchase_returns', [
      ['accounting_exchange_rate_syp_per_usd', 'INTEGER CHECK(accounting_exchange_rate_syp_per_usd IS NULL OR accounting_exchange_rate_syp_per_usd>0)'],
      ['accounting_inventory_relief_syp', 'INTEGER CHECK(accounting_inventory_relief_syp IS NULL OR accounting_inventory_relief_syp>=0)'],
      ['accounting_position_relief_syp', 'INTEGER CHECK(accounting_position_relief_syp IS NULL OR accounting_position_relief_syp>=0)'],
      ['accounting_advance_created_syp', 'INTEGER CHECK(accounting_advance_created_syp IS NULL OR accounting_advance_created_syp>=0)'],
      ['accounting_variance_syp', 'INTEGER'],
    ]);
    await addColumnsIfMissing(transaction, 'purchase_return_items', [
      ['accounting_inventory_relief_syp', 'INTEGER CHECK(accounting_inventory_relief_syp IS NULL OR accounting_inventory_relief_syp>=0)'],
      ['accounting_position_relief_syp', 'INTEGER CHECK(accounting_position_relief_syp IS NULL OR accounting_position_relief_syp>=0)'],
      ['accounting_advance_created_syp', 'INTEGER CHECK(accounting_advance_created_syp IS NULL OR accounting_advance_created_syp>=0)'],
      ['accounting_variance_syp', 'INTEGER'],
    ]);
    await addColumnsIfMissing(transaction, 'sale_items', [
      ['accounting_cogs_syp', 'INTEGER CHECK(accounting_cogs_syp IS NULL OR accounting_cogs_syp>=0)'],
      ['accounting_restocked_quantity', 'INTEGER NOT NULL DEFAULT 0 CHECK(accounting_restocked_quantity>=0)'],
      ['accounting_restored_cogs_syp', 'INTEGER NOT NULL DEFAULT 0 CHECK(accounting_restored_cogs_syp>=0)'],
    ]);
    await addColumnsIfMissing(transaction, 'sale_return_items', [
      ['restock_quantity', 'INTEGER CHECK(restock_quantity IS NULL OR restock_quantity>=0)'],
      ['accounting_restored_cogs_syp', 'INTEGER CHECK(accounting_restored_cogs_syp IS NULL OR accounting_restored_cogs_syp>=0)'],
    ]);
    await addColumnsIfMissing(transaction, 'sale_payments', [
      ['accounting_cash_carrying_syp', 'INTEGER CHECK(accounting_cash_carrying_syp IS NULL OR accounting_cash_carrying_syp>=0)'],
    ]);
    await addColumnsIfMissing(transaction, 'customer_payment_tenders', [
      ['accounting_cash_carrying_syp', 'INTEGER CHECK(accounting_cash_carrying_syp IS NULL OR accounting_cash_carrying_syp>=0)'],
    ]);
    await addColumnsIfMissing(transaction, 'supplier_payments', [
      ['accounting_payable_relief_syp', 'INTEGER CHECK(accounting_payable_relief_syp IS NULL OR accounting_payable_relief_syp>=0)'],
      ['accounting_consideration_syp', 'INTEGER CHECK(accounting_consideration_syp IS NULL OR accounting_consideration_syp>=0)'],
      ['accounting_advance_created_syp', 'INTEGER CHECK(accounting_advance_created_syp IS NULL OR accounting_advance_created_syp>=0)'],
      ['accounting_realized_fx_syp', 'INTEGER'],
    ]);
    await addColumnsIfMissing(transaction, 'supplier_payment_tenders', [
      ['accounting_cash_carrying_syp', 'INTEGER CHECK(accounting_cash_carrying_syp IS NULL OR accounting_cash_carrying_syp>=0)'],
    ]);
    await addColumnsIfMissing(transaction, 'cash_sessions', [
      ['closing_book_cash_syp', 'INTEGER CHECK(closing_book_cash_syp IS NULL OR closing_book_cash_syp>=0)'],
      ['closing_book_cash_usd_cents', 'INTEGER CHECK(closing_book_cash_usd_cents IS NULL OR closing_book_cash_usd_cents>=0)'],
      ['closing_book_cash_usd_carrying_syp', 'INTEGER CHECK(closing_book_cash_usd_carrying_syp IS NULL OR closing_book_cash_usd_carrying_syp>=0)'],
    ]);
    await transaction.execAsync(ACCOUNTING_V19_SCHEMA_SQL);
    const now = new Date().toISOString();
    for (const account of SYSTEM_ACCOUNTS) {
      const result = await transaction.runAsync(
        `INSERT INTO gl_accounts(uuid,code,system_key,name_ar,name_en,account_type,normal_side,is_system,active,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,1,1,?,?)`,
        createDeterministicUuid(`gl-account:${account.systemKey}`), account.code, account.systemKey,
        account.nameAr, account.nameEn, account.accountType, account.normalSide, now, now,
      );
      await transaction.runAsync(
        'INSERT INTO gl_account_balances(account_id,debit_total_syp,credit_total_syp,net_balance_syp,updated_at) VALUES(?,0,0,0,?)',
        result.lastInsertRowId, now,
      );
    }
    await transaction.runAsync(
      `INSERT INTO accounting_settings(id,accounting_enabled,accounting_started_at,functional_currency,cutover_exchange_rate_syp_per_usd,opening_journal_entry_id,created_at,updated_at)
       VALUES(1,0,NULL,'SYP',NULL,NULL,?,?)`,
      now, now,
    );
    await transaction.execAsync('PRAGMA user_version = 19');
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
  await migrateSupplierAccountsV17();
  await migrateCustomerAccountsV18();
  await migrateAccountingCoreV19();
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

export async function activateAccounting(input: AccountingCutoverInput) {
  const db = await dbPromise;
  let result: Awaited<ReturnType<typeof activateAccountingCutover>> | undefined;
  await db.withExclusiveTransactionAsync(async transaction => {
    result = await activateAccountingCutover(transaction, input);
  });
  if (!result) throw new Error('ACCOUNTING_CUTOVER_FAILED');
  return result;
}

export const getAccountingSettings = async () => readAccountingSettings(await dbPromise);
export const getGeneralJournal = async (input: Parameters<typeof readGeneralJournal>[1] = {}) => readGeneralJournal(await dbPromise, input);
export const getJournalDetail = async (id: number) => readJournalDetail(await dbPromise, id);
export const getAccountLedger = async (accountId: number, input: Parameters<typeof buildAccountLedger>[2] = {}) => buildAccountLedger(await dbPromise, accountId, input);
export const getTrialBalance = async (asOf?: string | null) => buildTrialBalance(await dbPromise, asOf);
export const getProfitAndLoss = async (input: Parameters<typeof buildProfitAndLoss>[1] = {}) => buildProfitAndLoss(await dbPromise, input);
export const getBalanceSheet = async (asOf?: string | null) => buildBalanceSheet(await dbPromise, asOf);
export const auditAccountingHealth = async () => auditAccountingHealthReport(await dbPromise);
export const getAccountingReconciliation = async () => buildAccountingReconciliation(await dbPromise);

export interface AccountingCutoverPreview {
  activeCashSession: boolean;
  currentExchangeRateSypPerUsd: number;
  customers: Array<{ customerId: number; customerUuid: string; customerName: string; balanceSyp: number }>;
  suppliers: Array<{ supplierId: number; supplierUuid: string; supplierName: string; balanceUsdCents: number }>;
  inventory: Array<{ productId: number; productUuid: string; productName: string; quantity: number; currentCostUsd: number }>;
}

export async function getAccountingCutoverPreview(): Promise<AccountingCutoverPreview> {
  const db = await dbPromise;
  const [settings, activeSession, customers, suppliers, inventory] = await Promise.all([
    db.getFirstAsync<{ value: string }>("SELECT value FROM settings WHERE key='exchangeRate'"),
    db.getFirstAsync<{ id: number }>('SELECT id FROM cash_sessions WHERE closed_at IS NULL LIMIT 1'),
    db.getAllAsync<{ customer_id: number; uuid: string; name: string; balance_syp: number }>(`SELECT b.customer_id,c.uuid,c.name,b.balance_syp FROM customer_account_balances b JOIN customers c ON c.id=b.customer_id ORDER BY c.name COLLATE NOCASE,c.id`),
    db.getAllAsync<{ supplier_id: number; uuid: string; name: string; balance_usd_cents: number }>(`SELECT b.supplier_id,s.uuid,s.name,b.balance_usd_cents FROM supplier_account_balances b JOIN suppliers s ON s.id=b.supplier_id ORDER BY s.name COLLATE NOCASE,s.id`),
    db.getAllAsync<{ product_id: number; uuid: string; name: string; quantity: number; cost_usd: number }>(`SELECT b.product_id,p.uuid,p.name,b.quantity,p.cost_usd FROM inventory_balances b JOIN products p ON p.id=b.product_id WHERE b.tracking_enabled=1 ORDER BY p.name COLLATE NOCASE,p.id`),
  ]);
  const parsed: unknown = settings ? JSON.parse(settings.value) : 15000;
  if (!Number.isSafeInteger(parsed) || (parsed as number) <= 0) throw new Error('INVALID_EXCHANGE_RATE');
  return {
    activeCashSession: !!activeSession,
    currentExchangeRateSypPerUsd: parsed as number,
    customers: customers.map(row => ({ customerId: row.customer_id, customerUuid: row.uuid, customerName: row.name, balanceSyp: row.balance_syp })),
    suppliers: suppliers.map(row => ({ supplierId: row.supplier_id, supplierUuid: row.uuid, supplierName: row.name, balanceUsdCents: row.balance_usd_cents })),
    inventory: inventory.map(row => ({ productId: row.product_id, productUuid: row.uuid, productName: row.name, quantity: row.quantity, currentCostUsd: row.cost_usd })),
  };
}

export async function getAccountingCashControl() {
  const db = await dbPromise;
  return db.getFirstAsync<{ cash_syp: number; cash_usd_cents: number; cash_usd_carrying_syp: number; updated_at: string }>('SELECT cash_syp,cash_usd_cents,cash_usd_carrying_syp,updated_at FROM cash_control WHERE id=1');
}

export type CashAdjustmentReason = 'OWNER_CONTRIBUTION' | 'OWNER_WITHDRAWAL' | 'CASH_OVER' | 'CASH_SHORT';
export interface CashAdjustmentInput { currency: 'SYP' | 'USD'; amountMinor: number; reason: CashAdjustmentReason; note?: string | null }

export async function createCashAdjustment(input: CashAdjustmentInput) {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor === 0) throw new Error('INVALID_CASH_ADJUSTMENT_AMOUNT');
  const inflow = input.reason === 'OWNER_CONTRIBUTION' || input.reason === 'CASH_OVER';
  if ((inflow && input.amountMinor < 0) || (!inflow && input.amountMinor > 0)) throw new Error('CASH_ADJUSTMENT_DIRECTION_MISMATCH');
  const note = normalizeOptionalText(input.note, 240); const db = await dbPromise; let id = 0;
  await db.withExclusiveTransactionAsync(async transaction => {
    if (!await accountingIsEnabled(transaction)) throw new Error('ACCOUNTING_NOT_ENABLED');
    if (await transaction.getFirstAsync('SELECT id FROM cash_sessions WHERE closed_at IS NULL LIMIT 1')) throw new Error('CASH_ADJUSTMENT_ACTIVE_SESSION');
    const now = new Date().toISOString(); const magnitude = Math.abs(input.amountMinor);
    let carryingValueSyp: number; let exchangeRateSypPerUsd: number | null = null; let cashLine: JournalLineInput;
    if (input.currency === 'SYP') {
      carryingValueSyp = magnitude;
      cashLine = await changeCashSyp(transaction, input.amountMinor, now);
    } else {
      const rateRow = await transaction.getFirstAsync<{ value: string }>("SELECT value FROM settings WHERE key='exchangeRate'");
      const parsed: unknown = rateRow ? JSON.parse(rateRow.value) : null;
      if (!Number.isSafeInteger(parsed) || (parsed as number) <= 0) throw new Error('INVALID_EXCHANGE_RATE');
      exchangeRateSypPerUsd = parsed as number;
      if (inflow) {
        carryingValueSyp = usdCentsToSyp(magnitude, exchangeRateSypPerUsd);
        if (carryingValueSyp <= 0) throw new Error('INVALID_CASH_ADJUSTMENT_AMOUNT');
        cashLine = await addCashUsd(transaction, magnitude, carryingValueSyp, exchangeRateSypPerUsd, now);
      } else {
        const removed = await removeCashUsd(transaction, magnitude, exchangeRateSypPerUsd, now);
        carryingValueSyp = removed.carryingReliefSyp;
        if (carryingValueSyp <= 0) throw new Error('INVALID_CASH_ADJUSTMENT_AMOUNT');
        cashLine = removed.line;
      }
    }
    const adjustmentUuid = createUuid();
    const inserted = await transaction.runAsync(`INSERT INTO cash_adjustments(uuid,currency,amount_minor,carrying_value_syp,exchange_rate_syp_per_usd,reason,note,occurred_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`, adjustmentUuid, input.currency, input.amountMinor, carryingValueSyp, exchangeRateSypPerUsd, input.reason, note, now, now);
    id = inserted.lastInsertRowId;
    const offset: JournalLineInput = input.reason === 'OWNER_CONTRIBUTION'
      ? { account: 'OWNER_CONTRIBUTIONS', creditSyp: carryingValueSyp }
      : input.reason === 'OWNER_WITHDRAWAL'
        ? { account: 'OWNER_DRAWINGS', debitSyp: carryingValueSyp }
        : input.reason === 'CASH_OVER'
          ? { account: 'CASH_OVER_SHORT', creditSyp: carryingValueSyp }
          : { account: 'CASH_OVER_SHORT', debitSyp: carryingValueSyp };
    await postJournalEntry(transaction, { sourceType: 'cash_adjustment', sourceId: id, sourceUuid: adjustmentUuid, occurredAt: now,
      description: `Cash adjustment — ${input.reason}`, lines: [cashLine, offset] });
  });
  const row = await db.getFirstAsync('SELECT * FROM cash_adjustments WHERE id=?', id);
  if (!row) throw new Error('CASH_ADJUSTMENT_NOT_FOUND');
  return row;
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

export async function enableInventoryTracking(productId: number, openingQuantity: number, threshold: number | null, note?: string | null, accountingOpeningValueSyp?: number) {
  if (![productId, openingQuantity].every(Number.isSafeInteger) || productId <= 0 || openingQuantity < 0 || (threshold != null && (!Number.isSafeInteger(threshold) || threshold < 0))) throw new Error('INVALID_INVENTORY_INPUT');
  const db = await dbPromise; const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async transaction => {
    const accountingEnabled = await accountingIsEnabled(transaction);
    if (accountingEnabled && (!Number.isSafeInteger(accountingOpeningValueSyp) || (accountingOpeningValueSyp ?? -1) < 0 || (openingQuantity === 0 && accountingOpeningValueSyp !== 0))) throw new Error('ACCOUNTING_INVENTORY_VALUE_REQUIRED');
    const product = await transaction.getFirstAsync<Product>('SELECT * FROM products WHERE id=? AND is_active<>0', productId);
    if (!product) throw new Error('PRODUCT_NOT_FOUND');
    const existing = await transaction.getFirstAsync<{ tracking_enabled: number }>('SELECT tracking_enabled FROM inventory_balances WHERE product_id=?', productId);
    if (existing?.tracking_enabled) throw new Error('INVENTORY_ALREADY_ENABLED');
    await transaction.runAsync(`INSERT INTO inventory_balances(product_id,tracking_enabled,quantity,low_stock_threshold,created_at,updated_at) VALUES(?,1,?,?,?,?)
      ON CONFLICT(product_id) DO UPDATE SET tracking_enabled=1,quantity=excluded.quantity,low_stock_threshold=excluded.low_stock_threshold,updated_at=excluded.updated_at`, productId, openingQuantity, threshold, now, now);
    if (accountingEnabled) await transaction.runAsync('INSERT INTO inventory_value_balances(product_id,quantity_snapshot,carrying_value_syp,updated_at) VALUES(?,?,?,?)', productId, 0, 0, now);
    if (openingQuantity > 0) {
      const movementUuid = createUuid();
      const movement = await transaction.runAsync(`INSERT INTO inventory_movements(uuid,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,movement_type,quantity_delta,quantity_before,quantity_after,note,created_at)
        VALUES(?,?,?,?,?,'opening',?,0,?,?,?)`, movementUuid, product.id, product.uuid, product.name, product.barcode, openingQuantity, openingQuantity, note?.trim() || null, now);
      if (accountingEnabled) {
        await recordInventoryValueChange(transaction, { sourceType: 'opening', sourceId: movement.lastInsertRowId, sourceItemId: movement.lastInsertRowId,
          productId, quantityDelta: openingQuantity, valueDeltaSyp: accountingOpeningValueSyp ?? 0, occurredAt: now });
        await postJournalEntry(transaction, { sourceType: 'inventory_adjustment', sourceId: movement.lastInsertRowId, sourceUuid: movementUuid, occurredAt: now,
          description: `Opening inventory — ${product.name}`, lines: [
            { account: 'INVENTORY', debitSyp: accountingOpeningValueSyp ?? 0 },
            { account: 'INVENTORY_ADJUSTMENT_GAIN', creditSyp: accountingOpeningValueSyp ?? 0 },
          ] });
      }
    }
  });
}

export async function adjustInventory(productId: number, mode: 'stock_in' | 'stock_out' | 'physical_count', quantity: number, note?: string | null, accountingIncreaseValueSyp?: number) {
  if (!Number.isSafeInteger(productId) || productId <= 0 || !Number.isSafeInteger(quantity) || quantity < 0 || (mode !== 'physical_count' && quantity === 0)) throw new Error('INVALID_INVENTORY_INPUT');
  const db = await dbPromise; const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async transaction => {
    const accountingEnabled = await accountingIsEnabled(transaction);
    const row = await transaction.getFirstAsync<InventoryListItem>(`SELECT b.*,p.uuid AS product_uuid,p.name AS product_name,p.barcode,p.is_active,'in_stock' AS status FROM inventory_balances b JOIN products p ON p.id=b.product_id WHERE b.product_id=? AND b.tracking_enabled=1`, productId);
    if (!row) throw new Error('INVENTORY_NOT_TRACKED');
    const after = mode === 'stock_in' ? row.quantity + quantity : mode === 'stock_out' ? row.quantity - quantity : quantity;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('INSUFFICIENT_STOCK');
    const delta = after - row.quantity;
    if (delta === 0) return;
    if (accountingEnabled && delta > 0 && (!Number.isSafeInteger(accountingIncreaseValueSyp) || (accountingIncreaseValueSyp ?? -1) < 0)) throw new Error('ACCOUNTING_INVENTORY_VALUE_REQUIRED');
    const movementType: InventoryMovementType = mode === 'physical_count' ? 'adjustment' : mode;
    await transaction.runAsync('UPDATE inventory_balances SET quantity=?,updated_at=? WHERE product_id=? AND quantity=?', after, now, productId, row.quantity);
    const movementUuid = createUuid();
    const movement = await transaction.runAsync(`INSERT INTO inventory_movements(uuid,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,movement_type,quantity_delta,quantity_before,quantity_after,note,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, movementUuid, productId, row.product_uuid, row.product_name, row.barcode, movementType, delta, row.quantity, after, note?.trim() || null, now);
    if (accountingEnabled) {
      const value = delta > 0
        ? accountingIncreaseValueSyp ?? 0
        : -await relieveInventoryValue(transaction, { sourceType: movementType, sourceId: movement.lastInsertRowId, sourceItemId: movement.lastInsertRowId,
          productId, quantityOut: -delta, occurredAt: now });
      if (delta > 0) await recordInventoryValueChange(transaction, { sourceType: movementType, sourceId: movement.lastInsertRowId, sourceItemId: movement.lastInsertRowId,
        productId, quantityDelta: delta, valueDeltaSyp: value, occurredAt: now });
      const amount = Math.abs(value); const lines: JournalLineInput[] = delta > 0
        ? [{ account: 'INVENTORY', debitSyp: amount }, { account: 'INVENTORY_ADJUSTMENT_GAIN', creditSyp: amount }]
        : [{ account: 'INVENTORY_ADJUSTMENT_LOSS', debitSyp: amount }, { account: 'INVENTORY', creditSyp: amount }];
      await postJournalEntry(transaction, { sourceType: 'inventory_adjustment', sourceId: movement.lastInsertRowId, sourceUuid: movementUuid, occurredAt: now,
        description: `Inventory adjustment — ${row.product_name}`, lines });
    }
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

export async function getCustomers(search = '', includeInactive = true): Promise<Customer[]> {
  const db = await dbPromise; const where: string[] = []; const parameters: string[] = [];
  const term = search.trim();
  if (term) { where.push("(c.name LIKE ? COLLATE NOCASE OR COALESCE(c.phone,'') LIKE ?)"); parameters.push(`%${term}%`, `%${term}%`); }
  if (!includeInactive) where.push('c.is_active=1');
  return db.getAllAsync<Customer>(`SELECT c.*,b.balance_syp,COUNT(s.id) AS sale_count,MAX(s.created_at) AS latest_sale_at
    FROM customers c LEFT JOIN customer_account_balances b ON b.customer_id=c.id LEFT JOIN sales s ON s.customer_id=c.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY c.id ORDER BY c.name COLLATE NOCASE,c.id`, ...parameters);
}

export async function addCustomer(input: CustomerInput) {
  const name = input.name.trim(); const phone = normalizeOptionalText(input.phone, 80); const note = normalizeOptionalText(input.note, 240);
  if (!name || name.length > 120) throw new Error('INVALID_CUSTOMER');
  const db = await dbPromise; const now = new Date().toISOString();
  const result = await db.runAsync('INSERT INTO customers(uuid,name,phone,note,created_at,updated_at) VALUES(?,?,?,?,?,?)', createUuid(), name, phone, note, now, now);
  return result.lastInsertRowId;
}

export async function updateCustomer(id: number, input: CustomerInput) {
  const name = input.name.trim(); const phone = normalizeOptionalText(input.phone, 80); const note = normalizeOptionalText(input.note, 240);
  if (!Number.isSafeInteger(id) || id <= 0 || !name || name.length > 120) throw new Error('INVALID_CUSTOMER');
  const db = await dbPromise; const result = await db.runAsync('UPDATE customers SET name=?,phone=?,note=?,updated_at=? WHERE id=?', name, phone, note, new Date().toISOString(), id);
  if (!result.changes) throw new Error('CUSTOMER_NOT_FOUND');
}

export async function setCustomerActive(id: number, active: boolean) {
  const db = await dbPromise; const result = await db.runAsync('UPDATE customers SET is_active=?,updated_at=? WHERE id=?', active ? 1 : 0, new Date().toISOString(), id);
  if (!result.changes) throw new Error('CUSTOMER_NOT_FOUND');
  return active ? 'restored' as const : 'archived' as const;
}

async function postCustomerAccountEntry(transaction: SQLite.SQLiteDatabase, customer: Customer, input: { type: CustomerAccountEntry['type']; delta: number; occurredAt: string; note?: string | null; saleId?: number; saleReturnId?: number; customerPaymentId?: number }) {
  if (!Number.isSafeInteger(input.delta)) throw new Error('INVALID_CUSTOMER_ACCOUNT_AMOUNT');
  const balance = await transaction.getFirstAsync<{ balance_syp: number }>('SELECT balance_syp FROM customer_account_balances WHERE customer_id=?', customer.id);
  if (!balance) throw new Error('CUSTOMER_ACCOUNT_BALANCE_MISSING');
  const after = balance.balance_syp + input.delta;
  if (!Number.isSafeInteger(after)) throw new Error('INVALID_CUSTOMER_ACCOUNT_AMOUNT');
  await transaction.runAsync(`INSERT INTO customer_account_entries
    (uuid,customer_id,type,delta_syp,occurred_at,created_at,customer_name_snapshot,sale_id,sale_return_id,customer_payment_id,note_snapshot)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, createUuid(), customer.id, input.type, input.delta, input.occurredAt, input.occurredAt, customer.name,
  input.saleId ?? null, input.saleReturnId ?? null, input.customerPaymentId ?? null, input.note?.trim() || null);
  const changed = await transaction.runAsync('UPDATE customer_account_balances SET balance_syp=?,updated_at=? WHERE customer_id=? AND balance_syp=?', after, input.occurredAt, customer.id, balance.balance_syp);
  if (changed.changes !== 1) throw new Error('CUSTOMER_ACCOUNT_CONCURRENT_UPDATE');
  return after;
}

export async function activateCustomerAccount(customerId: number, openingBalanceSyp: number): Promise<CustomerAccountSummary> {
  if (!Number.isSafeInteger(customerId) || customerId <= 0 || !Number.isSafeInteger(openingBalanceSyp)) throw new Error('INVALID_CUSTOMER_ACCOUNT_AMOUNT');
  const db = await dbPromise; const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async transaction => {
    if (await accountingIsEnabled(transaction) && openingBalanceSyp !== 0) throw new Error('POST_CUTOVER_NONZERO_ACCOUNT_OPENING');
    const customer = await transaction.getFirstAsync<Customer>('SELECT * FROM customers WHERE id=?', customerId);
    if (!customer) throw new Error('CUSTOMER_NOT_FOUND');
    if (customer.accounting_enabled) throw new Error('CUSTOMER_ACCOUNT_ALREADY_ACTIVE');
    const changed = await transaction.runAsync('UPDATE customers SET accounting_enabled=1,accounting_started_at=?,updated_at=? WHERE id=? AND accounting_enabled=0', now, now, customerId);
    if (changed.changes !== 1) throw new Error('CUSTOMER_ACCOUNT_ALREADY_ACTIVE');
    await transaction.runAsync('INSERT INTO customer_account_balances(customer_id,balance_syp,updated_at) VALUES(?,?,?)', customerId, openingBalanceSyp, now);
    await transaction.runAsync(`INSERT INTO customer_account_entries(uuid,customer_id,type,delta_syp,occurred_at,created_at,customer_name_snapshot,note_snapshot)
      VALUES(?,?,'opening',?,?,?,?,?)`, createUuid(), customerId, openingBalanceSyp, now, now, customer.name, null);
  });
  const summary = await getCustomerAccountSummary(customerId); if (!summary) throw new Error('CUSTOMER_ACCOUNT_NOT_FOUND'); return summary;
}

export async function getCustomerAccountSummary(customerId: number): Promise<CustomerAccountSummary | null> {
  const db = await dbPromise;
  const customer = await db.getFirstAsync<Customer>('SELECT c.*,b.balance_syp FROM customers c LEFT JOIN customer_account_balances b ON b.customer_id=c.id WHERE c.id=?', customerId);
  if (!customer || !customer.accounting_enabled) return null;
  const totals = await db.getFirstAsync<{ opening: number; sales: number; returns: number; payments: number }>(`SELECT
    COALESCE(SUM(CASE WHEN type='opening' THEN delta_syp ELSE 0 END),0) opening,
    COALESCE(SUM(CASE WHEN type='sale' THEN delta_syp ELSE 0 END),0) sales,
    COALESCE(-SUM(CASE WHEN type='sale_return' THEN delta_syp ELSE 0 END),0) returns,
    COALESCE(-SUM(CASE WHEN type='payment' THEN delta_syp ELSE 0 END),0) payments
    FROM customer_account_entries WHERE customer_id=?`, customerId);
  return { customer, balanceSyp: customer.balance_syp ?? 0, openingSyp: totals?.opening ?? 0, salesSyp: totals?.sales ?? 0, returnsSyp: totals?.returns ?? 0, paymentsSyp: totals?.payments ?? 0 };
}

export async function getCustomerAccountEntries(customerId: number, type: CustomerAccountEntry['type'] | 'all' = 'all', limit = 200, from?: string): Promise<CustomerAccountEntry[]> {
  if (!Number.isSafeInteger(customerId) || customerId <= 0 || !['all','opening','sale','sale_return','payment'].includes(type) || !Number.isSafeInteger(limit) || limit <= 0 || limit > 1000 || (from != null && !Number.isFinite(Date.parse(from)))) throw new Error('INVALID_CUSTOMER_ACCOUNT_QUERY');
  const db = await dbPromise; const where = `${type === 'all' ? '' : ' AND ledger.type=?'}${from ? ' AND ledger.occurred_at>=?' : ''}`;
  return db.getAllAsync<CustomerAccountEntry>(`WITH ledger AS (
      SELECT e.*,SUM(e.delta_syp) OVER (PARTITION BY e.customer_id ORDER BY e.occurred_at,e.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) running_balance_syp
      FROM customer_account_entries e WHERE e.customer_id=?
    ) SELECT ledger.*,COALESCE(s.invoice_number,sr.uuid,cp.uuid) reference FROM ledger
    LEFT JOIN sales s ON s.id=ledger.sale_id LEFT JOIN sale_returns sr ON sr.id=ledger.sale_return_id LEFT JOIN customer_payments cp ON cp.id=ledger.customer_payment_id
    WHERE 1=1${where} ORDER BY ledger.occurred_at DESC,ledger.id DESC LIMIT ?`, customerId, ...(type === 'all' ? [] : [type]), ...(from ? [from] : []), limit);
}

export async function getCustomerPayments(customerId: number, limit = 100): Promise<CustomerPayment[]> {
  const db = await dbPromise; return db.getAllAsync<CustomerPayment>('SELECT * FROM customer_payments WHERE customer_id=? ORDER BY occurred_at DESC,id DESC LIMIT ?', customerId, limit);
}

export async function getCustomerPaymentDetail(id: number): Promise<CustomerPayment | null> {
  const db = await dbPromise; const payment = await db.getFirstAsync<CustomerPayment>('SELECT * FROM customer_payments WHERE id=?', id);
  if (!payment) return null; payment.tenders = await db.getAllAsync('SELECT * FROM customer_payment_tenders WHERE customer_payment_id=? ORDER BY id', id); return payment;
}

export async function createCustomerPayment(input: CustomerPaymentInput): Promise<CustomerPayment> {
  const db = await dbPromise; const note = normalizeOptionalText(input.note, 240); let paymentId = 0;
  await db.withExclusiveTransactionAsync(async transaction => {
    const customer = await transaction.getFirstAsync<Customer>('SELECT * FROM customers WHERE id=? AND is_active=1 AND accounting_enabled=1', input.customerId);
    if (!customer) throw new Error('CUSTOMER_ACCOUNT_INACTIVE');
    const session = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM cash_sessions WHERE closed_at IS NULL LIMIT 1');
    if (!session) throw new Error('CASH_SESSION_REQUIRED');
    const setting = await transaction.getFirstAsync<{ value: string }>("SELECT value FROM settings WHERE key='exchangeRate'");
    const rate: unknown = setting ? JSON.parse(setting.value) : null;
    if (!Number.isSafeInteger(rate) || (rate as number) <= 0) throw new Error('INVALID_EXCHANGE_RATE');
    const calculated = calculateCustomerPaymentEquivalent(input, rate as number); const now = new Date().toISOString();
    const current = await transaction.getFirstAsync<{ balance_syp: number }>('SELECT balance_syp FROM customer_account_balances WHERE customer_id=?', customer.id);
    if (!current) throw new Error('CUSTOMER_ACCOUNT_BALANCE_MISSING');
    const after = current.balance_syp - calculated.totalSyp;
    if (!Number.isSafeInteger(after)) throw new Error('INVALID_CUSTOMER_ACCOUNT_AMOUNT');
    const accountingEnabled = await accountingIsEnabled(transaction); const paymentUuid = createUuid();
    const result = await transaction.runAsync(`INSERT INTO customer_payments(uuid,customer_id,cash_session_id,payment_mode,total_syp_equivalent,exchange_rate_syp_per_usd,customer_name_snapshot,note,occurred_at,created_at,balance_after_syp)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, paymentUuid, customer.id, session.id, calculated.input.mode, calculated.totalSyp, calculated.input.mode === 'SYP' ? null : rate as number, customer.name, note, now, now, after);
    paymentId = result.lastInsertRowId;
    if (calculated.input.sypAmount > 0) await transaction.runAsync(`INSERT INTO customer_payment_tenders(uuid,customer_payment_id,currency,amount_minor,syp_equivalent,exchange_rate_syp_per_usd,accounting_cash_carrying_syp,created_at) VALUES(?,?,'SYP',?,?,NULL,?,?)`, createUuid(), paymentId, calculated.input.sypAmount, calculated.input.sypAmount, accountingEnabled ? calculated.input.sypAmount : null, now);
    if (calculated.input.usdCents > 0) await transaction.runAsync(`INSERT INTO customer_payment_tenders(uuid,customer_payment_id,currency,amount_minor,syp_equivalent,exchange_rate_syp_per_usd,accounting_cash_carrying_syp,created_at) VALUES(?,?,'USD',?,?,?,?,?)`, createUuid(), paymentId, calculated.input.usdCents, calculated.usdEquivalentSyp, rate as number, accountingEnabled ? calculated.usdEquivalentSyp : null, now);
    await postCustomerAccountEntry(transaction, customer, { type: 'payment', delta: -calculated.totalSyp, occurredAt: now, note, customerPaymentId: paymentId });
    if (accountingEnabled) {
      const lines = signedControlTransitionLines(current.balance_syp, after, 'ACCOUNTS_RECEIVABLE', 'CUSTOMER_CREDITS');
      if (calculated.input.sypAmount > 0) lines.push(await changeCashSyp(transaction, calculated.input.sypAmount, now));
      if (calculated.input.usdCents > 0) lines.push(await addCashUsd(transaction, calculated.input.usdCents, calculated.usdEquivalentSyp, rate as number, now));
      await postJournalEntry(transaction, { sourceType: 'customer_payment', sourceId: paymentId, sourceUuid: paymentUuid, occurredAt: now, description: `Customer payment — ${customer.name}`, lines });
    }
  });
  const payment = await getCustomerPaymentDetail(paymentId); if (!payment) throw new Error('CUSTOMER_PAYMENT_NOT_FOUND'); return payment;
}

export async function auditCustomerAccountHealth(): Promise<CustomerAccountHealthReport> {
  const db = await dbPromise;
  const row = await db.getFirstAsync<Record<string, number>>(`SELECT
    (SELECT COUNT(*) FROM customers c WHERE c.accounting_enabled=1 AND (c.accounting_started_at IS NULL OR NOT EXISTS(SELECT 1 FROM customer_account_balances b WHERE b.customer_id=c.id) OR 1<>(SELECT COUNT(*) FROM customer_account_entries e WHERE e.customer_id=c.id AND e.type='opening'))) active_missing,
    (SELECT COUNT(*) FROM customers c WHERE c.accounting_enabled=0 AND (EXISTS(SELECT 1 FROM customer_account_balances b WHERE b.customer_id=c.id) OR EXISTS(SELECT 1 FROM customer_account_entries e WHERE e.customer_id=c.id))) inactive_state,
    (SELECT COUNT(*) FROM customer_account_balances b LEFT JOIN customers c ON c.id=b.customer_id WHERE c.id IS NULL OR typeof(b.balance_syp)<>'integer' OR b.balance_syp<>COALESCE((SELECT SUM(e.delta_syp) FROM customer_account_entries e WHERE e.customer_id=b.customer_id),0)) balance_mismatch,
    (SELECT COUNT(*) FROM (SELECT sale_id,sale_return_id,customer_payment_id,type,COUNT(*) n FROM customer_account_entries WHERE type<>'opening' GROUP BY sale_id,sale_return_id,customer_payment_id,type HAVING n>1)) duplicate_sources,
    (SELECT COUNT(*) FROM customer_account_entries e LEFT JOIN customers c ON c.id=e.customer_id LEFT JOIN sales s ON s.id=e.sale_id LEFT JOIN sale_returns sr ON sr.id=e.sale_return_id LEFT JOIN customer_payments cp ON cp.id=e.customer_payment_id WHERE c.id IS NULL OR typeof(e.delta_syp)<>'integer' OR (e.type='sale' AND (s.id IS NULL OR e.delta_syp<>s.on_account_syp)) OR (e.type='sale_return' AND (sr.id IS NULL OR e.delta_syp<>-sr.customer_account_credit_syp)) OR (e.type='payment' AND (cp.id IS NULL OR e.delta_syp<>-cp.total_syp_equivalent OR cp.balance_after_syp<>(SELECT COALESCE(SUM(e2.delta_syp),0) FROM customer_account_entries e2 WHERE e2.customer_id=e.customer_id AND (e2.occurred_at<e.occurred_at OR (e2.occurred_at=e.occurred_at AND e2.id<=e.id)))))) invalid_entries,
    (SELECT COUNT(*) FROM customer_payments cp LEFT JOIN customers c ON c.id=cp.customer_id LEFT JOIN cash_sessions cs ON cs.id=cp.cash_session_id WHERE c.id IS NULL OR cs.id IS NULL OR NOT EXISTS(SELECT 1 FROM customer_payment_tenders t WHERE t.customer_payment_id=cp.id)) payments_without_tender,
    (SELECT COUNT(*) FROM customer_payment_tenders t LEFT JOIN customer_payments cp ON cp.id=t.customer_payment_id WHERE cp.id IS NULL) orphan_tenders,
    (SELECT COUNT(*) FROM customer_payments cp WHERE typeof(cp.total_syp_equivalent)<>'integer' OR cp.total_syp_equivalent<>(SELECT COALESCE(SUM(t.syp_equivalent),0) FROM customer_payment_tenders t WHERE t.customer_payment_id=cp.id)) payment_mismatch,
    (SELECT COUNT(*) FROM customer_payment_tenders t WHERE typeof(t.amount_minor)<>'integer' OR typeof(t.syp_equivalent)<>'integer' OR t.amount_minor<=0 OR t.syp_equivalent<=0 OR (t.currency='SYP' AND (t.amount_minor<>t.syp_equivalent OR t.exchange_rate_syp_per_usd IS NOT NULL)) OR (t.currency='USD' AND (typeof(t.exchange_rate_syp_per_usd)<>'integer' OR t.exchange_rate_syp_per_usd<=0))) invalid_tenders,
    (SELECT COUNT(*) FROM sale_returns WHERE typeof(customer_account_credit_syp)<>'integer' OR customer_account_credit_syp<0 OR customer_account_credit_syp>refund_total_syp) invalid_returns,
    (SELECT COUNT(*) FROM cash_sessions cs WHERE cs.closed_at IS NOT NULL AND (cs.closing_customer_payments_syp<>COALESCE((SELECT SUM(t.amount_minor) FROM customer_payments cp JOIN customer_payment_tenders t ON t.customer_payment_id=cp.id WHERE cp.cash_session_id=cs.id AND t.currency='SYP'),0) OR cs.closing_customer_payments_usd_cents<>COALESCE((SELECT SUM(t.amount_minor) FROM customer_payments cp JOIN customer_payment_tenders t ON t.customer_payment_id=cp.id WHERE cp.cash_session_id=cs.id AND t.currency='USD'),0))) session_mismatch`);
  return { activeWithoutBalance: row?.active_missing ?? 0, inactiveWithState: row?.inactive_state ?? 0, balanceMismatches: row?.balance_mismatch ?? 0, duplicateSources: row?.duplicate_sources ?? 0, invalidEntries: row?.invalid_entries ?? 0, paymentsWithoutTender: row?.payments_without_tender ?? 0, orphanTenders: row?.orphan_tenders ?? 0, paymentTotalMismatches: row?.payment_mismatch ?? 0, invalidTenders: row?.invalid_tenders ?? 0, invalidReturnSplits: row?.invalid_returns ?? 0, cashSessionMismatches: row?.session_mismatch ?? 0 };
}

export async function getSuppliers(search = '', sort: SupplierSort = 'name', includeInactive = true): Promise<Supplier[]> {
  const db = await dbPromise; const where: string[] = []; const parameters: string[] = [];
  const term = search.trim();
  if (term) { where.push('(s.name LIKE ? COLLATE NOCASE OR COALESCE(s.phone,\'\') LIKE ?)'); parameters.push(`%${term}%`, `%${term}%`); }
  if (!includeInactive) where.push('s.is_active=1');
  const order = sort === 'newest' ? 's.created_at DESC,s.id DESC' : 's.name COLLATE NOCASE ASC,s.id ASC';
  return db.getAllAsync<Supplier>(`SELECT s.*,b.balance_usd_cents,COUNT(pr.id) AS receipt_count,MAX(pr.received_at) AS latest_receipt_at,
    (SELECT COUNT(*) FROM purchase_returns sr WHERE sr.supplier_uuid_snapshot=s.uuid) AS return_count,
    (SELECT MAX(created_at) FROM purchase_returns sr WHERE sr.supplier_uuid_snapshot=s.uuid) AS latest_return_at
    FROM suppliers s LEFT JOIN supplier_account_balances b ON b.supplier_id=s.id LEFT JOIN purchase_receipts pr ON pr.supplier_id=s.id${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    GROUP BY s.id ORDER BY ${order}`, ...parameters);
}

async function postSupplierAccountEntry(
  transaction: SQLite.SQLiteDatabase,
  supplier: Supplier,
  input: { type: SupplierAccountEntry['type']; delta: number; occurredAt: string; note?: string | null; purchaseReceiptId?: number; purchaseReturnId?: number; supplierPaymentId?: number },
) {
  if (!Number.isSafeInteger(input.delta)) throw new Error('INVALID_SUPPLIER_ACCOUNT_AMOUNT');
  const balance = await transaction.getFirstAsync<{ balance_usd_cents: number }>('SELECT balance_usd_cents FROM supplier_account_balances WHERE supplier_id=?', supplier.id);
  if (!balance) throw new Error('SUPPLIER_ACCOUNT_BALANCE_MISSING');
  const after = balance.balance_usd_cents + input.delta;
  if (!Number.isSafeInteger(after)) throw new Error('INVALID_SUPPLIER_ACCOUNT_AMOUNT');
  await transaction.runAsync(`INSERT INTO supplier_account_entries
    (uuid,supplier_id,type,delta_usd_cents,occurred_at,created_at,supplier_name_snapshot,purchase_receipt_id,purchase_return_id,supplier_payment_id,note_snapshot)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, createUuid(), supplier.id, input.type, input.delta, input.occurredAt, input.occurredAt, supplier.name,
  input.purchaseReceiptId ?? null, input.purchaseReturnId ?? null, input.supplierPaymentId ?? null, input.note?.trim() || null);
  const changed = await transaction.runAsync('UPDATE supplier_account_balances SET balance_usd_cents=?,updated_at=? WHERE supplier_id=? AND balance_usd_cents=?', after, input.occurredAt, supplier.id, balance.balance_usd_cents);
  if (changed.changes !== 1) throw new Error('SUPPLIER_ACCOUNT_CONCURRENT_UPDATE');
  return after;
}

export async function activateSupplierAccount(supplierId: number, openingBalanceUsdCents: number): Promise<SupplierAccountSummary> {
  if (!Number.isSafeInteger(supplierId) || supplierId <= 0 || !Number.isSafeInteger(openingBalanceUsdCents)) throw new Error('INVALID_SUPPLIER_ACCOUNT_AMOUNT');
  const db = await dbPromise; const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async transaction => {
    if (await accountingIsEnabled(transaction) && openingBalanceUsdCents !== 0) throw new Error('POST_CUTOVER_NONZERO_ACCOUNT_OPENING');
    const supplier = await transaction.getFirstAsync<Supplier>('SELECT * FROM suppliers WHERE id=?', supplierId);
    if (!supplier) throw new Error('SUPPLIER_NOT_FOUND');
    if (supplier.accounting_enabled) throw new Error('SUPPLIER_ACCOUNT_ALREADY_ACTIVE');
    const changed = await transaction.runAsync('UPDATE suppliers SET accounting_enabled=1,accounting_started_at=?,updated_at=? WHERE id=? AND accounting_enabled=0', now, now, supplierId);
    if (changed.changes !== 1) throw new Error('SUPPLIER_ACCOUNT_ALREADY_ACTIVE');
    await transaction.runAsync('INSERT INTO supplier_account_balances(supplier_id,balance_usd_cents,updated_at) VALUES(?,?,?)', supplierId, openingBalanceUsdCents, now);
    await transaction.runAsync(`INSERT INTO supplier_account_entries(uuid,supplier_id,type,delta_usd_cents,occurred_at,created_at,supplier_name_snapshot,note_snapshot)
      VALUES(?,?,'opening',?,?,?,?,?)`, createUuid(), supplierId, openingBalanceUsdCents, now, now, supplier.name, null);
  });
  const summary = await getSupplierAccountSummary(supplierId); if (!summary) throw new Error('SUPPLIER_ACCOUNT_NOT_FOUND'); return summary;
}

export async function getSupplierAccountSummary(supplierId: number): Promise<SupplierAccountSummary | null> {
  const db = await dbPromise;
  const supplier = await db.getFirstAsync<Supplier>('SELECT s.*,b.balance_usd_cents FROM suppliers s LEFT JOIN supplier_account_balances b ON b.supplier_id=s.id WHERE s.id=?', supplierId);
  if (!supplier || !supplier.accounting_enabled) return null;
  const totals = await db.getFirstAsync<{ opening: number; purchases: number; returns: number; payments: number }>(`SELECT
    COALESCE(SUM(CASE WHEN type='opening' THEN delta_usd_cents ELSE 0 END),0) AS opening,
    COALESCE(SUM(CASE WHEN type='purchase' THEN delta_usd_cents ELSE 0 END),0) AS purchases,
    COALESCE(-SUM(CASE WHEN type='purchase_return' THEN delta_usd_cents ELSE 0 END),0) AS returns,
    COALESCE(-SUM(CASE WHEN type='payment' THEN delta_usd_cents ELSE 0 END),0) AS payments
    FROM supplier_account_entries WHERE supplier_id=?`, supplierId);
  return { supplier, balanceUsdCents: supplier.balance_usd_cents ?? 0, openingUsdCents: totals?.opening ?? 0, purchasesUsdCents: totals?.purchases ?? 0, returnsUsdCents: totals?.returns ?? 0, paymentsUsdCents: totals?.payments ?? 0 };
}

export async function getSupplierAccountEntries(supplierId: number, type: SupplierAccountEntry['type'] | 'all' = 'all', limit = 200, from?: string): Promise<SupplierAccountEntry[]> {
  if (!Number.isSafeInteger(supplierId) || supplierId <= 0 || !['all','opening','purchase','purchase_return','payment'].includes(type) || !Number.isSafeInteger(limit) || limit <= 0 || limit > 1000 || (from != null && !Number.isFinite(Date.parse(from)))) throw new Error('INVALID_SUPPLIER_ACCOUNT_QUERY');
  const db = await dbPromise;
  const where = `${type === 'all' ? '' : ' AND ledger.type=?'}${from ? ' AND ledger.occurred_at>=?' : ''}`;
  return db.getAllAsync<SupplierAccountEntry>(`WITH ledger AS (
      SELECT e.*,SUM(e.delta_usd_cents) OVER (PARTITION BY e.supplier_id ORDER BY e.occurred_at ASC,e.id ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance_usd_cents
      FROM supplier_account_entries e WHERE e.supplier_id=?
    ) SELECT ledger.*,COALESCE(pr.uuid,pret.uuid,sp.uuid) AS reference
    FROM ledger
    LEFT JOIN purchase_receipts pr ON pr.id=ledger.purchase_receipt_id
    LEFT JOIN purchase_returns pret ON pret.id=ledger.purchase_return_id
    LEFT JOIN supplier_payments sp ON sp.id=ledger.supplier_payment_id
    WHERE 1=1${where} ORDER BY ledger.occurred_at DESC,ledger.id DESC LIMIT ?`, supplierId, ...(type === 'all' ? [] : [type]), ...(from ? [from] : []), limit);
}

export async function getSupplierPayments(supplierId: number, limit = 100): Promise<SupplierPayment[]> {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) throw new Error('INVALID_SUPPLIER_ACCOUNT_QUERY');
  const db = await dbPromise;
  return db.getAllAsync<SupplierPayment>('SELECT * FROM supplier_payments WHERE supplier_id=? ORDER BY occurred_at DESC,id DESC LIMIT ?', supplierId, limit);
}

export async function getSupplierPaymentDetail(id: number): Promise<SupplierPayment | null> {
  const db = await dbPromise; const payment = await db.getFirstAsync<SupplierPayment>('SELECT * FROM supplier_payments WHERE id=?', id);
  if (!payment) return null;
  payment.tenders = await db.getAllAsync('SELECT * FROM supplier_payment_tenders WHERE supplier_payment_id=? ORDER BY id', id);
  return payment;
}

export async function createSupplierPayment(input: SupplierPaymentInput): Promise<SupplierPayment> {
  if (!Number.isSafeInteger(input.supplierId) || input.supplierId <= 0) throw new Error('INVALID_SUPPLIER_PAYMENT');
  const note = normalizeOptionalText(input.note, 500); const db = await dbPromise; const now = new Date().toISOString(); let paymentId = 0;
  await db.withExclusiveTransactionAsync(async transaction => {
    const supplier = await transaction.getFirstAsync<Supplier>('SELECT * FROM suppliers WHERE id=? AND accounting_enabled=1', input.supplierId);
    if (!supplier) throw new Error('SUPPLIER_ACCOUNT_INACTIVE');
    const session = await transaction.getFirstAsync<{ id: number; available_syp: number; available_usd_cents: number }>(`SELECT cs.id,
      cs.opening_cash_syp
        +COALESCE((SELECT SUM(sp.amount_minor) FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE s.cash_session_id=cs.id AND sp.currency='SYP'),0)
        -COALESCE((SELECT SUM(s.change_syp) FROM sales s WHERE s.cash_session_id=cs.id),0)
        +COALESCE((SELECT SUM(t.amount_minor) FROM customer_payments cp JOIN customer_payment_tenders t ON t.customer_payment_id=cp.id WHERE cp.cash_session_id=cs.id AND t.currency='SYP'),0)
        -COALESCE((SELECT SUM(sr.refund_total_syp-sr.customer_account_credit_syp) FROM sale_returns sr WHERE sr.cash_session_id=cs.id),0)
        -COALESCE((SELECT SUM(e.amount_syp) FROM expenses e WHERE e.cash_session_id=cs.id),0)
        -COALESCE((SELECT SUM(t.amount_minor) FROM supplier_payments p JOIN supplier_payment_tenders t ON t.supplier_payment_id=p.id WHERE p.cash_session_id=cs.id AND t.currency='SYP'),0) AS available_syp,
      cs.opening_cash_usd_cents
        +COALESCE((SELECT SUM(sp.amount_minor) FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE s.cash_session_id=cs.id AND sp.currency='USD'),0)
        +COALESCE((SELECT SUM(t.amount_minor) FROM customer_payments cp JOIN customer_payment_tenders t ON t.customer_payment_id=cp.id WHERE cp.cash_session_id=cs.id AND t.currency='USD'),0)
        -COALESCE((SELECT SUM(t.amount_minor) FROM supplier_payments p JOIN supplier_payment_tenders t ON t.supplier_payment_id=p.id WHERE p.cash_session_id=cs.id AND t.currency='USD'),0) AS available_usd_cents
      FROM cash_sessions cs WHERE cs.closed_at IS NULL LIMIT 1`);
    if (!session) throw new Error('CASH_SESSION_REQUIRED');
    const setting = await transaction.getFirstAsync<{ value: string }>("SELECT value FROM settings WHERE key='exchangeRate'");
    const parsedRate: unknown = setting ? JSON.parse(setting.value) : null;
    if (!Number.isSafeInteger(parsedRate) || (parsedRate as number) <= 0) throw new Error('INVALID_EXCHANGE_RATE');
    const calculated = calculateSupplierPaymentEquivalent(input, parsedRate as number);
    if (![session.available_syp, session.available_usd_cents].every(Number.isSafeInteger)
      || calculated.input.sypAmount > session.available_syp
      || calculated.input.usdCents > session.available_usd_cents) throw new Error('INSUFFICIENT_CASH_SESSION_FUNDS');
    const rate = calculated.input.mode === 'USD' ? null : parsedRate as number;
    const current = await transaction.getFirstAsync<{ balance_usd_cents: number }>('SELECT balance_usd_cents FROM supplier_account_balances WHERE supplier_id=?', supplier.id);
    if (!current) throw new Error('SUPPLIER_ACCOUNT_BALANCE_MISSING');
    const after = current.balance_usd_cents - calculated.totalUsdCents;
    if (!Number.isSafeInteger(after)) throw new Error('INVALID_SUPPLIER_ACCOUNT_AMOUNT');
    const accountingEnabled = await accountingIsEnabled(transaction); const paymentUuid = createUuid();
    const header = await transaction.runAsync(`INSERT INTO supplier_payments
      (uuid,supplier_id,cash_session_id,payment_mode,total_usd_equivalent_cents,exchange_rate_syp_per_usd,supplier_name_snapshot,note,occurred_at,created_at,balance_after_usd_cents)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, paymentUuid, supplier.id, session.id, calculated.input.mode, calculated.totalUsdCents, rate, supplier.name, note, now, now, after);
    paymentId = header.lastInsertRowId;
    let usdCashCarryingSyp = 0;
    if (accountingEnabled && calculated.input.usdCents > 0) usdCashCarryingSyp = (await removeCashUsd(transaction, calculated.input.usdCents, parsedRate as number, now)).carryingReliefSyp;
    if (calculated.input.sypAmount > 0) await transaction.runAsync(`INSERT INTO supplier_payment_tenders(uuid,supplier_payment_id,currency,amount_minor,usd_equivalent_cents,exchange_rate_syp_per_usd,accounting_cash_carrying_syp,created_at)
      VALUES(?,?,'SYP',?,?,?,?,?)`, createUuid(), paymentId, calculated.input.sypAmount, calculated.sypUsdCents, parsedRate as number, accountingEnabled ? calculated.input.sypAmount : null, now);
    if (calculated.input.usdCents > 0) await transaction.runAsync(`INSERT INTO supplier_payment_tenders(uuid,supplier_payment_id,currency,amount_minor,usd_equivalent_cents,exchange_rate_syp_per_usd,accounting_cash_carrying_syp,created_at)
      VALUES(?,?,'USD',?,?,NULL,?,?)`, createUuid(), paymentId, calculated.input.usdCents, calculated.input.usdCents, accountingEnabled ? usdCashCarryingSyp : null, now);
    await postSupplierAccountEntry(transaction, supplier, { type: 'payment', delta: -calculated.totalUsdCents, occurredAt: now, note, supplierPaymentId: paymentId });
    if (accountingEnabled) {
      const payableNative = Math.min(Math.max(current.balance_usd_cents, 0), calculated.totalUsdCents);
      const payableReliefSyp = payableNative > 0 ? await consumeSupplierPositionLayers(transaction, { supplierId: supplier.id, positionType: 'PAYABLE', sourceType: 'supplier_payment', sourceId: paymentId, nativeUsdCents: payableNative, occurredAt: now }) : 0;
      const totalConsiderationSyp = calculated.input.sypAmount + usdCashCarryingSyp;
      if (!Number.isSafeInteger(totalConsiderationSyp)) throw new Error('SUPPLIER_PAYMENT_ACCOUNTING_OVERFLOW');
      const split = splitCarryingValueAtZero(totalConsiderationSyp, payableNative, calculated.totalUsdCents);
      const advanceNative = calculated.totalUsdCents - payableNative;
      const realizedFx = payableReliefSyp - split.payableConsiderationSyp;
      await transaction.runAsync(`UPDATE supplier_payments SET accounting_payable_relief_syp=?,accounting_consideration_syp=?,accounting_advance_created_syp=?,accounting_realized_fx_syp=? WHERE id=?`,
      payableReliefSyp, totalConsiderationSyp, split.advanceConsiderationSyp, realizedFx, paymentId);
      if (advanceNative > 0) await createSupplierPositionLayer(transaction, { supplierId: supplier.id, positionType: 'ADVANCE', sourceType: 'supplier_payment', sourceId: paymentId,
        nativeUsdCents: advanceNative, carryingSyp: split.advanceConsiderationSyp, exchangeRateSypPerUsd: rate, occurredAt: now });
      const lines: JournalLineInput[] = [
        { account: 'ACCOUNTS_PAYABLE', debitSyp: payableReliefSyp },
        { account: 'SUPPLIER_ADVANCES', debitSyp: split.advanceConsiderationSyp },
      ];
      if (calculated.input.sypAmount > 0) lines.push(await changeCashSyp(transaction, -calculated.input.sypAmount, now));
      if (calculated.input.usdCents > 0) lines.push({ account: 'CASH_USD', creditSyp: usdCashCarryingSyp, sourceCurrency: 'USD', sourceAmountMinor: calculated.input.usdCents, exchangeRateSypPerUsd: parsedRate as number });
      if (realizedFx > 0) lines.push({ account: 'REALIZED_FX_GAIN', creditSyp: realizedFx });
      if (realizedFx < 0) lines.push({ account: 'REALIZED_FX_LOSS', debitSyp: -realizedFx });
      await postJournalEntry(transaction, { sourceType: 'supplier_payment', sourceId: paymentId, sourceUuid: paymentUuid, occurredAt: now,
        description: `Supplier payment — ${supplier.name}`, lines });
    }
  });
  const payment = await getSupplierPaymentDetail(paymentId); if (!payment) throw new Error('SUPPLIER_PAYMENT_NOT_FOUND'); return payment;
}

export async function auditSupplierAccountHealth(): Promise<SupplierAccountHealthReport> {
  const db = await dbPromise;
  const row = await db.getFirstAsync<Record<string, number>>(`SELECT
    (SELECT COUNT(*) FROM suppliers s WHERE s.accounting_enabled=1 AND
      (s.accounting_started_at IS NULL OR NOT EXISTS(SELECT 1 FROM supplier_account_balances b WHERE b.supplier_id=s.id) OR
       1<>(SELECT COUNT(*) FROM supplier_account_entries e WHERE e.supplier_id=s.id AND e.type='opening'))) AS active_missing,
    (SELECT COUNT(*) FROM suppliers s WHERE s.accounting_enabled=0 AND (EXISTS(SELECT 1 FROM supplier_account_balances b WHERE b.supplier_id=s.id) OR EXISTS(SELECT 1 FROM supplier_account_entries e WHERE e.supplier_id=s.id))) AS inactive_state,
    (SELECT COUNT(*) FROM supplier_account_balances b LEFT JOIN suppliers s ON s.id=b.supplier_id
      WHERE s.id IS NULL OR typeof(b.balance_usd_cents)<>'integer' OR b.balance_usd_cents<>COALESCE((SELECT SUM(e.delta_usd_cents) FROM supplier_account_entries e WHERE e.supplier_id=b.supplier_id),0)) AS balance_mismatch,
    (SELECT COUNT(*) FROM (SELECT purchase_receipt_id,purchase_return_id,supplier_payment_id,type,COUNT(*) n FROM supplier_account_entries WHERE type<>'opening' GROUP BY purchase_receipt_id,purchase_return_id,supplier_payment_id,type HAVING n>1)) AS duplicate_sources,
    (SELECT COUNT(*) FROM supplier_account_entries e
      LEFT JOIN suppliers supplier ON supplier.id=e.supplier_id
      LEFT JOIN purchase_receipts pr ON pr.id=e.purchase_receipt_id
      LEFT JOIN purchase_returns pret ON pret.id=e.purchase_return_id
      LEFT JOIN supplier_payments sp ON sp.id=e.supplier_payment_id
      WHERE supplier.id IS NULL OR typeof(e.delta_usd_cents)<>'integer'
         OR (e.type='purchase' AND (pr.id IS NULL OR e.delta_usd_cents<>(SELECT COALESCE(SUM(line_total_usd_cents),0) FROM purchase_receipt_items WHERE purchase_receipt_id=pr.id)))
         OR (e.type='purchase_return' AND (pret.id IS NULL OR e.delta_usd_cents<>-pret.total_value_usd_cents))
         OR (e.type='payment' AND (sp.id IS NULL OR e.delta_usd_cents<>-sp.total_usd_equivalent_cents OR sp.balance_after_usd_cents<>(SELECT COALESCE(SUM(e2.delta_usd_cents),0) FROM supplier_account_entries e2 WHERE e2.supplier_id=e.supplier_id AND (e2.occurred_at<e.occurred_at OR (e2.occurred_at=e.occurred_at AND e2.id<=e.id)))))) AS invalid_entries,
    (SELECT COUNT(*) FROM supplier_payments sp LEFT JOIN suppliers s ON s.id=sp.supplier_id LEFT JOIN cash_sessions cs ON cs.id=sp.cash_session_id
      WHERE s.id IS NULL OR cs.id IS NULL OR NOT EXISTS(SELECT 1 FROM supplier_payment_tenders t WHERE t.supplier_payment_id=sp.id)) AS payments_without_tender,
    (SELECT COUNT(*) FROM supplier_payment_tenders t LEFT JOIN supplier_payments sp ON sp.id=t.supplier_payment_id WHERE sp.id IS NULL) AS orphan_tenders,
    (SELECT COUNT(*) FROM supplier_payments sp WHERE typeof(sp.total_usd_equivalent_cents)<>'integer' OR typeof(sp.balance_after_usd_cents)<>'integer'
      OR sp.total_usd_equivalent_cents<>(SELECT COALESCE(SUM(t.usd_equivalent_cents),0) FROM supplier_payment_tenders t WHERE t.supplier_payment_id=sp.id)
      OR (sp.payment_mode='USD' AND sp.exchange_rate_syp_per_usd IS NOT NULL)
      OR (sp.payment_mode IN ('SYP','MIXED') AND (typeof(sp.exchange_rate_syp_per_usd)<>'integer' OR sp.exchange_rate_syp_per_usd<=0))
      OR (sp.payment_mode='SYP' AND ((SELECT COUNT(*) FROM supplier_payment_tenders t WHERE t.supplier_payment_id=sp.id AND t.currency='SYP')<>1 OR EXISTS(SELECT 1 FROM supplier_payment_tenders t WHERE t.supplier_payment_id=sp.id AND t.currency='USD')))
      OR (sp.payment_mode='USD' AND ((SELECT COUNT(*) FROM supplier_payment_tenders t WHERE t.supplier_payment_id=sp.id AND t.currency='USD')<>1 OR EXISTS(SELECT 1 FROM supplier_payment_tenders t WHERE t.supplier_payment_id=sp.id AND t.currency='SYP')))
      OR (sp.payment_mode='MIXED' AND ((SELECT COUNT(*) FROM supplier_payment_tenders t WHERE t.supplier_payment_id=sp.id AND t.currency='SYP')<>1 OR (SELECT COUNT(*) FROM supplier_payment_tenders t WHERE t.supplier_payment_id=sp.id AND t.currency='USD')<>1))) AS payment_mismatch,
    (SELECT COUNT(*) FROM supplier_payment_tenders t JOIN supplier_payments sp ON sp.id=t.supplier_payment_id WHERE typeof(t.amount_minor)<>'integer' OR typeof(t.usd_equivalent_cents)<>'integer' OR t.amount_minor<=0 OR t.usd_equivalent_cents<=0 OR (t.currency='USD' AND (t.amount_minor<>t.usd_equivalent_cents OR t.exchange_rate_syp_per_usd IS NOT NULL)) OR (t.currency='SYP' AND (typeof(t.exchange_rate_syp_per_usd)<>'integer' OR t.exchange_rate_syp_per_usd<=0 OR t.exchange_rate_syp_per_usd<>sp.exchange_rate_syp_per_usd))) AS invalid_tenders,
    (SELECT COUNT(*) FROM cash_sessions cs WHERE cs.closed_at IS NOT NULL AND (
      typeof(cs.closing_supplier_payments_syp)<>'integer' OR typeof(cs.closing_supplier_payments_usd_cents)<>'integer'
      OR cs.closing_supplier_payments_syp<>COALESCE((SELECT SUM(t.amount_minor) FROM supplier_payments sp JOIN supplier_payment_tenders t ON t.supplier_payment_id=sp.id WHERE sp.cash_session_id=cs.id AND t.currency='SYP'),0)
      OR cs.closing_supplier_payments_usd_cents<>COALESCE((SELECT SUM(t.amount_minor) FROM supplier_payments sp JOIN supplier_payment_tenders t ON t.supplier_payment_id=sp.id WHERE sp.cash_session_id=cs.id AND t.currency='USD'),0))) AS session_mismatch`);
  return {
    activeWithoutBalance: row?.active_missing ?? 0, inactiveWithState: row?.inactive_state ?? 0,
    balanceMismatches: row?.balance_mismatch ?? 0, duplicateSources: row?.duplicate_sources ?? 0,
    invalidEntries: row?.invalid_entries ?? 0, paymentsWithoutTender: row?.payments_without_tender ?? 0,
    orphanTenders: row?.orphan_tenders ?? 0, paymentTotalMismatches: row?.payment_mismatch ?? 0,
    invalidTenders: row?.invalid_tenders ?? 0, cashSessionMismatches: row?.session_mismatch ?? 0,
  };
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
  const productIds = new Set<number>(); let receiptTotalUsdCents = 0;
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.productId) || item.productId <= 0 || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || !Number.isSafeInteger(item.unitCostUsdCents) || item.unitCostUsdCents < 0 || productIds.has(item.productId)) throw new Error('INVALID_PURCHASE_ITEM');
    const total = BigInt(item.quantity) * BigInt(item.unitCostUsdCents); if (total > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(receiptTotalUsdCents) + total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_PURCHASE_ITEM');
    receiptTotalUsdCents += Number(total);
    productIds.add(item.productId);
  }
  const db = await dbPromise; const now = new Date().toISOString(); let receiptId = 0;
  await db.withExclusiveTransactionAsync(async transaction => {
    const supplier = await transaction.getFirstAsync<Supplier>('SELECT * FROM suppliers WHERE id=? AND is_active=1', input.supplierId);
    if (!supplier) throw new Error('SUPPLIER_INACTIVE');
    const accountingEnabled = await accountingIsEnabled(transaction);
    const setting = accountingEnabled ? await transaction.getFirstAsync<{ value: string }>("SELECT value FROM settings WHERE key='exchangeRate'") : null;
    const parsedRate: unknown = setting ? JSON.parse(setting.value) : null;
    if (accountingEnabled && (!Number.isSafeInteger(parsedRate) || (parsedRate as number) <= 0)) throw new Error('INVALID_EXCHANGE_RATE');
    const supplierBalance = accountingEnabled
      ? await transaction.getFirstAsync<{ balance_usd_cents: number }>('SELECT balance_usd_cents FROM supplier_account_balances WHERE supplier_id=?', supplier.id)
      : null;
    if (accountingEnabled && (!supplier.accounting_enabled || !supplierBalance)) throw new Error('SUPPLIER_ACCOUNT_INACTIVE');
    const advanceNative = accountingEnabled ? Math.min(receiptTotalUsdCents, Math.max(-(supplierBalance?.balance_usd_cents ?? 0), 0)) : 0;
    const payableNative = accountingEnabled ? receiptTotalUsdCents - advanceNative : 0;
    const payableSyp = accountingEnabled ? usdCentsToSyp(payableNative, parsedRate as number) : 0;
    const receiptUuid = createUuid();
    const result = await transaction.runAsync(`INSERT INTO purchase_receipts(uuid,supplier_id,supplier_uuid_snapshot,supplier_name_snapshot,reference_number,note,received_at,created_at,
      accounting_exchange_rate_syp_per_usd,accounting_total_syp,accounting_advance_usd_cents,accounting_advance_syp,accounting_payable_usd_cents,accounting_payable_syp)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, receiptUuid, supplier.id, supplier.uuid, supplier.name, reference, note, now, now,
    accountingEnabled ? parsedRate as number : null, null, accountingEnabled ? advanceNative : null, null, accountingEnabled ? payableNative : null, accountingEnabled ? payableSyp : null);
    receiptId = result.lastInsertRowId;
    const advanceSyp = accountingEnabled && advanceNative > 0 ? await consumeSupplierPositionLayers(transaction, {
      supplierId: supplier.id, positionType: 'ADVANCE', sourceType: 'purchase', sourceId: receiptId, nativeUsdCents: advanceNative, occurredAt: now,
    }) : 0;
    const accountingTotalSyp = advanceSyp + payableSyp;
    if (!Number.isSafeInteger(accountingTotalSyp)) throw new Error('PURCHASE_ACCOUNTING_OVERFLOW');
    if (accountingEnabled) await transaction.runAsync('UPDATE purchase_receipts SET accounting_total_syp=?,accounting_advance_syp=? WHERE id=?', accountingTotalSyp, advanceSyp, receiptId);
    const itemPlans = input.items.map((item, sequence) => ({ item, uuid: createUuid(), sequence, native: item.quantity * item.unitCostUsdCents }));
    // Purchase line allocation is tied to the immutable receipt insertion sequence.
    // A generated UUID is portable identity, but must not decide accounting residuals.
    const stablePlans = itemPlans;
    let advanceRemaining = advanceNative; let advanceCumulative = 0;
    const allocations = new Map<number, { advanceNative: number; advanceSyp: number; payableNative: number; payableSyp: number }>();
    for (const plan of stablePlans) {
      const lineAdvanceNative = Math.min(plan.native, advanceRemaining); const prior = advanceCumulative;
      advanceCumulative += lineAdvanceNative; advanceRemaining -= lineAdvanceNative;
      const lineAdvanceSyp = advanceNative > 0 ? incrementalHalfUpAllocation(advanceSyp, prior, advanceCumulative, advanceNative) : 0;
      allocations.set(plan.sequence, { advanceNative: lineAdvanceNative, advanceSyp: lineAdvanceSyp, payableNative: plan.native - lineAdvanceNative, payableSyp: 0 });
    }
    if (advanceRemaining !== 0) throw new Error('PURCHASE_ADVANCE_ALLOCATION_MISMATCH');
    if (payableNative > 0) {
      const payableAllocation = allocatePurchaseSypByLargestRemainder(stablePlans.map(plan => ({ key: plan.sequence, usdCents: allocations.get(plan.sequence)!.payableNative })), parsedRate as number);
      for (const line of payableAllocation.allocations) allocations.get(line.key)!.payableSyp = line.accountingSyp;
      if (payableAllocation.totalSyp !== payableSyp) throw new Error('PURCHASE_PAYABLE_ALLOCATION_MISMATCH');
    }
    for (const plan of itemPlans) {
      const item = plan.item; const allocation = allocations.get(plan.sequence)!;
      const product = await transaction.getFirstAsync<Product & { tracking_enabled: number; quantity: number }>(`SELECT p.*,b.tracking_enabled,b.quantity FROM products p JOIN inventory_balances b ON b.product_id=p.id WHERE p.id=? AND p.is_active=1 AND b.tracking_enabled=1`, item.productId);
      if (!product) throw new Error('PRODUCT_NOT_TRACKED');
      const lineTotal = plan.native; const lineAccountingSyp = allocation.advanceSyp + allocation.payableSyp;
      const itemResult = await transaction.runAsync(`INSERT INTO purchase_receipt_items(uuid,purchase_receipt_id,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,quantity,unit_cost_usd_cents,line_total_usd_cents,created_at,
        accounting_line_syp,accounting_advance_usd_cents,accounting_advance_syp,accounting_payable_usd_cents,accounting_payable_syp)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, plan.uuid, receiptId, product.id, product.uuid, product.name, product.barcode, item.quantity, item.unitCostUsdCents, lineTotal, now,
      accountingEnabled ? lineAccountingSyp : null, accountingEnabled ? allocation.advanceNative : null, accountingEnabled ? allocation.advanceSyp : null,
      accountingEnabled ? allocation.payableNative : null, accountingEnabled ? allocation.payableSyp : null);
      const after = product.quantity + item.quantity; if (!Number.isSafeInteger(after)) throw new Error('INVALID_PURCHASE_ITEM');
      if (accountingEnabled) await recordInventoryValueChange(transaction, { sourceType: 'purchase', sourceId: receiptId, sourceItemId: itemResult.lastInsertRowId,
        productId: product.id, quantityDelta: item.quantity, valueDeltaSyp: lineAccountingSyp, occurredAt: now });
      const changed = await transaction.runAsync('UPDATE inventory_balances SET quantity=?,updated_at=? WHERE product_id=? AND quantity=? AND tracking_enabled=1', after, now, product.id, product.quantity);
      if (!changed.changes) throw new Error('INVENTORY_CONCURRENT_UPDATE');
      await transaction.runAsync(`INSERT INTO inventory_movements(uuid,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,movement_type,quantity_delta,quantity_before,quantity_after,purchase_receipt_item_id,note,created_at)
        VALUES(?,?,?,?,?,'purchase',?,?,?,?,?,?)`, createUuid(), product.id, product.uuid, product.name, product.barcode, item.quantity, product.quantity, after, itemResult.lastInsertRowId, reference, now);
    }
    if (supplier.accounting_enabled) await postSupplierAccountEntry(transaction, supplier, { type: 'purchase', delta: receiptTotalUsdCents, occurredAt: now, note, purchaseReceiptId: receiptId });
    if (accountingEnabled) {
      if (payableNative > 0) await createSupplierPositionLayer(transaction, { supplierId: supplier.id, positionType: 'PAYABLE', sourceType: 'purchase', sourceId: receiptId,
        nativeUsdCents: payableNative, carryingSyp: payableSyp, exchangeRateSypPerUsd: parsedRate as number, occurredAt: now });
      await postJournalEntry(transaction, { sourceType: 'purchase', sourceId: receiptId, sourceUuid: receiptUuid, reference, occurredAt: now,
        description: `Purchase receipt — ${supplier.name}`, lines: [
          { account: 'INVENTORY', debitSyp: accountingTotalSyp },
          { account: 'SUPPLIER_ADVANCES', creditSyp: advanceSyp },
          { account: 'ACCOUNTS_PAYABLE', creditSyp: payableSyp },
        ] });
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
    const receipt = await transaction.getFirstAsync<PurchaseReceipt & { accounting_total_syp: number | null; accounting_exchange_rate_syp_per_usd: number | null }>('SELECT * FROM purchase_receipts WHERE id=?', input.purchaseReceiptId);
    if (!receipt) throw new Error('PURCHASE_RECEIPT_NOT_FOUND');
    const rows = await transaction.getAllAsync<PurchaseReceiptItem & { accounting_line_syp: number | null; returned_quantity: number; inventory_quantity: number; tracking_enabled: number }>(`SELECT pi.*,
      COALESCE(SUM(ri.quantity),0) AS returned_quantity,COALESCE(b.quantity,0) AS inventory_quantity,COALESCE(b.tracking_enabled,0) AS tracking_enabled
      FROM purchase_receipt_items pi LEFT JOIN purchase_return_items ri ON ri.purchase_receipt_item_id=pi.id
      LEFT JOIN inventory_balances b ON b.product_id=pi.product_id
      WHERE pi.purchase_receipt_id=? GROUP BY pi.id`, input.purchaseReceiptId);
    const byId = new Map(rows.map(row => [row.id, row])); let totalQuantity = 0; let totalValue = 0; let receiptBasisSyp = 0;
    for (const [itemId, quantity] of requested) {
      const item = byId.get(itemId); if (!item) throw new Error('PURCHASE_RETURN_ITEM_NOT_FOUND');
      if (!item.product_id || item.tracking_enabled !== 1) throw new Error('PURCHASE_RETURN_PRODUCT_UNAVAILABLE');
      const remaining = item.quantity - item.returned_quantity;
      if (quantity > remaining) throw new Error('PURCHASE_OVER_RETURN');
      if (quantity > item.inventory_quantity) throw new Error('INSUFFICIENT_STOCK');
      const lineTotal = BigInt(quantity) * BigInt(item.unit_cost_usd_cents);
      if (lineTotal > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(totalQuantity + quantity) || BigInt(totalValue) + lineTotal > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_PURCHASE_RETURN_ITEM');
      totalQuantity += quantity; totalValue += Number(lineTotal);
      if (receipt.accounting_total_syp != null) {
        if (!Number.isSafeInteger(item.accounting_line_syp) || (item.accounting_line_syp ?? 0) < 0) throw new Error('INVALID_PURCHASE_ACCOUNTING_SNAPSHOT');
        const lineBasis = incrementalHalfUpAllocation(item.accounting_line_syp ?? 0, item.returned_quantity, item.returned_quantity + quantity, item.quantity);
        receiptBasisSyp += lineBasis; if (!Number.isSafeInteger(receiptBasisSyp)) throw new Error('PURCHASE_RETURN_ACCOUNTING_OVERFLOW');
      }
    }
    const accountingEnabled = await accountingIsEnabled(transaction);
    const supplier = accountingEnabled && receipt.supplier_id
      ? await transaction.getFirstAsync<Supplier>('SELECT * FROM suppliers WHERE id=? AND accounting_enabled=1', receipt.supplier_id)
      : null;
    if (accountingEnabled && !supplier) throw new Error('SUPPLIER_ACCOUNT_INACTIVE');
    const supplierBalance = accountingEnabled
      ? await transaction.getFirstAsync<{ balance_usd_cents: number }>('SELECT balance_usd_cents FROM supplier_account_balances WHERE supplier_id=?', supplier!.id)
      : null;
    if (accountingEnabled && !supplierBalance) throw new Error('SUPPLIER_ACCOUNT_BALANCE_MISSING');
    const setting = accountingEnabled ? await transaction.getFirstAsync<{ value: string }>("SELECT value FROM settings WHERE key='exchangeRate'") : null;
    const parsedRate: unknown = setting ? JSON.parse(setting.value) : null;
    if (accountingEnabled && (!Number.isSafeInteger(parsedRate) || (parsedRate as number) <= 0)) throw new Error('INVALID_EXCHANGE_RATE');
    const payableNative = accountingEnabled ? Math.min(Math.max(supplierBalance?.balance_usd_cents ?? 0, 0), totalValue) : 0;
    const advanceNative = accountingEnabled ? totalValue - payableNative : 0;
    const returnUuid = createUuid();
    const header = await transaction.runAsync(`INSERT INTO purchase_returns(uuid,purchase_receipt_id,supplier_uuid_snapshot,supplier_name_snapshot,created_at,total_quantity,total_value_usd_cents,reference_number,note,accounting_exchange_rate_syp_per_usd)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, returnUuid, receipt.id, receipt.supplier_uuid_snapshot, receipt.supplier_name_snapshot, now, totalQuantity, totalValue, reference, note,
    accountingEnabled ? parsedRate as number : null);
    returnId = header.lastInsertRowId;
    const payableReliefSyp = accountingEnabled && payableNative > 0 ? await consumeSupplierPositionLayers(transaction, {
      supplierId: supplier!.id, positionType: 'PAYABLE', sourceType: 'supplier_return', sourceId: returnId, nativeUsdCents: payableNative, occurredAt: now,
    }) : 0;
    const advanceCreatedSyp = accountingEnabled && advanceNative > 0
      ? receipt.accounting_total_syp != null
        ? splitCarryingValueAtZero(receiptBasisSyp, payableNative, totalValue).advanceConsiderationSyp
        : usdCentsToSyp(advanceNative, parsedRate as number)
      : 0;
    const positionReliefSyp = payableReliefSyp + advanceCreatedSyp;
    if (!Number.isSafeInteger(positionReliefSyp)) throw new Error('PURCHASE_RETURN_ACCOUNTING_OVERFLOW');
    const positionByItem = accountingEnabled ? new Map(allocateIntegerByLargestRemainder(positionReliefSyp,
      [...requested].map(([itemId, quantity]) => ({ key: itemId, weight: quantity * byId.get(itemId)!.unit_cost_usd_cents }))).map(row => [row.key, row.amount])) : new Map<number, number>();
    const advanceByItem = accountingEnabled ? new Map(allocateIntegerByLargestRemainder(advanceCreatedSyp,
      [...requested].map(([itemId, quantity]) => ({ key: itemId, weight: quantity * byId.get(itemId)!.unit_cost_usd_cents }))).map(row => [row.key, row.amount])) : new Map<number, number>();
    let inventoryReliefSyp = 0; let varianceSyp = 0;
    for (const [itemId, quantity] of requested) {
      const item = byId.get(itemId)!; const after = item.inventory_quantity - quantity;
      const changed = await transaction.runAsync('UPDATE inventory_balances SET quantity=?,updated_at=? WHERE product_id=? AND tracking_enabled=1 AND quantity=?', after, now, item.product_id, item.inventory_quantity);
      if (!changed.changes) throw new Error('INVENTORY_CONCURRENT_UPDATE');
      const lineTotal = quantity * item.unit_cost_usd_cents;
      const itemUuid = createUuid();
      const inserted = await transaction.runAsync(`INSERT INTO purchase_return_items(uuid,purchase_return_id,purchase_receipt_item_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,quantity,unit_cost_usd_cents,line_total_usd_cents,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, itemUuid, returnId, item.id, item.product_uuid_snapshot, item.product_name_snapshot, item.barcode_snapshot, quantity, item.unit_cost_usd_cents, lineTotal, now);
      const itemInventoryRelief = accountingEnabled ? await relieveInventoryValue(transaction, { sourceType: 'supplier_return', sourceId: returnId,
        sourceItemId: inserted.lastInsertRowId, productId: item.product_id!, quantityOut: quantity, occurredAt: now }) : 0;
      const itemPositionRelief = positionByItem.get(itemId) ?? 0; const itemAdvance = advanceByItem.get(itemId) ?? 0;
      const itemVariance = itemInventoryRelief - itemPositionRelief;
      if (accountingEnabled) await transaction.runAsync(`UPDATE purchase_return_items SET accounting_inventory_relief_syp=?,accounting_position_relief_syp=?,accounting_advance_created_syp=?,accounting_variance_syp=? WHERE id=?`,
      itemInventoryRelief, itemPositionRelief, itemAdvance, itemVariance, inserted.lastInsertRowId);
      inventoryReliefSyp += itemInventoryRelief; varianceSyp += itemVariance;
      if (![inventoryReliefSyp, varianceSyp].every(Number.isSafeInteger)) throw new Error('PURCHASE_RETURN_ACCOUNTING_OVERFLOW');
      await transaction.runAsync(`INSERT INTO inventory_movements(uuid,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,movement_type,quantity_delta,quantity_before,quantity_after,purchase_return_item_id,note,created_at)
        VALUES(?,?,?,?,?,'purchase_return',?,?,?,?,?,?)`, createUuid(), item.product_id, item.product_uuid_snapshot, item.product_name_snapshot, item.barcode_snapshot, -quantity, item.inventory_quantity, after, inserted.lastInsertRowId, reference, now);
    }
    if (receipt.supplier_id) {
      const accountSupplier = supplier ?? await transaction.getFirstAsync<Supplier>('SELECT * FROM suppliers WHERE id=? AND accounting_enabled=1', receipt.supplier_id);
      if (accountSupplier) await postSupplierAccountEntry(transaction, accountSupplier, { type: 'purchase_return', delta: -totalValue, occurredAt: now, note, purchaseReturnId: returnId });
    }
    if (accountingEnabled) {
      await transaction.runAsync(`UPDATE purchase_returns SET accounting_inventory_relief_syp=?,accounting_position_relief_syp=?,accounting_advance_created_syp=?,accounting_variance_syp=? WHERE id=?`,
      inventoryReliefSyp, positionReliefSyp, advanceCreatedSyp, varianceSyp, returnId);
      if (advanceNative > 0) await createSupplierPositionLayer(transaction, { supplierId: supplier!.id, positionType: 'ADVANCE', sourceType: 'supplier_return', sourceId: returnId,
        nativeUsdCents: advanceNative, carryingSyp: advanceCreatedSyp, exchangeRateSypPerUsd: parsedRate as number, occurredAt: now });
      const lines: JournalLineInput[] = [
        { account: 'ACCOUNTS_PAYABLE', debitSyp: payableReliefSyp },
        { account: 'SUPPLIER_ADVANCES', debitSyp: advanceCreatedSyp },
        { account: 'INVENTORY', creditSyp: inventoryReliefSyp },
      ];
      if (varianceSyp > 0) lines.push({ account: 'INVENTORY_VALUATION_VARIANCE', debitSyp: varianceSyp });
      if (varianceSyp < 0) lines.push({ account: 'INVENTORY_VALUATION_VARIANCE', creditSyp: -varianceSyp });
      await postJournalEntry(transaction, { sourceType: 'supplier_return', sourceId: returnId, sourceUuid: returnUuid, reference, occurredAt: now,
        description: `Supplier return — ${receipt.supplier_name_snapshot}`, lines });
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
    where.push(`(s.invoice_number LIKE ? OR COALESCE(s.customer_name_snapshot,'') LIKE ? COLLATE NOCASE OR s.id IN (
      SELECT si.sale_id FROM sale_items si
      WHERE si.product_name LIKE ? COLLATE NOCASE OR si.barcode_snapshot=? OR si.product_id IN (
        SELECT p.id FROM products p WHERE p.barcode=?
      )
    ))`);
    parameters.push(like, like, like, search, search);
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
  accountInput?: SaleAccountInput,
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
  const onAccountSyp = accountInput?.onAccountSyp ?? 0;
  if (!Number.isSafeInteger(onAccountSyp) || onAccountSyp < 0 || onAccountSyp > net || (onAccountSyp > 0 && (!Number.isSafeInteger(accountInput?.customerId) || (accountInput?.customerId ?? 0) <= 0))) throw new Error('INVALID_ON_ACCOUNT_AMOUNT');
  const cashDue = net - onAccountSyp;
  const normalizedPayment: PaymentInput = typeof paymentInput === 'number'
    ? { mode: 'SYP', sypAmount: paymentInput, usdCents: 0 }
    : paymentInput ?? { mode: 'SYP', sypAmount: cashDue, usdCents: 0 };
  const previewSettlement = calculateSettlement(cashDue, exchangeRate, normalizedPayment);
  if (!previewSettlement.valid) throw new Error('INSUFFICIENT_PAYMENT');
  const profit = net - cost;
  const createdAt = new Date().toISOString();
  const invoiceNumber = `INV-${createdAt.replace(/\D/g, '').slice(0, 17)}`;
  let saleId = 0;
  await db.withExclusiveTransactionAsync(async transaction => {
    const activeSession = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM cash_sessions WHERE closed_at IS NULL LIMIT 1');
    if (!activeSession) throw new Error('CASH_SESSION_REQUIRED');
    const settlement = calculateSettlement(cashDue, exchangeRate, normalizedPayment);
    if (!settlement.valid || settlement.totalTenderEquivalentSyp - settlement.changeSyp + onAccountSyp !== net) throw new Error('INVALID_PAYMENT_SETTLEMENT');
    const customer = accountInput?.customerId == null ? null : await transaction.getFirstAsync<Customer>('SELECT * FROM customers WHERE id=? AND is_active=1', accountInput.customerId);
    if (accountInput?.customerId != null && !customer) throw new Error('CUSTOMER_INACTIVE');
    if (onAccountSyp > 0 && !customer?.accounting_enabled) throw new Error('CUSTOMER_ACCOUNT_INACTIVE');
    const accountingEnabled = await accountingIsEnabled(transaction);
    const customerBalanceBefore = accountingEnabled && customer && onAccountSyp > 0
      ? await transaction.getFirstAsync<{ balance_syp: number }>('SELECT balance_syp FROM customer_account_balances WHERE customer_id=?', customer.id)
      : null;
    if (accountingEnabled && customer && onAccountSyp > 0 && !customerBalanceBefore) throw new Error('CUSTOMER_ACCOUNT_BALANCE_MISSING');
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
    const saleUuid = createUuid();
    const result = await transaction.runAsync(
      `INSERT INTO sales
       (uuid,invoice_number,exchange_rate,subtotal_syp,discount_syp,net_total_syp,cost_syp,profit_syp,amount_paid_syp,change_syp,created_at,updated_at,cash_session_id,customer_id,customer_uuid_snapshot,customer_name_snapshot,on_account_syp)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      saleUuid, invoiceNumber, exchangeRate, subtotal, discount, net, cost, profit, settlement.totalTenderEquivalentSyp, settlement.changeSyp, createdAt, createdAt, activeSession.id,
      customer?.id ?? null, customer?.uuid ?? null, customer?.name ?? null, onAccountSyp,
    );
    saleId = result.lastInsertRowId;
    let accountingCogsSyp = 0;
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
          const itemAccountingCogs = accountingEnabled ? await relieveInventoryValue(transaction, {
            sourceType: 'sale', sourceId: saleId, sourceItemId: insertedItem.lastInsertRowId,
            productId: item.productId, quantityOut: item.quantity, occurredAt: createdAt,
          }) : 0;
          if (accountingEnabled) {
            accountingCogsSyp += itemAccountingCogs;
            if (!Number.isSafeInteger(accountingCogsSyp)) throw new Error('ACCOUNTING_COGS_OVERFLOW');
            await transaction.runAsync('UPDATE sale_items SET accounting_cogs_syp=? WHERE id=?', itemAccountingCogs, insertedItem.lastInsertRowId);
          }
          const changed = await transaction.runAsync('UPDATE inventory_balances SET quantity=?,updated_at=? WHERE product_id=? AND quantity=?', after, createdAt, item.productId, before);
          if (changed.changes !== 1) throw new Error('INVENTORY_CONCURRENT_CHANGE');
          await transaction.runAsync(`INSERT INTO inventory_movements(uuid,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,movement_type,quantity_delta,quantity_before,quantity_after,sale_item_id,note,created_at)
            VALUES(?,?,?,?,?,'sale',?,?,?,?,NULL,?)`, createUuid(), item.productId, stock.product_uuid, item.productName, item.barcodeSnapshot, -item.quantity, before, after, insertedItem.lastInsertRowId, createdAt);
          stock.quantity = after;
        }
      }
    }
    for (const payment of settlement.payments) await transaction.runAsync(
      `INSERT INTO sale_payments(uuid,sale_id,currency,amount_minor,syp_equivalent,exchange_rate_syp_per_usd,accounting_cash_carrying_syp,created_at)
       VALUES(?,?,?,?,?,?,?,?)`, createUuid(), saleId, payment.currency, payment.amount_minor, payment.syp_equivalent, payment.exchange_rate_syp_per_usd, accountingEnabled ? payment.syp_equivalent : null, createdAt,
    );
    const customerBalanceAfter = customer && onAccountSyp > 0
      ? await postCustomerAccountEntry(transaction, customer, { type: 'sale', delta: onAccountSyp, occurredAt: createdAt, saleId })
      : null;
    if (accountingEnabled) {
      const lines: JournalLineInput[] = [{ account: 'SALES_REVENUE', creditSyp: net }];
      const sypTender = settlement.payments.find(payment => payment.currency === 'SYP')?.amount_minor ?? 0;
      const sypCashEffect = sypTender - settlement.changeSyp;
      if (sypCashEffect !== 0) lines.push(await changeCashSyp(transaction, sypCashEffect, createdAt));
      const usdTender = settlement.payments.find(payment => payment.currency === 'USD');
      if (usdTender && usdTender.amount_minor > 0) lines.push(await addCashUsd(transaction, usdTender.amount_minor, usdTender.syp_equivalent, exchangeRate, createdAt));
      if (customerBalanceBefore && customerBalanceAfter != null) lines.push(...signedControlTransitionLines(customerBalanceBefore.balance_syp, customerBalanceAfter, 'ACCOUNTS_RECEIVABLE', 'CUSTOMER_CREDITS'));
      if (accountingCogsSyp > 0) lines.push({ account: 'COGS', debitSyp: accountingCogsSyp }, { account: 'INVENTORY', creditSyp: accountingCogsSyp });
      await postJournalEntry(transaction, { sourceType: 'sale', sourceId: saleId, sourceUuid: saleUuid, reference: invoiceNumber, occurredAt: createdAt, description: `Sale ${invoiceNumber}`, lines });
    }
    if (draftId != null) {
      await transaction.runAsync('DELETE FROM sale_draft_items WHERE draft_id=?', draftId);
      await transaction.runAsync('DELETE FROM sale_drafts WHERE id=?', draftId);
    }
  });
  const sale = await getInvoiceDetails(saleId);
  if (!sale) throw new Error('SALE_NOT_FOUND');
  return sale;
}

export async function createSaleReturn(saleId: number, selections: ReturnSelection[], customerAccountCreditSyp = 0): Promise<SaleReturn> {
  if (!Number.isSafeInteger(saleId) || saleId <= 0 || !selections.length) throw new Error('INVALID_RETURN');
  if (!Number.isSafeInteger(customerAccountCreditSyp) || customerAccountCreditSyp < 0) throw new Error('INVALID_RETURN_SETTLEMENT');
  const db = await dbPromise;
  let returnId = 0;
  await db.withExclusiveTransactionAsync(async transaction => {
    const activeSession = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM cash_sessions WHERE closed_at IS NULL LIMIT 1');
    const header = await transaction.getFirstAsync<Omit<Sale, 'items'>>('SELECT * FROM sales WHERE id=?', saleId);
    if (!header) throw new Error('SALE_NOT_FOUND');
    const saleItems = await transaction.getAllAsync<SaleItem & { accounting_cogs_syp: number | null; accounting_restocked_quantity: number; accounting_restored_cogs_syp: number }>('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id', saleId);
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
    if (customerAccountCreditSyp > preview.refundTotalSyp) throw new Error('INVALID_RETURN_SETTLEMENT');
    const customer = header.customer_id == null ? null : await transaction.getFirstAsync<Customer>('SELECT * FROM customers WHERE id=? AND accounting_enabled=1', header.customer_id);
    if (customerAccountCreditSyp > 0 && !customer) throw new Error('CUSTOMER_ACCOUNT_INACTIVE');
    const cashRefundSyp = preview.refundTotalSyp - customerAccountCreditSyp;
    const accountingEnabled = await accountingIsEnabled(transaction);
    const sourceSalePosted = accountingEnabled
      ? Boolean(await transaction.getFirstAsync('SELECT id FROM journal_entries WHERE source_type=\'sale\' AND source_id=?', saleId))
      : false;
    const customerBalanceBefore = accountingEnabled && customer && customerAccountCreditSyp > 0
      ? await transaction.getFirstAsync<{ balance_syp: number }>('SELECT balance_syp FROM customer_account_balances WHERE customer_id=?', customer.id)
      : null;
    if (accountingEnabled && customer && customerAccountCreditSyp > 0 && !customerBalanceBefore) throw new Error('CUSTOMER_ACCOUNT_BALANCE_MISSING');
    if (cashRefundSyp > 0 && !activeSession) throw new Error('CASH_SESSION_REQUIRED');
    const cash = activeSession ? await transaction.getFirstAsync<{ available_syp: number }>(`SELECT cs.opening_cash_syp
      +COALESCE((SELECT SUM(sp.amount_minor) FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE s.cash_session_id=cs.id AND sp.currency='SYP'),0)
      -COALESCE((SELECT SUM(s.change_syp) FROM sales s WHERE s.cash_session_id=cs.id),0)
      +COALESCE((SELECT SUM(t.amount_minor) FROM customer_payments cp JOIN customer_payment_tenders t ON t.customer_payment_id=cp.id WHERE cp.cash_session_id=cs.id AND t.currency='SYP'),0)
      -COALESCE((SELECT SUM(sr.refund_total_syp-sr.customer_account_credit_syp) FROM sale_returns sr WHERE sr.cash_session_id=cs.id),0)
      -COALESCE((SELECT SUM(e.amount_syp) FROM expenses e WHERE e.cash_session_id=cs.id),0)
      -COALESCE((SELECT SUM(t.amount_minor) FROM supplier_payments p JOIN supplier_payment_tenders t ON t.supplier_payment_id=p.id WHERE p.cash_session_id=cs.id AND t.currency='SYP'),0) available_syp
      FROM cash_sessions cs WHERE cs.id=?`, activeSession.id) : null;
    if (cashRefundSyp > 0 && (!cash || !Number.isSafeInteger(cash.available_syp) || cashRefundSyp > cash.available_syp)) throw new Error('INSUFFICIENT_CASH_SESSION_FUNDS');
    const now = new Date().toISOString();
    const returnUuid = createUuid();
    const inserted = await transaction.runAsync(
      'INSERT INTO sale_returns(uuid,sale_id,refund_total_syp,returned_cost_syp,created_at,updated_at,cash_session_id,customer_account_credit_syp) VALUES(?,?,?,?,?,?,?,?)',
      returnUuid, saleId, preview.refundTotalSyp, preview.returnedCostSyp, now, now, activeSession?.id ?? null, customerAccountCreditSyp,
    );
    returnId = inserted.lastInsertRowId;
    const selectionByItem = new Map(selections.map(selection => [selection.saleItemId, selection]));
    let restoredAccountingCogsSyp = 0;
    for (const item of preview.items) {
      const selectedRestock = selectionByItem.get(item.saleItemId)?.restockQuantity ?? item.quantity;
      if (!Number.isSafeInteger(selectedRestock) || selectedRestock < 0 || selectedRestock > item.quantity) throw new Error('INVALID_RESTOCK_QUANTITY');
      const sold = saleItems.find(saleItem => saleItem.id === item.saleItemId);
      if (!sold) throw new Error('RETURN_ITEM_NOT_FOUND');
      const eligible = selectedRestock > 0 && sold.product_id
        ? await transaction.getFirstAsync<{ product_id: number }>("SELECT product_id FROM inventory_movements WHERE sale_item_id=? AND movement_type='sale' LIMIT 1", sold.id)
        : null;
      const balance = eligible && sold.product_id
        ? await transaction.getFirstAsync<{ quantity: number; product_uuid: string; product_name: string; barcode: string | null }>(`SELECT b.quantity,p.uuid AS product_uuid,p.name AS product_name,p.barcode FROM inventory_balances b JOIN products p ON p.id=b.product_id WHERE b.product_id=? AND b.tracking_enabled=1`, sold.product_id)
        : null;
      const actualRestock = balance ? selectedRestock : 0;
      let restoredForItem = 0;
      if (accountingEnabled && actualRestock > 0) {
        const totalCogs = sourceSalePosted ? sold.accounting_cogs_syp : sold.line_cost_syp;
        if (!Number.isSafeInteger(totalCogs) || (totalCogs ?? 0) < 0) throw new Error('INVALID_HISTORICAL_COGS');
        const beforeRestock = sold.accounting_restocked_quantity ?? 0; const afterRestock = beforeRestock + actualRestock;
        if (!Number.isSafeInteger(afterRestock) || afterRestock > sold.quantity) throw new Error('RETURN_RESTOCK_OVER_SOLD');
        restoredForItem = incrementalHalfUpAllocation(totalCogs ?? 0, beforeRestock, afterRestock, sold.quantity);
      }
      const insertedItem = await transaction.runAsync(
        `INSERT INTO sale_return_items(uuid,return_id,sale_item_id,quantity,refund_amount_syp,cost_reversal_syp,restock_quantity,accounting_restored_cogs_syp,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`, createUuid(), returnId, item.saleItemId, item.quantity, item.refundAmountSyp, item.costReversalSyp, actualRestock,
        accountingEnabled ? restoredForItem : null, now, now,
      );
      if (actualRestock === 0 || !sold.product_id || !balance) continue;
      const after = balance.quantity + actualRestock;
      if (!Number.isSafeInteger(after)) throw new Error('INVALID_RESTOCK_QUANTITY');
      const changed = await transaction.runAsync('UPDATE inventory_balances SET quantity=?,updated_at=? WHERE product_id=? AND quantity=?', after, now, sold.product_id, balance.quantity);
      if (changed.changes !== 1) throw new Error('INVENTORY_CONCURRENT_CHANGE');
      if (accountingEnabled) {
        await recordInventoryValueChange(transaction, { sourceType: 'sale_return', sourceId: returnId, sourceItemId: insertedItem.lastInsertRowId,
          productId: sold.product_id, quantityDelta: actualRestock, valueDeltaSyp: restoredForItem, occurredAt: now });
        const updated = await transaction.runAsync(`UPDATE sale_items SET accounting_restocked_quantity=accounting_restocked_quantity+?,accounting_restored_cogs_syp=accounting_restored_cogs_syp+?
          WHERE id=? AND accounting_restocked_quantity=?`, actualRestock, restoredForItem, sold.id, sold.accounting_restocked_quantity ?? 0);
        if (updated.changes !== 1) throw new Error('RETURN_RESTOCK_CONCURRENT_UPDATE');
        sold.accounting_restocked_quantity = (sold.accounting_restocked_quantity ?? 0) + actualRestock;
        sold.accounting_restored_cogs_syp = (sold.accounting_restored_cogs_syp ?? 0) + restoredForItem;
        restoredAccountingCogsSyp += restoredForItem;
        if (!Number.isSafeInteger(restoredAccountingCogsSyp)) throw new Error('ACCOUNTING_COGS_OVERFLOW');
      }
      await transaction.runAsync(`INSERT INTO inventory_movements(uuid,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,movement_type,quantity_delta,quantity_before,quantity_after,return_item_id,note,created_at)
        VALUES(?,?,?,?,?,'return',?,?,?,?,NULL,?)`, createUuid(), sold.product_id, balance.product_uuid, sold.product_name, sold.barcode_snapshot, actualRestock, balance.quantity, after, insertedItem.lastInsertRowId, now);
    }
    const customerBalanceAfter = customer && customerAccountCreditSyp > 0
      ? await postCustomerAccountEntry(transaction, customer, { type: 'sale_return', delta: -customerAccountCreditSyp, occurredAt: now, saleReturnId: returnId })
      : null;
    if (accountingEnabled) {
      const financialAccount = sourceSalePosted ? 'SALES_RETURNS' as const : 'PRIOR_PERIOD_ADJUSTMENT' as const;
      const lines: JournalLineInput[] = [{ account: financialAccount, debitSyp: preview.refundTotalSyp }];
      if (cashRefundSyp > 0) lines.push(await changeCashSyp(transaction, -cashRefundSyp, now));
      if (customerBalanceBefore && customerBalanceAfter != null) lines.push(...signedControlTransitionLines(customerBalanceBefore.balance_syp, customerBalanceAfter, 'ACCOUNTS_RECEIVABLE', 'CUSTOMER_CREDITS'));
      if (restoredAccountingCogsSyp > 0) lines.push(
        { account: 'INVENTORY', debitSyp: restoredAccountingCogsSyp },
        { account: sourceSalePosted ? 'COGS' : 'PRIOR_PERIOD_ADJUSTMENT', creditSyp: restoredAccountingCogsSyp },
      );
      await postJournalEntry(transaction, { sourceType: 'sale_return', sourceId: returnId, sourceUuid: returnUuid, occurredAt: now, description: `Customer return — ${header.invoice_number}`, lines });
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
    const expenseUuid = createUuid();
    const result = await transaction.runAsync(
      'INSERT INTO expenses (uuid,description,amount_syp,category_id,note,created_at,updated_at,cash_session_id) VALUES (?,?,?,?,?,?,?,?)',
      expenseUuid, normalizedNote ?? '', amountSyp, categoryId, normalizedNote, now, now, activeSession.id,
    );
    if (await accountingIsEnabled(transaction)) {
      const cashLine = await changeCashSyp(transaction, -amountSyp, now);
      await postJournalEntry(transaction, {
        sourceType: 'expense', sourceId: result.lastInsertRowId, sourceUuid: expenseUuid, occurredAt: now,
        description: normalizedNote ?? 'Operating expense',
        lines: [{ account: 'OPERATING_EXPENSE', debitSyp: amountSyp }, cashLine],
      });
    }
  });
}

const cashSessionSummarySelect = `SELECT cs.*,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(s.sales_total_syp,0) ELSE cs.closing_sales_total_syp END AS sales_total_syp,COALESCE(s.invoice_count,0) AS invoice_count,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(r.refunds_total_syp,0) ELSE cs.closing_refunds_total_syp END AS refunds_total_syp,COALESCE(r.return_count,0) AS return_count,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(e.expenses_total_syp,0) ELSE cs.closing_expenses_total_syp END AS expenses_total_syp,COALESCE(e.expense_count,0) AS expense_count,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(p.cash_received_syp,0) ELSE COALESCE(cs.closing_cash_received_syp,cs.closing_sales_total_syp,0) END AS cash_received_syp,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(p.cash_received_usd_cents,0) ELSE COALESCE(cs.closing_cash_received_usd_cents,0) END AS cash_received_usd_cents,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(s.change_given_syp,0) ELSE COALESCE(cs.closing_change_given_syp,0) END AS change_given_syp,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(spay.supplier_payments_syp,0) ELSE COALESCE(cs.closing_supplier_payments_syp,0) END AS supplier_payments_syp,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(spay.supplier_payments_usd_cents,0) ELSE COALESCE(cs.closing_supplier_payments_usd_cents,0) END AS supplier_payments_usd_cents,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(cpay.customer_payments_syp,0) ELSE COALESCE(cs.closing_customer_payments_syp,0) END AS customer_payments_syp,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(cpay.customer_payments_usd_cents,0) ELSE COALESCE(cs.closing_customer_payments_usd_cents,0) END AS customer_payments_usd_cents,
  CASE WHEN cs.closed_at IS NULL THEN cs.opening_cash_syp+COALESCE(p.cash_received_syp,0)-COALESCE(s.change_given_syp,0)+COALESCE(cpay.customer_payments_syp,0)-COALESCE(r.cash_refunds_syp,0)-COALESCE(e.expenses_total_syp,0)-COALESCE(spay.supplier_payments_syp,0) ELSE cs.closing_expected_cash_syp END AS expected_cash_syp,
  CASE WHEN cs.closed_at IS NULL THEN cs.opening_cash_usd_cents+COALESCE(p.cash_received_usd_cents,0)+COALESCE(cpay.customer_payments_usd_cents,0)-COALESCE(spay.supplier_payments_usd_cents,0) ELSE COALESCE(cs.closing_expected_cash_usd_cents,0) END AS expected_cash_usd_cents
  FROM cash_sessions cs
  LEFT JOIN (SELECT cash_session_id,SUM(net_total_syp) AS sales_total_syp,SUM(COALESCE(change_syp,0)) AS change_given_syp,COUNT(*) AS invoice_count FROM sales WHERE cash_session_id IS NOT NULL GROUP BY cash_session_id) s ON s.cash_session_id=cs.id
  LEFT JOIN (SELECT s.cash_session_id,SUM(CASE WHEN sp.currency='SYP' THEN sp.amount_minor ELSE 0 END) AS cash_received_syp,SUM(CASE WHEN sp.currency='USD' THEN sp.amount_minor ELSE 0 END) AS cash_received_usd_cents FROM sales s JOIN sale_payments sp ON sp.sale_id=s.id WHERE s.cash_session_id IS NOT NULL GROUP BY s.cash_session_id) p ON p.cash_session_id=cs.id
  LEFT JOIN (SELECT cash_session_id,SUM(refund_total_syp) AS refunds_total_syp,SUM(refund_total_syp-customer_account_credit_syp) AS cash_refunds_syp,COUNT(*) AS return_count FROM sale_returns WHERE cash_session_id IS NOT NULL GROUP BY cash_session_id) r ON r.cash_session_id=cs.id
  LEFT JOIN (SELECT cash_session_id,SUM(amount_syp) AS expenses_total_syp,COUNT(*) AS expense_count FROM expenses WHERE cash_session_id IS NOT NULL GROUP BY cash_session_id) e ON e.cash_session_id=cs.id
  LEFT JOIN (SELECT sp.cash_session_id,SUM(CASE WHEN t.currency='SYP' THEN t.amount_minor ELSE 0 END) AS supplier_payments_syp,SUM(CASE WHEN t.currency='USD' THEN t.amount_minor ELSE 0 END) AS supplier_payments_usd_cents FROM supplier_payments sp JOIN supplier_payment_tenders t ON t.supplier_payment_id=sp.id GROUP BY sp.cash_session_id) spay ON spay.cash_session_id=cs.id
  LEFT JOIN (SELECT cp.cash_session_id,SUM(CASE WHEN t.currency='SYP' THEN t.amount_minor ELSE 0 END) AS customer_payments_syp,SUM(CASE WHEN t.currency='USD' THEN t.amount_minor ELSE 0 END) AS customer_payments_usd_cents FROM customer_payments cp JOIN customer_payment_tenders t ON t.customer_payment_id=cp.id GROUP BY cp.cash_session_id) cpay ON cpay.cash_session_id=cs.id`;

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
  CASE WHEN cs.closed_at IS NULL THEN COALESCE((SELECT SUM(t.amount_minor) FROM supplier_payments sp JOIN supplier_payment_tenders t ON t.supplier_payment_id=sp.id WHERE sp.cash_session_id=cs.id AND t.currency='SYP'),0) ELSE COALESCE(cs.closing_supplier_payments_syp,0) END AS supplier_payments_syp,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE((SELECT SUM(t.amount_minor) FROM supplier_payments sp JOIN supplier_payment_tenders t ON t.supplier_payment_id=sp.id WHERE sp.cash_session_id=cs.id AND t.currency='USD'),0) ELSE COALESCE(cs.closing_supplier_payments_usd_cents,0) END AS supplier_payments_usd_cents,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE((SELECT SUM(t.amount_minor) FROM customer_payments cp JOIN customer_payment_tenders t ON t.customer_payment_id=cp.id WHERE cp.cash_session_id=cs.id AND t.currency='SYP'),0) ELSE COALESCE(cs.closing_customer_payments_syp,0) END AS customer_payments_syp,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE((SELECT SUM(t.amount_minor) FROM customer_payments cp JOIN customer_payment_tenders t ON t.customer_payment_id=cp.id WHERE cp.cash_session_id=cs.id AND t.currency='USD'),0) ELSE COALESCE(cs.closing_customer_payments_usd_cents,0) END AS customer_payments_usd_cents,
  CASE WHEN cs.closed_at IS NULL THEN cs.opening_cash_syp+COALESCE((SELECT SUM(sp.amount_minor) FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE s.cash_session_id=cs.id AND sp.currency='SYP'),0)-COALESCE((SELECT SUM(change_syp) FROM sales WHERE cash_session_id=cs.id),0)+COALESCE((SELECT SUM(t.amount_minor) FROM customer_payments cp JOIN customer_payment_tenders t ON t.customer_payment_id=cp.id WHERE cp.cash_session_id=cs.id AND t.currency='SYP'),0)-COALESCE((SELECT SUM(refund_total_syp-customer_account_credit_syp) FROM sale_returns WHERE cash_session_id=cs.id),0)-COALESCE((SELECT SUM(amount_syp) FROM expenses WHERE cash_session_id=cs.id),0)-COALESCE((SELECT SUM(t.amount_minor) FROM supplier_payments sp JOIN supplier_payment_tenders t ON t.supplier_payment_id=sp.id WHERE sp.cash_session_id=cs.id AND t.currency='SYP'),0) ELSE cs.closing_expected_cash_syp END AS expected_cash_syp,
  CASE WHEN cs.closed_at IS NULL THEN cs.opening_cash_usd_cents+COALESCE((SELECT SUM(sp.amount_minor) FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE s.cash_session_id=cs.id AND sp.currency='USD'),0)+COALESCE((SELECT SUM(t.amount_minor) FROM customer_payments cp JOIN customer_payment_tenders t ON t.customer_payment_id=cp.id WHERE cp.cash_session_id=cs.id AND t.currency='USD'),0)-COALESCE((SELECT SUM(t.amount_minor) FROM supplier_payments sp JOIN supplier_payment_tenders t ON t.supplier_payment_id=sp.id WHERE sp.cash_session_id=cs.id AND t.currency='USD'),0) ELSE COALESCE(cs.closing_expected_cash_usd_cents,0) END AS expected_cash_usd_cents
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
    if (await accountingIsEnabled(transaction)) {
      const control = await transaction.getFirstAsync<{ cash_syp: number; cash_usd_cents: number }>('SELECT cash_syp,cash_usd_cents FROM cash_control WHERE id=1');
      if (!control || control.cash_syp !== openingCashSyp || control.cash_usd_cents !== openingCashUsdCents) throw new Error('CASH_SESSION_OPENING_MUST_MATCH_BOOK');
    }
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
    const totals = await transaction.getFirstAsync<{ sales: number; refunds: number; cash_refunds: number; expenses: number; cash_syp: number; cash_usd: number; change_syp: number; supplier_syp: number; supplier_usd: number; customer_syp: number; customer_usd: number }>(`SELECT
      COALESCE((SELECT SUM(net_total_syp) FROM sales WHERE cash_session_id=?),0) AS sales,
      COALESCE((SELECT SUM(refund_total_syp) FROM sale_returns WHERE cash_session_id=?),0) AS refunds,
      COALESCE((SELECT SUM(refund_total_syp-customer_account_credit_syp) FROM sale_returns WHERE cash_session_id=?),0) AS cash_refunds,
      COALESCE((SELECT SUM(amount_syp) FROM expenses WHERE cash_session_id=?),0) AS expenses,
      COALESCE((SELECT SUM(sp.amount_minor) FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE s.cash_session_id=? AND sp.currency='SYP'),0) AS cash_syp,
      COALESCE((SELECT SUM(sp.amount_minor) FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE s.cash_session_id=? AND sp.currency='USD'),0) AS cash_usd,
      COALESCE((SELECT SUM(change_syp) FROM sales WHERE cash_session_id=?),0) AS change_syp,
      COALESCE((SELECT SUM(t.amount_minor) FROM supplier_payments sp JOIN supplier_payment_tenders t ON t.supplier_payment_id=sp.id WHERE sp.cash_session_id=? AND t.currency='SYP'),0) AS supplier_syp,
      COALESCE((SELECT SUM(t.amount_minor) FROM supplier_payments sp JOIN supplier_payment_tenders t ON t.supplier_payment_id=sp.id WHERE sp.cash_session_id=? AND t.currency='USD'),0) AS supplier_usd,
      COALESCE((SELECT SUM(t.amount_minor) FROM customer_payments cp JOIN customer_payment_tenders t ON t.customer_payment_id=cp.id WHERE cp.cash_session_id=? AND t.currency='SYP'),0) AS customer_syp,
      COALESCE((SELECT SUM(t.amount_minor) FROM customer_payments cp JOIN customer_payment_tenders t ON t.customer_payment_id=cp.id WHERE cp.cash_session_id=? AND t.currency='USD'),0) AS customer_usd`, active.id, active.id, active.id, active.id, active.id, active.id, active.id, active.id, active.id, active.id, active.id);
    const sales = totals?.sales ?? 0; const refunds = totals?.refunds ?? 0; const expenses = totals?.expenses ?? 0;
    const cashSyp = totals?.cash_syp ?? 0; const cashUsd = totals?.cash_usd ?? 0; const changeSyp = totals?.change_syp ?? 0;
    const supplierSyp = totals?.supplier_syp ?? 0; const supplierUsd = totals?.supplier_usd ?? 0;
    const customerSyp = totals?.customer_syp ?? 0; const customerUsd = totals?.customer_usd ?? 0; const cashRefunds = totals?.cash_refunds ?? 0;
    const expected = active.opening_cash_syp + cashSyp - changeSyp + customerSyp - cashRefunds - expenses - supplierSyp;
    const expectedUsd = active.opening_cash_usd_cents + cashUsd + customerUsd - supplierUsd;
    const difference = actualCashSyp - expected;
    const differenceUsd = actualCashUsdCents - expectedUsd;
    if (![sales, refunds, cashRefunds, expenses, cashSyp, cashUsd, changeSyp, supplierSyp, supplierUsd, customerSyp, customerUsd, expected, expectedUsd, difference, differenceUsd].every(Number.isSafeInteger) || expected < 0 || expectedUsd < 0) throw new Error('INVALID_CASH_TOTAL');
    const now = new Date().toISOString();
    const accountingEnabled = await accountingIsEnabled(transaction);
    const book = accountingEnabled ? await transaction.getFirstAsync<{ cash_syp: number; cash_usd_cents: number; cash_usd_carrying_syp: number }>('SELECT cash_syp,cash_usd_cents,cash_usd_carrying_syp FROM cash_control WHERE id=1') : null;
    if (accountingEnabled && !book) throw new Error('CASH_CONTROL_MISSING');
    const result = await transaction.runAsync(`UPDATE cash_sessions SET closed_at=?,closing_actual_cash_syp=?,
      closing_sales_total_syp=?,closing_refunds_total_syp=?,closing_expenses_total_syp=?,
      closing_expected_cash_syp=?,closing_difference_syp=?,closing_actual_cash_usd_cents=?,closing_expected_cash_usd_cents=?,
      closing_difference_usd_cents=?,closing_cash_received_syp=?,closing_cash_received_usd_cents=?,closing_change_given_syp=?,closing_supplier_payments_syp=?,closing_supplier_payments_usd_cents=?,closing_customer_payments_syp=?,closing_customer_payments_usd_cents=?,closing_book_cash_syp=?,closing_book_cash_usd_cents=?,closing_book_cash_usd_carrying_syp=?,closing_note=?,updated_at=?
      WHERE id=? AND closed_at IS NULL`, now, actualCashSyp, sales, refunds, expenses, expected, difference, actualCashUsdCents, expectedUsd,
    differenceUsd, cashSyp, cashUsd, changeSyp, supplierSyp, supplierUsd, customerSyp, customerUsd,
    book?.cash_syp ?? null, book?.cash_usd_cents ?? null, book?.cash_usd_carrying_syp ?? null, note, now, active.id);
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
    if (await accountingIsEnabled(transaction)) throw new Error('POST_CUTOVER_SOURCE_IMMUTABLE');
    const expense = await transaction.getFirstAsync<{ session_closed_at: string | null }>(`SELECT cs.closed_at AS session_closed_at FROM expenses e LEFT JOIN cash_sessions cs ON cs.id=e.cash_session_id WHERE e.id=?`, id);
    if (!expense) throw new Error('EXPENSE_NOT_FOUND');
    if (expense.session_closed_at) throw new Error('CLOSED_SESSION_EXPENSE_IMMUTABLE');
    await transaction.runAsync('DELETE FROM expenses WHERE id=?', id);
  });
}
