# Sarafy Phase 20.5 — Accounting Release Candidate Evidence Gate

## Status

**READY FOR PRODUCTION PACKAGING**

This gate validates the existing Phase 20 accounting implementation in a production-like Android Release APK environment. It does not authorize production signing, an AAB, a version increment, dependency synchronization, schema v20, or Phase 21.

## Branch

`release/phase-20.5-accounting-rc-gate`

## Base Commit

- Gate start: `1024e3d` — `docs: complete phase 20 validation report`
- Phase 20 implementation: `762b7aa` — `feat: add general ledger accounting core`
- Schema remained `v19`.
- Package remained `com.sarafy.catalog`.

## Commits

- `0799521` — `fix: harden phase 20 release candidate`
  - Adds the six missing accounting report/control sheets to the Excel export.
  - Adds one focused Phase 20 regression test.
- This report is committed separately from the product fix.

## Scope

Release validation only. No new accounting policy or workflow was added. There was no schema change, dependency change, Expo patch synchronization, Android regeneration, production signing configuration, production AAB, or Phase 21 work.

The only source defect found was an export completeness defect. The fix is report-only and does not alter posting, balances, historical records, restore/import behavior, or SQLite schema.

## Automated Baseline

- Starting baseline: **267/267 PASS**.
- TypeScript: PASS.
- Strict `noUnusedLocals` / `noUnusedParameters`: PASS.
- `git diff --check`: PASS.
- Phase 20 baseline, migration, posting, restore, Safe Merge, PDF/report, fault-injection, and high-volume tests remained green.

## Production Export

Fresh Android production export after the fix:

- Result: PASS.
- Modules: **1,337**.
- Hermes bundles: **1**.
- Hermes bundle: `_expo/static/js/android/AppEntry-ff284de09b34a6822dd02a9b9cb8c5fe.hbc`.
- Bundle size: approximately **5.7 MB**.
- Assets: **27**.
- Output: `dist`.
- Final clear-cache export duration: approximately **67.2 s**.

## Release Build

- `:app:assembleRelease`: PASS.
- Final result: `BUILD SUCCESSFUL`.
- Gradle tasks: **697 actionable**, 40 executed, 657 up-to-date.
- Final duration: approximately **2 min 28 s**.
- No AAB was created.
- No signing configuration was changed.

The first final attempt was blocked before project evaluation because the sandboxed wrapper could not download/resolve its existing Gradle plugin marker. Re-running the unchanged build through the normal Gradle resolution path succeeded; this was an execution-environment restriction, not a project failure.

## Release APK Metadata

Unsigned build artifact:

- Path: `android/app/build/outputs/apk/release/app-release-unsigned.apk`
- Size: **129,395,775 bytes**.
- SHA-256: `9BEF0410A5F05A63EDB496F8C5C7F830EF1DE10F057015876DFF4DDB0AD52C35`.
- Package: `com.sarafy.catalog`.
- Version code: `1`.
- Version name: `1.1.0`.
- Min SDK: `24`.
- Target SDK: `36`.
- Compile SDK: `36`.
- Label: `Sarafy`.
- ABIs: `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`.
- Hermes: present.
- APK signature verification: expected failure because the Gradle Release artifact is intentionally unsigned.

## Release Manifest

Merged Release manifest findings:

- `android:allowBackup="false"`.
- No `android:debuggable="true"`.
- No `RECORD_AUDIO` permission.
- No cleartext-traffic override.
- Expo Updates is explicitly disabled (`expo.modules.updates.ENABLED=false`).
- MainActivity is the expected exported launcher/deep-link surface.
- The only other exported component is AndroidX `ProfileInstallReceiver`, protected by `android.permission.DUMP`.
- File/sharing providers and library services are non-exported.
- No exported Expo dev launcher/dev menu surface was present.
- Camera, vibration, legacy bounded storage permissions, and Expo/library-generated `INTERNET` / `ACCESS_NETWORK_STATE` permissions match the established baseline.

## Offline Audit

