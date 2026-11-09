/**
 * Gloam relay client.
 *
 * Sends an already-proven private send, cash out or private swap through the
 * Gloam relay, so the sender's wallet (a person's or an agent's) never appears
 * next to the payment on a block explorer. The proof is the authorization and the cash-out
 * recipient is bound inside the proof, so a relay can only submit or refuse,
 * never redirect money. Deposits (shield) still come from the depositor's own
 * wallet, since that is where the money starts.
 */
import type { Address, Hex } from "viem";
import type { GloamIntent } from "./intents.js";
import { assertSwapSendable, type SwapRelayCall } from "./swapIntent.js";

export const GLOAM_RELAY_URL = "https://gloam.trade/api/relay";

export interface RelayOptions {
  /** Relay endpoint; defaults to the hosted Gloam relay. */
  url?: string;
  /** Custom fetch (tests, edge runtimes). */
  fetch?: typeof fetch;
}

export interface RelayNetworkStatus {
  chainId: number;
  key: string;
  enabled: boolean;
  relayer: Address | null;
  memo: boolean;
  lowBalance: boolean;
  /** Gas is over the relay's ceiling on this chain: nothing is sent until it falls. */
  gasHigh?: boolean;
  /** Where gas is dear: the smallest one-hop private swap the relay sends right now, in dollars. */
  swapFloorUsd?: number | null;
}

export class GloamRelayError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "GloamRelayError";
  }
}

/** Relay answers that don't say a send stayed unsent: it may still land, so nothing kept for it can go. */
export const RELAY_MAYBE_SENT: ReadonlySet<string> = new Set(["maybe_sent", "rpc", "network", "error", "internal", "in_flight"]);

async function post(body: Record<string, unknown>, opts: RelayOptions = {}): Promise<Hex> {
  const f = opts.fetch ?? fetch;
  const payload = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  let res: Response;
  try {
    res = await f(opts.url ?? GLOAM_RELAY_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
  } catch (e) {
    // A dropped connection can come after the relay took the request and sent it.
    throw new GloamRelayError(`No answer from the relay: ${e instanceof Error ? e.message : String(e)}`, "maybe_sent");
  }
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; hash?: Hex; error?: string; code?: string };
  if (!res.ok || !json.ok || !json.hash) {
    throw new GloamRelayError(json.error ?? `Relay error (${res.status})`, json.code ?? "error");
  }
  return json.hash;
}

/** Which networks the relay can submit on right now. */
export async function relayStatus(opts: RelayOptions = {}): Promise<RelayNetworkStatus[]> {
  const f = opts.fetch ?? fetch;
  const res = await f(opts.url ?? GLOAM_RELAY_URL, { method: "GET" });
  const json = (await res.json().catch(() => ({}))) as { networks?: RelayNetworkStatus[] };
  return Array.isArray(json.networks) ? json.networks : [];
}

/**
 * Submit a built private_send or unshield intent (from the SDK builders or
 * buildGloamPayment) through the relay. Returns the transaction hash.
 */
export async function relayIntent(intent: GloamIntent, opts: RelayOptions = {}): Promise<Hex> {
  const exec = intent.exec;
  if (!exec) throw new GloamRelayError("This intent has no resolved call to relay.", "no_exec");
  const a = exec.args;
  if (exec.fn === "transfer") {
    const [proof, root, nullifier, commitments] = a as readonly [Hex, Hex, Hex, readonly [Hex, Hex]];
    return post({ action: "transfer", chainId: intent.chainId, proof, root, nullifier, commitments }, opts);
  }
  if (exec.fn === "unshield") {
    const [proof, root, nullifier, asset, to, amount] = a as readonly [Hex, Hex, Hex, Address, Address, bigint];
    return post({ action: "unshield", chainId: intent.chainId, proof, root, nullifier, asset, to, amount }, opts);
  }
  throw new GloamRelayError(
    `Only private sends and cash outs can be relayed (got ${exec.fn}). Deposits come from your own wallet.`,
    "unsupported"
  );
}

/**
 * Post an encrypted payment message for a payment that already landed, so the
 * recipient finds it with their Gloam address. `memo` is the ticket bytes.
 */
export async function relayMemo(
  args: { chainId: number; paymentCommitment: Hex; memo: Hex },
  opts: RelayOptions = {}
): Promise<Hex> {
  return post({ action: "memo", ...args }, opts);
}

/**
 * Send a private swap, its refund or its exit (buildSwapIntent's `relay`,
 * buildSwapRefund's or buildSwapExit's) through the relay. Store the swap's
 * recovery record first (sendSwap does it for you). A swap whose deadline is
 * too close is refused here, as the relay would refuse it.
 */
export async function relaySwapCall(call: SwapRelayCall, opts: RelayOptions = {}): Promise<Hex> {
  if (call.action !== "swap" && call.action !== "swapExit") throw new GloamRelayError("Only a swap or a swap exit goes through relaySwapCall.", "unsupported");
  assertSwapSendable(call);
  return post({ ...call.body, action: call.action }, opts);
}
