import { CashSession, Customer, CustomerAccountEntryType, ExchangeRateHistoryEntry, Expense, ExpenseCategory, InventoryMovementType, Product, Sale, Settings, Supplier, SupplierAccountEntryType, SuspendedSale } from '@/types';

export type ImportMode = 'safe_merge' | 'selective' | 'full_restore';
export type ConflictStrategy = 'newest' | 'keep_local' | 'use_imported' | 'manual';
export type ImportEntity = 'products' | 'categories' | 'settings' | 'sales' | 'sale_items' | 'sale_payments' | 'sale_returns' | 'sale_return_items' | 'expenses' | 'expense_categories' | 'exchange_rate_history' | 'cash_sessions' | 'inventory_balances' | 'inventory_movements' | 'suppliers' | 'purchase_receipts' | 'purchase_receipt_items' | 'purchase_returns' | 'purchase_return_items' | 'supplier_account_balances' | 'supplier_account_entries' | 'supplier_payments' | 'supplier_payment_tenders' | 'customers' | 'customer_account_balances' | 'customer_account_entries' | 'customer_payments' | 'customer_payment_tenders' | 'product_images' | 'sale_drafts' | 'sale_draft_items';

export interface PortableSalePayment {
  uuid: string; sale_uuid: string; currency: 'SYP' | 'USD'; amount_minor: number;
  syp_equivalent: number; exchange_rate_syp_per_usd: number | null; created_at: string;
}

export interface PortableSaleReturnItem {
  uuid: string; sale_item_uuid: string; quantity: number; refund_amount_syp: number;
  cost_reversal_syp: number; created_at: string; updated_at: string;
}

export interface PortableSaleReturn {
  uuid: string; sale_uuid: string; refund_total_syp: number; returned_cost_syp: number;
  cash_session_uuid?: string | null;
  customer_account_credit_syp?: number;
  created_at: string; updated_at: string; items: PortableSaleReturnItem[];
}

export type PortableCustomer = Omit<Customer, 'id' | 'balance_syp' | 'sale_count' | 'latest_sale_at'>;
export interface PortableCustomerAccountBalance { customer_uuid: string; balance_syp: number; updated_at: string }
export interface PortableCustomerPaymentTender { uuid: string; currency: 'SYP' | 'USD'; amount_minor: number; syp_equivalent: number; exchange_rate_syp_per_usd: number | null; created_at: string }
export interface PortableCustomerPayment { uuid: string; customer_uuid: string; cash_session_uuid: string; payment_mode: 'SYP' | 'USD' | 'MIXED'; total_syp_equivalent: number; exchange_rate_syp_per_usd: number | null; customer_name_snapshot: string; note: string | null; occurred_at: string; created_at: string; balance_after_syp: number; tenders: PortableCustomerPaymentTender[] }
export interface PortableCustomerAccountEntry { uuid: string; customer_uuid: string; type: CustomerAccountEntryType; delta_syp: number; occurred_at: string; created_at: string; customer_name_snapshot: string; sale_uuid: string | null; sale_return_uuid: string | null; customer_payment_uuid: string | null; note_snapshot: string | null }

export type PortableCashSession = Omit<CashSession, 'id'>;

export interface PortableInventoryBalance { product_uuid: string; tracking_enabled: number; quantity: number; low_stock_threshold: number | null; created_at: string; updated_at: string }
export interface PortableInventoryMovement {
  uuid: string; product_uuid: string; product_uuid_snapshot: string; product_name_snapshot: string; barcode_snapshot: string | null;
  movement_type: InventoryMovementType; quantity_delta: number; quantity_before: number; quantity_after: number;
  sale_item_uuid: string | null; return_item_uuid: string | null; purchase_receipt_item_uuid?: string | null; purchase_return_item_uuid?: string | null; note: string | null; created_at: string;
}

