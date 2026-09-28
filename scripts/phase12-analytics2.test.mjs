import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { aggregateAnalyticsProducts, aggregateAnalyticsRange, aggregateExpenseCategories, analyzeHours, analyzeWeekdays, buildAnalytics2, buildRateSummary, compareMetric, generateAnalyticsInsights, getAnalyticsPeriodRange, getMetricTrendSentiment, getPreviousEquivalentPeriod } from '../src/utils/salesAnalytics.ts';
import { formatAnalyticsPercent } from '../src/utils/analyticsUiState.ts';

const now = new Date(2026, 8, 2, 12, 0, 0);
const stamp = (day, hour = 10) => new Date(2026, 8, day, hour, 0, 0).toISOString();
function item(id, name, quantity, revenue, cost) { return { id, uuid:`item-${id}`, sale_id:id, product_id:null, product_name:name, barcode_snapshot:null, quantity, unit_price_syp:revenue/quantity, unit_cost_syp:cost/quantity, line_total_syp:revenue, line_cost_syp:cost, created_at:stamp(2), updated_at:stamp(2) }; }
function sale(id, createdAt, subtotal, discount, cost, items) { return { id, uuid:`sale-${id}`, invoice_number:`INV-${id}`, exchange_rate:14500, subtotal_syp:subtotal, discount_syp:discount, net_total_syp:subtotal-discount, cost_syp:cost, profit_syp:subtotal-discount-cost, amount_paid_syp:null, change_syp:null, created_at:createdAt, updated_at:createdAt, items }; }
function returned(id, createdAt, saleId, rows) { return { id, uuid:`return-${id}`, sale_id:saleId, refund_total_syp:rows.reduce((s,x)=>s+x.refund_amount_syp,0), returned_cost_syp:rows.reduce((s,x)=>s+x.cost_reversal_syp,0), created_at:createdAt, updated_at:createdAt, items:rows.map((x,index)=>({ id:id*10+index,uuid:`ri-${id}-${index}`,return_id:id,sale_item_id:x.sale_item_id,quantity:x.quantity,refund_amount_syp:x.refund_amount_syp,cost_reversal_syp:x.cost_reversal_syp,created_at:createdAt,updated_at:createdAt,product_name:x.product_name,barcode_snapshot:null })) }; }

test('day/week/month current and previous ranges are calendar-safe, half-open and non-overlapping', () => {
  for (const period of ['day','week','month']) { const current=getAnalyticsPeriodRange(period,now); const previous=getPreviousEquivalentPeriod(period,now); assert.equal(previous.end.getTime(),current.start.getTime()); assert.ok(previous.start<previous.end); assert.ok(current.start<current.end); }
  assert.equal(getAnalyticsPeriodRange('week',now).start.getDay(),1); assert.equal(getPreviousEquivalentPeriod('day',now).start.getDate(),1); assert.equal(getPreviousEquivalentPeriod('month',now).start.getMonth(),7);
});

test('comparison and semantic sentiment cover zero, negative, infinity and negative-zero edges', () => {
  assert.equal(compareMetric(110,100).percentageChange,10); assert.equal(compareMetric(90,100).percentageChange,-10); assert.deepEqual(compareMetric(0,0),{current:0,previous:0,absoluteChange:0,percentageChange:null,direction:'same'}); assert.equal(compareMetric(100,0).percentageChange,null); assert.equal(compareMetric(-10,-20).percentageChange,null); assert.equal(formatAnalyticsPercent(-0.001,'en'),'0%'); assert.ok(!/NaN|Infinity|-0/.test(String(formatAnalyticsPercent(1e9,'en'))));
  assert.equal(getMetricTrendSentiment('netProfit',compareMetric(110,100)),'positive'); assert.equal(getMetricTrendSentiment('expenses',compareMetric(110,100)),'negative'); assert.equal(getMetricTrendSentiment('returns',compareMetric(90,100)),'positive');
});

test('accounting, margin, returns and discounts preserve historical equations', () => {
  const a=item(1,'A',2,600000,350000), b=item(2,'B',1,400000,250000); const s=sale(1,stamp(2),1000000,50000,600000,[a,b]); const r=returned(1,stamp(2,14),1,[{sale_item_id:1,quantity:1,refund_amount_syp:100000,cost_reversal_syp:70000,product_name:'A'}]);
  const vm=buildAnalytics2([s],[{id:1,uuid:'expense',description:'',amount_syp:50000,category_id:1,category_uuid:'cat',category_name_ar:'فئة',category_name_en:'Category',note:null,created_at:stamp(2),updated_at:stamp(2)}],'day',[r],[],15000,now); const c=vm.current;
  assert.equal(c.completedSales,950000); assert.equal(c.refunds,100000); assert.equal(c.netSales,850000); assert.equal(c.netCogs,530000); assert.equal(c.grossProfit,320000); assert.equal(c.netProfit,270000); assert.equal(c.averageInvoice,850000); assert.equal(c.returnRatePercent,100000/950000*100); assert.equal(c.discountRatePercent,5); assert.equal(c.grossMarginPercent,320000/850000*100); assert.equal(c.returnCount,1); assert.equal(c.returnedQuantity,1);
});