Shipping runtime source was searched for `fetch`, Axios, `XMLHttpRequest`, `WebSocket`, HTTP URLs, and network-service integration. No Sarafy runtime server/API/authentication path was introduced. Package metadata/documentation strings were excluded from runtime findings.

Sarafy remained operational with the device offline; release starts and accounting navigation did not require Metro or a network connection.

## Disposable Release Signature

For in-place physical validation, a copy of the Release APK was signed with the already-installed local Android debug certificate because that exact local certificate matched the existing test installation. This preserved application data and required no uninstall.

**THIS IS A LOCAL NON-PRODUCTION RELEASE-PROFILE CERTIFICATE. IT IS NOT PRODUCTION SIGNING.**

- RSA: 2048-bit.
- Certificate SHA-256: `FAC61745DC0903786FB9EDE62A962B399F7348F0BB6F899B8332667591033B9C`.
- APK Signature Scheme v2: verified.
- APK Signature Scheme v3: verified.
- Signed copy size: **129,507,926 bytes**.
- Signed copy SHA-256: `E00AD701B9075B3BAFC886622C9D005F0426ACE2D6777E8934BB31CC98AD7E2F`.
- No key, password, signed APK, or credential was committed.

## Physical Device

- Manufacturer: Samsung.
- Model: SM-N975F (Galaxy Note10+).
- Android: 12.
- API: 31.
- Physical display: 1440 × 3040.
- Normal test override: 1080 × 2280.
- Density: 420 dpi.
- Effective normal width: approximately 411 dp.
- RAM (`MemTotal`): 11,566,616 kB.

## In-Place Upgrade

- The installed certificate and local validation certificate matched.
- `adb install -r` succeeded without uninstalling or clearing application data.
- `firstInstallTime` remained `2026-09-06 11:38:17`.
- The installed Release validation build did not have the `DEBUGGABLE` flag.
- Schema remained v19.
- No migration replay, duplicate initialization, duplicate system account, duplicate cutover, or duplicate journal occurred.

## Data Preservation

Pre-upgrade and post-upgrade evidence included products, sales/items/payments, returns, expenses, customer and supplier finance, inventory, purchases, supplier returns, cash sessions, the 21 system accounts, journals/lines, inventory valuation, cash control, supplier foreign layers/allocations, settings, and cutover positions.

Immediately after in-place Release upgrade, authoritative-table counts and hashes were unchanged. Representative retained counts included:

- Products: 4.
- Sales: 12; sale items: 12; sale payments: 11.
- Customer returns/items: 8 / 8.
- Expenses: 2.
- Customers: 1; customer entries: 12; payments/tenders: 4 / 5.
- Suppliers: 2; supplier entries: 16; payments/tenders: 7 / 8.
- Inventory balances/movements: 3 / 23.
- Purchase receipts/items: 5 / 6.
- Supplier returns/items: 5 / 5.
- Cash sessions: 6.
- GL accounts/journals/lines/balances: 21 / 10 / 33 / 21.
- Inventory valuation balances/movements: 3 / 6.
- Supplier foreign layers/allocations: 3 / 4.

## Cold Startup

Five Release cold starts:

- Samples: 1,415 ms; 1,137 ms; 955 ms; 1,436 ms; 1,190 ms.
- Minimum: **955 ms**.
- Median: **1,190 ms**.
- Maximum: **1,436 ms**.

Every start reached usable UI without a crash, migration loop, database lock, or duplicate accounting posting.

## Warm Resume

- Warm resume observation: approximately **61 ms** (`HOT`).
- Home → resume and background → foreground retained the same state.
- No stale accounting view, duplicate initialization, or cash-control drift appeared.

## Process Restart

Force-stop and cold restart preserved:

- accounting enabled state and start time;
- functional currency and cutover;
- journal count and GL balances;
- cash control;
- inventory carrying balances;
- supplier foreign layers;
- reconciliation and Health Audit state.

The final release startup after process death showed the same operational exchange rate and dataset with no startup mutation.

## Accounting Smoke Flows

