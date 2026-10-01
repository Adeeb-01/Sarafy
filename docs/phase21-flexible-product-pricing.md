# Sarafy Phase 21 — Flexible Product Pricing

## Status

**COMPLETE**

Phase 21 is complete on schema v20. Flexible Product master Cost and Sale Price currencies are implemented, validated by 287/287 sequential automated tests, exercised on a physical Android device, and built through the Android production export and `:app:assembleRelease` gates. This does not renew the previous production-release gate: schema v20 still requires its own later Release Candidate Gate.

## Branch

- `feature/phase-21-flexible-product-pricing`
- Base: `8903de8 docs: record phase 20.5 release candidate gate`
- Package remains `com.sarafy.catalog`.
- Android version remains `1.1.0` / versionCode `1`.

## Commits

- `0f6ad59 docs: define flexible product pricing design`
- `6fba11e docs: approve flexible pricing arithmetic policy`
- `94ce548 feat: add optional SYP product pricing`

## Schema

One exclusive transactional migration advances v19 to v20.

`products` adds:

- `sale_price_currency` (`USD | SYP`, legacy default `USD`)
- `sale_price_syp` (nullable, nonnegative integer SYP)
- `cost_currency` (`USD | SYP`, legacy default `USD`)
- `cost_syp` (nullable, nonnegative integer SYP)

Both `sale_items` and `sale_draft_items` add the same immutable pricing evidence:

- sale source currency, canonical native decimal/native SYP
- pricing exchange rate when applicable
- rounding-enabled and rounding-target snapshots
- cost source currency, canonical native decimal/native SYP
- cost exchange rate when applicable

`PRAGMA user_version` changes only after all columns are added. The physical migrated/restored database reported v20, `integrity_check = ok`, and an empty `foreign_key_check`.

## Design Gate

The repository-wide pricing audit was committed before implementation. The owner-approved arithmetic policy uses exact canonical decimals and BigInt, direct HALF-UP rounding to the final sale quantum, one-time line-total Cost rounding, a four-decimal limit for new/modified USD master values, and fidelity for unchanged legacy higher-precision USD values.

## Product Pricing Model

Cost currency and Sale Price currency are independent. All four combinations are supported:

- USD Cost / USD Sale
- USD Cost / SYP Sale
- SYP Cost / USD Sale
- SYP Cost / SYP Sale

The active currency discriminator selects the authoritative native value. Inactive values may remain stored but never participate in calculations. Switching currency never silently converts or overwrites the alternate native value.

## Cost Currency

- SYP Cost is an exact nonnegative safe integer.
- USD Cost accepts up to four decimals for new/modified values.
- USD operational Cost is computed from the canonical decimal and transaction rate, then rounded HALF-UP once at immutable line-total level.
- SYP line Cost is `native SYP cost × quantity` using checked exact integer arithmetic.
- Product master Cost remains operational metadata; it does not replace Phase 20 moving-weighted-average GL inventory valuation.

## Sale Currency

- Native SYP Sale Price is used directly and is not changed by rate or rounding settings.
- USD Sale Price is parsed exactly and multiplied by the committed transaction rate.
- Rounding disabled means direct HALF-UP to one SYP.
- Rounding enabled means direct HALF-UP to the selected final target (5/10/500/1000 as applicable), with no intermediate one-SYP rounding.

## Migration

All legacy Products remain USD/USD with unchanged SQLite REAL values and null inactive SYP values. Historical sales, drafts, returns, inventory, purchases, journals, and accounting balances are not rewritten. Legacy sale/draft rows are intentionally allowed to have null v20 source metadata; Health Audit does not misclassify them.

## Product UI

Create/Edit exposes independent USD/SYP selectors and values for Sale Price and Cost. Validation rejects fractional/unsafe SYP and USD edits beyond four decimals without silently rounding. Active native Sale/Cost values are shown in product lists, cards, cashier rows, and purchase informational displays.

Physical testing found and fixed two 320dp presentation defects:

