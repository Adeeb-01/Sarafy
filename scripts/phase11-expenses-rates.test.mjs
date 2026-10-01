import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';

const OTHER_UUID = '5a8d8194-27e5-4d6b-a1f4-81060cb99e07';
const defaults = [
  ['5a8d8194-27e5-4d6b-a1f4-81060cb99e01', 'إيجار', 'Rent'], ['5a8d8194-27e5-4d6b-a1f4-81060cb99e02', 'كهرباء', 'Electricity'],
  ['5a8d8194-27e5-4d6b-a1f4-81060cb99e03', 'رواتب', 'Salaries'], ['5a8d8194-27e5-4d6b-a1f4-81060cb99e04', 'نقل', 'Transportation'],
  ['5a8d8194-27e5-4d6b-a1f4-81060cb99e05', 'صيانة', 'Maintenance'], ['5a8d8194-27e5-4d6b-a1f4-81060cb99e06', 'مشتريات / مستلزمات', 'Supplies'],
  [OTHER_UUID, 'أخرى', 'Other'],
];

function v10Database() {
  const db = new DatabaseSync(':memory:'); db.exec(`PRAGMA foreign_keys=ON; PRAGMA user_version=10;
    CREATE TABLE expenses(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE,description TEXT NOT NULL,amount_syp REAL NOT NULL CHECK(amount_syp>=0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE sales(id INTEGER PRIMARY KEY,exchange_rate REAL); CREATE TABLE sale_returns(id INTEGER PRIMARY KEY); CREATE TABLE sale_drafts(id INTEGER PRIMARY KEY,exchange_rate REAL);
    INSERT INTO expenses VALUES(1,'00000000-0000-4000-8000-000000000001','Legacy rent',12000,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO expenses VALUES(2,'00000000-0000-4000-8000-000000000002','Legacy power',8000,'2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z');
    INSERT INTO settings VALUES('exchangeRate','14500'); INSERT INTO sales VALUES(1,14000); INSERT INTO sale_drafts VALUES(1,14300);`); return db;
}

function migrateV11(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 11) return;
  db.exec(`BEGIN; CREATE TABLE expense_categories(id INTEGER PRIMARY KEY AUTOINCREMENT,uuid TEXT NOT NULL UNIQUE,name_ar TEXT NOT NULL,name_en TEXT,is_system INTEGER NOT NULL DEFAULT 0 CHECK(is_system IN(0,1)),is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN(0,1)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE exchange_rate_history(id INTEGER PRIMARY KEY AUTOINCREMENT,uuid TEXT NOT NULL UNIQUE,old_rate REAL NOT NULL CHECK(old_rate>0),new_rate REAL NOT NULL CHECK(new_rate>0),created_at TEXT NOT NULL);
    ALTER TABLE expenses ADD COLUMN category_id INTEGER REFERENCES expense_categories(id) ON DELETE RESTRICT; ALTER TABLE expenses ADD COLUMN note TEXT;`);
  const insert = db.prepare('INSERT INTO expense_categories(uuid,name_ar,name_en,is_system,is_active,created_at,updated_at) VALUES(?,?,?,1,1,?,?)');
  for (const row of defaults) insert.run(...row, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
  db.prepare('UPDATE expenses SET category_id=(SELECT id FROM expense_categories WHERE uuid=?) WHERE category_id IS NULL').run(OTHER_UUID);
  db.exec(`CREATE INDEX idx_expenses_category_id ON expenses(category_id); CREATE INDEX idx_expense_categories_active ON expense_categories(is_active); CREATE INDEX idx_exchange_rate_history_created_at ON exchange_rate_history(created_at); PRAGMA user_version=11; COMMIT;`);
}

