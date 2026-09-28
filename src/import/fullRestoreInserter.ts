import type { SQLiteBindValue, SQLiteDatabase } from 'expo-sqlite';

import { OTHER_EXPENSE_CATEGORY_UUID } from '@/database/database';
import type { ImportEntity, ImportPayload, PortableSalePayment } from './importTypes';
import { createDeterministicUuid } from '@/utils/uuid';
import { normalizeBarcode } from '@/utils/barcode';

const MAX_BATCH_BINDINGS = 900;

type IdUuidRow = { id: number; uuid: string };

async function insertRows(
  transaction: SQLiteDatabase,
  table: string,
  columns: readonly string[],
  rows: readonly SQLiteBindValue[][],
) {
  if (!rows.length) return 0;
  const batchSize = Math.max(1, Math.floor(MAX_BATCH_BINDINGS / columns.length));
  const rowPlaceholders = `(${columns.map(() => '?').join(',')})`;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = batch.flat();
    await transaction.runAsync(
      `INSERT INTO ${table}(${columns.join(',')}) VALUES ${batch.map(() => rowPlaceholders).join(',')}`,
      values,
    );
  }
  return rows.length;
}

async function loadIdByUuid(transaction: SQLiteDatabase, table: string) {
  const rows = await transaction.getAllAsync<IdUuidRow>(`SELECT id,uuid FROM ${table}`);
  return new Map(rows.map(row => [row.uuid, row.id]));
}

function requireId(ids: ReadonlyMap<string, number>, uuid: string, error: string) {
  const id = ids.get(uuid);
  if (!id) throw new Error(error);
  return id;
}

function entitySet(entities: readonly ImportEntity[]) {
  return new Set<ImportEntity>(entities);
}

/**
 * Full restore starts from empty operational tables, so per-row existence queries
 * only add bridge traffic. This path keeps the same FK/order/invariant checks while
 * batching inserts and loading each portable UUID map once.
 */
