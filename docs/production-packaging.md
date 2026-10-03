# Sarafy Production Packaging Preparation

Date: 2026-10-01 (Asia/Damascus)

## Status

**BLOCKED — PRODUCTION SIGNING CREDENTIAL REQUIRED**

The application and its unsigned Android release build pass the production-packaging preparation gate. No approved production signing identity or secure reference to one is available in the repository, process environment, local Gradle configuration, CI configuration, or EAS configuration inspected during this audit. Production AAB generation therefore stopped as required.

No schema, dependency, accounting, runtime, signing, or version change was made. No AAB was generated during this preparation run.

## Branch

- Branch: `release/production-packaging`
- Working tree before the audit: clean.
- Working tree after the audit: only this report is new; generated export/build outputs remain ignored.

## Base Commit

- `8903de8 docs: record phase 20.5 release candidate gate`
- Phase 20.5 release-candidate fixes immediately below it:
  - `0799521 fix: harden phase 20 release candidate`

## Commits

No source or packaging commit was created in this run. Production signing and versioning remain intentionally unmodified pending owner approval.

## Package

- Application ID / namespace: `com.sarafy.catalog`
- Database schema: `v19` (`SCHEMA_VERSION = 19`)
- Android build tools: `36.0.0`
- `minSdk`: `24`
- `compileSdk`: `36`
- `targetSdk`: `36`
- React Native architectures configured: `armeabi-v7a`, `arm64-v8a`, `x86`, `x86_64`
- Hermes: enabled
- React Native New Architecture: enabled

## Versioning

Verified from the native Android source and packaged manifest:

- `versionName`: `1.1.0`
- `versionCode`: `1`

`app.json` also declares `1.1.0`; the Android `versionCode` is currently sourced from `android/app/build.gradle`.

No version value was changed. The conservative default recommendation for the next distinct production release is:

- `versionName`: `1.1.1`
- `versionCode`: `2`

This recommendation requires owner approval and confirmation of the highest version code ever uploaded to Google Play. If no build has ever been uploaded and the intended first public label remains `1.1.0`, retaining `1.1.0` / `1` can still be valid; Play history is authoritative.

## Signing State

- The `release` build type has **no signingConfig** and correctly produces an unsigned artifact.
- The checked-in `android/app/debug.keystore` is referenced only by the `debug` build type.
- The ignored `.expo-release-profile/signing/` directory contains local Phase 20.5 validation identities and APKs. These are not production credentials and must not be promoted or reused.
- No production keystore was found in the repository, the expected local Android/Gradle locations, environment-variable names, `gradle.properties`, `local.properties`, CI configuration, or EAS configuration.
- The EAS `production` profile requests an Android `app-bundle`, but no approved credential linkage was present in the inspected project configuration.
- The existing ignored AAB is unsigned and is not a production artifact.

Required next owner action: provide or authorize the approved production signing process/credential through a secure channel. Do not commit the keystore, passwords, or a secret-bearing signing property file.

## Secret Audit

The audit reported locations and categories only; no secret values were printed.

| Location | Category | Assessment |
| --- | --- | --- |
| Tracked source tree | Private-key material, API keys, OAuth secrets, bearer tokens, GitHub-token shapes | No matches |
| `android/app/build.gradle` | Debug signing credential literals | Safe only for debug; release does not reference them |
| `android/app/debug.keystore` | Standard tracked debug identity | Debug-only; prohibited for production |
| `.expo-release-profile/signing/*.jks` | Local Phase 20.5 validation identities | Ignored/local; prohibited for production reuse |
| Environment variables | Production signing / Play / EAS credential names | None found |
| CI / Gradle / local properties / EAS | Production signing credential reference | None found |

`.gitignore` and `.easignore` exclude `.env*`, `*.jks`, `*.keystore`, `*.p12`, `*.apk`, and `*.aab`. No credential-bearing file was added.

## Manifest

The freshly merged Release manifest confirms:

- Package: `com.sarafy.catalog`
- `versionName=1.1.0`, `versionCode=1`
- `minSdk=24`, `targetSdk=36`; packaged metadata confirms `compileSdk=36`
- `allowBackup=false`
- No `debuggable=true`
- No cleartext-traffic override
- No `RECORD_AUDIO`
- Expo Updates explicitly disabled (`expo.modules.updates.ENABLED=false`)
- No exported Expo dev-launcher/dev-menu activity, provider, service, or receiver
- Exported application surface is the launcher `MainActivity`; AndroidX Profile Installer's receiver is permission-protected
- The established `exp+sarafy` MainActivity deep-link filter remains present

