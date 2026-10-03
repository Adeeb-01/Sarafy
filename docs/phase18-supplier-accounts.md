# Sarafy Phase 18 — Supplier Accounts & Payables

## Status

COMPLETE

Phase 18 implementation and the required physical Android validation are complete. Supplier activation, cutover accounting, SYP/USD/Mixed payments, supplier credit, cash-session reconciliation, PDFs, backup, Full Restore, Safe Merge, 320dp, SQLite health, automated gates, production export, and Android release assembly passed. No Phase 19 work, dependency update, signing change, or AAB was performed.

## Branch

`feature/phase-18-supplier-accounts-payables`

Base: `16e2e56 perf: harden high-volume restore and startup`

## Commits

Phase 18 implementation: `caeaa3c feat: add supplier accounts and payables`.

Physical-validation hardening: `f846ffd fix: prevent supplier payment cash overdraw`.

No Phase 19 work, dependency update, signing change, AAB, prebuild, or Android regeneration is included.

## Schema

One migration only: schema v16 to v17.

- `suppliers`: adds `accounting_enabled` and `accounting_started_at`.
- `cash_sessions`: adds immutable closing snapshots `closing_supplier_payments_syp` and `closing_supplier_payments_usd_cents`.
- New `supplier_account_balances` cache table, one row per activated supplier.
- New immutable `supplier_account_entries` ledger with `opening`, `purchase`, `purchase_return`, and `payment` entries.
- New immutable `supplier_payments` headers and `supplier_payment_tenders` components.
- Portable UUIDs, foreign keys, source-specific unique indexes, and bounded history indexes are included.

The package remains `com.sarafy.catalog`.

## Migration

The migration runs inside one exclusive SQLite transaction and sets `PRAGMA user_version = 17` only after all schema work succeeds. Existing suppliers remain inactive, existing purchases and returns are not reconstructed into debt, existing cash-session values are preserved, and both new closing snapshot fields default to zero. Migration tests verify `integrity_check = ok`, an empty `foreign_key_check`, unchanged historical rows, and an empty supplier ledger.

## Supplier Account Activation

Activation is explicit and irreversible in Phase 18. The UI requires a second confirmation using the exact parsed opening amount. The database rechecks that the supplier exists and is not already activated, then atomically updates the supplier, creates its balance cache, and creates exactly one opening ledger row.

## Opening Balance

Opening balance is stored as signed integer USD cents. Positive values represent a payable, zero is settled, and negative values represent supplier credit. Names are display snapshots only; identity uses supplier IDs/UUIDs.

## Account Ledger

The immutable ledger is authoritative. `supplier_account_balances` is a transactional cache and is checked against `SUM(delta_usd_cents)`. Every source entry has a unique source identity, preventing duplicate posting. Statement history uses deterministic `occurred_at DESC, id DESC` ordering, a bounded limit, SQL filtering, and a window calculation for deterministic running balances.

## Purchase Integration

For suppliers activated at transaction time, a completed purchase receipt posts one positive ledger entry using its historical receipt total. Receipt creation, inventory movements, ledger entry, and balance update share the existing exclusive SQLite transaction. Purchases completed before activation are intentionally not backfilled.

## Supplier Return Integration

For an activated supplier, a supplier return posts one negative ledger entry using the immutable historical return value. This also applies to a return created after activation against a receipt that predates activation. Inventory movement, return document, ledger entry, and cached balance update are atomic; the original purchase remains immutable.

## Supplier Payments

Payments require an active cash session and are immutable after commit. The transaction re-reads the active supplier, current committed exchange rate, active cash session, and current cached balance; it then inserts the payment header, tender rows, negative ledger entry, and updated balance before commit. UI/store state changes only after database success.

Physical validation found one accounting-safety defect: a supplier payment could exceed the currently available SYP or USD cash in the active session, leaving a negative expected drawer that the closing constraints correctly refused. The smallest fix computes each committed currency balance inside the same exclusive transaction and raises `INSUFFICIENT_CASH_SESSION_FUNDS` before inserting a payment header. Regression coverage proves SYP and USD overdraws leave zero headers, tenders, payment-ledger entries, balance changes, or cash-session effects, including after one currency has just been exhausted. The physical retest rejected an extra USD payment atomically and kept the form open.

