import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import test from 'node:test';
import { calculateKeyboardAwareMaxHeight, calculateKeyboardInset } from '../src/components/ui/bottomSheetKeyboard.ts';

test('startup keeps React visually empty until fonts and the store are ready', async () => {
  const [app, copy] = await Promise.all([
    readFile(new URL('../App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/i18n/ui.ts', import.meta.url), 'utf8'),
  ]);
  assert.ok(app.indexOf('SplashScreen.preventAutoHideAsync()') < app.indexOf('export default function App'));
  assert.match(app, /const startupReady = fontsLoaded && isReady && !startupError/);
  assert.match(app, /if \(!startupReady && !startupError && !retainStartupError\) return null/);
  assert.match(app, /onLayout=\{\(\) => void releaseNativeSplash\(\)\}/);
  assert.match(app, /<ErrorState title=\{copy\.app\.startErrorTitle\}/);
  assert.doesNotMatch(app, /AppBootstrapScreen|LoadingState/);
  assert.doesNotMatch(copy, /preparingData|bootstrapSupporting|Preparing your data|جارٍ تجهيز بياناتك/);
  await assert.rejects(access(new URL('../src/components/ui/AppBootstrapScreen.tsx', import.meta.url), constants.F_OK));
});

test('keyboard hidden produces no bottom-sheet inset', () => {
  assert.equal(calculateKeyboardInset({ y: 0, height: 844 }, null), 0);
});

test('full-screen product modal resizes its sticky save action above Android IME', async () => {
  const source = await readFile(new URL('../src/components/ProductFormModal.tsx', import.meta.url), 'utf8');
  // Android 12 physical-device regression: the modal window stayed full height
  // despite activity adjustResize; an undefined Android behavior hid the CTA.
  assert.match(source, /<KeyboardAvoidingView behavior=\{Platform\.OS === 'ios' \? 'padding' : 'height'\}/);
  const start = source.indexOf('<KeyboardAvoidingView');
  const end = source.indexOf('</KeyboardAvoidingView>', start);
  const body = source.slice(start, end);
  assert.match(body, /styles\.footer/);
  assert.match(body, /copy\.productForm\.saveProduct/);
  assert.match(body, /keyboardShouldPersistTaps="handled"/);
});

test('keyboard overlap is measured against the modal viewport', () => {
  assert.equal(calculateKeyboardInset({ y: 0, height: 844 }, { screenY: 520, height: 324 }), 324);
  assert.equal(calculateKeyboardInset({ y: 24, height: 820 }, { screenY: 520, height: 324 }), 324);
});

test('adjustResize is not double-counted when the modal already ends above the keyboard', () => {
  assert.equal(calculateKeyboardInset({ y: 0, height: 520 }, { screenY: 520, height: 324 }), 0);
});

test('keyboard-aware max height respects keyboard and safe areas on small screens', () => {
  assert.equal(calculateKeyboardAwareMaxHeight({ viewportHeight: 640, keyboardInset: 300, safeAreaTop: 24, safeAreaBottom: 16 }), 300);
  assert.equal(calculateKeyboardAwareMaxHeight({ viewportHeight: 844, keyboardInset: 324, safeAreaTop: 47, safeAreaBottom: 34 }), 439);
});

test('input sheets opt into the centralized keyboard-aware behavior', async () => {
  const [bottomSheet, rate, sales, category] = await Promise.all([
    readFile(new URL('../src/components/ui/BottomSheet.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/RateControl.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/sales/SalesViews.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/CategoryPickerSheet.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(bottomSheet, /keyboardAware\?: boolean/);
  assert.match(bottomSheet, /Keyboard\.dismiss\(\)/);
  assert.match(bottomSheet, /keyboardDismissMode="on-drag"/);
  assert.match(rate, /keyboardAware/);
  assert.match(sales, /keyboardAware/);
  assert.match(category, /keyboardAware/);
});

test('native splash uses the Sarafy launcher icon, theme backgrounds, and post-splash theme', async () => {
  const [activity, styles, styles31, colors, nightColors, packageJson, appConfig] = await Promise.all([
    readFile(new URL('../android/app/src/main/java/com/sarafy/catalog/MainActivity.kt', import.meta.url), 'utf8'),
    readFile(new URL('../android/app/src/main/res/values/styles.xml', import.meta.url), 'utf8'),
    readFile(new URL('../android/app/src/main/res/values-v31/styles.xml', import.meta.url), 'utf8'),
    readFile(new URL('../android/app/src/main/res/values/colors.xml', import.meta.url), 'utf8'),
    readFile(new URL('../android/app/src/main/res/values-night/colors.xml', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../app.json', import.meta.url), 'utf8'),
  ]);
  assert.ok(activity.indexOf('SplashScreenManager.registerOnActivity(this)') < activity.indexOf('super.onCreate(null)'));
  for (const source of [styles, styles31]) {
    assert.match(source, /parent="Theme\.SplashScreen"/);
    assert.match(source, /windowSplashScreenBackground">@color\/splashscreen_background/);
    assert.match(source, /windowSplashScreenAnimatedIcon">@mipmap\/ic_launcher/);
    assert.match(source, /postSplashScreenTheme">@style\/AppTheme/);
    assert.doesNotMatch(source, /splashscreen_logo/);
  }
  assert.match(colors, /splashscreen_background">#EFF3F8/);
  assert.match(colors, /activityBackground">#EFF3F8/);
  assert.match(nightColors, /splashscreen_background">#0F1420/);
  assert.match(nightColors, /activityBackground">#0F1420/);
  assert.match(packageJson, /"expo-splash-screen": "~57\.0\.8"/);
  assert.match(appConfig, /"imageWidth": 96/);
  assert.match(appConfig, /"backgroundColor": "#0F1420"/);
  assert.match(appConfig, /"package": "com\.sarafy\.catalog"/);
});
