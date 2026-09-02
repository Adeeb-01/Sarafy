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

export interface AnalyticsRange { start: Date; end: Date }
export type AnalyticsMetricType = 'netSales' | 'grossProfit' | 'netProfit' | 'expenses' | 'invoiceCount' | 'returns' | 'discounts';
export type TrendDirection = 'up' | 'down' | 'same';
export type TrendSentiment = 'positive' | 'negative' | 'neutral';
export interface MetricComparison { current: number; previous: number; absoluteChange: number; percentageChange: number | null; direction: TrendDirection }
export interface AnalyticsProductMetric { name: string; quantity: number; revenue: number; profit: number }
export interface AnalyticsInsight { id: string; kind: 'sales' | 'profit' | 'expenses' | 'returns' | 'product' | 'weekday'; sentiment: TrendSentiment; value?: number; productName?: string; weekday?: number }

export function getAnalyticsPeriodRange(period: AnalyticsPeriod, now = new Date()): AnalyticsRange {
  const start = periodStart(period, now);
  const end = new Date(start);
  if (period === 'day') end.setDate(end.getDate() + 1);
  else if (period === 'week') end.setDate(end.getDate() + 7);
  else end.setMonth(end.getMonth() + 1);
  return { start, end };
}

export function getPreviousEquivalentPeriod(period: AnalyticsPeriod, now = new Date()): AnalyticsRange {
  const current = getAnalyticsPeriodRange(period, now);
  const end = new Date(current.start); const start = new Date(current.start);
  if (period === 'day') start.setDate(start.getDate() - 1);
  else if (period === 'week') start.setDate(start.getDate() - 7);
  else start.setMonth(start.getMonth() - 1);
  return { start, end };
}

export function compareMetric(current: number, previous: number): MetricComparison {
  const safeCurrent = Number.isFinite(current) ? current : 0; const safePrevious = Number.isFinite(previous) ? previous : 0;
  const absoluteChange = safeCurrent - safePrevious;
  const normalizedChange = Object.is(absoluteChange, -0) ? 0 : absoluteChange;
  const percentageChange = safePrevious <= 0 ? null : normalizedChange / Math.abs(safePrevious) * 100;
  return { current: safeCurrent, previous: safePrevious, absoluteChange: normalizedChange, percentageChange: Number.isFinite(percentageChange) ? percentageChange : null, direction: normalizedChange > 0 ? 'up' : normalizedChange < 0 ? 'down' : 'same' };
}

export function getMetricTrendSentiment(metric: AnalyticsMetricType, comparison: MetricComparison): TrendSentiment {
  if (comparison.direction === 'same' || metric === 'discounts') return 'neutral';
  const increaseIsGood = metric === 'netSales' || metric === 'grossProfit' || metric === 'netProfit' || metric === 'invoiceCount';
  return comparison.direction === 'up' ? (increaseIsGood ? 'positive' : 'negative') : (increaseIsGood ? 'negative' : 'positive');
}

function inRange(createdAt: string, range: AnalyticsRange) {
  const time = new Date(createdAt).getTime();
  return time >= range.start.getTime() && time < range.end.getTime();
}

export function aggregateAnalyticsRange(sales: Sale[], expenses: Expense[], returns: SaleReturn[], range: AnalyticsRange) {
  const rangeSales = sales.filter(sale => inRange(sale.created_at, range));
  const rangeReturns = returns.filter(record => inRange(record.created_at, range));
  const rangeExpenses = expenses.filter(expense => inRange(expense.created_at, range));
  const completedSales = rangeSales.reduce((sum, sale) => sum + sale.net_total_syp, 0);
  const grossSales = rangeSales.reduce((sum, sale) => sum + sale.subtotal_syp, 0);
  const discounts = rangeSales.reduce((sum, sale) => sum + sale.discount_syp, 0);
  const refunds = rangeReturns.reduce((sum, record) => sum + record.refund_total_syp, 0);
  const saleCogs = rangeSales.reduce((sum, sale) => sum + (sale.cost_syp ?? sale.net_total_syp - sale.profit_syp), 0);
  const returnedCogs = rangeReturns.reduce((sum, record) => sum + record.returned_cost_syp, 0);
  const netSales = completedSales - refunds; const netCogs = saleCogs - returnedCogs; const grossProfit = netSales - netCogs;
  const operatingExpenses = rangeExpenses.reduce((sum, expense) => sum + expense.amount_syp, 0);
  const soldQuantity = rangeSales.reduce((sum, sale) => sum + sale.items.reduce((itemSum, item) => itemSum + item.quantity, 0), 0);
  const returnedQuantity = rangeReturns.reduce((sum, record) => sum + record.items.reduce((itemSum, item) => itemSum + item.quantity, 0), 0);
  return { sales: rangeSales, returns: rangeReturns, expenses: rangeExpenses, completedSales, grossSales, discounts, refunds, netSales, netCogs, grossProfit, operatingExpenses, netProfit: grossProfit - operatingExpenses, invoiceCount: rangeSales.length, returnCount: rangeReturns.length, soldQuantity, returnedQuantity, itemCount: soldQuantity - returnedQuantity, averageInvoice: rangeSales.length ? netSales / rangeSales.length : 0, grossMarginPercent: netSales > 0 ? grossProfit / netSales * 100 : null, returnRatePercent: completedSales > 0 ? refunds / completedSales * 100 : null, discountRatePercent: grossSales > 0 ? discounts / grossSales * 100 : null };
}