The controlled test dataset contained and preserved post-cutover evidence for SYP, USD, mixed and on-account sales, customer payments, customer returns with independent restock quantity, expenses, purchases, supplier returns, supplier payments at a different settlement rate, realized FX, a cash adjustment, and inventory value movements.

Release validation browsed the resulting sources, journals, account ledgers, controls and reports, and direct SQLite checks reconciled every source/control. Destructive business flows were not recreated merely to duplicate already-present representative evidence.

Operational source rows and immutable snapshots remained unchanged through in-place upgrade. Automated release tests additionally cover the valid zero-functional-value source policy and verify that it produces operational evidence without a fabricated journal.

## Journal

- General Journal loaded on Release.
- Source/date/account filters were accessible.
- Journal records were read-only.
- Supplier-payment detail showed the expected balanced posting:
  - DR Accounts Payable: 387,500 SYP.
  - DR Realized FX Loss: 12,500 SYP.
  - CR Cash SYP: 400,000 SYP.
- Final journal count: 10.
- Final journal-line count: 33.
- Total debit and credit: **10,002,280,100 SYP each**.
- Invalid lines, empty/unbalanced entries, and duplicate source journals: zero.

## Account Ledger

- Cash SYP ledger opened on Release with debit, credit, reference, date and running balance.
- Negative and mixed Arabic/Latin values remained readable.
- Ordering and running balance matched the immutable journal lines.
- Account-statement PDF/share action succeeded.

## Trial Balance

- Total Debit: **10,001,018,100 SYP**.
- Total Credit: **10,001,018,100 SYP**.
- UI and direct SQLite evidence matched exactly.
- PDF and Excel values matched the UI.

## Profit & Loss

Release GL-derived values:

- Sales Revenue: 108,500 SYP.
- Sales Returns: -77,500 SYP.
- Net Sales: 31,000 SYP.
- COGS: -15,500 SYP.
- Gross Profit: 15,500 SYP.
- Operating Expenses: -25,000 SYP.
- Realized FX: -12,500 SYP.
- Net Loss: **-22,000 SYP**.

The report rendered correctly in UI, PDF and the repaired Excel export.

## Balance Sheet

- Assets: **10,000,887,600 SYP**.
- Liabilities: **77,500 SYP**.
- Equity: **10,000,810,100 SYP**.
- Liabilities + Equity: **10,000,887,600 SYP**.
- Identity passed exactly.
- Current Earnings remained a report presentation value, not a hidden closing journal.

## Reconciliation

All seven controls reported **MATCHED** with zero difference:

| Control | Control SYP | Ledger SYP |
|---|---:|---:|
| Cash SYP | 9,999,554,600 | 9,999,554,600 |
| Cash USD carrying | 155,000 | 155,000 |
| Accounts Receivable | 0 | 0 |
| Customer Credits | -77,500 | -77,500 |
| Inventory | 1,178,000 | 1,178,000 |
| Accounts Payable | 0 | 0 |
| Supplier Advances | 0 | 0 |

No silent repair occurred.

## Health Audit

Accounting Health Audit: PASS in Release UI and automated/direct database checks.

Confirmed zero counts for:

- invalid or unbalanced journal;
- invalid/zero-valued journal line;
- duplicate source posting;
- GL cache mismatch;
- inventory quantity/value/movement/latest mismatch;
- cash-control mismatch;
- customer AR/credit mismatch;
- supplier payable/advance mismatch;
- invalid supplier layer/allocation residual;
- Balance Sheet identity failure.

## PDFs

Generated on the signed Release validation APK:

- Trial Balance: 2 pages.
- Profit & Loss: 1 page.
- Balance Sheet: 1 page.
- Cash SYP account statement: 1 page.

PDFs were pulled, rendered to images and inspected. Arabic shaping, English/numerics, RTL/LTR, margins, row layout and page breaks were correct. The multi-page Trial Balance continuation page retained its top margin/header. No clipped rows, `null`, or `undefined` appeared. Android share chooser opened.

## Excel

### Defect and fix

