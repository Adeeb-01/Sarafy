import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import type { Language } from '@/types';
import type { AccountLedgerReport, BalanceSheetReport, ProfitAndLossReport, TrialBalanceReport } from '@/accounting/accountingReports';
import { accountingText } from '@/i18n/accounting';
import { lightColors } from '@/theme/colors';
import { formatReportDateTime, formatReportSyp, REPORT_NUMERIC_CSS } from '@/utils/reportFormatting';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
const money = (value: number, language: Language) => formatReportSyp(value, language, accountingText(language).sypShort);
const shell = (title: string, body: string, rtl: boolean) => `<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>${REPORT_NUMERIC_CSS} @page{margin:28px}body{font-family:Arial,sans-serif;color:${lightColors.textPrimary};margin:0}h1{font-size:24px;margin:0 0 16px}h2{font-size:17px;margin:24px 0 8px}p{margin:6px 0}table{width:100%;border-collapse:collapse;margin-top:14px}thead{display:table-header-group}tr{break-inside:avoid}th,td{padding:8px;border-bottom:1px solid ${lightColors.border};text-align:${rtl ? 'right' : 'left'};vertical-align:top}.money{white-space:nowrap}.total{font-weight:700;background:${lightColors.surfaceSecondary}}.blocked{padding:12px;background:${lightColors.warningSoft};color:${lightColors.warning}}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;

async function share(title: string, html: string) {
  const file = await Print.printToFileAsync({ html });
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', dialogTitle: title });
  return file.uri;
}

export async function shareTrialBalance(report: TrialBalanceReport, language: Language) {
  const copy = accountingText(language); const rtl = language === 'ar';
  const rows = report.rows.map(row => `<tr><td class="id">${escapeHtml(row.code)}</td><td>${escapeHtml(rtl ? row.nameAr : row.nameEn)}</td><td class="money">${money(row.debitBalanceSyp, language)}</td><td class="money">${money(row.creditBalanceSyp, language)}</td></tr>`).join('');
  const html = shell(copy.trialBalance, `<p>${copy.status}: ${report.balanced ? copy.balanced : copy.unbalanced}</p><table><thead><tr><th>${copy.accounts}</th><th>${copy.description}</th><th>${copy.debit}</th><th>${copy.credit}</th></tr></thead><tbody>${rows}<tr class="total"><td colspan="2">${copy.total}</td><td class="money">${money(report.totalDebitSyp, language)}</td><td class="money">${money(report.totalCreditSyp, language)}</td></tr></tbody></table>`, rtl);
  return share(copy.trialBalance, html);
}

export async function shareProfitAndLoss(report: ProfitAndLossReport, language: Language) {
  const copy = accountingText(language); const rtl = language === 'ar';
  const rows: Array<[string, number]> = [[copy.salesRevenue, report.salesRevenueSyp], [copy.salesReturns, -report.salesReturnsSyp], [copy.netSales, report.netSalesSyp], [copy.cogs, -report.cogsSyp], [copy.grossProfit, report.grossProfitSyp], [copy.operatingExpenses, -report.operatingExpensesSyp], [copy.realizedFx, report.realizedFxNetSyp], [copy.netProfit, report.netProfitSyp]];
  return share(copy.profitLoss, shell(copy.profitLoss, `<table><tbody>${rows.map(([label, value], index) => `<tr${index === rows.length - 1 ? ' class="total"' : ''}><td>${escapeHtml(label)}</td><td class="money">${money(value, language)}</td></tr>`).join('')}</tbody></table>`, rtl));
}

export async function shareBalanceSheet(report: BalanceSheetReport, language: Language) {
  const copy = accountingText(language); const rtl = language === 'ar';
  if (!report.valid) return share(copy.balanceSheet, shell(copy.balanceSheet, `<p class="blocked">${escapeHtml(copy.reportBlocked)}</p><p>${escapeHtml(report.blockedReasons.join(' · '))}</p>`, rtl));
  const rows: Array<[string, number]> = [[copy.assets, report.assetsSyp], [copy.liabilities, report.liabilitiesSyp], [copy.equity, report.equitySyp], [copy.liabilitiesEquity, report.liabilitiesAndEquitySyp]];
  return share(copy.balanceSheet, shell(copy.balanceSheet, `<table><tbody>${rows.map(([label, value], index) => `<tr${index === rows.length - 1 ? ' class="total"' : ''}><td>${escapeHtml(label)}</td><td class="money">${money(value, language)}</td></tr>`).join('')}</tbody></table>`, rtl));
}

export async function shareAccountLedger(report: AccountLedgerReport, language: Language) {
  const copy = accountingText(language); const rtl = language === 'ar'; const name = rtl ? report.account.nameAr : report.account.nameEn;
  const rows = report.rows.map(row => `<tr><td class="num">${escapeHtml(formatReportDateTime(row.occurredAt, language))}</td><td class="id">${escapeHtml(row.reference ?? row.description)}</td><td class="money">${money(row.debitSyp, language)}</td><td class="money">${money(row.creditSyp, language)}</td><td class="money">${money(row.runningBalanceSyp, language)}</td></tr>`).join('');
  return share(copy.accountLedger, shell(`${copy.accountLedger} — ${report.account.code} ${name}`, `<p>${copy.broughtForward}: <span class="money">${money(report.broughtForwardSyp, language)}</span></p><table><thead><tr><th>${copy.startedAt}</th><th>${copy.reference}</th><th>${copy.debit}</th><th>${copy.credit}</th><th>${copy.runningBalance}</th></tr></thead><tbody>${rows}</tbody></table>`, rtl));
}
