# Sarafy Phase 17.5 — Physical Android validation

Date: 2026-09-08

## Status

**READY FOR RELEASE HARDENING**

The critical physical release path is complete on the connected Android device: multi-currency settlement, customer returns, supplier returns, cash-session reconciliation and close, full backup, full restore, Safe Merge isolation, final SQLite integrity/foreign-key checks, and inventory health all passed. Phase 18, schema changes, dependency updates, Expo patch sync, signing changes, and AAB creation were not started.

This status is not a claim that every optional device matrix is complete. A genuine 320dp run, production-build performance profiling, high-volume physical list testing, and deterministic mid-commit force-stop timing remain release-hardening follow-ups.

## Device

| Field | Value |
| --- | --- |
| Manufacturer / model | Samsung SM-N975F (Galaxy Note10+) |
| Android / API | Android 12 / API 31 |
| Physical resolution | 1440 × 3040 |
| Test override | 1080 × 2280 |
| Density | 420 dpi; effective width about 411dp |
| RAM | 11,566,608kB (about 11.03GiB) |
| Serial | R3CM80SC8DN |

Application ID remains `com.sarafy.catalog`. Schema remains v16.

## Commits and Git checkpoint

- Base feature commit: `dda4d14 feat: add supplier purchase returns`.
- Earlier physical-flow fix: `8c4c28c fix: harden physical device flows`.
- Return-flow isolation fix: `307341e fix: isolate customer return flows`.
- Final physical-hardening fix: `48fd76a fix: harden transactional device workflows`.
- This existing validation report is intentionally local under the repository's ignored `docs/` policy; the verified source/test fixes are committed.
- No dependency, package identity, signing, schema, or accounting-formula change was made.

Before the final checkpoint, the intentional uncommitted product diff contained only:

- `src/database/database.ts`
- `src/components/sales/ReturnFlowScreen.tsx`
- `src/components/ui/ScreenContainer.tsx`
- `scripts/phase9-sales.test.mjs`
- `scripts/sales-ui.test.mjs`
- `scripts/startup-keyboard-ui.test.mjs`

Local screenshots, copied SQLite files, rendered PDF pages, and generated build outputs were treated as diagnostic evidence and were not included in the commit.

## Automated tests

| Check | Result |
| --- | --- |
| Original Phase 17.5 baseline | 175/175 sequential PASS |
| Previously established count | 181/181 sequential PASS |
| New regressions at this checkpoint | 3 |
| Final full sequential suite | **184/184 PASS** |
| TypeScript | PASS |
| Strict `noUnusedLocals` / `noUnusedParameters` | PASS |
| `git diff --check` | PASS; line-ending notices only |

The three latest regressions cover orphan draft-child cleanup plus atomic parent/child deletion, the numeric inventory-movement JSX condition, and Android keyboard-safe full-screen form actions. Earlier Phase 17.5 regressions for product keyboard layout, camera permission refresh, draft stock prevalidation, invoice-detail raw JSX whitespace, and per-invoice return-flow isolation remain green.

The machine-wide `npm` wrapper is broken because its global `npm-cli.js` is missing. Validation therefore invoked the same local TypeScript compiler and Node test runner directly from the workspace; this is a host-tooling issue, not an application or dependency change.

## Startup and initial UI

- Arabic RTL and dark-mode launch: PASS, with safe margins and usable bottom navigation.
- Five launcher cold starts had a previously measured median of about 1.96s; five task warm brings had a median of about 24ms. These are launcher/activity timings, not a production usable-UI benchmark.
- Open cash session persisted through force-stop/reopen.
- No migration loop, duplicate initialization, second splash, or immediate crash was observed.

## Products, suppliers, purchases, and barcode