### SYP

SYP tender is stored as integer SYP with the committed exchange-rate snapshot. Conversion to USD cents uses BigInt integer half-up rounding; no floating-point amount is persisted.

### USD

USD tender is stored directly as integer cents. Its tender exchange-rate field is null because no conversion is needed.

### Mixed

Mixed payments store separate SYP and USD tender rows. The SYP component has the committed historical exchange-rate snapshot and the USD component remains exact cents. Their USD-cent equivalents must sum exactly to the payment header.

## Supplier Credit

Overpayment is permitted only through the explicit credit confirmation path. It produces a negative supplier balance rather than clamping to zero. The payment keeps `balance_after_usd_cents` for immutable receipt/history display.

## Cash Session Integration

Supplier payments are cash outflows, not expenses. Active-session formulas are:

- Expected SYP = opening + SYP received - change - customer refunds - expenses - supplier SYP payments.
- Expected USD cents = opening USD cents + USD received cents - supplier USD payments.

Closing stores both supplier-payment totals as immutable, currency-separated snapshots. Cash-session UI and PDF show them as outflows and never label them as profit or expense.

The physical session was reconciled after legitimate replenishing sales. The final expected drawers were SYP 2,600 and USD 0.00; it closed with actual SYP 2,600 and USD 0.00 and independent differences of zero. Direct database evidence showed SYP received 620,000, USD received 120.80, SYP change 12,400, supplier payments SYP 605,000, and supplier payments USD 120.80. The closed snapshot survived force-stop, Full Restore, and Safe Merge unchanged. With no active session, the payment UI displayed the required warning, disabled confirmation, and produced no new rows.

## Statement

Supplier detail shows inactive/payable/settled/credit state, activation, current balance, filtered ledger, payment history, and read-only payment detail. Filters cover all/opening/purchase/return/payment and all-time/this-month. Entries retain supplier and source snapshots and do not depend on current names or exchange rates.

## PDFs

Dedicated supplier statement and supplier payment receipt HTML/PDF models were added. They include supplier/reference/date, ledger or tender breakdown, historical exchange rate where relevant, and resulting balance. They do not claim that a payment is an expense, purchase cost change, or supplier-bank integration. Cash-session PDF includes separated SYP/USD supplier outflows.

Physical Android inspection passed for the representative Mixed supplier-payment receipt, supplier statement, and cash-session report. Arabic text, supplier/reference/date, tender components, historical exchange rate, USD account equivalent, running/final balance, and separated SYP/USD cash outflows rendered correctly; no `null`/`undefined`, expense wording, sale wording, bank-transfer claim, or profit-labelled drawer difference appeared. Android share sheets opened without sending externally. The statement PDF was inspected using the Payments filter; the unfiltered statement model remains covered by automated tests.

## Backup / Restore

Full `.sarafy` backup schema v17 includes supplier activation fields, balance cache, immutable ledger, payment headers/tenders, cash-session supplier-payment snapshots, and portable UUID references. The container format remains unchanged.

Full restore validates parent references, entry source semantics, tender/header totals, running balances, cached balances, payment balance-after snapshots, and closed-session supplier-payment snapshots. Older v8-v16 and legacy payloads remain accepted: suppliers default inactive, snapshot totals default zero, and no fake opening or ledger history is generated.

Physical Full Backup and Full Restore passed using `manual-20260927074230647-886358.sarafy` (42,343 bytes). The restored database preserved supplier activation, the signed balance cache, 11 account entries, six payments, seven tenders, historical exchange-rate snapshots, cash-session supplier-payment snapshots, purchases, returns, and inventory history with no duplicate transactions. Pre/post entity counts matched exactly. No `.writing`, `.importing`, or `.previous` artifact remained.

## Safe Merge