test('zero, expense-only and returns-only periods stay finite without fake margins', () => {
  const empty=buildAnalytics2([],[],'day',[],[],15000,now); assert.equal(empty.current.averageInvoice,0); assert.equal(empty.current.grossMarginPercent,null); assert.equal(empty.current.returnRatePercent,null);
  const expense=buildAnalytics2([],[{amount_syp:7000,created_at:stamp(2)}],'day',[],[],15000,now); assert.equal(expense.current.netProfit,-7000); assert.equal(expense.current.grossMarginPercent,null);
  const r=returned(2,stamp(2),99,[{sale_item_id:99,quantity:2,refund_amount_syp:9000,cost_reversal_syp:6000,product_name:'Old'}]); const onlyReturn=buildAnalytics2([],[],'day',[r],[],15000,now); assert.equal(onlyReturn.current.netSales,-9000); assert.equal(onlyReturn.current.netCogs,-6000); assert.equal(onlyReturn.current.grossProfit,-3000); assert.equal(onlyReturn.products.quantity[0].quantity,-2); assert.equal(onlyReturn.current.grossMarginPercent,null);
  assert.ok(!/NaN|Infinity/.test(JSON.stringify([empty.current,expense.current,onlyReturn.current])));
});

test('top products rank quantity, revenue and historical profit with return-date snapshots', () => {
  const products=[sale(1,stamp(2),1000,0,500,[item(1,'Deleted snapshot',5,600,100),item(2,'Revenue',1,400,350)])]; const r=returned(3,stamp(2,15),88,[{sale_item_id:5,quantity:6,refund_amount_syp:700,cost_reversal_syp:200,product_name:'Return only'}]); const rows=aggregateAnalyticsProducts(products,[r]);
  assert.equal(rows.quantity[0].name,'Deleted snapshot'); assert.equal(rows.revenue[0].name,'Deleted snapshot'); assert.equal(rows.profit[0].name,'Deleted snapshot'); assert.equal(rows.quantity.find(x=>x.name==='Return only').quantity,-6); assert.equal(rows.profit.find(x=>x.name==='Return only').profit,-500);
});

test('expense categories include inactive historical identity and sum exactly to operating expenses', () => {
  const expenses=[{amount_syp:300,category_uuid:'active',category_name_ar:'نشطة',category_name_en:'Active',created_at:stamp(2)},{amount_syp:700,category_uuid:'inactive',category_name_ar:'مخفية',category_name_en:'Inactive',created_at:stamp(2)}]; const rows=aggregateExpenseCategories(expenses); assert.equal(rows.reduce((s,x)=>s+x.totalSyp,0),1000); assert.equal(rows.find(x=>x.categoryUuid==='inactive').totalSyp,700);
});

test('weekday strongest/weakest and hourly peak are deterministic and returns do not alter peak hour', () => {
  const s1=sale(1,stamp(1,18),100,0,50,[item(1,'A',1,100,50)]),s2=sale(2,stamp(2,18),200,0,100,[item(2,'B',1,200,100)]),s3=sale(3,stamp(2,6),50,0,25,[item(3,'C',1,50,25)]); const r=returned(4,stamp(2,23),1,[{sale_item_id:1,quantity:1,refund_amount_syp:250,cost_reversal_syp:100,product_name:'A'}]);
  const weekdays=analyzeWeekdays([s1,s2,s3],[r]); assert.equal(weekdays.strongest,2); assert.equal(weekdays.weakest,3); const hours=analyzeHours([s1,s2,s3]); assert.equal(hours.peakHour,18); assert.equal(hours.peakInvoiceCount,2);
  const tie=analyzeHours([sale(5,stamp(2,4),1,0,0,[]),sale(6,stamp(2,8),1,0,0,[])]); assert.equal(tie.peakHour,4); assert.equal(analyzeWeekdays([],[]).strongest,null);
});

test('exchange-rate summary needs a committed change at or before start and current comes from settings', () => {
  const range=getAnalyticsPeriodRange('day',now); const insufficient=buildRateSummary([{id:1,uuid:'h1',old_rate:14500,new_rate:14800,created_at:stamp(2,14)}],16000,range); assert.equal(insufficient.startRate,null); assert.equal(insufficient.currentRate,16000); const enough=buildRateSummary([{id:1,uuid:'h0',old_rate:14000,new_rate:14500,created_at:stamp(1)},{id:2,uuid:'h1',old_rate:14500,new_rate:14800,created_at:stamp(2,14)}],16000,range); assert.equal(enough.startRate,14500); assert.equal(enough.currentRate,16000); assert.equal(enough.changeCount,1);
});

