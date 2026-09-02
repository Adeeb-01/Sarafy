import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { allocateInvoiceDiscount, cumulativeAmount, deriveReturnStatus, previewReturn } from '../src/utils/returns.ts';
import { buildAnalytics, dailyRevenueSeries } from '../src/utils/salesAnalytics.ts';

const item = (id, gross, cost, quantity, name = `P${id}`) => ({ id, uuid:`i${id}`, sale_id:1, product_id:null, product_name:name, barcode_snapshot:null, quantity, unit_price_syp:gross/quantity, unit_cost_syp:cost/quantity, line_total_syp:gross, line_cost_syp:cost, created_at:'2026-08-31T00:00:00Z', updated_at:'2026-08-31T00:00:00Z' });
const sale = (items, subtotal, discount, net) => ({ id:1, uuid:'s1', invoice_number:'INV-1', exchange_rate:15000, subtotal_syp:subtotal, discount_syp:discount, net_total_syp:net, cost_syp:items.reduce((s,i)=>s+i.line_cost_syp,0), profit_syp:net-items.reduce((s,i)=>s+i.line_cost_syp,0), amount_paid_syp:100000, change_syp:100000-net, created_at:'2026-08-31T00:00:00Z', updated_at:'2026-08-31T00:00:00Z', items, returns:[] });

test('discount allocation is exact and deterministic', () => {
  const s=sale([item(1,60000,30000,2),item(2,40000,20000,2)],100000,10000,90000); const a=allocateInvoiceDiscount(s);
  assert.deepEqual([...a.entries()].sort(),[[1,6000],[2,4000]]); assert.equal([...a.values()].reduce((x,y)=>x+y,0),10000);
  assert.equal(s.items.reduce((sum,line)=>sum+line.line_total_syp-(a.get(line.id)??0),0),s.net_total_syp);
});

test('odd largest-remainder allocation preserves invoice invariant', () => {
  const s=sale([item(3,3334,2000,2),item(1,3334,1001,3),item(2,3335,2002,5)],10003,1001,9002); const a=allocateInvoiceDiscount(s);
  assert.equal([...a.values()].reduce((x,y)=>x+y,0),1001); assert.equal(s.items.reduce((x,i)=>x+i.line_total_syp-(a.get(i.id)??0),0),9002);
});

test('three separate partial returns settle line net and historical cost exactly', () => {
  assert.deepEqual([cumulativeAmount(10001,3,0,1),cumulativeAmount(10001,3,1,1),cumulativeAmount(10001,3,2,1)], [3333,3334,3334]);
  assert.equal(cumulativeAmount(7001,3,0,1)+cumulativeAmount(7001,3,1,1)+cumulativeAmount(7001,3,2,1),7001);
});

test('preview supports partial, multiple and full returns without using paid amount', () => {
  const s=sale([item(1,10001,7001,3)],10001,0,10001);
  const first=previewReturn(s,[{saleItemId:1,quantity:1}]); assert.equal(first.refundTotalSyp,3333);
  s.returns=[{id:1,uuid:'r1',sale_id:1,refund_total_syp:3333,returned_cost_syp:2333,created_at:'2026-09-01T00:00:00Z',updated_at:'2026-09-01T00:00:00Z',items:[{id:1,uuid:'ri1',return_id:1,sale_item_id:1,quantity:1,refund_amount_syp:3333,cost_reversal_syp:2333,created_at:'2026-09-01T00:00:00Z',updated_at:'2026-09-01T00:00:00Z',product_name:'P1',barcode_snapshot:null}]}];
  const remaining=previewReturn(s,[{saleItemId:1,quantity:2}]); assert.equal(first.refundTotalSyp+remaining.refundTotalSyp,10001); assert.equal(first.returnedCostSyp+remaining.returnedCostSyp,7001);
  assert.throws(()=>previewReturn(s,[{saleItemId:1,quantity:3}]),/RETURN_QUANTITY_EXCEEDED/);
});

test('derived invoice status is none, partial and full', () => {
  const s=sale([item(1,5000,3000,5)],5000,0,5000); assert.equal(deriveReturnStatus(s.items,[]),'none');
  const r={id:1,uuid:'r',sale_id:1,refund_total_syp:2000,returned_cost_syp:1200,created_at:'x',updated_at:'x',items:[{id:1,uuid:'ri',return_id:1,sale_item_id:1,quantity:2,refund_amount_syp:2000,cost_reversal_syp:1200,created_at:'x',updated_at:'x',product_name:'P1',barcode_snapshot:null}]};
  assert.equal(deriveReturnStatus(s.items,[r]),'partial'); r.items[0].quantity=5; assert.equal(deriveReturnStatus(s.items,[r]),'full');
});

