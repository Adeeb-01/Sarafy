# Sarafy Release Hardening Report

Date: 2026-09-14

## Status

**READY FOR PRODUCTION PACKAGING**

The two remaining evidence blockers were cleared with a disposable, local-only Release-profile signature and a genuine high-volume `.sarafy` restore through the production UI. Three evidence-gate defects were found and fixed: unbounded per-row full-restore bridge work, replaying the portable-identity migration on every v16 startup, and eagerly rendering all supplier filter chips. The standalone offline Release profile, high-volume Android UI, SQLite health, automated gate, export, and `assembleRelease` now pass. Production signing/versioning and AAB creation remain a separate, explicitly unauthorized packaging phase.

The earlier checkpoint evidence below is retained for traceability. Any earlier `BLOCKED` or `pending` statement is superseded by the final Release Candidate Evidence Gate section at the end of this report.

## Git

- Base: `48fd76a fix: harden transactional device workflows`
- Hardening: `60a21b1 fix: harden release workflows and small-screen layouts`
- Schema remains v16.
- Package remains `com.sarafy.catalog`.
- No dependency, signing, version, schema, prebuild, or generated-Android change was made.

## Automated Tests

- Initial hardening baseline: 184/184 sequential PASS.
- New hardening regressions: 7.
- Final: 191/191 sequential PASS in 39.61 seconds.
- TypeScript: PASS.
- TypeScript with `noUnusedLocals` and `noUnusedParameters`: PASS.
- `git diff --check`: PASS.

The seven new tests cover compact inventory layout, compact supplier/purchase layout, sales-section navigation isolation, compact checkout footer safety, high-volume relational/query health, 20 test-only transaction fault points, and serialized rapid-action uniqueness. Existing tests were retained. One old UI assertion was updated from requiring the removed `stickyActionHeight` implementation to requiring the new non-shrinking keyboard-safe footer contract.

## 320dp

Equivalent 320dp Android validation was executed by setting 840 px width at 420 dpi. The matrix covered Arabic/English, dark/light, and font scales 1.0/1.2. The device was restored to 1080x2280, font scale 1.0, dark mode.

Validated screens included products/product form, sales, checkout and SYP/USD/mixed payment layouts, invoice details, customer return, inventory/adjustment, suppliers, purchases, supplier return, cash sessions, analytics, and settings.

Defects reproduced and hardened:

1. Open-shift bottom-sheet action clipped: corrected Android keyboard/scroll sizing.
2. Customer-return action clipped: added a minimum safe footer and scroll clearance.
3. Inventory filter labels at compact width: horizontal scrolling was verified instead of compressing text.
4. Cash/suspended sales sections falsely selected `sale`: the segment now receives the real active section, so New Sale remains directly navigable.
5. Checkout footer and payment fields overlapped: moved actions into normal layout flow and made Android keyboard layout shrink/scroll.
6. Product-form footer clipped at font 1.2: moved it into a non-shrinking safe layout.
7. Active-session content made Close Shift unreachable: moved the summary into the history list header so the whole screen scrolls.
8. English inventory header compressed at font 1.2: below 360dp it stacks copy and a full-width action.
9. Supplier/purchase headers had the same compact-width problem: applied the same scoped layout.

No horizontal clipping, hidden primary action, broken bottom navigation, or severe numeric wrapping remained in the tested matrix.

## High-Volume Dataset

One deterministic in-memory SQLite dataset used valid foreign keys and relationships:

| Entity | Rows |
|---|---:|
| Products / inventory balances | 5,000 / 5,000 |
| Sales / sale items / payments | 10,000 / 30,000 / 10,000 |
| Customer returns / items | 5,000 / 5,000 |
| Inventory movements | 25,000 |
| Cash sessions | 5,000 |
| Suppliers | 1,000 |
| Purchase receipts / items | 5,000 / 15,000 |
| Supplier returns / items | 5,000 / 5,000 |
| Expenses | 5,000 |

No invalid FK fixture or production schema change was used.

## Query Performance

Seven measured runs after warm-up; values below are final-run medians in milliseconds:

