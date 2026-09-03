import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const historyProjection = `SELECT id,uuid,opened_at,closed_at,closing_difference_syp,closing_difference_usd_cents
  FROM cash_sessions WHERE closed_at IS NOT NULL`;
const oldSummary = `SELECT cs.*,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(s.sales_total_syp,0) ELSE cs.closing_sales_total_syp END AS sales_total_syp,COALESCE(s.invoice_count,0) AS invoice_count,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(r.refunds_total_syp,0) ELSE cs.closing_refunds_total_syp END AS refunds_total_syp,COALESCE(r.return_count,0) AS return_count,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(e.expenses_total_syp,0) ELSE cs.closing_expenses_total_syp END AS expenses_total_syp,COALESCE(e.expense_count,0) AS expense_count,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(p.cash_received_syp,0) ELSE COALESCE(cs.closing_cash_received_syp,cs.closing_sales_total_syp,0) END AS cash_received_syp,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(p.cash_received_usd_cents,0) ELSE COALESCE(cs.closing_cash_received_usd_cents,0) END AS cash_received_usd_cents,
  CASE WHEN cs.closed_at IS NULL THEN COALESCE(s.change_given_syp,0) ELSE COALESCE(cs.closing_change_given_syp,0) END AS change_given_syp,
  CASE WHEN cs.closed_at IS NULL THEN cs.opening_cash_syp+COALESCE(p.cash_received_syp,0)-COALESCE(s.change_given_syp,0)-COALESCE(r.refunds_total_syp,0)-COALESCE(e.expenses_total_syp,0) ELSE cs.closing_expected_cash_syp END AS expected_cash_syp,
  CASE WHEN cs.closed_at IS NULL THEN cs.opening_cash_usd_cents+COALESCE(p.cash_received_usd_cents,0) ELSE COALESCE(cs.closing_expected_cash_usd_cents,0) END AS expected_cash_usd_cents
  FROM cash_sessions cs
  LEFT JOIN (SELECT cash_session_id,SUM(net_total_syp) AS sales_total_syp,SUM(COALESCE(change_syp,0)) AS change_given_syp,COUNT(*) AS invoice_count FROM sales WHERE cash_session_id IS NOT NULL GROUP BY cash_session_id) s ON s.cash_session_id=cs.id
  LEFT JOIN (SELECT s.cash_session_id,SUM(CASE WHEN sp.currency='SYP' THEN sp.amount_minor ELSE 0 END) AS cash_received_syp,SUM(CASE WHEN sp.currency='USD' THEN sp.amount_minor ELSE 0 END) AS cash_received_usd_cents FROM sales s JOIN sale_payments sp ON sp.sale_id=s.id WHERE s.cash_session_id IS NOT NULL GROUP BY s.cash_session_id) p ON p.cash_session_id=cs.id
  LEFT JOIN (SELECT cash_session_id,SUM(refund_total_syp) AS refunds_total_syp,COUNT(*) AS return_count FROM sale_returns WHERE cash_session_id IS NOT NULL GROUP BY cash_session_id) r ON r.cash_session_id=cs.id
  LEFT JOIN (SELECT cash_session_id,SUM(amount_syp) AS expenses_total_syp,COUNT(*) AS expense_count FROM expenses WHERE cash_session_id IS NOT NULL GROUP BY cash_session_id) e ON e.cash_session_id=cs.id`;

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA user_version=13;
    CREATE TABLE cash_sessions(id INTEGER PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,opened_at TEXT NOT NULL,closed_at TEXT,opening_cash_syp INTEGER NOT NULL,closing_actual_cash_syp INTEGER,closing_sales_total_syp INTEGER,closing_refunds_total_syp INTEGER,closing_expenses_total_syp INTEGER,closing_expected_cash_syp INTEGER,closing_difference_syp INTEGER,opening_cash_usd_cents INTEGER NOT NULL,closing_actual_cash_usd_cents INTEGER,closing_expected_cash_usd_cents INTEGER,closing_difference_usd_cents INTEGER,closing_cash_received_syp INTEGER,closing_cash_received_usd_cents INTEGER,closing_change_given_syp INTEGER,opening_note TEXT,closing_note TEXT,created_at TEXT,updated_at TEXT);
    CREATE UNIQUE INDEX idx_cash_sessions_uuid ON cash_sessions(uuid); CREATE INDEX idx_cash_sessions_opened_at ON cash_sessions(opened_at); CREATE INDEX idx_cash_sessions_closed_at ON cash_sessions(closed_at);
    CREATE TABLE sales(id INTEGER PRIMARY KEY,cash_session_id INTEGER,net_total_syp INTEGER,change_syp INTEGER); CREATE INDEX idx_sales_cash_session_id ON sales(cash_session_id);
    CREATE TABLE sale_payments(id INTEGER PRIMARY KEY,sale_id INTEGER,currency TEXT,amount_minor INTEGER); CREATE INDEX idx_sale_payments_sale_id ON sale_payments(sale_id);
    CREATE TABLE sale_returns(id INTEGER PRIMARY KEY,cash_session_id INTEGER,refund_total_syp INTEGER); CREATE INDEX idx_sale_returns_cash_session_id ON sale_returns(cash_session_id);
    CREATE TABLE expenses(id INTEGER PRIMARY KEY,cash_session_id INTEGER,amount_syp INTEGER); CREATE INDEX idx_expenses_cash_session_id ON expenses(cash_session_id);`);
  const session = db.prepare(`INSERT INTO cash_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const sale = db.prepare('INSERT INTO sales VALUES(?,?,?,?)'); const payment = db.prepare('INSERT INTO sale_payments VALUES(?,?,?,?)');
  const returned = db.prepare('INSERT INTO sale_returns VALUES(?,?,?)'); const expense = db.prepare('INSERT INTO expenses VALUES(?,?,?)');
  db.exec('BEGIN');
  for (let i=1;i<=10000;i++) { const day=String((i%28)+1).padStart(2,'0'); const v13=i%2===0; session.run(i,uuid(i),`2026-01-${day}T${String(i%24).padStart(2,'0')}:00:00Z`,`2026-01-${day}T23:00:00Z`,100000,120000,1000000,10000,20000,1070000,i%3-1,0,v13?2500:null,v13?2500:null,v13?(i%5-2):null,v13?500000:null,v13?2500:null,v13?30000:null,'opening '.repeat(8),'closing '.repeat(8),'2026','2026'); }
  for (let i=1;i<=5000;i++) { sale.run(i,10000,1000,0); const mixed=i%2===0,usd=i%4===1; if(!usd) payment.run(i,i,'SYP',mixed?500:1000); if(usd||mixed) payment.run(10000+i,i,'USD',mixed?4:7); }
  for (let i=1;i<=1000;i++) returned.run(i,10000,100);
  for (let i=1;i<=10000;i++) expense.run(i,10000,25);
  db.exec('COMMIT'); return db;
}