test('returns affect their own date, allow negative days, and preserve profit equation', () => {
  const now=new Date(); const sunday=new Date(now); sunday.setHours(10,0,0,0); const tuesday=new Date(now); tuesday.setHours(12,0,0,0);
  const s=sale([item(1,100000,70000,5)],100000,0,100000); s.created_at=sunday.toISOString(); s.cost_syp=70000; s.profit_syp=30000;
  const record={id:1,uuid:'r',sale_id:1,refund_total_syp:40000,returned_cost_syp:28000,created_at:tuesday.toISOString(),updated_at:tuesday.toISOString(),items:[{id:1,uuid:'ri',return_id:1,sale_item_id:1,quantity:2,refund_amount_syp:40000,cost_reversal_syp:28000,created_at:tuesday.toISOString(),updated_at:tuesday.toISOString(),product_name:'P1',barcode_snapshot:null}]}; s.returns=[record];
  const analytics=buildAnalytics([s],[],'day',[record]); assert.equal(analytics.revenue,60000); assert.equal(analytics.netCogs,42000); assert.equal(analytics.grossProfit,18000); assert.equal(analytics.netProfit,analytics.revenue-analytics.netCogs);
  const returnOnly={...record,refund_total_syp:140000,items:[{...record.items[0],refund_amount_syp:140000}]}; const points=dailyRevenueSeries([s],'day',[returnOnly]); assert.equal(points.at(-1).value,-40000);
});

function dbV10() { const db=new DatabaseSync(':memory:'); db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE sales(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE,net_total_syp INTEGER); CREATE TABLE sale_items(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE,sale_id INTEGER REFERENCES sales(id),product_id INTEGER,product_name TEXT,quantity INTEGER,line_cost_syp INTEGER); CREATE TABLE sale_returns(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE,sale_id INTEGER REFERENCES sales(id),refund_total_syp INTEGER,returned_cost_syp INTEGER,created_at TEXT,updated_at TEXT); CREATE TABLE sale_return_items(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE,return_id INTEGER REFERENCES sale_returns(id),sale_item_id INTEGER REFERENCES sale_items(id),quantity INTEGER,refund_amount_syp INTEGER,cost_reversal_syp INTEGER,created_at TEXT,updated_at TEXT); INSERT INTO sales VALUES(1,'s',90000); INSERT INTO sale_items VALUES(1,'i',1,NULL,'Deleted product snapshot',3,60000);`); return db; }

test('transaction rollback leaves zero header and items',()=>{ const db=dbV10(); try{db.exec("BEGIN; INSERT INTO sale_returns VALUES(1,'r',1,30000,20000,'x','x');"); throw Error('forced');}catch{db.exec('ROLLBACK');} assert.equal(db.prepare('SELECT COUNT(*) c FROM sale_returns').get().c,0); assert.equal(db.prepare('SELECT COUNT(*) c FROM sale_return_items').get().c,0); db.close(); });

test('deleted product snapshot remains returnable and duplicate UUID cannot double refund',()=>{ const db=dbV10(); db.exec("BEGIN; INSERT INTO sale_returns VALUES(1,'r',1,30000,20000,'x','x'); INSERT INTO sale_return_items VALUES(1,'ri',1,1,1,30000,20000,'x','x'); COMMIT;"); assert.equal(db.prepare('SELECT product_name FROM sale_items WHERE id=1').get().product_name,'Deleted product snapshot'); assert.throws(()=>db.exec("INSERT INTO sale_returns VALUES(2,'r',1,30000,20000,'x','x')")); db.close(); });

test('v9 to v10 migration preserves rows and adds indexed empty return tables',()=>{ const db=new DatabaseSync(':memory:'); db.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY,invoice_number TEXT); CREATE TABLE sale_items(id INTEGER PRIMARY KEY,sale_id INTEGER,quantity INTEGER); INSERT INTO sales VALUES(1,'INV'); INSERT INTO sale_items VALUES(1,1,2); PRAGMA user_version=9; CREATE TABLE sale_returns(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE,sale_id INTEGER,refund_total_syp INTEGER,returned_cost_syp INTEGER,created_at TEXT,updated_at TEXT); CREATE TABLE sale_return_items(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE,return_id INTEGER,sale_item_id INTEGER,quantity INTEGER,refund_amount_syp INTEGER,cost_reversal_syp INTEGER,created_at TEXT,updated_at TEXT); CREATE INDEX idx_sale_returns_sale_id ON sale_returns(sale_id); CREATE INDEX idx_sale_returns_created_at ON sale_returns(created_at); CREATE INDEX idx_sale_return_items_return_id ON sale_return_items(return_id); CREATE INDEX idx_sale_return_items_sale_item_id ON sale_return_items(sale_item_id); PRAGMA user_version=10;`); assert.equal(db.prepare('SELECT COUNT(*) c FROM sales').get().c,1); assert.equal(db.prepare('SELECT COUNT(*) c FROM sale_returns').get().c,0); assert.equal(db.prepare('PRAGMA user_version').get().user_version,10); db.close(); });