| Path | Median ms |
|---|---:|
| Product list / search | 0.32 / 1.66 |
| Invoice newest / oldest / filter | 0.30 / 0.29 / 3.59 |
| Invoice detail | 0.05 |
| Cash-session history / detail | 9.48 / 0.03 |
| Inventory list / movements | 0.99 / 0.03 |
| Supplier list / search | 1.97 / 0.16 |
| Purchase history / detail | 7.71 / 0.03 |
| Supplier-return history / supplier detail | 7.77 / 0.03 |
| Analytics Today / Week / Month | 0.17 / 1.05 / 4.14 |
| Inventory health audit | 2.25 |
| Backup-shaped payload preparation | 345.62 |
| Restore preview parse/validation | 68.11 |

Query plans used the existing v16 date/product indexes for invoice history, cash-session history, inventory movements, purchase history, and supplier-return history. No evidence justified a schema/index migration.

## Large Lists

Compact Android lists were exercised with the existing device dataset and did not show stale or blank rows. The full synthetic high-volume dataset was not loaded into the Android UI, so physical/emulator UI profiling at the complete row counts remains pending.

## Backup Stress

The synthetic backup-shaped payload included all high-volume tables, remained below the existing 50 MB header limit, and serialized with a 345.62 ms median. No `.writing`, `.importing`, or `.previous` diagnostic artifact was retained. Phase 17.5 had already passed a real `.sarafy` backup/restore on its device test dataset; a real full-volume `.sarafy` archive was not produced in this gate.

## Restore Stress

The high-volume payload preview parsed and validated in 68.11 ms median and preserved expected table counts. SQLite health and cross-table invariants passed. Full physical restore of the high-volume Android dataset remains part of the same large-UI/data prerequisite above.

## Fault Injection

Fault injection exists only in `scripts/release-hardening.test.mjs`; a source scan found no runtime flag, menu, environment branch, or shipping hook.

All 20 injected boundaries rolled back fully:

- Sale: after header, after items, after payments, before inventory, before commit.
- Purchase receipt: after header, after items, before inventory, before commit.
- Customer return: after header, after items, before restock, before commit.
- Supplier return: after header, after items, before movement, before commit.
- Cash-session close: after recomputation, before snapshot, before commit.

Every failure left zero partial headers/items/payments/movements, unchanged inventory, and an open unchanged cash session.

## Concurrency

Rapid serialized duplicate attempts committed each sale, purchase, customer return, supplier return, inventory movement, and cash-session close once. The second attempt was rejected by current-state validation or uniqueness. Existing phase suites also cover re-reading committed stock, over-return prevention, session-close uniqueness, and movement identity. No negative stock or duplicate movement resulted.

## SQLite Health

- `PRAGMA integrity_check`: `ok`.
- `PRAGMA foreign_key_check`: empty.
- No negative tracked balances.
- Every movement satisfies `before + delta = after`.
- Latest movement matches current balance.
- Source movement references remain unique.
- Payment SYP equivalent minus change equals invoice net total.
- Customer cumulative returns do not exceed sold quantity.
- Supplier cumulative returns do not exceed received quantity.
- Historical supplier unit cost invariants remain covered by the Phase 17 suite.

## Storage

All 120 local screenshot/XML diagnostic files were removed before commit. Build/export directories remain generated/ignored artifacts. No temporary database, PDF, APK, or profiling file entered the source commit. Normal Gradle and SQLite cache/WAL behavior was not classified as a defect.

## Barcode

DEV-CLIENT REFERENCE ONLY: scanner open/close was exercised 20 times. The UI returned to Sales on every iteration. Camera-service logs showed camera close, disconnect, and running reference count returning to zero; no frozen preview, native crash, or duplicate commit was observed.

## Process Restart

DEV-CLIENT REFERENCE ONLY: Home -> resume and force-stop -> cold start passed without duplicate initialization, database lock, stale scanner, or lost committed state. Screen-off/on was not automated because lock-screen security was intentionally not bypassed.

## RTL/LTR

The compact matrix covered Arabic RTL and English LTR, including SYP/USD, mixed values, exchange-rate arrows, negative values, and stock deltas. No bidi corruption was observed. The production export included Cairo font assets.

## Accessibility

Compact-screen inspection confirmed reachable primary actions and clear disabled states for the hardened checkout/return/session forms. Regression tests continue to require explicit accessibility states and labels for critical controls. This was a quick pass, not a formal accessibility certification.