The first Release workbook exported only the existing raw accounting sheets and omitted six required release-gate report/control projections.

- Reproduction: generate Excel from the signed Release APK and inspect workbook sheet names.
- Root cause: `exportExcel` appended Chart of Accounts, General Journal, Journal Lines and Trial Balance, but did not append P&L, Balance Sheet, Reconciliation, Inventory Valuation, Cash Control or Supplier Positions.
- Fix: minimal export-only projection from the already-authoritative portable accounting state.
- Accounting/restore/import behavior: unchanged.
- Regression: one focused Phase 20 test added.
- Physical retest: PASS on rebuilt and reinstalled signed Release APK.

Post-fix workbook:

- Size: **183,742 bytes**.
- Sheets: **38** total.
- Required sheets present: Chart of Accounts, General Journal, Journal Lines, Trial Balance, Profit & Loss, Balance Sheet, Reconciliation, Inventory Valuation, Cash Control, Supplier Positions.
- Reconciliation: seven rows, all `YES`, difference zero.
- Inventory valuation: Phase17.5-A quantity 38, carrying value 1,178,000 SYP, average 31,000 SYP.
- Cash and supplier-position values matched SQLite.
- Excel import remains unable to mutate accounting history; this is covered by automated assertions.

## Backup

Release-created backup:

- File: `manual-20260930112432745-208712.sarafy`.
- Size: **116,760 bytes**.
- Stable application-managed path.
- Share/document chooser opened.
- No `.writing` residue.

Force-stop/reopen preserved the backup and application state.

## Full Restore

Full Restore was executed through the signed Release UI only after the recoverable backup existed.

- Preview: 6 new, 12 updates, 40 unchanged, 0 conflicts, 0 rejected.
- Restore result: success; undo safety action was offered.
- Schema: v19.
- Integrity: `ok`.
- Foreign-key violations: 0.
- Accounts/journals/lines/balances: 21 / 10 / 33 / 21.
- Inventory valuation balances/movements: 3 / 6.
- Supplier layers/allocations: 3 / 4.
- Sales/returns/cash sessions: 12 / 8 / 6.
- Journal/cache/control invariants remained valid.

Full Restore intentionally remaps local integer IDs and foreign keys while preserving portable UUID identity and semantic state. Therefore, equality was verified by portable identities, row counts, immutable values, balances and accounting invariants rather than by byte-identical local table hashes.

## Safe Merge

Safe Merge was run on Release with the same controlled valid archive.

- Preview: 0 new, 12 updates, 42 unchanged, 0 conflicts, 0 rejected.
- UI displayed explicit operational-finance skip reasons for purchases/inventory, supplier finance, customer finance/credit sales, GL journals/balances/cutover, cash carrying state and supplier returns.
- Merge completed successfully.

Exact before/after hashes were identical for authoritative local accounting and operational-finance tables, including settings/cutover, GL accounts/journals/lines/balances, inventory valuation, cash control/adjustments, supplier layers/allocations, customer and supplier balances/entries/payments/tenders, cash sessions, inventory, purchases and supplier returns.

Post-merge integrity remained `ok`, FK violations remained zero, and no unbalanced journal appeared.

## RAM

Release observations:

- Fresh process: TOTAL PSS **133,900 kB**, RSS 259,122 kB, native heap 42,620 kB, Java heap 10,592 kB.
- After accounting navigation cycles: TOTAL PSS **134,719 kB**, RSS 266,944 kB, native heap 51,516 kB, Java heap 10,180 kB.
- After reports/PDF/Excel/backup activity in the longer release session: TOTAL PSS **200,058 kB**, RSS 369,918 kB, native heap 66,732 kB, Dalvik 12,132 kB.
- A process restart returned memory to the lower fresh range.

The approximately 819 kB fresh-to-navigation PSS delta and post-restart recovery provide no evidence of monotonic runaway retention. No OOM occurred. These are device-specific observations, not universal memory limits.

## Repeated Navigation

