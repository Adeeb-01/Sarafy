import { CashSession, Customer, CustomerAccountEntryType, ExchangeRateHistoryEntry, Expense, ExpenseCategory, InventoryMovementType, Product, Sale, Settings, Supplier, SupplierAccountEntryType, SuspendedSale } from '@/types';

export type ImportMode = 'safe_merge' | 'selective' | 'full_restore';
export type ConflictStrategy = 'newest' | 'keep_local' | 'use_imported' | 'manual';
export type ImportEntity = 'products' | 'categories' | 'settings' | 'sales' | 'sale_items' | 'sale_payments' | 'sale_returns' | 'sale_return_items' | 'expenses' | 'expense_categories' | 'exchange_rate_history' | 'cash_sessions' | 'inventory_balances' | 'inventory_movements' | 'suppliers' | 'purchase_receipts' | 'purchase_receipt_items' | 'purchase_returns' | 'purchase_return_items' | 'supplier_account_balances' | 'supplier_account_entries' | 'supplier_payments' | 'supplier_payment_tenders' | 'customers' | 'customer_account_balances' | 'customer_account_entries' | 'customer_payments' | 'customer_payment_tenders' | 'accounting' | 'product_images' | 'sale_drafts' | 'sale_draft_items';

export interface PortableSalePayment {
  uuid: string; sale_uuid: string; currency: 'SYP' | 'USD'; amount_minor: number;
  syp_equivalent: number; exchange_rate_syp_per_usd: number | null; accounting_cash_carrying_syp?: number | null; created_at: string;
}

export interface PortableSaleReturnItem {
  uuid: string; sale_item_uuid: string; quantity: number; refund_amount_syp: number;
  cost_reversal_syp: number; created_at: string; updated_at: string;
  restock_quantity?: number | null; accounting_restored_cogs_syp?: number | null;
}

export interface PortableSaleReturn {
  uuid: string; sale_uuid: string; refund_total_syp: number; returned_cost_syp: number;
  cash_session_uuid?: string | null;
  customer_account_credit_syp?: number;
  created_at: string; updated_at: string; items: PortableSaleReturnItem[];
}

export type PortableCustomer = Omit<Customer, 'id' | 'balance_syp' | 'sale_count' | 'latest_sale_at'>;
export interface PortableCustomerAccountBalance { customer_uuid: string; balance_syp: number; updated_at: string }
export interface PortableCustomerPaymentTender { uuid: string; currency: 'SYP' | 'USD'; amount_minor: number; syp_equivalent: number; exchange_rate_syp_per_usd: number | null; accounting_cash_carrying_syp?: number | null; created_at: string }
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
  accounting_line_syp?: number | null; accounting_advance_usd_cents?: number | null; accounting_advance_syp?: number | null;
  accounting_payable_usd_cents?: number | null; accounting_payable_syp?: number | null;
}
export interface PortablePurchaseReceipt {
  uuid: string; supplier_uuid: string | null; supplier_uuid_snapshot: string; supplier_name_snapshot: string; reference_number: string | null;
  note: string | null; received_at: string; created_at: string; items: PortablePurchaseReceiptItem[];
  accounting_exchange_rate_syp_per_usd?: number | null; accounting_total_syp?: number | null;
  accounting_advance_usd_cents?: number | null; accounting_advance_syp?: number | null;
  accounting_payable_usd_cents?: number | null; accounting_payable_syp?: number | null;
}
export interface PortablePurchaseReturnItem {
  uuid: string; purchase_receipt_item_uuid: string; product_uuid_snapshot: string; product_name_snapshot: string; barcode_snapshot: string | null;
  quantity: number; unit_cost_usd_cents: number; line_total_usd_cents: number; created_at: string;
  accounting_inventory_relief_syp?: number | null; accounting_position_relief_syp?: number | null;
  accounting_advance_created_syp?: number | null; accounting_variance_syp?: number | null;
}
export interface PortablePurchaseReturn {
  uuid: string; purchase_receipt_uuid: string; supplier_uuid_snapshot: string; supplier_name_snapshot: string; created_at: string;
  total_quantity: number; total_value_usd_cents: number; reference_number: string | null; note: string | null; items: PortablePurchaseReturnItem[];
  accounting_exchange_rate_syp_per_usd?: number | null; accounting_inventory_relief_syp?: number | null;
  accounting_position_relief_syp?: number | null; accounting_advance_created_syp?: number | null; accounting_variance_syp?: number | null;
}