## Expo Doctor

`expo-doctor`: 19/21 checks passed.

Known failures:

1. Existing non-CNG warning because native folders coexist with app config fields.
2. SDK 57 patch-version drift.

No `expo install --fix`, patch sync, dependency update, prebuild, or Android regeneration was performed.

## Dependency Drift

Report-only recommended patches:

- `@expo/metro-runtime` 57.0.14 -> expected ~57.0.15
- `expo` 57.0.18 -> expected ~57.0.21
- `expo-dev-client` 57.0.16 -> expected ~57.0.18
- `expo-font` 57.0.2 -> expected ~57.0.3
- `expo-image` 57.0.3 -> expected ~57.0.4
- `expo-image-picker` 57.0.14 -> expected ~57.0.16
- `expo-sharing` 57.0.16 -> expected ~57.0.18

Dependency synchronization remains a separate explicit task.

## Release Manifest

- Package/application ID: `com.sarafy.catalog`.
- minSdk 24, compileSdk 36, targetSdk 36.
- `allowBackup=false`.
- No `RECORD_AUDIO` permission.
- No `debuggable=true` or cleartext-traffic override.
- Expo Updates is disabled.
- Exported app component: MainActivity, required for launcher/deep links.
- AndroidX ProfileInstallReceiver is exported only behind `android.permission.DUMP`.
- No Expo dev-launcher/dev-menu activity, provider, service, or receiver was present in the merged release manifest.
- The Expo-generated INTERNET/ACCESS_NETWORK_STATE permissions remain in the manifest, but static runtime tests reject `fetch`, Axios, XMLHttpRequest, WebSocket, and HTTP URLs in shipping TypeScript; no runtime network behavior was introduced.

## APK Metadata

- Path: `C:\Users\Lenovo\Documents\Sarafy\android\app\build\outputs\apk\release\app-release-unsigned.apk`
- Size: 128,983,271 bytes.
- Package: `com.sarafy.catalog`.
- versionCode: 1.
- versionName: 1.1.0.
- minSdk: 24.
- targetSdk: 36.
- compileSdk: 36.
- `apksigner verify`: FAIL, missing `META-INF/MANIFEST.MF`; artifact is unsigned.

## Release APK Physical Profiling

**BLOCKED — unsigned release artifact; production signing intentionally unchanged.**

The APK was not installed, the existing development/user-data installation was not removed or overwritten, and no ad-hoc signing was introduced.

## Dev-Client Reference Measurements

These values are not release-performance evidence:

- Before scanner x20: total PSS 476,709 KB; RSS 608,282 KB.
- Immediately after scanner x20: PSS 536,688 KB; RSS 678,118 KB.
- After 20 seconds: PSS 524,469 KB; RSS 669,982 KB.
- After force-stop/cold restart: PSS 451,927 KB; RSS 586,294 KB.
- Camera logs confirmed resource close. There was no FATAL, ANR, OOM, SQLiteException, or Hermes failure.
- Scripted scanner transitions reported high dev-client frame latency (137/161 janky frames); this includes dev tooling, camera startup, and forced 700 ms transitions and is not comparable to release.
- `gfxinfo` reported zero captured frames for the subsequent Analytics scroll, so it was not usable as performance evidence.

## Production Export

PASS.

- Entry: `node_modules/expo/AppEntry.js`.
- Modules: 1,323.
- Assets: 27.
- Hermes bundle: 5.2 MB.
- Output: `dist-release-hardening`.

## Build

`:app:assembleRelease`: PASS (`BUILD SUCCESSFUL` in 2m45s; 697 tasks, 53 executed, 644 up-to-date). No AAB was created. Gradle used the process-local Android Studio JBR and the existing release configuration.

## Bugs Found

Nine compact-layout/navigation defects were reproduced and fixed as listed under 320dp. No accounting, inventory, database, backup, or release-manifest regression was found. No schema or dependency change was needed.

## Automated Final Gate

- Tests: 191/191 PASS.
- TypeScript: PASS.
- Strict unused: PASS.
- Diff check: PASS.
- Production Expo export: PASS.
- assembleRelease: PASS.
- APK signature: unsigned.

## Remaining Risks

