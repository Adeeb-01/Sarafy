import { create } from 'zustand';
import { CashSessionHistoryRow, CashSessionReturnSummary, CashSessionSummary, ExchangeRateHistoryEntry, Expense, ExpenseCategory, ExpenseCategoryTotal, ExpensePeriod, ExpenseQuery, InventoryDetail, InventoryHealthReport, InventoryListItem, InventoryMetrics, InventoryQuery, InvoiceQuery, PaymentInput, Product, ProductInput, PurchaseReceipt, PurchaseReceiptInput, PurchaseReceiptQuery, PurchaseReturn, PurchaseReturnInput, PurchaseReturnQuery, ReturnSelection, Sale, SaleItemInput, SaleReturn, Settings, Supplier, SupplierAccountEntry, SupplierAccountHealthReport, SupplierAccountSummary, SupplierInput, SupplierPayment, SupplierPaymentInput, SupplierSort, SuspendedSale, SuspendedSaleSummary } from '@/types';
import * as database from '@/database/database';

const defaults: Settings = {
  exchangeRate: 15000,
  isRoundingEnabled: true,
  roundingTarget: 500,
  language: 'ar',
};

async function loadSnapshot() {
  const [products, categories, settings, sales, expenses, expenseCategories, latestRateChanges, suspendedSales, activeCashSession] = await Promise.all([
    database.getProducts(),
    database.getCategories(),
    database.loadSettings(defaults),
    database.getSales(),
    database.getExpenses(),
    database.getExpenseCategories(),
    database.getExchangeRateHistory(1),
    database.getSuspendedSaleSummaries(),
    database.getActiveCashSession(),
  ]);
  return { products, categories, sales, expenses, expenseCategories, latestRateChange: latestRateChanges[0] ?? null, suspendedSales, activeCashSession, ...settings };
}

interface AppState extends Settings {
  products: Product[];
  categories: string[];
  sales: Sale[];
  expenses: Expense[];
  expenseCategories: ExpenseCategory[];
  latestRateChange: ExchangeRateHistoryEntry | null;
  suspendedSales: SuspendedSaleSummary[];
  activeCashSession: CashSessionSummary | null;
  isReady: boolean;
  initialize: () => Promise<void>;
  refreshProducts: () => Promise<void>;
  reloadAll: () => Promise<void>;
  createProduct: (input: ProductInput) => Promise<void>;
  editProduct: (id: number, input: ProductInput) => Promise<void>;
  removeProduct: (id: number) => Promise<void>;
  createCategory: (name: string) => Promise<void>;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
  updateExchangeRate: (value: number) => Promise<ExchangeRateHistoryEntry | null>;
  getExchangeRateHistory: () => Promise<ExchangeRateHistoryEntry[]>;
  refreshSales: () => Promise<void>;
  completeSale: (items: SaleItemInput[], discountSyp?: number, payment?: PaymentInput | number, exchangeRate?: number, draftId?: number) => Promise<Sale>;
  createReturn: (saleId: number, selections: ReturnSelection[]) => Promise<SaleReturn>;
  suspendSale: (items: SaleItemInput[], discountSyp: number, exchangeRate: number, replaceDraftId?: number) => Promise<number>;
  getSuspendedSale: (id: number) => Promise<SuspendedSale | null>;
  deleteSuspendedSale: (id: number) => Promise<void>;
  refreshSuspendedSales: () => Promise<void>;
  queryInvoices: (query: InvoiceQuery) => Promise<Sale[]>;
  getInvoiceDetails: (saleId: number) => Promise<Sale | null>;
  queryExpenses: (query: ExpenseQuery) => Promise<Expense[]>;
  getExpenseTotalsByCategory: (period?: ExpensePeriod) => Promise<ExpenseCategoryTotal[]>;
  createExpense: (categoryId: number, amountSyp: number, note?: string | null) => Promise<void>;
  createExpenseCategory: (nameAr: string, nameEn?: string | null) => Promise<void>;
  renameExpenseCategory: (id: number, nameAr: string, nameEn?: string | null) => Promise<void>;
  setExpenseCategoryActive: (id: number, active: boolean) => Promise<'archived' | 'restored' | 'deleted'>;
  refreshActiveCashSession: () => Promise<void>;
  openCashSession: (openingCashSyp: number, openingCashUsdCents?: number, note?: string | null) => Promise<CashSessionSummary>;
  closeCashSession: (actualCashSyp: number, actualCashUsdCents?: number, note?: string | null) => Promise<CashSessionSummary>;
  getCashSessionHistory: (sort?: 'newest' | 'oldest') => Promise<CashSessionHistoryRow[]>;
  getCashSessionsForExport: () => Promise<CashSessionSummary[]>;
  getCashSessionDetail: (id: number) => Promise<CashSessionSummary | null>;
  getCashSessionSales: (id: number) => Promise<Sale[]>;
  getCashSessionExpenses: (id: number) => Promise<Expense[]>;
  getCashSessionReturns: (id: number) => Promise<CashSessionReturnSummary[]>;
  queryInventory: (query?: InventoryQuery) => Promise<InventoryListItem[]>;
  getInventoryMetrics: () => Promise<InventoryMetrics>;
  getInventoryDetail: (productId: number) => Promise<InventoryDetail | null>;
  enableInventoryTracking: (productId: number, openingQuantity: number, threshold: number | null, note?: string | null) => Promise<void>;
  adjustInventory: (productId: number, mode: 'stock_in' | 'stock_out' | 'physical_count', quantity: number, note?: string | null) => Promise<void>;
  updateInventoryThreshold: (productId: number, threshold: number | null) => Promise<void>;
  auditInventoryHealth: () => Promise<InventoryHealthReport>;
  getSuppliers: (search?: string, sort?: SupplierSort, includeInactive?: boolean) => Promise<Supplier[]>;
  addSupplier: (input: SupplierInput) => Promise<number>;
  updateSupplier: (id: number, input: SupplierInput) => Promise<void>;
  setSupplierActive: (id: number, active: boolean) => Promise<'archived' | 'restored'>;
  activateSupplierAccount: (id: number, openingBalanceUsdCents: number) => Promise<SupplierAccountSummary>;
  getSupplierAccountSummary: (id: number) => Promise<SupplierAccountSummary | null>;
  getSupplierAccountEntries: (id: number, type?: SupplierAccountEntry['type'] | 'all', limit?: number, from?: string) => Promise<SupplierAccountEntry[]>;
  getSupplierPayments: (id: number, limit?: number) => Promise<SupplierPayment[]>;
  getSupplierPaymentDetail: (id: number) => Promise<SupplierPayment | null>;
  createSupplierPayment: (input: SupplierPaymentInput) => Promise<SupplierPayment>;
  auditSupplierAccountHealth: () => Promise<SupplierAccountHealthReport>;
  queryPurchaseReceipts: (query?: PurchaseReceiptQuery) => Promise<PurchaseReceipt[]>;
  getPurchaseReceiptDetail: (id: number) => Promise<PurchaseReceipt | null>;
  createPurchaseReceipt: (input: PurchaseReceiptInput) => Promise<PurchaseReceipt>;
  queryPurchaseReturns: (query?: PurchaseReturnQuery) => Promise<PurchaseReturn[]>;
  getPurchaseReturnDetail: (id: number) => Promise<PurchaseReturn | null>;
  createPurchaseReturn: (input: PurchaseReturnInput) => Promise<PurchaseReturn>;
}

