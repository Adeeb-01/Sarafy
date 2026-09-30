import { getDatabase, OTHER_EXPENSE_CATEGORY_UUID } from '@/database/database';
import { createPreImportBackup } from '@/backup/backupManager';
import { ImportOptions, ImportPayload, ImportPreview, ImportResult } from './importTypes';
import { createDeterministicUuid, isUuid } from '@/utils/uuid';
import { isStoredProductImagePath } from '@/media/productImageStorage';
import { normalizeBarcode } from '@/utils/barcode';
import { calculateCashDifference, calculateExpectedCash, calculateExpectedCashWithSettlements } from '@/utils/cashSession';
import { usdCentsToSyp } from '@/utils/multiCurrency';
import { isValidImportedSalePaymentRows, isValidImportedSaleSettlement } from '@/utils/customerAccounts';
import { insertFullRestorePayload } from './fullRestoreInserter';

const SETTING_KEYS = ['exchangeRate', 'isRoundingEnabled', 'roundingTarget', 'language'] as const;

function shouldUseImported(localUpdated: string, importedUpdated: string, options: ImportOptions) {
  if (options.conflictStrategy === 'keep_local' || options.conflictStrategy === 'manual') return false;
  if (options.conflictStrategy === 'use_imported') return true;
  return Date.parse(importedUpdated) > Date.parse(localUpdated);
}

let importRunning = false;

