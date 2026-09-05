import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = file => readFile(new URL(file, root), 'utf8');

async function sourceFiles(directory) {
  const absolute = path.resolve(new URL(directory, root).pathname.slice(1));
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const relative = `${directory.replace(/\/$/, '')}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  }));
  return nested.flat();
}

test('native and Expo configuration preserve identity, resize behavior, and theme background', async () => {
  const [app, gradle, manifest, colors, ignore] = await Promise.all([
    read('app.json'), read('android/app/build.gradle'), read('android/app/src/main/AndroidManifest.xml'),
    read('android/app/src/main/res/values/colors.xml'), read('.easignore'),
  ]);
  assert.match(app, /"package": "com\.sarafy\.catalog"/);
  assert.match(gradle, /applicationId 'com\.sarafy\.catalog'/);
  assert.match(manifest, /android:windowSoftInputMode="adjustResize"/);
  assert.match(app, /"backgroundColor": "#EFF3F8"/);
  assert.match(colors, /activityBackground">#EFF3F8/);
  for (const entry of ['node_modules/', 'android/app/build/', 'android/app/.cxx/', 'dist/', 'coverage/', '*.sarafy', '*.apk', '*.aab']) assert.match(ignore, new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('legacy UI wrappers and compatibility tokens are absent', async () => {
  for (const file of ['src/components/Screen.tsx', 'src/components/SearchBar.tsx', 'src/components/GlassSurface.tsx', 'src/theme/tokens.ts']) {
    await assert.rejects(access(new URL(file, root), constants.F_OK));
  }
  const files = await sourceFiles('src');
  for (const file of files) {
    const source = await read(file);
    assert.doesNotMatch(source, /GlassSurface|theme\/tokens|components\/Screen['"]|components\/SearchBar['"]/);
  }
});

test('runtime UI uses centralized color and copy systems', async () => {
  const files = await sourceFiles('src');
  for (const file of files) {
    if (file === 'src/theme/colors.ts' || file === 'src/theme/shadows.ts' || file === 'src/utils/invoice.ts' || file === 'src/utils/returnReceipt.ts' || file.startsWith('src/i18n/')) continue;
    const source = await read(file);
    assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|rgba?\(/i, `${file} contains a raw color`);
    assert.doesNotMatch(source, /[ء-ي]/, `${file} contains user-facing Arabic outside i18n`);
    assert.doesNotMatch(source, /Alert\.alert|\balert\s*\(/, `${file} contains a raw alert`);
    assert.doesNotMatch(source, /console\.log\s*\(/, `${file} contains development logging`);
  }
});

test('raw modals are limited to shared sheet infrastructure and full-screen workflows', async () => {
  const files = await sourceFiles('src');
  const modalFiles = [];
  for (const file of files) if (/\bModal\b/.test(await read(file))) modalFiles.push(file);
  assert.deepEqual(modalFiles.sort(), [
    'src/components/ProductFormModal.tsx', 'src/components/RateHistoryScreen.tsx',
    'src/components/barcode/BarcodeScannerScreen.tsx',
    'src/components/sales/ReturnFlowScreen.tsx',
    'src/components/sales/SalesViews.tsx',
    'src/components/ui/BottomSheet.tsx',
    'src/screens/InventoryScreen.tsx',
    'src/screens/PurchasesScreen.tsx',
  ]);
});

test('measured navigation and sticky-action insets remain wired to scroll content', async () => {
  const [products, form, sales, analytics, snackbar, app] = await Promise.all([
    read('src/screens/ProductManagementScreen.tsx'), read('src/components/ProductFormModal.tsx'),
    read('src/screens/SalesScreen.tsx'), read('src/components/analytics/AnalyticsDashboard.tsx'),
    read('src/components/ui/Snackbar.tsx'), read('App.tsx'),
  ]);
  assert.match(products, /bottomNavigationInset/);
  assert.match(form, /stickyActionHeight/);
  assert.match(form, /insets\.bottom/);
  assert.match(sales, /bottomNavigationInset/);
  assert.match(analytics, /paddingBottom: bottomNavigationInset \+ spacing\.xl/);
  assert.match(app, /<SnackbarProvider bottomInset=\{bottomNavigationHeight\}>/);
  assert.match(snackbar, /resolvedBottomInset/);
  assert.match(snackbar, /insets\.bottom/);
});

test('critical UI accessibility and double-action guards remain explicit', async () => {
  const [button, controls, list, app, sales, product, settings] = await Promise.all([
    read('src/components/ui/AppButton.tsx'), read('src/components/ui/Controls.tsx'),
    read('src/components/ui/ListItem.tsx'), read('App.tsx'), read('src/screens/SalesScreen.tsx'),
    read('src/components/ProductFormModal.tsx'), read('src/screens/SettingsAndBackupScreen.tsx'),
  ]);
  assert.match(button, /accessibilityState=\{\{ disabled: inactive, busy: loading \}\}/);
  assert.match(controls, /accessibilityRole="switch"/);
  assert.match(controls, /checked: value/);
  assert.match(list, /busy: loading/);
  assert.match(app, /accessibilityState=\{\{ selected: active \}\}/);
  assert.match(sales, /savingRef/);
  assert.match(product, /savingRef/);
  assert.match(settings, /operationRunning/);
});
