# Sarafy Release Hardening & Final Audit

Audit date: 2026-08-29 (Asia/Damascus)  
Target: Android release, package `com.sarafy.catalog`  
Decision scope: no production AAB was created.

## Versions

Status: **PASS**

| Item | Baseline | Final |
|---|---:|---:|
| Node.js | 24.13.1 | 24.13.1 |
| npm CLI | 11.8.0 | 11.8.0 |
| Expo | 57.0.17 | 57.0.18 |
| React Native | 0.86.3 | 0.86.3 |
| React | 19.2.3 | 19.2.3 |
| Hermes compiler | 250829098.0.17 | 250829098.0.17 |
| Hermes enabled | yes | yes |
| Lockfile packages | 555 dependencies plus the root package | unchanged |
| Test count | 45 | 45 |

The system `npm` PowerShell shim resolves an invalid roaming-prefix CLI path. Audit commands therefore invoked the same installed npm 11.8.0 CLI directly from the Node installation. This is a workstation issue, not an application issue.

Baseline typecheck passed. Baseline tests passed 45/45. Baseline `expo-doctor@latest` passed 19/21 and identified two patch mismatches plus the native/app-config synchronization warning. Expo and expo-font were updated only to compatible SDK 57 patch versions. Final doctor passes 20/21; the remaining warning is documented under Android Manifest.

## Cleanup

Status: **PASS**

- Removed `src/utils/direction.ts`. The complete runtime import graph, repository search, and strict TypeScript unused checks proved all three exports and the file itself unused.
- No component, config/plugin entry, fixture, style, wrapper, or helper was removed on heuristic evidence alone.
- Strict `tsc --noUnusedLocals --noUnusedParameters` reported no remaining unused TypeScript declarations.
- Runtime has no `console.log`, `console.debug`, or `console.info`. Limited diagnostic `console.error` calls are guarded by `__DEV__`.

## Dependency Audit

Status: **WARN**

- `expo-blur` and `expo-linear-gradient` are absent from source, App.tsx, app config, Android native files, scripts, package.json, lockfile, and installed dependency tree. They were removed with normal npm lockfile reconciliation.
- Final direct dependencies: 27 runtime and 2 development dependencies.
- `npm audit`: 12 moderate, 0 high, 0 critical.
- `npm audit --omit=dev`: the same 12 moderate findings because Expo build/config tooling is carried in the production dependency graph.
- Classification: all findings trace to Expo CLI/config-plugin/Xcode tooling and the transitive `uuid <11.1.1` advisory. The vulnerable UUID buffer APIs are not used by the Android runtime. No demonstrated Sarafy Android runtime vulnerability was found.
- No `npm audit fix --force`, major downgrade/upgrade, or broad dependency cleanup was performed. npm's proposed “fix” is an incompatible Expo major downgrade and was rejected.

Warning: **LOW**; impact: developer/build tooling exposure only; required before release: **no**; proposed fix: adopt the matching Expo patch when Expo publishes a compatible dependency-graph fix, then rerun both audits.

## Security

Status: **WARN**