function measure(run) { run(); const values=[]; for(let i=0;i<7;i++){const start=performance.now();run();values.push(performance.now()-start);} values.sort((a,b)=>a-b); return {min:+values[0].toFixed(3),median:+values[3].toFixed(3),max:+values[6].toFixed(3)}; }
const plan = (db,sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row=>row.detail);

test('history projection preserves newest/oldest, legacy/v13 identity and unique rows', () => {
  const db=database(); const newest=db.prepare(`${historyProjection} ORDER BY opened_at DESC,id DESC`).all(); const oldest=db.prepare(`${historyProjection} ORDER BY opened_at ASC,id ASC`).all();
  assert.equal(newest.length,10000); assert.equal(new Set(newest.map(row=>row.uuid)).size,10000); assert.deepEqual(oldest.map(row=>row.id),newest.map(row=>row.id).reverse());
  assert.equal(newest.find(row=>row.id%2===1).closing_difference_usd_cents,null); assert.equal(typeof newest.find(row=>row.id%2===0).closing_difference_usd_cents,'number'); db.close();
});

test('history is one narrow snapshot query while detail remains complete', async () => {
  const source=await readFile(new URL('../src/database/database.ts',import.meta.url),'utf8');
  const history=source.match(/export async function getCashSessionHistory[\s\S]*?\n\}/)?.[0]??'';
  assert.match(history,/SELECT id,uuid,opened_at,closed_at,closing_difference_syp,closing_difference_usd_cents/);
  assert.doesNotMatch(history,/SELECT \*|sale_payments|JOIN sales|JOIN expenses|JOIN sale_returns/);
  assert.match(source,/getCashSessionDetail[\s\S]*?cashSessionDetailSelect/);
  const db=database(); const detail=db.prepare('SELECT * FROM cash_sessions WHERE id=?').get(2); for(const field of ['opening_cash_syp','closing_sales_total_syp','closing_refunds_total_syp','closing_expenses_total_syp','closing_expected_cash_syp','closing_actual_cash_usd_cents','opening_note','closing_note']) assert.ok(Object.hasOwn(detail,field)); db.close();
});

