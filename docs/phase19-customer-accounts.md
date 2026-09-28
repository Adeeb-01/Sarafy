# Sarafy Phase 19 — Customer Accounts & Receivables

## Status

COMPLETE

Phase 19 is complete on the local branch. The customer-account ledger, SYP receivables, customer payments, credit sales, return settlement split, cash-session integration, portable backup/restore, Safe Merge policy, Excel reporting, PDFs, health checks, responsive UI, automated tests, physical Android validation, and Android release build all passed.

## Branch

- Branch: `feature/phase-19-customer-accounts-receivables`
- Start commit: `f846ffd fix: prevent supplier payment cash overdraw`
- Schema: v18
- Package: `com.sarafy.catalog`

## Commits

- Phase 18 base: `caeaa3c feat: add supplier accounts and payables`
- Phase 19 implementation: this report is included in the focused `feat: add customer accounts and receivables` commit.
- No Phase 20, dependency update, Expo patch sync, production signing, or AAB work is included.

## Schema

The single v17 to v18 migration adds:

- `customers`
- `customer_account_balances`
- `customer_account_entries`
- `customer_payments`
- `customer_payment_tenders`
- customer references and immutable name/UUID snapshots on `sales`
- integer `on_account_syp` on `sales`
- integer `customer_account_credit_syp` on `sale_returns`
- immutable closing customer-payment snapshots on `cash_sessions`

UUID and source-identity indexes prevent duplicate portable records and duplicate ledger posting. Customer accounting values are integer SYP. USD tenders are stored in integer cents with their historical SYP conversion.

## Migration

The migration is transactional and preserves all v17 accounting data. Existing sales remain unassigned with zero on-account value, existing returns remain cash-only, and existing closed cash sessions receive zero customer-payment snapshot fields. No historical receivable is reconstructed and no synthetic customer or ledger row is created.

Migration, rollback, legacy-data, `integrity_check`, and `foreign_key_check` coverage passed. The physical database reports `user_version = 18`, `integrity_check = ok`, and zero foreign-key violations.

## Customers

Customers are first-class UUID entities and can be created, edited, archived, and restored independently from account activation. Archived customers cannot be used for new financial actions; historical snapshots, statements, invoices, and payments remain readable. Restoring the physical test customer preserved its active customer account and balance.

## Activation

Account activation is explicit, one-time, and transactional. It re-reads the customer, stores `accounting_started_at`, creates one balance cache row, and appends exactly one immutable opening entry. It has no cash-session effect and does not retro-post historical sales.

## Opening Balance

Positive, zero, and negative integer SYP opening positions are supported. Automated tests verify receivable, settled, and customer-credit semantics without clamping. The physical test account was activated with `+100,000 SYP` and retained that starting entry after restart, backup, and restore.

## Ledger

`customer_account_entries` is authoritative and immutable. The balance cache is updated in the same exclusive SQLite transaction as each opening, on-account sale, account return credit, or customer payment.

Final device evidence for `Phase19 Customer`:

- opening: `+100,000`
- payments: `-106,500`
- on-account sales: `+342,500`
- account return credits: `-360,000`
- final balance: `-24,000 SYP`
- ledger sum: `-24,000 SYP`
- cache mismatch: `0`
- duplicate source postings: `0`

The negative result is shown as customer credit, not clamped to zero.

## Credit Sales

Full on-account sales post revenue, cost, profit, stock movements, one customer ledger entry, and the balance cache atomically. The existing full-credit physical invoice for `77,500 SYP` was completed with no cash tender and retained its immutable customer and exchange-rate snapshots.

## Partial Settlement

The exact settlement rule is:

`SYP tender + USD tender equivalent - SYP change + on_account_syp = invoice net_total_syp`

Physical results:

- Partial SYP/account invoice: total `310,000`, SYP cash `200,000`, on account `110,000`.
- USD/account invoice: total `310,000`, USD `$10.00` at `15,500 SYP/USD` (`155,000 SYP` equivalent), on account `155,000`.

Both produced one invoice, one customer sale entry, correct payment rows, and no stale hidden tender values.

## Customer Payments

Customer payments are cash inflows and receivable reductions. They are not sales, revenue, expenses, or profit. They require an active cash session and write an immutable header, one or two tenders, one ledger entry, the cached balance, and the cash-session effect in one transaction. No-active-session blocking and rapid-confirm single-commit behavior passed physically.

