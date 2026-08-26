import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const gradle = await readFile(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
const manifest = await readFile(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
const importer = await readFile(new URL('../src/import/jsonImporter.ts', import.meta.url), 'utf8');
const server = await readFile(new URL('./serve-web.mjs', import.meta.url), 'utf8');

test('release artifacts never fall back to the debug signing key', () => {
  const releaseBlock = gradle.slice(gradle.indexOf('release {'), gradle.indexOf('packagingOptions'));
  assert.doesNotMatch(releaseBlock, /signingConfig\s+signingConfigs\.debug/);
});

test('production manifest disables Android backup and overlay permission', () => {
  assert.match(manifest, /android:allowBackup="false"/);
  assert.doesNotMatch(manifest, /android\.permission\.SYSTEM_ALERT_WINDOW/);
});

test('backup settings are allowlisted before storage', () => {
  assert.match(importer, /const SETTING_KEYS = \['exchangeRate', 'isRoundingEnabled', 'roundingTarget', 'language'\]/);
  assert.match(importer, /Object\.keys\(settings\)\.some/);
  assert.doesNotMatch(importer, /Object\.entries\(payload\.settings\)/);
});

test('preview server uses a path-boundary check and catches malformed URLs', () => {
  assert.match(server, /relative\(root, requested\)/);
  assert.match(server, /!relativePath\.startsWith\('\.\.'\) && !isAbsolute\(relativePath\)/);
  assert.ok(server.indexOf('try {') < server.indexOf('decodeURIComponent'));
});
