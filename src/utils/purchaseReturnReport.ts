import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Language, PurchaseReturn } from '@/types';
import { formatUsdCents } from '@/utils/multiCurrency';
import { uiText } from '@/i18n';
import { formatNumber } from '@/utils/formatters';
import { formatReportDateTime, REPORT_NUMERIC_CSS } from '@/utils/reportFormatting';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);

export async function sharePurchaseReturn(record: PurchaseReturn, language: Language) {
  const rtl = language === 'ar'; const copy = uiText(language); const title = copy.purchase.returnDocument;
  const rows = (record.items ?? []).map(item => `<tr><td>${escapeHtml(item.product_name_snapshot)}</td><td class="num">${formatNumber(item.quantity, language)}</td><td class="money">${formatUsdCents(item.unit_cost_usd_cents, 'en')}</td><td class="money">${formatUsdCents(item.line_total_usd_cents, 'en')}</td></tr>`).join('');
  const html = `<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>${REPORT_NUMERIC_CSS} body{font-family:Arial,sans-serif;color:midnightblue;padding:28px}h1{font-size:24px}p{margin:6px 0}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:10px;border-bottom:1px solid gainsboro;text-align:${rtl ? 'right' : 'left'}}.total{font-size:18px;font-weight:700;margin-top:18px}.note{color:slategray;margin-top:24px}</style></head><body><h1>${title}</h1><p>${copy.purchase.returnId}: <span class="id">${escapeHtml(record.uuid)}</span></p><p>${copy.purchase.originalReceipt}: <span class="id">${escapeHtml(record.purchase_receipt_uuid ?? '')}</span></p><p>${copy.purchase.supplier}: ${escapeHtml(record.supplier_name_snapshot)}</p><p>${copy.purchase.reportDate}: <span class="num">${escapeHtml(formatReportDateTime(record.created_at, language))}</span></p>${record.reference_number ? `<p>${copy.purchase.referenceNumber}: <span class="id">${escapeHtml(record.reference_number)}</span></p>` : ''}<table><thead><tr><th>${copy.purchase.reportProduct}</th><th>${copy.purchase.reportQuantity}</th><th>${copy.purchase.unitCost}</th><th>${copy.purchase.reportLineTotal}</th></tr></thead><tbody>${rows}</tbody></table><p class="total num">${copy.purchase.totalQuantity}: ${formatNumber(record.total_quantity, language)}</p><p class="total money">${copy.purchase.historicalValue}: ${formatUsdCents(record.total_value_usd_cents, 'en')}</p><p class="note">${copy.purchase.informationalValue}</p></body></html>`;
  const file = await Print.printToFileAsync({ html });
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', dialogTitle: title });
  return file.uri;
}