### SYP

The physical `50,000 SYP` payment wrote one SYP tender and reduced the receivable by exactly `50,000 SYP`.

### USD

The physical `$2.00` payment at `15,500 SYP/USD` wrote one USD tender with an immutable `31,000 SYP` equivalent. Later rate changes do not recalculate it.

### Mixed

The physical mixed payment used `10,000 SYP + $1.00`, producing a `25,500 SYP` ledger reduction at the historical rate. It wrote two tender rows and separate SYP/USD drawer inflows.

## Customer Credit

Overpayment is allowed after explicit confirmation. The physical sequence crossed zero into `-6,500 SYP` customer credit, persisted after restart, and later sales/returns continued from the immutable ledger rather than a separate mutable credit bucket.

## Customer Returns

Return value, cash refund, customer-account credit, and inventory restock remain distinct. The invariant is:

`cash refund + customer account credit = financial return value`

Only the cash portion leaves the drawer. Only the account portion reduces the receivable. Analytics still uses the full return value on the return date.

### Cash

The physical cash-only return for invoice `INV-20260928080500169` recorded a `310,000 SYP` financial return, zero account credit, and a `310,000 SYP` cash refund. It created no customer ledger entry.

### Account

The physical account-only return for invoice `INV-20260928080204814` recorded a `310,000 SYP` financial return and a `310,000 SYP` account credit with zero cash refund. It created one negative customer ledger entry and no cash outflow.

### Mixed

The earlier physical mixed return recorded `77,500 SYP` total, `50,000 SYP` account credit, and `27,500 SYP` cash refund. The original invoice remained immutable and the restock amount remained independent.

## Cash Sessions

Open-session customer payments are added separately to their SYP/USD drawers. On-account sales and account return credits do not affect cash. Customer cash refunds subtract only their cash portion.

The validated closed session stored `60,000 SYP` and `$3.00` of customer-payment inflows as separate immutable snapshots. Close/restart preserved the snapshots and did not recalculate historical exchange rates. A second test-only session was opened for the final partial-settlement and return matrix; it was not used as release accounting evidence.

## Statement

The customer statement is deterministic by occurrence time and stable identity. It supports All/Opening/Sales/Returns/Payments and All Time/This Month filters. It shows signed integer SYP movements and running balances from the immutable ledger. Payment rows open a read-only detail view containing the customer snapshot, reference, mode, tenders, historical rate, SYP equivalent, balance-after value, session reference, and note.

## PDFs

The customer payment receipt, customer statement, and customer return receipts were generated on Android and opened the platform share sheet without external transmission. Rendered Arabic documents were visually checked for correct titles, references, signed values, historical exchange rate, return cash/account split, running balances, and absence of `null`/`undefined` or sale/expense wording on customer payments. Existing invoice and cash-session PDF paths retain their historical snapshots.

## Backup / Restore

The portable `.sarafy` container version remains unchanged. Full backup includes customers, balances, entries, payments, tenders, sale customer snapshots, on-account amounts, return account credits, and closed-session customer-payment snapshots.

Physical backup/restore preserved activation, opening entry, sales, tenders, historical rates, mixed return split, statement order, cached balance, and cash-session snapshots. Pre-v18 backups default all customer-finance fields safely without creating fake debt. The restored database passed SQLite and account/inventory invariants.

## Safe Merge

Safe Merge may resolve customer profiles by UUID but skips customer balances, ledger entries, payments, tenders, on-account operational finance, and cash-session finance with an explicit operational-finance reason. Physical Safe Merge left local balances and inventory unchanged and completed with clean SQLite and health checks.

## Excel

Excel remains reporting/export only. Android generated `sarafy-products-2026-09-28.xlsx` (118,386 bytes) and opened the share sheet. Read-only inspection verified these Phase 19 sheets and representative rows:

- `Customers`
- `Customer Accounts`
- `Customer Account Entries`
- `Customer Payments`
- `Customer Payment Tenders`

Sales and returns also export the customer snapshots, on-account amount, account-credit amount, and cash-refund semantics. No generic financial-history import was added.

## Health Audit

The deterministic customer-account audit covers missing/duplicate opening entries, cache-to-ledger mismatch, duplicate source posting, sale/payment/return delta mismatch, tender currency/rate/total mismatch, invalid return split, orphan references, closed-session snapshot mismatch, unsafe integers, and stored balance-after mismatch.