- Physical non-dev release memory/frame profiling requires a safely signed release candidate.
- Full synthetic high-volume data was not exercised through Android UI lists.
- A real high-volume `.sarafy` backup/restore was not run on-device in this gate; only the normal Phase 17.5 archive and the synthetic payload path were validated.
- Screen lock/unlock resume was not automated because device security was not bypassed.
- Production signing and version increment have not started by design.
- Expo patch synchronization remains a separate reviewed change.

## Release Gate Decision

This checkpoint decision was superseded on 2026-09-14 by the completed evidence gate below.

---

# Release Candidate Evidence Gate — 2026-09-14

## Status

**READY FOR PRODUCTION PACKAGING**

## Git

- Base hardening commit: `60a21b1 fix: harden release workflows and small-screen layouts`.
- Evidence-gate commit: `16e2e56 perf: harden high-volume restore and startup`.
- Schema remains v16.
- Package remains `com.sarafy.catalog`.
- No dependency, schema, production-signing, version, AAB, prebuild, or generated-Android change was made.

## Automated Tests

- Original release-hardening baseline: 184/184.
- Prior compact/stress regressions: 7.
- Evidence-gate regressions: 3.
- Final: **194/194 sequential PASS** in 38.05 seconds.
- TypeScript: PASS.
- Strict `noUnusedLocals` / `noUnusedParameters`: PASS.
- `git diff --check`: PASS.

The new tests require batched full restore with one UUID-map load per table, prevent the completed portable-identity migration from replaying at v8+, and require a virtualized high-volume supplier filter strip. Fault injection remains test-only; no runtime hook exists in `src`.

## Release Candidate Signature

- A disposable RSA-2048 key was generated locally for this evidence run only, with 30-day validity.
- Keystore, aligned APK, signed APK, and signature sidecar remain ignored under `.expo-release-profile/signing/`.
- No password was persisted or printed.
- Signed profile APK: `.expo-release-profile/signing/app-release-profile-14480403104720.apk`.
- Size: 129,110,614 bytes.
- APK Signature Scheme v2: verified.
- APK Signature Scheme v3: verified.
- Certificate SHA-256: `3df0a66d92028ea51b060bc79325eb84b43807b3aee0e0f71258c0b6c82bb181`.
- This is not production signing and must not be promoted as a production credential.

## Release APK Physical Profiling

The signed Release-profile APK was installed only on the dedicated API 36 emulator. Wi-Fi and mobile data were disabled. It launched standalone without Metro, a development menu, a remote JS bundle, or a white-screen loop.

Five cold starts against the restored high-volume database:

| Run | Android TotalTime | Usable UI observation |
|---:|---:|---:|
| 1 | 5,676 ms | 9,302 ms |
| 2 | 4,295 ms | 7,926 ms |
| 3 | 4,895 ms | 7,858 ms |
| 4 | 4,681 ms | 7,685 ms |
| 5 | 5,424 ms | 8,584 ms |

Median Android time was 4,895 ms; median usable-UI observation was 7,926 ms. The UI observation includes `uiautomator` dump overhead. All five starts reached usable offline UI with no migration loop or duplicate initialization.

## High-Volume SARAFY Archive

A genuine application-compatible backup archive was generated with the same v8 container/serialization semantics:

- File: `.expo-release-profile/sarafy-release-high-volume.sarafy`.
- Size: 51,586,670 bytes.
- SHA-256: `f0a189fca17fb2d43197caaff4e2b91f0d0e04c5a44adba6b36f9dbbd966bb09`.
- `backupVersion=8`, `schemaVersion=16`, `applicationId=com.sarafy.catalog`.
- No product images or Base64 inflation.

| Entity | Rows |
|---|---:|
| Products / inventory balances | 5,000 / 5,000 |
| Sales / items / payments | 10,000 / 30,000 / 10,000 |
| Customer returns / items | 5,000 / 5,000 |
| Inventory movements | 25,000 |
| Cash sessions | 5,000 |
| Suppliers | 1,000 |
| Purchase receipts / items | 5,000 / 15,000 |
| Supplier returns / items | 5,000 / 5,000 |
| Expenses / expense categories | 5,000 / 7 |
| Exchange-rate history | 1 |

