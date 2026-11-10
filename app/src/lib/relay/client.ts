/**
 * Gloam relay, browser side. See lib/relay/server.ts for what the relay will
 * and will not do. Everything here degrades to "send from your wallet".
 */
import type { Address, Hex, PublicClient } from "viem";
import { getRhPublicClient } from "@/lib/rhClient";
import { readDemo } from "@/lib/demoFlag";
import { demoRelay, demoRelayStatus, demoWaitForTx } from "@/lib/demo/chain";
import type { EscrowKey, PoolKey } from "@/lib/vaultSwap";

export type RelayNetworkStatus = {
  chainId: number;
  key: string;
  enabled: boolean;
  relayer: Address | null;
  memo: boolean;
  lowBalance: boolean;
  /** Gas is over the relay's ceiling here (Ethereum): relayed sends wait until it comes down. */
  gasHigh?: boolean;
  /** The relay's gas ceiling in gwei, null on chains with none. */
  maxGasGwei?: string | null;
  /** The gas price in gwei on chains with a ceiling. */
  gasGwei?: string | null;
  /** The relay takes prepaid top-ups here. */
  topUps?: boolean;
  /** The relay pays for a fresh wallet's gas station here. */
  gasStation?: boolean;
  /** The smallest one-hop private swap right now, in dollars, where gas is dear. */
  swapFloorUsd?: number | null;
};

const PREF_KEY = "gloam.relay.pref";
let statusCache: { at: number; networks: RelayNetworkStatus[] } | null = null;

/** Relay availability per network (cached for a minute). */
export async function fetchRelayStatus(force = false): Promise<RelayNetworkStatus[]> {
  // Recording demo: the relay is always up and nothing is ever posted to it.
  if (readDemo()) return demoRelayStatus();
  if (!force && statusCache && Date.now() - statusCache.at < 60_000) return statusCache.networks;
  try {
    const res = await fetch("/api/relay", { cache: "no-store" });
    const json = (await res.json()) as { ok?: boolean; networks?: RelayNetworkStatus[] };
    const networks = json.ok && Array.isArray(json.networks) ? json.networks : [];
    statusCache = { at: Date.now(), networks };
    return networks;
  } catch {
    return [];
  }
}

export async function relayFor(chainId: number, force = false): Promise<RelayNetworkStatus | null> {
  const all = await fetchRelayStatus(force);
  return all.find((n) => n.chainId === chainId) ?? null;
}

/** User preference: hide my wallet by relaying (default on). */
export function relayPreferred(): boolean {
  try {
    return window.localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setRelayPreferred(on: boolean) {
  try {
    window.localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    /* ignore */
  }
}

export class RelaySubmitError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message);
  }
}

/** A send that never got an answer from the relay (the fetch itself failed): it may or may not have arrived. */
export const RELAY_UNREACHABLE_MESSAGE = "Could not reach the relay. Check your connection.";

/** What the relay answers a send: the hash, and for a transfer the payment's memo ticket. */
type RelayReply = { hash: Hex; memoTicket?: string | null };

async function post(body: Record<string, unknown>): Promise<RelayReply> {
  if (readDemo()) return { hash: await demoRelay(body) };
  let res: Response;
  try {
    res = await fetch("/api/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    });
  } catch {
    throw new RelaySubmitError(RELAY_UNREACHABLE_MESSAGE, "network");
  }
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    hash?: Hex;
    memoTicket?: string | null;
    error?: string;
    code?: string;
  };
  if (!res.ok || !json.ok || !json.hash) {
    throw new RelaySubmitError(json.error ?? "The relay could not submit this payment.", json.code ?? "error");
  }
  return { hash: json.hash, memoTicket: json.memoTicket };
}

/**
 * Memo tickets from this tab's relayed transfers, by payment commitment. The
 * relay hands one back with each transfer (lib/relay/server memoTicket); sent
 * with that payment's message, it gets the payer's own few, which strangers
 * copying the public commitment can't use up. Memory only: a message posted
 * after a reload goes without one and shares the strangers' allowance.
 */
const memoTickets = new Map<string, string>();
const MEMO_TICKETS_MAX = 500;

