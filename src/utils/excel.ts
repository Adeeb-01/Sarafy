import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as XLSX from 'xlsx';
import { CashSessionSummary, ExchangeRateHistoryEntry, Expense, ExpenseCategory, InventoryListItem, Product, Sale, SalePayment, Settings } from '@/types';
import { PortableInventoryMovement, PortablePurchaseReceipt, PortablePurchaseReturn, PortableSupplier, PortableSupplierAccountBalance, PortableSupplierAccountEntry, PortableSupplierPayment } from '@/import/importTypes';
import { exchangeRateChangePercent } from '@/utils/exchangeRate';
import { createDeterministicUuid, isUuid } from '@/utils/uuid';
import { isStoredProductImagePath } from '@/media/productImageStorage';
import { assertAvailableDiskSpace } from '@/utils/storageSafety';

const PRODUCTS_SHEET = 'Products';
const CATEGORIES_SHEET = 'Categories';
const SETTINGS_SHEET = 'Settings';

type ExcelImport = {
  products: Product[];
  categories: string[];
  settings: Settings;
};

type ProductRow = {
  uuid?: unknown;
  id?: unknown;
  name?: unknown;
  category?: unknown;
  price_usd?: unknown;
  cost_usd?: unknown;
  barcode?: unknown;
  image_uri?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  is_active?: unknown;
};