- Secret scan found no API key, token, OAuth secret, release signing password, private key text, or database credential in runtime/config/scripts.
- `android/app/debug.keystore` is tracked and contains the standard Android debug credential only. Release Gradle configuration does not fall back to it; the generated APK is intentionally unsigned.
- `.gitignore` and `.easignore` exclude local env files, private key/keystore formats, `.sarafy`, Excel exports, temporary suffixes, APK/AAB, node_modules, `.expo`, Gradle/CMake/build outputs, and test export formats while retaining source and native build inputs.
- SQL values use parameter binding. Dynamic table/index identifiers exist only in fixed internal `as const` whitelists during migration/import analysis; no user-controlled identifier is interpolated.
- Imported filenames are never used as destination paths. Product filenames are generated from application UUIDs/nonces, and archive paths must match `media/products/[A-Za-z0-9._-]+` with no separators beyond the fixed prefix.
- `.sarafy` validates magic, bounded header length, exact archive size, unique safe paths, per-entry size, data checksum, and image checksum before permanent database changes. Extracted images are written to `.importing`, content-signature checked, then atomically moved. Replacement rollback uses `.previous`.
- Image imports now validate the first 16 bytes for JPEG, PNG, GIF, or WebP and generate a safe extension from content. No full image buffer is retained in JS.
- The archive is a custom uncompressed container, not ZIP. Zip bombs, nested archives, and decompression expansion therefore do not apply. Header is capped at 50 MiB, picked files at 100 MiB, and each image at 15 MiB.
- Checksums are the existing 32-bit FNV-1a integrity mechanism, not a cryptographic authenticity mechanism. The algorithm and `.sarafy` format were not changed.
- Backup, import/restore, sale, product, expense, and share actions have UI/in-process double-action guards. Import has a module-level single-flight guard and uses an exclusive SQLite transaction.

Warning: **MEDIUM**; impact: `.sarafy` can be deliberately modified by an attacker capable of recomputing non-cryptographic checksums; required before release: **no** for the current local-file trust model; proposed fix: authenticated encryption in a future versioned backup format, which is intentionally outside Phase 7.

## Network

Status: **PASS**

- Runtime network calls: **NO**.
- Automatic network services: **NO**.
- No runtime `fetch`, axios, XMLHttpRequest, WebSocket, remote image/font URL, telemetry SDK, crash-reporting service, Firebase, server, API, cloud sync, or authentication exists.
- Cairo fonts are bundled locally. Expo Updates is not a direct dependency and merged release metadata has `expo.modules.updates.ENABLED=false`.
- `INTERNET` and `ACCESS_NETWORK_STATE` remain framework/library permissions. Their presence alone does not create network activity and they were not removed blindly.
- Dev-client libraries compile disabled release stubs from `disableInRelease`; the merged release manifest contains no Dev Launcher/Menu activity or provider and build config has `DEBUG=false`.

## SQLite

Status: **PASS**

- Database name remains `sarafy.db`; schema user version remains 8. No schema, invoice snapshot, calculation, UUID, or data-format change was made.
- `foreign_keys=ON`, `journal_mode=WAL`, and exclusive transactions for import are present. The current busy behavior and journal mode were not changed.
- Indexes cover product name/barcode/active, sales and expense dates, sale-item foreign key, and every portable UUID. No speculative index was added.
- Synthetic database after sale-shaped inserts: `PRAGMA integrity_check = ok`; `PRAGMA foreign_key_check = 0 rows`.
- Failure safety is structural: sale/import writes are transactional; a thrown insert or foreign-key check rolls back. A real UI/native fault injection still requires a device test.

## Disk Growth

Status: **PASS** for synthetic SQLite; **WARN** for device storage

Synthetic SQLite 3.50.4 dataset:

| Dataset | Products | Sales | Sale items | Expenses | SQLite/WAL observation |
|---|---:|---:|---:|---:|---|
| Initial | 10,000 | 5,000 | 25,000 | 1,000 | DB 8.08 MiB; WAL high-water 8.26 MiB; SHM 32 KiB |
| +20% | 12,000 | 6,000 | 30,000 | 1,200 | DB 9.67 MiB after passive test checkpoint |

Growth was approximately linear. WAL reused its high-water allocation rather than growing with the second batch; there was no evidence for an automatic startup VACUUM/checkpoint, so none was added. Physical-device WAL behavior remains to be measured.

## File Storage

Status: **WARN**