Approximately ten accounting navigation cycles covered Dashboard → Journal → Journal Detail → Account Ledger/Chart → Reports/Trial Balance → Back, together with repeated report/PDF/share navigation during the gate.

- No crash, stale record, duplicate posting, or unreachable screen.
- Fresh PSS: 133,900 kB.
- Post-navigation PSS: 134,719 kB.
- No persistent growth pattern was observed.

## Frame / Responsiveness

Release cumulative frame evidence during real navigation:

- Frames: 6,384.
- Janky frames: 157 (**2.46%**).
- 50th/90th/95th percentile: 16 ms.
- 99th percentile: 29 ms.

Journal, ledger, reports, reconciliation and Health Audit remained responsive without frozen UI or ANR. A later synthetic rapid-ADB sample was discarded because the activity was backgrounded and produced no valid rendered-frame window.

## High-Volume Evidence

Automated Phase 20 workload:

- 50,000 journals.
- 100,000 journal lines.
- Balanced reports, source lookup, reconciliation and Health Audit: PASS.

Final Phase 20 medians on this host:

- Journal history: 23.38 ms.
- Account ledger: 845.02 ms.
- Trial Balance: 85.52 ms.
- Profit & Loss: 108.07 ms.
- Source lookup: 0.08 ms.
- Health Audit: 1,726.12 ms.
- Reconciliation: 0.57 ms.

Final general release-stress medians included products 0.25 ms, product search 1.53 ms, invoice newest/oldest 0.26 ms, cash history 9.62 ms, inventory list 1.18 ms, supplier list 2.35 ms, purchase history 8.62 ms, supplier returns 7.90 ms, Analytics Month 4.63 ms, inventory health 3.88 ms, backup payload 563.20 ms and restore preview 115.99 ms.

The account-ledger and Health Audit operations are the heaviest measured accounting paths but remained within the existing accepted benchmark thresholds. No schema/index migration was introduced.

The physical Release device used the representative normal-size test dataset. The 50k/100k dataset remained automated-only to avoid injecting synthetic volume into the preserved device state.

## 320dp

The signed Release APK was tested at **840 px / 420 dpi = 320 dp**.

Validated:

- Accounting Dashboard.
- General Journal and filters.
- Journal Detail.
- Chart of Accounts.
- Cash SYP ledger.
- Trial Balance.
- Profit & Loss.
- Balance Sheet.
- Health status and reconciliation visibility.
- Arabic / English.
- Dark / light.
- Font scale 1.0 / 1.2.

No critical text, amount, CTA, bottom navigation, report row or journal line was clipped. Accounting tabs remain horizontally scrollable by design; Reports was reachable in both directions. At font 1.2, long dates wrapped vertically without hiding controls.

The cash-adjustment form was not opened because the preserved dataset had an active cash-session constraint; no session was closed or mutated merely for keyboard evidence. The form's centralized keyboard/CTA behavior remains covered by the existing 320dp and keyboard regression suites.

Device settings were restored to 1080 × 2280, font scale 1.0, Arabic and dark mode.

## RTL/LTR

- Arabic RTL: PASS.
- English LTR: PASS.
- Dark and light themes: PASS.
- SYP/USD, negative values, debit/credit, UUID/reference text, dates and mixed Arabic/Latin account names remained readable.
- Numeric values retained readable direction inside RTL UI.

## Higher API Evidence

**HIGHER-API PHYSICAL/EMULATOR VALIDATION NOT AVAILABLE.**

No already-available API 34/35/36 emulator or second device was present. Per gate policy, no SDK/emulator tooling was downloaded or reconfigured. This is optional evidence and no concrete target-SDK defect was found.

## Logcat

Final Release force-stop/start and navigation window contained no Sarafy:

- FATAL EXCEPTION;
- ANR;
- OutOfMemoryError;
- SQLiteException;
- database lock;
- Hermes fatal error;
- raw Text warning.

Benign warnings:

- React Native `SafeAreaView` deprecation.
- React Native `InteractionManager` deprecation.
- Unrelated Facebook/phone process messages and Android command-runtime entries generated by test tooling.

