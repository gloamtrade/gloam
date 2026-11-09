/**
 * The partner relay (POST /api/v1/relay): one proven action sent through the Gloam
 * relay's own functions (lib/relay/server), then counted to the partner whose key sent
 * it (lib/partners recordActivity). Nothing is ever charged.
 *
 * What is counted, and from what:
 *   transfer  a private payment, with nothing about it but that it happened
 *   unshield  a cash out, with its asset and amount (public inputs of its proof)
 *   swap      a private swap, with its input's asset and amount (public inputs of
 *             its unshield proof), but only when the vault read the note as unspent
 *             just before the send: a spent note can only take the refund path,
 *             which brings money back and is not a swap
 *   memo      a payment message, not counted
 *   swapExit  a swap's money leaving by its exit key, not counted
 * A refund or an exit is claimed for the partner without being counted, so its
 * transaction can't later be attributed as a swap or a deposit.
 * Whether a swap is new is read from the vault, never taken from the request.
 * A cash out's and a swap's vault fee is recorded with it: the amount times the
 * vault's withdrawFeeBps, read after the send (cached a few minutes), the way
 * the vault works it out. A fee that can't be read is left unknown.
 * A count is made when the relay sends, before the transaction is mined. When its
 * receipt then shows a revert (the relay watches every send it makes), the count is
 * taken back exactly (lib/partners reverseActivity), so a partner's numbers hold only
 * transactions that landed.
 *
 * Server only. The relay functions and the vault read are injectable for tests.
 */
import type { Address, Hex } from "viem";
import { logSafe } from "./logSafe";
import { claimTransaction, recordActivity, reverseActivity, type ActivityKind, type ActivityRecord, type Partner } from "./partners";
import type { GloamNetwork } from "./networks";
import { swapRouterFor } from "./vaultSwap";
import {
  RelayError,
  asAddress,
  asAmount,
  asBytes32,
  relayMemo,
  relayPoolAbi,
  relayPublicClient,
  relayTransfer,
  relayUnshield,
  relayVaultSwap,
  relayVaultSwapExit,
  type MemoPartner,
  type Sender,
  type SendHooks,
} from "./relay/server";

export type PartnerRelayAction = "transfer" | "unshield" | "memo" | "swap" | "swapExit";
export const PARTNER_RELAY_ACTIONS: readonly PartnerRelayAction[] = ["transfer", "unshield", "memo", "swap", "swapExit"];

export type Attribution =
  | { recorded: true; kind: ActivityKind; activity: ActivityRecord }
  | { recorded: false; kind: ActivityKind | null; reason: "not_billable" | "duplicate" | "storage_error" };

export type PartnerRelayDeps = {
  relayTransfer: (net: GloamNetwork, body: Record<string, unknown>, sender?: Sender, hooks?: SendHooks) => Promise<Hex>;
  relayUnshield: (net: GloamNetwork, body: Record<string, unknown>, sender?: Sender, hooks?: SendHooks) => Promise<Hex>;
  relayMemo: (net: GloamNetwork, body: Record<string, unknown>, from?: MemoPartner) => Promise<Hex>;
  relayVaultSwap: (net: GloamNetwork, body: Record<string, unknown>, sender?: Sender, hooks?: SendHooks) => Promise<Hex>;
  relayVaultSwapExit: (net: GloamNetwork, body: Record<string, unknown>, sender?: Sender) => Promise<Hex>;
  /** The vault's spent(nullifier), read on the relay's own node. */
  isSpent: (net: GloamNetwork, nullifier: Hex) => Promise<boolean>;
  record: typeof recordActivity;
  /** Takes back a count whose transaction reverted. */
  reverse: typeof reverseActivity;
  /** Claims a transaction for the partner without counting it (a refund, an exit). */
  claim: typeof claimTransaction;
  /** The vault's cash-out fee in basis points, or null when it can't be read. */
  vaultFeeBps: (net: GloamNetwork) => Promise<number | null>;
};

const feeBpsCache = new Map<number, { at: number; bps: number }>();
const FEE_BPS_TTL_MS = 5 * 60_000;

/** withdrawFeeBps on the relay's own node, cached; null on any failure. */
async function readVaultFeeBps(net: GloamNetwork): Promise<number | null> {
  const hit = feeBpsCache.get(net.chainId);
  if (hit && Date.now() - hit.at < FEE_BPS_TTL_MS) return hit.bps;
  try {
    const bps = Number(
      await Promise.race([
        relayPublicClient(net).readContract({ address: net.pool!, abi: feeBpsAbi, functionName: "withdrawFeeBps" }),
        new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), 2_000)),
      ])
    );
    if (!Number.isInteger(bps) || bps < 0 || bps > 100) return null;
    feeBpsCache.set(net.chainId, { at: Date.now(), bps });
    return bps;
  } catch {
    return null;
  }
}