- Dense Product rows reserved too much fixed horizontal space, truncating names and native values. Compact rows now keep native Sale/Cost and resolved SYP readable while retaining deterministic FlatList geometry.
- English `Products` was squeezed by header actions at font scale 1.2. The narrow layout now places the full-width title above the action row.

## Sales

Each cart line receives one coherent pricing snapshot at add/repeat time. `createSale` validates complete metadata, safe integer Sale values, exact line Cost replay, totals, stock, payments, inventory, and accounting inside the existing exclusive transaction. Product edits are atomic single-row updates, so an edit racing a sale cannot produce a mixed old/new Product configuration.

## Mixed Pricing Cart

A physical sale combined all four pricing combinations at 16,000 SYP/USD. The exact cart total was 138,000 SYP (55,500 + 37,500 + 23,000 + 22,000). SYP, USD, and Mixed payment paths passed, including 55,500 paid by 3.47 USD with 20 SYP change and 23,000 paid by 7,000 SYP + 1.00 USD.

## Cost Snapshots

Post-v20 lines preserve canonical source value, source currency, rate only when used, quantity, compatibility unit Cost, and authoritative integer `line_cost_syp`. Health Audit replays the integer result from immutable evidence and never reads the current Product or current rate.

## Drafts

Drafts keep their original pricing evidence and resolved SYP values. A 55,500 SYP draft created at rate 16,000 remained 55,500 after the current rate became 16,500, while the UI clearly showed old/current rates. No silent repricing occurred.

## Barcode

Barcode identity remains currency-neutral. Physical lookup of `P21004` selected the expected Product and displayed its current active USD master price plus resolved SYP value. Adding through barcode uses the same centralized active pricing snapshot builder as other cashier paths.

## Returns

Customer refunds and Cost reversals use immutable original SYP line snapshots. A historical 57,000 SYP sale with 18,333 SYP operational Cost was fully returned for exactly 57,000/18,333 after the Product master had been edited; the current master values and rate were irrelevant.

## Analytics

Operational analytics continue to consume immutable SYP sale and operational line-Cost snapshots. Physical Today/Week/Month checks completed without NaN/Infinity. The tested dataset showed 272,000 SYP net sales and 154,162 SYP gross profit, consistent with the captured Phase 21 sale/return evidence.

## Inventory

Existing balances and movements were not revalued. Manual Stock-In/Physical Count Increase suggestions use native SYP Cost directly or current-rate USD Cost conversion, remain editable suggestions, and retain Phase 20 confirmation rules. Inventory Health Audit passed after Phase 21 sales, return, backup, and restore.

## Accounting

Product master edits create no journal. Sale revenue continues from immutable invoice SYP values; GL COGS continues from inventory valuation rather than Product master Cost. Physical checks passed for the journal, Trial Balance, P&L, Balance Sheet, seven reconciliation families, and Accounting Health Audit. Trial Balance debits and credits both equalled 10,001,347,100 SYP; Balance Sheet sides both equalled 10,001,159,600 SYP.

## Purchases

Purchase Receipt and Supplier Return currencies/accounting remain unchanged and continue using their own USD receipt snapshots, inventory valuation, supplier layers, and GL rules. Product master Cost is only displayed as informational context and is not mutated by posting purchases.

## Backup / Restore

The v20 `.sarafy` payload contains Product native currencies/values and sale/draft pricing evidence. Pre-v20 payloads default missing Product discriminators to USD without fabricating SYP values.

Physical backup `manual-20261001091440703-638842.sarafy` was 141,244 bytes, completed without `.writing`, and parsed as schema 20. Full Restore added 294 records in the replacement flow. Post-restore row counts and exact Phase 21 Product/snapshot/return values matched the backup; database and both health audits passed.

## Safe Merge

Product master pricing fields follow the existing Product UUID/update policy. Historical operational and accounting data remain protected. Physical preview reported explicit operational-stock/purchase/return/customer/supplier/GL skip reasons, then completed with zero added or updated historical financial records and no silent inventory mutation.

## Excel

Existing Product Excel import/export was extended rather than converted into a backup mechanism. It includes Cost Currency, Cost USD/SYP, Sale Price Currency, and Sale Price USD/SYP; legacy missing currency columns default to USD. New/update USD values above four decimals and invalid/fractional SYP values are rejected. Physical export opened the Android share sheet.