No warning represented an application failure.

## SQLite Final Audit

Final copied database after Release upgrade, restore and Safe Merge:

- `PRAGMA user_version`: **19**.
- `PRAGMA integrity_check`: **ok**.
- `PRAGMA foreign_key_check`: **0 rows**.
- Accounting enabled: 1.
- Functional currency: SYP.
- Opening journal reference remained valid after Full Restore local-ID remapping.
- Journal entries/lines: 10 / 33.
- Debit/Credit: 10,002,280,100 / 10,002,280,100 SYP.
- Unbalanced journals: 0.
- Invalid lines: 0.
- Duplicate sources: 0.
- GL balance-cache mismatches: 0.
- Inventory quantity/movement/latest mismatches: 0.
- Cash, inventory, AR/customer-credit and AP/supplier-advance controls matched GL exactly.

SQLite `-wal` / `-shm` files were present at normal write-heavy sizes (approximately 4,052 kB / 32 kB) and were not classified as defects. No `.writing`, `.importing`, `.previous` or abandoned temporary backup was present.

Expo Print retained 25 OS-managed cached PDFs totaling approximately 880 kB across the long multi-phase device-validation history. This is bounded cache evidence, not an archive/temp failure; no unbounded growth or OOM was observed.

## Bugs Found

### Missing accounting report/control sheets in Excel

- Severity: release evidence/export completeness; no ledger corruption.
- Reproduction: generate workbook from signed Release APK and inspect sheet names.
- Root cause: only four raw accounting sheets were appended by the Phase 20 exporter.
- Minimal fix: append six read-only report/control sheets derived from existing portable accounting snapshots.
- Regression test: added.
- Targeted Phase 20 suite: 30/30 PASS.
- Full suite: 268/268 PASS.
- Physical Release retest: workbook generated, shared, pulled and parsed; all required sheets and values PASS.
- Commit: `0799521`.

No other application defect was found during this gate.

## Automated Final Gate

- Previous baseline: 267.
- New legitimate regression: 1.
- Final: **268/268 PASS**.
- Full sequential duration: approximately **98.05 s**.
- TypeScript: PASS.
- Strict unused: PASS.
- `git diff --check`: PASS.

The host's global `npm` shim became unavailable during the final rerun because it referenced a missing user-level `npm-cli.js`. The exact project-local TypeScript compiler and direct Node test runner were used instead; no dependency or lockfile was changed.

## Final Build

- Production Android export: PASS.
- Modules/assets: 1,337 / 27.
- Hermes bundle: PASS.
- `:app:assembleRelease`: PASS.
- APK: unsigned by design.
- No production AAB.
- No production signing change.
- No version increment.

## Remaining Risks

- Production signing credentials, production AAB creation, release versioning and store packaging have not started by explicit scope.
- Higher-API physical/emulator validation was unavailable.
- The 50k-journal/100k-line workload is automated evidence; physical Release UI used the preserved representative dataset.
- Cash-adjustment keyboard interaction at 320dp was not destructively enabled because the preserved active cash session was not altered; automated keyboard/layout tests remain green.
- Expo Doctor remains 19/21 due the established non-CNG warning and SDK 57 patch drift. No dependency synchronization was performed.
- The local PRODUCT.md used by the optional UI-audit workflow is stale relative to current Phase 20 terminology; it did not influence product behavior or this gate.

None of these items is a discovered Phase 20 functional, accounting-integrity, upgrade-safety, or release-build defect.

## Release Gate Decision

**READY FOR PRODUCTION PACKAGING**

The Release APK passed safe in-place upgrade, data preservation, startup/resume/restart, accounting UI/reports, PDFs, corrected Excel export, backup, Full Restore, Safe Merge isolation, 320dp, RTL/LTR, themes, memory smoke, logcat, SQLite integrity, accounting reconciliation, high-volume automation, final 268-test gate, production export and assembleRelease.

The next authorized activity may be a separate production-packaging step. This report does not authorize production signing, an AAB, version increment, dependency synchronization, schema v20 or Phase 21.