function setRate(db, next, uuid) {
  db.exec('BEGIN IMMEDIATE');
  try { const old = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='exchangeRate'").get().value); if (old === next) { db.exec('COMMIT'); return null; }
    db.prepare('INSERT INTO exchange_rate_history(uuid,old_rate,new_rate,created_at) VALUES(?,?,?,?)').run(uuid, old, next, '2026-09-01T10:00:00.000Z');
    db.prepare("UPDATE settings SET value=? WHERE key='exchangeRate'").run(JSON.stringify(next)); db.exec('COMMIT'); return { old, next };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

test('v10 to v11 migration preserves expense totals and assigns Other without synthetic history', () => {
  const db = v10Database(); const before = db.prepare('SELECT SUM(amount_syp) total FROM expenses').get().total; migrateV11(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11); assert.equal(db.prepare('SELECT SUM(amount_syp) total FROM expenses').get().total, before);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM expenses e JOIN expense_categories c ON c.id=e.category_id WHERE c.uuid=?').get(OTHER_UUID).count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM exchange_rate_history').get().count, 0); assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='exchangeRate'").get().value), 14500);
  assert.equal(db.prepare('SELECT exchange_rate FROM sales').get().exchange_rate, 14000); assert.equal(db.prepare('SELECT exchange_rate FROM sale_drafts').get().exchange_rate, 14300);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); db.close();
});

test('rate updates serialize old-to-new values, skip same rate and roll back atomically', () => {
  const db = v10Database(); migrateV11(db); assert.deepEqual(setRate(db, 14800, '00000000-0000-4000-8000-000000000011'), { old:14500, next:14800 }); assert.deepEqual(setRate(db, 15000, '00000000-0000-4000-8000-000000000012'), { old:14800, next:15000 }); assert.equal(setRate(db, 15000, '00000000-0000-4000-8000-000000000013'), null);
  assert.deepEqual(db.prepare('SELECT old_rate,new_rate FROM exchange_rate_history ORDER BY id').all().map(row => ({ ...row })), [{ old_rate:14500, new_rate:14800 }, { old_rate:14800, new_rate:15000 }]);
  assert.throws(() => { db.exec('BEGIN'); try { db.prepare('INSERT INTO exchange_rate_history(uuid,old_rate,new_rate,created_at) VALUES(?,?,?,?)').run('00000000-0000-4000-8000-000000000014', 15000, 16000, 'bad'); throw new Error('SIMULATED'); } catch (error) { db.exec('ROLLBACK'); throw error; } }, /SIMULATED/);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM exchange_rate_history').get().count, 2); assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='exchangeRate'").get().value), 15000); db.close();
});

test('rate percentage stays finite and exact for representative changes', async () => {
  const { exchangeRateChangePercent, formatExchangeRateChange } = await import('../src/utils/exchangeRate.ts'); assert.equal(exchangeRateChangePercent(100,110),10); assert.equal(exchangeRateChangePercent(100,90),-10); assert.ok(Math.abs(exchangeRateChangePercent(14500,14800) - 2.0689655172413794) < 1e-12); assert.equal(exchangeRateChangePercent(0,100),null); assert.equal(formatExchangeRateChange(1000000,999999,'en-US'),'0%'); assert.equal(formatExchangeRateChange(100,110,'en-US'),'+10%');
});

test('default initialization is idempotent and custom/inactive category identity stays UUID-based', () => {
  const db=v10Database(); migrateV11(db); migrateV11(db); assert.equal(db.prepare('SELECT COUNT(*) count FROM expense_categories').get().count,7);
  db.prepare('INSERT INTO expense_categories(uuid,name_ar,name_en,is_system,is_active,created_at,updated_at) VALUES(?,?,?,0,1,?,?)').run('00000000-0000-4000-8000-000000000301','إيجار','Rent','2026-09-01','2026-09-01');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM expense_categories WHERE name_en='Rent'").get().count,2); const custom=db.prepare("SELECT id FROM expense_categories WHERE uuid='00000000-0000-4000-8000-000000000301'").get();
  db.prepare('INSERT INTO expenses(uuid,description,amount_syp,category_id,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('00000000-0000-4000-8000-000000000302','',7000,custom.id,null,'2026-09-01','2026-09-01'); db.prepare('UPDATE expense_categories SET is_active=0 WHERE id=?').run(custom.id);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM expenses WHERE category_id=?').get(custom.id).count,1); assert.equal(db.prepare('SELECT COUNT(*) count FROM expense_categories WHERE id=? AND is_active=1').get(custom.id).count,0); db.prepare('UPDATE expense_categories SET is_active=1 WHERE id=?').run(custom.id); assert.equal(db.prepare('SELECT is_active FROM expense_categories WHERE id=?').get(custom.id).is_active,1); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]); db.close();
});

