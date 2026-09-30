const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export function requireSafeInteger(value: number, code = 'UNSAFE_ACCOUNTING_INTEGER'): number {
  if (!Number.isSafeInteger(value)) throw new Error(code);
  return value;
}

export function bigintToSafeInteger(value: bigint, code = 'UNSAFE_ACCOUNTING_INTEGER'): number {
  if (value > MAX_SAFE_BIGINT || value < -MAX_SAFE_BIGINT) throw new Error(code);
  return Number(value);
}

export function roundHalfUpRatio(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error('INVALID_ACCOUNTING_RATIO');
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
}

export function usdCentsToSyp(usdCents: number, exchangeRateSypPerUsd: number): number {
  requireSafeInteger(usdCents, 'INVALID_USD_CENTS');
  requireSafeInteger(exchangeRateSypPerUsd, 'INVALID_EXCHANGE_RATE');
  if (usdCents < 0 || exchangeRateSypPerUsd <= 0) throw new Error('INVALID_CURRENCY_CONVERSION');
  return bigintToSafeInteger(roundHalfUpRatio(BigInt(usdCents) * BigInt(exchangeRateSypPerUsd), 100n), 'ACCOUNTING_CONVERSION_OVERFLOW');
}

export function cumulativeHalfUpAllocation(total: number, cumulativeQuantity: number, originalQuantity: number): number {
  requireSafeInteger(total);
  requireSafeInteger(cumulativeQuantity, 'INVALID_CUMULATIVE_QUANTITY');
  requireSafeInteger(originalQuantity, 'INVALID_ORIGINAL_QUANTITY');
  if (total < 0 || originalQuantity <= 0 || cumulativeQuantity < 0 || cumulativeQuantity > originalQuantity) throw new Error('INVALID_CUMULATIVE_ALLOCATION');
  if (cumulativeQuantity === originalQuantity) return total;
  return bigintToSafeInteger(roundHalfUpRatio(BigInt(total) * BigInt(cumulativeQuantity), BigInt(originalQuantity)), 'ACCOUNTING_ALLOCATION_OVERFLOW');
}

export function incrementalHalfUpAllocation(total: number, previousQuantity: number, nextQuantity: number, originalQuantity: number): number {
  if (nextQuantity < previousQuantity) throw new Error('INVALID_CUMULATIVE_ALLOCATION');
  return cumulativeHalfUpAllocation(total, nextQuantity, originalQuantity) - cumulativeHalfUpAllocation(total, previousQuantity, originalQuantity);
}

export function proportionalCarryingAllocation(totalCarryingSyp: number, partNative: number, totalNative: number): number {
  requireSafeInteger(totalCarryingSyp);
  requireSafeInteger(partNative, 'INVALID_NATIVE_AMOUNT');
  requireSafeInteger(totalNative, 'INVALID_NATIVE_AMOUNT');
  if (totalCarryingSyp < 0 || partNative < 0 || totalNative <= 0 || partNative > totalNative) throw new Error('INVALID_CARRYING_ALLOCATION');
  if (partNative === totalNative) return totalCarryingSyp;
  return bigintToSafeInteger(roundHalfUpRatio(BigInt(totalCarryingSyp) * BigInt(partNative), BigInt(totalNative)), 'ACCOUNTING_ALLOCATION_OVERFLOW');
}

export function relieveWeightedAverageCarryingValue(nativeBalance: number, carryingValueSyp: number, nativeOutflow: number): number {
  requireSafeInteger(nativeBalance, 'INVALID_NATIVE_BALANCE');
  requireSafeInteger(carryingValueSyp, 'INVALID_CARRYING_BALANCE');
  requireSafeInteger(nativeOutflow, 'INVALID_NATIVE_OUTFLOW');
  if (nativeBalance < 0 || carryingValueSyp < 0 || nativeOutflow < 0 || nativeOutflow > nativeBalance) throw new Error('INVALID_WEIGHTED_AVERAGE_RELIEF');
  if (nativeOutflow === 0) return 0;
  if (nativeOutflow === nativeBalance) return carryingValueSyp;
  return proportionalCarryingAllocation(carryingValueSyp, nativeOutflow, nativeBalance);
}

export interface LargestRemainderInput<Key extends string | number> { key: Key; usdCents: number }
export interface LargestRemainderAllocation<Key extends string | number> extends LargestRemainderInput<Key> { accountingSyp: number }

function compareStableKeys(left: string | number, right: string | number) {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right), 'en');
}