All portable UUID references, payment equations, stock arithmetic, customer-return bounds, supplier-return bounds, and historical snapshots were valid before archive creation.

## High-Volume Restore

- Production file picker and Full Restore UI were used; the SQLite database was not injected.
- Final preview: approximately 110 seconds; 46,002 new rows, 7 unchanged settings, 0 conflicts, 0 rejected rows.
- Final restore: completed in approximately 80 seconds and returned to Settings.
- A second fixed-build run completed in the same approximately 81-second range.
- Force-stop/relaunch retained the restored dataset.
- The Products screen reported 5,000 products; Invoices reported 10,000 invoices; Inventory reported 5,000 tracked products; supplier/session/purchase/return representative data matched the archive.
- Inventory Health Audit: PASS.
- Startup's `integrity_check` / `foreign_key_check` completed without failure, and the full-restore transaction's FK check returned empty before commit.
- No `.writing` or `.importing` file was visible in accessible storage; the writer also re-read and verified both temporary and final archives before reporting completion.

## Bugs Found

### 1. Full Restore performed unbounded per-row bridge work

- Reproduction: preview the 51.6 MB archive and execute Full Restore on the first Release profile.
- Observed: the restore remained busy beyond 44 minutes, with sustained CPU and high memory. Force-stop/relaunch showed the original empty DB, proving rollback and no partial state.
- Root cause: hundreds of thousands of per-row UUID existence/parent queries and inserts crossed the async SQLite bridge.
- Fix: `insertFullRestorePayload` batches multi-row inserts to at most 900 bind values, loads each UUID-to-local-ID map once, and retains payment, return, inventory, and FK invariants in the same exclusive transaction. Safe Merge remains unchanged.
- Regression: batched statements and one-time UUID map loads are required by the release-hardening suite.
- Release retest: PASS at approximately 80–81 seconds.

### 2. Portable identity migration replayed on every startup

- Reproduction: cold-start a v16 database after restoring the high-volume archive.
- Observed: one pre-fix restart spent approximately 2m52s on the splash screen.
- Root cause: the legacy portable-identity migration scanned and updated all products, categories, sales, sale items, and expenses even when `user_version` was already 16.
- Fix: return immediately when `user_version >= 8`; legacy databases below v8 retain the original migration path.
- Regression: the version guard must precede the migration transaction.
- Release retest: five cold starts passed; median usable observation 7.93 seconds.

### 3. Purchase history eagerly rendered 1,001 supplier filters

- Reproduction: open Purchase/Supplier Return history with 1,000 suppliers.
- Root cause: a horizontal `ScrollView` mapped every supplier chip eagerly before the vertical history list.
- Fix: replace only that strip with a horizontal `FlatList` using stable UUID keys and bounded render batches.
- Regression: the supplier filter strip must remain virtualized.
- Release retest: PASS; only six supplier chips were mounted/visible instead of 1,001, while selection/filter semantics remained unchanged.

## High-Volume Android Lists

- Products: 5,000 count, fast scrolling, P2500/P4999 search, barcode field presence, and stable distinct rows passed.
- Invoices: 10,000 count, fast scrolling, I5000 search reduced to one invoice, and a three-item historical invoice detail hydrated correctly.
- Cash sessions: 5,000-row newest/oldest controls remained available; fast scrolling and complete SYP/USD detail passed.
- Inventory: 5,000 tracked rows, health audit, search/filter controls, and representative opening/purchase/sale/return/purchase-return movements passed.
- Suppliers: 1,000 rows, S500 search, detail summary, and receipt history passed.
- Purchases: 5,000 rows, newest/oldest controls, scrolling, and three-item receipt detail passed.
- Supplier returns: 5,000 rows, filters, scrolling, historical-cost detail, and original-receipt linkage passed.
- Analytics: Today/Week empty states and Month high-volume state loaded without NaN, Infinity, broken chart, or crash.

No blank recycled cells, wrong detail identity, duplicate rendering, native crash, or ANR was observed.

## High-Volume Memory

Release measurements are emulator references, not device-specific limits:

