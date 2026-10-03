import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import type { Language, Sale, SaleReturn } from '@/types';
import { formatNumber } from '@/utils/formatters';
import { formatReportDateTime, formatReportSyp, REPORT_NUMERIC_CSS } from '@/utils/reportFormatting';

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function shareReturnReceiptPdf(record: SaleReturn, sale: Sale, language: Language) {
  const rtl = language === 'ar';
  const money = (value: number) => formatReportSyp(value, language, rtl ? 'ل.س' : 'SYP');
  const accountCredit = record.customer_account_credit_syp ?? 0;
  const cashRefund = record.refund_total_syp - accountCredit;
  const rows = record.items.map(item => `<tr><td>${escapeHtml(item.product_name)}</td><td class="num">${formatNumber(item.quantity, language)}</td><td class="money">${money(item.refund_amount_syp)}</td></tr>`).join('');
  const html = `<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>
  ${REPORT_NUMERIC_CSS} body{font-family:Arial,sans-serif;color:#151b2b;padding:32px}header{border-bottom:3px solid #b52d67;padding-bottom:18px}h1{margin:0;color:#542250}.meta{color:#697386;margin-top:7px}table{width:100%;border-collapse:collapse;margin-top:24px}th{background:#151b2b;color:#fff}th,td{padding:11px;text-align:${rtl ? 'right' : 'left'};border-bottom:1px solid #dce4ee}.total{display:flex;justify-content:space-between;margin-top:24px;padding-top:12px;border-top:2px solid #08796d;color:#08796d;font-size:20px;font-weight:bold}
  </style></head><body><header><h1>${rtl ? 'إيصال مرتجع' : 'Return receipt'}</h1><div class="meta"><span class="id">Return ${escapeHtml(record.uuid)}</span><br>${rtl ? 'الفاتورة الأصلية' : 'Original invoice'} <span class="id">${escapeHtml(sale.invoice_number)}</span><br><span class="num">${formatReportDateTime(record.created_at, language)}</span></div></header>
  <table><thead><tr><th>${rtl ? 'المنتج' : 'Product'}</th><th>${rtl ? 'الكمية' : 'Qty'}</th><th>${rtl ? 'الاسترداد' : 'Refund'}</th></tr></thead><tbody>${rows}</tbody></table><div class="total"><span>${rtl ? 'إجمالي الاسترداد' : 'Total refund'}</span><span>${money(record.refund_total_syp)}</span></div>${accountCredit > 0 ? `<div class="total"><span>${rtl ? 'إضافة إلى حساب العميل' : 'Customer account credit'}</span><span>${money(accountCredit)}</span></div><div class="total"><span>${rtl ? 'الاسترداد النقدي' : 'Cash refund'}</span><span>${money(cashRefund)}</span></div>` : ''}</body></html>`;
  const result = await Print.printToFileAsync({ html });
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(result.uri, { mimeType: 'application/pdf', dialogTitle: `return-${record.uuid.slice(0, 8)}.pdf`, UTI: 'com.adobe.pdf' });
  return result.uri;
}