- Products A/B/C/D and the Phase17.5 category persisted through backup/restore. A/B/D are tracked and C is untracked.
- Product barcodes restored exactly, including A `48506922` and B `175000000002`.
- Supplier create/edit/archive/restore and persistence: PASS.
- Purchase receipt: A +20 at USD 2.20 and B +10 at USD 1.50; 30 units and USD 59 total. One receipt item/movement per product, product current cost unchanged, and no expense/payment/cash-session accounting write.
- Camera permission refresh after Android Settings: PASS after fix.
- Known and unknown barcodes, torch, and repeated scanner reopen: PASS for the exercised device loop; no crash or black-preview recurrence.
- Scanner memory trend: 578,340kB before, 579,365kB after five reopens, 589,541kB after ten (about +1.94%); this is a dev-build short trend, not production leak proof.

## Cart, drafts, and payments

- Cart stock cap: PASS with clear insufficient-stock feedback.
- Resumed B×8 draft at current stock 5 showed the current availability, warning, disabled increment/checkout, and became valid at quantity 5. Completion created one invoice and one sale movement, deleted the draft, and left B at zero at that checkpoint.
- SYP: net 87,500; tender 100,000; change 12,500; drawer effect +87,500.
- USD: net 300,000; tender USD 21.00; historical rate 15,000; equivalent 315,000; SYP change 15,000; drawer effects USD +21.00 and SYP -15,000.
- Mixed: SYP 200,000 + USD 10.00 at 15,000 = 350,000 equivalent; change 50,000 SYP; drawer effects SYP +150,000 and USD +10.00.
- Underpayment of 250,000 against 300,000 was blocked without sale/payment/stock/session mutation.
- SYP → USD → Mixed → SYP mode switching cleared hidden tender values.
- Final SQL payment invariant check reported zero bad rows: payment equivalents minus SYP change equal each invoice net total.

## Exchange rate

- Operational rate 15,000 → 15,500 created exactly one history event.
- Old invoices retained their 15,000 snapshot; no historical recalculation occurred.
- Full restore used the backup setting and restored the current rate to 15,500 independently of history ordering.

## Customer returns

- Invoice 1 → Invoice 2 → Invoice 1 physical switching starts each return flow cleanly; no `RETURN_ITEM_NOT_FOUND` and no stale selected item.
- Return B quantity 2 with restock 1: refund 60,000 SYP, historical cost reversal 30,000 SYP, and inventory +1 only.
- Subsequent B returns with restock 0 committed financially without inventory mutation. The tested cumulative refund reached 90,000 after the second return; the later PDF-only return also preserved cumulative ≤ sold.
- Original invoices remained immutable, return documents were unique, and return-date analytics semantics were preserved.
- Final direct checks: no return-parent or sale-item orphan, no over-return, no duplicate restock source movement.

## Expenses

- Expense 25,000 SYP in Test/Maintenance with the Phase 17.5 note: PASS.
- SYP drawer decreased by 25,000, USD remained unchanged, and Analytics Expenses increased by 25,000.
- Rapid confirmation produced one expense.

## Supplier returns

- First return A×4 and second return A×2: PASS.
- Stock decreased 4 then 2; cumulative returned quantity is 6, with one immutable return header/item and one unique `purchase_return` movement per operation.
- The second historical value is USD 4.40 from the receipt snapshot (2 × USD 2.20), not current product cost.
- Stock-limited case: B had current stock 1 while purchase-returnable quantity exceeded it; requesting 2 kept confirmation disabled and created no header, item, movement, or negative inventory.
- Original purchase receipt remained immutable and status/remaining quantities were derived correctly.

## Inventory ledger and health

Product A physical ledger was verified in chronological order:

1. +10 opening
2. +20 purchase
3. -2 sale
4. +1 customer restock
5. -4 supplier return
6. -2 supplier return

Final A balance is 23. For every final ledger row, `before + delta = after`; latest movement equals the balance; tracked quantities are non-negative; and sale, customer-restock, purchase, and supplier-return source references are unique. Inventory Health Audit passed before restore, after full restore, and after Safe Merge.

## Cash sessions

The primary session reconciled exactly:

| Component | Value |
| --- | ---: |
| Opening SYP | 500,000 |
| SYP cash received | 750,000 |
| SYP change | -77,500 |
| Customer refunds | -207,500 |
| Expenses | -25,000 |
| Expected SYP | **940,000** |
| Actual SYP | **937,500** |
| SYP difference | **-2,500** |
| Opening USD | 50.00 |
| USD received | 31.00 |
| Expected / actual USD | **81.00 / 81.00** |
| USD difference | **0.00** |

