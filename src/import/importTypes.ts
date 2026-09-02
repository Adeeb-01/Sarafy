import { ExchangeRateHistoryEntry, Expense, ExpenseCategory, Product, Sale, Settings, SuspendedSale } from '@/types';

export type ImportMode = 'safe_merge' | 'selective' | 'full_restore';
export type ConflictStrategy = 'newest' | 'keep_local' | 'use_imported' | 'manual';
export type ImportEntity = 'products' | 'categories' | 'settings' | 'sales' | 'sale_items' | 'sale_returns' | 'sale_return_items' | 'expenses' | 'expense_categories' | 'exchange_rate_history' | 'product_images' | 'sale_drafts' | 'sale_draft_items';

export interface PortableSaleReturnItem {
  uuid: string; sale_item_uuid: string; quantity: number; refund_amount_syp: number;
  cost_reversal_syp: number; created_at: string; updated_at: string;
}

export interface PortableSaleReturn {
  uuid: string; sale_uuid: string; refund_total_syp: number; returned_cost_syp: number;
  created_at: string; updated_at: string; items: PortableSaleReturnItem[];
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
  expenses: Expense[];
  drafts?: SuspendedSale[];
  returns?: PortableSaleReturn[];
  expenseCategories?: ExpenseCategory[];
  exchangeRateHistory?: ExchangeRateHistoryEntry[];
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