const feeBpsAbi = [
  { type: "function", name: "withdrawFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
] as const;

/** The vault's fee on an amount: floor(amount * bps / 10,000), as unshield() keeps it. */
export function vaultFeeOn(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10_000n;
}

export const partnerRelayDeps: PartnerRelayDeps = {
  relayTransfer,
  relayUnshield,
  relayMemo,
  relayVaultSwap,
  relayVaultSwapExit,
  isSpent: async (net, nullifier) =>
    Boolean(await relayPublicClient(net).readContract({ address: net.pool!, abi: relayPoolAbi, functionName: "spent", args: [nullifier] })),
  record: recordActivity,
  reverse: reverseActivity,
  claim: claimTransaction,
  vaultFeeBps: readVaultFeeBps,
};

export class UnknownRelayAction extends RelayError {
  constructor() {
    super('action must be "transfer", "unshield", "memo", "swap" or "swapExit".', 400, "bad_action");
  }
}

/**
 * Sends one action and counts it to `partner`. A transaction that was sent is never
 * failed over accounting: a storage error comes back as attribution.reason.
 */
export async function relayForPartner(
  /** `sender`: who holds a share of the network's cap for the send (the partner account, and the calling IP for an account no admin approved), as the relay takes it. */
  args: { net: GloamNetwork; body: Record<string, unknown>; partner: Partner; keyId: string; sender?: Sender },
  deps: PartnerRelayDeps = partnerRelayDeps
): Promise<{ hash: Hex; action: PartnerRelayAction; attribution: Attribution }> {
  const { net, body, partner, keyId, sender } = args;
  let hash: Hex;
  let kind: ActivityKind | null = null;
  let edge: { asset: Address; amount: bigint } | null = null;
  /** Sent and not counted, but claimed for this partner (a refund, an exit). */
  let claimed: Hex | null = null;
  // A send whose receipt shows a revert is taken back from the count, whichever of the
  // count and the receipt comes first (the receipt is read after the reply).
  let reverted = false;
  let counted: Hex | null = null;
  const takeBack = (tx: Hex) =>
    deps.reverse(net.chainId, tx).then(
      () => undefined,
      (e: unknown) => console.error("gloam_api_reverse", logSafe(e))
    );
  const hooks: SendHooks = {
    onEnd: async (status) => {
      if (status !== "reverted" || reverted) return;
      reverted = true;
      if (counted) await takeBack(counted);
    },
  };
  switch (body.action) {
    case "transfer":
      hash = await deps.relayTransfer(net, body, sender, hooks);
      kind = "private_payment";
      break;
    case "unshield":
      hash = await deps.relayUnshield(net, body, sender, hooks);
      kind = "cash_out";
      // Public inputs of the cash-out proof, already validated by the relay.
      edge = { asset: asAddress(body.asset, "asset"), amount: asAmount(body.amount) };
      break;
    case "memo":
      // an approved partner's messages share the paid budget (lib/relay/server relayMemo)
      hash = await deps.relayMemo(net, body, { partner: partner.id, approved: partner.relayApproved === true });
      break;
    case "swap": {
      // the relay's own first refusal, before anything is read from the chain
      if (!swapRouterFor(net.chainId)) throw new RelayError("Private swaps are not live on this network yet.", 400, "no_swap");
      const spend = (body.spend ?? {}) as Record<string, unknown>;
      const nullifier = asBytes32(spend.nullifier, "nullifier");
      const swapEdge = { asset: asAddress(spend.asset, "asset"), amount: asAmount(spend.amount) };
      // Read before the send: a note already spent can only take the refund path, which is not a swap.
      let spent: boolean;
      try {
        spent = await deps.isSpent(net, nullifier);
      } catch {
        throw new RelayError("Could not read the vault right now. Nothing was sent. Try again shortly.", 503, "check_failed");
      }
      hash = await deps.relayVaultSwap(net, body, sender, hooks);
      if (!spent) {
        kind = "private_swap";
        // The swap's input: public inputs of its unshield proof, which the relay's dry run checked.
        edge = swapEdge;
      } else claimed = hash;
      break;
    }
    case "swapExit":
      hash = await deps.relayVaultSwapExit(net, body, sender);
      claimed = hash;
      break;
    default:
      throw new UnknownRelayAction();
  }

  if (claimed) {
    const tx = claimed;
    // The transaction is already sent: a storage error never fails the response.
    await deps.claim(partner, net.chainId, tx).catch((e: unknown) => console.error("gloam_api_claim", logSafe(e)));
  }

  let attribution: Attribution;
  if (!kind) {
    attribution = { recorded: false, kind: null, reason: "not_billable" };
  } else {
    try {
      // the vault's own fee on a cash out or a swap's input: never fails the response
      const bps = edge ? await deps.vaultFeeBps(net).catch(() => null) : null;
      const vaultFee = edge && bps != null ? vaultFeeOn(edge.amount, bps) : null;
      const r = await deps.record({ partner, keyId, network: net, kind, txHash: hash, edge, vaultFee, source: "api" });
      if (r.recorded) {
        counted = hash;
        // its receipt already showed a revert: take it back now
        if (reverted) await takeBack(hash);
      }
      attribution = r.recorded ? { recorded: true, kind, activity: r.record } : { recorded: false, kind, reason: r.reason };
    } catch (e) {
      console.error("gloam_api_attribution", logSafe(e));
      attribution = { recorded: false, kind, reason: "storage_error" };
    }
  }
  return { hash, action: body.action as PartnerRelayAction, attribution };
}
