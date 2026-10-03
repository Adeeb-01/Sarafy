const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export const LTR_ISOLATE = '\u2066';
export const POP_DIRECTIONAL_ISOLATE = '\u2069';

export function normalizeDigits(value: string) {
  return value
    .replace(/[٠-٩]/g, digit => String(ARABIC_INDIC_DIGITS.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String(PERSIAN_DIGITS.indexOf(digit)));
}

export function normalizeNumericOutput(value: string) {
  return normalizeDigits(value)
    .replace(/٬/g, ',')
    .replace(/٫/g, '.')
    .replace(/٪/g, '%')
    .replace(/−/g, '-');
}

export type NumericInputOptions = {
  allowDecimal?: boolean;
  allowNegative?: boolean;
};

export function normalizeNumericInput(value: string, _options: NumericInputOptions = {}) {
  return normalizeDigits(value)
    .replace(/٫/g, '.')
    .replace(/−/g, '-')
    .replace(/[٬,\s\u00a0\u202f]/g, '');
}

export function sanitizeNumericInput(value: string, options: NumericInputOptions = {}) {
  const { allowDecimal = false, allowNegative = false } = options;
  const normalized = normalizeNumericInput(value, options);
  let result = '';
  let hasDecimal = false;
  let hasSign = false;
  for (const character of normalized) {
    if (character >= '0' && character <= '9') {
      result += character;
    } else if (allowDecimal && character === '.' && !hasDecimal) {
      result += character;
      hasDecimal = true;
    } else if (allowNegative && character === '-' && !hasSign && result.length === 0) {
      result += character;
      hasSign = true;
    }
  }
  return result;
}

export function normalizeIdentifierDigits(value: string) {
  return normalizeDigits(value);
}

export function isolateLtr(value: string | number) {
  return `${LTR_ISOLATE}${normalizeDigits(String(value))}${POP_DIRECTIONAL_ISOLATE}`;
}