## PDF

Invoice totals remain authoritative SYP snapshots and customer-facing invoice semantics are unchanged. Invoice/return sharing paths opened successfully; the customer return receipt showed the immutable invoice reference, quantities, and SYP refund without null/undefined values. Accounting PDFs remain SYP reports and were not modified by Product pricing.

## Health Audit

Health replay validates source enum, required active native value, safe integer SYP data, canonical decimal evidence, applicable rate/rounding metadata, resolved unit Sale Price, and authoritative line Cost. Pre-v20 null metadata is exempt. Physical Inventory and Accounting Health Audits passed before and after Full Restore.

## Concurrency

Product mutations are exclusive SQLite transactions and update all pricing fields together. Cart/draft lines hold a single resolved snapshot object. Sale persistence validates that snapshot before and during the exclusive transaction, preventing an old currency/new value mixture. Double-action guards and existing serialized sale behavior remain intact.

## Performance

There are no per-row Product database lookups: list/search/filter/sort resolve native values from already-loaded Product rows. A 10,000-operation exact Sale/Cost arithmetic benchmark completed in 47.61 ms in the final targeted run (earlier warm runs ranged lower), well below its 500 ms regression ceiling. Existing Product indexes and list virtualization remain unchanged; the compact 320dp row uses a fixed 104 px layout so `getItemLayout` stays O(1).

## 320dp

Equivalent 320dp validation covered Arabic/English, dark/light, font scales 1.0/1.2, Product rows, Product form, both independent selectors/values, and keyboard-open state. The Save CTA remained reachable above the numeric keyboard. Both reproduced narrow-layout defects were fixed, regression-tested, rebuilt, installed, and physically retested.

## RTL/LTR

Arabic RTL and English LTR passed. USD decimals, SYP integers, active native values, and resolved equivalents remained readable and retained numeric meaning. No currency selector semantics reverse under RTL.

## Physical Device

- Samsung SM-N975F (Galaxy Note10+), Android 12 / API 31, 11,566,616 kB reported RAM
- v19→v20 in-place migration and persisted data: PASS
- Four pricing combinations, mixed cart, all payment modes, rate change, draft, barcode, Product edit history, Return, Analytics, Inventory, Accounting, Backup, Full Restore, Safe Merge, Excel/share, force-stop/restart: PASS
- Final Logcat review: no FATAL EXCEPTION, ANR, OOM, SQLiteException, Hermes/ReactNativeJS failure, or raw Text warning
- Device restored after validation to 1080×2280 override, density 420, font scale 1.0, dark mode, and Arabic UI

## Automated Tests

- Prior baseline: 268/268
- Phase 21 regressions: 19
- Final full sequential suite: **287/287 PASS**
- TypeScript: PASS
- Strict `noUnusedLocals`/`noUnusedParameters`: PASS
- `git diff --check`: PASS

Coverage includes exact parsing, four combinations, direct-target rounding, one-time line Cost rounding, legacy precision/migration, integer safety, immutable returns, transactional rollback, schema/source propagation, backup/restore/Safe Merge/Excel, Health Audit boundaries, accounting separation, 10k arithmetic, and 320dp list/header regression guards.

## Build

- Android production export: PASS
  - 1,337 modules
  - Hermes `.hbc` bundle
  - 27 assets
- `:app:assembleRelease`: PASS
  - 697 tasks
  - final build time approximately 1m37s
- No AAB, production signing, version, package, schema-beyond-v20, or dependency change was made.

## Known Risks

- The installed physical validation artifact was locally signed only to permit in-place device testing; it is not a production signing identity.
- Phase 20.5 release evidence applied to schema v19. Schema v20 requires a separate Release Candidate Gate before claiming production packaging readiness.
- Expo SDK patch drift remains intentionally outside Phase 21; no dependency synchronization was performed.
- USD Product masters remain SQLite REAL for backward compatibility. Every committed post-v20 SYP result is nevertheless derived from a centralized canonical decimal snapshot and exact BigInt arithmetic.
