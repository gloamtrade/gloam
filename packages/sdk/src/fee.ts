/**
 * The vault's cash-out fee, read live.
 *
 * Every payments vault keeps a fee on whatever leaves it: a cash out, and the
 * note a private swap spends. It was 0.25% at launch and 0.5% (CASH_OUT_FEE_BPS)
 * from 3 November 2026, and the owner can change it through the vault's 3-day
 * timelock, so a number built into this package can go stale. Read it from the vault (withdrawFeeBps) whenever an
 * amount depends on it; the swap planner and buildUnshieldIntent (given a client)
 * do. cashOutFee(amount, bps) is the vault's own rounding.
 */
import type { Address, PublicClient } from "viem";
import { cashOutFee } from "./constants.js";

export const POOL_FEE_ABI = [
  { type: "function", name: "withdrawFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
] as const;

/** The reads a fee check needs; a viem PublicClient fits. */
export type FeeReader = Pick<PublicClient, "readContract">;

/**
 * The vault's cash-out fee right now, in basis points. It is taken when a cash
 * out lands, so this is what one sent now pays. Throws when it can't be read
 * (the Robinhood Chain and Tempo testnet pools have no fee to read), so a caller
 * never prices with a guess. Anything outside 0 to 10,000 is refused the same way.
 */
export async function readCashOutFeeBps(client: FeeReader, pool: Address): Promise<number> {
  const raw = await client.readContract({ address: pool, abi: POOL_FEE_ABI, functionName: "withdrawFeeBps" });
  const bps = Number(raw);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error(`The vault at ${pool} answered a fee of ${String(raw)}, which is not a fee.`);
  return bps;
}

/** What the vault keeps from `amount` leaving it, at the fee it charges right now. */
export async function cashOutFeeLive(client: FeeReader, pool: Address, amount: bigint): Promise<{ feeBps: number; fee: bigint; receives: bigint }> {
  const feeBps = await readCashOutFeeBps(client, pool);
  const fee = cashOutFee(amount, feeBps);
  return { feeBps, fee, receives: amount - fee };
}