async function executeImportInternal(preview: ImportPreview): Promise<ImportResult> {
  assertImportPayload(preview.payload);
  if (preview.summary.invalidRecords || preview.summary.duplicates ||
      preview.issues.some(issue => issue.code === 'DUPLICATE_BARCODE') ||
      preview.issues.some(issue => issue.code === 'RETURN_PARENT_MISSING' || issue.code === 'RETURN_ITEM_PARENT_MISSING') ||
      preview.issues.some(issue => issue.code === 'EXPENSE_CATEGORY_PARENT_MISSING') ||
      preview.issues.some(issue => issue.code === 'PAYMENT_PARENT_MISSING' || issue.code === 'PAYMENT_CONFLICT' || issue.code === 'PAYMENT_SETTLEMENT_CONFLICT') ||
      preview.issues.some(issue => issue.code === 'CASH_SESSION_PARENT_MISSING' || issue.code === 'OPEN_CASH_SESSION_CONFLICT' || issue.code === 'CASH_SESSION_CONFLICT') ||
      (preview.options.conflictStrategy === 'manual' && preview.summary.conflicts)) {
    throw new Error('IMPORT_REQUIRES_REVIEW');
  }
  const backupId = await createPreImportBackup(`import:${preview.options.mode}`);
  if (!backupId) throw new Error('PRE_IMPORT_BACKUP_FAILED');
  const db = await getDatabase();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const { payload, options } = preview;
  const isFullRestore = options.mode === 'full_restore';
  await db.withExclusiveTransactionAsync(async transaction => {
    if (isFullRestore) {
      await transaction.runAsync(`UPDATE accounting_settings SET accounting_enabled=0,accounting_started_at=NULL,cutover_exchange_rate_syp_per_usd=NULL,opening_journal_entry_id=NULL,updated_at=? WHERE id=1`, new Date().toISOString());
      await transaction.runAsync('DELETE FROM journal_lines');
      await transaction.runAsync('DELETE FROM journal_entries');
      await transaction.runAsync('DELETE FROM supplier_foreign_allocations');
      await transaction.runAsync('DELETE FROM supplier_foreign_position_layers');
      await transaction.runAsync('DELETE FROM inventory_value_movements');
      await transaction.runAsync('DELETE FROM inventory_value_balances');
      await transaction.runAsync('DELETE FROM accounting_cutover_positions');
      await transaction.runAsync('DELETE FROM cash_control');
      await transaction.runAsync('DELETE FROM cash_adjustments');
      await transaction.runAsync(`UPDATE gl_account_balances SET debit_total_syp=0,credit_total_syp=0,net_balance_syp=0,updated_at=?`, new Date().toISOString());
      await transaction.runAsync('DELETE FROM supplier_payment_tenders');
      await transaction.runAsync('DELETE FROM supplier_account_entries');
      await transaction.runAsync('DELETE FROM supplier_account_balances');
      await transaction.runAsync('DELETE FROM supplier_payments');
      await transaction.runAsync('DELETE FROM customer_payment_tenders');
      await transaction.runAsync('DELETE FROM customer_account_entries');
      await transaction.runAsync('DELETE FROM customer_account_balances');
      await transaction.runAsync('DELETE FROM customer_payments');
      await transaction.runAsync('DELETE FROM inventory_movements');
      await transaction.runAsync('DELETE FROM inventory_balances');
      await transaction.runAsync('DELETE FROM purchase_return_items');
      await transaction.runAsync('DELETE FROM purchase_returns');
      await transaction.runAsync('DELETE FROM purchase_receipt_items');
      await transaction.runAsync('DELETE FROM purchase_receipts');
      await transaction.runAsync('DELETE FROM suppliers');
      await transaction.runAsync('DELETE FROM sale_payments');
      await transaction.runAsync('DELETE FROM sale_return_items');
      await transaction.runAsync('DELETE FROM sale_returns');
      await transaction.runAsync('DELETE FROM sale_draft_items');
      await transaction.runAsync('DELETE FROM sale_drafts');
      await transaction.runAsync('DELETE FROM sale_items');
      await transaction.runAsync('DELETE FROM sales');
      await transaction.runAsync('DELETE FROM customers');
      await transaction.runAsync('DELETE FROM expenses');
      await transaction.runAsync('DELETE FROM cash_sessions');
      await transaction.runAsync('DELETE FROM exchange_rate_history');
      if (payload.expenseCategories?.length) await transaction.runAsync('DELETE FROM expense_categories');
      else { await transaction.runAsync('DELETE FROM expense_categories WHERE is_system=0'); await transaction.runAsync('UPDATE expense_categories SET is_active=1'); }
      await transaction.runAsync('DELETE FROM products');
      await transaction.runAsync('DELETE FROM categories');
      if (options.entities.includes('settings')) await transaction.runAsync('DELETE FROM settings');
      inserted += await insertFullRestorePayload(transaction, payload, options.entities);
      const fk = await transaction.getAllAsync<{ table: string; rowid: number }>('PRAGMA foreign_key_check');
      if (fk.length) throw new Error('FOREIGN_KEY_CHECK_FAILED');
      return;
    }
    if (options.entities.includes('cash_sessions')) {
      const supplierFinanceSessionUuids = new Set((payload.supplierPayments ?? []).map(payment => payment.cash_session_uuid));
      const customerFinanceSessionUuids = new Set((payload.customerPayments ?? []).map(payment => payment.cash_session_uuid));
      const openCount = (payload.cashSessions ?? []).filter(session => session.closed_at == null).length;
      if (options.mode === 'full_restore' && openCount > 1) throw new Error('MULTIPLE_OPEN_CASH_SESSIONS');
      for (const session of payload.cashSessions ?? []) {
        const hasSupplierFinance = supplierFinanceSessionUuids.has(session.uuid) ||
          (session.closing_supplier_payments_syp ?? 0) !== 0 ||
          (session.closing_supplier_payments_usd_cents ?? 0) !== 0;
        const hasCustomerFinance = customerFinanceSessionUuids.has(session.uuid) || (session.closing_customer_payments_syp ?? 0) !== 0 || (session.closing_customer_payments_usd_cents ?? 0) !== 0;
        if (options.mode !== 'full_restore' && (hasSupplierFinance || hasCustomerFinance)) { skipped += 1; continue; }
        if (options.mode !== 'full_restore' && session.closed_at == null) throw new Error('OPEN_CASH_SESSION_CONFLICT');
        const local = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM cash_sessions WHERE uuid=?', session.uuid);
        if (local) { skipped += 1; continue; }
        await transaction.runAsync(`INSERT INTO cash_sessions(uuid,opened_at,closed_at,opening_cash_syp,opening_cash_usd_cents,closing_actual_cash_syp,closing_actual_cash_usd_cents,
          closing_sales_total_syp,closing_refunds_total_syp,closing_expenses_total_syp,closing_expected_cash_syp,
          closing_difference_syp,closing_expected_cash_usd_cents,closing_difference_usd_cents,closing_cash_received_syp,closing_cash_received_usd_cents,closing_change_given_syp,
          opening_note,closing_note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        session.uuid, session.opened_at, session.closed_at, session.opening_cash_syp, session.opening_cash_usd_cents ?? 0, session.closing_actual_cash_syp, session.closing_actual_cash_usd_cents ?? null,
        session.closing_sales_total_syp, session.closing_refunds_total_syp, session.closing_expenses_total_syp,
        session.closing_expected_cash_syp, session.closing_difference_syp, session.closing_expected_cash_usd_cents ?? null, session.closing_difference_usd_cents ?? null,
        session.closing_cash_received_syp ?? null, session.closing_cash_received_usd_cents ?? null, session.closing_change_given_syp ?? null, session.opening_note, session.closing_note,
        session.created_at, session.updated_at);
        inserted += 1;
      }
    }
    const sessionRows = await transaction.getAllAsync<{ id: number; uuid: string }>('SELECT id,uuid FROM cash_sessions');
    const sessionIdByUuid = new Map(sessionRows.map(session => [session.uuid, session.id]));
    const resolveCashSessionId = (uuid?: string | null) => {
      if (!uuid) return null;
      const id = sessionIdByUuid.get(uuid);
      if (!id) throw new Error('CASH_SESSION_PARENT_MISSING');
      return id;
    };
    if (options.entities.includes('expense_categories')) {
      for (const item of payload.expenseCategories ?? []) {
        const local = await transaction.getFirstAsync<{ id: number; updated_at: string }>('SELECT id,updated_at FROM expense_categories WHERE uuid=?', item.uuid);
        if (!local) {
          await transaction.runAsync(`INSERT INTO expense_categories(uuid,name_ar,name_en,is_system,is_active,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?)`, item.uuid, item.name_ar, item.name_en ?? null, item.is_system ? 1 : 0, item.is_active ? 1 : 0, item.created_at, item.updated_at);
          inserted += 1;
        } else if (!item.is_system && shouldUseImported(local.updated_at, item.updated_at, options)) {
          await transaction.runAsync('UPDATE expense_categories SET name_ar=?,name_en=?,is_active=?,updated_at=? WHERE uuid=?', item.name_ar, item.name_en ?? null, item.is_active ? 1 : 0, item.updated_at, item.uuid);
          updated += 1;
        } else skipped += 1;
      }
    }
    if (options.entities.includes('categories')) {
      for (const item of payload.categories) {
        const local = await transaction.getFirstAsync<{ uuid: string; updated_at: string }>(
          'SELECT uuid,updated_at FROM categories WHERE uuid=? OR name=? COLLATE NOCASE LIMIT 1',
          item.uuid, item.name,
        );
        if (!local) {
          await transaction.runAsync('INSERT INTO categories(uuid,name,created_at,updated_at) VALUES(?,?,?,?)', item.uuid, item.name, item.created_at, item.updated_at);
          inserted += 1;
        } else if (shouldUseImported(local.updated_at, item.updated_at, options)) {
          await transaction.runAsync('UPDATE categories SET name=?,updated_at=? WHERE uuid=?', item.name, item.updated_at, local.uuid);
          updated += 1;
        } else skipped += 1;
      }
    }
    const importedProductIds = new Map<number, string>();
    const localProductByImportedId = new Map<number, number>();
    if (options.entities.includes('products')) {
      for (const item of payload.products) {
        const barcode = normalizeBarcode(item.barcode);
        importedProductIds.set(item.id, item.uuid);
        const local = await transaction.getFirstAsync<{ id: number; uuid: string; updated_at: string }>(
          'SELECT id,uuid,updated_at FROM products WHERE uuid=? OR (barcode IS NOT NULL AND barcode=?) LIMIT 1',
          item.uuid, barcode,
        );
        if (!local) {
          const result = await transaction.runAsync(
            `INSERT INTO products(uuid,name,category,price_usd,cost_usd,image_uri,barcode,created_at,updated_at,is_active)
             VALUES(?,?,?,?,?,?,?,?,?,?)`,
            item.uuid, item.name, item.category, item.price_usd, item.cost_usd, item.image_uri,
            barcode, item.created_at, item.updated_at, item.is_active ?? 1,
          );
          localProductByImportedId.set(item.id, result.lastInsertRowId);
          inserted += 1;
        } else if (shouldUseImported(local.updated_at, item.updated_at, options)) {
          await transaction.runAsync(
            `UPDATE products SET name=?,category=?,price_usd=?,cost_usd=?,barcode=?,updated_at=?,is_active=? WHERE uuid=?`,
            item.name, item.category, item.price_usd, item.cost_usd, barcode,
            item.updated_at, item.is_active ?? 1, local.uuid,
          );
          localProductByImportedId.set(item.id, local.id);
          updated += 1;
        } else {
          localProductByImportedId.set(item.id, local.id);
          skipped += 1;
        }
      }
    }
    for (const [oldId, uuid] of importedProductIds) {
      if (localProductByImportedId.has(oldId)) continue;
      const row = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM products WHERE uuid=?', uuid);
      if (row) localProductByImportedId.set(oldId, row.id);
    }
    if (options.entities.includes('suppliers')) {
      for (const supplier of payload.suppliers ?? []) {
        const local = await transaction.getFirstAsync<{ id: number; updated_at: string }>('SELECT id,updated_at FROM suppliers WHERE uuid=?', supplier.uuid);
        if (!local) {
          await transaction.runAsync('INSERT INTO suppliers(uuid,name,phone,address,note,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', supplier.uuid, supplier.name, supplier.phone, supplier.address, supplier.note, supplier.is_active ? 1 : 0, supplier.created_at, supplier.updated_at);
          inserted += 1;
        } else if (shouldUseImported(local.updated_at, supplier.updated_at, options)) {
          await transaction.runAsync('UPDATE suppliers SET name=?,phone=?,address=?,note=?,is_active=?,updated_at=? WHERE id=?', supplier.name, supplier.phone, supplier.address, supplier.note, supplier.is_active ? 1 : 0, supplier.updated_at, local.id);
          updated += 1;
        } else skipped += 1;
      }
    }
    if (options.entities.includes('customers')) {
      for (const customer of payload.customers ?? []) {
        const local = await transaction.getFirstAsync<{ id: number; updated_at: string }>('SELECT id,updated_at FROM customers WHERE uuid=?', customer.uuid);
        if (!local) { await transaction.runAsync('INSERT INTO customers(uuid,name,phone,note,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', customer.uuid, customer.name, customer.phone, customer.note, customer.is_active ? 1 : 0, customer.created_at, customer.updated_at); inserted += 1; }
        else if (shouldUseImported(local.updated_at, customer.updated_at, options)) { await transaction.runAsync('UPDATE customers SET name=?,phone=?,note=?,is_active=?,updated_at=? WHERE id=?', customer.name, customer.phone, customer.note, customer.is_active ? 1 : 0, customer.updated_at, local.id); updated += 1; }
        else skipped += 1;
      }
    }
    if (options.entities.includes('sales')) {
      for (const sale of payload.sales) {
        if (options.mode !== 'full_restore' && ((sale.on_account_syp ?? 0) > 0 || sale.customer_uuid_snapshot)) { skipped += 1; continue; }
        const cashSessionId = resolveCashSessionId(sale.cash_session_uuid);
        const local = await transaction.getFirstAsync<{ id: number; updated_at: string }>('SELECT id,updated_at FROM sales WHERE uuid=?', sale.uuid);
        let saleId = local?.id;
        let saleWasInserted = false;
        if (!local) {
          const invoiceCollision = await transaction.getFirstAsync<{ uuid: string }>('SELECT uuid FROM sales WHERE invoice_number=?', sale.invoice_number);
          const invoiceNumber = invoiceCollision && invoiceCollision.uuid !== sale.uuid
            ? `${sale.invoice_number}-${sale.uuid.slice(0, 8)}`
            : sale.invoice_number;
          const result = await transaction.runAsync(
            `INSERT INTO sales(uuid,invoice_number,exchange_rate,subtotal_syp,discount_syp,net_total_syp,cost_syp,profit_syp,amount_paid_syp,change_syp,created_at,updated_at,cash_session_id)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            sale.uuid, invoiceNumber, sale.exchange_rate, sale.subtotal_syp, sale.discount_syp,
            sale.net_total_syp, sale.cost_syp, sale.profit_syp, sale.amount_paid_syp ?? null,
            sale.change_syp ?? null, sale.created_at, sale.updated_at, cashSessionId,
          );
          saleId = result.lastInsertRowId; saleWasInserted = true; inserted += 1;
        } else { if (cashSessionId) await transaction.runAsync('UPDATE sales SET cash_session_id=COALESCE(cash_session_id,?) WHERE id=?', cashSessionId, local.id); skipped += 1; } // Completed invoices are immutable snapshots.
        if (saleId && saleWasInserted && options.entities.includes('sale_items')) {
          for (const item of sale.items) {
            const exists = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM sale_items WHERE uuid=?', item.uuid);
            if (exists) { skipped += 1; continue; }
            await transaction.runAsync(
              `INSERT INTO sale_items(uuid,sale_id,product_id,product_name,barcode_snapshot,quantity,unit_price_syp,unit_cost_syp,line_total_syp,line_cost_syp,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
              item.uuid, saleId, item.product_id ? localProductByImportedId.get(item.product_id) ?? null : null,
              item.product_name, item.barcode_snapshot ?? null, item.quantity, item.unit_price_syp, item.unit_cost_syp,
              item.line_total_syp, item.line_cost_syp, item.created_at, item.updated_at,
            );
            inserted += 1;
          }
        }
      }
    }
    if (options.entities.includes('sale_payments')) {
      const importedPayments = payload.salePayments ?? payload.sales.filter(sale => sale.amount_paid_syp != null).map(sale => ({
        uuid: createDeterministicUuid(`sale-payment:syp:${sale.uuid}`), sale_uuid: sale.uuid, currency: 'SYP' as const,
        amount_minor: sale.amount_paid_syp!, syp_equivalent: sale.amount_paid_syp!, exchange_rate_syp_per_usd: null, created_at: sale.created_at,
      }));
      for (const payment of importedPayments) {
        const sale = await transaction.getFirstAsync<{ id: number; net_total_syp: number; change_syp: number | null }>('SELECT id,net_total_syp,change_syp FROM sales WHERE uuid=?', payment.sale_uuid);
        if (!sale) throw new Error('PAYMENT_PARENT_MISSING');
        const duplicate = await transaction.getFirstAsync<{ sale_id: number; currency: string; amount_minor: number; syp_equivalent: number; exchange_rate_syp_per_usd: number | null }>('SELECT sale_id,currency,amount_minor,syp_equivalent,exchange_rate_syp_per_usd FROM sale_payments WHERE uuid=?', payment.uuid);
        if (duplicate) {
          if (duplicate.sale_id !== sale.id || duplicate.currency !== payment.currency || duplicate.amount_minor !== payment.amount_minor || duplicate.syp_equivalent !== payment.syp_equivalent || duplicate.exchange_rate_syp_per_usd !== payment.exchange_rate_syp_per_usd) throw new Error('PAYMENT_CONFLICT');
          skipped += 1; continue;
        }
        const currencyConflict = await transaction.getFirstAsync<{ uuid: string }>('SELECT uuid FROM sale_payments WHERE sale_id=? AND currency=?', sale.id, payment.currency);
        if (currencyConflict) throw new Error('PAYMENT_SETTLEMENT_CONFLICT');
        await transaction.runAsync('INSERT INTO sale_payments(uuid,sale_id,currency,amount_minor,syp_equivalent,exchange_rate_syp_per_usd,created_at) VALUES(?,?,?,?,?,?,?)', payment.uuid, sale.id, payment.currency, payment.amount_minor, payment.syp_equivalent, payment.exchange_rate_syp_per_usd, payment.created_at);
        inserted += 1;
      }
      for (const saleUuid of new Set(importedPayments.map(payment => payment.sale_uuid))) {
        const sale = await transaction.getFirstAsync<{ id: number; net_total_syp: number; change_syp: number | null; on_account_syp: number }>('SELECT id,net_total_syp,change_syp,on_account_syp FROM sales WHERE uuid=?', saleUuid);
        if (!sale) throw new Error('PAYMENT_PARENT_MISSING');
        const total = await transaction.getFirstAsync<{ total: number }>('SELECT COALESCE(SUM(syp_equivalent),0) AS total FROM sale_payments WHERE sale_id=?', sale.id);
        if ((total?.total ?? 0) - (sale.change_syp ?? 0) + (sale.on_account_syp ?? 0) !== sale.net_total_syp) throw new Error('PAYMENT_SETTLEMENT_CONFLICT');
      }
    }
    if (options.entities.includes('sale_returns')) {
      for (const record of payload.returns ?? []) {
        if (options.mode !== 'full_restore' && (record.customer_account_credit_syp ?? 0) > 0) { skipped += 1; continue; }
        const cashSessionId = resolveCashSessionId(record.cash_session_uuid);
        const duplicate = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM sale_returns WHERE uuid=?', record.uuid);
        if (duplicate) { skipped += 1; continue; }
        const sale = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM sales WHERE uuid=?', record.sale_uuid);
        if (!sale) throw new Error('RETURN_PARENT_MISSING');
        const resolved: Array<{ id: number; item: typeof record.items[number] }> = [];
        for (const item of record.items) {
          const localItem = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM sale_items WHERE uuid=? AND sale_id=?', item.sale_item_uuid, sale.id);
          if (!localItem) throw new Error('RETURN_ITEM_PARENT_MISSING');
          resolved.push({ id: localItem.id, item });
        }
        if (record.items.reduce((sum, item) => sum + item.refund_amount_syp, 0) !== record.refund_total_syp ||
            record.items.reduce((sum, item) => sum + item.cost_reversal_syp, 0) !== record.returned_cost_syp) throw new Error('INVALID_RETURN_TOTAL');
        const requestedByItem = new Map<number, number>();
        for (const entry of resolved) requestedByItem.set(entry.id, (requestedByItem.get(entry.id) ?? 0) + entry.item.quantity);
        for (const [itemId, requestedQuantity] of requestedByItem) {
          const quantities = await transaction.getFirstAsync<{ sold: number; returned: number }>(`SELECT si.quantity AS sold,
            COALESCE((SELECT SUM(ri.quantity) FROM sale_return_items ri WHERE ri.sale_item_id=si.id),0) AS returned
            FROM sale_items si WHERE si.id=?`, itemId);
          if (!quantities || quantities.returned + requestedQuantity > quantities.sold) throw new Error('RETURN_QUANTITY_EXCEEDED');
        }
        const insertedReturn = await transaction.runAsync(
          'INSERT INTO sale_returns(uuid,sale_id,refund_total_syp,returned_cost_syp,created_at,updated_at,cash_session_id,customer_account_credit_syp) VALUES(?,?,?,?,?,?,?,?)',
          record.uuid, sale.id, record.refund_total_syp, record.returned_cost_syp, record.created_at, record.updated_at, cashSessionId, record.customer_account_credit_syp ?? 0,
        );
        inserted += 1;
        if (!options.entities.includes('sale_return_items')) continue;
        for (const entry of resolved) {
          await transaction.runAsync(`INSERT INTO sale_return_items(uuid,return_id,sale_item_id,quantity,refund_amount_syp,cost_reversal_syp,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?)`, entry.item.uuid, insertedReturn.lastInsertRowId, entry.id, entry.item.quantity, entry.item.refund_amount_syp, entry.item.cost_reversal_syp, entry.item.created_at, entry.item.updated_at);
          inserted += 1;
        }
      }
    }
    if (options.mode === 'full_restore' && options.entities.includes('sale_drafts')) {
      for (const draft of payload.drafts ?? []) {
        const result = await transaction.runAsync(
          'INSERT INTO sale_drafts(uuid,exchange_rate,discount_syp,created_at,updated_at) VALUES(?,?,?,?,?)',
          draft.uuid, draft.exchange_rate, draft.discount_syp, draft.created_at, draft.updated_at,
        );
        inserted += 1;
        if (!options.entities.includes('sale_draft_items')) continue;
        for (const item of draft.items) {
          await transaction.runAsync(
            `INSERT INTO sale_draft_items(uuid,draft_id,product_id,product_name,barcode_snapshot,quantity,unit_price_syp,unit_cost_syp,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?)`,
            item.uuid, result.lastInsertRowId,
            item.product_id ? localProductByImportedId.get(item.product_id) ?? null : null,
            item.product_name, item.barcode_snapshot ?? null, item.quantity,
            item.unit_price_syp, item.unit_cost_syp, item.created_at, item.updated_at,
          );
          inserted += 1;
        }
      }
    }
    if (options.entities.includes('expenses')) {
      for (const item of payload.expenses) {
        const cashSessionId = resolveCashSessionId(item.cash_session_uuid);
        const categoryUuid = item.category_uuid || OTHER_EXPENSE_CATEGORY_UUID;
        const category = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM expense_categories WHERE uuid=?', categoryUuid);
        if (!category) throw new Error('EXPENSE_CATEGORY_PARENT_MISSING');
        const local = await transaction.getFirstAsync<{ updated_at: string }>('SELECT updated_at FROM expenses WHERE uuid=?', item.uuid);
        if (!local) {
          await transaction.runAsync('INSERT INTO expenses(uuid,description,amount_syp,category_id,note,created_at,updated_at,cash_session_id) VALUES(?,?,?,?,?,?,?,?)', item.uuid, item.description, item.amount_syp, category.id, item.note ?? null, item.created_at, item.updated_at, cashSessionId);
          inserted += 1;
        } else if (shouldUseImported(local.updated_at, item.updated_at, options)) {
          await transaction.runAsync('UPDATE expenses SET description=?,amount_syp=?,category_id=?,note=?,updated_at=?,cash_session_id=COALESCE(cash_session_id,?) WHERE uuid=?', item.description, item.amount_syp, category.id, item.note ?? null, item.updated_at, cashSessionId, item.uuid);
          updated += 1;
        } else skipped += 1;
      }
    }
    if (options.entities.includes('exchange_rate_history')) {
      for (const entry of payload.exchangeRateHistory ?? []) {
        const exists = await transaction.getFirstAsync<{ id: number }>('SELECT id FROM exchange_rate_history WHERE uuid=?', entry.uuid);
        if (exists) { skipped += 1; continue; }
        await transaction.runAsync('INSERT INTO exchange_rate_history(uuid,old_rate,new_rate,created_at) VALUES(?,?,?,?)', entry.uuid, entry.old_rate, entry.new_rate, entry.created_at);
        inserted += 1;
      }
    }
    if (options.mode === 'full_restore' && options.entities.includes('purchase_receipts')) {
      for (const receipt of payload.purchaseReceipts ?? []) {
        const supplier = receipt.supplier_uuid ? await transaction.getFirstAsync<{ id: number }>('SELECT id FROM suppliers WHERE uuid=?', receipt.supplier_uuid) : null;
        if (receipt.supplier_uuid && !supplier) throw new Error('PURCHASE_SUPPLIER_PARENT_MISSING');
        const insertedReceipt = await transaction.runAsync(`INSERT INTO purchase_receipts(uuid,supplier_id,supplier_uuid_snapshot,supplier_name_snapshot,reference_number,note,received_at,created_at)
          VALUES(?,?,?,?,?,?,?,?)`, receipt.uuid, supplier?.id ?? null, receipt.supplier_uuid_snapshot, receipt.supplier_name_snapshot, receipt.reference_number, receipt.note, receipt.received_at, receipt.created_at);
        inserted += 1;
        if (!options.entities.includes('purchase_receipt_items')) continue;
        for (const item of receipt.items) {
          const product = item.product_uuid ? await transaction.getFirstAsync<{ id: number }>('SELECT id FROM products WHERE uuid=?', item.product_uuid) : null;
          if (item.product_uuid && !product) throw new Error('PURCHASE_PRODUCT_PARENT_MISSING');
          if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0 || !Number.isSafeInteger(item.unit_cost_usd_cents) || item.unit_cost_usd_cents < 0 || item.line_total_usd_cents !== item.quantity * item.unit_cost_usd_cents) throw new Error('INVALID_PURCHASE_ITEM');
          await transaction.runAsync(`INSERT INTO purchase_receipt_items(uuid,purchase_receipt_id,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,quantity,unit_cost_usd_cents,line_total_usd_cents,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`, item.uuid, insertedReceipt.lastInsertRowId, product?.id ?? null, item.product_uuid_snapshot, item.product_name_snapshot, item.barcode_snapshot, item.quantity, item.unit_cost_usd_cents, item.line_total_usd_cents, item.created_at);
          inserted += 1;
        }
      }
    } else if (payload.purchaseReceipts?.length) skipped += payload.purchaseReceipts.reduce((sum, receipt) => sum + 1 + receipt.items.length, 0);
    if (options.mode === 'full_restore' && options.entities.includes('purchase_returns')) {
      const receiptRows = await transaction.getAllAsync<{ id: number; uuid: string }>('SELECT id,uuid FROM purchase_receipts');
      const purchaseItemRows = await transaction.getAllAsync<{ id: number; uuid: string; purchase_receipt_id: number; quantity: number; product_uuid_snapshot: string }>('SELECT id,uuid,purchase_receipt_id,quantity,product_uuid_snapshot FROM purchase_receipt_items');
      const receiptIdByUuid = new Map(receiptRows.map(row => [row.uuid, row.id])); const itemByUuid = new Map(purchaseItemRows.map(row => [row.uuid, row]));
      const cumulative = new Map<number, number>();
      for (const record of payload.purchaseReturns ?? []) {
        const receiptId = receiptIdByUuid.get(record.purchase_receipt_uuid); if (!receiptId) throw new Error('PURCHASE_RETURN_RECEIPT_PARENT_MISSING');
        const insertedReturn = await transaction.runAsync(`INSERT INTO purchase_returns(uuid,purchase_receipt_id,supplier_uuid_snapshot,supplier_name_snapshot,created_at,total_quantity,total_value_usd_cents,reference_number,note)
          VALUES(?,?,?,?,?,?,?,?,?)`, record.uuid, receiptId, record.supplier_uuid_snapshot, record.supplier_name_snapshot, record.created_at, record.total_quantity, record.total_value_usd_cents, record.reference_number, record.note);
        inserted += 1; let quantityTotal = 0; let valueTotal = 0;
        for (const item of record.items) {
          const parent = itemByUuid.get(item.purchase_receipt_item_uuid);
          if (!parent || parent.purchase_receipt_id !== receiptId) throw new Error('PURCHASE_RETURN_ITEM_PARENT_MISSING');
          const next = (cumulative.get(parent.id) ?? 0) + item.quantity;
          if (next > parent.quantity) throw new Error('PURCHASE_OVER_RETURN');
          cumulative.set(parent.id, next); quantityTotal += item.quantity; valueTotal += item.line_total_usd_cents;
          await transaction.runAsync(`INSERT INTO purchase_return_items(uuid,purchase_return_id,purchase_receipt_item_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,quantity,unit_cost_usd_cents,line_total_usd_cents,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`, item.uuid, insertedReturn.lastInsertRowId, parent.id, item.product_uuid_snapshot, item.product_name_snapshot, item.barcode_snapshot, item.quantity, item.unit_cost_usd_cents, item.line_total_usd_cents, item.created_at);
          inserted += 1;
        }
        if (quantityTotal !== record.total_quantity || valueTotal !== record.total_value_usd_cents) throw new Error('INVALID_PURCHASE_RETURN_TOTAL');
      }
    } else if (payload.purchaseReturns?.length) skipped += payload.purchaseReturns.reduce((sum, record) => sum + 1 + record.items.length, 0);
    if (options.mode === 'full_restore' && options.entities.includes('inventory_balances')) {
      const productRows = await transaction.getAllAsync<{ id: number; uuid: string }>('SELECT id,uuid FROM products');
      const productIdByUuid = new Map(productRows.map(row => [row.uuid, row.id]));
      for (const balance of payload.inventoryBalances ?? []) {
        const productId = productIdByUuid.get(balance.product_uuid);
        if (!productId) throw new Error('INVENTORY_PRODUCT_PARENT_MISSING');
        await transaction.runAsync(`INSERT INTO inventory_balances(product_id,tracking_enabled,quantity,low_stock_threshold,created_at,updated_at) VALUES(?,?,?,?,?,?)`,
          productId, balance.tracking_enabled ? 1 : 0, balance.quantity, balance.low_stock_threshold, balance.created_at, balance.updated_at);
        inserted += 1;
      }
      if (options.entities.includes('inventory_movements')) {
        const saleItemRows = await transaction.getAllAsync<{ id: number; uuid: string }>('SELECT id,uuid FROM sale_items');
        const returnItemRows = await transaction.getAllAsync<{ id: number; uuid: string }>('SELECT id,uuid FROM sale_return_items');
        const purchaseItemRows = await transaction.getAllAsync<{ id: number; uuid: string; quantity: number; product_uuid_snapshot: string }>('SELECT id,uuid,quantity,product_uuid_snapshot FROM purchase_receipt_items');
        const purchaseReturnItemRows = await transaction.getAllAsync<{ id: number; uuid: string; quantity: number; product_uuid_snapshot: string }>('SELECT id,uuid,quantity,product_uuid_snapshot FROM purchase_return_items');
        const saleItemIdByUuid = new Map(saleItemRows.map(row => [row.uuid, row.id]));
        const returnItemIdByUuid = new Map(returnItemRows.map(row => [row.uuid, row.id]));
        const purchaseItemByUuid = new Map(purchaseItemRows.map(row => [row.uuid, row]));
        const purchaseReturnItemByUuid = new Map(purchaseReturnItemRows.map(row => [row.uuid, row]));
        for (const movement of payload.inventoryMovements ?? []) {
          const productId = productIdByUuid.get(movement.product_uuid);
          const saleItemId = movement.sale_item_uuid ? saleItemIdByUuid.get(movement.sale_item_uuid) : null;
          const returnItemId = movement.return_item_uuid ? returnItemIdByUuid.get(movement.return_item_uuid) : null;
          const purchaseItem = movement.purchase_receipt_item_uuid ? purchaseItemByUuid.get(movement.purchase_receipt_item_uuid) : null;
          const purchaseReturnItem = movement.purchase_return_item_uuid ? purchaseReturnItemByUuid.get(movement.purchase_return_item_uuid) : null;
          if (!productId || (movement.sale_item_uuid && !saleItemId) || (movement.return_item_uuid && !returnItemId) || (movement.purchase_receipt_item_uuid && !purchaseItem) || (movement.purchase_return_item_uuid && !purchaseReturnItem)) throw new Error('INVENTORY_MOVEMENT_PARENT_MISSING');
          if (movement.movement_type === 'purchase' && (!purchaseItem || movement.quantity_delta !== purchaseItem.quantity || movement.product_uuid_snapshot !== purchaseItem.product_uuid_snapshot)) throw new Error('INVALID_PURCHASE_MOVEMENT');
          if (movement.movement_type === 'purchase_return' && (!purchaseReturnItem || movement.quantity_delta !== -purchaseReturnItem.quantity || movement.product_uuid_snapshot !== purchaseReturnItem.product_uuid_snapshot)) throw new Error('INVALID_PURCHASE_RETURN_MOVEMENT');
          await transaction.runAsync(`INSERT INTO inventory_movements(uuid,product_id,product_uuid_snapshot,product_name_snapshot,barcode_snapshot,movement_type,quantity_delta,quantity_before,quantity_after,sale_item_id,return_item_id,purchase_receipt_item_id,purchase_return_item_id,note,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, movement.uuid, productId, movement.product_uuid_snapshot, movement.product_name_snapshot, movement.barcode_snapshot,
          movement.movement_type, movement.quantity_delta, movement.quantity_before, movement.quantity_after, saleItemId ?? null, returnItemId ?? null, purchaseItem?.id ?? null, purchaseReturnItem?.id ?? null, movement.note, movement.created_at);
          inserted += 1;
        }
        const invalidLedger = await transaction.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM inventory_movements WHERE quantity_after<>quantity_before+quantity_delta`);
        const invalidBalances = await transaction.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM inventory_balances b WHERE EXISTS(SELECT 1 FROM inventory_movements m WHERE m.product_id=b.product_id) AND b.quantity<>(SELECT quantity_after FROM inventory_movements m WHERE m.product_id=b.product_id ORDER BY id DESC LIMIT 1)`);
        const missingPurchases = await transaction.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM purchase_receipt_items pi WHERE NOT EXISTS(SELECT 1 FROM inventory_movements m WHERE m.purchase_receipt_item_id=pi.id AND m.movement_type='purchase')`);
        const missingPurchaseReturns = await transaction.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM purchase_return_items ri WHERE NOT EXISTS(SELECT 1 FROM inventory_movements m WHERE m.purchase_return_item_id=ri.id AND m.movement_type='purchase_return')`);
        if ((invalidLedger?.count ?? 0) || (invalidBalances?.count ?? 0) || (missingPurchases?.count ?? 0) || (missingPurchaseReturns?.count ?? 0)) throw new Error('INVALID_INVENTORY_LEDGER');
      }
    } else if ((payload.inventoryBalances?.length ?? 0) || (payload.inventoryMovements?.length ?? 0)) {
      skipped += (payload.inventoryBalances?.length ?? 0) + (payload.inventoryMovements?.length ?? 0);
    }
    if (options.entities.includes('settings') && options.importSettings) {
      for (const key of SETTING_KEYS) {
        await transaction.runAsync(
          'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          key, JSON.stringify(payload.settings[key]),
        );
      }
    }
    const fk = await transaction.getAllAsync<{ table: string; rowid: number }>('PRAGMA foreign_key_check');
    if (fk.length) throw new Error('FOREIGN_KEY_CHECK_FAILED');
  });
  return {
    success: true, backupId, inserted, updated, skipped,
    rejected: preview.summary.invalidRecords, conflicts: preview.summary.conflicts,
    warnings: preview.issues.filter(issue => issue.action !== 'rejected'),
    errors: preview.issues.filter(issue => issue.action === 'rejected'),
  };
}

export async function executeImport(preview: ImportPreview): Promise<ImportResult> {
  if (importRunning) throw new Error('IMPORT_ALREADY_RUNNING');
  importRunning = true;
  try {
    return await executeImportInternal(preview);
  } finally {
    importRunning = false;
  }
}

export function defaultImportOptions(mode: ImportOptions['mode'] = 'safe_merge'): ImportOptions {
  return {
    mode,
    conflictStrategy: 'newest',
    entities: mode === 'full_restore'
      ? ['products', 'categories', 'settings', 'cash_sessions', 'customers', 'sales', 'sale_items', 'sale_payments', 'sale_returns', 'sale_return_items', 'expense_categories', 'expenses', 'exchange_rate_history', 'suppliers', 'purchase_receipts', 'purchase_receipt_items', 'purchase_returns', 'purchase_return_items', 'supplier_account_balances', 'supplier_account_entries', 'supplier_payments', 'supplier_payment_tenders', 'customer_account_balances', 'customer_account_entries', 'customer_payments', 'customer_payment_tenders', 'inventory_balances', 'inventory_movements', 'accounting', 'product_images', 'sale_drafts', 'sale_draft_items']
      : ['products', 'categories', 'cash_sessions', 'sales', 'sale_items', 'sale_payments', 'sale_returns', 'sale_return_items', 'expense_categories', 'expenses', 'exchange_rate_history', 'suppliers', 'product_images'],
    importSettings: mode === 'full_restore',
  };
}

export function assertImportPayload(value: unknown): asserts value is ImportPayload {
  if (!value || typeof value !== 'object') throw new Error('INVALID_BACKUP');
  const payload = value as Partial<ImportPayload>;
  if (!Array.isArray(payload.products) || !Array.isArray(payload.categories) ||
      !Array.isArray(payload.sales) || !Array.isArray(payload.expenses) ||
      !payload.settings || typeof payload.version !== 'number') throw new Error('INVALID_BACKUP');
  if (payload.version > 8) throw new Error('BACKUP_NEWER_THAN_APP');
  const validDate = (input: unknown) => typeof input === 'string' && Number.isFinite(Date.parse(input));
  const finite = (input: unknown) => typeof input === 'number' && Number.isFinite(input);
  if (payload.accounting) {
    const state = payload.accounting;
    if (!isRecord(state.settings) || ![0, 1].includes(state.settings.accounting_enabled) || state.settings.functional_currency !== 'SYP' ||
        !Array.isArray(state.cutoverPositions) || !Array.isArray(state.accounts) || !Array.isArray(state.journalEntries) ||
        !Array.isArray(state.journalLines) || !Array.isArray(state.accountBalances) || !Array.isArray(state.inventoryValueBalances) ||
        !Array.isArray(state.inventoryValueMovements) || !Array.isArray(state.supplierPositionLayers) || !Array.isArray(state.supplierAllocations) ||
        !Array.isArray(state.cashAdjustments)) throw new Error('INVALID_ACCOUNTING_BACKUP');
    if (state.settings.accounting_enabled === 1
      ? !validDate(state.settings.accounting_started_at) || !Number.isSafeInteger(state.settings.cutover_exchange_rate_syp_per_usd) || (state.settings.cutover_exchange_rate_syp_per_usd ?? 0) <= 0
      : state.settings.accounting_started_at != null || state.settings.cutover_exchange_rate_syp_per_usd != null || state.settings.opening_journal_uuid != null) throw new Error('INVALID_ACCOUNTING_SETTINGS');
    const entryUuids = new Set<string>(); const accountUuids = new Set<string>(); const lineUuids = new Set<string>();
    for (const account of state.accounts) {
      if (!isUuid(account.uuid) || accountUuids.has(account.uuid) || typeof account.code !== 'string' || typeof account.system_key !== 'string' ||
          typeof account.name_ar !== 'string' || typeof account.name_en !== 'string' || !['DEBIT', 'CREDIT'].includes(account.normal_side) ||
          ![0, 1].includes(account.is_system) || ![0, 1].includes(account.active) || !validDate(account.created_at) || !validDate(account.updated_at)) throw new Error('INVALID_ACCOUNTING_ACCOUNT');
      accountUuids.add(account.uuid);
    }
    const sourceTypes = new Set(['opening', 'sale', 'sale_return', 'expense', 'purchase', 'supplier_return', 'supplier_payment', 'customer_payment', 'inventory_adjustment', 'cash_adjustment', 'reversal']);
    const sourceIdentities = new Set<string>(); let openingEntries = 0;
    for (const entry of state.journalEntries) {
      if (!isUuid(entry.uuid) || entryUuids.has(entry.uuid) || !sourceTypes.has(entry.source_type) || !validDate(entry.occurred_at) || !validDate(entry.created_at) ||
          typeof entry.description_snapshot !== 'string' || (entry.source_type === 'opening' ? entry.source_uuid != null : !isUuid(entry.source_uuid)) ||
          (entry.reversal_of_entry_uuid != null && !isUuid(entry.reversal_of_entry_uuid))) throw new Error('INVALID_ACCOUNTING_JOURNAL');
      if (entry.source_type === 'opening') {
        openingEntries += 1;
        if (openingEntries > 1 || entry.reversal_of_entry_uuid != null) throw new Error('INVALID_ACCOUNTING_JOURNAL');
      } else if (entry.source_type !== 'reversal') {
        if (entry.reversal_of_entry_uuid != null) throw new Error('INVALID_ACCOUNTING_JOURNAL');
        const identity = `${entry.source_type}:${entry.source_uuid}`;
        if (sourceIdentities.has(identity)) throw new Error('INVALID_ACCOUNTING_JOURNAL');
        sourceIdentities.add(identity);
      }
      entryUuids.add(entry.uuid);
    }
    const entryByUuid = new Map(state.journalEntries.map(entry => [entry.uuid, entry])); const reversalTargets = new Set<string>();
    for (const entry of state.journalEntries) {
      if (entry.source_type !== 'reversal') continue;
      const originalUuid = entry.reversal_of_entry_uuid;
      const original = originalUuid ? entryByUuid.get(originalUuid) : null;
      if (!originalUuid || entry.source_uuid !== originalUuid || !original || original.source_type === 'reversal' || reversalTargets.has(originalUuid)) throw new Error('INVALID_ACCOUNTING_REVERSAL');
      reversalTargets.add(originalUuid);
    }
    const totals = new Map<string, { debit: number; credit: number; lines: number }>();
    for (const line of state.journalLines) {
      if (!isUuid(line.uuid) || lineUuids.has(line.uuid) || !entryUuids.has(line.journal_entry_uuid) || !accountUuids.has(line.account_uuid) ||
          !Number.isSafeInteger(line.debit_syp) || !Number.isSafeInteger(line.credit_syp) || (line.debit_syp > 0) === (line.credit_syp > 0) ||
          line.debit_syp < 0 || line.credit_syp < 0 || !validDate(line.created_at)) throw new Error('INVALID_ACCOUNTING_JOURNAL_LINE');
      lineUuids.add(line.uuid); const total = totals.get(line.journal_entry_uuid) ?? { debit: 0, credit: 0, lines: 0 };
      total.debit += line.debit_syp; total.credit += line.credit_syp; total.lines += 1;
      if (![total.debit, total.credit].every(Number.isSafeInteger)) throw new Error('INVALID_ACCOUNTING_JOURNAL_LINE'); totals.set(line.journal_entry_uuid, total);
    }
    if (state.journalEntries.some(entry => { const total = totals.get(entry.uuid); return !total || total.lines < 2 || total.debit <= 0 || total.debit !== total.credit; })) throw new Error('INVALID_ACCOUNTING_JOURNAL');
  }
  for (const product of payload.products) {
    if (!product || !isRecord(product) || !isUuid(product.uuid) || typeof product.name !== 'string' ||
        !product.name.trim() || typeof product.category !== 'string' || !product.category.trim() ||
        !finite(product.price_usd) || product.price_usd < 0 || !finite(product.cost_usd) || product.cost_usd < 0 ||
        !validDate(product.created_at) || !validDate(product.updated_at) ||
        (product.image_uri !== null && !isStoredProductImagePath(product.image_uri)) ||
        (product.barcode !== null && typeof product.barcode !== 'string')) {
      throw new Error('INVALID_PRODUCT');
    }
  }
  for (const category of payload.categories) {
    if (!category || !isRecord(category) || !isUuid(category.uuid) || typeof category.name !== 'string' ||
        !category.name.trim() || !validDate(category.created_at) || !validDate(category.updated_at)) {
      throw new Error('INVALID_CATEGORY');
    }
  }
  for (const balance of payload.inventoryBalances ?? []) {
    if (!isUuid(balance.product_uuid) || !Number.isSafeInteger(balance.quantity) || balance.quantity < 0 || ![0, 1].includes(balance.tracking_enabled) ||
        (balance.low_stock_threshold != null && (!Number.isSafeInteger(balance.low_stock_threshold) || balance.low_stock_threshold < 0)) || !validDate(balance.created_at) || !validDate(balance.updated_at)) throw new Error('INVALID_INVENTORY_BALANCE');
  }
  const purchaseItemByUuid = new Map((payload.purchaseReceipts ?? []).flatMap(receipt => receipt.items.map(item => [item.uuid, item] as const)));
  const purchaseReturnItemByUuid = new Map((payload.purchaseReturns ?? []).flatMap(record => record.items.map(item => [item.uuid, item] as const)));
  const purchaseReturnMovementRefs = new Set<string>();
  for (const movement of payload.inventoryMovements ?? []) {
    if (!isUuid(movement.uuid) || !isUuid(movement.product_uuid) || !isUuid(movement.product_uuid_snapshot) || !['opening','stock_in','stock_out','adjustment','sale','return','purchase','purchase_return'].includes(movement.movement_type) ||
        !Number.isSafeInteger(movement.quantity_delta) || movement.quantity_delta === 0 || !Number.isSafeInteger(movement.quantity_before) || !Number.isSafeInteger(movement.quantity_after) ||
        movement.quantity_before < 0 || movement.quantity_after < 0 || movement.quantity_after !== movement.quantity_before + movement.quantity_delta || !validDate(movement.created_at)) throw new Error('INVALID_INVENTORY_MOVEMENT');
    if (movement.purchase_receipt_item_uuid != null && !isUuid(movement.purchase_receipt_item_uuid)) throw new Error('INVALID_PURCHASE_REFERENCE');
    if (movement.purchase_return_item_uuid != null && !isUuid(movement.purchase_return_item_uuid)) throw new Error('INVALID_PURCHASE_RETURN_REFERENCE');
    if (movement.movement_type === 'purchase') {
      const item = movement.purchase_receipt_item_uuid ? purchaseItemByUuid.get(movement.purchase_receipt_item_uuid) : null;
      if (!item || movement.quantity_delta !== item.quantity || movement.product_uuid_snapshot !== item.product_uuid_snapshot) throw new Error('INVALID_PURCHASE_MOVEMENT');
    } else if (movement.purchase_receipt_item_uuid != null) throw new Error('INVALID_PURCHASE_MOVEMENT');
    if (movement.movement_type === 'purchase_return') {
      const item = movement.purchase_return_item_uuid ? purchaseReturnItemByUuid.get(movement.purchase_return_item_uuid) : null;
      if (!item || movement.quantity_delta !== -item.quantity || movement.product_uuid_snapshot !== item.product_uuid_snapshot) throw new Error('INVALID_PURCHASE_RETURN_MOVEMENT');
      if (purchaseReturnMovementRefs.has(item.uuid)) throw new Error('DUPLICATE_PURCHASE_RETURN_MOVEMENT');
      purchaseReturnMovementRefs.add(item.uuid);
    } else if (movement.purchase_return_item_uuid != null) throw new Error('INVALID_PURCHASE_RETURN_MOVEMENT');
  }
  if (purchaseReturnMovementRefs.size !== purchaseReturnItemByUuid.size) throw new Error('MISSING_PURCHASE_RETURN_MOVEMENT');
  const supplierUuids = new Set<string>();
  for (const supplier of payload.suppliers ?? []) {
    if (!isRecord(supplier) || !isUuid(supplier.uuid) || supplierUuids.has(supplier.uuid) || typeof supplier.name !== 'string' || !supplier.name.trim() || supplier.name.length > 120 ||
        (supplier.phone != null && (typeof supplier.phone !== 'string' || supplier.phone.length > 60)) ||
        (supplier.address != null && (typeof supplier.address !== 'string' || supplier.address.length > 240)) ||
        (supplier.note != null && (typeof supplier.note !== 'string' || supplier.note.length > 500)) || ![0, 1].includes(supplier.is_active) ||
        (supplier.accounting_enabled != null && ![0, 1].includes(supplier.accounting_enabled)) ||
        (supplier.accounting_started_at != null && !validDate(supplier.accounting_started_at)) ||
        !validDate(supplier.created_at) || !validDate(supplier.updated_at)) throw new Error('INVALID_SUPPLIER');
    supplierUuids.add(supplier.uuid);
  }
  const receiptUuids = new Set<string>(); const purchaseItemUuids = new Set<string>();
  for (const receipt of payload.purchaseReceipts ?? []) {
    if (!isRecord(receipt) || !isUuid(receipt.uuid) || receiptUuids.has(receipt.uuid) || !isUuid(receipt.supplier_uuid_snapshot) ||
        (receipt.supplier_uuid != null && !isUuid(receipt.supplier_uuid)) || typeof receipt.supplier_name_snapshot !== 'string' || !receipt.supplier_name_snapshot.trim() ||
        (receipt.reference_number != null && (typeof receipt.reference_number !== 'string' || receipt.reference_number.length > 120)) ||
        (receipt.note != null && (typeof receipt.note !== 'string' || receipt.note.length > 500)) || !validDate(receipt.received_at) || !validDate(receipt.created_at) || !Array.isArray(receipt.items) || !receipt.items.length) throw new Error('INVALID_PURCHASE_RECEIPT');
    receiptUuids.add(receipt.uuid);
    for (const item of receipt.items) {
      if (!isRecord(item) || !isUuid(item.uuid) || purchaseItemUuids.has(item.uuid) || !isUuid(item.product_uuid_snapshot) ||
          (item.product_uuid != null && !isUuid(item.product_uuid)) || typeof item.product_name_snapshot !== 'string' || !item.product_name_snapshot.trim() ||
          (item.barcode_snapshot != null && typeof item.barcode_snapshot !== 'string') || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 ||
          !Number.isSafeInteger(item.unit_cost_usd_cents) || item.unit_cost_usd_cents < 0 || !Number.isSafeInteger(item.line_total_usd_cents) ||
          item.line_total_usd_cents !== item.quantity * item.unit_cost_usd_cents || !validDate(item.created_at)) throw new Error('INVALID_PURCHASE_ITEM');
      purchaseItemUuids.add(item.uuid);
    }
  }
  const returnUuids = new Set<string>(); const purchaseReturnItemUuids = new Set<string>(); const cumulativeReturns = new Map<string, number>();
  const receiptByUuid = new Map((payload.purchaseReceipts ?? []).map(receipt => [receipt.uuid, receipt]));
  for (const record of payload.purchaseReturns ?? []) {
    const parentReceipt = receiptByUuid.get(record.purchase_receipt_uuid);
    if (!isRecord(record) || !isUuid(record.uuid) || returnUuids.has(record.uuid) || !parentReceipt || !isUuid(record.supplier_uuid_snapshot) || typeof record.supplier_name_snapshot !== 'string' || !record.supplier_name_snapshot.trim() ||
        !validDate(record.created_at) || !Number.isSafeInteger(record.total_quantity) || record.total_quantity <= 0 || !Number.isSafeInteger(record.total_value_usd_cents) || record.total_value_usd_cents < 0 ||
        (record.reference_number != null && (typeof record.reference_number !== 'string' || record.reference_number.length > 120)) || (record.note != null && (typeof record.note !== 'string' || record.note.length > 500)) || !Array.isArray(record.items) || !record.items.length) throw new Error('INVALID_PURCHASE_RETURN');
    returnUuids.add(record.uuid); let quantityTotal = 0; let valueTotal = 0;
    const parentItems = new Map(parentReceipt.items.map(item => [item.uuid, item]));
    for (const item of record.items) {
      const parent = parentItems.get(item.purchase_receipt_item_uuid);
      if (!isRecord(item) || !isUuid(item.uuid) || purchaseReturnItemUuids.has(item.uuid) || !parent || !isUuid(item.product_uuid_snapshot) || item.product_uuid_snapshot !== parent.product_uuid_snapshot || typeof item.product_name_snapshot !== 'string' || !item.product_name_snapshot.trim() ||
          !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || !Number.isSafeInteger(item.unit_cost_usd_cents) || item.unit_cost_usd_cents !== parent.unit_cost_usd_cents || !Number.isSafeInteger(item.line_total_usd_cents) || item.line_total_usd_cents !== item.quantity * item.unit_cost_usd_cents || !validDate(item.created_at)) throw new Error('INVALID_PURCHASE_RETURN_ITEM');
      purchaseReturnItemUuids.add(item.uuid); const cumulative = (cumulativeReturns.get(item.purchase_receipt_item_uuid) ?? 0) + item.quantity;
      if (cumulative > parent.quantity) throw new Error('PURCHASE_OVER_RETURN'); cumulativeReturns.set(item.purchase_receipt_item_uuid, cumulative);
      quantityTotal += item.quantity; valueTotal += item.line_total_usd_cents;
    }
    if (quantityTotal !== record.total_quantity || valueTotal !== record.total_value_usd_cents) throw new Error('INVALID_PURCHASE_RETURN_TOTAL');
  }
  const supplierByUuid = new Map((payload.suppliers ?? []).map(supplier => [supplier.uuid, supplier]));
  const supplierPaymentByUuid = new Map<string, NonNullable<ImportPayload['supplierPayments']>[number]>();
  const supplierPaymentSypBySession = new Map<string, number>(); const supplierPaymentUsdBySession = new Map<string, number>();
  for (const payment of payload.supplierPayments ?? []) {
    if (!isUuid(payment.uuid) || supplierPaymentByUuid.has(payment.uuid) || !supplierByUuid.has(payment.supplier_uuid) || !isUuid(payment.cash_session_uuid) || !['SYP','USD','MIXED'].includes(payment.payment_mode) ||
        !Number.isSafeInteger(payment.total_usd_equivalent_cents) || payment.total_usd_equivalent_cents <= 0 || !validDate(payment.occurred_at) || !validDate(payment.created_at) || !Array.isArray(payment.tenders) || !payment.tenders.length || !Number.isSafeInteger(payment.balance_after_usd_cents) ||
        typeof payment.supplier_name_snapshot !== 'string' || !payment.supplier_name_snapshot.trim() || (payment.note != null && (typeof payment.note !== 'string' || payment.note.length > 500)) ||
        (payment.payment_mode === 'USD' ? payment.exchange_rate_syp_per_usd != null : !Number.isSafeInteger(payment.exchange_rate_syp_per_usd) || (payment.exchange_rate_syp_per_usd ?? 0) <= 0)) throw new Error('INVALID_SUPPLIER_PAYMENT');
    let total = 0; let syp = 0; let usd = 0; const currencies = new Set<string>();
    for (const tender of payment.tenders) {
      if (!isUuid(tender.uuid) || currencies.has(tender.currency) || !['SYP','USD'].includes(tender.currency) || !Number.isSafeInteger(tender.amount_minor) || tender.amount_minor <= 0 || !Number.isSafeInteger(tender.usd_equivalent_cents) || tender.usd_equivalent_cents <= 0 || !validDate(tender.created_at)) throw new Error('INVALID_SUPPLIER_PAYMENT_TENDER');
      if (tender.currency === 'USD' ? tender.amount_minor !== tender.usd_equivalent_cents || tender.exchange_rate_syp_per_usd != null : !Number.isSafeInteger(tender.exchange_rate_syp_per_usd) || tender.exchange_rate_syp_per_usd !== payment.exchange_rate_syp_per_usd) throw new Error('INVALID_SUPPLIER_PAYMENT_TENDER');
      currencies.add(tender.currency); total += tender.usd_equivalent_cents;
      if (tender.currency === 'SYP') syp += tender.amount_minor; else usd += tender.amount_minor;
    }
    const mode = syp > 0 && usd > 0 ? 'MIXED' : usd > 0 ? 'USD' : 'SYP';
    if (mode !== payment.payment_mode || total !== payment.total_usd_equivalent_cents) throw new Error('INVALID_SUPPLIER_PAYMENT_TOTAL');
    supplierPaymentByUuid.set(payment.uuid, payment);
    supplierPaymentSypBySession.set(payment.cash_session_uuid, (supplierPaymentSypBySession.get(payment.cash_session_uuid) ?? 0) + syp);
    supplierPaymentUsdBySession.set(payment.cash_session_uuid, (supplierPaymentUsdBySession.get(payment.cash_session_uuid) ?? 0) + usd);
  }
  const entrySumBySupplier = new Map<string, number>(); const entrySourceKeys = new Set<string>(); const entryUuids = new Set<string>(); const openingCountBySupplier = new Map<string, number>(); const runningBySupplier = new Map<string, number>();
  for (const entry of payload.supplierAccountEntries ?? []) {
    if (!isUuid(entry.uuid) || entryUuids.has(entry.uuid) || !supplierByUuid.has(entry.supplier_uuid) || !['opening','purchase','purchase_return','payment'].includes(entry.type) || !Number.isSafeInteger(entry.delta_usd_cents) || !validDate(entry.occurred_at) || !validDate(entry.created_at)) throw new Error('INVALID_SUPPLIER_ACCOUNT_ENTRY');
    entryUuids.add(entry.uuid);
    const sources = [entry.purchase_receipt_uuid, entry.purchase_return_uuid, entry.supplier_payment_uuid].filter(Boolean);
    if ((entry.type === 'opening' && sources.length) || (entry.type !== 'opening' && sources.length !== 1)) throw new Error('INVALID_SUPPLIER_ACCOUNT_ENTRY');
    const sourceKey = `${entry.type}:${sources[0] ?? entry.supplier_uuid}`; if (entrySourceKeys.has(sourceKey)) throw new Error('DUPLICATE_SUPPLIER_ACCOUNT_SOURCE'); entrySourceKeys.add(sourceKey);
    if (entry.type === 'opening') openingCountBySupplier.set(entry.supplier_uuid, (openingCountBySupplier.get(entry.supplier_uuid) ?? 0) + 1);
    if (entry.type === 'purchase') { const receipt = (payload.purchaseReceipts ?? []).find(item => item.uuid === entry.purchase_receipt_uuid); const value = receipt?.items.reduce((sum, item) => sum + item.line_total_usd_cents, 0); if (value == null || entry.delta_usd_cents !== value) throw new Error('INVALID_SUPPLIER_ACCOUNT_ENTRY'); }
    if (entry.type === 'purchase_return') { const record = (payload.purchaseReturns ?? []).find(item => item.uuid === entry.purchase_return_uuid); if (!record || entry.delta_usd_cents !== -record.total_value_usd_cents) throw new Error('INVALID_SUPPLIER_ACCOUNT_ENTRY'); }
    if (entry.type === 'payment') { const payment = entry.supplier_payment_uuid ? supplierPaymentByUuid.get(entry.supplier_payment_uuid) : null; if (!payment || entry.delta_usd_cents !== -payment.total_usd_equivalent_cents) throw new Error('INVALID_SUPPLIER_ACCOUNT_ENTRY'); }
    const running = (runningBySupplier.get(entry.supplier_uuid) ?? 0) + entry.delta_usd_cents;
    if (!Number.isSafeInteger(running)) throw new Error('INVALID_SUPPLIER_ACCOUNT_ENTRY');
    if (entry.type === 'payment' && supplierPaymentByUuid.get(entry.supplier_payment_uuid!)?.balance_after_usd_cents !== running) throw new Error('SUPPLIER_PAYMENT_BALANCE_MISMATCH');
    runningBySupplier.set(entry.supplier_uuid, running);
    entrySumBySupplier.set(entry.supplier_uuid, (entrySumBySupplier.get(entry.supplier_uuid) ?? 0) + entry.delta_usd_cents);
  }
  const balancedSuppliers = new Set<string>();
  for (const balance of payload.supplierAccountBalances ?? []) {
    const supplier = supplierByUuid.get(balance.supplier_uuid);
    if (!supplier || !supplier.accounting_enabled || balancedSuppliers.has(balance.supplier_uuid) || !Number.isSafeInteger(balance.balance_usd_cents) || balance.balance_usd_cents !== (entrySumBySupplier.get(balance.supplier_uuid) ?? 0) || !validDate(balance.updated_at)) throw new Error('SUPPLIER_ACCOUNT_BALANCE_MISMATCH');
    balancedSuppliers.add(balance.supplier_uuid);
  }
  for (const supplier of payload.suppliers ?? []) {
    const enabled = supplier.accounting_enabled ?? 0;
    if (enabled && (!balancedSuppliers.has(supplier.uuid) || openingCountBySupplier.get(supplier.uuid) !== 1 || !supplier.accounting_started_at)) throw new Error('SUPPLIER_ACCOUNT_INCOMPLETE');
    if (!enabled && (balancedSuppliers.has(supplier.uuid) || entrySumBySupplier.has(supplier.uuid) || supplier.accounting_started_at != null)) throw new Error('SUPPLIER_ACCOUNT_INACTIVE_DATA');
  }
  for (const sale of payload.sales) {
    const onAccountSyp = sale?.on_account_syp ?? 0;
    if (!sale || !isRecord(sale) || !isUuid(sale.uuid) || typeof sale.invoice_number !== 'string' ||
        !sale.invoice_number.trim() || !validDate(sale.created_at) || !validDate(sale.updated_at) ||
        !finite(sale.exchange_rate) || sale.exchange_rate <= 0 || !finite(sale.subtotal_syp) || !finite(sale.discount_syp) ||
        !finite(sale.net_total_syp) || !finite(sale.cost_syp) || !finite(sale.profit_syp) || !Array.isArray(sale.items) ||
        !isValidImportedSaleSettlement(sale.net_total_syp, onAccountSyp, sale.amount_paid_syp) ||
        (onAccountSyp > 0 && (!isUuid(sale.customer_uuid_snapshot) || typeof sale.customer_name_snapshot !== 'string' || !sale.customer_name_snapshot.trim())) ||
        (sale.change_syp != null && (!finite(sale.change_syp) || sale.change_syp < 0))) {
      throw new Error('INVALID_SALE');
    }
    if (sale.cash_session_uuid != null && !isUuid(sale.cash_session_uuid)) throw new Error('INVALID_CASH_SESSION_REFERENCE');
    for (const item of sale.items) {
      if (!item || !isRecord(item) || !isUuid(item.uuid) || typeof item.product_name !== 'string' ||
          !finite(item.quantity) || item.quantity <= 0 || !finite(item.unit_price_syp) ||
          !finite(item.unit_cost_syp) || !finite(item.line_total_syp) || !finite(item.line_cost_syp) ||
          (item.barcode_snapshot != null && typeof item.barcode_snapshot !== 'string') ||
          !validDate(item.created_at) || !validDate(item.updated_at)) throw new Error('INVALID_SALE_ITEM');
    }
  }
  const saleByUuid = new Map(payload.sales.map(sale => [sale.uuid, sale]));
  const paymentCurrencies = new Set<string>();
  const paymentUuids = new Set<string>();
  const paymentTotals = new Map<string, number>();
  for (const payment of payload.salePayments ?? []) {
    if (!isRecord(payment) || !isUuid(payment.uuid) || !isUuid(payment.sale_uuid) || !['SYP', 'USD'].includes(payment.currency) ||
        !Number.isSafeInteger(payment.amount_minor) || payment.amount_minor < 0 || !Number.isSafeInteger(payment.syp_equivalent) || payment.syp_equivalent < 0 || !validDate(payment.created_at)) throw new Error('INVALID_SALE_PAYMENT');
    const sale = saleByUuid.get(payment.sale_uuid); if (!sale) throw new Error('PAYMENT_PARENT_MISSING');
    if (paymentUuids.has(payment.uuid)) throw new Error('DUPLICATE_SALE_PAYMENT'); paymentUuids.add(payment.uuid);
    if (payment.currency === 'SYP' ? payment.exchange_rate_syp_per_usd != null || payment.amount_minor !== payment.syp_equivalent
      : !Number.isSafeInteger(payment.exchange_rate_syp_per_usd) || payment.exchange_rate_syp_per_usd !== sale.exchange_rate || usdCentsToSyp(payment.amount_minor, payment.exchange_rate_syp_per_usd) !== payment.syp_equivalent) throw new Error('INVALID_SALE_PAYMENT');
    const key = `${payment.sale_uuid}:${payment.currency}`; if (paymentCurrencies.has(key)) throw new Error('DUPLICATE_SALE_PAYMENT'); paymentCurrencies.add(key);
    paymentTotals.set(payment.sale_uuid, (paymentTotals.get(payment.sale_uuid) ?? 0) + payment.syp_equivalent);
  }
  for (const [saleUuid, tender] of paymentTotals) { const sale = saleByUuid.get(saleUuid)!; if (!isValidImportedSalePaymentRows(sale.net_total_syp, sale.on_account_syp ?? 0, tender, sale.change_syp ?? 0)) throw new Error('PAYMENT_SETTLEMENT_CONFLICT'); }
  for (const draft of payload.drafts ?? []) {
    if (!draft || !isRecord(draft) || !isUuid(draft.uuid) || !validDate(draft.created_at) || !validDate(draft.updated_at) ||
        !finite(draft.exchange_rate) || draft.exchange_rate <= 0 || !finite(draft.discount_syp) || draft.discount_syp < 0 || !Array.isArray(draft.items)) {
      throw new Error('INVALID_SALE_DRAFT');
    }
    for (const item of draft.items) {
      if (!item || !isRecord(item) || !isUuid(item.uuid) || typeof item.product_name !== 'string' ||
          !finite(item.quantity) || item.quantity <= 0 || !finite(item.unit_price_syp) || item.unit_price_syp < 0 ||
          !finite(item.unit_cost_syp) || item.unit_cost_syp < 0 || (item.barcode_snapshot != null && typeof item.barcode_snapshot !== 'string') ||
          !validDate(item.created_at) || !validDate(item.updated_at)) {
        throw new Error('INVALID_SALE_DRAFT_ITEM');
      }
    }
  }
  for (const record of payload.returns ?? []) {
    const customerAccountCreditSyp = record?.customer_account_credit_syp ?? 0;
    if (!isRecord(record) || !isUuid(record.uuid) || !isUuid(record.sale_uuid) || !Number.isSafeInteger(record.refund_total_syp) || record.refund_total_syp < 0 ||
        !Number.isSafeInteger(record.returned_cost_syp) || record.returned_cost_syp < 0 || !Number.isSafeInteger(customerAccountCreditSyp) || customerAccountCreditSyp < 0 || customerAccountCreditSyp > record.refund_total_syp ||
        !validDate(record.created_at) || !validDate(record.updated_at) || !Array.isArray(record.items)) throw new Error('INVALID_RETURN');
    if (record.cash_session_uuid != null && !isUuid(record.cash_session_uuid)) throw new Error('INVALID_CASH_SESSION_REFERENCE');
    const seenReturnItems = new Set<string>(); const seenParentItems = new Set<string>();
    for (const item of record.items) {
      if (!isRecord(item) || !isUuid(item.uuid) || !isUuid(item.sale_item_uuid) || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 ||
          !Number.isSafeInteger(item.refund_amount_syp) || item.refund_amount_syp < 0 || !Number.isSafeInteger(item.cost_reversal_syp) || item.cost_reversal_syp < 0 ||
          !validDate(item.created_at) || !validDate(item.updated_at)) throw new Error('INVALID_RETURN_ITEM');
      if (seenReturnItems.has(item.uuid) || seenParentItems.has(item.sale_item_uuid)) throw new Error('DUPLICATE_RETURN_ITEM');
      seenReturnItems.add(item.uuid); seenParentItems.add(item.sale_item_uuid);
    }
  }
  for (const expense of payload.expenses) {
    if (!expense || !isRecord(expense) || !isUuid(expense.uuid) || typeof expense.description !== 'string' ||
        !finite(expense.amount_syp) || expense.amount_syp < 0 ||
        !validDate(expense.created_at) || !validDate(expense.updated_at)) throw new Error('INVALID_EXPENSE');
    if (expense.category_uuid != null && !isUuid(expense.category_uuid)) throw new Error('INVALID_EXPENSE_CATEGORY_REFERENCE');
    if (expense.cash_session_uuid != null && !isUuid(expense.cash_session_uuid)) throw new Error('INVALID_CASH_SESSION_REFERENCE');
    if (expense.note != null && (typeof expense.note !== 'string' || expense.note.length > 240)) throw new Error('INVALID_EXPENSE_NOTE');
  }
  for (const category of payload.expenseCategories ?? []) {
    if (!isRecord(category) || !isUuid(category.uuid) || typeof category.name_ar !== 'string' || !category.name_ar.trim() || category.name_ar.length > 60 ||
        (category.name_en != null && (typeof category.name_en !== 'string' || category.name_en.length > 60)) || ![0, 1].includes(category.is_system) || ![0, 1].includes(category.is_active) ||
        !validDate(category.created_at) || !validDate(category.updated_at)) throw new Error('INVALID_EXPENSE_CATEGORY');
  }
  for (const entry of payload.exchangeRateHistory ?? []) {
    if (!isRecord(entry) || !isUuid(entry.uuid) || !finite(entry.old_rate) || entry.old_rate <= 0 || !finite(entry.new_rate) || entry.new_rate <= 0 || !validDate(entry.created_at)) throw new Error('INVALID_EXCHANGE_RATE_HISTORY');
  }
  const openSessions = (payload.cashSessions ?? []).filter(session => session.closed_at == null);
  if (openSessions.length > 1) throw new Error('MULTIPLE_OPEN_CASH_SESSIONS');
  const customerPaymentSypBySession = new Map<string, number>(); const customerPaymentUsdBySession = new Map<string, number>();
  for (const payment of payload.customerPayments ?? []) for (const tender of payment.tenders) {
    const map = tender.currency === 'SYP' ? customerPaymentSypBySession : customerPaymentUsdBySession;
    map.set(payment.cash_session_uuid, (map.get(payment.cash_session_uuid) ?? 0) + tender.amount_minor);
  }
  const cashRefundsBySession = new Map<string, number>();
  for (const record of payload.returns ?? []) if (record.cash_session_uuid) {
    const cashRefund = record.refund_total_syp - (record.customer_account_credit_syp ?? 0);
    cashRefundsBySession.set(record.cash_session_uuid, (cashRefundsBySession.get(record.cash_session_uuid) ?? 0) + cashRefund);
  }
  const seenCashSessions = new Set<string>();
  for (const session of payload.cashSessions ?? []) {
    if (!isRecord(session) || !isUuid(session.uuid) || !validDate(session.opened_at) || !validDate(session.created_at) || !validDate(session.updated_at) ||
        (session.closed_at != null && !validDate(session.closed_at)) || !Number.isSafeInteger(session.opening_cash_syp) || session.opening_cash_syp < 0 ||
        (session.closing_actual_cash_syp != null && (!Number.isSafeInteger(session.closing_actual_cash_syp) || session.closing_actual_cash_syp < 0)) ||
        (session.opening_note != null && (typeof session.opening_note !== 'string' || session.opening_note.length > 240)) ||
        (session.closing_note != null && (typeof session.closing_note !== 'string' || session.closing_note.length > 240))) throw new Error('INVALID_CASH_SESSION');
    if (seenCashSessions.has(session.uuid)) throw new Error('DUPLICATE_CASH_SESSION');
    seenCashSessions.add(session.uuid);
    const closingValues = [session.closing_actual_cash_syp, session.closing_sales_total_syp, session.closing_refunds_total_syp,
      session.closing_expenses_total_syp, session.closing_expected_cash_syp, session.closing_difference_syp];
    if (session.closed_at == null) {
      if (closingValues.some(value => value != null) || session.closing_note != null) throw new Error('INVALID_OPEN_CASH_SESSION');
      continue;
    }
    if (Date.parse(session.closed_at) < Date.parse(session.opened_at) || closingValues.some(value => !Number.isSafeInteger(value)) ||
        (session.closing_actual_cash_syp ?? -1) < 0 || (session.closing_sales_total_syp ?? -1) < 0 ||
        (session.closing_refunds_total_syp ?? -1) < 0 || (session.closing_expenses_total_syp ?? -1) < 0) throw new Error('INVALID_CLOSED_CASH_SESSION');
    const hasV13Snapshot = Number.isSafeInteger(session.closing_cash_received_syp) && Number.isSafeInteger(session.closing_change_given_syp);
      const supplierSyp = session.closing_supplier_payments_syp ?? 0; const supplierUsd = session.closing_supplier_payments_usd_cents ?? 0;
      const customerSyp = session.closing_customer_payments_syp ?? 0; const customerUsd = session.closing_customer_payments_usd_cents ?? 0;
      if (supplierSyp !== (supplierPaymentSypBySession.get(session.uuid) ?? 0) || supplierUsd !== (supplierPaymentUsdBySession.get(session.uuid) ?? 0)) throw new Error('INVALID_CASH_SESSION_SUPPLIER_PAYMENT_SNAPSHOT');
      if (customerSyp !== (customerPaymentSypBySession.get(session.uuid) ?? 0) || customerUsd !== (customerPaymentUsdBySession.get(session.uuid) ?? 0)) throw new Error('INVALID_CASH_SESSION_CUSTOMER_PAYMENT_SNAPSHOT');
      const expected = hasV13Snapshot
      ? calculateExpectedCashWithSettlements(session.opening_cash_syp, session.closing_cash_received_syp!, session.closing_change_given_syp!, cashRefundsBySession.get(session.uuid) ?? 0, session.closing_expenses_total_syp!, supplierSyp, customerSyp)
      : calculateExpectedCash(session.opening_cash_syp, session.closing_sales_total_syp!, session.closing_refunds_total_syp!, session.closing_expenses_total_syp!);
    const difference = calculateCashDifference(session.closing_actual_cash_syp!, expected);
    if (session.closing_expected_cash_syp !== expected || session.closing_difference_syp !== difference) throw new Error('INVALID_CASH_SESSION_SNAPSHOT');
    if (hasV13Snapshot) {
      const expectedUsd = (session.opening_cash_usd_cents ?? 0) + (session.closing_cash_received_usd_cents ?? 0) - supplierUsd + customerUsd;
      if (session.closing_expected_cash_usd_cents !== expectedUsd || session.closing_difference_usd_cents !== (session.closing_actual_cash_usd_cents! - expectedUsd)) throw new Error('INVALID_CASH_SESSION_SNAPSHOT');
    }
  }
  for (const payment of payload.supplierPayments ?? []) if (!seenCashSessions.has(payment.cash_session_uuid)) throw new Error('SUPPLIER_PAYMENT_SESSION_MISSING');
  const settings = payload.settings;
  if (!isRecord(settings) || Object.keys(settings).some(key => !SETTING_KEYS.includes(key as typeof SETTING_KEYS[number])) ||
      !finite(settings.exchangeRate) || settings.exchangeRate <= 0 ||
      typeof settings.isRoundingEnabled !== 'boolean' ||
      ![5, 10, 500, 1000].includes(settings.roundingTarget) ||
      !['ar', 'en'].includes(settings.language)) throw new Error('INVALID_SETTINGS');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