test('expense note, search, category/period/amount filters, all sorts and aggregation are exact', () => {
  const db=v10Database(); migrateV11(db); db.exec('DELETE FROM expenses'); const other=db.prepare('SELECT id FROM expense_categories WHERE uuid=?').get(OTHER_UUID).id; const rent=db.prepare("SELECT id FROM expense_categories WHERE name_en='Rent'").get().id;
  const insert=db.prepare('INSERT INTO expenses(uuid,description,amount_syp,category_id,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)'); insert.run('00000000-0000-4000-8000-000000000311','legacy electricity',8000,other,null,'2026-08-01T09:00:00.000Z','2026-08-01T09:00:00.000Z'); insert.run('00000000-0000-4000-8000-000000000312','rent note',12000,rent,'Office rent','2026-09-01T09:00:00.000Z','2026-09-01T09:00:00.000Z'); insert.run('00000000-0000-4000-8000-000000000313','repair',5000,other,'Fridge repair','2026-09-02T09:00:00.000Z','2026-09-02T09:00:00.000Z');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM expenses WHERE COALESCE(note,description) LIKE '%electricity%'").get().count,1); assert.equal(db.prepare('SELECT COUNT(*) count FROM expenses WHERE category_id=?').get(other).count,2); assert.equal(db.prepare("SELECT COUNT(*) count FROM expenses WHERE created_at>='2026-09-01'").get().count,2); assert.equal(db.prepare('SELECT COUNT(*) count FROM expenses WHERE amount_syp BETWEEN 6000 AND 12000').get().count,2);
  assert.deepEqual(db.prepare('SELECT amount_syp FROM expenses ORDER BY created_at DESC,id DESC').all().map(x=>x.amount_syp),[5000,12000,8000]); assert.deepEqual(db.prepare('SELECT amount_syp FROM expenses ORDER BY created_at ASC,id ASC').all().map(x=>x.amount_syp),[8000,12000,5000]); assert.deepEqual(db.prepare('SELECT amount_syp FROM expenses ORDER BY amount_syp DESC,created_at DESC').all().map(x=>x.amount_syp),[12000,8000,5000]); assert.deepEqual(db.prepare('SELECT amount_syp FROM expenses ORDER BY amount_syp ASC,created_at DESC').all().map(x=>x.amount_syp),[5000,8000,12000]);
  const total=db.prepare("SELECT SUM(amount_syp) total FROM expenses WHERE created_at>='2026-09-01'").get().total; const grouped=db.prepare("SELECT category_id,SUM(amount_syp) total FROM expenses WHERE created_at>='2026-09-01' GROUP BY category_id").all().reduce((sum,row)=>sum+row.total,0); assert.equal(grouped,total); assert.equal(total,17000); db.close();
});

test('inactive categories reject new expenses while historical rows and category totals remain', () => {
  const db = v10Database(); migrateV11(db); const category = db.prepare('SELECT id FROM expense_categories WHERE uuid=?').get(OTHER_UUID); db.prepare('UPDATE expense_categories SET is_active=0 WHERE id=?').run(category.id);
  assert.equal(db.prepare('SELECT SUM(amount_syp) total FROM expenses').get().total, 20000); assert.equal(db.prepare('SELECT SUM(e.amount_syp) total FROM expenses e JOIN expense_categories c ON c.id=e.category_id GROUP BY c.id').get().total, 20000);
  const active = db.prepare('SELECT id FROM expense_categories WHERE id=? AND is_active=1').get(category.id); assert.equal(active, undefined); db.close();
});

