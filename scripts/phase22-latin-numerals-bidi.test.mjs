import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import {
  formatDate,
  formatDateTime,
  formatDecimal,
  formatNumber,
  formatPercent,
  formatProductUsd,
  formatTime,
  formatUsd,
  formatUsdCents,
} from '../src/utils/formatters.ts';
import {
  LTR_ISOLATE,
  POP_DIRECTIONAL_ISOLATE,
  isolateLtr,
  normalizeDigits,
  normalizeIdentifierDigits,
  normalizeNumericInput,
  normalizeNumericOutput,
  sanitizeNumericInput,
} from '../src/utils/numerals.ts';

const NON_LATIN_DIGITS = /[٠-٩۰-۹]/;
const projectRoot = process.cwd();

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test('Arabic-Indic, Persian, and mixed digits normalize to ASCII', () => {
  assert.equal(normalizeDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
  assert.equal(normalizeDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789');
  assert.equal(normalizeDigits('١2۳٤5'), '12345');
});

test('numeric input normalization preserves validation while live sanitization is deterministic', () => {
  assert.equal(normalizeNumericInput('١٥٬٠٠٠'), '15000');
  assert.equal(normalizeNumericInput('۱۲۳٫۴۵', { allowDecimal: true }), '123.45');
  assert.equal(normalizeNumericInput('a١'), 'a1');
  assert.equal(sanitizeNumericInput('a١٢..٣-', { allowDecimal: true }), '12.3');
  assert.equal(sanitizeNumericInput('−٢٥', { allowNegative: true }), '-25');
  assert.equal(sanitizeNumericInput('-٢٥', { allowNegative: true }), '-25');
});

test('identifiers and barcodes keep punctuation and leading zeroes while normalizing digits', () => {
  assert.equal(normalizeIdentifierDigits('INV-١٠٢٤'), 'INV-1024');
  assert.equal(normalizeIdentifierDigits('٠١٢٣٤٥٦٧٨٩٠١٢'), '0123456789012');
  assert.equal(normalizeIdentifierDigits('+٩٦٣-٩٤٤-١٢٣٤٥٦'), '+963-944-123456');
});

test('number, money, decimal and percent formatting is Latin and separator-stable in both languages', () => {
  for (const language of ['ar', 'en']) {
    assert.equal(formatNumber(9_999_999_999, language), '9,999,999,999');
    assert.equal(formatNumber(-1_250, language), '-1,250');
    assert.equal(formatDecimal(1234.5, language, 2, 2), '1,234.50');
    assert.equal(formatUsdCents(-125, language), '-1.25 USD');
    assert.equal(formatPercent(12.5, language), '12.5%');
    assert.equal(NON_LATIN_DIGITS.test([formatUsd(1.25, language), formatProductUsd(1.2345, language)].join(' ')), false);
  }
});

test('USD cents formatting stays exact at safe integer boundaries', () => {
  assert.equal(formatUsdCents(Number.MAX_SAFE_INTEGER), '90,071,992,547,409.91 USD');
  assert.equal(formatUsdCents(-1), '-0.01 USD');
  assert.throws(() => formatUsdCents(Number.MAX_SAFE_INTEGER + 1), /INVALID_USD_CENTS/);
});

test('Gregorian date and time formatters emit Latin digits in Arabic and English', () => {
  const value = new Date('2026-10-03T15:05:00.000Z');
  for (const language of ['ar', 'en']) {
    for (const formatted of [formatDate(value, language), formatTime(value, language), formatDateTime(value, language)]) {
      assert.equal(NON_LATIN_DIGITS.test(formatted), false);
      assert.match(formatted, /\d/);
    }
  }
});

test('output fallback normalizes digits, separators, percent and minus', () => {
  assert.equal(normalizeNumericOutput('−١٬٢٣٤٫٥٪'), '-1,234.5%');
});

test('mixed-direction technical tokens use centralized LRI/PDI isolation', () => {
  const isolated = isolateLtr('INV-١٠٢٤');
  assert.equal(isolated, `${LTR_ISOLATE}INV-1024${POP_DIRECTIONAL_ISOLATE}`);
  assert.equal(`فاتورة رقم ${isolated}`.includes('INV-1024'), true);
});

test('shared input and PDF foundations enforce LTR numeric presentation', () => {
  const input = readFileSync(join(projectRoot, 'src/components/ui/AppInput.tsx'), 'utf8');
  const reportFormatting = readFileSync(join(projectRoot, 'src/utils/reportFormatting.ts'), 'utf8');
  assert.match(input, /sanitizeNumericInput/);
  assert.match(input, /normalizeIdentifierDigits/);
  assert.match(input, /resolvedNumericMode && technicalText/);
  assert.match(reportFormatting, /direction:ltr/);
  assert.match(reportFormatting, /unicode-bidi:isolate/);
  assert.match(reportFormatting, /tabular-nums/);
});

test('sales header stacks actions below the title at the required 320dp width', () => {
  const sales = readFileSync(join(projectRoot, 'src/screens/SalesScreen.tsx'), 'utf8');
  assert.match(sales, /const compactHeader = width < 360/);
  assert.match(sales, /compactHeader \? styles\.compactTitleRow/);
  assert.match(sales, /compactHeader && styles\.compactTitleCopy/);
  assert.match(sales, /compactHeader && styles\.compactHeaderAction/);
  assert.match(sales, /compactTitleCopy: \{ flex: 0, width: '100%' \}/);
  assert.match(sales, /compactHeaderAction: \{ flex: 1, minWidth: 0 \}/);
});

test('bottom navigation labels remain bounded at 320dp with enlarged system text', () => {
  const app = readFileSync(join(projectRoot, 'App.tsx'), 'utf8');
  assert.match(app, /const compactNavigation = width < 360/);
  assert.match(app, /maxFontSizeMultiplier=\{compactNavigation \? 1 : 1\.2\}/);
  assert.match(app, /compactNavigation && styles\.compactNavLabel/);
  assert.match(app, /compactNavLabel: \{ fontSize: 11, paddingHorizontal: 1 \}/);
});

test('backup import preview remains scrollable on compact screens and large fonts', () => {
  const sheets = readFileSync(join(projectRoot, 'src/components/ui/BottomSheet.tsx'), 'utf8');
  const settings = readFileSync(join(projectRoot, 'src/screens/SettingsAndBackupScreen.tsx'), 'utf8');
  assert.match(sheets, /ConfirmSheet\([\s\S]*scrollable = false/);
  assert.match(sheets, /rtl=\{rtl\} scrollable=\{scrollable\}/);
  assert.match(settings, /<ConfirmSheet[^>]*visible=\{!!pendingImport\}[^>]*scrollable>/);
});

test('shipping source centralizes Intl formatting and contains no user-facing non-Latin digit literals', () => {
  const files = sourceFiles(join(projectRoot, 'src'));
  const directIntl = [];
  const digitLiterals = [];
  const reversalHacks = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const name = relative(projectRoot, file).replaceAll('\\', '/');
    if (name !== 'src/utils/formatters.ts' && /Intl\.(?:NumberFormat|DateTimeFormat)|\.toLocale(?:String|DateString|TimeString)\(/.test(source)) directIntl.push(name);
    if (name !== 'src/utils/numerals.ts' && NON_LATIN_DIGITS.test(source)) digitLiterals.push(name);
    if (/split\(['"]{2}\)\.reverse\(\)/.test(source)) reversalHacks.push(name);
  }
  assert.deepEqual(directIntl, []);
  assert.deepEqual(digitLiterals, []);
  assert.deepEqual(reversalHacks, []);
  assert.equal(readFileSync(join(projectRoot, 'src/database/database.ts'), 'utf8').includes('export const SCHEMA_VERSION = 20;'), true);
});

test('Excel keeps numeric cells numeric and formats only generated display text centrally', () => {
  const excel = readFileSync(join(projectRoot, 'src/utils/excel.ts'), 'utf8');
  assert.match(excel, /amount_minor: payment\.amount_minor/);
  assert.match(excel, /display_amount: payment\.currency === 'USD' \? formatUsdCents/);
  assert.doesNotMatch(excel, /[٠-٩۰-۹]/);
});
