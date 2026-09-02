export function exchangeRateChangePercent(oldRate: number, newRate: number) {
  if (!Number.isFinite(oldRate) || oldRate <= 0 || !Number.isFinite(newRate)) return null;
  const value = ((newRate - oldRate) / oldRate) * 100;
  return Number.isFinite(value) ? value : null;
}

export function formatExchangeRateChange(oldRate: number, newRate: number, locale: string) {
  const percent = exchangeRateChangePercent(oldRate, newRate);
  if (percent == null) return null;
  const rounded = Math.abs(percent) < 0.005 ? 0 : percent;
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString(locale, { maximumFractionDigits: 2 })}%`;
}