export function aggregateAnalyticsProducts(sales: Sale[], returns: SaleReturn[]) {
  const products = new Map<string, AnalyticsProductMetric>();
  for (const sale of sales) {
    const canAllocate = Number.isSafeInteger(sale.subtotal_syp) && Number.isSafeInteger(sale.discount_syp) && Number.isSafeInteger(sale.net_total_syp) && sale.items.every(item => Number.isSafeInteger(item.id) && Number.isSafeInteger(item.line_total_syp));
    const allocated = canAllocate ? allocateInvoiceDiscount(sale) : new Map<number, number>();
    for (const item of sale.items) {
      const current = products.get(item.product_name) ?? { name: item.product_name, quantity: 0, revenue: 0, profit: 0 };
      const revenue = item.line_total_syp - (allocated.get(item.id) ?? 0); const cost = item.line_cost_syp ?? item.unit_cost_syp * item.quantity;
      products.set(item.product_name, { name: item.product_name, quantity: current.quantity + item.quantity, revenue: current.revenue + revenue, profit: current.profit + revenue - cost });
    }
  }
  for (const record of returns) for (const item of record.items) {
    const current = products.get(item.product_name) ?? { name: item.product_name, quantity: 0, revenue: 0, profit: 0 };
    products.set(item.product_name, { name: item.product_name, quantity: current.quantity - item.quantity, revenue: current.revenue - item.refund_amount_syp, profit: current.profit - (item.refund_amount_syp - item.cost_reversal_syp) });
  }
  const rows = [...products.values()]; const stable = (a: AnalyticsProductMetric, b: AnalyticsProductMetric) => a.name.localeCompare(b.name);
  return {
    quantity: [...rows].sort((a, b) => b.quantity - a.quantity || stable(a, b)).slice(0, 5),
    revenue: [...rows].sort((a, b) => b.revenue - a.revenue || stable(a, b)).slice(0, 5),
    profit: [...rows].sort((a, b) => b.profit - a.profit || stable(a, b)).slice(0, 5),
  };
}

export function analyzeWeekdays(sales: Sale[], returns: SaleReturn[]) {
  const values = Array.from({ length: 7 }, (_, day) => ({ day, netSales: 0, activity: false }));
  for (const sale of sales) { const day = new Date(sale.created_at).getDay(); const row = values[day]; if (row) { row.netSales += sale.net_total_syp; row.activity = true; } }
  for (const record of returns) { const day = new Date(record.created_at).getDay(); const row = values[day]; if (row) { row.netSales -= record.refund_total_syp; row.activity = true; } }
  const active = values.filter(row => row.activity); const strongest = active.length ? [...active].sort((a, b) => b.netSales - a.netSales || a.day - b.day)[0]?.day ?? null : null; const weakest = active.length ? [...active].sort((a, b) => a.netSales - b.netSales || a.day - b.day)[0]?.day ?? null : null;
  return { values, strongest, weakest };
}

export function analyzeHours(sales: Sale[]) {
  const values = Array.from({ length: 24 }, (_, hour) => ({ hour, invoiceCount: 0 }));
  for (const sale of sales) { const row = values[new Date(sale.created_at).getHours()]; if (row) row.invoiceCount += 1; }
  const maximum = Math.max(0, ...values.map(row => row.invoiceCount));
  return { values, peakHour: maximum > 0 ? values.find(row => row.invoiceCount === maximum)?.hour ?? null : null, peakInvoiceCount: maximum };
}

export function aggregateExpenseCategories(expenses: Expense[]) {
  const totals = new Map<string, { categoryUuid: string; nameAr: string; nameEn: string | null; totalSyp: number }>();
  for (const expense of expenses) { const key = expense.category_uuid ?? `legacy-${expense.category_id ?? 0}`; const row = totals.get(key) ?? { categoryUuid: key, nameAr: expense.category_name_ar ?? '', nameEn: expense.category_name_en ?? null, totalSyp: 0 }; row.totalSyp += expense.amount_syp; totals.set(key, row); }
  return [...totals.values()].sort((a, b) => b.totalSyp - a.totalSyp || a.categoryUuid.localeCompare(b.categoryUuid));
}

