import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Language, Sale } from '@/types';

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export async function shareInvoicePdf(sale: Sale, language: Language) {
  const rtl = language === 'ar';
  const locale = rtl ? 'ar-SY' : 'en-US';
  const money = (value: number) => `${Math.round(value).toLocaleString(locale)} ${rtl ? 'ل.س' : 'SYP'}`;
  const rows = sale.items.map(item => `
    <tr>
      <td>${escapeHtml(item.product_name)}</td>
      <td>${item.quantity.toLocaleString(locale)}</td>
      <td>${money(item.unit_price_syp)}</td>
      <td>${money(item.line_total_syp)}</td>
    </tr>`).join('');
  const html = `<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">
    <style>
      body{font-family:Arial,sans-serif;color:#151b2b;padding:32px}
      header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #b52d67;padding-bottom:18px}
      h1{margin:0;color:#542250} .muted{color:#697386;font-size:12px}
      table{width:100%;border-collapse:collapse;margin-top:24px} th{background:#151b2b;color:#fff}
      th,td{padding:11px;text-align:${rtl ? 'right' : 'left'};border-bottom:1px solid #dce4ee}
      .totals{margin-top:24px;margin-${rtl ? 'right' : 'left'}:auto;width:280px}
      .line{display:flex;justify-content:space-between;padding:7px 0}.net{font-size:20px;font-weight:bold;color:#08796d;border-top:2px solid #08796d}
    </style></head><body>
    <header><div><h1>${rtl ? 'فاتورة مبيعات' : 'Sales invoice'}</h1><div class="muted">Sarafy · ${escapeHtml(sale.invoice_number)}</div></div>
    <div class="muted">${new Date(sale.created_at).toLocaleString(locale)}</div></header>
    <table><thead><tr><th>${rtl ? 'المنتج' : 'Product'}</th><th>${rtl ? 'الكمية' : 'Qty'}</th><th>${rtl ? 'السعر' : 'Price'}</th><th>${rtl ? 'الإجمالي' : 'Total'}</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="totals"><div class="line"><span>${rtl ? 'المجموع' : 'Subtotal'}</span><b>${money(sale.subtotal_syp)}</b></div>
    <div class="line"><span>${rtl ? 'الحسم' : 'Discount'}</span><b>${money(sale.discount_syp)}</b></div>
    <div class="line net"><span>${rtl ? 'الإجمالي الصافي' : 'Net total'}</span><span>${money(sale.net_total_syp)}</span></div></div>
    </body></html>`;
  const result = await Print.printToFileAsync({ html });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(result.uri, {
      mimeType: 'application/pdf',
      dialogTitle: `${sale.invoice_number}.pdf`,
      UTI: 'com.adobe.pdf',
    });
  }
  return result.uri;
}
