export interface BootstrapInterval {
  readonly estimate: number;
  readonly lower: number;
  readonly upper: number;
  readonly samples: number;
  readonly seed: number;
}

export function pairedBootstrap(
  pairs: readonly {
    readonly candidate: number;
    readonly baseline: number;
  }[],
  options: { readonly samples?: number; readonly seed?: number } = {}
): BootstrapInterval {
  if (pairs.length === 0) {
    throw new Error("Paired bootstrap requires at least one paired sample.");
  }
  const samples = options.samples ?? 10_000;
  const seed = options.seed ?? 0x50_52_54_49;
  const random = mulberry32(seed);
  const deltas = pairs.map((pair) => pair.candidate - pair.baseline);
  const estimates = Array.from({ length: samples }, () => {
    let total = 0;
    for (let index = 0; index < deltas.length; index += 1) {
      total += deltas[Math.floor(random() * deltas.length)] ?? 0;
    }
    return total / deltas.length;
  }).sort((left, right) => left - right);
  return {
    estimate: mean(deltas),
    lower: percentile(estimates, 0.025) as number,
    upper: percentile(estimates, 0.975) as number,
    samples,
    seed,
  };
}

export function median(values: readonly number[]): number | undefined {
  return percentile(values, 0.5);
}

export function percentile(
  values: readonly number[],
  quantile: number
): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  const lowerValue = sorted[lower] as number;
  const upperValue = sorted[upper] as number;
  return lowerValue + (upperValue - lowerValue) * weight;
}

export function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let next = Math.imul(value ^ (value >>> 15), 1 | value);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}
