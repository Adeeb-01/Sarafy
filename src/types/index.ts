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
  quantity: number;
  unit_price_syp: number;
  unit_cost_syp: number;
  line_total_syp: number;
  line_cost_syp: number;
  created_at: string;
  updated_at: string;
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
  created_at: string;
  updated_at: string;
  items: SaleItem[];
}

export interface SaleItemInput {
  productId: number;
  productName: string;
  quantity: number;
  unitPriceSyp: number;
  unitCostSyp: number;
}

export interface Expense {
  id: number;
  uuid: string;
  description: string;
  amount_syp: number;
  created_at: string;
  updated_at: string;
}
