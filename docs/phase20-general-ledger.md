# Phase 20 — General Ledger & Accounting Core

## Status

COMPLETE

## Branch

`feature/phase-20-general-ledger-accounting-core`

## Commits

- `7cd5501` — `docs: define phase 20 accounting policies`
- `3468332` — `docs: resolve final phase 20 allocation policies`
- `d876e9b` — `docs: approve phase 20 accounting design`
- `7b2e9ea` — `docs: approve zero-effect source policy`
- `762b7aa` — `feat: add general ledger accounting core`

## Schema

Schema migrated exactly once from v18 to v19. The migration is schema-only: it creates the accounting core, seeds 21 locked system accounts, and does not fabricate journals from historical operations.

New authoritative tables are `accounting_settings`, `accounting_cutover_positions`, `gl_accounts`, `journal_entries`, `journal_lines`, `gl_account_balances`, `inventory_value_balances`, `inventory_value_movements`, `cash_control`, `supplier_foreign_position_layers`, `supplier_foreign_allocations`, and `cash_adjustments`. Source identity, journal chronology, account-ledger access, inventory valuation history, supplier FIFO positions, and cash-adjustment history have focused indexes. SQLite triggers make posted journals/lines and locked system-account identities immutable.

The physical v18→v19 migration retained all operational rows, opened normally, reported `user_version = 19`, `integrity_check = ok`, and an empty `foreign_key_check`.

## Accounting Design Gate

The independent design gate is approved in `docs/phase20-accounting-design.md`. It resolves functional currency, cutover, inventory valuation, USD cash carrying value, AP/advance layers, customer controls, returns, FX, zero cutover, and value-neutral operational sources before schema implementation.

## Functional Currency

The immutable functional currency is SYP. Every final debit/credit is a safe integer SYP amount. USD native cents and the historical exchange/carrying snapshots remain attached where required; current rates are never used to rewrite old journals.

## Accounting Cutover

- All-zero confirmed positions enable accounting without an opening journal, lines, or fabricated nominal value; `opening_journal_entry_id` remains null.
- Any nonzero confirmed position creates exactly one nonempty, balanced CUTOVER journal. `OPENING_EQUITY` is used only for the final net balance.
- The physical nonzero cutover captured SYP cash `9,999,895,100`, USD cash `$10.00` carried at `155,000`, customer credit `24,000`, supplier advance `$15.00` carried at `232,500`, and inventory values `558,000`, `15,500`, and zero.
- Its one opening journal contained six nonzero lines and balanced at `10,000,856,100` SYP on each side; Opening Equity was `10,000,832,100` SYP credit.

## Chart of Accounts

The chart contains 21 bilingual locked system accounts covering SYP/USD cash, AR, inventory, supplier advances, AP, customer credits, opening/equity controls, revenue/returns, realized FX, inventory gains/losses, COGS, operating expenses, valuation variance, and cash over/short. Codes, keys, types, normal sides, activation state, and system identity cannot be edited or deleted after activation.

## General Journal

Journal entries and lines are immutable, source-linked, UUID-portable, date-filterable, account-filterable, and deterministically ordered. A partial unique index enforces one journal per operational source, one opening journal at most, and one reversal per target. Physical data after restore contained 10 journals and 33 lines; total debits and credits were both `10,002,280,100` SYP, with no invalid, empty, duplicate-source, or zero-valued journal.

## Posting Engine

Every source is recomputed inside the same exclusive SQLite transaction as its operational mutation. The engine aggregates account effects, removes zero account deltas, validates safe integers and exact balance, inserts the immutable header/lines, and updates account caches atomically. A source may omit a journal only when its complete derived functional-currency effect is exactly zero; the health audit independently re-derives that decision.

## Sales

Post-cutover sales post revenue and their cash/customer-control split, plus COGS and inventory relief for valued tracked stock. The physical cash sale of `31,000` SYP posted cash/revenue and `15,500` SYP COGS/inventory. The physical credit sale of `77,500` SYP consumed `24,000` customer credit, created `53,500` AR, and posted `31,000` SYP COGS/inventory.

## Customer Payments

Customer payment tenders preserve SYP/USD snapshots and update cash carrying value plus AR/customer-credit controls atomically. The physical `53,500` SYP receipt debited SYP cash and cleared AR exactly. Credit-sale settlement validation now correctly accepts cash, partial-on-account, and fully-on-account invoices during restore.

## Customer Returns

Financial return quantity and physical restock quantity remain independent. The physical return debited Sales Returns and credited Customer Credits for `77,500` SYP; restocking one unit restored exactly `31,000` SYP to Inventory and reversed COGS. Cumulative BigInt allocation guarantees exact final restoration while a zero-restock return has no inventory-value effect.

## Expenses

The physical `25,000` SYP expense debited Operating Expense and credited SYP Cash once, with no reclassification as a supplier payment or purchase cost.

## Purchases

Purchases use the immutable receipt rate and deterministic integer allocation. Supplier advances are consumed FIFO before new AP is created; line totals use stable largest-remainder allocation. Physical coverage included a purchase wholly consuming advance value and a `$40.00` purchase that split `232,500` SYP to Supplier Advances and `387,500` SYP to AP while debiting Inventory `620,000` SYP.

