export const LAMPORTS_PER_SOL = 1_000_000_000n;

export function toLamports(sol: number): bigint {
  return BigInt(Math.floor(sol * 1_000_000_000));
}

export function formatSol(lamports: bigint): string {
  return (Number(lamports) / 1e9).toFixed(6);
}

export function formatTokenAmount(amount: bigint, decimals: number, precision = 6): string {
  const divisor = 10 ** decimals;
  return (Number(amount) / divisor).toFixed(precision);
}

export function formatPct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function shorten(address: string, left = 4, right = 4): string {
  if (address.length <= left + right + 3) {
    return address;
  }
  return `${address.slice(0, left)}...${address.slice(-right)}`;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}
