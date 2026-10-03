import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import type { Language, Supplier, SupplierAccountEntry, SupplierPayment } from '@/types';
import { uiText } from '@/i18n';
import { formatUsdCents } from '@/utils/multiCurrency';
import { lightColors } from '@/theme/colors';
import { formatNumber } from '@/utils/formatters';
import { formatReportDateTime, REPORT_NUMERIC_CSS } from '@/utils/reportFormatting';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
const date = formatReportDateTime;
const shell = (body: string, rtl: boolean) => `<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>${REPORT_NUMERIC_CSS} body{font-family:Arial,sans-serif;color:${lightColors.textPrimary};padding:28px}h1{font-size:24px}p{margin:6px 0}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:9px;border-bottom:1px solid ${lightColors.border};text-align:${rtl ? 'right' : 'left'}}.money{white-space:nowrap}.total{font-size:18px;font-weight:700;margin-top:18px}</style></head><body>${body}</body></html>`;

async function share(html: string, title: string) {
  const file = await Print.printToFileAsync({ html });
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', dialogTitle: title });
  return file.uri;
}

export async function shareSupplierPayment(payment: SupplierPayment, language: Language) {
  const copy = uiText(language); const rtl = language === 'ar';
  const tenders = (payment.tenders ?? []).map(tender => `<tr><td>${tender.currency}</td><td class="money">${tender.currency === 'USD' ? formatUsdCents(tender.amount_minor, 'en') : `${formatNumber(tender.amount_minor, language)} SYP`}</td><td class="money">${formatUsdCents(tender.usd_equivalent_cents, 'en')}</td></tr>`).join('');
  return share(shell(`<h1>${copy.purchase.paymentHistory}</h1><p>${copy.purchase.supplier}: ${escapeHtml(payment.supplier_name_snapshot)}</p><p>${copy.purchase.reportDate}: <span class="num">${escapeHtml(date(payment.occurred_at, language))}</span></p><p>${copy.purchase.reference}: <span class="id">${escapeHtml(payment.uuid)}</span></p><p>${copy.purchase.paymentMode}: ${payment.payment_mode}</p>${payment.exchange_rate_syp_per_usd ? `<p>${copy.purchase.exchangeSnapshot}: <span class="money">${formatNumber(payment.exchange_rate_syp_per_usd, language)} SYP/USD</span></p>` : ''}<table><thead><tr><th>${copy.purchase.paymentMode}</th><th>${copy.purchase.totalValue}</th><th>${copy.purchase.usdEquivalent}</th></tr></thead><tbody>${tenders}</tbody></table><p class="total money">${copy.purchase.usdEquivalent}: ${formatUsdCents(payment.total_usd_equivalent_cents, 'en')}</p><p class="money">${copy.purchase.newBalance}: ${formatUsdCents(payment.balance_after_usd_cents, 'en')}</p>${payment.note ? `<p>${escapeHtml(payment.note)}</p>` : ''}`, rtl), copy.purchase.sharePayment);
}

export async function shareSupplierStatement(supplier: Supplier, entries: SupplierAccountEntry[], language: Language) {
  const copy = uiText(language); const rtl = language === 'ar'; const ordered = [...entries].reverse();
  const rows = ordered.map(entry => `<tr><td class="num">${escapeHtml(date(entry.occurred_at, language))}</td><td>${escapeHtml(({ opening: copy.purchase.accountOpening, purchase: copy.purchase.accountPurchase, purchase_return: copy.purchase.accountReturn, payment: copy.purchase.accountPayment })[entry.type])}</td><td class="id">${escapeHtml(entry.reference?.slice(0, 8) ?? '—')}</td><td class="money">${formatUsdCents(entry.delta_usd_cents, 'en')}</td><td class="money">${formatUsdCents(entry.running_balance_usd_cents ?? 0, 'en')}</td></tr>`).join('');
  const opening = ordered.length ? (ordered[0]!.running_balance_usd_cents ?? ordered[0]!.delta_usd_cents) - ordered[0]!.delta_usd_cents : 0;
  const purchases = ordered.filter(entry => entry.type === 'purchase').reduce((sum, entry) => sum + entry.delta_usd_cents, 0);
  const returns = -ordered.filter(entry => entry.type === 'purchase_return').reduce((sum, entry) => sum + entry.delta_usd_cents, 0);
  const payments = -ordered.filter(entry => entry.type === 'payment').reduce((sum, entry) => sum + entry.delta_usd_cents, 0);
  const closing = ordered.at(-1)?.running_balance_usd_cents ?? 0;
  const period = ordered.length ? `${date(ordered[0]!.occurred_at, language)} — ${date(ordered.at(-1)!.occurred_at, language)}` : '—';
  return share(shell(`<h1>${copy.purchase.accountStatement}</h1><p>${copy.purchase.supplier}: ${escapeHtml(supplier.name)}</p><p>${copy.purchase.period}: ${escapeHtml(period)}</p><p class="money">${copy.purchase.accountOpening}: ${formatUsdCents(opening, 'en')}</p><p class="money">${copy.purchase.totalPurchases}: ${formatUsdCents(purchases, 'en')}</p><p class="money">${copy.purchase.returnedGoodsValue}: ${formatUsdCents(returns, 'en')}</p><p class="money">${copy.purchase.totalPayments}: ${formatUsdCents(payments, 'en')}</p><table><thead><tr><th>${copy.purchase.reportDate}</th><th>${copy.purchase.paymentMode}</th><th>${copy.purchase.reference}</th><th>${copy.purchase.totalValue}</th><th>${copy.purchase.currentBalance}</th></tr></thead><tbody>${rows}</tbody></table><p class="total money">${copy.purchase.currentBalance}: ${formatUsdCents(closing, 'en')}</p>`, rtl), copy.purchase.shareStatement);
}
