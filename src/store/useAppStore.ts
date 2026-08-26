import { create } from 'zustand';
import { Expense, Product, ProductInput, Sale, SaleItemInput, Settings } from '@/types';
import * as database from '@/database/database';

const defaults: Settings = {
  exchangeRate: 15000,
  isRoundingEnabled: true,
  roundingTarget: 500,
  language: 'ar',
};

async function loadSnapshot() {
  const [products, categories, settings, sales, expenses] = await Promise.all([
    database.getProducts(),
    database.getCategories(),
    database.loadSettings(defaults),
    database.getSales(),
    database.getExpenses(),
  ]);
  return { products, categories, sales, expenses, ...settings };
}

interface AppState extends Settings {
  products: Product[];
  categories: string[];
  sales: Sale[];
  expenses: Expense[];
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
  completeSale: (items: SaleItemInput[], discountSyp?: number) => Promise<Sale>;
  createExpense: (description: string, amountSyp: number) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  ...defaults,
  products: [],
  categories: [],
  sales: [],
  expenses: [],
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
  completeSale: async (items, discountSyp = 0) => {
    const sale = await database.createSale(items, get().exchangeRate, discountSyp);
    set({ sales: [sale, ...get().sales] });
    return sale;
  },
  createExpense: async (description, amountSyp) => {
    await database.addExpense(description, amountSyp);
    set({ expenses: await database.getExpenses() });
  },
}));