test('10k history before/after timing and query plans are measured over seven runs', () => {
  const db=database(); const beforeNewest=`${oldSummary} WHERE cs.closed_at IS NOT NULL ORDER BY cs.opened_at DESC,cs.id DESC`; const beforeOldest=`${oldSummary} WHERE cs.closed_at IS NOT NULL ORDER BY cs.opened_at ASC,cs.id ASC`; const afterNewest=`${historyProjection} ORDER BY opened_at DESC,id DESC`; const afterOldest=`${historyProjection} ORDER BY opened_at ASC,id ASC`;
  const raw=db.prepare(afterNewest).all(); const date=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); const number=new Intl.NumberFormat('en-US');
  const report={beforeNewest:measure(()=>db.prepare(beforeNewest).all()),beforeOldest:measure(()=>db.prepare(beforeOldest).all()),afterNewest:measure(()=>db.prepare(afterNewest).all()),afterOldest:measure(()=>db.prepare(afterOldest).all()),hydration:measure(()=>raw.map(row=>({id:row.id,uuid:row.uuid,opened_at:row.opened_at,closed_at:row.closed_at,closing_difference_syp:row.closing_difference_syp,closing_difference_usd_cents:row.closing_difference_usd_cents}))),legacyNormalization:measure(()=>raw.map(row=>row.closing_difference_usd_cents==null?{...row,legacy:true}:{...row,legacy:false})),snapshotMapping:measure(()=>raw.map(row=>({id:row.id,sypDifference:row.closing_difference_syp??0,usdDifference:row.closing_difference_usd_cents}))),formatting:measure(()=>raw.map(row=>({date:date.format(new Date(row.opened_at)),difference:number.format(row.closing_difference_syp??0)}))),jsSorting:measure(()=>[...raw].sort((a,b)=>b.opened_at.localeCompare(a.opened_at)||b.id-a.id)),viewModel:measure(()=>raw.map(row=>({key:row.uuid,date:date.format(new Date(row.opened_at)),durationMs:Date.parse(row.closed_at)-Date.parse(row.opened_at),difference:row.closing_difference_syp??0,status:(row.closing_difference_syp??0)===0?'balanced':row.closing_difference_syp>0?'surplus':'shortage',legacy:row.closing_difference_usd_cents==null}))),fullLoad:measure(()=>db.prepare(afterNewest).all().map(row=>({key:row.uuid,difference:row.closing_difference_syp??0,legacy:row.closing_difference_usd_cents==null})))};
  const plans={beforeNewest:plan(db,beforeNewest),beforeOldest:plan(db,beforeOldest),afterNewest:plan(db,afterNewest),afterOldest:plan(db,afterOldest)};
  assert.ok(plans.beforeNewest.some(item=>/MATERIALIZE/.test(item))); assert.ok(plans.afterNewest.some(item=>/idx_cash_sessions_opened_at/.test(item))); assert.ok(plans.afterOldest.some(item=>/idx_cash_sessions_opened_at/.test(item))); assert.ok(!plans.afterNewest.some(item=>/TEMP B-TREE/.test(item))); assert.ok(report.fullLoad.median<70);
  console.log(`PHASE14_5_PERFORMANCE=${JSON.stringify(report)}`); console.log(`PHASE14_5_PLANS=${JSON.stringify(plans)}`); db.close();
});