test('insights ignore noise, avoid missing comparisons, prioritize deterministically and cap at five', () => {
  const current={returnRatePercent:8}; const comparisons={netProfit:compareMetric(130,100),netSales:compareMetric(120,100),expenses:compareMetric(110,100)}; const products={quantity:[],revenue:[],profit:[{name:'A',quantity:1,revenue:100,profit:50}]}; const weekdays={values:[],strongest:2,weakest:1}; const rows=generateAnalyticsInsights(current,comparisons,products,weekdays); assert.deepEqual(rows.map(x=>x.id),['profit-change','sales-change','high-returns','expense-change','top-product']); assert.equal(rows.length,5);
  const quiet=generateAnalyticsInsights({returnRatePercent:2},{netProfit:compareMetric(102,100),netSales:compareMetric(100,0),expenses:compareMetric(101,100)},{quantity:[],revenue:[],profit:[]},{values:[],strongest:null,weakest:null}); assert.equal(quiet.length,0);
});

test('Analytics 2.0 keeps no derived tables/dependencies and reuses native text/design controls', async () => {
const [db,dashboard,chart,pkg]=await Promise.all(['../src/database/database.ts','../src/components/analytics/AnalyticsDashboard.tsx','../src/components/analytics/SalesTrendChart.tsx','../package.json'].map(path=>readFile(new URL(path,import.meta.url),'utf8'))); assert.match(db,/SCHEMA_VERSION = 18/); assert.doesNotMatch(db,/analytics_totals|analytics_cache|daily_stats|insights_table/); assert.match(dashboard,/SegmentedControl/); assert.match(dashboard,/RateHistoryScreen/); assert.match(dashboard,/useMemo/); assert.doesNotMatch(chart,/SvgText/); const parsed=JSON.parse(pkg); assert.equal(parsed.dependencies['react-native-svg'],'15.15.4');
});

test('full analytics benchmark remains finite on the requested synthetic workload', () => {
  const sales=[]; const returns=[]; const expenses=[]; const history=[]; for(let i=0;i<5000;i++){ const items=[]; for(let j=0;j<5;j++)items.push(item(i*5+j+1,`Product ${i%10000}`,j+1,1000+j,500+j)); sales.push(sale(i+1,stamp(2,i%24),items.reduce((s,x)=>s+x.line_total_syp,0),0,items.reduce((s,x)=>s+x.line_cost_syp,0),items)); } for(let i=0;i<1000;i++)returns.push(returned(i+1,stamp(2,i%24),i+1,Array.from({length:3},(_,j)=>({sale_item_id:i*5+j+1,quantity:1,refund_amount_syp:500,cost_reversal_syp:250,product_name:`Product ${i%10000}`})))); for(let i=0;i<10000;i++){expenses.push({amount_syp:100+i%1000,category_uuid:`cat-${i%100}`,category_name_ar:`فئة ${i%100}`,category_name_en:`Category ${i%100}`,created_at:stamp(2)});history.push({id:i+1,uuid:`history-${i}`,old_rate:14000+i,new_rate:14001+i,created_at:stamp(i%2?1:2,i%24)});} const ranges={current:getAnalyticsPeriodRange('day',now),previous:getPreviousEquivalentPeriod('day',now)}; const current=aggregateAnalyticsRange(sales,expenses,returns,ranges.current); const comparisons={netSales:compareMetric(current.netSales,1),netProfit:compareMetric(current.netProfit,1),expenses:compareMetric(current.operatingExpenses,1)};
  const preparedProducts=aggregateAnalyticsProducts(current.sales,current.returns); const preparedWeekdays=analyzeWeekdays(current.sales,current.returns); const operations={currentPeriod:()=>aggregateAnalyticsRange(sales,expenses,returns,ranges.current),previousPeriod:()=>aggregateAnalyticsRange(sales,expenses,returns,ranges.previous),comparisonAdapter:()=>compareMetric(current.netSales,1),returnMetrics:()=>[current.refunds,current.returnCount,current.returnedQuantity,current.returnRatePercent],discountMetrics:()=>[current.discounts,current.discountRatePercent],expenseCategories:()=>aggregateExpenseCategories(current.expenses),topQuantity:()=>aggregateAnalyticsProducts(current.sales,current.returns).quantity,topRevenue:()=>aggregateAnalyticsProducts(current.sales,current.returns).revenue,topProfit:()=>aggregateAnalyticsProducts(current.sales,current.returns).profit,weekday:()=>analyzeWeekdays(current.sales,current.returns),hourly:()=>analyzeHours(current.sales),rateSummary:()=>buildRateSummary(history,15000,ranges.current),insights:()=>generateAnalyticsInsights(current,comparisons,preparedProducts,preparedWeekdays),finalViewModel:()=>buildAnalytics2(sales,expenses,'day',returns,history,15000,now)}; const report={}; for(const [name,operation] of Object.entries(operations)){operation();operation();const times=[];for(let run=0;run<5;run++){const start=performance.now();const value=operation();assert.ok(value!=null);times.push(performance.now()-start);}times.sort((a,b)=>a-b);report[name]={min:+times[0].toFixed(2),median:+times[2].toFixed(2),max:+times[4].toFixed(2)};} console.log(`PHASE12_PERFORMANCE=${JSON.stringify(report)}`); assert.equal(sales.length,5000); assert.equal(sales.reduce((s,x)=>s+x.items.length,0),25000); assert.equal(expenses.length,10000); assert.equal(history.length,10000);
});