export const useAppStore = create<AppState>((set, get) => ({
  ...defaults,
  products: [],
  categories: [],
  sales: [],
  expenses: [],
  expenseCategories: [],
  latestRateChange: null,
  suspendedSales: [],
  activeCashSession: null,
  isReady: false,
  initialize: async () => {
    await database.initializeDatabase();
    set({ ...await loadSnapshot(), isReady: true });
  },
  refreshProducts: async () => set({ products: await database.getProducts() }),
  reloadAll: async () => set(await loadSnapshot()),
  createProduct: async input => {
    await database.addProduct(input);
    await get().refreshProducts();
  },
  editProduct: async (id, input) => {
    await database.updateProduct(id, input);
    await get().refreshProducts();
  },
  removeProduct: async id => {
    await database.deleteProduct(id);
    set({ products: get().products.filter(product => product.id !== id) });
  },
  createCategory: async name => {
    const normalized = name.trim();
    if (!normalized) return;
    await database.addCategory(normalized);
    set({ categories: await database.getCategories() });
  },
  updateSetting: async (key, value) => {
    if (key === 'exchangeRate') { await get().updateExchangeRate(value as number); return; }
    await database.saveSetting(key, value);
    set(state => ({ ...state, [key]: value }));
  },
  updateExchangeRate: async value => {
    const entry = await database.updateExchangeRate(value);
    if (entry) set({ exchangeRate: value, latestRateChange: entry });
    return entry;
  },
  getExchangeRateHistory: database.getExchangeRateHistory,
  refreshSales: async () => {
    const [sales, expenses] = await Promise.all([database.getSales(), database.getExpenses()]);
    set({ sales, expenses });
  },
  completeSale: async (items, discountSyp = 0, payment, exchangeRate = get().exchangeRate, draftId) => {
    const sale = await database.createSale(items, exchangeRate, discountSyp, payment, draftId);
    set({ products: await database.getProducts(), sales: [sale, ...get().sales], suspendedSales: draftId == null ? get().suspendedSales : get().suspendedSales.filter(draft => draft.id !== draftId), activeCashSession: await database.getActiveCashSession() });
    return sale;
  },
  createReturn: async (saleId, selections) => {
    const record = await database.createSaleReturn(saleId, selections);
    set({ products: await database.getProducts(), sales: await database.getSales(), activeCashSession: await database.getActiveCashSession() });
    return record;
  },
  suspendSale: async (items, discountSyp, exchangeRate, replaceDraftId) => {
    const id = await database.suspendSale(items, exchangeRate, discountSyp, replaceDraftId);
    set({ suspendedSales: await database.getSuspendedSaleSummaries() });
    return id;
  },
  getSuspendedSale: database.getSuspendedSale,
  deleteSuspendedSale: async id => {
    await database.deleteSuspendedSale(id);
    set({ suspendedSales: get().suspendedSales.filter(draft => draft.id !== id) });
  },
  refreshSuspendedSales: async () => set({ suspendedSales: await database.getSuspendedSaleSummaries() }),
  queryInvoices: database.queryInvoices,
  getInvoiceDetails: database.getInvoiceDetails,
  queryExpenses: database.queryExpenses,
  getExpenseTotalsByCategory: database.getExpenseTotalsByCategory,
  createExpense: async (categoryId, amountSyp, note) => {
    await database.addExpense(categoryId, amountSyp, note);
    set({ expenses: await database.getExpenses(), activeCashSession: await database.getActiveCashSession() });
  },
  createExpenseCategory: async (nameAr, nameEn) => {
    await database.addExpenseCategory(nameAr, nameEn);
    set({ expenseCategories: await database.getExpenseCategories() });
  },
  renameExpenseCategory: async (id, nameAr, nameEn) => {
    await database.renameExpenseCategory(id, nameAr, nameEn);
    set({ expenseCategories: await database.getExpenseCategories(), expenses: await database.getExpenses() });
  },
  setExpenseCategoryActive: async (id, active) => {
    const result = await database.setExpenseCategoryActive(id, active);
    set({ expenseCategories: await database.getExpenseCategories(), expenses: await database.getExpenses() });
    return result;
  },
  refreshActiveCashSession: async () => set({ activeCashSession: await database.getActiveCashSession() }),
  openCashSession: async (openingCashSyp, openingCashUsdCents, note) => {
    const session = await database.openCashSession(openingCashSyp, openingCashUsdCents, note);
    set({ activeCashSession: session });
    return session;
  },
  closeCashSession: async (actualCashSyp, actualCashUsdCents, note) => {
    const session = await database.closeCashSession(actualCashSyp, actualCashUsdCents, note);
    set({ activeCashSession: null });
    return session;
  },
  getCashSessionHistory: database.getCashSessionHistory,
  getCashSessionsForExport: database.getCashSessionsForExport,
  getCashSessionDetail: database.getCashSessionDetail,
  getCashSessionSales: database.getCashSessionSales,
  getCashSessionExpenses: database.getCashSessionExpenses,
  getCashSessionReturns: database.getCashSessionReturns,
  queryInventory: database.getInventory,
  getInventoryMetrics: database.getInventoryMetrics,
  getInventoryDetail: database.getInventoryDetail,
  enableInventoryTracking: database.enableInventoryTracking,
  adjustInventory: database.adjustInventory,
  updateInventoryThreshold: database.updateInventoryThreshold,
  auditInventoryHealth: database.auditInventoryHealth,
  getSuppliers: database.getSuppliers,
  addSupplier: database.addSupplier,
  updateSupplier: database.updateSupplier,
  setSupplierActive: database.setSupplierActive,
  activateSupplierAccount: database.activateSupplierAccount,
  getSupplierAccountSummary: database.getSupplierAccountSummary,
  getSupplierAccountEntries: database.getSupplierAccountEntries,
  getSupplierPayments: database.getSupplierPayments,
  getSupplierPaymentDetail: database.getSupplierPaymentDetail,
  createSupplierPayment: async input => {
    const payment = await database.createSupplierPayment(input);
    set({ activeCashSession: await database.getActiveCashSession() });
    return payment;
  },
  auditSupplierAccountHealth: database.auditSupplierAccountHealth,
  queryPurchaseReceipts: database.queryPurchaseReceipts,
  getPurchaseReceiptDetail: database.getPurchaseReceiptDetail,
  createPurchaseReceipt: async input => {
    const receipt = await database.createPurchaseReceipt(input);
    set({ products: await database.getProducts() });
    return receipt;
  },
  queryPurchaseReturns: database.queryPurchaseReturns,
  getPurchaseReturnDetail: database.getPurchaseReturnDetail,
  createPurchaseReturn: async input => {
    const record = await database.createPurchaseReturn(input);
    set({ products: await database.getProducts() });
    return record;
  },
}));
