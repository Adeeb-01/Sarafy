# Phase 22 — Latin Numerals and RTL/LTR Hardening

## Status

COMPLETE

Validation date: 2026-10-03.

## Branch

`feature/phase-22-latin-numerals-bidi`

## Commits

- `272b929` — Phase 21 validated base.
- `c2c8afd` — approved numeral and bidirectional-layout design.
- `e60cf40` — centralized numerals, reports, inputs, and compact-layout fixes.

## Schema

Schema remains v20. No migration, data rewrite, dependency change, version change, signing change, or AAB was introduced.

## Numeral Policy

Application-controlled numeric content uses ASCII digits `0-9`, comma grouping, period decimal separators, and an ASCII leading minus. Arabic-Indic and Persian digits are confined to the normalization map and regression tests. Stored accounting, pricing, inventory, payment, return, UUID, and snapshot values are unchanged.

## Input Normalization

`src/utils/numerals.ts` accepts Latin, Arabic-Indic, Persian, and mixed digit input. It normalizes supported decimal/minus forms before parsing while identifier mode preserves punctuation and leading zeroes. `AppInput` applies the policy live and displays numeric controls LTR in both languages.

## Number Formatting

`src/utils/formatters.ts` owns cached `Intl.NumberFormat` instances with `numberingSystem: 'latn'`, deterministic output normalization, integer-safety checks, exact USD-cent rendering, quantities, signed amounts, percentages, and exchange rates. Shipping screens no longer construct independent `Intl` number formatters.

## Date/Time Formatting

Cached `Intl.DateTimeFormat` instances explicitly request Latin digits and the Gregorian calendar. Arabic and English dates/times retained their existing locale semantics while rendering only `0-9`.

## Bidi Isolation

Technical tokens use shared LTR styles or centralized LRI/PDI isolation where string composition is unavoidable. References, barcodes, UUIDs, phone-like identifiers, dates, times, money, percentages, and negative amounts remain visually LTR without reversing strings.

## RTL/LTR Layout Policy

Arabic prose remains RTL and English prose remains LTR. Numeric internals are LTR while their containers follow locale placement. The audit retained physical left/right positioning only where it represents a real screen edge; no global mirroring or string-reversal hack was added.

## Shared Components

- `AppInput` supports explicit numeric and identifier modes.
- Shared typography exposes a technical LTR numeric style.
- Shared controls and quantity steppers use centralized formatters.
- `ConfirmSheet` now supports opt-in scrolling; import previews remain actionable at 320dp with font scale 1.2.

## Navigation

Arabic and English bottom navigation, screen headers, back controls, and horizontal section tabs were physically reviewed. At 320dp/font 1.2, compact navigation caps label scaling and keeps each label inside its tab.

## Products

Product list, create/edit form, category picker, prices, cost, resolved SYP values, quantities, barcodes, and search were reviewed. USD/USD, USD/SYP, SYP/USD, and SYP/SYP pricing combinations retained exact Phase 21 behavior.

## Sales

Cashier, cart, drafts, discounts, subtotals, totals, quantities, stock limits, and exchange-rate values use the common presentation policy. The sales header now stacks title/actions below 360dp, preventing the title and actions from collapsing into a narrow column.

## Payments

SYP, USD, and mixed payment values and inputs stayed LTR and Latin-digit. The compact checkout layout and keyboard-open state remained reachable and did not change settlement arithmetic.

## Invoices

Invoice list/detail references, timestamps, line quantities, historical prices, discounts, paid/change values, exchange snapshots, and return values were physically reviewed in Arabic. Search accepts normalized digit variants without changing text search.

## Customers

Customer list/detail, contact identifiers, receivable/credit values, statement references, dates, payments, and returns render technical tokens LTR. Negative and running balances remained readable.

## Suppliers

Supplier list/detail, purchases, returns, account statements, payments, USD values, historical cost/rate tokens, and references use centralized formatting. Horizontal supplier tabs remained reachable in both directions.

## Inventory

Balances, status counts, movement before/delta/after values, adjustments, valuation, and Health Audit display Latin digits. Physical Inventory Health Audit reported `دفتر المخزون سليم` after restore and Safe Merge.

## Expenses

Expense amounts, dates, filters, category counts, and input controls use Latin digits and LTR numeric fields. Accounting semantics were unchanged.

## Cash Sessions

Opening, expected, actual, received, change, refund, expense, supplier-payment, and difference values were reviewed with large and negative examples in SYP and USD.

## Analytics

