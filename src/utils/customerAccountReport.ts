import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import type { Customer, CustomerAccountEntry, CustomerPayment, Language } from '@/types';
import { uiText } from '@/i18n';
import { formatUsdCents } from '@/utils/multiCurrency';
import { lightColors } from '@/theme/colors';
import { formatNumber } from '@/utils/formatters';
import { formatReportDateTime, formatReportSyp, REPORT_NUMERIC_CSS } from '@/utils/reportFormatting';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
const date = formatReportDateTime;
const shell = (body: string, rtl: boolean) => `<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>${REPORT_NUMERIC_CSS} body{font-family:Arial,sans-serif;color:${lightColors.textPrimary};padding:28px}h1{font-size:24px}p{margin:6px 0}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:9px;border-bottom:1px solid ${lightColors.border};text-align:${rtl ? 'right' : 'left'}}.money{white-space:nowrap}.total{font-size:18px;font-weight:700;margin-top:18px}</style></head><body>${body}</body></html>`;

async function share(html: string, title: string) {
  const file = await Print.printToFileAsync({ html });
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', dialogTitle: title });
  return file.uri;
}

export async function shareCustomerPayment(payment: CustomerPayment, language: Language) {
  const copy = uiText(language); const rtl = language === 'ar'; const money = (value: number) => formatReportSyp(value, language, copy.common.syp);
  const tenders = (payment.tenders ?? []).map(tender => `<tr><td>${tender.currency}</td><td class="money">${tender.currency === 'USD' ? formatUsdCents(tender.amount_minor, 'en') : money(tender.amount_minor)}</td><td class="money">${money(tender.syp_equivalent)}</td></tr>`).join('');
  return share(shell(`<h1>${copy.customer.paymentReceipt}</h1><p>${copy.customer.customerName}: ${escapeHtml(payment.customer_name_snapshot)}</p><p class="num">${escapeHtml(date(payment.occurred_at, language))}</p><p class="id">${escapeHtml(payment.uuid)}</p><p>${copy.customer.paymentMode}: ${payment.payment_mode}</p>${payment.exchange_rate_syp_per_usd ? `<p>${copy.purchase.exchangeSnapshot}: <span class="money">${formatNumber(payment.exchange_rate_syp_per_usd, language)} SYP/USD</span></p>` : ''}<table><thead><tr><th>${copy.customer.paymentMode}</th><th>${copy.customer.receivePayment}</th><th>${copy.customer.equivalent}</th></tr></thead><tbody>${tenders}</tbody></table><p class="total money">${copy.customer.equivalent}: ${money(payment.total_syp_equivalent)}</p><p class="money">${copy.customer.newBalance}: ${money(payment.balance_after_syp)}</p>${payment.note ? `<p>${escapeHtml(payment.note)}</p>` : ''}`, rtl), copy.customer.sharePayment);
}

export async function shareCustomerStatement(customer: Customer, entries: CustomerAccountEntry[], language: Language) {
  const copy = uiText(language); const rtl = language === 'ar'; const money = (value: number) => formatReportSyp(value, language, copy.common.syp); const ordered = [...entries].reverse();
  const labels = { opening: copy.customer.opening, sale: copy.customer.sales, sale_return: copy.customer.returns, payment: copy.customer.payment };
  const rows = ordered.map(entry => `<tr><td class="num">${escapeHtml(date(entry.occurred_at, language))}</td><td>${escapeHtml(labels[entry.type])}</td><td class="id">${escapeHtml(entry.reference?.slice(0, 8) ?? '—')}</td><td class="money">${money(entry.delta_syp)}</td><td class="money">${money(entry.running_balance_syp ?? 0)}</td></tr>`).join('');
  const opening = ordered.filter(entry => entry.type === 'opening').reduce((sum, entry) => sum + entry.delta_syp, 0);
  const sales = ordered.filter(entry => entry.type === 'sale').reduce((sum, entry) => sum + entry.delta_syp, 0);
  const returns = ordered.filter(entry => entry.type === 'sale_return').reduce((sum, entry) => sum - entry.delta_syp, 0);
  const payments = ordered.filter(entry => entry.type === 'payment').reduce((sum, entry) => sum - entry.delta_syp, 0);
  const closing = ordered.at(-1)?.running_balance_syp ?? 0;
  const period = ordered.length ? `${date(ordered[0]!.occurred_at, language)} — ${date(ordered.at(-1)!.occurred_at, language)}` : '—';
  return share(shell(`<h1>${copy.customer.statement}</h1><p>${copy.customer.customerName}: ${escapeHtml(customer.name)}</p><p>${copy.purchase.period}: ${escapeHtml(period)}</p><p class="money">${copy.customer.opening}: ${money(opening)}</p><p class="money">${copy.customer.onAccountSales}: ${money(sales)}</p><p class="money">${copy.customer.accountReturns}: ${money(returns)}</p><p class="money">${copy.customer.payments}: ${money(payments)}</p><table><thead><tr><th>${copy.purchase.reportDate}</th><th>${copy.customer.entryType}</th><th>${copy.purchase.reference}</th><th>${copy.purchase.totalValue}</th><th>${copy.customer.currentBalance}</th></tr></thead><tbody>${rows}</tbody></table><p class="total money">${copy.customer.currentBalance}: ${money(closing)}</p>`, rtl), copy.customer.shareStatement);
}
