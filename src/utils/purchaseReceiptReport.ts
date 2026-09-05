import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Language, PurchaseReceipt } from '@/types';
import { formatUsdCents } from '@/utils/multiCurrency';
import { uiText } from '@/i18n';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);

export async function sharePurchaseReceipt(receipt: PurchaseReceipt, language: Language) {
  const rtl = language === 'ar';
  const copy = uiText(language); const title = copy.purchase.reportTitle;
  const rows = (receipt.items ?? []).map(item => `<tr><td>${escapeHtml(item.product_name_snapshot)}</td><td>${item.quantity}</td><td>${formatUsdCents(item.unit_cost_usd_cents, 'en')}</td><td>${formatUsdCents(item.line_total_usd_cents, 'en')}</td></tr>`).join('');
  const html = `<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;color:midnightblue;padding:28px}h1{font-size:24px}p{margin:6px 0}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:10px;border-bottom:1px solid gainsboro;text-align:${rtl ? 'right' : 'left'}}.total{font-size:18px;font-weight:700;margin-top:18px}</style></head><body><h1>${title}</h1><p>${copy.purchase.supplier}: ${escapeHtml(receipt.supplier_name_snapshot)}</p><p>${copy.purchase.reportDate}: ${escapeHtml(new Date(receipt.received_at).toLocaleString(rtl ? 'ar-SY' : 'en-US'))}</p>${receipt.reference_number ? `<p>${copy.purchase.referenceNumber}: ${escapeHtml(receipt.reference_number)}</p>` : ''}<table><thead><tr><th>${copy.purchase.reportProduct}</th><th>${copy.purchase.reportQuantity}</th><th>${copy.purchase.unitCost}</th><th>${copy.purchase.reportLineTotal}</th></tr></thead><tbody>${rows}</tbody></table><p class="total">${copy.purchase.totalValue}: ${formatUsdCents(receipt.total_cost_usd_cents, 'en')}</p></body></html>`;
  const file = await Print.printToFileAsync({ html });
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', dialogTitle: title });
  return file.uri;
}