- Stable paths remain `sarafy.db`, `DocumentDirectory/sarafy/media/products`, and `DocumentDirectory/sarafy/backups`.
- No SQLite field stores a Cache URI as a permanent product reference. New product images are copied into the persistent media directory before the DB update.
- Backup `.writing` files and image `.tmp`/`.importing` files are cleaned on startup. `.previous` is restored if the final image is missing or removed if replacement completed.
- Excel import picker files are deleted in `finally`. PDF and Excel share outputs live only in OS cache and are not persistent references; OS cache may retain them until eviction.
- Free-space checks use Expo 57 `Paths.availableDiskSpace`, measured required bytes, and a margin before backup writes, archive image extraction, image copy, and Excel export. Final backup publication is atomic and failed temporary/final files are removed.

Warning: **LOW**; impact: repeated PDF/Excel sharing may temporarily grow OS-managed cache; required before release: **no**; proposed fix: confirm cache eviction behavior during force-close/low-storage device testing before adding any post-share deletion that could race receiving apps.

## Backups

Status: **WARN**

- Manual backups are never rotated automatically. Pre-import rotation filters only `pre-import-*.sarafy` and retains the newest five.
- Writes use unique names, `.writing`, read-back verification, atomic move, final read-back verification, and share only after a non-empty readability check.
- Current SARAFY2, its legacy header form, older portable payload versions up to v4, and legacy JSON migration paths remain accepted. Newer backup/schema versions are rejected.
- Import preview precedes execution; execution creates a verified pre-import backup before the exclusive transaction. Checksum mismatch causes rejection before DB modification.
- Backup JSON is materialized in JS memory; images are checksummed and written in 256 KiB chunks. The synthetic large payload was 10,611,948 bytes and stringification took roughly 37–49 ms on the audit host. Picked files are capped at 100 MiB and headers at 50 MiB, but low-memory Android limits require a release-device test.
- A full fresh-app export/import/export semantic round-trip and force-close during write were not run because no device/emulator was connected.

### Backup Confidentiality

`.sarafy encrypted: NO`

The file contains plaintext JSON and raw product-image bytes. It can contain products, sales, expenses, settings, and images. This is a known privacy risk. Encryption would require a versioned format migration and was not introduced in Phase 7.

Warning: **MEDIUM**; impact: anyone receiving the file can read business data; required before release: **no** if the UI/documentation clearly treats backups as sensitive user-controlled files; proposed fix: evaluate authenticated `.sarafy v3+` encryption as a separate migration.

## Images

Status: **WARN**

- Add/replace code writes and validates the new image before DB update; failed DB writes delete the new image; old images are deleted only after successful update and only when unreferenced.
- Missing files render the existing placeholder. Lists use URI/native image loading, not Base64/ArrayBuffer state.
- Health check reports missing, orphan, temporary, and bytes-used separately. Deletion of orphans occurs only in the existing explicit full-restore cleanup path, not in the health check.
- Archive and picker image content now accept only JPEG/PNG/GIF/WebP signatures. Product filenames remain generated and safe.
- 5/10/20 MiB physical image tests were not run. Static bounds accept supported images up to 15 MiB and reject a 20 MiB input with `IMAGE_TOO_LARGE`. No compression dependency was added.

Warning: **MEDIUM**; impact: real decoder RAM/scroll performance for 10–15 MiB images is unmeasured; required before release: **yes, as part of the physical-device gate**; proposed fix: run the specified image-heavy flows first, and discuss compression only if a measured crash/storage problem occurs.

## Excel

Status: **WARN**

- Format and business fields are unchanged.
- Picked file size is capped at 25 MiB; workbook structure, numeric/date fields, UUID generation, and stored image paths are validated/normalized before import preview.
- A 10,000-row workbook round-trip produced 2,737,482 bytes and completed in approximately 0.54–0.80 s on the audit host.
- SheetJS reads/writes Base64 and materializes the workbook in JS. References are function-local and the copied input is deleted in `finally`, but peak Release/Hermes RAM and UI pause were not measured.

Warning: **MEDIUM**; impact: a near-25 MiB workbook may cause a long pause or memory pressure; required before release: **yes, as part of the physical-device gate**; proposed fix: measure the practical limit on a low-memory Android device before changing format or parser.