SYP and USD differences stayed separate. Rapid close produced one immutable closed session. At font scale 1.2, a second empty test session opened once under rapid taps and closed once at exact zero; the database contains two closed sessions and no active session.

## Analytics

- Today, Week, and Month: physical PASS.
- Today/week returns-only state showed net sales -120,000, gross profit -60,000, expenses 25,000, and net profit -85,000 with no NaN/Infinity.
- Month showed net sales 930,000, gross profit 765,000, expenses 25,000, net profit 740,000, and five invoices.
- Top products, margin, average invoice, returns ratio, discounts, expense category, weekday/hourly views, insights, and exchange-rate summary rendered correctly.
- Purchase receipts and supplier returns created no direct sales/expense accounting rows and therefore no direct profit impact.

## PDFs

The complete physical matrix opened Android share sheets without sending externally. Rendered files were inspected page-by-page:

- SYP invoice: 87,500 / 100,000 / 12,500 correct.
- USD invoice: USD 21.00, rate 15,000, equivalent 315,000, change 15,000 correct.
- Mixed invoice: SYP 200,000 + USD 10.00, total equivalent 350,000, change 50,000 correct.
- Customer return: Arabic item, invoice reference, quantity, and refund correct; no cost/profit disclosure.
- Cash session: two pages with business activity and separate SYP/USD drawers; difference is not labelled profit.
- Purchase receipt: supplier, quantities, unit costs, line totals, and USD 59 total correct; no cash/profit claim.
- Supplier return: supplier, original receipt, A×2, historical USD 2.20 unit cost, and USD 4.40 total; explicitly documentary and not a settlement/debt claim.

No inspected PDF contained `null` or `undefined`.

## Backup and full restore

- Full backup: `manual-20260908105312452-854567.sarafy`, 23,215 bytes.
- Stable app path: `files/sarafy/backups/`; no `.writing` remainder.
- Force-stop/reopen preserved the complete dataset and current rate.
- Full Restore from that backup: PASS. Preview showed zero conflicts/rejections and the replacement completed successfully.
- Manifest: backupVersion 8, schemaVersion 16, correct application ID.
- Restored counts exactly matched the manifest: 4 products, 1 category, 5 sales, 5 sale items, 6 payments, 1 expense, 4 customer returns/items, 7 expense categories, 1 rate-history event, 1 backed-up cash session, 3 inventory balances, 11 movements, 1 supplier, 1 purchase receipt with 2 items, and 2 supplier returns/items. The backup contained zero drafts and zero product images.
- Portable UUID sets matched the backup for headers and child records. There were no duplicate payments, movements, returns, purchase returns, or cash sessions; no fake opening movements; and no recalculation of historical financial/cost/rate snapshots.
- Closed-session snapshot restored exactly at 940,000 / 937,500 / -2,500 SYP and 81.00 / 81.00 / 0.00 USD.

## Safe Merge

Safe Merge was run only after preserving the full backup. Preview explicitly reported that operational purchase receipts/movements and supplier-return inventory history are skipped to protect the stock ledger and require Full Restore. It reported 0 new, 5 would update, 26 unchanged, and 0 conflicts/rejections; execution reported added 0, updated 0.

Before/after rows were identical for products, suppliers, purchase receipts/items, supplier returns/items, inventory balances/movements, sales/items/payments, customer returns/items, expenses, cash sessions, and exchange history. Supplier identity followed the UUID policy, operational inventory was unchanged, and no inventory-linked history was silently imported.

## Force-close and double-tap coverage

- Force-stop persistence was verified after session open, transactional sales/returns, supplier returns, backup, restore, and Safe Merge. Direct SQLite inspection always found a fully committed or absent operation; no partial header/item/movement state was found.
- Deterministically landing a force-stop inside the sub-millisecond SQLite commit window was not practical on this device. Atomic rollback/serialization remains covered by the full automated suites.
- Physical single-commit guards were observed for Save Product, Open Session, Customer Return, Expense, Supplier Return, and Close Session. Completed sale/payment, purchase receipt, and manual adjustment remained transactionally unique in final DB evidence, but not every one had a separately recorded rapid-tap gesture.

