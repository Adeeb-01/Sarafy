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
}

export type ProductInput = Omit<Product, 'id' | 'uuid' | 'created_at' | 'updated_at' | 'is_active'>;

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
}

export type ReturnStatus = 'none' | 'partial' | 'full';

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
  items: SaleItem[];
  item_count?: number;
  line_count?: number;
  returns?: SaleReturn[];
  return_summary?: SaleReturnSummary;
}

export interface ReturnableSaleItem extends SaleItem {
  soldQuantity: number;
  returnedQuantity: number;
  remainingReturnableQuantity: number;
  lineNetRefundableSyp: number;
  previewRefundSyp: number;
}

export interface ReturnSelection { saleItemId: number; quantity: number }

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
  created_at: string;
  updated_at: string;
}