| Stage | Total PSS | Total RSS |
|---|---:|---:|
| Fresh high-volume launch | 164,774 KB | 311,176 KB |
| After Products scrolling | 186,391 KB | 335,208 KB |
| After Analytics | 182,818 KB | 331,472 KB |
| Before scanner x20 | 191,655 KB | 343,744 KB |
| Immediately after scanner x20 | 205,608 KB | 358,096 KB |
| Scanner idle 20 seconds | 202,392 KB | 354,880 KB |
| During backup construction | 338,948 KB | 486,668 KB |
| Immediately after backup | 550,768 KB | 698,756 KB |
| Backup idle 30 seconds | 497,391 KB | 645,380 KB |
| Force-stop/cold restart | 178,669 KB | 327,528 KB |

Scanner growth was bounded and began dropping at idle. Backup caused the expected temporary allocation/cache peak for a 51.6 MB JSON/archive workload; it plateaued and a normal restart returned below 180 MB PSS. No OOM or monotonic cross-restart growth occurred.

## High-Volume Jank

`gfxinfo` on the dedicated API 36 emulator (scripted swipes) reported:

| Screen | Frames | Janky | p50 | p90 | p99 |
|---|---:|---:|---:|---:|---:|
| Products | 468 | 27.78% | 36 ms | 53 ms | 85 ms |
| Invoices | 422 | 25.59% | 36 ms | 48 ms | 117 ms |
| Cash sessions | 393 | 23.41% | 34 ms | 48 ms | 150 ms |
| Purchases, before supplier-strip fix | 342 | 53.80% | 48 ms | 69 ms | 105 ms |
| Purchases, after supplier-strip fix | 362 | 43.09% | 42 ms | 69 ms | 129 ms |
| Supplier returns | 361 | 43.21% | 44 ms | 65 ms | 109 ms |
| Analytics | 343 | 46.06% | 46 ms | 77 ms | 133 ms |

The emulator is frame-limited and these scripted values are warnings, not a production-device FPS claim. The evidence showed no frozen scrolling, ANR-like pause, or persistent interaction failure. The one row-count-dependent UI defect was fixed by reducing live supplier filter nodes from 1,001 to six. Production-device profiling remains appropriate after the real production key exists, but no critical Release regression was demonstrated.

## Release Barcode

- Release camera permission flow completed.
- Scanner opened/closed 20 times on the emulator camera path.
- No frozen preview, crash, or stale permission state.
- PSS changed from 191,655 KB to 205,608 KB, then dropped to 202,392 KB after idle.
- Camera service showed no retained client after exit.
- Known/unknown real-barcode optical scanning remains covered by the completed Phase 17.5 physical-device pass; the emulator camera was used here for Release lifecycle evidence.

## Release Backup

The Release app itself created and internally verified a Full Backup from the restored dataset. The operation completed in roughly 70 seconds, left the process responsive, and no accessible `.writing` residue remained. Android's non-debuggable application sandbox and lack of a share target prevented external shell inspection of the app-private manual file's exact byte size; no bypass of `allowBackup=false` was attempted. The independently preserved source archive remains exactly 51,586,670 bytes and was successfully previewed/restored twice through the same production reader.

## Release Logcat

- FATAL EXCEPTION: none.
- ANR for `com.sarafy.catalog`: none.
- OutOfMemoryError: none.
- SQLiteException: none.
- Hermes fatal/error: none.
- Camera/print native failure: none.
- Benign warnings: existing React Native `SafeAreaView` and `InteractionManager` deprecation messages.

## Release Background/Restart

- Home to hot resume: Android TotalTime 226 ms; no crash or DB lock.
- Force-stop to cold restart with high-volume DB: usable UI returned; no duplicate initialization or stale data.
- Five cold-start matrix passed as recorded above.
- Screen-lock security was not bypassed.
- A later optional long-background recheck could not be added because the dedicated emulator was no longer connected; it does not replace or invalidate the completed hot-resume, force-stop, and cold-start evidence above.

## Query Performance

Final seven-run in-memory medians (milliseconds): product list/search 0.21/1.32; invoice newest/oldest/filter 0.22/0.23/2.41; invoice detail 0.03; cash history/detail 6.35/0.02; inventory list/movements 0.63/0.02; supplier list/search 1.27/0.10; purchase history/detail 5.99/0.02; supplier-return history/detail 6.08/0.03; Analytics Today/Week/Month 0.13/0.80/3.08; health audit 1.34; backup-shaped preparation 484.14; restore preview 70.90. Existing v16 indexes were used; no schema/index migration was introduced.

