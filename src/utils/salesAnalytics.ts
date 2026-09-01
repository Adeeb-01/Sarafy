import type { Expense, Sale, SaleReturn } from '@/types';
import { allocateInvoiceDiscount } from './returns.ts';

export type AnalyticsPeriod = 'day' | 'week' | 'month';

export function periodStart(period: AnalyticsPeriod, now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === 'week') {
    const day = start.getDay();
    start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
  } else if (period === 'month') {
    start.setDate(1);
  }
  return start;
}

export function buildAnalytics(sales: Sale[], expenses: Expense[], period: AnalyticsPeriod, returns: SaleReturn[] = sales.flatMap(sale => sale.returns ?? [])) {
  const start = periodStart(period).getTime();
  const periodSales = sales.filter(sale => new Date(sale.created_at).getTime() >= start);
  const periodExpenses = expenses.filter(expense => new Date(expense.created_at).getTime() >= start);
  const periodReturns = returns.filter(record => new Date(record.created_at).getTime() >= start);
  const revenue = periodSales.reduce((sum, sale) => sum + sale.net_total_syp, 0) - periodReturns.reduce((sum, record) => sum + record.refund_total_syp, 0);
  const netCogs = periodSales.reduce((sum, sale) => sum + (sale.cost_syp ?? sale.net_total_syp - sale.profit_syp), 0) - periodReturns.reduce((sum, record) => sum + record.returned_cost_syp, 0);
  const grossProfit = revenue - netCogs;
  const expenseTotal = periodExpenses.reduce((sum, expense) => sum + expense.amount_syp, 0);
  const itemCount = periodSales.reduce(
    (sum, sale) => sum + sale.items.reduce((itemSum, item) => itemSum + item.quantity, 0),
    0,
  ) - periodReturns.reduce((sum, record) => sum + record.items.reduce((itemSum, item) => itemSum + item.quantity, 0), 0);
  const topProducts = new Map<string, { quantity: number; revenue: number }>();
  periodSales.forEach(sale => {
    const canAllocate = Number.isSafeInteger(sale.subtotal_syp) && Number.isSafeInteger(sale.discount_syp) && Number.isSafeInteger(sale.net_total_syp) && sale.items.every(item => Number.isSafeInteger(item.id) && Number.isSafeInteger(item.line_total_syp));
    const discounts = canAllocate ? allocateInvoiceDiscount(sale) : new Map<number, number>();
    sale.items.forEach(item => {
      const current = topProducts.get(item.product_name) ?? { quantity: 0, revenue: 0 };
      topProducts.set(item.product_name, { quantity: current.quantity + item.quantity, revenue: current.revenue + item.line_total_syp - (discounts.get(item.id) ?? 0) });
    });
  });
  periodReturns.flatMap(record => record.items).forEach(item => {
    const current = topProducts.get(item.product_name) ?? { quantity: 0, revenue: 0 };
    topProducts.set(item.product_name, { quantity: current.quantity - item.quantity, revenue: current.revenue - item.refund_amount_syp });
  });
  return {
    sales: periodSales,
    revenue,
    netCogs,
    grossProfit,
    expenses: expenseTotal,
    netProfit: grossProfit - expenseTotal,
    invoiceCount: periodSales.length,
    itemCount,
    averageInvoice: periodSales.length ? revenue / periodSales.length : 0,
    returns: periodReturns,
    hasActivity: periodSales.length > 0 || periodReturns.length > 0,
    topProducts: [...topProducts.entries()]
      .map(([name, values]) => ({ name, ...values }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5),
  };
}

export function dailyRevenueSeries(sales: Sale[], period: AnalyticsPeriod, returns: SaleReturn[] = sales.flatMap(sale => sale.returns ?? [])) {
  const days = period === 'day' ? 1 : period === 'week' ? 7 : 30;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (days - index - 1));
    const next = new Date(date);
    next.setDate(date.getDate() + 1);
    const saleValue = sales
      .filter(sale => {
        const time = new Date(sale.created_at).getTime();
        return time >= date.getTime() && time < next.getTime();
      })
      .reduce((sum, sale) => sum + sale.net_total_syp, 0);
    const returnValue = returns.filter(record => {
      const time = new Date(record.created_at).getTime();
      return time >= date.getTime() && time < next.getTime();
    }).reduce((sum, record) => sum + record.refund_total_syp, 0);
    return { date, value: saleValue - returnValue };
  });
}
