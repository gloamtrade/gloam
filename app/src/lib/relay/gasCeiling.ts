/**
 * The relay's gas ceiling: the most the Gloam relay pays per unit of gas on a
 * chain. The relay pays the gas for every private send and cash out, and a
 * private send costs about 1.9M gas, so on Ethereum a spike to 50 gwei would
 * cost Gloam about 0.09 ETH a send. Above the ceiling the relay sends nothing
 * and says why; a scheduled cash out waits for gas to come back under it
 * (lib/relay/scheduled).
 *
 * GLOAM_RELAY_MAX_GAS_GWEI_<chainId> (server env) sets it, in gwei ("3",
 * "0.5"); "off" turns it off for that chain. The default is 3 gwei on Ethereum
 * mainnet, 1 gwei on BNB Chain (56; it charged 0.05 gwei on 18 Nov 2026, so the
 * ceiling is 20 times that, and a 1.9M-gas send at it costs about 0.0019 BNB), and
 * no ceiling elsewhere, where gas costs a fraction of a cent.
 *
 * Under the ceiling, a send still caps what it can pay: its max fee per gas is
 * at most one and a half times the ceiling, room for the base fee to rise for
 * a few blocks between the check and inclusion, and never more.
 */
import { formatUnits, parseUnits } from "viem";

/** Default ceilings, in gwei, by chain id. */
export const DEFAULT_MAX_GAS_GWEI: Readonly<Record<number, string>> = { 1: "3", 56: "1" };

/** What a refusal over gas says, and its code. */
export const GAS_HIGH_CODE = "gas_high";

export function gasHighMessage(label: string): string {
  return `${label} gas is high right now; try again shortly.`;
}

type Env = Record<string, string | undefined>;

const warned = new Set<string>();

/** The ceiling for `chainId` in wei per gas, or null when it has none. */
export function maxGasPriceWei(chainId: number, env: Env = process.env): bigint | null {
  const name = `GLOAM_RELAY_MAX_GAS_GWEI_${chainId}`;
  const raw = env[name]?.trim();
  const fallback = DEFAULT_MAX_GAS_GWEI[chainId];
  if (raw && raw.toLowerCase() === "off") return null;
  if (raw) {
    const wei = gweiToWei(raw);
    if (wei !== null) return wei;
    // A value that is not a number keeps the default rather than lifting the ceiling.
    if (!warned.has(name)) console.warn("gloam_relay_gas_ceiling_invalid", JSON.stringify({ name }));
    warned.add(name);
  }
  return fallback ? gweiToWei(fallback) : null;
}

function gweiToWei(v: string): bigint | null {
  if (!/^\d{1,6}(\.\d{1,9})?$/.test(v)) return null;
  const wei = parseUnits(v, 9);
  return wei > 0n ? wei : null;
}

/** The hard cap on a send's max fee per gas under a ceiling: 1.5 times it. */
export function maxFeeCapWei(ceiling: bigint): bigint {
  return ceiling + ceiling / 2n;
}

/** Gwei as a short decimal for messages and the status ("3", "0.035"). */
export function formatGwei(wei: bigint): string {
  const [whole, frac = ""] = formatUnits(wei, 9).split(".");
  const short = frac.slice(0, 3).replace(/0+$/, "");
  return short ? `${whole}.${short}` : (whole ?? "0");
}

export type GasReading = {
  /** The ceiling, or null when this chain has none. */
  ceilingWei: bigint | null;
  /** The chain's gas price now, or null when there is no ceiling to check it against. */
  gasPriceWei: bigint | null;
  /** Over the ceiling: the relay sends nothing until it comes down. */
  high: boolean;
};

type Reader = { getGasPrice: () => Promise<bigint> };

/** Gas price reads kept briefly per chain, so status polls and a payroll's sends share one. */
const READ_TTL_MS = 12_000;
const reads = new Map<number, { at: number; wei: bigint }>();

/**
 * Where gas stands on `chainId` against its ceiling. Chains with no ceiling
 * never read the price. A price that can't be read counts as high on a chain
 * with a ceiling: the relay would rather wait than pay blind.
 */
export async function readGas(
  chainId: number,
  client: Reader,
  opts: { env?: Env; now?: number; fresh?: boolean } = {}
): Promise<GasReading> {
  const ceilingWei = maxGasPriceWei(chainId, opts.env);
  if (ceilingWei === null) return { ceilingWei, gasPriceWei: null, high: false };
  const now = opts.now ?? Date.now();
  const hit = reads.get(chainId);
  let gasPriceWei: bigint | null = hit && !opts.fresh && now - hit.at < READ_TTL_MS ? hit.wei : null;
  if (gasPriceWei === null) {
    try {
      gasPriceWei = await client.getGasPrice();
      reads.set(chainId, { at: now, wei: gasPriceWei });
    } catch {
      return { ceilingWei, gasPriceWei: null, high: true };
    }
  }
  return { ceilingWei, gasPriceWei, high: gasPriceWei > ceilingWei };
}

/** Test hook: forget the cached reads. */
export function resetGasReads(): void {
  reads.clear();
}
