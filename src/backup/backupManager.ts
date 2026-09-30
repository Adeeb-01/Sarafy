import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { getDatabase } from '@/database/database';
import { CashSession, Customer, CustomerAccountEntry, CustomerPayment, CustomerPaymentTender, ExchangeRateHistoryEntry, Expense, ExpenseCategory, InventoryBalance, InventoryMovement, Product, PurchaseReceipt, PurchaseReceiptItem, PurchaseReturn, PurchaseReturnItem, Sale, SaleItem, SalePayment, SaleReturn, SaleReturnItem, Settings, Supplier, SupplierAccountBalance, SupplierAccountEntry, SupplierPayment, SupplierPaymentTender, SuspendedSale, SuspendedSaleItem } from '@/types';
import { ImportPayload, PortableAccountingState, PortableCategory } from '@/import/importTypes';
import { createDeterministicUuid, isUuid } from '@/utils/uuid';
import { readSarafyArchive, writeSarafyArchive } from './backupArchive';
import { assertReadableNonEmptyFile, ensureBackupDirectory, getBackupDirectory } from './backupStorage';
import { isStoredProductImagePath } from '@/media/productImageStorage';

const BACKUP_VERSION = 8;
const SCHEMA_VERSION = 19;
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
  counts: { products: number; categories: number; sales: number; saleItems: number; salePayments?: number; expenses: number; images: number; drafts?: number; draftItems?: number; returns?: number; returnItems?: number; expenseCategories?: number; exchangeRateHistory?: number; cashSessions?: number; inventoryBalances?: number; inventoryMovements?: number; suppliers?: number; purchaseReceipts?: number; purchaseReceiptItems?: number; purchaseReturns?: number; purchaseReturnItems?: number; supplierAccountBalances?: number; supplierAccountEntries?: number; supplierPayments?: number; supplierPaymentTenders?: number; customers?: number; customerAccountBalances?: number; customerAccountEntries?: number; customerPayments?: number; customerPaymentTenders?: number; journalEntries?: number; journalLines?: number };
}

export interface SarafyBackup {
  manifest: BackupManifest;
  data: ImportPayload;
  archiveUri?: string;
}