## Keyboard, RTL/LTR, themes, and font scale

- Android keyboard: product, exchange-rate, expense, opening/closing session, SYP/USD/Mixed payment, stock in/out/count, supplier, purchase quantity/cost, and supplier-return quantity forms remained usable in the exercised flows.
- Supplier-return CTA regression: physical PASS; confirmation remained reachable above the IME.
- English LTR and Arabic RTL: physically checked across Products, Sales/Invoices, Analytics, Inventory, Suppliers/Purchases/Returns, Cash Sessions, Catalog, and Settings. SYP/USD, 15,000 → 15,500, negative differences, stock deltas, and percentages remained readable.
- Light and dark themes: physically checked across the same core screens with no unreadable foreground/background regression.
- Font scale 1.2: product, stock in/out/count, purchase quantity/cost, supplier return, and shift open/close actions remained reachable. Payment and Analytics had already passed at normal scale; a complete 1.2 capture of every secondary card remains a noncritical hardening follow-up. The device was restored to font scale 1.0, Arabic, and dark mode.
- 320dp: **PENDING**. The physical phone is about 411dp and is not claimed as a 320dp PASS.

## Lists, memory, and jank

- Products, invoices, cash-session history, inventory movements, purchase history, supplier returns, and suppliers were navigated/scrolled without blank recycled rows, stale detail, or crash. The physical dataset is small; a genuinely high-volume physical list run remains pending.
- PSS: 257,884kB at a fresh post-restore checkpoint, 508,646kB after the full PDF/restore/theme/font test matrix, and 501,863kB after subsequent navigation. Scanner-loop PSS reached 589,541kB. The later samples plateaued rather than showing sustained unbounded growth, but dev-client PSS is not a release-memory benchmark.
- Reset `gfxinfo` during automated screen navigation recorded 337 frames, 28.49% deadline-missed/janky, p50 17ms, p90 31ms, p95 42ms. Launch, Metro/dev-client overhead, ADB input automation, and screen transitions are included, so this is an elevated development warning rather than a production-release regression claim. No rendering crash occurred; release-profile frame testing remains hardening work.

## Storage, WAL, and logs

- Backup directory contains the manual backup plus two expected pre-import safety backups created by Full Restore and Safe Merge. No `.writing`, `.tmp`, `.importing`, or `.previous` artifact remained.
- Seven test PDFs remain in Android cache/Print (about 263KiB total). They are cache artifacts from the explicit PDF matrix, not stable app data.
- SQLite DB/WAL/SHM were approximately 4KiB / 2.48MiB / 32KiB at the final checkpoint. WAL/SHM presence is normal; no unbounded growth or failed cleanup was demonstrated.
- Final logcat review: 0 app FATAL exceptions, 0 app ANR, 0 OOM, 0 ReactNativeJS/Hermes errors, 0 expo-camera/print/sqlite errors, 0 raw-text warning, 0 `RETURN_ITEM_NOT_FOUND`, and 0 startup FK failure. Sixteen `SQLiteException` matches belonged to another system process querying unrelated `pp_data` tables and are classified BENIGN.
- Remaining React Native SafeAreaView/InteractionManager deprecation messages are WARNINGS, not crashes.

## Final database health and invariants

- `PRAGMA user_version = 16`.
- `PRAGMA integrity_check = ok`.
- `PRAGMA foreign_key_check` returned zero rows.
- Zero orphans for sale items/payments/returns/return items/draft items, inventory movement products, purchase items, purchase returns, and purchase-return items.
- Zero bad movement arithmetic, negative tracked balances, latest-movement/balance mismatches, duplicate source movements, payment invariant failures, customer over-returns, supplier over-returns, or historical supplier-cost mismatches.
- Final row counts after the deliberately added empty shift are 4 products, 5 sales, 6 payment rows, 4 customer returns, 1 expense, 2 closed cash sessions, 3 inventory balances, 11 movements, 1 supplier, 1 purchase receipt/2 items, and 2 supplier returns/2 items. Draft headers/items are both zero.