test('5k/25k/1k/3k aggregate queries stay bounded and indexed',()=>{ const db=new DatabaseSync(':memory:'); db.exec('CREATE TABLE sales(id INTEGER PRIMARY KEY,net INTEGER,created_at TEXT); CREATE TABLE sale_items(id INTEGER PRIMARY KEY,sale_id INTEGER,quantity INTEGER); CREATE TABLE sale_returns(id INTEGER PRIMARY KEY,sale_id INTEGER,refund INTEGER,created_at TEXT); CREATE TABLE sale_return_items(id INTEGER PRIMARY KEY,return_id INTEGER,sale_item_id INTEGER,quantity INTEGER); CREATE INDEX rs ON sale_returns(sale_id); CREATE INDEX rc ON sale_returns(created_at); CREATE INDEX rir ON sale_return_items(return_id); CREATE INDEX ris ON sale_return_items(sale_item_id);'); const s=db.prepare('INSERT INTO sales VALUES(?,?,?)'),si=db.prepare('INSERT INTO sale_items VALUES(?,?,?)'),r=db.prepare('INSERT INTO sale_returns VALUES(?,?,?,?)'),ri=db.prepare('INSERT INTO sale_return_items VALUES(?,?,?,?)'); db.exec('BEGIN'); for(let x=1;x<=5000;x++){s.run(x,10000,'2026-09-01');for(let y=1;y<=5;y++)si.run((x-1)*5+y,x,2);} for(let x=1;x<=1000;x++){r.run(x,x,1000,'2026-09-01');for(let y=1;y<=3;y++)ri.run((x-1)*3+y,x,(x-1)*5+y,1);} db.exec('COMMIT'); const start=performance.now(); const rows=db.prepare('SELECT s.id,COALESCE(SUM(ri.quantity),0) returned FROM sales s LEFT JOIN sale_returns r ON r.sale_id=s.id LEFT JOIN sale_return_items ri ON ri.return_id=r.id GROUP BY s.id').all(); const ms=performance.now()-start; assert.equal(rows.length,5000); assert.ok(ms<1000); console.log(`phase10_5k_25k_1k_3k_ms=${ms.toFixed(2)}`); db.close(); });

test('backup v11 retains portable return references while old payload fields stay optional', async()=>{ const manager=await readFile(new URL('../src/backup/backupManager.ts',import.meta.url),'utf8'); const types=await readFile(new URL('../src/import/importTypes.ts',import.meta.url),'utf8'); assert.match(manager,/SCHEMA_VERSION = 11/); assert.match(manager,/sale_uuid:/); assert.match(manager,/sale_item_uuid:/); assert.match(types,/returns\?: PortableSaleReturn\[\]/); });

test('safe merge resolves parents, reports missing references, and skips duplicate return UUID', async()=>{ const importer=await readFile(new URL('../src/import/jsonImporter.ts',import.meta.url),'utf8'); const analyzer=await readFile(new URL('../src/import/importAnalyzer.ts',import.meta.url),'utf8'); assert.match(importer,/SELECT id FROM sale_returns WHERE uuid=\?/); assert.match(importer,/if \(duplicate\) \{ skipped \+= 1; continue; \}/); assert.match(importer,/RETURN_ITEM_PARENT_MISSING/); assert.match(analyzer,/RETURN_PARENT_MISSING/); assert.match(analyzer,/RETURN_ITEM_PARENT_MISSING/); });

test('full restore deletes return children before immutable sales and Excel is export-only compatible', async()=>{ const importer=await readFile(new URL('../src/import/jsonImporter.ts',import.meta.url),'utf8'); const excel=await readFile(new URL('../src/utils/excel.ts',import.meta.url),'utf8'); assert.ok(importer.indexOf("DELETE FROM sale_return_items")<importer.indexOf("DELETE FROM sale_items")); assert.ok(importer.indexOf("DELETE FROM sale_returns")<importer.indexOf("DELETE FROM sales")); assert.match(excel,/book_append_sheet\(workbook, returnsSheet, 'Returns'\)/); assert.match(excel,/book_append_sheet\(workbook, returnItemsSheet, 'Return Items'\)/); });

test('portable v10 backup round trip preserves refund, status, analytics, and remaining quantity',()=>{ const original=sale([item(1,90000,60000,3,'Snapshot')],90000,0,90000); original.created_at=new Date().toISOString(); const first=previewReturn(original,[{saleItemId:1,quantity:1}]); original.returns=[{id:1,uuid:'return-portable',sale_id:1,refund_total_syp:first.refundTotalSyp,returned_cost_syp:first.returnedCostSyp,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),items:[{id:1,uuid:'return-item-portable',return_id:1,sale_item_id:1,quantity:1,refund_amount_syp:first.refundTotalSyp,cost_reversal_syp:first.returnedCostSyp,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),product_name:'Snapshot',barcode_snapshot:null}]}]; const restored=structuredClone(JSON.parse(JSON.stringify(original))); assert.equal(restored.net_total_syp,90000); assert.equal(restored.returns[0].refund_total_syp,30000); assert.equal(deriveReturnStatus(restored.items,restored.returns),'partial'); assert.equal(restored.items[0].quantity-restored.returns[0].items[0].quantity,2); const a=buildAnalytics([restored],[],'day'); assert.equal(a.revenue,60000); assert.equal(a.netCogs,40000); });