## RAM

Status: **NOT RUN**

No authorized ADB device/emulator was connected. Therefore release APK PSS/Java/Native/Graphics baselines and all 10-cycle retention flows are unavailable. Static review found cleanup for Keyboard listeners, timers, and snackbar timeout; no intervals, AppState subscriptions, WebSockets, Base64 image state, or large image closures exist. A host-only 5,000-sale/25,000-item grouping used about 2.8 MiB additional JS heap and 4.9 ms, but this is not an Android/Hermes RAM substitute.

Warning: **MEDIUM**; impact: native/JS leaks and image-decoder peaks cannot be ruled out; required before release: **yes**; proposed fix: run `scripts/android-release-audit.ps1` at each requested screen/flow and compare stabilized PSS after ten cycles.

## Startup

Status: **NOT RUN**

No device was connected, so five cold starts, median TotalTime/WaitTime, and warm start were not measured. Static startup order is fonts + SQLite/migrations + snapshot load; stale-backup cleanup is deferred until after interactions and no artificial splash delay exists.

Warning: **MEDIUM**; impact: real release startup latency is unknown; required before release: **yes**; proposed fix: collect five cold and warm measurements on the target device.

## Large Data

Status: **PASS** on host simulation; device confirmation pending

- Initial synthetic insert time: ~559 ms on desktop SQLite.
- Product list query, 10,000 rows: median ~36 ms.
- Sales query, 5,000 rows: median ~18 ms.
- Sale-item query, 25,000 rows: median ~109 ms.
- Invoice-detail query, 100 rows: median ~0.39 ms.
- Indexed barcode lookup: median ~0.02 ms.
- Name prefix query: median ~1.53 ms.
- Product JS search over 10,000 records: median ~1.9–3.0 ms across audit runs.
- Analytics 5,000 invoices/25,000 items: build ~10–18 ms, trend ~64–73 ms, combined period computation ~73–88 ms on the host. `useMemo` limits recomputation to sales/expenses/period changes.
- Lists are virtualized with bounded windows/batches and fixed item layouts where applicable. Device scrolling/jank remains NOT RUN.

## Android Manifest

Status: **WARN**

Merged release manifest and built APK were inspected, not only the source manifest.

- Package/applicationId: `com.sarafy.catalog`.
- Version: 1.1.0 (versionCode 1 in local native build).
- SDK: min 24, target/compile 36.
- `allowBackup=false`; no dataExtractionRules/fullBackupContent override can re-enable cloud backup. Manual `.sarafy` backup is unaffected.
- `debuggable` absent, therefore false for release. `usesCleartextTraffic` absent, therefore false by platform default for target 36.
- Launcher MainActivity is exported. Crop/image-picker activities are not exported. FileSystem, Sharing, ImagePicker, cropper, and AndroidX providers are not exported.
- AndroidX ProfileInstaller receiver is exported but protected by the signature/system `android.permission.DUMP` permission.
- Permissions: INTERNET, ACCESS_NETWORK_STATE, VIBRATE, CAMERA, READ/WRITE_EXTERNAL_STORAGE limited to maxSdk 32, and the AndroidX dynamic-receiver protection permission.
- No RECORD_AUDIO permission survived merge. Expo Updates is disabled.

Warning: **MEDIUM**; impact: `expo-image-picker` contributes CAMERA and Android infers a required camera feature even though Sarafy only calls the image library; this may affect store disclosure and camera-less device compatibility; required before release: **no**, but explicit owner decision is recommended; proposed fix: after functional verification, discuss blocking CAMERA or declaring the feature optional. This permission was not changed silently because permission changes are a stated stop condition.

The final doctor warning says app.json native fields are not auto-synchronized when `android/` is committed. Manual comparison confirmed package, portrait orientation, icons, theme/background, splash, blocked microphone permission, plugins/providers, and `allowBackup=false` in native/merged output.