Final device database checks:

- `integrity_check = ok`
- `foreign_key_check = 0 rows`
- customer cache mismatch: `0`
- orphan payment tenders: `0`
- payment/tender mismatch: `0`
- duplicate customer source posting: `0`
- customer over-return: `0`
- negative inventory balances: `0`
- inventory movement arithmetic mismatch: `0`
- latest inventory movement/balance mismatch: `0`

## Concurrency

Exclusive transactions re-read customer state, balance, cash-session state, exchange rate, stock, and returnable quantities. Unique partial indexes prevent duplicate sale, return, payment, and opening postings. Double-action refs protect activation, payment, sale, return, and close actions. Automated rollback/concurrency cases and physical rapid confirms produced one complete commit or no commit, never partial state.

## Performance

Synthetic workload: 1,000 customers, 10,000 ledger entries, 5,000 customer payments, and 7,500 tenders.

Final representative medians from the Phase 19 suite:

| Path | Median |
| --- | ---: |
| Customer list | 2.23 ms |
| Customer search | 0.28 ms |
| Statement | 0.14 ms |
| Payment history | 0.10 ms |
| Health audit | 7.12 ms |

Statement and payment history use the customer/date indexes. No list N+1 query was introduced.

## 320dp

Equivalent 320dp validation passed for Arabic and English, dark and light themes, and font scales 1.0 and 1.2. Customer list/detail, activation, checkout customer selection, on-account settlement, SYP/USD/Mixed payment, credit confirmation, statement, payment detail, return settlement, and PDF/share paths remained reachable.

One real defect was found: the customer payment sheet CTA could be hidden by the Android keyboard. The minimal fix moved it to the shared keyboard-aware, scrollable BottomSheet behavior. Automated coverage and physical 320dp/font-1.2 retest passed.

## RTL/LTR

Arabic RTL and English LTR passed on customer screens and numeric values including positive/negative SYP, USD cents, historical exchange rates, signed statement rows, and running balances. Numeric content retained readable LTR direction within Arabic layouts.

## Physical Device

- Manufacturer: Samsung
- Model: SM-N975F (Galaxy Note10+)
- Android: 12
- API: 31
- Physical display: 1440 x 3040
- Normal validation override: 1080 x 2280
- Density: 420 dpi
- RAM: approximately 11 GB

Physical coverage includes creation/edit/archive/restore, activation, restart persistence, full/partial/USD credit sales, SYP/USD/Mixed payments, customer credit, cash/account/mixed returns, no-session blocking, rapid confirms, cash-session close, statement/payment detail, PDFs/share sheet, backup/restore, Safe Merge, Excel, 320dp, keyboard, RTL/LTR, and themes. Final startup logcat contained no FATAL, ANR, OOM, SQLiteException, Hermes error, raw Text warning, or ReactNativeJS error. The only final messages were benign development deprecation warnings for SafeAreaView and InteractionManager.

## Automated Tests

- Phase 18 baseline: 216/216
- Phase 19 regression suite: 22 tests
- Final combined gate: 238/238 across 22 test files
- TypeScript normal: PASS
- TypeScript strict unused: PASS
- `git diff --check`: PASS

The suite covers migration/rollback, activation, positive/zero/negative openings, cutover, SYP/USD/Mixed payments, credit, on-account settlement, restore variants, cash/account/mixed returns, cash formulas, health audit, backup/restore, Safe Merge, Excel, PDFs, UI wiring, indexes, and performance. All earlier phase tests remain green.

## Build

- Expo Android production export: PASS
- Metro modules: 1,329
- Hermes Android bundle: PASS (`5.4 MB`)
- Assets: 27
- Output: `dist/phase19-production`
- `:app:assembleRelease`: PASS
- Gradle: 697 actionable tasks, 44 executed, 653 up-to-date
- AAB: not created
- Production signing: unchanged
- Dependencies: unchanged; `package.json` adds only `test:phase19`

## Known Risks

- Physical results are from the existing debug development build; production signing and production AAB validation remain separate release steps.
- The connected device uses a dedicated test dataset. A second open test cash session contains an operator-entered oversized opening SYP value caused by appending digits to a prefilled field; it is not used by the validated closed-session evidence and was intentionally not deleted or rewritten.
- Expo SDK patch drift was not changed in this phase.
- No Phase 20, General Ledger, bank accounts, installments, or cloud features were started.