Supplier profiles continue to merge by the existing UUID/conflict policy. Supplier financial state is operational data and is deliberately skipped during Safe Merge with `SUPPLIER_ACCOUNT_SKIPPED_OPERATIONAL_FINANCE`. This includes balance/ledger/payment data and cash sessions containing or referenced by supplier-payment snapshots. No supplier finance or cash drawer is silently mutated.

The physical Safe Merge preview displayed the operational-stock, supplier-finance, and purchase-return skip reasons. Importing the same backup added/updated zero financial records; ledger/payment/tender counts, the `-1500` cent balance, inventory movement count, tracked balance, and cash-session snapshots remained unchanged. Post-merge integrity, foreign keys, and inventory health passed.

## Excel

Excel remains reporting-only for supplier finance. Four backward-compatible export sheets were added:

- `Supplier Accounts`
- `Supplier Account Entries`
- `Supplier Payments`
- `Supplier Payment Tenders`

No Excel importer for supplier finance was introduced, and Excel history cannot alter the operational balance or cash sessions.

Physical export produced `sarafy-products-2026-09-27.xlsx`; the Android share sheet opened. Read-only workbook inspection confirmed the four sheets and representative rows for opening, purchase, return, SYP, USD, and Mixed payments, including null rate for USD tenders and historical rates for SYP tenders.

## Health Audit

The audit checks activated/inactive account state, exactly one opening entry, integer money storage, cache-versus-ledger equality, source relationships and duplicates, orphan suppliers/sessions/tenders, mode/tender consistency, payment totals and historical rates, stored balance-after values, and closed cash-session snapshots. The synthetic database ends with `integrity_check = ok`, an empty `foreign_key_check`, exact ledger/cache totals, and exact payment/tender totals.

Final physical-device database verification also passed: `integrity_check = ok`, `foreign_key_check` returned zero rows, both active suppliers had exactly one opening entry and one balance cache, ledger sums equalled cached balances, payment tender sums equalled header equivalents, no duplicate source posting existed, and inventory health remained clean. The main test supplier ended at `-1500` cents (Supplier Credit $15.00); the zero-opening supplier ended at zero with exactly one opening entry.

## Concurrency

Exclusive SQLite transactions serialize activation, purchase, return, payment, and session-close writes. Conditional cached-balance updates detect stale reads. Unique source indexes reject duplicate purchase/return/payment posting. Synchronous UI guards prevent repeated activation/payment taps. Tests cover both purchase-before-payment and payment-before-purchase orderings, closed-session rejection, duplicate sources, and rollback after an injected payment-header failure.

## Performance

Synthetic dataset: 1,000 suppliers, 10,000 account entries, 5,000 payments, 7,500 tender rows, 4,000 linked purchase receipts, and 10 cash sessions. Seven measured runs after warm-up:

| Path | Min | Median | Max |
| --- | ---: | ---: | ---: |
| Supplier list | 0.75 ms | 0.81 ms | 1.47 ms |
| Supplier search | 0.10 ms | 0.10 ms | 0.11 ms |
| Supplier detail | 0.03 ms | 0.03 ms | 0.04 ms |
| Statement first page | 0.04 ms | 0.06 ms | 0.09 ms |
| Filtered statement | 0.04 ms | 0.05 ms | 0.05 ms |
| Payment history | 0.03 ms | 0.03 ms | 0.04 ms |
| Payment detail | 0.02 ms | 0.02 ms | 0.03 ms |
| Health audit query | 2.44 ms | 2.59 ms | 2.65 ms |

`EXPLAIN QUERY PLAN` confirms the statement, payment history, and tender detail paths use `idx_supplier_account_entries_supplier_date`, `idx_supplier_payments_supplier_date`, and `idx_supplier_payment_tenders_payment`. No schema v18 or speculative index was added.

## 320dp