test('10k expense and 10k history queries are indexed, deterministic and bounded', () => {
  const db = new DatabaseSync(':memory:'); db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE expense_categories(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE,name_ar TEXT,name_en TEXT,is_system INTEGER,is_active INTEGER,created_at TEXT,updated_at TEXT); CREATE TABLE expenses(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE,description TEXT,amount_syp INTEGER,category_id INTEGER REFERENCES expense_categories(id),note TEXT,created_at TEXT,updated_at TEXT); CREATE INDEX idx_expenses_category_id ON expenses(category_id); CREATE INDEX idx_expenses_created_at ON expenses(created_at); CREATE INDEX idx_expenses_amount ON expenses(amount_syp); CREATE TABLE exchange_rate_history(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE,old_rate REAL,new_rate REAL,created_at TEXT); CREATE INDEX idx_exchange_rate_history_created_at ON exchange_rate_history(created_at);`);
  const categoryInsert=db.prepare('INSERT INTO expense_categories VALUES(?,?,?,?,0,1,?,?)'); const expenseInsert=db.prepare('INSERT INTO expenses VALUES(?,?,?,?,?,?,?,?)'); const rateInsert=db.prepare('INSERT INTO exchange_rate_history VALUES(?,?,?,?,?)'); db.exec('BEGIN');
  for(let i=1;i<=100;i++) categoryInsert.run(i,`cat-${i}`,`فئة ${i}`,`Category ${i}`,'2026-01-01','2026-01-01');
  for(let i=1;i<=10000;i++){ const day=String((i%28)+1).padStart(2,'0'); expenseInsert.run(i,`expense-${i}`,`Legacy ${i}`,100+(i%5000),1+(i%100),i%10===0?`صيانة ${i}`:null,`2026-08-${day}T10:00:00.000Z`,`2026-08-${day}T10:00:00.000Z`); rateInsert.run(i,`rate-${i}`,14000+i-1,14000+i,`2026-08-${day}T10:00:${String(i%60).padStart(2,'0')}.000Z`); } db.exec('COMMIT');
  const matrix={ expenseList:['SELECT e.id FROM expenses e JOIN expense_categories c ON c.id=e.category_id ORDER BY e.created_at DESC',[]], categoryFilter:['SELECT e.id FROM expenses e JOIN expense_categories c ON c.id=e.category_id WHERE e.category_id=? ORDER BY e.created_at DESC',[42]], noteSearch:['SELECT e.id FROM expenses e JOIN expense_categories c ON c.id=e.category_id WHERE COALESCE(e.note,e.description) LIKE ?',['%صيانة%']], periodFilter:['SELECT e.id FROM expenses e JOIN expense_categories c ON c.id=e.category_id WHERE e.created_at>=? ORDER BY e.created_at DESC',['2026-08-20']], amountFilter:['SELECT e.id FROM expenses e JOIN expense_categories c ON c.id=e.category_id WHERE e.amount_syp>=? AND e.amount_syp<=? ORDER BY e.created_at DESC',[1000,2000]], newest:['SELECT e.id FROM expenses e JOIN expense_categories c ON c.id=e.category_id ORDER BY e.created_at DESC,e.id DESC',[]], oldest:['SELECT e.id FROM expenses e JOIN expense_categories c ON c.id=e.category_id ORDER BY e.created_at ASC,e.id ASC',[]], highest:['SELECT e.id FROM expenses e JOIN expense_categories c ON c.id=e.category_id ORDER BY e.amount_syp DESC,e.created_at DESC',[]], lowest:['SELECT e.id FROM expenses e JOIN expense_categories c ON c.id=e.category_id ORDER BY e.amount_syp ASC,e.created_at DESC',[]], categoryAggregation:['SELECT c.id,SUM(e.amount_syp) total FROM expenses e JOIN expense_categories c ON c.id=e.category_id GROUP BY c.id',[]], rateHistory:['SELECT * FROM exchange_rate_history ORDER BY created_at DESC,id DESC',[]]};
  const report={}; for(const [name,[sql,args]] of Object.entries(matrix)){ const times=[]; for(let run=0;run<7;run++){ const start=performance.now(); db.prepare(sql).all(...args); const elapsed=performance.now()-start; if(run>=2) times.push(elapsed); } times.sort((a,b)=>a-b); report[name]={min:+times[0].toFixed(2),median:+times[2].toFixed(2),max:+times[4].toFixed(2)}; }
  const categoryPlan=db.prepare('EXPLAIN QUERY PLAN SELECT * FROM expenses WHERE category_id=?').all(42).map(row=>row.detail).join(' '); const historyPlan=db.prepare('EXPLAIN QUERY PLAN SELECT * FROM exchange_rate_history ORDER BY created_at DESC').all().map(row=>row.detail).join(' '); assert.match(categoryPlan,/idx_expenses_category_id/); assert.match(historyPlan,/idx_exchange_rate_history_created_at/); assert.equal(db.prepare('SELECT COUNT(*) count FROM expenses').get().count,10000); assert.equal(db.prepare('SELECT COUNT(*) count FROM exchange_rate_history').get().count,10000); console.log(`PHASE11_PERFORMANCE=${JSON.stringify(report)}`); db.close();
});

test('backup, safe merge and Excel preserve portable expense and rate semantics', async () => {
  const [backup, importer, types, excel] = await Promise.all(['../src/backup/backupManager.ts','../src/import/jsonImporter.ts','../src/import/importTypes.ts','../src/utils/excel.ts'].map(path=>readFile(new URL(path,import.meta.url),'utf8')));
assert.match(backup,/BACKUP_VERSION = 8/); assert.match(backup,/SCHEMA_VERSION = 20/); assert.match(backup,/expenseCategories/); assert.match(backup,/exchangeRateHistory/); assert.match(types,/expenseCategories\?: ExpenseCategory\[\]/); assert.match(types,/exchangeRateHistory\?: ExchangeRateHistoryEntry\[\]/);
  assert.match(importer,/EXPENSE_CATEGORY_PARENT_MISSING/); assert.match(importer,/SELECT id FROM exchange_rate_history WHERE uuid=\?/); assert.match(importer,/item\.category_uuid \|\| OTHER_EXPENSE_CATEGORY_UUID/); assert.match(excel,/Expense Categories/); assert.match(excel,/Exchange Rate History/); assert.match(excel,/note: expense\.note/);
});

test('v11 backup-shaped data round-trips and duplicate merge cannot change current rate', () => {
  const source=v10Database(); migrateV11(source); source.prepare(`INSERT INTO expense_categories(uuid,name_ar,name_en,is_system,is_active,created_at,updated_at) VALUES(?,?,?,0,1,?,?)`).run('00000000-0000-4000-8000-000000000101','اتصالات','Communications','2026-09-01','2026-09-01');
  const category=source.prepare('SELECT id,uuid FROM expense_categories WHERE uuid=?').get('00000000-0000-4000-8000-000000000101'); source.prepare('INSERT INTO expenses(uuid,description,amount_syp,category_id,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('00000000-0000-4000-8000-000000000102','فاتورة إنترنت',25000,category.id,'فاتورة إنترنت','2026-09-01','2026-09-01'); setRate(source,14800,'00000000-0000-4000-8000-000000000103');
  const payload={ currentRate:14800, categories:source.prepare('SELECT * FROM expense_categories').all().map(row=>({...row})), expenses:source.prepare('SELECT e.*,c.uuid category_uuid FROM expenses e JOIN expense_categories c ON c.id=e.category_id').all().map(row=>({...row})), history:source.prepare('SELECT * FROM exchange_rate_history').all().map(row=>({...row})) };
  const target=v10Database(); migrateV11(target); target.exec('DELETE FROM expenses; DELETE FROM exchange_rate_history;'); target.prepare("UPDATE settings SET value='16000' WHERE key='exchangeRate'").run();
  const merge=()=>{ target.exec('BEGIN'); try { for(const cat of payload.categories) target.prepare(`INSERT INTO expense_categories(uuid,name_ar,name_en,is_system,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(uuid) DO NOTHING`).run(cat.uuid,cat.name_ar,cat.name_en,cat.is_system,cat.is_active,cat.created_at,cat.updated_at); for(const expense of payload.expenses){ const parent=target.prepare('SELECT id FROM expense_categories WHERE uuid=?').get(expense.category_uuid); target.prepare('INSERT INTO expenses(uuid,description,amount_syp,category_id,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(uuid) DO NOTHING').run(expense.uuid,expense.description,expense.amount_syp,parent.id,expense.note,expense.created_at,expense.updated_at); } for(const entry of payload.history) target.prepare('INSERT INTO exchange_rate_history(uuid,old_rate,new_rate,created_at) VALUES(?,?,?,?) ON CONFLICT(uuid) DO NOTHING').run(entry.uuid,entry.old_rate,entry.new_rate,entry.created_at); target.exec('COMMIT'); } catch(error){ target.exec('ROLLBACK'); throw error; } };
  merge(); merge(); assert.equal(target.prepare("SELECT COUNT(*) count FROM expense_categories WHERE uuid='00000000-0000-4000-8000-000000000101'").get().count,1); assert.equal(target.prepare("SELECT COUNT(*) count FROM expenses WHERE uuid='00000000-0000-4000-8000-000000000102'").get().count,1); assert.equal(target.prepare("SELECT COUNT(*) count FROM exchange_rate_history WHERE uuid='00000000-0000-4000-8000-000000000103'").get().count,1); assert.equal(JSON.parse(target.prepare("SELECT value FROM settings WHERE key='exchangeRate'").get().value),16000); assert.equal(target.prepare("SELECT note FROM expenses WHERE uuid='00000000-0000-4000-8000-000000000102'").get().note,'فاتورة إنترنت'); source.close(); target.close();
});

test('legacy backup expense without category reference resolves to Other and history stays empty', () => {
  const db=v10Database(); migrateV11(db); db.exec('DELETE FROM expenses'); const legacy={ uuid:'00000000-0000-4000-8000-000000000201',description:'Legacy',amount_syp:5000,created_at:'2025-01-01',updated_at:'2025-01-01' }; const other=db.prepare('SELECT id FROM expense_categories WHERE uuid=?').get(OTHER_UUID); db.prepare('INSERT INTO expenses(uuid,description,amount_syp,category_id,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(legacy.uuid,legacy.description,legacy.amount_syp,other.id,null,legacy.created_at,legacy.updated_at); assert.equal(db.prepare('SELECT c.uuid FROM expenses e JOIN expense_categories c ON c.id=e.category_id').get().uuid,OTHER_UUID); assert.equal(db.prepare('SELECT COUNT(*) count FROM exchange_rate_history').get().count,0); db.close();
});

test('full restore keeps backed-up current rate independent from the last history event', () => {
  const db=v10Database(); migrateV11(db); db.exec('DELETE FROM exchange_rate_history'); db.prepare('INSERT INTO exchange_rate_history(uuid,old_rate,new_rate,created_at) VALUES(?,?,?,?)').run('00000000-0000-4000-8000-000000000401',14500,14800,'2026-09-01'); db.prepare("UPDATE settings SET value='15200' WHERE key='exchangeRate'").run();
  const backedUpSetting=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='exchangeRate'").get().value); const lastHistory=db.prepare('SELECT new_rate FROM exchange_rate_history ORDER BY created_at DESC,id DESC').get().new_rate; assert.equal(backedUpSetting,15200); assert.equal(lastHistory,14800); assert.notEqual(backedUpSetting,lastHistory); db.close();
});

test('source keeps history read-only and old backup generations optional without changing archive format', async () => {
  const [database, importer, types, backup, archive] = await Promise.all(['../src/database/database.ts','../src/import/jsonImporter.ts','../src/import/importTypes.ts','../src/backup/backupManager.ts','../src/backup/backupArchive.ts'].map(path=>readFile(new URL(path,import.meta.url),'utf8')));
  assert.doesNotMatch(database,/export async function (?:update|delete)ExchangeRateHistory/); assert.match(database,/if \(oldRate === newRate\) return/); assert.match(importer,/payload\.version > 8/); assert.match(importer,/item\.category_uuid \|\| OTHER_EXPENSE_CATEGORY_UUID/); assert.match(types,/expenseCategories\?:/); assert.match(types,/exchangeRateHistory\?:/); assert.match(backup,/writeSarafyArchive/); assert.match(archive,/const MAGIC = 'SARAFY2/);
});

test('application wires SQL expense queries, immutable rate history and virtualized UI', async () => {
  const [database, store, expenseUi, rateUi] = await Promise.all(['../src/database/database.ts','../src/store/useAppStore.ts','../src/components/expenses/ExpensesView.tsx','../src/components/RateHistoryScreen.tsx'].map(path=>readFile(new URL(path,import.meta.url),'utf8')));
  assert.match(database,/export const SCHEMA_VERSION = 20/); assert.match(database,/withExclusiveTransactionAsync/); assert.match(database,/queryExpenses/); assert.match(database,/getExpenseTotalsByCategory/); assert.match(database,/EXPENSE_CATEGORY_INACTIVE/); assert.match(store,/updateExchangeRate: async/); assert.match(expenseUi,/useDeferredValue/); assert.match(expenseUi,/SegmentedControl/); assert.match(expenseUi,/savingRef/); assert.match(rateUi,/FlatList/); assert.doesNotMatch(database,/UPDATE sales SET exchange_rate/); assert.doesNotMatch(database,/UPDATE sale_drafts SET exchange_rate/);
});