export function buildRateSummary(history: import('@/types').ExchangeRateHistoryEntry[], currentRate: number, range: AnalyticsRange) {
  let before: import('@/types').ExchangeRateHistoryEntry | undefined; let beforeTime = -Infinity; let changes = 0; const startTime = range.start.getTime(); const endTime = range.end.getTime();
  for (const entry of history) { const time = new Date(entry.created_at).getTime(); if (time >= startTime && time < endTime) changes += 1; if (time <= startTime && (time > beforeTime || time === beforeTime && entry.id > (before?.id ?? -1))) { before = entry; beforeTime = time; } }
  const startRate = before?.new_rate ?? null;
  return { currentRate, startRate, changePercent: startRate && startRate > 0 ? (currentRate - startRate) / startRate * 100 : null, changeCount: changes };
}

const INSIGHT_THRESHOLD = 5;
export function generateAnalyticsInsights(current: ReturnType<typeof aggregateAnalyticsRange>, comparisons: Record<'netSales' | 'netProfit' | 'expenses', MetricComparison>, products: ReturnType<typeof aggregateAnalyticsProducts>, weekdays: ReturnType<typeof analyzeWeekdays>): AnalyticsInsight[] {
  const candidates: Array<AnalyticsInsight & { priority: number }> = [];
  const addChange = (id: string, kind: 'sales' | 'profit' | 'expenses', comparison: MetricComparison, metric: AnalyticsMetricType, priority: number) => { if (comparison.percentageChange != null && Math.abs(comparison.percentageChange) >= INSIGHT_THRESHOLD) candidates.push({ id, kind, sentiment: getMetricTrendSentiment(metric, comparison), value: comparison.percentageChange, priority }); };
  addChange('profit-change', 'profit', comparisons.netProfit, 'netProfit', 1); addChange('sales-change', 'sales', comparisons.netSales, 'netSales', 2); addChange('expense-change', 'expenses', comparisons.expenses, 'expenses', 4);
  if (current.returnRatePercent != null && current.returnRatePercent >= INSIGHT_THRESHOLD) candidates.push({ id: 'high-returns', kind: 'returns', sentiment: 'negative', value: current.returnRatePercent, priority: 3 });
  const top = products.profit[0]; if (top && top.profit > 0) candidates.push({ id: 'top-product', kind: 'product', sentiment: 'neutral', productName: top.name, value: top.profit, priority: 5 });
  if (weekdays.strongest != null) candidates.push({ id: 'strongest-day', kind: 'weekday', sentiment: 'neutral', weekday: weekdays.strongest, priority: 6 });
  return candidates.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)).slice(0, 5).map(({ priority: _priority, ...item }) => item);
}

export function buildAnalytics2(sales: Sale[], expenses: Expense[], period: AnalyticsPeriod, returns: SaleReturn[] = sales.flatMap(sale => sale.returns ?? []), rateHistory: import('@/types').ExchangeRateHistoryEntry[] = [], currentRate = 0, now = new Date()) {
  const range = getAnalyticsPeriodRange(period, now); const previousRange = getPreviousEquivalentPeriod(period, now);
  const current = aggregateAnalyticsRange(sales, expenses, returns, range); const previous = aggregateAnalyticsRange(sales, expenses, returns, previousRange);
  const comparisons = { netSales: compareMetric(current.netSales, previous.netSales), grossProfit: compareMetric(current.grossProfit, previous.grossProfit), netProfit: compareMetric(current.netProfit, previous.netProfit), expenses: compareMetric(current.operatingExpenses, previous.operatingExpenses), invoiceCount: compareMetric(current.invoiceCount, previous.invoiceCount) };
  const products = aggregateAnalyticsProducts(current.sales, current.returns); const weekdays = analyzeWeekdays(current.sales, current.returns); const hourly = analyzeHours(current.sales); const categories = aggregateExpenseCategories(current.expenses);
  return { range, previousRange, current, previous, comparisons, products, weekdays, hourly, expenseCategories: categories, rate: buildRateSummary(rateHistory, currentRate, range), insights: generateAnalyticsInsights(current, { netSales: comparisons.netSales, netProfit: comparisons.netProfit, expenses: comparisons.expenses }, products, weekdays), hasActivity: current.sales.length > 0 || current.returns.length > 0 || current.expenses.length > 0 };
}