function keepMemoTicket(commitment: Hex, ticket: unknown) {
  if (typeof ticket !== "string" || !ticket) return;
  if (memoTickets.size >= MEMO_TICKETS_MAX) {
    const oldest = memoTickets.keys().next().value;
    if (oldest !== undefined) memoTickets.delete(oldest);
  }
  memoTickets.set(commitment.toLowerCase(), ticket);
}

export async function relayTransfer(p: {
  chainId: number;
  proof: Hex;
  root: Hex;
  nullifier: Hex;
  commitments: readonly [Hex, Hex];
  /** A partner's link code: the relay counts the payment to them once it lands (lib/partnerAttribution). */
  partnerCode?: string;
}): Promise<Hex> {
  const { hash, memoTicket } = await post({ action: "transfer", ...p });
  // commitments[0] is the payment, the one its heads-up is for
  keepMemoTicket(p.commitments[0], memoTicket);
  return hash;
}

export async function relayUnshield(p: {
  chainId: number;
  proof: Hex;
  root: Hex;
  nullifier: Hex;
  asset: Address;
  to: Address;
  amount: bigint;
  /** A partner's link code: the relay counts the cash out to them once it lands. */
  partnerCode?: string;
}): Promise<Hex> {
  return (await post({ action: "unshield", ...p })).hash;
}

/** One gas station step for a fresh wallet (lib/relay/gasStation): only the wallet and the step go to the relay. */
export async function relayGasStation(p: { chainId: number; wallet: Address; step: "make" | "pump" }): Promise<Hex> {
  return (await post({ action: "gas-station", ...p })).hash;
}

/** A private swap through the vault (lib/vaultSwap). Only the relay ever submits one. */
export async function relayVaultSwap(p: {
  chainId: number;
  /** The router: the swap's own, so a refund goes back through the router its swap used. */
  router: Address;
  spend: { proof: Hex; root: Hex; nullifier: Hex; asset: Address; amount: bigint };
  deposit: { proof: Hex; commitment: Hex; asset: Address; amount: bigint };
  refund: { proof: Hex; commitment: Hex; asset: Address; amount: bigint };
  route: readonly PoolKey[];
  /** A refund: the transaction that paid its escrow. */
  unshieldTx?: Hex;
  /** v3: the swap's exit key and deadline. */
  exitKey?: Address;
  deadline?: bigint;
  /** A partner's link code: the relay counts the swap to them once it lands. */
  partnerCode?: string;
}): Promise<Hex> {
  return (await post({ action: "swap", ...p })).hash;
}

/** Sends a swap's waiting money to the address its exit key signed for (lib/vaultSwapRun exitVaultSwap). */
export async function relayVaultSwapExit(p: {
  chainId: number;
  router: Address;
  asset: Address;
  key: Required<EscrowKey>;
  to: Address;
  signature: Hex;
  /** The transaction that paid its escrow. */
  unshieldTx: Hex;
}): Promise<Hex> {
  return (await post({ action: "swapExit", ...p })).hash;
}

/**
 * The relay reads the payment from its own node, which can be a few seconds
 * behind the one that confirmed it here: "not in the vault yet" is tried again.
 */
export const MEMO_NOT_SEEN_RETRY = { tries: 3, delayMs: 2_500 };

/** A payment's heads-up, with its memo ticket when this tab relayed the payment. */
export async function relayMemo(p: { chainId: number; paymentCommitment: Hex; memo: Hex }): Promise<Hex> {
  const ticket = memoTickets.get(p.paymentCommitment.toLowerCase());
  for (let attempt = 1; ; attempt++) {
    try {
      return (await post({ action: "memo", ...p, ...(ticket ? { ticket } : {}) })).hash;
    } catch (e) {
      if (!(e instanceof RelaySubmitError && e.code === "not_seen") || attempt >= MEMO_NOT_SEEN_RETRY.tries) throw e;
      await new Promise((r) => setTimeout(r, MEMO_NOT_SEEN_RETRY.delayMs));
    }
  }
}

/** Wait for a relayed tx on the active network. */
/** `client` is the chain the transaction went to; the active network's when left out. */
export async function waitForTx(hash: Hex, timeoutMs = 120_000, client: PublicClient = getRhPublicClient()): Promise<"success" | "reverted"> {
  if (readDemo()) return demoWaitForTx(hash, timeoutMs);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 1_000 });
  return receipt.status === "success" ? "success" : "reverted";
}