Warning: **LOW**; impact: future app.json edits may not reach native Android automatically; required before release: **no** for the audited commit; proposed fix: keep native/app.json parity in the release checklist or adopt one native-generation strategy in a future maintenance phase.

## Android Build and Size

Status: **WARN**

- `assembleRelease`: **PASS**, 757 tasks, final run 1m51s after cache warm-up.
- Local release APK: 104,276,470 bytes (99.45 MiB), unsigned as intended because release credentials were not embedded.
- Hermes JS bundle: 3,812,408 bytes (3.64 MiB), 1,294 modules, 27 bundled assets.
- APK compressed contributors: native libraries ~82.44 MiB, DEX ~8.56 MiB, JS/assets ~3.64 MiB, resources ~2.68 MiB. The universal APK contains four ABIs and is not representative of per-device delivery.
- Existing AAB baseline: 67,850,167 bytes (64.71 MiB), dated 2026-08-25. It was recorded only; no new Production AAB was created.
- `lintVitalRelease`: PASS, “No issues found.”
- Full `lintRelease`: did not complete because Android Lint crashed internally while analyzing `react-native-worklets` with `Cannot find a KaModule for the VirtualFile`. No Sarafy lint/security finding preceded the tooling crash; no suppression was added.
- EAS Preview was not started because the execution security layer rejected source upload to EAS. The authenticated EAS session existed, but no remote build or source egress occurred.

Warning: **MEDIUM**; impact: full lint coverage and EAS Preview artifact are missing; required before release: **yes**; proposed fix: rerun full lint in a matching Android Studio/command-line-tools environment or after the compatible worklets/lint patch, then run the requested EAS Preview with explicit source-upload authorization.

## Physical Device Tests

Status: **NOT RUN**

ADB was installed but reported zero connected devices. The following remain unverified: release install/signing, eight-point meminfo baseline, ten-cycle leak flows, cold/warm startup, gfxinfo/jank, 5/10/20 MiB images, PDF 1/20/100 items with Arabic visual inspection, force-close during sensitive writes, low storage, low memory, rapid actions, lifecycle/process death, SDK 56 in-place upgrade, and 100% user-data survival.

`scripts/android-release-audit.ps1` was added. It collects package version, optional startup timing, meminfo, gfxinfo, and package info; it never clears app data, uninstalls, writes device files, or changes settings.

## Remaining Risks

| Severity | Risk | Release requirement |
|---|---|---|
| HIGH | None demonstrated by static/host/local release build audit. | — |
| MEDIUM | Physical-device RAM, image, startup, jank, force-close, low-storage, lifecycle, upgrade, and data-survival tests not run. | Required |
| MEDIUM | Full lint crashes inside react-native-worklets tooling; only lintVital completed. | Required |
| MEDIUM | EAS Preview not created because source-upload execution was denied. | Required |
| MEDIUM | `.sarafy` is plaintext and uses integrity checks, not authenticated encryption. | Accepted only as a documented local-backup privacy risk |
| MEDIUM | Near-limit Excel/backup peak memory is not measured on Hermes. | Physical-device gate |
| MEDIUM | CAMERA permission is merged despite library-only selection flow. | Owner decision recommended |
| LOW | Expo doctor native/app-config synchronization warning. | Manual parity verified for this release |
| LOW | OS cache can retain shared PDF/Excel files until eviction. | Observe during low-storage/force-close testing |
| LOW | 12 moderate npm advisories are confined to transitive Expo build/config tooling. | Monitor compatible patches |

## Release Decision

**READY AFTER PHYSICAL DEVICE TEST**

Static hardening, host-scale data tests, merged-manifest audit, lintVital, and local release assembly pass. Production release remains gated on the explicitly listed physical-device matrix, successful full lint or an upstream-confirmed lint-tool workaround, and an EAS Preview build. No Production AAB was created.