export type PortableSupplier = Omit<Supplier, 'id' | 'receipt_count' | 'latest_receipt_at' | 'return_count' | 'latest_return_at'>;
export interface PortablePurchaseReceiptItem {
  uuid: string; product_uuid: string | null; product_uuid_snapshot: string; product_name_snapshot: string; barcode_snapshot: string | null;
  quantity: number; unit_cost_usd_cents: number; line_total_usd_cents: number; created_at: string;
}
export interface PortablePurchaseReceipt {
  uuid: string; supplier_uuid: string | null; supplier_uuid_snapshot: string; supplier_name_snapshot: string; reference_number: string | null;
  note: string | null; received_at: string; created_at: string; items: PortablePurchaseReceiptItem[];
}
export interface PortablePurchaseReturnItem {
  uuid: string; purchase_receipt_item_uuid: string; product_uuid_snapshot: string; product_name_snapshot: string; barcode_snapshot: string | null;
  quantity: number; unit_cost_usd_cents: number; line_total_usd_cents: number; created_at: string;
}
export interface PortablePurchaseReturn {
  uuid: string; purchase_receipt_uuid: string; supplier_uuid_snapshot: string; supplier_name_snapshot: string; created_at: string;
  total_quantity: number; total_value_usd_cents: number; reference_number: string | null; note: string | null; items: PortablePurchaseReturnItem[];
}

export interface PortableSupplierAccountBalance { supplier_uuid: string; balance_usd_cents: number; updated_at: string }
export interface PortableSupplierPaymentTender { uuid: string; currency: 'SYP' | 'USD'; amount_minor: number; usd_equivalent_cents: number; exchange_rate_syp_per_usd: number | null; created_at: string }
export interface PortableSupplierPayment {
  uuid: string; supplier_uuid: string; cash_session_uuid: string; payment_mode: 'SYP' | 'USD' | 'MIXED'; total_usd_equivalent_cents: number;
  exchange_rate_syp_per_usd: number | null; supplier_name_snapshot: string; note: string | null; occurred_at: string; created_at: string;
  balance_after_usd_cents: number; tenders: PortableSupplierPaymentTender[];
}
export interface PortableSupplierAccountEntry {
  uuid: string; supplier_uuid: string; type: SupplierAccountEntryType; delta_usd_cents: number; occurred_at: string; created_at: string;
  supplier_name_snapshot: string; purchase_receipt_uuid: string | null; purchase_return_uuid: string | null; supplier_payment_uuid: string | null; note_snapshot: string | null;
}

export interface PortableCategory {
  id?: number;
  uuid: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface ImportPayload {
  version: number;
  exportedAt: string;
  products: Product[];
  categories: PortableCategory[];
  settings: Settings;
  sales: Sale[];
  salePayments?: PortableSalePayment[];
  expenses: Expense[];
  drafts?: SuspendedSale[];
  returns?: PortableSaleReturn[];
  expenseCategories?: ExpenseCategory[];
  exchangeRateHistory?: ExchangeRateHistoryEntry[];
  cashSessions?: PortableCashSession[];
  inventoryBalances?: PortableInventoryBalance[];
  inventoryMovements?: PortableInventoryMovement[];
  suppliers?: PortableSupplier[];
  purchaseReceipts?: PortablePurchaseReceipt[];
  purchaseReturns?: PortablePurchaseReturn[];
  supplierAccountBalances?: PortableSupplierAccountBalance[];
  supplierAccountEntries?: PortableSupplierAccountEntry[];
  supplierPayments?: PortableSupplierPayment[];
  customers?: PortableCustomer[];
  customerAccountBalances?: PortableCustomerAccountBalance[];
  customerAccountEntries?: PortableCustomerAccountEntry[];
  customerPayments?: PortableCustomerPayment[];
}

export interface ImportOptions {
  mode: ImportMode;
  conflictStrategy: ConflictStrategy;
  entities: ImportEntity[];
  importSettings?: boolean;
  archiveMissingProducts?: boolean;
}

export interface ImportIssue {
  entity: ImportEntity;
  row: number;
  field?: string;
  value?: string;
  code: string;
  action: 'rejected' | 'skipped' | 'review';
}

export interface ImportPreviewSummary {
  newRecords: number;
  updatedRecords: number;
  unchangedRecords: number;
  conflicts: number;
  duplicates: number;
  invalidRecords: number;
  newImages: number;
  missingImages: number;
  replacedImages: number;
}

export interface ImportPreview {
  summary: ImportPreviewSummary;
  issues: ImportIssue[];
  payload: ImportPayload;
  options: ImportOptions;
}

export interface ImportResult {
  success: boolean;
  backupId?: string;
  inserted: number;
  updated: number;
  skipped: number;
  rejected: number;
  conflicts: number;
  warnings: ImportIssue[];
  errors: ImportIssue[];
}