## SQLite Health

- `integrity_check=ok`.
- `foreign_key_check`: empty.
- Inventory Health Audit: PASS.
- No orphan rows, negative tracked balances, movement arithmetic mismatch, latest-movement mismatch, duplicate movement source, payment settlement mismatch, customer over-return, supplier over-return, or historical supplier-cost mismatch.
- All 20 test-only fault-injection boundaries roll back fully.
- Rapid serialized duplicate attempts remain single-commit.

## Release Manifest

- Package: `com.sarafy.catalog`.
- versionCode 1; versionName 1.1.0.
- minSdk 24; targetSdk 36; compileSdk 36.
- `allowBackup=false`; Expo Updates disabled.
- No `RECORD_AUDIO`, `debuggable=true`, or cleartext override.
- No Expo dev-launcher/dev-menu exported component in the merged Release manifest.
- Expected exported MainActivity and permission-protected AndroidX ProfileInstallReceiver only.
- CAMERA is present. Expo/React Native generated INTERNET and ACCESS_NETWORK_STATE permissions remain, while source/runtime network-use tests pass and the signed APK completed the full gate offline.

## APK Metadata

- Fresh unsigned output: `android/app/build/outputs/apk/release/app-release-unsigned.apk`.
- Unsigned size: 129,000,307 bytes.
- Local signed profile copy: `.expo-release-profile/signing/app-release-profile-14480403104720.apk`.
- Signed size: 129,110,614 bytes.
- Package `com.sarafy.catalog`; versionCode 1; versionName 1.1.0; minSdk 24; targetSdk 36; compileSdk 36.
- No AAB was created.

## Expo Doctor / Dependency Drift

- Existing result remains 19/21.
- Known Doctor causes remain the non-CNG warning and SDK 57 patch drift.
- A fresh read-only `expo install --check` on 2026-09-14 reports 14 patch updates: `@expo/metro-runtime` 57.0.14→57.0.15, `expo` 57.0.18→57.0.22, `expo-camera` 57.0.4→57.0.5, `expo-dev-client` 57.0.16→57.0.19, `expo-document-picker` 57.0.1→57.0.2, `expo-file-system` 57.0.6→57.0.7, `expo-font` 57.0.2→57.0.4, `expo-haptics` 57.0.2→57.0.3, `expo-image` 57.0.3→57.0.5, `expo-image-picker` 57.0.14→57.0.17, `expo-print` 57.0.1→57.0.2, `expo-sharing` 57.0.16→57.0.19, `expo-splash-screen` 57.0.8→57.0.9, and `expo-sqlite` 57.0.2→57.0.3.
- No dependency sync or `expo install --fix` was performed.

## Automated Final Gate

- Tests: **194/194 PASS**.
- TypeScript: PASS.
- Strict unused: PASS.
- Diff check: PASS.
- Production export: PASS; 1,324 modules, 27 assets, 5.2 MB Hermes bundle, `dist-release-candidate`.
- `:app:assembleRelease`: PASS; BUILD SUCCESSFUL in 1m21s, 697 tasks (44 executed, 653 up-to-date).
- Signed local Release profile: v2/v3 verified and standalone offline PASS.

## Remaining Risks

- The disposable profile key is not production signing; production key custody, version increment, and AAB generation have not started.
- Emulator `gfxinfo` shows frame pressure on complex lists/charts; no ANR or functional stall occurred, but final production-signed physical-device performance sampling is still recommended during packaging QA.
- Exact byte size of the app-private, app-generated manual backup was not externally observable without weakening the non-debuggable sandbox; the operation and internal temporary/final verification passed.
- Real optical barcode recognition is inherited from the completed Phase 17.5 physical-device evidence; this Release gate exercised the camera lifecycle on the emulator.
- Expo patch synchronization remains a separate reviewed change.

## Final Decision

The two release-hardening evidence blockers are cleared. The standalone signed Release profile worked offline, restored and exercised the genuine high-volume dataset, passed health/invariant checks, completed backup, showed bounded memory behavior without critical logcat events, and passed the final automated/export/build gates. Sarafy is ready for the separately authorized Production Packaging & Signing phase.