Permissions in the merged Release manifest:

- `CAMERA`
- `VIBRATE`
- bounded legacy `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE`
- Expo/library-generated `INTERNET` / `ACCESS_NETWORK_STATE`
- the application-scoped dynamic-receiver protection permission

The manifest matches the accepted Phase 20.5 baseline.

## Offline Audit

- Static shipping-source checks found no `fetch`, Axios, `XMLHttpRequest`, WebSocket, or application HTTP endpoint use.
- The only matched remote package URL belongs to the package-manager dependency declaration for SheetJS and is not runtime application behavior.
- Expo Updates is disabled.
- `INTERNET` and `ACCESS_NETWORK_STATE` remain generated manifest permissions, but no runtime network path was found and the Phase 20.5 signed release gate completed offline.

## Release Configuration

- R8/minification: disabled by current default (`android.enableMinifyInReleaseBuilds` is not enabled).
- Resource shrinking: disabled by current default.
- ProGuard file: default Android rules plus project keep rules for Reanimated and React TurboModules.
- APK ABI splitting: not configured; the release APK is universal and contains four ABIs.
- AAB capability: available through Gradle and the EAS production `app-bundle` profile; Play can deliver ABI splits from an authorized bundle.
- Expo dev-client libraries are installed and compiled, but the merged release manifest exposes no dev-launcher/dev-menu component. The validated Release APK opens the application directly.
- Play Store configuration present: EAS project metadata and a production app-bundle profile.
- Play Store configuration absent: store listing/fastlane metadata, service-account credentials, upload configuration, and an approved production signing link.

## Automated Tests

- TypeScript: PASS
- Strict unused (`noUnusedLocals`, `noUnusedParameters`): PASS
- `git diff --check`: PASS
- Full sequential suite: **268/268 PASS**
- Duration: approximately **43.63 seconds**
- No test was removed or weakened.

## Production Export

- Result: PASS
- Platform: Android
- Modules: `1,337`
- Assets: `27`
- Hermes bytecode bundle: PASS (`.hbc`, approximately 5.7 MB)
- Output: ignored local directory `dist-production-packaging/`

## APK Build

- `:app:assembleRelease`: PASS
- Gradle result: `BUILD SUCCESSFUL`
- Duration: approximately `2m 21s`
- Artifact: `android/app/build/outputs/apk/release/app-release-unsigned.apk`
- Size: `129,395,775` bytes
- Signature verification: FAIL as expected; artifact is unsigned
- No APK was committed.

## AAB

- Production AAB generated in this run: **NO**
- Reason: owner-approved production signing credential and production version approval are absent.
- Technical capability: PASS (`bundleRelease`/EAS app-bundle path exists).
- A pre-existing ignored `app-release.aab` was found at `67,850,167` bytes. Inspection showed four ABIs and Hermes payloads, but `jarsigner` classified it as unsigned. It is stale local evidence, not a production candidate.

## Signing Certificate

- Production certificate: unavailable
- Production certificate SHA-256: unavailable
- Debug and disposable Phase 20.5 certificate fingerprints were not promoted or recorded as production evidence.

## Artifact Metadata

Unsigned APK metadata:

| Field | Value |
| --- | --- |
| Package | `com.sarafy.catalog` |
| Version name | `1.1.0` |
| Version code | `1` |
| Minimum SDK | `24` |
| Target SDK | `36` |
| Compile SDK | `36` |
| ABIs | `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64` |
| Signing | Unsigned by design |

No APK or AAB is tracked by Git.

## Remaining Risks

1. An owner-approved production signing identity/process is mandatory before a production AAB can be built.
2. The owner must approve the production `versionName` and a `versionCode` greater than any prior Play upload.
3. The production certificate SHA-256 cannot be recorded until the approved certificate is available.
4. Play listing, privacy-policy/store metadata, and upload/service-account configuration are not present in this repository and must be handled in the store-submission stage.
5. R8/minification and resource shrinking are currently disabled. This is the validated baseline, not a blocker, but enabling either later requires its own regression/release validation rather than a packaging-only toggle.
6. Generated Expo network permissions and the `exp+sarafy` deep-link remain part of the accepted baseline; any removal should be a separately validated native-configuration change.

## Final Decision

**BLOCKED — PRODUCTION SIGNING CREDENTIAL REQUIRED**

Sarafy is functionally ready for production packaging, but the production artifact cannot be created safely until the owner explicitly approves both:

1. the production signing credential/process; and
2. the production version values.

No production AAB, signing identity, Play upload, schema change, dependency update, or product feature was created in this run.
