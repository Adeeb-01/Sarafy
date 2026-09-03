import { getDatabase, OTHER_EXPENSE_CATEGORY_UUID } from '@/database/database';
import { ImportIssue, ImportOptions, ImportPayload, ImportPreview } from './importTypes';
import { isUuid } from '@/utils/uuid';
import { normalizeBarcode } from '@/utils/barcode';

const emptySummary = () => ({
  newRecords: 0, updatedRecords: 0, unchangedRecords: 0, conflicts: 0,
  duplicates: 0, invalidRecords: 0, newImages: 0, missingImages: 0, replacedImages: 0,
});

function comparable(value: object) {
  const copy = { ...value } as Record<string, unknown>;
  delete copy.id;
  delete copy.updated_at;
  return JSON.stringify(copy);
}

export async function analyzeImport(payload: ImportPayload, options: ImportOptions): Promise<ImportPreview> {
  const db = await getDatabase();
  const summary = emptySummary();
  const issues: ImportIssue[] = [];
  const localCashSessions = await db.getAllAsync<Record<string, unknown> & { uuid: string }>('SELECT * FROM cash_sessions');
  const localSessionByUuid = new Map(localCashSessions.map(row => [row.uuid, row]));
  const localSessions = new Set(localSessionByUuid.keys());
  const importableSessions = new Set<string>();
  if (options.entities.includes('cash_sessions')) {
    const localSessionRows = new Set(localSessions);
    const seenSessions = new Set<string>();
    for (const [index, session] of (payload.cashSessions ?? []).entries()) {
      if (seenSessions.has(session.uuid)) {
        summary.duplicates += 1; issues.push({ entity: 'cash_sessions', row: index + 1, field: 'uuid', value: session.uuid, code: 'DUPLICATE_UUID', action: 'rejected' });
      } else if (options.mode === 'full_restore') {
        summary.newRecords += 1; importableSessions.add(session.uuid);
      } else if (session.closed_at == null) {
        summary.conflicts += 1; issues.push({ entity: 'cash_sessions', row: index + 1, code: 'OPEN_CASH_SESSION_CONFLICT', action: 'review' });
      } else if (localSessionRows.has(session.uuid)) {
        if (comparable(localSessionByUuid.get(session.uuid)!) === comparable(session)) summary.unchangedRecords += 1;
        else { summary.conflicts += 1; issues.push({ entity: 'cash_sessions', row: index + 1, code: 'CASH_SESSION_CONFLICT', action: 'review' }); }
      }
      else { summary.newRecords += 1; importableSessions.add(session.uuid); }
      seenSessions.add(session.uuid);
    }
  }
  const knownSession = (uuid: string | null | undefined) => !uuid || localSessions.has(uuid) || importableSessions.has(uuid) || (options.mode === 'full_restore' && (payload.cashSessions ?? []).some(session => session.uuid === uuid));
  payload.sales.forEach((sale, index) => { if (!knownSession(sale.cash_session_uuid)) { summary.conflicts += 1; issues.push({ entity: 'sales', row: index + 1, field: 'cash_session_uuid', value: sale.cash_session_uuid ?? '', code: 'CASH_SESSION_PARENT_MISSING', action: 'review' }); } });
  payload.expenses.forEach((expense, index) => { if (!knownSession(expense.cash_session_uuid)) { summary.conflicts += 1; issues.push({ entity: 'expenses', row: index + 1, field: 'cash_session_uuid', value: expense.cash_session_uuid ?? '', code: 'CASH_SESSION_PARENT_MISSING', action: 'review' }); } });
  (payload.returns ?? []).forEach((record, index) => { if (!knownSession(record.cash_session_uuid)) { summary.conflicts += 1; issues.push({ entity: 'sale_returns', row: index + 1, field: 'cash_session_uuid', value: record.cash_session_uuid ?? '', code: 'CASH_SESSION_PARENT_MISSING', action: 'review' }); } });
  const analyze = async (entity: 'products' | 'sales' | 'expenses', records: Array<{ uuid: string; updated_at: string }>) => {
    if (!options.entities.includes(entity)) return;
    const local = await db.getAllAsync<Record<string, unknown> & { uuid: string; updated_at: string }>(`SELECT * FROM ${entity}`);
    const byUuid = new Map(local.map(row => [row.uuid, row]));
    const seen = new Set<string>();
    records.forEach((record, index) => {
      if (!isUuid(record.uuid)) {
        summary.invalidRecords += 1;
        issues.push({ entity, row: index + 1, field: 'uuid', value: String(record.uuid), code: 'INVALID_UUID', action: 'rejected' });
        return;
      }
      if (seen.has(record.uuid)) {
        summary.duplicates += 1;
        issues.push({ entity, row: index + 1, field: 'uuid', value: record.uuid, code: 'DUPLICATE_UUID', action: 'skipped' });
        return;
      }
      seen.add(record.uuid);
      const existing = byUuid.get(record.uuid);
      if (!existing) { summary.newRecords += 1; return; }
      if (comparable(existing) === comparable(record)) { summary.unchangedRecords += 1; return; }
      if (options.conflictStrategy === 'manual' || (
        options.conflictStrategy === 'newest' &&
        (!record.updated_at || !existing.updated_at)
      )) {
        summary.conflicts += 1;
        issues.push({ entity, row: index + 1, code: 'REVIEW_REQUIRED', action: 'review' });
      } else summary.updatedRecords += 1;
    });
  };
  if (options.entities.includes('products')) {
    const localProducts = await db.getAllAsync<Record<string, unknown> & { uuid: string; barcode: string | null; updated_at: string }>('SELECT * FROM products');
    const byUuid = new Map(localProducts.map(row => [row.uuid, row]));
    const byBarcode = new Map(localProducts.flatMap(row => { const barcode = normalizeBarcode(row.barcode); return barcode ? [[barcode, row] as const] : []; }));
    const seen = new Set<string>();
    payload.products.forEach((product, index) => {
      if (!isUuid(product.uuid)) {
        summary.invalidRecords += 1;
        issues.push({ entity: 'products', row: index + 1, field: 'uuid', code: 'INVALID_UUID', action: 'rejected' });
        return;
      }
      if (seen.has(product.uuid)) {
        summary.duplicates += 1;
        issues.push({ entity: 'products', row: index + 1, field: 'uuid', code: 'DUPLICATE_UUID', action: 'rejected' });
        return;
      }
      seen.add(product.uuid);
      const barcode = normalizeBarcode(product.barcode);
      const existingByUuid = byUuid.get(product.uuid);
      const existingByBarcode = barcode ? byBarcode.get(barcode) : undefined;
      if (existingByUuid && existingByBarcode && existingByUuid.uuid !== existingByBarcode.uuid) {
        summary.conflicts += 1;
        issues.push({ entity: 'products', row: index + 1, field: 'barcode', value: barcode ?? '', code: 'DUPLICATE_BARCODE', action: 'review' });
        return;
      }
      const existing = existingByUuid ?? existingByBarcode;
      if (!existing) summary.newRecords += 1;
      else if (comparable(existing) === comparable(product)) summary.unchangedRecords += 1;
      else if (options.conflictStrategy === 'manual' ||
        (options.conflictStrategy === 'newest' &&
          (!Number.isFinite(Date.parse(product.updated_at)) || !Number.isFinite(Date.parse(existing.updated_at))))) {
        summary.conflicts += 1;
        issues.push({ entity: 'products', row: index + 1, code: 'REVIEW_REQUIRED', action: 'review' });
      } else summary.updatedRecords += 1;
    });
  }
  const barcodeRows = payload.products.map((product, index) => ({ product, index, barcode: normalizeBarcode(product.barcode) })).filter(row => !!row.barcode);
  const barcodeCounts = new Map<string, number>();
  barcodeRows.forEach(row => barcodeCounts.set(row.barcode ?? '', (barcodeCounts.get(row.barcode ?? '') ?? 0) + 1));
  barcodeRows.forEach(row => {
    if ((barcodeCounts.get(row.barcode ?? '') ?? 0) > 1) {
      summary.conflicts += 1;
      issues.push({ entity: 'products', row: row.index + 1, field: 'barcode', value: row.barcode ?? '', code: 'DUPLICATE_BARCODE', action: 'review' });
    }
  });
  await analyze('sales', payload.sales);
  if (options.entities.includes('sale_items')) {
    const seenItems = new Set<string>();
    let itemRow = 0;
    for (const sale of payload.sales) {
      for (const item of sale.items) {
        itemRow += 1;
        if (!isUuid(item.uuid)) {
          summary.invalidRecords += 1;
          issues.push({ entity: 'sale_items', row: itemRow, field: 'uuid', code: 'INVALID_UUID', action: 'rejected' });
        } else if (seenItems.has(item.uuid)) {
          summary.duplicates += 1;
          issues.push({ entity: 'sale_items', row: itemRow, field: 'uuid', code: 'DUPLICATE_UUID', action: 'rejected' });
        }
        seenItems.add(item.uuid);
      }
    }
  }
  if (options.entities.includes('expenses')) {
    const localExpenses = await db.getAllAsync<{ uuid: string; description: string; amount_syp: number; note: string | null; category_uuid: string; updated_at: string }>(`SELECT e.uuid,e.description,e.amount_syp,e.note,c.uuid AS category_uuid,e.updated_at
      FROM expenses e JOIN expense_categories c ON c.id=e.category_id`);
    const byUuid = new Map(localExpenses.map(row => [row.uuid, row])); const seen = new Set<string>();
    payload.expenses.forEach((expense, index) => {
      if (seen.has(expense.uuid)) { summary.duplicates += 1; issues.push({ entity: 'expenses', row: index + 1, code: 'DUPLICATE_UUID', action: 'rejected' }); return; }
      seen.add(expense.uuid); const existing = byUuid.get(expense.uuid);
      if (!existing) { summary.newRecords += 1; return; }
      const unchanged = existing.description === expense.description && existing.amount_syp === expense.amount_syp &&
        (existing.note ?? null) === (expense.note ?? null) && existing.category_uuid === (expense.category_uuid ?? OTHER_EXPENSE_CATEGORY_UUID);
      if (unchanged) summary.unchangedRecords += 1;
      else if (options.conflictStrategy === 'manual') { summary.conflicts += 1; issues.push({ entity: 'expenses', row: index + 1, code: 'REVIEW_REQUIRED', action: 'review' }); }
      else summary.updatedRecords += 1;
    });
  }
  if (options.entities.includes('expense_categories')) {
    const local = new Map((await db.getAllAsync<{ uuid: string; updated_at: string }>('SELECT uuid,updated_at FROM expense_categories')).map(row => [row.uuid, row]));
    const seen = new Set<string>();
    for (const [index, category] of (payload.expenseCategories ?? []).entries()) {
      if (seen.has(category.uuid)) { summary.duplicates += 1; issues.push({ entity: 'expense_categories', row: index + 1, code: 'DUPLICATE_UUID', action: 'rejected' }); continue; }
      seen.add(category.uuid); const existing = local.get(category.uuid);
      if (!existing) summary.newRecords += 1; else if (Date.parse(category.updated_at) > Date.parse(existing.updated_at)) summary.updatedRecords += 1; else summary.unchangedRecords += 1;
    }
  }
  if (options.entities.includes('expenses')) {
    const knownCategories = new Set((await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM expense_categories')).map(row => row.uuid));
    for (const category of payload.expenseCategories ?? []) knownCategories.add(category.uuid);
    payload.expenses.forEach((expense, index) => {
      if (expense.category_uuid && !knownCategories.has(expense.category_uuid)) {
        summary.conflicts += 1; issues.push({ entity: 'expenses', row: index + 1, field: 'category_uuid', value: expense.category_uuid, code: 'EXPENSE_CATEGORY_PARENT_MISSING', action: 'review' });
      }
    });
  }
  if (options.entities.includes('exchange_rate_history')) {
    const local = new Set((await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM exchange_rate_history')).map(row => row.uuid));
    const seen = new Set<string>();
    (payload.exchangeRateHistory ?? []).forEach((entry, index) => {
      if (seen.has(entry.uuid)) { summary.duplicates += 1; issues.push({ entity: 'exchange_rate_history', row: index + 1, code: 'DUPLICATE_UUID', action: 'rejected' }); }
      else if (local.has(entry.uuid)) summary.unchangedRecords += 1;
      else summary.newRecords += 1;
      seen.add(entry.uuid);
    });
  }
  if (options.entities.includes('sale_returns')) {
    const localReturns = new Set((await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM sale_returns')).map(row => row.uuid));
    const localSales = new Set((await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM sales')).map(row => row.uuid));
    const localItems = new Set((await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM sale_items')).map(row => row.uuid));
    const payloadSales = new Set(payload.sales.map(sale => sale.uuid));
    const payloadItems = new Set(payload.sales.flatMap(sale => sale.items.map(item => item.uuid)));
    const seen = new Set<string>();
    (payload.returns ?? []).forEach((record, index) => {
      if (seen.has(record.uuid)) { summary.duplicates += 1; issues.push({ entity: 'sale_returns', row: index + 1, code: 'DUPLICATE_UUID', action: 'rejected' }); return; }
      seen.add(record.uuid);
      if (localReturns.has(record.uuid)) { summary.unchangedRecords += 1; return; }
      if (!localSales.has(record.sale_uuid) && !payloadSales.has(record.sale_uuid)) {
        summary.conflicts += 1; issues.push({ entity: 'sale_returns', row: index + 1, field: 'sale_uuid', code: 'RETURN_PARENT_MISSING', action: 'review' }); return;
      }
      const missingItem = record.items.find(item => !localItems.has(item.sale_item_uuid) && !payloadItems.has(item.sale_item_uuid));
      if (missingItem) { summary.conflicts += 1; issues.push({ entity: 'sale_return_items', row: index + 1, field: 'sale_item_uuid', value: missingItem.sale_item_uuid, code: 'RETURN_ITEM_PARENT_MISSING', action: 'review' }); return; }
      summary.newRecords += 1 + record.items.length;
    });
  }
  if (options.entities.includes('sale_payments')) {
    const localRows = await db.getAllAsync<{ uuid: string; sale_uuid: string; currency: string; amount_minor: number; syp_equivalent: number; exchange_rate_syp_per_usd: number | null }>('SELECT sp.uuid,s.uuid AS sale_uuid,sp.currency,sp.amount_minor,sp.syp_equivalent,sp.exchange_rate_syp_per_usd FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id');
    const localByUuid = new Map(localRows.map(row => [row.uuid, row]));
    const localCurrency = new Map(localRows.map(row => [`${row.sale_uuid}:${row.currency}`, row.uuid]));
    const knownSales = new Set((await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM sales')).map(row => row.uuid));
    payload.sales.forEach(sale => knownSales.add(sale.uuid));
    const seenUuid = new Set<string>(); const seenCurrency = new Set<string>();
    for (const [index, payment] of (payload.salePayments ?? []).entries()) {
      const key = `${payment.sale_uuid}:${payment.currency}`;
      if (seenUuid.has(payment.uuid) || seenCurrency.has(key)) { summary.duplicates += 1; issues.push({ entity: 'sale_payments', row: index + 1, code: 'DUPLICATE_UUID', action: 'rejected' }); continue; }
      seenUuid.add(payment.uuid); seenCurrency.add(key);
      if (!knownSales.has(payment.sale_uuid)) { summary.conflicts += 1; issues.push({ entity: 'sale_payments', row: index + 1, field: 'sale_uuid', value: payment.sale_uuid, code: 'PAYMENT_PARENT_MISSING', action: 'review' }); continue; }
      const local = localByUuid.get(payment.uuid);
      if (local) {
        const unchanged = local.sale_uuid === payment.sale_uuid && local.currency === payment.currency && local.amount_minor === payment.amount_minor && local.syp_equivalent === payment.syp_equivalent && local.exchange_rate_syp_per_usd === payment.exchange_rate_syp_per_usd;
        if (unchanged) summary.unchangedRecords += 1; else { summary.conflicts += 1; issues.push({ entity: 'sale_payments', row: index + 1, code: 'PAYMENT_CONFLICT', action: 'review' }); }
      } else if (localCurrency.has(key)) { summary.conflicts += 1; issues.push({ entity: 'sale_payments', row: index + 1, code: 'PAYMENT_SETTLEMENT_CONFLICT', action: 'review' }); }
      else summary.newRecords += 1;
    }
    const totals = new Map<string, number>();
    for (const payment of payload.salePayments ?? []) totals.set(payment.sale_uuid, (totals.get(payment.sale_uuid) ?? 0) + payment.syp_equivalent);
    for (const [saleUuid, total] of totals) { const sale = payload.sales.find(row => row.uuid === saleUuid); if (sale && total - (sale.change_syp ?? 0) !== sale.net_total_syp) { summary.conflicts += 1; issues.push({ entity: 'sale_payments', row: 0, value: saleUuid, code: 'PAYMENT_SETTLEMENT_CONFLICT', action: 'review' }); } }
  }
  if (options.entities.includes('categories')) {
    const local = new Set((await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM categories')).map(row => row.uuid));
    const seen = new Set<string>();
    payload.categories.forEach((category, index) => {
      if (!isUuid(category.uuid)) {
        summary.invalidRecords += 1;
        issues.push({ entity: 'categories', row: index + 1, field: 'uuid', code: 'INVALID_UUID', action: 'rejected' });
      } else if (seen.has(category.uuid)) summary.duplicates += 1;
      else if (local.has(category.uuid)) summary.unchangedRecords += 1;
      else summary.newRecords += 1;
      seen.add(category.uuid);
    });
  }
  return { summary, issues, payload, options };
}