export function allocateIntegerByLargestRemainder<Key extends string | number>(
  total: number,
  inputs: readonly { key: Key; weight: number }[],
): Array<{ key: Key; amount: number }> {
  requireSafeInteger(total); if (total < 0 || inputs.length === 0) throw new Error('INVALID_INTEGER_ALLOCATION');
  const keys = new Set<string>(); let totalWeight = 0n;
  const working = inputs.map(input => {
    requireSafeInteger(input.weight, 'INVALID_ALLOCATION_WEIGHT'); if (input.weight < 0) throw new Error('INVALID_ALLOCATION_WEIGHT');
    const serialized = `${typeof input.key}:${String(input.key)}`; if (keys.has(serialized)) throw new Error('DUPLICATE_ALLOCATION_KEY'); keys.add(serialized);
    totalWeight += BigInt(input.weight); return { ...input, serialized };
  });
  if (totalWeight === 0n) {
    if (total !== 0) throw new Error('INVALID_INTEGER_ALLOCATION');
    return working.map(row => ({ key: row.key, amount: 0 }));
  }
  const calculated = working.map(row => {
    const numerator = BigInt(total) * BigInt(row.weight);
    return { ...row, base: numerator / totalWeight, remainder: numerator % totalWeight };
  });
  const residual = BigInt(total) - calculated.reduce((sum, row) => sum + row.base, 0n);
  const ranked = [...calculated].sort((left, right) => left.remainder === right.remainder
    ? compareStableKeys(left.key, right.key)
    : left.remainder > right.remainder ? -1 : 1);
  const increments = new Set(ranked.slice(0, Number(residual)).map(row => row.serialized));
  const result = calculated.map(row => ({ key: row.key, amount: bigintToSafeInteger(row.base + (increments.has(row.serialized) ? 1n : 0n)) }));
  if (result.reduce((sum, row) => sum + row.amount, 0) !== total) throw new Error('INTEGER_ALLOCATION_MISMATCH');
  return result;
}

export function allocatePurchaseSypByLargestRemainder<Key extends string | number>(
  inputs: readonly LargestRemainderInput<Key>[],
  exchangeRateSypPerUsd: number,
): { totalSyp: number; allocations: LargestRemainderAllocation<Key>[] } {
  requireSafeInteger(exchangeRateSypPerUsd, 'INVALID_EXCHANGE_RATE');
  if (exchangeRateSypPerUsd <= 0 || inputs.length === 0) throw new Error('INVALID_PURCHASE_ALLOCATION');
  const keys = new Set<string>(); let totalUsd = 0n;
  const working = inputs.map(input => {
    requireSafeInteger(input.usdCents, 'INVALID_USD_CENTS');
    if (input.usdCents < 0) throw new Error('INVALID_USD_CENTS');
    const serialized = `${typeof input.key}:${String(input.key)}`;
    if (keys.has(serialized)) throw new Error('DUPLICATE_ALLOCATION_KEY');
    keys.add(serialized); totalUsd += BigInt(input.usdCents);
    const numerator = BigInt(input.usdCents) * BigInt(exchangeRateSypPerUsd);
    return { ...input, base: numerator / 100n, remainder: numerator % 100n, serialized };
  });
  const totalBigInt = roundHalfUpRatio(totalUsd * BigInt(exchangeRateSypPerUsd), 100n);
  const baseTotal = working.reduce((sum, line) => sum + line.base, 0n);
  const residual = totalBigInt - baseTotal;
  if (residual < 0n || residual > BigInt(working.length)) throw new Error('INVALID_PURCHASE_ALLOCATION');
  const ranked = [...working].sort((left, right) => left.remainder === right.remainder
    ? compareStableKeys(left.key, right.key)
    : left.remainder > right.remainder ? -1 : 1);
  const increments = new Set(ranked.slice(0, Number(residual)).map(line => line.serialized));
  const allocations = working.map(line => ({
    key: line.key,
    usdCents: line.usdCents,
    accountingSyp: bigintToSafeInteger(line.base + (increments.has(line.serialized) ? 1n : 0n)),
  }));
  const totalSyp = bigintToSafeInteger(totalBigInt, 'ACCOUNTING_CONVERSION_OVERFLOW');
  if (allocations.reduce((sum, line) => sum + line.accountingSyp, 0) !== totalSyp) throw new Error('PURCHASE_ALLOCATION_MISMATCH');
  return { totalSyp, allocations };
}

export function splitCarryingValueAtZero(considerationSyp: number, payableNative: number, paymentNative: number) {
  if (payableNative < 0 || paymentNative <= 0 || payableNative > paymentNative) throw new Error('INVALID_ZERO_CROSSING');
  const payableConsiderationSyp = proportionalCarryingAllocation(considerationSyp, payableNative, paymentNative);
  return { payableConsiderationSyp, advanceConsiderationSyp: considerationSyp - payableConsiderationSyp };
}
