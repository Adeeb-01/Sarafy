import { canonicalizeLegacyUsdNumber, resolveUsdSalePriceSyp } from '@/utils/productPricing';

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
  return resolveUsdSalePriceSyp(canonicalizeLegacyUsdNumber(priceUsd), exchangeRate, isRoundingEnabled, roundingTarget);
};