export async function collectPortableData(): Promise<ImportPayload> {
  const db = await getDatabase();
  const [products, categories, settingsRows, salesRows, saleItems, salePayments, expenses, draftRows, draftItems, returnRows, returnItems, expenseCategories, exchangeRateHistory, cashSessions, inventoryBalances, inventoryMovements, suppliers, purchaseReceipts, purchaseReceiptItems, purchaseReturns, purchaseReturnItems, supplierAccountBalances, supplierAccountEntries, supplierPayments, supplierPaymentTenders, customers, customerAccountBalances, customerAccountEntries, customerPayments, customerPaymentTenders] = await Promise.all([
    db.getAllAsync<Product>('SELECT * FROM products ORDER BY id'),
    db.getAllAsync<PortableCategory>('SELECT id,uuid,name,created_at,updated_at FROM categories ORDER BY id'),
    db.getAllAsync<{ key: string; value: string }>('SELECT key,value FROM settings'),
    db.getAllAsync<Omit<Sale, 'items'>>('SELECT * FROM sales ORDER BY id'),
    db.getAllAsync<SaleItem>('SELECT * FROM sale_items ORDER BY id'),
    db.getAllAsync<SalePayment>('SELECT * FROM sale_payments ORDER BY id'),
    db.getAllAsync<Expense>('SELECT e.*,c.uuid AS category_uuid FROM expenses e JOIN expense_categories c ON c.id=e.category_id ORDER BY e.id'),
    db.getAllAsync<Omit<SuspendedSale, 'items'>>('SELECT * FROM sale_drafts ORDER BY id'),
    db.getAllAsync<SuspendedSaleItem>('SELECT * FROM sale_draft_items ORDER BY id'),
    db.getAllAsync<Omit<SaleReturn, 'items'>>('SELECT * FROM sale_returns ORDER BY id'),
    db.getAllAsync<SaleReturnItem>('SELECT ri.*,si.product_name,si.barcode_snapshot FROM sale_return_items ri JOIN sale_items si ON si.id=ri.sale_item_id ORDER BY ri.id'),
    db.getAllAsync<ExpenseCategory>('SELECT * FROM expense_categories ORDER BY id'),
    db.getAllAsync<ExchangeRateHistoryEntry>('SELECT * FROM exchange_rate_history ORDER BY id'),
    db.getAllAsync<CashSession>('SELECT * FROM cash_sessions ORDER BY id'),
    db.getAllAsync<InventoryBalance>('SELECT * FROM inventory_balances WHERE tracking_enabled=1 ORDER BY id'),
    db.getAllAsync<InventoryMovement>('SELECT * FROM inventory_movements ORDER BY id'),
    db.getAllAsync<Supplier>('SELECT * FROM suppliers ORDER BY id'),
    db.getAllAsync<PurchaseReceipt>('SELECT pr.*,0 AS item_count,0 AS total_quantity,0 AS total_cost_usd_cents FROM purchase_receipts pr ORDER BY id'),
    db.getAllAsync<PurchaseReceiptItem>('SELECT * FROM purchase_receipt_items ORDER BY id'),
    db.getAllAsync<PurchaseReturn>('SELECT * FROM purchase_returns ORDER BY id'),
    db.getAllAsync<PurchaseReturnItem>('SELECT * FROM purchase_return_items ORDER BY id'),
    db.getAllAsync<SupplierAccountBalance>('SELECT * FROM supplier_account_balances ORDER BY supplier_id'),
    db.getAllAsync<SupplierAccountEntry>('SELECT * FROM supplier_account_entries ORDER BY id'),
    db.getAllAsync<SupplierPayment>('SELECT * FROM supplier_payments ORDER BY id'),
    db.getAllAsync<SupplierPaymentTender>('SELECT * FROM supplier_payment_tenders ORDER BY id'),
    db.getAllAsync<Customer>('SELECT * FROM customers ORDER BY id'),
    db.getAllAsync<{ customer_id: number; balance_syp: number; updated_at: string }>('SELECT * FROM customer_account_balances ORDER BY customer_id'),
    db.getAllAsync<CustomerAccountEntry>('SELECT * FROM customer_account_entries ORDER BY id'),
    db.getAllAsync<CustomerPayment>('SELECT * FROM customer_payments ORDER BY id'),
    db.getAllAsync<CustomerPaymentTender>('SELECT * FROM customer_payment_tenders ORDER BY id'),
  ]);
  const [accountingSettings, cutoverPositions, accounts, journalEntries, journalLines, accountBalances, inventoryValueBalances, inventoryValueMovements, cashControl, supplierPositionLayers, supplierAllocations, cashAdjustments] = await Promise.all([
    db.getFirstAsync<{ accounting_enabled: number; accounting_started_at: string | null; functional_currency: 'SYP'; cutover_exchange_rate_syp_per_usd: number | null; opening_journal_entry_id: number | null; created_at: string; updated_at: string }>('SELECT * FROM accounting_settings WHERE id=1'),
    db.getAllAsync<{ uuid: string; position_type: string; entity_type: string; entity_id: number; native_amount_minor: number; carrying_value_syp: number; created_at: string }>('SELECT * FROM accounting_cutover_positions ORDER BY id'),
    db.getAllAsync<{ id: number; uuid: string; code: string; system_key: string; name_ar: string; name_en: string; account_type: string; normal_side: string; is_system: number; active: number; created_at: string; updated_at: string }>('SELECT * FROM gl_accounts ORDER BY id'),
    db.getAllAsync<{ id: number; uuid: string; source_type: string; source_id: number | null; source_uuid: string | null; reference: string | null; occurred_at: string; created_at: string; description_snapshot: string; reversal_of_entry_id: number | null }>('SELECT * FROM journal_entries ORDER BY id'),
    db.getAllAsync<{ uuid: string; journal_entry_id: number; account_id: number; debit_syp: number; credit_syp: number; source_currency: 'SYP' | 'USD' | null; source_amount_minor: number | null; exchange_rate_syp_per_usd: number | null; memo: string | null; created_at: string }>('SELECT * FROM journal_lines ORDER BY id'),
    db.getAllAsync<{ account_id: number; debit_total_syp: number; credit_total_syp: number; net_balance_syp: number; updated_at: string }>('SELECT * FROM gl_account_balances ORDER BY account_id'),
    db.getAllAsync<{ product_id: number; quantity_snapshot: number; carrying_value_syp: number; updated_at: string }>('SELECT * FROM inventory_value_balances ORDER BY product_id'),
    db.getAllAsync<{ uuid: string; product_id: number; source_type: string; source_id: number | null; source_item_id: number | null; quantity_delta: number; quantity_before: number; quantity_after: number; value_delta_syp: number; value_before_syp: number; value_after_syp: number; created_at: string }>('SELECT * FROM inventory_value_movements ORDER BY id'),
    db.getFirstAsync<{ cash_syp: number; cash_usd_cents: number; cash_usd_carrying_syp: number; updated_at: string }>('SELECT cash_syp,cash_usd_cents,cash_usd_carrying_syp,updated_at FROM cash_control WHERE id=1'),
    db.getAllAsync<{ id: number; uuid: string; supplier_id: number; position_type: 'PAYABLE' | 'ADVANCE'; source_type: string; source_id: number | null; original_usd_cents: number; remaining_usd_cents: number; original_carrying_syp: number; remaining_carrying_syp: number; exchange_rate_syp_per_usd: number | null; created_at: string; updated_at: string }>('SELECT * FROM supplier_foreign_position_layers ORDER BY id'),
    db.getAllAsync<{ uuid: string; layer_id: number; source_type: string; source_id: number; native_usd_cents: number; carrying_value_syp: number; created_at: string }>('SELECT * FROM supplier_foreign_allocations ORDER BY id'),
    db.getAllAsync<{ id: number; uuid: string; currency: 'SYP' | 'USD'; amount_minor: number; carrying_value_syp: number; exchange_rate_syp_per_usd: number | null; reason: string; note: string | null; occurred_at: string; created_at: string }>('SELECT * FROM cash_adjustments ORDER BY id'),
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
  const sessionUuidById = new Map(cashSessions.map(session => [session.id, session.uuid]));
  const saleItemUuidById = new Map(saleItems.map(item => [item.id, item.uuid]));
  const returnItemUuidById = new Map(returnItems.map(item => [item.id, item.uuid]));
  const purchaseItemUuidById = new Map(purchaseReceiptItems.map(item => [item.id, item.uuid]));
  const purchaseReturnItemUuidById = new Map(purchaseReturnItems.map(item => [item.id, item.uuid]));
  const purchaseReceiptUuidById = new Map(purchaseReceipts.map(item => [item.id, item.uuid]));
  const productUuidById = new Map(products.map(product => [product.id, product.uuid]));
  const supplierUuidById = new Map(suppliers.map(supplier => [supplier.id, supplier.uuid]));
  const purchaseReturnUuidById = new Map(purchaseReturns.map(item => [item.id, item.uuid]));
  const supplierPaymentUuidById = new Map(supplierPayments.map(item => [item.id, item.uuid]));
  const customerPaymentUuidById = new Map(customerPayments.map(item => [item.id, item.uuid]));
  const expenseUuidById = new Map(expenses.map(item => [item.id, item.uuid]));
  const inventoryMovementUuidById = new Map(inventoryMovements.map(item => [item.id, item.uuid]));
  const cashAdjustmentUuidById = new Map(cashAdjustments.map(item => [item.id, item.uuid]));
  const accountUuidById = new Map(accounts.map(item => [item.id, item.uuid]));
  const journalUuidById = new Map(journalEntries.map(item => [item.id, item.uuid]));
  const supplierLayerUuidById = new Map(supplierPositionLayers.map(item => [item.id, item.uuid]));
  const sourceUuid = (type: string, id: number | null) => {
    if (id == null) return null;
    if (type === 'sale') return saleUuidById.get(id) ?? null;
    if (type === 'sale_return') return saleReturnUuidById.get(id) ?? null;
    if (type === 'expense') return expenseUuidById.get(id) ?? null;
    if (type === 'purchase') return purchaseReceiptUuidById.get(id) ?? null;
    if (type === 'supplier_return') return purchaseReturnUuidById.get(id) ?? null;
    if (type === 'supplier_payment') return supplierPaymentUuidById.get(id) ?? null;
    if (type === 'customer_payment') return customerPaymentUuidById.get(id) ?? null;
    if (type === 'inventory_adjustment') return inventoryMovementUuidById.get(id) ?? null;
    if (type === 'cash_adjustment') return cashAdjustmentUuidById.get(id) ?? null;
    return null;
  };
  const inventoryValueSourceUuid = (type: string, id: number | null) => {
    if (type === 'sale') return id == null ? null : saleUuidById.get(id) ?? null;
    if (type === 'sale_return') return id == null ? null : saleReturnUuidById.get(id) ?? null;
    if (type === 'purchase') return id == null ? null : purchaseReceiptUuidById.get(id) ?? null;
    if (type === 'supplier_return') return id == null ? null : purchaseReturnUuidById.get(id) ?? null;
    return id == null ? null : inventoryMovementUuidById.get(id) ?? null;
  };
  const inventoryValueSourceItemUuid = (type: string, id: number | null) => {
    if (id == null) return null;
    if (type === 'sale') return saleItemUuidById.get(id) ?? null;
    if (type === 'sale_return') return returnItemUuidById.get(id) ?? null;
    if (type === 'purchase') return purchaseItemUuidById.get(id) ?? null;
    if (type === 'supplier_return') return purchaseReturnItemUuidById.get(id) ?? null;
    return inventoryMovementUuidById.get(id) ?? null;
  };
  const supplierSourceUuid = (type: string, id: number | null) => {
    if (id == null) return null;
    if (type === 'purchase') return purchaseReceiptUuidById.get(id) ?? null;
    if (type === 'supplier_return') return purchaseReturnUuidById.get(id) ?? null;
    if (type === 'supplier_payment') return supplierPaymentUuidById.get(id) ?? null;
    return null;
  };
  const paymentTendersByPayment = new Map<number, SupplierPaymentTender[]>();
  for (const tender of supplierPaymentTenders) paymentTendersByPayment.set(tender.supplier_payment_id, [...(paymentTendersByPayment.get(tender.supplier_payment_id) ?? []), tender]);
  const customerUuidById = new Map(customers.map(customer => [customer.id, customer.uuid]));
  const customerTendersByPayment = new Map<number, CustomerPaymentTender[]>();
  for (const tender of customerPaymentTenders) customerTendersByPayment.set(tender.customer_payment_id, [...(customerTendersByPayment.get(tender.customer_payment_id) ?? []), tender]);
  const saleReturnUuidById = new Map(returnRows.map(record => [record.id, record.uuid]));
  const purchaseItemsByReceipt = new Map<number, PurchaseReceiptItem[]>();
  for (const item of purchaseReceiptItems) purchaseItemsByReceipt.set(item.purchase_receipt_id, [...(purchaseItemsByReceipt.get(item.purchase_receipt_id) ?? []), item]);
  const purchaseReturnItemsByReturn = new Map<number, PurchaseReturnItem[]>();
  for (const item of purchaseReturnItems) purchaseReturnItemsByReturn.set(item.purchase_return_id, [...(purchaseReturnItemsByReturn.get(item.purchase_return_id) ?? []), item]);
  const returnItemsByReturn = new Map<number, SaleReturnItem[]>();
  for (const item of returnItems) returnItemsByReturn.set(item.return_id, [...(returnItemsByReturn.get(item.return_id) ?? []), item]);
  const accounting: PortableAccountingState | undefined = accountingSettings ? {
    settings: { accounting_enabled: accountingSettings.accounting_enabled, accounting_started_at: accountingSettings.accounting_started_at,
      functional_currency: accountingSettings.functional_currency, cutover_exchange_rate_syp_per_usd: accountingSettings.cutover_exchange_rate_syp_per_usd,
      opening_journal_uuid: accountingSettings.opening_journal_entry_id == null ? null : journalUuidById.get(accountingSettings.opening_journal_entry_id) ?? null,
      created_at: accountingSettings.created_at, updated_at: accountingSettings.updated_at },
    cutoverPositions: cutoverPositions.map(row => ({ uuid: row.uuid, position_type: row.position_type, entity_type: row.entity_type,
      entity_uuid: row.entity_type === 'PRODUCT' ? productUuidById.get(row.entity_id) ?? null : row.entity_type === 'SUPPLIER' ? supplierUuidById.get(row.entity_id) ?? null : row.entity_type === 'CUSTOMER' ? customerUuidById.get(row.entity_id) ?? null : null,
      native_amount_minor: row.native_amount_minor, carrying_value_syp: row.carrying_value_syp, created_at: row.created_at })),
    accounts: accounts.map(({ id: _id, ...row }) => row),
    journalEntries: journalEntries.map(row => ({ uuid: row.uuid, source_type: row.source_type, source_uuid: row.source_uuid ?? sourceUuid(row.source_type, row.source_id), reference: row.reference,
      occurred_at: row.occurred_at, created_at: row.created_at, description_snapshot: row.description_snapshot,
      reversal_of_entry_uuid: row.reversal_of_entry_id == null ? null : journalUuidById.get(row.reversal_of_entry_id) ?? null })),
    journalLines: journalLines.map(row => ({ uuid: row.uuid, journal_entry_uuid: journalUuidById.get(row.journal_entry_id) ?? '', account_uuid: accountUuidById.get(row.account_id) ?? '',
      debit_syp: row.debit_syp, credit_syp: row.credit_syp, source_currency: row.source_currency, source_amount_minor: row.source_amount_minor,
      exchange_rate_syp_per_usd: row.exchange_rate_syp_per_usd, memo: row.memo, created_at: row.created_at })),
    accountBalances: accountBalances.map(row => ({ account_uuid: accountUuidById.get(row.account_id) ?? '', debit_total_syp: row.debit_total_syp, credit_total_syp: row.credit_total_syp, net_balance_syp: row.net_balance_syp, updated_at: row.updated_at })),
    inventoryValueBalances: inventoryValueBalances.map(row => ({ product_uuid: productUuidById.get(row.product_id) ?? '', quantity_snapshot: row.quantity_snapshot, carrying_value_syp: row.carrying_value_syp, updated_at: row.updated_at })),
    inventoryValueMovements: inventoryValueMovements.map(row => ({ uuid: row.uuid, product_uuid: productUuidById.get(row.product_id) ?? '', source_type: row.source_type,
      source_uuid: inventoryValueSourceUuid(row.source_type, row.source_id), source_item_uuid: inventoryValueSourceItemUuid(row.source_type, row.source_item_id),
      quantity_delta: row.quantity_delta, quantity_before: row.quantity_before, quantity_after: row.quantity_after, value_delta_syp: row.value_delta_syp,
      value_before_syp: row.value_before_syp, value_after_syp: row.value_after_syp, created_at: row.created_at })),
    cashControl: cashControl ?? null,
    supplierPositionLayers: supplierPositionLayers.map(row => ({ uuid: row.uuid, supplier_uuid: supplierUuidById.get(row.supplier_id) ?? '', position_type: row.position_type,
      source_type: row.source_type, source_uuid: supplierSourceUuid(row.source_type, row.source_id), original_usd_cents: row.original_usd_cents,
      remaining_usd_cents: row.remaining_usd_cents, original_carrying_syp: row.original_carrying_syp, remaining_carrying_syp: row.remaining_carrying_syp,
      exchange_rate_syp_per_usd: row.exchange_rate_syp_per_usd, created_at: row.created_at, updated_at: row.updated_at })),
    supplierAllocations: supplierAllocations.map(row => ({ uuid: row.uuid, layer_uuid: supplierLayerUuidById.get(row.layer_id) ?? '', source_type: row.source_type,
      source_uuid: supplierSourceUuid(row.source_type, row.source_id) ?? '', native_usd_cents: row.native_usd_cents, carrying_value_syp: row.carrying_value_syp, created_at: row.created_at })),
    cashAdjustments: cashAdjustments.map(({ id: _id, ...row }) => row),
  } : undefined;
  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    products, categories, settings, expenseCategories, exchangeRateHistory, accounting,
    customers: customers.map(({ id: _id, balance_syp: _balance, sale_count: _count, latest_sale_at: _latest, ...customer }) => customer),
    customerAccountBalances: customerAccountBalances.map(balance => ({ customer_uuid: customerUuidById.get(balance.customer_id) ?? '', balance_syp: balance.balance_syp, updated_at: balance.updated_at })),
    customerPayments: customerPayments.map(({ id, customer_id, cash_session_id, tenders: _tenders, ...payment }) => ({ ...payment, customer_uuid: customerUuidById.get(customer_id) ?? '', cash_session_uuid: sessionUuidById.get(cash_session_id) ?? '', tenders: (customerTendersByPayment.get(id) ?? []).map(({ id: _id, customer_payment_id: _paymentId, ...tender }) => tender) })),
    customerAccountEntries: customerAccountEntries.map(({ id: _id, customer_id, sale_id, sale_return_id, customer_payment_id, reference: _reference, running_balance_syp: _running, ...entry }) => ({ ...entry, customer_uuid: customerUuidById.get(customer_id) ?? '', sale_uuid: sale_id ? saleUuidById.get(sale_id) ?? null : null, sale_return_uuid: sale_return_id ? saleReturnUuidById.get(sale_return_id) ?? null : null, customer_payment_uuid: customer_payment_id ? customerPaymentUuidById.get(customer_payment_id) ?? null : null })),
suppliers: suppliers.map(({ id: _id, receipt_count: _count, latest_receipt_at: _latest, return_count: _returnCount, latest_return_at: _latestReturn, ...supplier }) => supplier),
    purchaseReceipts: purchaseReceipts.map(({ id, supplier_id, item_count: _count, total_quantity: _quantity, total_cost_usd_cents: _total, items: _items, ...receipt }) => ({
      ...receipt, supplier_uuid: supplier_id ? supplierUuidById.get(supplier_id) ?? null : null,
      items: (purchaseItemsByReceipt.get(id) ?? []).map(({ id: _id, purchase_receipt_id: _receiptId, product_id, ...item }) => ({ ...item, product_uuid: product_id ? productUuidById.get(product_id) ?? null : null })),
    })),
    purchaseReturns: purchaseReturns.map(({ id, purchase_receipt_id, purchase_receipt_uuid: _receiptUuid, items: _items, ...record }) => ({
      ...record, purchase_receipt_uuid: purchaseReceiptUuidById.get(purchase_receipt_id) ?? '',
      items: (purchaseReturnItemsByReturn.get(id) ?? []).map(({ id: _id, purchase_return_id: _returnId, purchase_receipt_item_id, ...item }) => ({ ...item, purchase_receipt_item_uuid: purchaseItemUuidById.get(purchase_receipt_item_id) ?? '' })),
    })),
    supplierAccountBalances: supplierAccountBalances.map(balance => ({ supplier_uuid: supplierUuidById.get(balance.supplier_id) ?? '', balance_usd_cents: balance.balance_usd_cents, updated_at: balance.updated_at })),
    supplierPayments: supplierPayments.map(({ id, supplier_id, cash_session_id, tenders: _tenders, ...payment }) => ({
      ...payment, supplier_uuid: supplierUuidById.get(supplier_id) ?? '', cash_session_uuid: sessionUuidById.get(cash_session_id) ?? '',
      tenders: (paymentTendersByPayment.get(id) ?? []).map(({ id: _id, supplier_payment_id: _paymentId, ...tender }) => tender),
    })),
    supplierAccountEntries: supplierAccountEntries.map(({ id: _id, supplier_id, purchase_receipt_id, purchase_return_id, supplier_payment_id, reference: _reference, running_balance_usd_cents: _running, ...entry }) => ({
      ...entry, supplier_uuid: supplierUuidById.get(supplier_id) ?? '', purchase_receipt_uuid: purchase_receipt_id ? purchaseReceiptUuidById.get(purchase_receipt_id) ?? null : null,
      purchase_return_uuid: purchase_return_id ? purchaseReturnUuidById.get(purchase_return_id) ?? null : null,
      supplier_payment_uuid: supplier_payment_id ? supplierPaymentUuidById.get(supplier_payment_id) ?? null : null,
    })),
    inventoryBalances: inventoryBalances.map(({ id: _id, product_id, ...balance }) => ({ ...balance, product_uuid: productUuidById.get(product_id) ?? '' })),
    inventoryMovements: inventoryMovements.map(({ id: _id, product_id, sale_item_id, return_item_id, purchase_receipt_item_id, purchase_return_item_id, ...movement }) => ({ ...movement, product_uuid: product_id ? productUuidById.get(product_id) ?? movement.product_uuid_snapshot : movement.product_uuid_snapshot, sale_item_uuid: sale_item_id ? saleItemUuidById.get(sale_item_id) ?? null : null, return_item_uuid: return_item_id ? returnItemUuidById.get(return_item_id) ?? null : null, purchase_receipt_item_uuid: purchase_receipt_item_id ? purchaseItemUuidById.get(purchase_receipt_item_id) ?? null : null, purchase_return_item_uuid: purchase_return_item_id ? purchaseReturnItemUuidById.get(purchase_return_item_id) ?? null : null })),
    salePayments: salePayments.map(({ id: _id, sale_id, ...payment }) => ({ ...payment, sale_uuid: saleUuidById.get(sale_id) ?? '' })),
    cashSessions: cashSessions.map(({ id: _id, ...session }) => session),
    sales: salesRows.map(sale => { const { cash_session_id: sessionId, customer_id: _customerId, ...portable } = sale; return { ...portable, cash_session_uuid: sessionId ? sessionUuidById.get(sessionId) ?? null : null, items: saleItemsBySale.get(sale.id) ?? [] }; }),
    expenses: expenses.map(expense => { const { cash_session_id: sessionId, ...portable } = expense; return { ...portable, cash_session_uuid: sessionId ? sessionUuidById.get(sessionId) ?? null : null }; }),
    drafts: draftRows.map(draft => ({ ...draft, items: itemsByDraft.get(draft.id) ?? [] })),
    returns: returnRows.map(record => ({
      uuid: record.uuid, sale_uuid: saleUuidById.get(record.sale_id) ?? '', cash_session_uuid: record.cash_session_id ? sessionUuidById.get(record.cash_session_id) ?? null : null, refund_total_syp: record.refund_total_syp,
      returned_cost_syp: record.returned_cost_syp, created_at: record.created_at, updated_at: record.updated_at,
      customer_account_credit_syp: record.customer_account_credit_syp ?? 0,
      items: (returnItemsByReturn.get(record.id) ?? []).map(item => ({ uuid: item.uuid, sale_item_uuid: saleItemUuidById.get(item.sale_item_id) ?? '', quantity: item.quantity, refund_amount_syp: item.refund_amount_syp, cost_reversal_syp: item.cost_reversal_syp,
        restock_quantity: item.restock_quantity ?? null, accounting_restored_cogs_syp: item.accounting_restored_cogs_syp ?? null, created_at: item.created_at, updated_at: item.updated_at })),
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
        salePayments: data.salePayments?.length ?? 0,
        expenses: data.expenses.length, images: imageCount,
        drafts: data.drafts?.length ?? 0,
        draftItems: data.drafts?.reduce((sum, draft) => sum + draft.items.length, 0) ?? 0,
        returns: data.returns?.length ?? 0,
        returnItems: data.returns?.reduce((sum, record) => sum + record.items.length, 0) ?? 0,
        expenseCategories: data.expenseCategories?.length ?? 0,
        exchangeRateHistory: data.exchangeRateHistory?.length ?? 0,
        cashSessions: data.cashSessions?.length ?? 0,
        inventoryBalances: data.inventoryBalances?.length ?? 0,
        inventoryMovements: data.inventoryMovements?.length ?? 0,
        suppliers: data.suppliers?.length ?? 0,
        purchaseReceipts: data.purchaseReceipts?.length ?? 0,
        purchaseReceiptItems: data.purchaseReceipts?.reduce((sum, receipt) => sum + receipt.items.length, 0) ?? 0,
        purchaseReturns: data.purchaseReturns?.length ?? 0,
        purchaseReturnItems: data.purchaseReturns?.reduce((sum, record) => sum + record.items.length, 0) ?? 0,
        supplierAccountBalances: data.supplierAccountBalances?.length ?? 0,
        supplierAccountEntries: data.supplierAccountEntries?.length ?? 0,
        supplierPayments: data.supplierPayments?.length ?? 0,
        supplierPaymentTenders: data.supplierPayments?.reduce((sum, payment) => sum + payment.tenders.length, 0) ?? 0,
        customers: data.customers?.length ?? 0,
        customerAccountBalances: data.customerAccountBalances?.length ?? 0,
        customerAccountEntries: data.customerAccountEntries?.length ?? 0,
        customerPayments: data.customerPayments?.length ?? 0,
        customerPaymentTenders: data.customerPayments?.reduce((sum, payment) => sum + payment.tenders.length, 0) ?? 0,
        journalEntries: data.accounting?.journalEntries.length ?? 0,
        journalLines: data.accounting?.journalLines.length ?? 0,
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
      (candidate.manifest.counts.salePayments != null && candidate.manifest.counts.salePayments !== (candidate.data.salePayments?.length ?? 0)) ||
      candidate.manifest.counts.expenses !== candidate.data.expenses.length ||
      (candidate.manifest.counts.drafts != null && candidate.manifest.counts.drafts !== (candidate.data.drafts?.length ?? 0)) ||
      (candidate.manifest.counts.draftItems != null && candidate.manifest.counts.draftItems !== (candidate.data.drafts?.reduce((sum, draft) => sum + draft.items.length, 0) ?? 0)) ||
      (candidate.manifest.counts.returns != null && candidate.manifest.counts.returns !== (candidate.data.returns?.length ?? 0)) ||
      (candidate.manifest.counts.returnItems != null && candidate.manifest.counts.returnItems !== (candidate.data.returns?.reduce((sum, record) => sum + record.items.length, 0) ?? 0)) ||
      (candidate.manifest.counts.expenseCategories != null && candidate.manifest.counts.expenseCategories !== (candidate.data.expenseCategories?.length ?? 0)) ||
      (candidate.manifest.counts.exchangeRateHistory != null && candidate.manifest.counts.exchangeRateHistory !== (candidate.data.exchangeRateHistory?.length ?? 0)) ||
      (candidate.manifest.counts.cashSessions != null && candidate.manifest.counts.cashSessions !== (candidate.data.cashSessions?.length ?? 0)) ||
      (candidate.manifest.counts.inventoryBalances != null && candidate.manifest.counts.inventoryBalances !== (candidate.data.inventoryBalances?.length ?? 0)) ||
      (candidate.manifest.counts.inventoryMovements != null && candidate.manifest.counts.inventoryMovements !== (candidate.data.inventoryMovements?.length ?? 0)) ||
      (candidate.manifest.counts.suppliers != null && candidate.manifest.counts.suppliers !== (candidate.data.suppliers?.length ?? 0)) ||
      (candidate.manifest.counts.purchaseReceipts != null && candidate.manifest.counts.purchaseReceipts !== (candidate.data.purchaseReceipts?.length ?? 0)) ||
      (candidate.manifest.counts.purchaseReceiptItems != null && candidate.manifest.counts.purchaseReceiptItems !== (candidate.data.purchaseReceipts?.reduce((sum, receipt) => sum + receipt.items.length, 0) ?? 0)) ||
      (candidate.manifest.counts.purchaseReturns != null && candidate.manifest.counts.purchaseReturns !== (candidate.data.purchaseReturns?.length ?? 0)) ||
      (candidate.manifest.counts.purchaseReturnItems != null && candidate.manifest.counts.purchaseReturnItems !== (candidate.data.purchaseReturns?.reduce((sum, record) => sum + record.items.length, 0) ?? 0)) ||
      (candidate.manifest.counts.supplierAccountBalances != null && candidate.manifest.counts.supplierAccountBalances !== (candidate.data.supplierAccountBalances?.length ?? 0)) ||
      (candidate.manifest.counts.supplierAccountEntries != null && candidate.manifest.counts.supplierAccountEntries !== (candidate.data.supplierAccountEntries?.length ?? 0)) ||
      (candidate.manifest.counts.supplierPayments != null && candidate.manifest.counts.supplierPayments !== (candidate.data.supplierPayments?.length ?? 0)) ||
      (candidate.manifest.counts.supplierPaymentTenders != null && candidate.manifest.counts.supplierPaymentTenders !== (candidate.data.supplierPayments?.reduce((sum, payment) => sum + payment.tenders.length, 0) ?? 0)) ||
      (candidate.manifest.counts.customers != null && candidate.manifest.counts.customers !== (candidate.data.customers?.length ?? 0)) ||
      (candidate.manifest.counts.customerAccountBalances != null && candidate.manifest.counts.customerAccountBalances !== (candidate.data.customerAccountBalances?.length ?? 0)) ||
      (candidate.manifest.counts.customerAccountEntries != null && candidate.manifest.counts.customerAccountEntries !== (candidate.data.customerAccountEntries?.length ?? 0)) ||
      (candidate.manifest.counts.customerPayments != null && candidate.manifest.counts.customerPayments !== (candidate.data.customerPayments?.length ?? 0)) ||
      (candidate.manifest.counts.customerPaymentTenders != null && candidate.manifest.counts.customerPaymentTenders !== (candidate.data.customerPayments?.reduce((sum, payment) => sum + payment.tenders.length, 0) ?? 0))) {
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