## Supplier Returns

Supplier returns use the receipt's immutable allocated carrying value, relieve inventory, and update the appropriate AP/advance position atomically. The physical `$2.00` return debited Supplier Advances and credited Inventory by `31,000` SYP. Staged automated tests preserve exact final residuals and prevent over-return or negative inventory.

## Supplier Payments

Supplier payments consume AP FIFO, value SYP tender at exact cash and USD tender at USD Cash weighted-average carrying value, and create advances only for the portion crossing through zero. The physical `400,000` SYP payment at rate `16,000` relieved AP carrying value `387,500`, recognized `12,500` FX loss, and credited SYP Cash `400,000`; the supplier balance settled to zero.

## Foreign Currency

USD Cash tracks native cents and SYP carrying value separately. Inflows use moving weighted average; outflows use deterministic proportional BigInt relief and exact full-depletion residual handling. Supplier payable and advance positions keep immutable FIFO native/carrying layers and allocations. No current-rate remeasurement silently changes historical cash, AP, advances, journals, or reports.

## Realized FX

FX is recognized only when actual consideration carrying value differs from the relieved historical carrying value. It cannot disappear into Inventory, Cash, AP, or an arbitrary plug. The physical supplier settlement produced the expected `12,500` SYP Realized FX Loss.

## Cash Sessions

Cash sessions remain operational drawer snapshots; GL cash is an independent control. Sales, customer receipts/returns, expenses, and supplier payments post to both their existing session semantics and GL in one transaction when applicable. Cash adjustments are immutable explicit sources, use owner/cash-over-short accounts, and are blocked while a cash session is open.

## Inventory / COGS Policy

Post-cutover valuation is perpetual moving weighted average in integer SYP. Quantity and value move together in `inventory_value_movements`; the latest value movement must match `inventory_value_balances`, and zero quantity must have zero carrying value. Purchases increase carrying value, sales relieve average carrying value to COGS, physical customer restocks restore cumulative original accounting COGS, and supplier returns/manual adjustments use the approved carrying/variance rules. The quantity ledger itself remains unchanged and no current product cost is substituted for accounting value.

## Subledger Reconciliation

The dashboard exposes seven control reconciliations for SYP cash, USD cash carrying value, AR, Customer Credits, Inventory, AP, and Supplier Advances. Each row compares the operational subledger/cache with GL and shows the exact difference. All seven physical rows were `Matched`; direct database checks also found zero customer/supplier balance-cache, tender-total, settlement, layer, or allocation mismatch.

## Trial Balance

The report is derived only from journal lines. The physical all-time Trial Balance was exactly balanced at `10,001,018,100` SYP debit and credit.

## Profit & Loss

The GL-derived physical report showed Sales Revenue `108,500`, Sales Returns `77,500`, Net Sales `31,000`, COGS `15,500`, Gross Profit `15,500`, Operating Expenses `25,000`, Realized FX Loss `12,500`, and Net Loss `22,000` SYP.

## Balance Sheet

The report is shown only when the accounting identity is reliable. The physical report balanced Assets `10,000,887,600` = Liabilities `77,500` + Equity `10,000,810,100` SYP.

## PDFs

Arabic PDFs were physically generated and shared for Trial Balance, Profit & Loss, Balance Sheet, and the SYP Cash General Ledger. Values, direction, pagination, and labels were correct with no null/undefined output. A real multipage defect was found in Trial Balance: continuation pages lacked top margin. The CSS now uses page margins, repeating table headers, and row break protection; the regression is automated and the physical second-page retest passed.

## Excel

Excel remains export/report only. The physical workbook was `169,231` bytes with 32 sheets/tables, including Chart of Accounts (21 rows), General Journal (10 rows), Journal Lines (33 rows), and Trial Balance (21 rows). Journal-line debits/credits both summed to `10,002,280,100`; Trial Balance debit/credit columns both summed to `10,001,018,100`. Excel import cannot mutate GL.

## Backup / Restore

Full `.sarafy` backup includes settings, cutover, accounts, journals/lines, caches, cash control, inventory valuation, supplier layers/allocations, and cash adjustments using portable UUID references. The physical backup `manual-20260930093749882-429227.sarafy` was `116,760` bytes with no `.writing` residue.

Full Restore initially exposed a real validation defect: valid credit sales were checked as `tender - change = net`, ignoring `on_account_syp`, and raised `PAYMENT_SETTLEMENT_CONFLICT`. Validation is now centralized as `tender - change + onAccount = net` in both preview and execution. Regression tests cover cash, partial-account, full-account, and change cases. Physical restore then completed with zero conflicts/rejections and reproduced exactly 21 accounts, 10 journals, 33 lines, balances, cutover, cash/value ledgers, supplier layers, operational rows, and historical snapshots. Post-restore `integrity_check = ok` and `foreign_key_check` returned zero rows.

## Safe Merge