export async function insertFullRestorePayload(
  transaction: SQLiteDatabase,
  payload: ImportPayload,
  requestedEntities: readonly ImportEntity[],
) {
  const entities = entitySet(requestedEntities);
  let inserted = 0;

  if (entities.has('cash_sessions')) {
    const sessions = payload.cashSessions ?? [];
    if (sessions.filter(session => session.closed_at == null).length > 1) throw new Error('MULTIPLE_OPEN_CASH_SESSIONS');
    inserted += await insertRows(transaction, 'cash_sessions', [
      'uuid', 'opened_at', 'closed_at', 'opening_cash_syp', 'opening_cash_usd_cents',
      'closing_actual_cash_syp', 'closing_actual_cash_usd_cents', 'closing_sales_total_syp',
      'closing_refunds_total_syp', 'closing_expenses_total_syp', 'closing_expected_cash_syp',
      'closing_difference_syp', 'closing_expected_cash_usd_cents', 'closing_difference_usd_cents',
      'closing_cash_received_syp', 'closing_cash_received_usd_cents', 'closing_change_given_syp',
      'closing_supplier_payments_syp', 'closing_supplier_payments_usd_cents',
      'closing_customer_payments_syp', 'closing_customer_payments_usd_cents',
      'opening_note', 'closing_note', 'created_at', 'updated_at',
    ], sessions.map(session => [
      session.uuid, session.opened_at, session.closed_at, session.opening_cash_syp,
      session.opening_cash_usd_cents ?? 0, session.closing_actual_cash_syp,
      session.closing_actual_cash_usd_cents ?? null, session.closing_sales_total_syp,
      session.closing_refunds_total_syp, session.closing_expenses_total_syp,
      session.closing_expected_cash_syp, session.closing_difference_syp,
      session.closing_expected_cash_usd_cents ?? null, session.closing_difference_usd_cents ?? null,
      session.closing_cash_received_syp ?? null, session.closing_cash_received_usd_cents ?? null,
      session.closing_change_given_syp ?? null, session.closing_supplier_payments_syp ?? 0, session.closing_supplier_payments_usd_cents ?? 0,
      session.closing_customer_payments_syp ?? 0, session.closing_customer_payments_usd_cents ?? 0, session.opening_note, session.closing_note,
      session.created_at, session.updated_at,
    ]));
  }
  const sessionIdByUuid = await loadIdByUuid(transaction, 'cash_sessions');
  const optionalSessionId = (uuid?: string | null) => uuid
    ? requireId(sessionIdByUuid, uuid, 'CASH_SESSION_PARENT_MISSING')
    : null;

  if (entities.has('expense_categories')) {
    inserted += await insertRows(transaction, 'expense_categories',
      ['uuid', 'name_ar', 'name_en', 'is_system', 'is_active', 'created_at', 'updated_at'],
      (payload.expenseCategories ?? []).map(item => [
        item.uuid, item.name_ar, item.name_en ?? null, item.is_system ? 1 : 0,
        item.is_active ? 1 : 0, item.created_at, item.updated_at,
      ]));
  }
  const expenseCategoryIdByUuid = await loadIdByUuid(transaction, 'expense_categories');

  if (entities.has('categories')) {
    inserted += await insertRows(transaction, 'categories', ['uuid', 'name', 'created_at', 'updated_at'],
      payload.categories.map(item => [item.uuid, item.name, item.created_at, item.updated_at]));
  }

  if (entities.has('products')) {
    inserted += await insertRows(transaction, 'products', [
      'uuid', 'name', 'category', 'price_usd', 'cost_usd', 'image_uri', 'barcode',
      'created_at', 'updated_at', 'is_active',
    ], payload.products.map(item => [
      item.uuid, item.name, item.category, item.price_usd, item.cost_usd, item.image_uri,
      normalizeBarcode(item.barcode), item.created_at, item.updated_at, item.is_active ?? 1,
    ]));
  }
  const productIdByUuid = await loadIdByUuid(transaction, 'products');
  const productUuidByImportedId = new Map(payload.products.map(product => [product.id, product.uuid]));
  const optionalProductId = (importedId: number | null | undefined) => {
    if (!importedId) return null;
    const uuid = productUuidByImportedId.get(importedId);
    return uuid ? requireId(productIdByUuid, uuid, 'PRODUCT_PARENT_MISSING') : null;
  };

  if (entities.has('suppliers')) {
    inserted += await insertRows(transaction, 'suppliers', [
      'uuid', 'name', 'phone', 'address', 'note', 'is_active', 'accounting_enabled', 'accounting_started_at', 'created_at', 'updated_at',
    ], (payload.suppliers ?? []).map(item => [
      item.uuid, item.name, item.phone, item.address, item.note, item.is_active ? 1 : 0,
      item.accounting_enabled ? 1 : 0, item.accounting_started_at ?? null, item.created_at, item.updated_at,
    ]));
  }
  const supplierIdByUuid = await loadIdByUuid(transaction, 'suppliers');

  if (entities.has('customers')) {
    inserted += await insertRows(transaction, 'customers', ['uuid','name','phone','note','is_active','accounting_enabled','accounting_started_at','created_at','updated_at'],
      (payload.customers ?? []).map(item => [item.uuid,item.name,item.phone,item.note,item.is_active ? 1 : 0,item.accounting_enabled ? 1 : 0,item.accounting_started_at ?? null,item.created_at,item.updated_at]));
  }
  const customerIdByUuid = await loadIdByUuid(transaction, 'customers');

  if (entities.has('sales')) {
    inserted += await insertRows(transaction, 'sales', [
      'uuid', 'invoice_number', 'exchange_rate', 'subtotal_syp', 'discount_syp',
      'net_total_syp', 'cost_syp', 'profit_syp', 'amount_paid_syp', 'change_syp',
      'created_at', 'updated_at', 'cash_session_id',
      'customer_id','customer_uuid_snapshot','customer_name_snapshot','on_account_syp',
    ], payload.sales.map(sale => [
      sale.uuid, sale.invoice_number, sale.exchange_rate, sale.subtotal_syp, sale.discount_syp,
      sale.net_total_syp, sale.cost_syp, sale.profit_syp, sale.amount_paid_syp ?? null,
      sale.change_syp ?? null, sale.created_at, sale.updated_at, optionalSessionId(sale.cash_session_uuid),
      sale.customer_uuid_snapshot ? requireId(customerIdByUuid, sale.customer_uuid_snapshot, 'CUSTOMER_PARENT_MISSING') : null,
      sale.customer_uuid_snapshot ?? null, sale.customer_name_snapshot ?? null, sale.on_account_syp ?? 0,
    ]));
  }
  const saleIdByUuid = await loadIdByUuid(transaction, 'sales');

  if (entities.has('sale_items')) {
    const saleItemRows: SQLiteBindValue[][] = [];
    for (const sale of payload.sales) {
      const saleId = requireId(saleIdByUuid, sale.uuid, 'SALE_PARENT_MISSING');
      for (const item of sale.items) {
        saleItemRows.push([
          item.uuid, saleId, optionalProductId(item.product_id), item.product_name,
          item.barcode_snapshot ?? null, item.quantity, item.unit_price_syp, item.unit_cost_syp,
          item.line_total_syp, item.line_cost_syp, item.created_at, item.updated_at,
        ]);
      }
    }
    inserted += await insertRows(transaction, 'sale_items', [
      'uuid', 'sale_id', 'product_id', 'product_name', 'barcode_snapshot', 'quantity',
      'unit_price_syp', 'unit_cost_syp', 'line_total_syp', 'line_cost_syp', 'created_at', 'updated_at',
    ], saleItemRows);
  }
  const saleItemIdByUuid = await loadIdByUuid(transaction, 'sale_items');

  if (entities.has('sale_payments')) {
    const payments: PortableSalePayment[] = payload.salePayments ?? payload.sales
      .filter(sale => sale.amount_paid_syp != null)
      .map(sale => ({
        uuid: createDeterministicUuid(`sale-payment:syp:${sale.uuid}`),
        sale_uuid: sale.uuid,
        currency: 'SYP',
        amount_minor: sale.amount_paid_syp!,
        syp_equivalent: sale.amount_paid_syp!,
        exchange_rate_syp_per_usd: null,
        created_at: sale.created_at,
      }));
    inserted += await insertRows(transaction, 'sale_payments', [
      'uuid', 'sale_id', 'currency', 'amount_minor', 'syp_equivalent',
      'exchange_rate_syp_per_usd', 'created_at',
    ], payments.map(payment => [
      payment.uuid, requireId(saleIdByUuid, payment.sale_uuid, 'PAYMENT_PARENT_MISSING'),
      payment.currency, payment.amount_minor, payment.syp_equivalent,
      payment.exchange_rate_syp_per_usd, payment.created_at,
    ]));
    const invalidPayments = await transaction.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM sales s
      WHERE (SELECT COALESCE(SUM(p.syp_equivalent),0) FROM sale_payments p WHERE p.sale_id=s.id)-COALESCE(s.change_syp,0)+COALESCE(s.on_account_syp,0)<>s.net_total_syp
         OR s.on_account_syp<0 OR s.on_account_syp>s.net_total_syp
         OR (s.on_account_syp>0 AND (s.customer_id IS NULL OR s.customer_uuid_snapshot IS NULL OR s.customer_name_snapshot IS NULL))`);
    if ((invalidPayments?.count ?? 0) > 0) throw new Error('PAYMENT_SETTLEMENT_CONFLICT');
  }

  if (entities.has('sale_returns')) {
    const cumulativeReturned = new Map<string, number>();
    const soldByItemUuid = new Map(payload.sales.flatMap(sale => sale.items.map(item => [item.uuid, item.quantity] as const)));
    for (const record of payload.returns ?? []) {
      if (!saleIdByUuid.has(record.sale_uuid)) throw new Error('RETURN_PARENT_MISSING');
      for (const item of record.items) {
        if (!saleItemIdByUuid.has(item.sale_item_uuid)) throw new Error('RETURN_ITEM_PARENT_MISSING');
        const next = (cumulativeReturned.get(item.sale_item_uuid) ?? 0) + item.quantity;
        if (next > (soldByItemUuid.get(item.sale_item_uuid) ?? -1)) throw new Error('RETURN_QUANTITY_EXCEEDED');
        cumulativeReturned.set(item.sale_item_uuid, next);
      }
    }
    inserted += await insertRows(transaction, 'sale_returns', [
      'uuid', 'sale_id', 'refund_total_syp', 'returned_cost_syp', 'created_at', 'updated_at', 'cash_session_id','customer_account_credit_syp',
    ], (payload.returns ?? []).map(record => [
      record.uuid, requireId(saleIdByUuid, record.sale_uuid, 'RETURN_PARENT_MISSING'),
      record.refund_total_syp, record.returned_cost_syp, record.created_at, record.updated_at,
      optionalSessionId(record.cash_session_uuid), record.customer_account_credit_syp ?? 0,
    ]));
    const invalidReturnSplits = await transaction.getFirstAsync<{ count: number }>(`SELECT COUNT(*) count FROM sale_returns r
      LEFT JOIN sales s ON s.id=r.sale_id
      WHERE r.customer_account_credit_syp<0 OR r.customer_account_credit_syp>r.refund_total_syp
         OR (r.customer_account_credit_syp>0 AND s.customer_id IS NULL)`);
    if ((invalidReturnSplits?.count ?? 0) > 0) throw new Error('CUSTOMER_RETURN_SPLIT_MISMATCH');
  }
  const saleReturnIdByUuid = await loadIdByUuid(transaction, 'sale_returns');

  if (entities.has('sale_return_items')) {
    const rows: SQLiteBindValue[][] = [];
    for (const record of payload.returns ?? []) {
      const returnId = requireId(saleReturnIdByUuid, record.uuid, 'RETURN_PARENT_MISSING');
      for (const item of record.items) {
        rows.push([
          item.uuid, returnId, requireId(saleItemIdByUuid, item.sale_item_uuid, 'RETURN_ITEM_PARENT_MISSING'),
          item.quantity, item.refund_amount_syp, item.cost_reversal_syp, item.created_at, item.updated_at,
        ]);
      }
    }
    inserted += await insertRows(transaction, 'sale_return_items', [
      'uuid', 'return_id', 'sale_item_id', 'quantity', 'refund_amount_syp', 'cost_reversal_syp',
      'created_at', 'updated_at',
    ], rows);
  }
  const saleReturnItemIdByUuid = await loadIdByUuid(transaction, 'sale_return_items');

  if (entities.has('sale_drafts')) {
    inserted += await insertRows(transaction, 'sale_drafts',
      ['uuid', 'exchange_rate', 'discount_syp', 'created_at', 'updated_at'],
      (payload.drafts ?? []).map(draft => [draft.uuid, draft.exchange_rate, draft.discount_syp, draft.created_at, draft.updated_at]));
  }
  const draftIdByUuid = await loadIdByUuid(transaction, 'sale_drafts');
  if (entities.has('sale_draft_items')) {
    const rows: SQLiteBindValue[][] = [];
    for (const draft of payload.drafts ?? []) {
      const draftId = requireId(draftIdByUuid, draft.uuid, 'DRAFT_PARENT_MISSING');
      for (const item of draft.items) {
        rows.push([
          item.uuid, draftId, optionalProductId(item.product_id), item.product_name,
          item.barcode_snapshot ?? null, item.quantity, item.unit_price_syp, item.unit_cost_syp,
          item.created_at, item.updated_at,
        ]);
      }
    }
    inserted += await insertRows(transaction, 'sale_draft_items', [
      'uuid', 'draft_id', 'product_id', 'product_name', 'barcode_snapshot', 'quantity',
      'unit_price_syp', 'unit_cost_syp', 'created_at', 'updated_at',
    ], rows);
  }

  if (entities.has('expenses')) {
    inserted += await insertRows(transaction, 'expenses', [
      'uuid', 'description', 'amount_syp', 'category_id', 'note', 'created_at', 'updated_at', 'cash_session_id',
    ], payload.expenses.map(item => {
      const categoryUuid = item.category_uuid || OTHER_EXPENSE_CATEGORY_UUID;
      return [
        item.uuid, item.description, item.amount_syp,
        requireId(expenseCategoryIdByUuid, categoryUuid, 'EXPENSE_CATEGORY_PARENT_MISSING'),
        item.note ?? null, item.created_at, item.updated_at, optionalSessionId(item.cash_session_uuid),
      ];
    }));
  }

  if (entities.has('exchange_rate_history')) {
    inserted += await insertRows(transaction, 'exchange_rate_history', ['uuid', 'old_rate', 'new_rate', 'created_at'],
      (payload.exchangeRateHistory ?? []).map(item => [item.uuid, item.old_rate, item.new_rate, item.created_at]));
  }

  if (entities.has('purchase_receipts')) {
    inserted += await insertRows(transaction, 'purchase_receipts', [
      'uuid', 'supplier_id', 'supplier_uuid_snapshot', 'supplier_name_snapshot',
      'reference_number', 'note', 'received_at', 'created_at',
    ], (payload.purchaseReceipts ?? []).map(receipt => [
      receipt.uuid,
      receipt.supplier_uuid ? requireId(supplierIdByUuid, receipt.supplier_uuid, 'PURCHASE_SUPPLIER_PARENT_MISSING') : null,
      receipt.supplier_uuid_snapshot, receipt.supplier_name_snapshot, receipt.reference_number,
      receipt.note, receipt.received_at, receipt.created_at,
    ]));
  }
  const purchaseReceiptIdByUuid = await loadIdByUuid(transaction, 'purchase_receipts');

  if (entities.has('purchase_receipt_items')) {
    const rows: SQLiteBindValue[][] = [];
    for (const receipt of payload.purchaseReceipts ?? []) {
      const receiptId = requireId(purchaseReceiptIdByUuid, receipt.uuid, 'PURCHASE_RECEIPT_PARENT_MISSING');
      for (const item of receipt.items) {
        rows.push([
          item.uuid, receiptId,
          item.product_uuid ? requireId(productIdByUuid, item.product_uuid, 'PURCHASE_PRODUCT_PARENT_MISSING') : null,
          item.product_uuid_snapshot, item.product_name_snapshot, item.barcode_snapshot,
          item.quantity, item.unit_cost_usd_cents, item.line_total_usd_cents, item.created_at,
        ]);
      }
    }
    inserted += await insertRows(transaction, 'purchase_receipt_items', [
      'uuid', 'purchase_receipt_id', 'product_id', 'product_uuid_snapshot', 'product_name_snapshot',
      'barcode_snapshot', 'quantity', 'unit_cost_usd_cents', 'line_total_usd_cents', 'created_at',
    ], rows);
  }
  const purchaseItemIdByUuid = await loadIdByUuid(transaction, 'purchase_receipt_items');

  if (entities.has('purchase_returns')) {
    inserted += await insertRows(transaction, 'purchase_returns', [
      'uuid', 'purchase_receipt_id', 'supplier_uuid_snapshot', 'supplier_name_snapshot',
      'created_at', 'total_quantity', 'total_value_usd_cents', 'reference_number', 'note',
    ], (payload.purchaseReturns ?? []).map(record => [
      record.uuid, requireId(purchaseReceiptIdByUuid, record.purchase_receipt_uuid, 'PURCHASE_RETURN_RECEIPT_PARENT_MISSING'),
      record.supplier_uuid_snapshot, record.supplier_name_snapshot, record.created_at,
      record.total_quantity, record.total_value_usd_cents, record.reference_number, record.note,
    ]));
  }
  const purchaseReturnIdByUuid = await loadIdByUuid(transaction, 'purchase_returns');

  if (entities.has('purchase_return_items')) {
    const rows: SQLiteBindValue[][] = [];
    for (const record of payload.purchaseReturns ?? []) {
      const returnId = requireId(purchaseReturnIdByUuid, record.uuid, 'PURCHASE_RETURN_PARENT_MISSING');
      for (const item of record.items) {
        rows.push([
          item.uuid, returnId,
          requireId(purchaseItemIdByUuid, item.purchase_receipt_item_uuid, 'PURCHASE_RETURN_ITEM_PARENT_MISSING'),
          item.product_uuid_snapshot, item.product_name_snapshot, item.barcode_snapshot, item.quantity,
          item.unit_cost_usd_cents, item.line_total_usd_cents, item.created_at,
        ]);
      }
    }
    inserted += await insertRows(transaction, 'purchase_return_items', [
      'uuid', 'purchase_return_id', 'purchase_receipt_item_id', 'product_uuid_snapshot',
      'product_name_snapshot', 'barcode_snapshot', 'quantity', 'unit_cost_usd_cents',
      'line_total_usd_cents', 'created_at',
    ], rows);
  }
  const purchaseReturnItemIdByUuid = await loadIdByUuid(transaction, 'purchase_return_items');

  if (entities.has('supplier_payments')) {
    inserted += await insertRows(transaction, 'supplier_payments', [
      'uuid', 'supplier_id', 'cash_session_id', 'payment_mode', 'total_usd_equivalent_cents',
      'exchange_rate_syp_per_usd', 'supplier_name_snapshot', 'note', 'occurred_at', 'created_at', 'balance_after_usd_cents',
    ], (payload.supplierPayments ?? []).map(payment => [
      payment.uuid, requireId(supplierIdByUuid, payment.supplier_uuid, 'SUPPLIER_PAYMENT_SUPPLIER_MISSING'),
      requireId(sessionIdByUuid, payment.cash_session_uuid, 'SUPPLIER_PAYMENT_SESSION_MISSING'), payment.payment_mode,
      payment.total_usd_equivalent_cents, payment.exchange_rate_syp_per_usd, payment.supplier_name_snapshot,
      payment.note, payment.occurred_at, payment.created_at, payment.balance_after_usd_cents,
    ]));
  }
  const supplierPaymentIdByUuid = await loadIdByUuid(transaction, 'supplier_payments');
  if (entities.has('supplier_payment_tenders')) {
    const tenderRows: SQLiteBindValue[][] = [];
    for (const payment of payload.supplierPayments ?? []) for (const tender of payment.tenders) tenderRows.push([
      tender.uuid, requireId(supplierPaymentIdByUuid, payment.uuid, 'SUPPLIER_PAYMENT_PARENT_MISSING'), tender.currency,
      tender.amount_minor, tender.usd_equivalent_cents, tender.exchange_rate_syp_per_usd, tender.created_at,
    ]);
    inserted += await insertRows(transaction, 'supplier_payment_tenders', [
      'uuid', 'supplier_payment_id', 'currency', 'amount_minor', 'usd_equivalent_cents', 'exchange_rate_syp_per_usd', 'created_at',
    ], tenderRows);
  }
  if (entities.has('supplier_account_entries')) {
    inserted += await insertRows(transaction, 'supplier_account_entries', [
      'uuid', 'supplier_id', 'type', 'delta_usd_cents', 'occurred_at', 'created_at', 'supplier_name_snapshot',
      'purchase_receipt_id', 'purchase_return_id', 'supplier_payment_id', 'note_snapshot',
    ], (payload.supplierAccountEntries ?? []).map(entry => [
      entry.uuid, requireId(supplierIdByUuid, entry.supplier_uuid, 'SUPPLIER_ACCOUNT_SUPPLIER_MISSING'), entry.type,
      entry.delta_usd_cents, entry.occurred_at, entry.created_at, entry.supplier_name_snapshot,
      entry.purchase_receipt_uuid ? requireId(purchaseReceiptIdByUuid, entry.purchase_receipt_uuid, 'SUPPLIER_ACCOUNT_SOURCE_MISSING') : null,
      entry.purchase_return_uuid ? requireId(purchaseReturnIdByUuid, entry.purchase_return_uuid, 'SUPPLIER_ACCOUNT_SOURCE_MISSING') : null,
      entry.supplier_payment_uuid ? requireId(supplierPaymentIdByUuid, entry.supplier_payment_uuid, 'SUPPLIER_ACCOUNT_SOURCE_MISSING') : null,
      entry.note_snapshot,
    ]));
  }
  if (entities.has('supplier_account_balances')) {
    inserted += await insertRows(transaction, 'supplier_account_balances', ['supplier_id', 'balance_usd_cents', 'updated_at'],
      (payload.supplierAccountBalances ?? []).map(balance => [requireId(supplierIdByUuid, balance.supplier_uuid, 'SUPPLIER_ACCOUNT_SUPPLIER_MISSING'), balance.balance_usd_cents, balance.updated_at]));
    const mismatch = await transaction.getFirstAsync<{ count: number }>(`SELECT COUNT(*) count FROM supplier_account_balances b
      WHERE b.balance_usd_cents<>COALESCE((SELECT SUM(delta_usd_cents) FROM supplier_account_entries e WHERE e.supplier_id=b.supplier_id),0)`);
    const incomplete = await transaction.getFirstAsync<{ count: number }>(`SELECT COUNT(*) count FROM suppliers s WHERE s.accounting_enabled=1 AND
      (NOT EXISTS(SELECT 1 FROM supplier_account_balances b WHERE b.supplier_id=s.id) OR
       1<>(SELECT COUNT(*) FROM supplier_account_entries e WHERE e.supplier_id=s.id AND e.type='opening'))`);
    if ((mismatch?.count ?? 0) > 0 || (incomplete?.count ?? 0) > 0) throw new Error('SUPPLIER_ACCOUNT_BALANCE_MISMATCH');
  }

  if (entities.has('customer_payments')) {
    inserted += await insertRows(transaction, 'customer_payments', ['uuid','customer_id','cash_session_id','payment_mode','total_syp_equivalent','exchange_rate_syp_per_usd','customer_name_snapshot','note','occurred_at','created_at','balance_after_syp'],
      (payload.customerPayments ?? []).map(payment => [payment.uuid,requireId(customerIdByUuid,payment.customer_uuid,'CUSTOMER_PAYMENT_CUSTOMER_MISSING'),requireId(sessionIdByUuid,payment.cash_session_uuid,'CUSTOMER_PAYMENT_SESSION_MISSING'),payment.payment_mode,payment.total_syp_equivalent,payment.exchange_rate_syp_per_usd,payment.customer_name_snapshot,payment.note,payment.occurred_at,payment.created_at,payment.balance_after_syp]));
  }
  const customerPaymentIdByUuid = await loadIdByUuid(transaction, 'customer_payments');
  if (entities.has('customer_payment_tenders')) {
    const rows: SQLiteBindValue[][] = [];
    for (const payment of payload.customerPayments ?? []) for (const tender of payment.tenders) rows.push([tender.uuid,requireId(customerPaymentIdByUuid,payment.uuid,'CUSTOMER_PAYMENT_PARENT_MISSING'),tender.currency,tender.amount_minor,tender.syp_equivalent,tender.exchange_rate_syp_per_usd,tender.created_at]);
    inserted += await insertRows(transaction, 'customer_payment_tenders',['uuid','customer_payment_id','currency','amount_minor','syp_equivalent','exchange_rate_syp_per_usd','created_at'],rows);
    const invalidPayments = await transaction.getFirstAsync<{ count: number }>(`SELECT COUNT(*) count FROM customer_payments p
      WHERE p.total_syp_equivalent<>COALESCE((SELECT SUM(t.syp_equivalent) FROM customer_payment_tenders t WHERE t.customer_payment_id=p.id),0)
         OR NOT EXISTS(SELECT 1 FROM customer_payment_tenders t WHERE t.customer_payment_id=p.id)`);
    const invalidTenders = await transaction.getFirstAsync<{ count: number }>(`SELECT COUNT(*) count FROM customer_payment_tenders t
      WHERE t.amount_minor<=0 OR t.syp_equivalent<=0
         OR (t.currency='SYP' AND (t.amount_minor<>t.syp_equivalent OR t.exchange_rate_syp_per_usd IS NOT NULL))
         OR (t.currency='USD' AND (t.exchange_rate_syp_per_usd IS NULL OR t.exchange_rate_syp_per_usd<=0))`);
    if ((invalidPayments?.count ?? 0) > 0 || (invalidTenders?.count ?? 0) > 0) throw new Error('CUSTOMER_PAYMENT_TENDER_MISMATCH');
  }
  if (entities.has('customer_account_entries')) {
    inserted += await insertRows(transaction, 'customer_account_entries',['uuid','customer_id','type','delta_syp','occurred_at','created_at','customer_name_snapshot','sale_id','sale_return_id','customer_payment_id','note_snapshot'],
      (payload.customerAccountEntries ?? []).map(entry => [entry.uuid,requireId(customerIdByUuid,entry.customer_uuid,'CUSTOMER_ACCOUNT_CUSTOMER_MISSING'),entry.type,entry.delta_syp,entry.occurred_at,entry.created_at,entry.customer_name_snapshot,entry.sale_uuid ? requireId(saleIdByUuid,entry.sale_uuid,'CUSTOMER_ACCOUNT_SOURCE_MISSING') : null,entry.sale_return_uuid ? requireId(saleReturnIdByUuid,entry.sale_return_uuid,'CUSTOMER_ACCOUNT_SOURCE_MISSING') : null,entry.customer_payment_uuid ? requireId(customerPaymentIdByUuid,entry.customer_payment_uuid,'CUSTOMER_ACCOUNT_SOURCE_MISSING') : null,entry.note_snapshot]));
    const invalidEntries = await transaction.getFirstAsync<{ count: number }>(`SELECT COUNT(*) count FROM customer_account_entries e
      LEFT JOIN sales s ON s.id=e.sale_id LEFT JOIN sale_returns r ON r.id=e.sale_return_id LEFT JOIN customer_payments p ON p.id=e.customer_payment_id
      WHERE (e.type='sale' AND (s.id IS NULL OR e.delta_syp<>s.on_account_syp))
         OR (e.type='sale_return' AND (r.id IS NULL OR e.delta_syp<>-r.customer_account_credit_syp))
         OR (e.type='payment' AND (p.id IS NULL OR e.delta_syp<>-p.total_syp_equivalent))`);
    const missingEntries = await transaction.getFirstAsync<{ count: number }>(`SELECT
      (SELECT COUNT(*) FROM sales s WHERE s.on_account_syp>0 AND NOT EXISTS(SELECT 1 FROM customer_account_entries e WHERE e.sale_id=s.id))
      +(SELECT COUNT(*) FROM sale_returns r WHERE r.customer_account_credit_syp>0 AND NOT EXISTS(SELECT 1 FROM customer_account_entries e WHERE e.sale_return_id=r.id))
      +(SELECT COUNT(*) FROM customer_payments p WHERE NOT EXISTS(SELECT 1 FROM customer_account_entries e WHERE e.customer_payment_id=p.id)) count`);
    if ((invalidEntries?.count ?? 0) > 0 || (missingEntries?.count ?? 0) > 0) throw new Error('CUSTOMER_ACCOUNT_SOURCE_MISMATCH');
  }
  if (entities.has('customer_account_balances')) {
    inserted += await insertRows(transaction, 'customer_account_balances',['customer_id','balance_syp','updated_at'],(payload.customerAccountBalances ?? []).map(balance => [requireId(customerIdByUuid,balance.customer_uuid,'CUSTOMER_ACCOUNT_CUSTOMER_MISSING'),balance.balance_syp,balance.updated_at]));
    const mismatch = await transaction.getFirstAsync<{ count: number }>(`SELECT COUNT(*) count FROM customer_account_balances b WHERE b.balance_syp<>COALESCE((SELECT SUM(delta_syp) FROM customer_account_entries e WHERE e.customer_id=b.customer_id),0)`);
    const incomplete = await transaction.getFirstAsync<{ count: number }>(`SELECT COUNT(*) count FROM customers c WHERE c.accounting_enabled=1 AND (NOT EXISTS(SELECT 1 FROM customer_account_balances b WHERE b.customer_id=c.id) OR 1<>(SELECT COUNT(*) FROM customer_account_entries e WHERE e.customer_id=c.id AND e.type='opening'))`);
    if ((mismatch?.count ?? 0) > 0 || (incomplete?.count ?? 0) > 0) throw new Error('CUSTOMER_ACCOUNT_BALANCE_MISMATCH');
  }

  if (entities.has('inventory_balances')) {
    inserted += await insertRows(transaction, 'inventory_balances', [
      'product_id', 'tracking_enabled', 'quantity', 'low_stock_threshold', 'created_at', 'updated_at',
    ], (payload.inventoryBalances ?? []).map(balance => [
      requireId(productIdByUuid, balance.product_uuid, 'INVENTORY_PRODUCT_PARENT_MISSING'),
      balance.tracking_enabled ? 1 : 0, balance.quantity, balance.low_stock_threshold,
      balance.created_at, balance.updated_at,
    ]));
  }

  if (entities.has('inventory_movements')) {
    inserted += await insertRows(transaction, 'inventory_movements', [
      'uuid', 'product_id', 'product_uuid_snapshot', 'product_name_snapshot', 'barcode_snapshot',
      'movement_type', 'quantity_delta', 'quantity_before', 'quantity_after', 'sale_item_id',
      'return_item_id', 'purchase_receipt_item_id', 'purchase_return_item_id', 'note', 'created_at',
    ], (payload.inventoryMovements ?? []).map(movement => [
      movement.uuid, requireId(productIdByUuid, movement.product_uuid, 'INVENTORY_MOVEMENT_PARENT_MISSING'),
      movement.product_uuid_snapshot, movement.product_name_snapshot, movement.barcode_snapshot,
      movement.movement_type, movement.quantity_delta, movement.quantity_before, movement.quantity_after,
      movement.sale_item_uuid ? requireId(saleItemIdByUuid, movement.sale_item_uuid, 'INVENTORY_MOVEMENT_PARENT_MISSING') : null,
      movement.return_item_uuid ? requireId(saleReturnItemIdByUuid, movement.return_item_uuid, 'INVENTORY_MOVEMENT_PARENT_MISSING') : null,
      movement.purchase_receipt_item_uuid ? requireId(purchaseItemIdByUuid, movement.purchase_receipt_item_uuid, 'INVENTORY_MOVEMENT_PARENT_MISSING') : null,
      movement.purchase_return_item_uuid ? requireId(purchaseReturnItemIdByUuid, movement.purchase_return_item_uuid, 'INVENTORY_MOVEMENT_PARENT_MISSING') : null,
      movement.note, movement.created_at,
    ]));
  }

  if (entities.has('settings')) {
    for (const key of ['exchangeRate', 'isRoundingEnabled', 'roundingTarget', 'language'] as const) {
      await transaction.runAsync('INSERT INTO settings(key,value) VALUES(?,?)', key, JSON.stringify(payload.settings[key]));
    }
  }

  if (entities.has('inventory_movements') && (payload.inventoryMovements?.length ?? 0) > 0) {
    const invalidLedger = await transaction.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM inventory_movements WHERE quantity_after<>quantity_before+quantity_delta');
    const invalidBalances = await transaction.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM inventory_balances b
      WHERE EXISTS(SELECT 1 FROM inventory_movements m WHERE m.product_id=b.product_id)
      AND b.quantity<>(SELECT quantity_after FROM inventory_movements m WHERE m.product_id=b.product_id ORDER BY id DESC LIMIT 1)`);
    const missingPurchases = await transaction.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM purchase_receipt_items pi
      WHERE NOT EXISTS(SELECT 1 FROM inventory_movements m WHERE m.purchase_receipt_item_id=pi.id AND m.movement_type='purchase')`);
    const missingPurchaseReturns = await transaction.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM purchase_return_items ri
      WHERE NOT EXISTS(SELECT 1 FROM inventory_movements m WHERE m.purchase_return_item_id=ri.id AND m.movement_type='purchase_return')`);
    if ((invalidLedger?.count ?? 0) || (invalidBalances?.count ?? 0) ||
        (missingPurchases?.count ?? 0) || (missingPurchaseReturns?.count ?? 0)) {
      throw new Error('INVALID_INVENTORY_LEDGER');
    }
  }

  return inserted;
}
