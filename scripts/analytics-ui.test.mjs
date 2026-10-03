import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { buildAnalytics, dailyRevenueSeries, periodStart } from '../src/utils/salesAnalytics.ts';
import { formatNumber } from '../src/utils/formatters.ts';

const sale = ({ id = 1, revenue = 15_000, profit = 5_000, quantity = 2, name = 'Product', createdAt = new Date().toISOString() } = {}) => ({
  id, created_at: createdAt, net_total_syp: revenue, profit_syp: profit,
  items: [{ product_name: name, quantity, line_total_syp: revenue }],
});

test('current analytics equations and zero-average behavior remain unchanged', () => {
  const empty = buildAnalytics([], [], 'day');
  assert.deepEqual({ revenue: empty.revenue, gross: empty.grossProfit, expenses: empty.expenses, net: empty.netProfit, invoices: empty.invoiceCount, items: empty.itemCount, average: empty.averageInvoice }, { revenue: 0, gross: 0, expenses: 0, net: 0, invoices: 0, items: 0, average: 0 });

  const result = buildAnalytics([sale()], [{ amount_syp: 2_000, created_at: new Date().toISOString() }], 'day');
  assert.equal(result.revenue, 15_000);
  assert.equal(result.grossProfit, 5_000);
  assert.equal(result.expenses, 2_000);
  assert.equal(result.netProfit, 3_000);
  assert.equal(result.invoiceCount, 1);
  assert.equal(result.itemCount, 2);
  assert.equal(result.averageInvoice, 15_000);
});

test('period boundaries keep today, Monday week start, and current-month behavior', () => {
  const monday = new Date(2026, 7, 24, 18, 45);
  assert.equal(periodStart('day', monday).getHours(), 0);
  assert.equal(periodStart('week', monday).getDate(), 24);
  assert.equal(periodStart('month', monday).getDate(), 1);
  const sunday = new Date(2026, 7, 30, 18, 45);
  assert.equal(periodStart('week', sunday).getDate(), 24);
});

test('view formatting is finite and localized for zero, loss, and huge values', async () => {
  for (const value of [0, -985_000, 900, 15_000, 985_000, 15_500_000, 1_485_000_000]) {
    const english = formatNumber(value, 'en');
    const arabic = formatNumber(value, 'ar');
    assert.ok(english && !/NaN|Infinity|undefined/.test(english));
    assert.ok(arabic && !/NaN|Infinity|undefined/.test(arabic));
  }
  const [source, formatters, copy] = await Promise.all([
    readFile(new URL('../src/utils/analyticsUiState.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/utils/formatters.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/i18n/ui.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /Number\.isFinite/);
  assert.match(source, /formatDate/);
  assert.match(source, /formatTime/);
  assert.match(formatters, /Intl\.DateTimeFormat/);
  assert.match(formatters, /ar-SY-u-ca-gregory-nu-latn/);
  assert.match(formatters, /numberingSystem: 'latn'/);
  assert.match(source, /trendAccessibilitySummary/);
  assert.match(source, /uiText\(language\)/);
  assert.match(copy, /thousand: 'ألف'/);
  assert.match(copy, /million: 'مليون'/);
  assert.match(source, /weekday: 'short'/);
});

test('chart labels use native text shaping and preserve bounded responsive geometry', async () => {
  const chart = await readFile(new URL('../src/components/analytics/SalesTrendChart.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(chart, /SvgText/);
  assert.match(chart, /writingDirection: rtl \? 'rtl' : 'ltr'/);
  assert.match(chart, /const SINGLE_CHART_HEIGHT = 168/);
  assert.match(chart, /Math\.min\(width - X_LABEL_WIDTH/);
  assert.match(chart, /selected\.x >= width \/ 2/);
});

test('analytics polish keeps measured navigation inset and fixed ranked-list geometry', async () => {
  const dashboard = await readFile(new URL('../src/components/analytics/AnalyticsDashboard.tsx', import.meta.url), 'utf8');
  assert.match(dashboard, /paddingBottom: bottomNavigationInset \+ spacing\.xl/);
  assert.match(dashboard, /progressTrack: \{ height: 10/);
  assert.match(dashboard, /numberOfLines=\{1\} ellipsizeMode="tail"/);
});

test('trend keeps the existing 1, 7, and 30 point shapes', () => {
  const currentSale = sale();
  assert.equal(dailyRevenueSeries([currentSale], 'day').length, 1);
  assert.equal(dailyRevenueSeries([currentSale], 'week').length, 7);
  assert.equal(dailyRevenueSeries([currentSale], 'month').length, 30);
});

test('net loss, a single product, and long snapshot names remain explicit', () => {
  const longName = 'منتج تجريبي باسم عربي طويل جدًا للتحقق من ثبات بيانات التحليلات التاريخية';
  const result = buildAnalytics([sale({ revenue: 900, profit: -300, name: longName })], [{ amount_syp: 600, created_at: new Date().toISOString() }], 'day');
  assert.equal(result.netProfit, -900);
  assert.equal(result.topProducts.length, 1);
  assert.equal(result.topProducts[0]?.name, longName);
  assert.equal(result.topProducts[0]?.quantity, 2);
});

test('large-month analytics handles 5,000 invoices and 25,000 sale items without invalid output', () => {
  const now = new Date().toISOString();
  const sales = Array.from({ length: 5_000 }, (_, saleIndex) => ({
    id: saleIndex + 1,
    created_at: now,
    net_total_syp: 15_500_000,
    profit_syp: saleIndex % 2 ? 2_000_000 : -500_000,
    items: Array.from({ length: 5 }, (_, itemIndex) => ({ product_name: `Product ${itemIndex}`, quantity: itemIndex + 1, line_total_syp: 3_100_000 })),
  }));
  const buildStarted = performance.now();
  const result = buildAnalytics(sales, [], 'month');
  const buildMs = performance.now() - buildStarted;
  const trendStarted = performance.now();
  const points = dailyRevenueSeries(result.sales, 'month');
  const trendMs = performance.now() - trendStarted;
  const adapterStarted = performance.now();
  const visibleTopProducts = result.topProducts;
  const adapterMs = performance.now() - adapterStarted;
  assert.equal(result.invoiceCount, 5_000);
  assert.equal(result.itemCount, 75_000);
  assert.equal(visibleTopProducts.length, 5);
  assert.equal(points.length, 30);
  assert.ok(Number.isFinite(result.netProfit));
  console.log(`analytics_build_ms=${buildMs.toFixed(2)} trend_ms=${trendMs.toFixed(2)} top_adapter_ms=${adapterMs.toFixed(4)} period_compute_ms=${(buildMs + trendMs).toFixed(2)}`);
});