## Bugs found and fixes

### 1. Product save CTA hidden by Android keyboard

- Reproduction: focus a product field on Android 12; save action fell behind the IME.
- Root cause: the full-screen modal did not resize for the Android keyboard.
- Fix: keyboard-safe full-screen container behavior.
- Regression: verifies the save footer stays inside the resizing container.
- Physical retest: PASS.

### 2. Camera permission stale after Android Settings grant

- Reproduction: grant camera in Settings and return to the still-mounted scanner.
- Root cause: permission state was read only at mount.
- Fix: refresh when scanner becomes visible and AppState returns active.
- Regression and physical retest: PASS.

### 3. Resumed draft above stock reached confirmation

- Reproduction: resume B×8 after stock fell from 15 to 5.
- Root cause: draft hydration lacked current inventory availability.
- Fix: hydrate/display/cap by current quantity and disable checkout until valid; SQLite guard unchanged.
- Regression and physical retest: PASS, including successful reduction to 5.

### 4. InvoiceDetailsSheet raw JSX whitespace

- Reproduction: open invoice details and customer-return confirmation; LogBox reported text outside `<Text>`.
- Root cause: literal whitespace between adjacent conditional blocks inside a `View`.
- Fix: remove only that raw node.
- Regression and physical retest across multiple invoices: PASS.

### 5. ReturnFlow state survived invoice changes

- Reproduction: open a return on Invoice 1, then Invoice 2; stale sale-item identity caused `RETURN_ITEM_NOT_FOUND`.
- Root cause: the mounted flow retained local quantity/restock/success state.
- Fix: key the flow by sale identity.
- Regression and physical Invoice 1 → Invoice 2 → Invoice 1 retest: PASS.

### 6. Orphan draft item caused startup FK failure

- Reproduction: a historical `sale_draft_items` row remained after its parent draft deletion; startup reported `DATABASE_FOREIGN_KEY_CHECK_FAILED`.
- Root cause: some draft-delete paths removed the header without explicitly deleting children.
- Fix: delete children and parent atomically; startup removes only unreachable draft-item orphans before integrity checks.
- Regression: covers atomic child deletion and narrowly scoped cleanup.
- Physical retest: PASS; the orphan was removed, FK check became empty, and completed sales/inventory/history remained unchanged.

### 7. ReturnFlow rendered numeric zero as a raw JSX child

- Reproduction: `inventory_sale_movement` arrived as SQLite numeric 0/1; a truthy-style JSX chain could yield numeric 0 inside `View`.
- Root cause: the render condition used the raw numeric flag.
- Fix: compare explicitly with `=== 1`.
- Regression and customer-return physical retest: PASS.

### 8. Supplier-return confirmation hidden by keyboard

- Reproduction: focus supplier-return quantity; confirmation bounds collapsed outside the usable IME viewport.
- Root cause: the shared full-screen form container did not apply the hardened Android resize behavior.
- Fix: minimal Android `height` keyboard-avoidance behavior in the shared container.
- Regression and physical supplier-return retest, including font scale 1.2: PASS.

## Build

- Android production export: PASS; Hermes bundle and 27 assets exported to the ignored `dist-phase17_5` directory.
- `:app:assembleRelease`: **BUILD SUCCESSFUL** with Android Studio JBR supplied through process-local `JAVA_HOME`; 697 tasks, 44 executed and 653 up-to-date.
- Gradle emitted existing toolchain/deprecation warnings only. No AAB was created.
- Prior Expo checks remain documented as 19/21 with the known non-CNG and patch-version warnings; no patch sync or dependency fix was run.

## Release readiness

**READY FOR RELEASE HARDENING**

Critical Phase 17.5 device validation is complete and database/accounting state is healthy after Full Restore and Safe Merge. Release hardening should still include a genuine 320dp run, production-build memory/frame profiling, a high-volume physical list dataset, and—if required by the release protocol—instrumented process-kill fault injection at transaction boundaries. Phase 18 has not started.