Equivalent 320dp validation was executed on the physical Android target using an 840-pixel override at density 420. Supplier list/detail, activation, opening balance, SYP/USD/Mixed payment, credit confirmation, statement filters, and payment detail were exercised in Arabic/English, dark/light, and font scales 1.0/1.2. Horizontal tabs remained scrollable and no destructive overflow or clipped CTA was found. With the keyboard open, the payment confirmation required scrolling but remained fully reachable; dismissing the IME restored normal layout. The device was restored afterward to 1080x2280, font scale 1.0, dark mode, and Arabic.

## RTL/LTR

All new user-facing strings have Arabic and English translations. Physical Arabic RTL and English LTR checks passed for USD/SYP values, historical exchange rates, signed ledger deltas, running balances, payable/settled/credit states, and mixed tender rows. Light and dark themes remained readable at font scales 1.0 and 1.2.

## Physical Device

Validation target: Samsung SM-N975F, Android 12 / API 31, physical resolution 1440x3040, density 420, and 11,566,616 kB reported RAM.

Physical validation passed for v16→v17 migration, activation persistence, zero and positive opening balances, purchase and return postings across the activation cutover, SYP/USD/Mixed payments, rate snapshots, overpayment credit, no-active-session blocking, double-tap protection, payment details, deterministic statements and filters, cash reconciliation/close, PDFs/share sheets, backup/restore, Safe Merge, Excel export, database health, process restart, keyboard behavior, 320dp, RTL/LTR, light/dark, and font scale 1.2. The pre-v17 supplier remained inactive until explicit activation; no historical purchase or return was retro-posted. A new post-activation return against a pre-activation receipt correctly used its immutable historical cost.

Representative account sequence for the main supplier: opening +$100.00, post-activation purchases +$118.00, supplier returns -$72.20, payments -$160.80, final balance -$15.00 credit. Payment evidence included SYP 300,000 at 15,000 ($20.00), USD $25.00, Mixed SYP 150,000 + USD $5.00 ($15.00), and a later SYP payment at 15,500; earlier payments retained their 15,000 snapshot. Rapid confirmation created only one payment.

Repeated force-stop/cold-start checks found no duplicate posting, balance drift, migration replay, database lock, or lost committed state. Final logcat contained no app FATAL exception, ANR, OOM, SQLiteException, Hermes/ReactNativeJS failure, or raw-text warning. Existing SafeAreaView and InteractionManager deprecation messages were benign.

## Automated Tests

- Previous project baseline: 194/194.
- Phase 18 implementation regressions: 21.
- Phase 18.5 cash-drawer overdraw regression: 1.
- Final sequential suite: 216/216 PASS.
- Normal TypeScript: PASS.
- `noUnusedLocals` / `noUnusedParameters`: PASS.
- `git diff --check`: PASS (line-ending warnings only).

Coverage includes migration, activation and cutover, purchase/return posting, SYP/USD/Mixed payment, credit, committed-currency cash availability, cash-session formulas, immutability, duplicate prevention, transaction rollback, serialization, backup/restore compatibility, Safe Merge isolation, Excel export, health audit, PDF/UI wiring, indexes, and performance.

## Build

- Expo Android production export: PASS.
- Modules bundled: 1,326.
- Hermes Android bundles: 1.
- Assets: 27.
- Export directory: `dist-phase18` (generated and not committed).
- `:app:assembleRelease`: PASS in 2m 51s; 697 tasks (44 executed, 653 up-to-date).
- APK: `android/app/build/outputs/apk/release/app-release-unsigned.apk`, 129,076,987 bytes.
- Metadata: `com.sarafy.catalog`, versionCode 1, versionName 1.1.0, minSdk 24, target/compileSdk 36.
- APK remains unsigned as expected; it was not installed or ad-hoc signed.
- No AAB was created.

## Known Risks

- A separate negative-opening supplier was not created physically; signed negative balance and Supplier Credit behavior were instead proven physically through controlled overpayment and remain covered by automated signed-opening tests.
- The inspected statement PDF used the Payments filter; the full unfiltered statement path remains covered by automated model tests.
- Expo dependency patch drift was intentionally not changed in this phase.
- Production signing, versioning, and AAB packaging have not started.

Phase 19, customer accounts, general accounting, dependency synchronization, signing, and production AAB work were not started.
