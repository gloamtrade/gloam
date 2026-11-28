/**
 * $GLOAM holder rebates: holders pay 0.2% to cash out instead of 0.5%.
 *
 * Every vault charges one cash-out fee to everyone (withdrawFeeBps, 50 bps), so
 * the holder rate is paid as a rebate: once a week the treasury sends back the
 * difference on each cash-out that went to a wallet holding at least
 * HOLDER_MIN_GLOAM $GLOAM on Robinhood Chain, in the coin the fee was taken in.
 * The same wallet address counts on every chain.
 *
 * This file is the arithmetic only: which cash-outs qualify and what each
 * wallet gets back. scripts/holder-rebates.mts reads the chains and writes the
 * payout list. Nothing here moves money; the treasury sends the payouts.
 */

/** The cash-out fee a holder ends up paying, in basis points (0.2%). */
export const HOLDER_FEE_BPS = 20n;

/** $GLOAM a wallet must hold on Robinhood Chain to count as a holder. */
export const HOLDER_MIN_GLOAM = 1_000n;

/** When the rebate started: cash-outs before this are not rebated. */
export const REBATE_START = "2026-11-21T00:00:00Z";

/** One cash-out read from a vault: Unshielded plus the WithdrawFee beside it. */
export type CashOut = {
  chainId: number;
  network: string;
  txHash: `0x${string}`;
  nullifier: `0x${string}`;
  /** Token address, lowercased, or "native" for the chain's own coin. */
  asset: string;
  /** The wallet the cash-out paid, lowercased. */
  to: string;
  /** The amount proven, before the fee (Unshielded.amount). */
  amount: bigint;
  /** What the vault kept (WithdrawFee.fee). */
  fee: bigint;
  block: bigint;
  /** Unix seconds. */
  time: number;
};

/** The ledger key of a cash-out: one rebate per cash-out, ever. */
export function cashOutKey(c: Pick<CashOut, "chainId" | "nullifier">): string {
  return `${c.chainId}:${c.nullifier.toLowerCase()}`;
}

/**
 * What a holder gets back for one cash-out: the fee kept, less what the holder
 * rate would have kept, never below zero. Rounded down, so the treasury never
 * sends back more than the vault took.
 */
export function rebateFor(amount: bigint, fee: bigint, holderBps: bigint = HOLDER_FEE_BPS): bigint {
  if (amount <= 0n || fee <= 0n) return 0n;
  const holderFee = (amount * holderBps) / 10_000n;
  return fee > holderFee ? fee - holderFee : 0n;
}

export type Payout = {
  chainId: number;
  network: string;
  asset: string;
  to: string;
  /** Sum of the rebates for this wallet, chain and coin. */
  amount: bigint;
  /** The cash-outs it covers, by ledger key. */
  cashOuts: string[];
};

export type RebatePlan = {
  payouts: Payout[];
  /** Cash-outs that qualified, by ledger key, rebate per cash-out. */
  rebated: { key: string; rebate: bigint }[];
  /** Why the rest did not: counted per reason. */
  skipped: Record<"paid before" | "no fee" | "not a holder" | "gloam wallet" | "before start", number>;
};

/**
 * The payouts for a set of cash-outs. `isHolder(to)` says whether the wallet
 * held enough $GLOAM; `alreadyPaid` holds the ledger keys of cash-outs an
 * earlier plan covered; `excluded` holds Gloam's own wallets and contracts
 * (the treasury, swap routers), which are never rebated.
 */
export function planRebates(
  cashOuts: CashOut[],
  opts: {
    isHolder: (to: string) => boolean;
    alreadyPaid: Set<string>;
    excluded: Set<string>;
    startTime: number;
    holderBps?: bigint;
  }
): RebatePlan {
  const skipped: RebatePlan["skipped"] = {
    "paid before": 0,
    "no fee": 0,
    "not a holder": 0,
    "gloam wallet": 0,
    "before start": 0,
  };
  const rebated: RebatePlan["rebated"] = [];
  const byWallet = new Map<string, Payout>();
  const seen = new Set<string>();

  for (const c of [...cashOuts].sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0))) {
    const key = cashOutKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    if (opts.alreadyPaid.has(key)) {
      skipped["paid before"]++;
      continue;
    }
    if (c.time < opts.startTime) {
      skipped["before start"]++;
      continue;
    }
    const to = c.to.toLowerCase();
    if (opts.excluded.has(to)) {
      skipped["gloam wallet"]++;
      continue;
    }
    const rebate = rebateFor(c.amount, c.fee, opts.holderBps);
    if (rebate === 0n) {
      skipped["no fee"]++;
      continue;
    }
    if (!opts.isHolder(to)) {
      skipped["not a holder"]++;
      continue;
    }
    rebated.push({ key, rebate });
    const asset = c.asset.toLowerCase();
    const slot = `${c.chainId}:${asset}:${to}`;
    const p = byWallet.get(slot) ?? { chainId: c.chainId, network: c.network, asset, to, amount: 0n, cashOuts: [] };
    p.amount += rebate;
    p.cashOuts.push(key);
    byWallet.set(slot, p);
  }

  const payouts = [...byWallet.values()].sort(
    (a, b) => a.chainId - b.chainId || a.asset.localeCompare(b.asset) || (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0)
  );
  return { payouts, rebated, skipped };
}
