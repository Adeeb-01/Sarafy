import { create } from 'zustand';
import { Expense, InvoiceQuery, Product, ProductInput, Sale, SaleItemInput, Settings, SuspendedSale, SuspendedSaleSummary } from '@/types';
import * as database from '@/database/database';

const defaults: Settings = {
  exchangeRate: 15000,
  isRoundingEnabled: true,
  roundingTarget: 500,
  language: 'ar',
};

async function loadSnapshot() {
  const [products, categories, settings, sales, expenses, suspendedSales] = await Promise.all([
    database.getProducts(),
    database.getCategories(),
    database.loadSettings(defaults),
    database.getSales(),
    database.getExpenses(),
    database.getSuspendedSaleSummaries(),
  ]);
  return { products, categories, sales, expenses, suspendedSales, ...settings };
}

interface AppState extends Settings {
  products: Product[];
  categories: string[];
  sales: Sale[];
  expenses: Expense[];
  suspendedSales: SuspendedSaleSummary[];
  isReady: boolean;
  initialize: () => Promise<void>;
  refreshProducts: () => Promise<void>;
  reloadAll: () => Promise<void>;
  createProduct: (input: ProductInput) => Promise<void>;
  editProduct: (id: number, input: ProductInput) => Promise<void>;
  removeProduct: (id: number) => Promise<void>;
  createCategory: (name: string) => Promise<void>;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
  refreshSales: () => Promise<void>;
  completeSale: (items: SaleItemInput[], discountSyp?: number, amountPaidSyp?: number, exchangeRate?: number, draftId?: number) => Promise<Sale>;
  suspendSale: (items: SaleItemInput[], discountSyp: number, exchangeRate: number, replaceDraftId?: number) => Promise<number>;
  getSuspendedSale: (id: number) => Promise<SuspendedSale | null>;
  deleteSuspendedSale: (id: number) => Promise<void>;
  refreshSuspendedSales: () => Promise<void>;
  queryInvoices: (query: InvoiceQuery) => Promise<Sale[]>;
  createExpense: (description: string, amountSyp: number) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  ...defaults,
  products: [],
  categories: [],
  sales: [],
  expenses: [],
  suspendedSales: [],
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
    set(state => ({ ...state, [key]: value }));
    await database.saveSetting(key, value);
  },
  refreshSales: async () => {
    const [sales, expenses] = await Promise.all([database.getSales(), database.getExpenses()]);
    set({ sales, expenses });
  },
  completeSale: async (items, discountSyp = 0, amountPaidSyp, exchangeRate = get().exchangeRate, draftId) => {
    const sale = await database.createSale(items, exchangeRate, discountSyp, amountPaidSyp, draftId);
    set({ sales: [sale, ...get().sales], suspendedSales: draftId == null ? get().suspendedSales : get().suspendedSales.filter(draft => draft.id !== draftId) });
    return sale;
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
  createExpense: async (description, amountSyp) => {
    await database.addExpense(description, amountSyp);
    set({ expenses: await database.getExpenses() });
  },
}));
