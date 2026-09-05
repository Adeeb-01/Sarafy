export type Language = 'ar' | 'en';

export interface Product {
  id: number;
  uuid: string;
  name: string;
  category: string;
  price_usd: number;
  cost_usd: number;
  image_uri: string | null;
  barcode: string | null;
  created_at: string;
  updated_at: string;
  is_active: number;
  inventory_tracking_enabled?: number;
  inventory_quantity?: number | null;
  low_stock_threshold?: number | null;
}

export type ProductInput = Omit<Product, 'id' | 'uuid' | 'created_at' | 'updated_at' | 'is_active' | 'inventory_tracking_enabled' | 'inventory_quantity' | 'low_stock_threshold'>;

export interface Settings {
  exchangeRate: number;
  isRoundingEnabled: boolean;
  roundingTarget: 5 | 10 | 500 | 1000;
  language: Language;
}

export interface SaleItem {
  id: number;
  uuid: string;
  sale_id: number;
  product_id: number | null;
  product_name: string;
  barcode_snapshot: string | null;
  quantity: number;
  unit_price_syp: number;
  unit_cost_syp: number;
  line_total_syp: number;
  line_cost_syp: number;
  created_at: string;
  updated_at: string;
  inventory_sale_movement?: number;
}

export type ReturnStatus = 'none' | 'partial' | 'full';
export type PaymentCurrency = 'SYP' | 'USD';
export type PaymentMode = 'SYP' | 'USD' | 'MIXED';

export interface SalePayment {
  id: number;
  uuid: string;
  sale_id: number;
  currency: PaymentCurrency;
  amount_minor: number;
  syp_equivalent: number;
  exchange_rate_syp_per_usd: number | null;
  created_at: string;
}

export interface PaymentInput {
  mode: PaymentMode;
  sypAmount: number;
  usdCents: number;
}

export interface PaymentSettlement {
  mode: PaymentMode;
  payments: Array<Omit<SalePayment, 'id' | 'uuid' | 'sale_id' | 'created_at'>>;
  totalTenderEquivalentSyp: number;
  changeSyp: number;
  remainingSyp: number;
  valid: boolean;
}

export interface SaleReturnItem {
  id: number;
  uuid: string;
  return_id: number;
  sale_item_id: number;
  quantity: number;
  refund_amount_syp: number;
  cost_reversal_syp: number;
  created_at: string;
  updated_at: string;
  product_name: string;
  barcode_snapshot: string | null;
}

export interface SaleReturn {
  id: number;
  uuid: string;
  sale_id: number;
  refund_total_syp: number;
  returned_cost_syp: number;
  created_at: string;
  updated_at: string;
  cash_session_id?: number | null;
  cash_session_uuid?: string | null;
  items: SaleReturnItem[];
}

export interface SaleReturnSummary {
  refund_total_syp: number;
  returned_cost_syp: number;
  returned_quantity: number;
  sold_quantity: number;
  status: ReturnStatus;
}

export interface Sale {
  id: number;
  uuid: string;
  invoice_number: string;
  exchange_rate: number;
  subtotal_syp: number;
  discount_syp: number;
  net_total_syp: number;
  cost_syp: number;
  profit_syp: number;
  amount_paid_syp: number | null;
  change_syp: number | null;
  created_at: string;
  updated_at: string;
  cash_session_id?: number | null;
  cash_session_uuid?: string | null;
  items: SaleItem[];
  item_count?: number;
  line_count?: number;
  returns?: SaleReturn[];
  return_summary?: SaleReturnSummary;
  payments?: SalePayment[];
}

export interface ReturnableSaleItem extends SaleItem {
  soldQuantity: number;
  returnedQuantity: number;
  remainingReturnableQuantity: number;
  lineNetRefundableSyp: number;
  previewRefundSyp: number;
}

export interface ReturnSelection { saleItemId: number; quantity: number; restockQuantity?: number }

