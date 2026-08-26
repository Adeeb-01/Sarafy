export interface CalculationParams {
  priceUsd: number;
  exchangeRate: number;
  isRoundingEnabled: boolean;
  roundingTarget: number;
}

export const calculateSypPrice = ({
  priceUsd,
  exchangeRate,
  isRoundingEnabled,
  roundingTarget,
}: CalculationParams): number => {
  const rawPrice = priceUsd * exchangeRate;
  if (!isRoundingEnabled || roundingTarget <= 0) return rawPrice;
  return Math.round(rawPrice / roundingTarget) * roundingTarget;
};