Safe Merge explicitly reported that General Ledger, journals, account balances, inventory/cash carrying values, and operational finance were skipped. After physical execution, every authoritative accounting table and all compared sales, payments, returns, purchases, inventory movements, subledgers, and cash sessions were row-identical before/after. Accounting remained the local authority; integrity and FK checks still passed.

## Health Audit

The accounting audit validates cutover policy, one balanced nonzero journal per nonzero source, journal immutability/source uniqueness, cache derivation, cash and inventory carrying arithmetic, control reconciliation, supplier FIFO/allocations, zero-effect absence, and balance-sheet identity. UI audit passed. Direct restored-DB checks found zero invalid journals/lines, duplicate sources, cache mismatches, negative inventory, movement arithmetic errors, tender/settlement mismatches, over-returns, or invalid foreign layers.

## Concurrency

Exclusive SQLite transactions, unique source indexes, and synchronous UI guards serialize competing business actions. Existing rapid-action tests plus Phase 20 source uniqueness verify a single operational mutation and a single journal, with clean rejection/rollback of the competing attempt.

## Fault Injection

Phase 20 injects failures after source mutation, after journal header, after journal lines, and before balance-cache completion. Every boundary rolled back the operational source, journal, lines, and caches. The prior 20-boundary business-transaction suite also remained green.

## Performance

Synthetic accounting workload: 50,000 journal headers and 100,000 lines, measured after warm-up.

| Path | Min | Median | Max |
|---|---:|---:|---:|
| Journal history | 10.36 ms | 11.66 ms | 12.07 ms |
| Account ledger | 263.06 ms | 306.78 ms | 320.25 ms |
| Trial Balance | 34.78 ms | 35.07 ms | 35.20 ms |
| Profit & Loss | 33.44 ms | 34.70 ms | 35.07 ms |
| Source lookup | 0.01 ms | 0.02 ms | 0.04 ms |
| Health Audit | 563.73 ms | 586.99 ms | 790.26 ms |
| Reconciliation | 0.19 ms | 0.21 ms | 0.22 ms |

Query plans use `idx_journal_entries_occurred`, `idx_journal_lines_account_entry`, and `idx_journal_entries_source`. No schema-v20/index migration was needed.

## 320dp

The physical device was temporarily configured to an equivalent 320dp width (`840 px` at density `420`). Overview, Journal, Journal Detail, Chart of Accounts, Ledger, reports, audit, and reconciliation were exercised in Arabic/English, dark/light, and font scale 1.0/1.2. Tabs and period controls scroll horizontally, content remains scrollable above navigation, numeric cards remain readable, and no CTA or report action was unreachable. Device settings were restored to `1080×2280`, font scale `1.0`, dark mode.

## RTL/LTR

Arabic RTL and English LTR were physically verified. SYP/USD values, negative P&L amounts, running balances, dates, and mixed Arabic/Latin account text remained readable. The UI uses centralized design tokens and localized copy.

## Physical Device

- Manufacturer/model: Samsung SM-N975F (Galaxy Note10+)
- Android/API: 12 / 31
- Physical display: 1440×3040; normal test override: 1080×2280
- Density: 420 dpi
- RAM: 11,566,616 kB

Physical validation covered migration, nonzero cutover, all post-cutover source types, journal/list/detail/ledger/reports, reconciliation, PDFs, Excel, backup, Full Restore, Safe Merge, force-stop persistence, 320dp, themes, locale, and font scaling. Logcat contained no Sarafy FATAL, ANR, OOM, SQLite, Hermes, ReactNativeJS, or raw-Text failure. A bad-file-descriptor crash belonged to the temporary `uiautomator` shell process, not the application; normal dev-only deprecation warnings were benign.

## Automated Tests

- Pre-Phase-20 baseline: 238/238 PASS
- New Phase 20 tests: 29
- Final sequential suite: 267/267 PASS
- TypeScript: PASS
- Strict unused locals/parameters: PASS
- `git diff --check`: PASS

Coverage includes migration/cutover, immutable chart/journals/reversals, all posting sources, zero-effect sources, integer allocation, inventory/COGS, supplier FIFO/FX, USD cash, reports, reconciliation, health corruption cases, backup/restore/merge, Excel, PDF pagination, fault injection, concurrency/source uniqueness, query plans, and the credit-sale restore regression.

## Build

- Expo Android production export: PASS
- Modules bundled: 1,337
- Hermes bundle: one `.hbc`, 5.7 MB
- Assets: 27
- Output: `dist`
- `:app:assembleRelease`: PASS (`BUILD SUCCESSFUL`, 697 tasks)
- Production AAB: not started, as required
- Signing/dependencies/application ID: unchanged (`com.sarafy.catalog`)

## Known Risks

- The validated device runs Android 12/API 31; target/compile SDK behavior beyond existing automated/build coverage remains a later release-candidate concern.
- Physical validation used the existing development build; release packaging/signing and installed release-candidate profiling are intentionally separate work.
- Accounting is intentionally SYP-functional with realized FX and historical carrying values; unrealized remeasurement, tax, customer/supplier aging, and a broader closing-period workflow are out of Phase 20 scope.