Today/week/month cards, chart labels, totals, percentages, negative values, returns, expenses, and exchange summaries use centralized formatting. The existing chart and accounting equations remain unchanged and finite.

## Accounting

Dashboard, General Journal, Journal Detail, Chart of Accounts, reports, references, dates, account codes, debit, credit, and negative values were physically reviewed. Trial Balance displayed equal debit and credit totals. Accounting Health reported success.

## Settings

Exchange rate, history, rounding options, backup counts, restore previews, and version-related numeric content use Latin digits. Language switching was exercised Arabic → English → Arabic without a reload loop.

## Backup / Restore

Created `manual-20261003081449345-950670.sarafy` (141,246 bytes internally) with no `.writing`, `.importing`, or `.previous` residue. Full Restore from that test backup completed on device. The restored DB remained schema v20; `PRAGMA integrity_check` returned `ok`, and `PRAGMA foreign_key_check` returned zero rows.

## Safe Merge

Safe Merge preview rendered `0` new, `17` updates, `54` unchanged, `0` conflicts, and `0` rejected using Latin digits. Operational inventory, supplier/customer finance, purchase/return history, and General Ledger skip reasons remained explicit. The merge completed once; journal and inventory source counts did not duplicate. A compact-screen defect that hid the preview actions was fixed with an opt-in scrollable confirmation sheet and physically retested.

## PDFs

Arabic and English two-page Trial Balance PDFs were generated from the physical device, opened through Android sharing, rendered to PNG, and visually inspected page by page. Digits, negative amounts, dates, codes, headers, tables, totals, and column alignment were correct; no Arabic-Indic digits, reversed values, clipping, `null`, or `undefined` appeared. All report generators share LTR numeric CSS with `unicode-bidi: isolate`.

## Excel

Generated `sarafy-products-2026-10-03.xlsx` and opened the Android share sheet. Export keeps actual number cells numeric and applies normalized display strings only to generated textual columns; barcode/reference identity stays ASCII text.

## Accessibility

Technical accessibility strings avoid visual string reversal. Compact bottom-navigation labels are bounded, numeric inputs preserve clear LTR editing, and import actions remain reachable. Existing control labels and minimum action sizes were retained.

## Performance

Stable `Intl` formatter instances are cached by locale/options. No database query or N+1 path was added. The complete pre-existing performance suite passed, including large invoice, inventory, cash-session, accounting, pricing, backup, restore, and Excel workloads.

## 320dp

Equivalent 320dp validation used 840px at density 420. Arabic/English, dark/light, font scales 1.0/1.2, keyboard-open forms, products, cashier/payment, invoices, customers, suppliers, inventory, expenses, cash sessions, analytics, accounting, settings, restore, Safe Merge, PDF sharing, and Excel sharing were exercised.

Defects reproduced and fixed:

1. Sales header compression — compact vertical header below 360dp.
2. Bottom-navigation label overlap at font 1.2 — bounded compact typography.
3. Safe Merge preview actions unreachable — scrollable import confirmation content.

All three fixes have focused regression coverage and physical retest evidence.

## RTL/LTR Physical Validation

Normal width and 320dp were visually reviewed on Samsung SM-N975F (Android 12/API 31). Mixed Arabic/numeric content, USD decimals, negative SYP values, dates, times, percentages, UUIDs, references, barcodes, tables, tabs, and keyboard states stayed readable. Final device state was restored to 1080×2280, density 420, font scale 1.0, dark mode, and Arabic UI.

## Automated Tests

- Previous baseline: 287/287.
- Phase 22 regressions: 14.
- Final sequential suite: 301/301 PASS.
- TypeScript: PASS.
- Strict unused TypeScript: PASS.
- `git diff --check`: PASS.
- Static numeral/Intl/reversal audits: PASS.

## Build

- Android production export: PASS.
- Modules: 1,339.
- Hermes bundle: 5,734,745 bytes.
- Assets: 27.
- `:app:assembleRelease`: PASS in 5m38s, 697 tasks.
- No AAB, signing, application ID, dependency, or version change.

## Known Risks

- Device logcat retains known dev-client deprecation warnings and a non-fatal React-host soft exception during cold initialization; no Sarafy FATAL EXCEPTION, ANR, OOM, SQLiteException, Hermes fatal, ReactNativeJS fatal, or raw-Text error was observed.
- Android system share targets may independently display contact names containing Arabic digits; those strings are not controlled by Sarafy.
- Production-signed artifact validation remains outside Phase 22 and was not started.