export interface PortableSupplierAccountBalance { supplier_uuid: string; balance_usd_cents: number; updated_at: string }
export interface PortableSupplierPaymentTender { uuid: string; currency: 'SYP' | 'USD'; amount_minor: number; usd_equivalent_cents: number; exchange_rate_syp_per_usd: number | null; accounting_cash_carrying_syp?: number | null; created_at: string }
export interface PortableSupplierPayment {
  uuid: string; supplier_uuid: string; cash_session_uuid: string; payment_mode: 'SYP' | 'USD' | 'MIXED'; total_usd_equivalent_cents: number;
  exchange_rate_syp_per_usd: number | null; supplier_name_snapshot: string; note: string | null; occurred_at: string; created_at: string;
  balance_after_usd_cents: number; tenders: PortableSupplierPaymentTender[];
  accounting_payable_relief_syp?: number | null; accounting_consideration_syp?: number | null;
  accounting_advance_created_syp?: number | null; accounting_realized_fx_syp?: number | null;
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

export interface PortableAccountingState {
  settings: { accounting_enabled: number; accounting_started_at: string | null; functional_currency: 'SYP'; cutover_exchange_rate_syp_per_usd: number | null; opening_journal_uuid: string | null; created_at: string; updated_at: string };
  cutoverPositions: Array<{ uuid: string; position_type: string; entity_type: string; entity_uuid: string | null; native_amount_minor: number; carrying_value_syp: number; created_at: string }>;
  accounts: Array<{ uuid: string; code: string; system_key: string; name_ar: string; name_en: string; account_type: string; normal_side: string; is_system: number; active: number; created_at: string; updated_at: string }>;
  journalEntries: Array<{ uuid: string; source_type: string; source_uuid: string | null; reference: string | null; occurred_at: string; created_at: string; description_snapshot: string; reversal_of_entry_uuid: string | null }>;
  journalLines: Array<{ uuid: string; journal_entry_uuid: string; account_uuid: string; debit_syp: number; credit_syp: number; source_currency: 'SYP' | 'USD' | null; source_amount_minor: number | null; exchange_rate_syp_per_usd: number | null; memo: string | null; created_at: string }>;
  accountBalances: Array<{ account_uuid: string; debit_total_syp: number; credit_total_syp: number; net_balance_syp: number; updated_at: string }>;
  inventoryValueBalances: Array<{ product_uuid: string; quantity_snapshot: number; carrying_value_syp: number; updated_at: string }>;
  inventoryValueMovements: Array<{ uuid: string; product_uuid: string; source_type: string; source_uuid: string | null; source_item_uuid: string | null; quantity_delta: number; quantity_before: number; quantity_after: number; value_delta_syp: number; value_before_syp: number; value_after_syp: number; created_at: string }>;
  cashControl: { cash_syp: number; cash_usd_cents: number; cash_usd_carrying_syp: number; updated_at: string } | null;
  supplierPositionLayers: Array<{ uuid: string; supplier_uuid: string; position_type: 'PAYABLE' | 'ADVANCE'; source_type: string; source_uuid: string | null; original_usd_cents: number; remaining_usd_cents: number; original_carrying_syp: number; remaining_carrying_syp: number; exchange_rate_syp_per_usd: number | null; created_at: string; updated_at: string }>;
  supplierAllocations: Array<{ uuid: string; layer_uuid: string; source_type: string; source_uuid: string; native_usd_cents: number; carrying_value_syp: number; created_at: string }>;
  cashAdjustments: Array<{ uuid: string; currency: 'SYP' | 'USD'; amount_minor: number; carrying_value_syp: number; exchange_rate_syp_per_usd: number | null; reason: string; note: string | null; occurred_at: string; created_at: string }>;
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
  accounting?: PortableAccountingState;
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