export async function exportExcel(
  products: Product[],
  categories: string[],
  settings: Settings,
  sales: Sale[] = [],
  expenses: Expense[] = [],
  expenseCategories: ExpenseCategory[] = [],
  exchangeRateHistory: ExchangeRateHistoryEntry[] = [],
  cashSessions: CashSessionSummary[] = [],
  salePayments: Array<Omit<SalePayment, 'id' | 'sale_id'> & { sale_uuid: string }> = [],
  inventory: InventoryListItem[] = [],
  inventoryMovements: PortableInventoryMovement[] = [],
  suppliers: PortableSupplier[] = [],
  purchaseReceipts: PortablePurchaseReceipt[] = [],
  purchaseReturns: PortablePurchaseReturn[] = [],
  supplierAccountBalances: PortableSupplierAccountBalance[] = [],
  supplierAccountEntries: PortableSupplierAccountEntry[] = [],
  supplierPayments: PortableSupplierPayment[] = [],
) {
  const workbook = XLSX.utils.book_new();
  const sessionUuidById = new Map(cashSessions.map(session => [session.id, session.uuid]));
  const productRows = products.map(product => ({
    uuid: product.uuid,
    id: product.id,
    name: product.name,
    category: product.category,
    price_usd: product.price_usd,
    cost_usd: product.cost_usd,
    barcode: product.barcode ?? '',
    image_uri: product.image_uri ?? '',
    created_at: product.created_at,
    updated_at: product.updated_at,
    is_active: product.is_active,
  }));
  const productSheet = XLSX.utils.json_to_sheet(productRows, {
    header: ['uuid', 'id', 'name', 'category', 'price_usd', 'cost_usd', 'barcode', 'image_uri', 'created_at', 'updated_at', 'is_active'],
  });
  productSheet['!cols'] = [
    { wch: 10 }, { wch: 30 }, { wch: 22 }, { wch: 14 },
    { wch: 14 }, { wch: 20 }, { wch: 36 }, { wch: 24 },
  ];
  productSheet['!autofilter'] = { ref: `A1:K${Math.max(products.length + 1, 2)}` };

  const categorySheet = XLSX.utils.json_to_sheet(
    categories.map(name => ({ category: name })),
    { header: ['category'] },
  );
  categorySheet['!cols'] = [{ wch: 30 }];

  const settingSheet = XLSX.utils.aoa_to_sheet([
    ['setting', 'value'],
    ['exchange_rate', settings.exchangeRate],
    ['is_rounding_enabled', settings.isRoundingEnabled],
    ['rounding_target', settings.roundingTarget],
    ['language', settings.language],
  ]);
  settingSheet['!cols'] = [{ wch: 24 }, { wch: 20 }];

  XLSX.utils.book_append_sheet(workbook, productSheet, PRODUCTS_SHEET);
  XLSX.utils.book_append_sheet(workbook, categorySheet, CATEGORIES_SHEET);
  XLSX.utils.book_append_sheet(workbook, settingSheet, SETTINGS_SHEET);
  const salesSheet = XLSX.utils.json_to_sheet(sales.map(sale => ({
    invoice_number: sale.invoice_number,
    created_at: sale.created_at,
    exchange_rate: sale.exchange_rate,
    subtotal_syp: sale.subtotal_syp,
    discount_syp: sale.discount_syp,
    net_total_syp: sale.net_total_syp,
    amount_paid_syp: sale.amount_paid_syp,
    change_syp: sale.change_syp,
    cost_syp: sale.cost_syp,
    gross_profit_syp: sale.profit_syp,
    cash_session_uuid: sale.cash_session_uuid ?? (sale.cash_session_id ? sessionUuidById.get(sale.cash_session_id) : '') ?? '',
  })));
  salesSheet['!cols'] = [{ wch: 24 }, { wch: 24 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 16 }, { wch: 16 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(workbook, salesSheet, 'Sales');
  const saleItemsSheet = XLSX.utils.json_to_sheet(sales.flatMap(sale => sale.items.map(item => ({
    invoice_number: sale.invoice_number,
    product_name: item.product_name,
    barcode_snapshot: item.barcode_snapshot,
    quantity: item.quantity,
    unit_price_syp: item.unit_price_syp,
    line_total_syp: item.line_total_syp,
    unit_cost_syp: item.unit_cost_syp,
    line_cost_syp: item.line_cost_syp,
  }))));
  saleItemsSheet['!cols'] = [{ wch: 24 }, { wch: 30 }, { wch: 22 }, { wch: 12 }, { wch: 17 }, { wch: 17 }, { wch: 17 }, { wch: 17 }];
  XLSX.utils.book_append_sheet(workbook, saleItemsSheet, 'Sale Items');
  const salePaymentsSheet = XLSX.utils.json_to_sheet(salePayments.map(payment => ({ payment_uuid: payment.uuid, sale_uuid: payment.sale_uuid, currency: payment.currency, amount_minor: payment.amount_minor, display_amount: payment.currency === 'USD' ? `${Math.floor(payment.amount_minor / 100)}.${String(payment.amount_minor % 100).padStart(2, '0')} USD` : `${payment.amount_minor} SYP`, syp_equivalent: payment.syp_equivalent, exchange_rate: payment.exchange_rate_syp_per_usd ?? '' })));
  salePaymentsSheet['!cols'] = [{ wch: 38 }, { wch: 38 }, { wch: 12 }, { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(workbook, salePaymentsSheet, 'Sale Payments');
  const returns = sales.flatMap(sale => (sale.returns ?? []).map(record => ({ sale, record })));
  const returnsSheet = XLSX.utils.json_to_sheet(returns.map(({ sale, record }) => ({
    return_uuid: record.uuid, original_invoice_number: sale.invoice_number, return_date: record.created_at,
    refund_total_syp: record.refund_total_syp, returned_cost_syp: record.returned_cost_syp,
    cash_session_uuid: record.cash_session_uuid ?? (record.cash_session_id ? sessionUuidById.get(record.cash_session_id) : null) ?? '',
  })));
  returnsSheet['!cols'] = [{ wch: 38 }, { wch: 25 }, { wch: 24 }, { wch: 20 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(workbook, returnsSheet, 'Returns');
  const returnItemsSheet = XLSX.utils.json_to_sheet(returns.flatMap(({ sale, record }) => record.items.map(item => ({
    return_uuid: record.uuid, original_invoice_number: sale.invoice_number, product_name: item.product_name,
    barcode_snapshot: item.barcode_snapshot, quantity: item.quantity, refund_amount_syp: item.refund_amount_syp,
  }))));
  returnItemsSheet['!cols'] = [{ wch: 38 }, { wch: 25 }, { wch: 30 }, { wch: 22 }, { wch: 12 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(workbook, returnItemsSheet, 'Return Items');
  const expensesSheet = XLSX.utils.json_to_sheet(expenses.map(expense => ({
    description: expense.description,
    category_uuid: expense.category_uuid ?? '',
    category_ar: expense.category_name_ar ?? '',
    category_en: expense.category_name_en ?? '',
    note: expense.note ?? '',
    amount_syp: expense.amount_syp,
    created_at: expense.created_at,
    cash_session_uuid: expense.cash_session_uuid ?? (expense.cash_session_id ? sessionUuidById.get(expense.cash_session_id) : '') ?? '',
  })));
  expensesSheet['!cols'] = [{ wch: 34 }, { wch: 38 }, { wch: 24 }, { wch: 24 }, { wch: 38 }, { wch: 18 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(workbook, expensesSheet, 'Expenses');
  const expenseCategoriesSheet = XLSX.utils.json_to_sheet(expenseCategories.map(category => ({ uuid: category.uuid, name_ar: category.name_ar, name_en: category.name_en ?? '', is_system: category.is_system, is_active: category.is_active, created_at: category.created_at, updated_at: category.updated_at })));
  expenseCategoriesSheet['!cols'] = [{ wch: 38 }, { wch: 28 }, { wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 24 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(workbook, expenseCategoriesSheet, 'Expense Categories');
  const rateHistorySheet = XLSX.utils.json_to_sheet(exchangeRateHistory.map(entry => ({ date: entry.created_at, old_rate: entry.old_rate, new_rate: entry.new_rate, change_percent: exchangeRateChangePercent(entry.old_rate, entry.new_rate) })));
  rateHistorySheet['!cols'] = [{ wch: 24 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(workbook, rateHistorySheet, 'Exchange Rate History');
  const cashSessionsSheet = XLSX.utils.json_to_sheet(cashSessions.map(session => ({
    uuid: session.uuid, opened_at: session.opened_at, closed_at: session.closed_at ?? '', opening_cash_syp: session.opening_cash_syp,
    sales_total_syp: session.closed_at ? session.closing_sales_total_syp : session.sales_total_syp,
    refunds_total_syp: session.closed_at ? session.closing_refunds_total_syp : session.refunds_total_syp,
    expenses_total_syp: session.closed_at ? session.closing_expenses_total_syp : session.expenses_total_syp,
    expected_cash_syp: session.closed_at ? session.closing_expected_cash_syp : session.expected_cash_syp,
    actual_cash_syp: session.closing_actual_cash_syp ?? '', difference_syp: session.closing_difference_syp ?? '',
    opening_cash_usd_cents: session.opening_cash_usd_cents,
    cash_received_usd_cents: session.closed_at ? (session.closing_cash_received_usd_cents ?? '') : session.cash_received_usd_cents,
    expected_cash_usd_cents: session.closed_at ? (session.closing_expected_cash_usd_cents ?? '') : session.expected_cash_usd_cents,
    actual_cash_usd_cents: session.closing_actual_cash_usd_cents ?? '', difference_usd_cents: session.closing_difference_usd_cents ?? '',
    supplier_payments_syp: session.closed_at ? session.closing_supplier_payments_syp : session.supplier_payments_syp,
    supplier_payments_usd_cents: session.closed_at ? session.closing_supplier_payments_usd_cents : session.supplier_payments_usd_cents,
    invoice_count: session.invoice_count, return_count: session.return_count, expense_count: session.expense_count,
    opening_note: session.opening_note ?? '', closing_note: session.closing_note ?? '',
  })));
  cashSessionsSheet['!cols'] = [{ wch: 38 }, { wch: 24 }, { wch: 24 }, ...Array.from({ length: 16 }, () => ({ wch: 20 }))];
  XLSX.utils.book_append_sheet(workbook, cashSessionsSheet, 'Cash Sessions');
  const inventorySheet = XLSX.utils.json_to_sheet(inventory.map(item => ({ product_uuid: item.product_uuid, product_name: item.product_name, barcode: item.barcode ?? '', quantity: item.quantity, low_stock_threshold: item.low_stock_threshold ?? '', status: item.status, active: item.is_active })));
  inventorySheet['!cols'] = [{ wch: 38 }, { wch: 30 }, { wch: 22 }, { wch: 14 }, { wch: 20 }, { wch: 18 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(workbook, inventorySheet, 'Inventory');
  const movementSheet = XLSX.utils.json_to_sheet(inventoryMovements.map(item => ({ movement_uuid: item.uuid, product_uuid: item.product_uuid_snapshot, product_name: item.product_name_snapshot, barcode: item.barcode_snapshot ?? '', type: item.movement_type, quantity_delta: item.quantity_delta, quantity_before: item.quantity_before, quantity_after: item.quantity_after, note: item.note ?? '', created_at: item.created_at })));
  movementSheet['!cols'] = [{ wch: 38 }, { wch: 38 }, { wch: 30 }, { wch: 22 }, { wch: 15 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 36 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(workbook, movementSheet, 'Inventory Movements');
  const supplierSheet = XLSX.utils.json_to_sheet(suppliers.map(item => ({ supplier_uuid: item.uuid, name: item.name, phone: item.phone ?? '', address: item.address ?? '', note: item.note ?? '', active: item.is_active, created_at: item.created_at, updated_at: item.updated_at })));
  supplierSheet['!cols'] = [{ wch: 38 }, { wch: 30 }, { wch: 20 }, { wch: 40 }, { wch: 40 }, { wch: 10 }, { wch: 24 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(workbook, supplierSheet, 'Suppliers');
  const receiptSheet = XLSX.utils.json_to_sheet(purchaseReceipts.map(item => ({ receipt_uuid: item.uuid, supplier_uuid: item.supplier_uuid ?? '', supplier_snapshot: item.supplier_name_snapshot, reference: item.reference_number ?? '', date: item.received_at, note: item.note ?? '', total_quantity: item.items.reduce((sum, line) => sum + line.quantity, 0), total_cost_usd_cents: item.items.reduce((sum, line) => sum + line.line_total_usd_cents, 0) })));
  receiptSheet['!cols'] = [{ wch: 38 }, { wch: 38 }, { wch: 30 }, { wch: 24 }, { wch: 24 }, { wch: 40 }, { wch: 16 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(workbook, receiptSheet, 'Purchase Receipts');
  const receiptItemSheet = XLSX.utils.json_to_sheet(purchaseReceipts.flatMap(receipt => receipt.items.map(item => ({ item_uuid: item.uuid, receipt_uuid: receipt.uuid, product_uuid: item.product_uuid ?? '', product_snapshot: item.product_name_snapshot, barcode_snapshot: item.barcode_snapshot ?? '', quantity: item.quantity, unit_cost_usd_cents: item.unit_cost_usd_cents, line_total_usd_cents: item.line_total_usd_cents }))));
  receiptItemSheet['!cols'] = [{ wch: 38 }, { wch: 38 }, { wch: 38 }, { wch: 30 }, { wch: 22 }, { wch: 14 }, { wch: 22 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(workbook, receiptItemSheet, 'Purchase Receipt Items');
  const purchaseReturnSheet = XLSX.utils.json_to_sheet(purchaseReturns.map(record => ({ return_uuid: record.uuid, original_receipt_uuid: record.purchase_receipt_uuid, supplier_uuid: record.supplier_uuid_snapshot, supplier_snapshot: record.supplier_name_snapshot, date: record.created_at, reference: record.reference_number ?? '', total_quantity: record.total_quantity, total_historical_value_usd_cents: record.total_value_usd_cents })));
  purchaseReturnSheet['!cols'] = [{ wch: 38 }, { wch: 38 }, { wch: 38 }, { wch: 30 }, { wch: 24 }, { wch: 24 }, { wch: 16 }, { wch: 28 }];
  XLSX.utils.book_append_sheet(workbook, purchaseReturnSheet, 'Purchase Returns');
  const purchaseReturnItemSheet = XLSX.utils.json_to_sheet(purchaseReturns.flatMap(record => record.items.map(item => ({ item_uuid: item.uuid, return_uuid: record.uuid, purchase_item_uuid: item.purchase_receipt_item_uuid, product_uuid: item.product_uuid_snapshot, product_snapshot: item.product_name_snapshot, quantity: item.quantity, unit_cost_usd_cents: item.unit_cost_usd_cents, line_value_usd_cents: item.line_total_usd_cents }))));
  purchaseReturnItemSheet['!cols'] = [{ wch: 38 }, { wch: 38 }, { wch: 38 }, { wch: 38 }, { wch: 30 }, { wch: 14 }, { wch: 22 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(workbook, purchaseReturnItemSheet, 'Purchase Return Items');
  const supplierAccountsSheet = XLSX.utils.json_to_sheet(supplierAccountBalances.map(balance => ({ supplier_uuid: balance.supplier_uuid, balance_usd_cents: balance.balance_usd_cents, updated_at: balance.updated_at })));
  supplierAccountsSheet['!cols'] = [{ wch: 38 }, { wch: 24 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(workbook, supplierAccountsSheet, 'Supplier Accounts');
  const supplierEntriesSheet = XLSX.utils.json_to_sheet(supplierAccountEntries.map(entry => ({ entry_uuid: entry.uuid, supplier_uuid: entry.supplier_uuid, type: entry.type, delta_usd_cents: entry.delta_usd_cents, occurred_at: entry.occurred_at, supplier_snapshot: entry.supplier_name_snapshot, purchase_receipt_uuid: entry.purchase_receipt_uuid ?? '', purchase_return_uuid: entry.purchase_return_uuid ?? '', supplier_payment_uuid: entry.supplier_payment_uuid ?? '', note_snapshot: entry.note_snapshot ?? '' })));
  supplierEntriesSheet['!cols'] = Array.from({ length: 10 }, () => ({ wch: 30 }));
  XLSX.utils.book_append_sheet(workbook, supplierEntriesSheet, 'Supplier Account Entries');
  const supplierPaymentsSheet = XLSX.utils.json_to_sheet(supplierPayments.map(payment => ({ payment_uuid: payment.uuid, supplier_uuid: payment.supplier_uuid, cash_session_uuid: payment.cash_session_uuid, mode: payment.payment_mode, total_usd_equivalent_cents: payment.total_usd_equivalent_cents, exchange_rate: payment.exchange_rate_syp_per_usd ?? '', supplier_snapshot: payment.supplier_name_snapshot, note: payment.note ?? '', occurred_at: payment.occurred_at, balance_after_usd_cents: payment.balance_after_usd_cents })));
  supplierPaymentsSheet['!cols'] = Array.from({ length: 10 }, () => ({ wch: 28 }));
  XLSX.utils.book_append_sheet(workbook, supplierPaymentsSheet, 'Supplier Payments');
  const supplierTenderSheet = XLSX.utils.json_to_sheet(supplierPayments.flatMap(payment => payment.tenders.map(tender => ({ tender_uuid: tender.uuid, payment_uuid: payment.uuid, currency: tender.currency, amount_minor: tender.amount_minor, usd_equivalent_cents: tender.usd_equivalent_cents, exchange_rate: tender.exchange_rate_syp_per_usd ?? '', created_at: tender.created_at }))));
  supplierTenderSheet['!cols'] = Array.from({ length: 7 }, () => ({ wch: 28 }));
  XLSX.utils.book_append_sheet(workbook, supplierTenderSheet, 'Supplier Payment Tenders');

  const filename = `sarafy-products-${new Date().toISOString().slice(0, 10)}.xlsx`;
  const uri = `${FileSystem.cacheDirectory}${filename}`;
  const base64 = XLSX.write(workbook, { bookType: 'xlsx', type: 'base64' });
  assertAvailableDiskSpace(Math.ceil(base64.length * 0.75));
  await FileSystem.writeAsStringAsync(uri, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      dialogTitle: filename,
      UTI: 'org.openxmlformats.spreadsheetml.sheet',
    });
  }
  return uri;
}

export async function pickExcel(currentSettings: Settings): Promise<ExcelImport | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ],
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets[0]) return null;
  const uri = result.assets[0].uri;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists || ('size' in info ? info.size : 0) > 25 * 1024 * 1024) throw new Error('EXCEL_FILE_TOO_LARGE');
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const workbook = XLSX.read(base64, { type: 'base64' });
    const firstSheetName = workbook.SheetNames[0];
    const productsSheet = workbook.Sheets[PRODUCTS_SHEET]
      ?? (firstSheetName ? workbook.Sheets[firstSheetName] : undefined);
    if (!productsSheet) throw new Error('EXCEL_PRODUCTS_SHEET_MISSING');

    const rows = XLSX.utils.sheet_to_json<ProductRow>(productsSheet, {
      defval: '',
      raw: true,
    });
    const products = normalizeProducts(rows);
    const categories = readCategories(workbook, products);
    const settings = readSettings(workbook, currentSettings);
    return { products, categories, settings };
  } finally {
    if (FileSystem.cacheDirectory && uri.startsWith(FileSystem.cacheDirectory)) {
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
    }
  }
}

function normalizeProducts(rows: ProductRow[]): Product[] {
  const now = new Date().toISOString();
  const usedIds = new Set<number>();
  let nextId = rows.reduce((max, row) => {
    const id = toPositiveInteger(row.id);
    return id ? Math.max(max, id) : max;
  }, 0) + 1;

  return rows
    .filter(row => String(row.name ?? '').trim() || String(row.category ?? '').trim())
    .map((row, index) => {
      const name = String(row.name ?? '').trim();
      const category = String(row.category ?? '').trim();
      const price = toFiniteNumber(row.price_usd);
      const cost = toFiniteNumber(row.cost_usd) ?? 0;
      if (!name || !category || price === null || price < 0 || cost < 0) {
        throw new Error(`INVALID_EXCEL_PRODUCT_ROW_${index + 2}`);
      }

      let id = toPositiveInteger(row.id);
      if (!id || usedIds.has(id)) {
        while (usedIds.has(nextId)) nextId += 1;
        id = nextId++;
      }
      usedIds.add(id);

      return {
        id,
        uuid: isUuid(row.uuid) ? row.uuid : createDeterministicUuid(
          optionalText(row.barcode) ? `excel:barcode:${optionalText(row.barcode)}` : `excel:product:${id}:${name}:${category}`,
        ),
        name,
        category,
        price_usd: price,
        cost_usd: cost,
        barcode: optionalText(row.barcode),
        image_uri: safeRelativeImagePath(row.image_uri),
        created_at: validDateText(row.created_at) ?? now,
        updated_at: validDateText(row.updated_at) ?? validDateText(row.created_at) ?? now,
        is_active: toBoolean(row.is_active) === false ? 0 : 1,
      };
    });
}

function readCategories(workbook: XLSX.WorkBook, products: Product[]) {
  const sheet = workbook.Sheets[CATEGORIES_SHEET];
  const stored = sheet
    ? XLSX.utils.sheet_to_json<{ category?: unknown }>(sheet, { defval: '' })
      .map(row => String(row.category ?? '').trim())
      .filter(Boolean)
    : [];
  return Array.from(new Set([...stored, ...products.map(product => product.category)]));
}

function readSettings(workbook: XLSX.WorkBook, fallback: Settings): Settings {
  const sheet = workbook.Sheets[SETTINGS_SHEET];
  if (!sheet) return fallback;
  const entries = XLSX.utils.sheet_to_json<{ setting?: unknown; value?: unknown }>(sheet, {
    defval: '',
  });
  const values = Object.fromEntries(
    entries.map(row => [String(row.setting ?? '').trim(), row.value]),
  );
  const exchangeRate = toFiniteNumber(values.exchange_rate);
  const roundingTarget = toFiniteNumber(values.rounding_target);
  return {
    exchangeRate: exchangeRate && exchangeRate > 0 ? exchangeRate : fallback.exchangeRate,
    isRoundingEnabled: toBoolean(values.is_rounding_enabled) ?? fallback.isRoundingEnabled,
    roundingTarget: roundingTarget === 5 || roundingTarget === 10 ||
      roundingTarget === 500 || roundingTarget === 1000
      ? roundingTarget
      : fallback.roundingTarget,
    language: values.language === 'ar' || values.language === 'en'
      ? values.language
      : fallback.language,
  };
}

function optionalText(value: unknown) {
  const text = String(value ?? '').trim();
  return text || null;
}

function safeRelativeImagePath(value: unknown) {
  const text = optionalText(value);
  return isStoredProductImagePath(text) ? text : null;
}

function toFiniteNumber(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const normalized = String(value ?? '').trim().replace(/,/g, '');
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function toPositiveInteger(value: unknown) {
  const number = toFiniteNumber(value);
  return number && Number.isInteger(number) && number > 0 ? number : null;
}

function toBoolean(value: unknown) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function validDateText(value: unknown) {
  const text = String(value ?? '').trim();
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}