export interface ReturnPreview {
  items: Array<{ saleItemId: number; quantity: number; refundAmountSyp: number; costReversalSyp: number }>;
  refundTotalSyp: number;
  returnedCostSyp: number;
}

export interface SaleItemInput {
  productId: number | null;
  productName: string;
  barcodeSnapshot: string | null;
  quantity: number;
  unitPriceSyp: number;
  unitCostSyp: number;
}

export type InventoryMovementType = 'opening' | 'stock_in' | 'stock_out' | 'adjustment' | 'sale' | 'return' | 'purchase';
export type InventoryStockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';

export interface InventoryBalance {
  id: number;
  product_id: number;
  tracking_enabled: number;
  quantity: number;
  low_stock_threshold: number | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryListItem extends InventoryBalance {
  product_uuid: string;
  product_name: string;
  barcode: string | null;
  is_active: number;
  status: InventoryStockStatus;
}

export interface InventoryMovement {
  id: number;
  uuid: string;
  product_id: number | null;
  product_uuid_snapshot: string;
  product_name_snapshot: string;
  barcode_snapshot: string | null;
  movement_type: InventoryMovementType;
  quantity_delta: number;
  quantity_before: number;
  quantity_after: number;
  sale_item_id: number | null;
  return_item_id: number | null;
  purchase_receipt_item_id: number | null;
  note: string | null;
  created_at: string;
}

export interface InventoryDetail extends InventoryListItem {
  movements: InventoryMovement[];
}

export interface InventoryQuery {
  search?: string;
  status?: 'all' | InventoryStockStatus;
  sort?: 'name' | 'lowest' | 'highest';
}

export interface InventoryMetrics { tracked: number; lowStock: number; outOfStock: number }

export interface InventoryHealthReport {
  negativeBalances: number;
  arithmeticMismatches: number;
  latestBalanceMismatches: number;
  duplicateSaleMovements: number;
  duplicateReturnMovements: number;
  duplicatePurchaseMovements: number;
  invalidPurchaseMovements: number;
  missingPurchaseMovements: number;
}

export interface Supplier {
  id: number;
  uuid: string;
  name: string;
  phone: string | null;
  address: string | null;
  note: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
  receipt_count?: number;
  latest_receipt_at?: string | null;
}

export type SupplierInput = Pick<Supplier, 'name' | 'phone' | 'address' | 'note'>;
export type SupplierSort = 'name' | 'newest';

export interface PurchaseReceiptItem {
  id: number;
  uuid: string;
  purchase_receipt_id: number;
  product_id: number | null;
  product_uuid_snapshot: string;
  product_name_snapshot: string;
  barcode_snapshot: string | null;
  quantity: number;
  unit_cost_usd_cents: number;
  line_total_usd_cents: number;
  created_at: string;
}

export interface PurchaseReceipt {
  id: number;
  uuid: string;
  supplier_id: number | null;
  supplier_uuid_snapshot: string;
  supplier_name_snapshot: string;
  reference_number: string | null;
  note: string | null;
  received_at: string;
  created_at: string;
  item_count: number;
  total_quantity: number;
  total_cost_usd_cents: number;
  items?: PurchaseReceiptItem[];
}

export interface PurchaseReceiptInputItem { productId: number; quantity: number; unitCostUsdCents: number }
export interface PurchaseReceiptInput { supplierId: number; referenceNumber?: string | null; note?: string | null; items: PurchaseReceiptInputItem[] }
export interface PurchaseReceiptQuery { search?: string; period?: 'all' | 'today' | 'week' | 'month'; supplierId?: number; sort?: 'newest' | 'oldest' | 'highest' | 'lowest'; limit?: number }

export interface PaymentInfo {
  amountPaidSyp: number;
  changeSyp: number;
}

export interface SuspendedSaleItem {
  id: number;
  uuid: string;
  draft_id: number;
  product_id: number | null;
  product_name: string;
  barcode_snapshot: string | null;
  quantity: number;
  unit_price_syp: number;
  unit_cost_syp: number;
  created_at: string;
  updated_at: string;
}

export interface SuspendedSale {
  id: number;
  uuid: string;
  exchange_rate: number;
  discount_syp: number;
  created_at: string;
  updated_at: string;
  items: SuspendedSaleItem[];
}

export interface SuspendedSaleSummary extends Omit<SuspendedSale, 'items'> {
  item_count: number;
  line_count: number;
  subtotal_syp: number;
  net_total_syp: number;
  item_preview: string;
}

export type InvoicePeriod = 'all' | 'today' | 'week' | 'month';
export type InvoiceSort = 'newest' | 'oldest' | 'highest' | 'lowest';

export interface InvoiceQuery {
  search?: string;
  period?: InvoicePeriod;
  minAmount?: number | null;
  maxAmount?: number | null;
  sort?: InvoiceSort;
}

export interface Expense {
  id: number;
  uuid: string;
  description: string;
  amount_syp: number;
  category_id?: number | null;
  category_uuid?: string | null;
  category_name_ar?: string;
  category_name_en?: string | null;
  note?: string | null;
  created_at: string;
  updated_at: string;
  cash_session_id?: number | null;
  cash_session_uuid?: string | null;
}

export interface ExpenseCategory {
  id: number;
  uuid: string;
  name_ar: string;
  name_en: string | null;
  is_system: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export type ExpensePeriod = 'all' | 'today' | 'week' | 'month';
export type ExpenseSort = 'newest' | 'oldest' | 'highest' | 'lowest';

export interface ExpenseQuery {
  search?: string;
  period?: ExpensePeriod;
  categoryUuid?: string | null;
  minAmount?: number | null;
  maxAmount?: number | null;
  sort?: ExpenseSort;
}

export interface ExpenseCategoryTotal {
  categoryId: number;
  categoryUuid: string;
  nameAr: string;
  nameEn: string | null;
  totalSyp: number;
}

export interface ExchangeRateHistoryEntry {
  id: number;
  uuid: string;
  old_rate: number;
  new_rate: number;
  created_at: string;
}

export interface CashSession {
  id: number;
  uuid: string;
  opened_at: string;
  closed_at: string | null;
  opening_cash_syp: number;
  closing_actual_cash_syp: number | null;
  closing_sales_total_syp: number | null;
  closing_refunds_total_syp: number | null;
  closing_expenses_total_syp: number | null;
  closing_expected_cash_syp: number | null;
  closing_difference_syp: number | null;
  opening_cash_usd_cents: number;
  closing_actual_cash_usd_cents: number | null;
  closing_expected_cash_usd_cents: number | null;
  closing_difference_usd_cents: number | null;
  closing_cash_received_syp: number | null;
  closing_cash_received_usd_cents: number | null;
  closing_change_given_syp: number | null;
  opening_note: string | null;
  closing_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface CashSessionSummary extends CashSession {
  sales_total_syp: number;
  invoice_count: number;
  refunds_total_syp: number;
  return_count: number;
  expenses_total_syp: number;
  expense_count: number;
  expected_cash_syp: number;
  cash_received_syp: number;
  cash_received_usd_cents: number;
  change_given_syp: number;
  expected_cash_usd_cents: number;
}

export type CashSessionHistoryRow = Pick<CashSession,
  'id' | 'uuid' | 'opened_at' | 'closed_at' | 'closing_difference_syp' | 'closing_difference_usd_cents'
>;

export type ActiveCashSessionSummary = CashSessionSummary;
export type ClosedCashSession = CashSessionSummary;

export interface CashSessionClosePreview {
  session: ActiveCashSessionSummary;
  actual_cash_syp: number;
  difference_syp: number;
}

export interface CashSessionReturnSummary extends Omit<SaleReturn, 'items'> {
  invoice_number: string;
}
