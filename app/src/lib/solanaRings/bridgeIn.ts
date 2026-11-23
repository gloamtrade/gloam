/**
 * Bring money from another chain into a private balance on Solana, through
 * Relay (relay.link). Shared by the browser, /api/bridge/solana and the
 * self-tests; nothing here touches the network.
 *
 * The path, in one step for the person:
 *  1. Relay delivers to the private account's own Solana address (SOL, USDC or
 *     USDT), paid from an EVM wallet (it signs an approve and a deposit on its
 *     chain) or sent to a one-time deposit address from any wallet or exchange.
 *  2. The private account deposits what arrived into its private balance, with
 *     Gloam's relay as fee payer (lib/solanaRings/arrivals). The relay policy
 *     allows exactly that deposit (relayPolicy readDeposit): the account never
 *     needs SOL, and the main Solana wallet never appears.
 *
 * Public: the chain paid from, Relay's delivery to the private account, and the
 * deposit (asset and amount) on Solana. Private after that: the asset and the
 * amount of everything the account does.
 *
 * Money that reached the private account but isn't private yet (a tab closed
 * mid-way, the relay paused) stays at its address and is found again on the
 * next visit (arrivalsFrom), so it is never lost track of.
 *
 * Off unless NEXT_PUBLIC_SOLANA_BRIDGE_IN is "1". Relay only delivers to
 * mainnet; NEXT_PUBLIC_BRIDGE_PREVIEW=1 shows it on a devnet build too.
 *
 * Routes checked with live Relay quotes on 2026-11-23 (no API key, no funds):
 * every chain in BRIDGE_CHAINS but Blast (Relay: "Origin chain 81457 not
 * supported") gave a deposit address into Solana USDC, and Base, Arbitrum,
 * Ethereum, BNB Chain, Robinhood Chain, Tempo and Tron into USDT and SOL; a
 * wallet on Base got its [approve, deposit] into USDC. 20 USDC from Base landed
 * about 19.84 USDC.
 */
import { BRIDGE_CHAINS, type BridgeAppFee, type BridgeChain, type BridgeStage, type BridgeToken } from "../bridge";
import { RELAYED_DEPOSIT_MIN } from "./relayPolicy";
import { ringsAssets, RINGS_SOL_MINT, SOLANA_RINGS_NETWORK, type RingsAsset, type RingsNetwork } from "./config";

export const SOLANA_BRIDGE_IN_ENABLED = process.env.NEXT_PUBLIC_SOLANA_BRIDGE_IN === "1";

/** Shown with the flag on, on mainnet; on a devnet build only as a preview. */
export function solanaBridgeVisible(network: RingsNetwork = SOLANA_RINGS_NETWORK): boolean {
  return SOLANA_BRIDGE_IN_ENABLED && (network === "mainnet" || process.env.NEXT_PUBLIC_BRIDGE_PREVIEW === "1");
}

/** Relay's id for Solana. */
export const RELAY_SOLANA_CHAIN_ID = 792703809;

/** Chains Relay refused as a source into Solana on 2026-11-23. */
export const SOLANA_BRIDGE_UNSUPPORTED: ReadonlySet<number> = new Set([81457]);

/** Where money can come from: every bridge chain but Solana itself (Add covers that) and the ones Relay refused. */
export function solanaBridgeSources(chains: readonly BridgeChain[] = BRIDGE_CHAINS): BridgeChain[] {
  return chains.filter((c) => c.kind !== "svm" && !SOLANA_BRIDGE_UNSUPPORTED.has(c.id));
}

/** How Relay names a listed asset on Solana: its mint, or the system program's address for SOL. */
export function relayCurrency(asset: RingsAsset): string {
  return asset.mint ?? RINGS_SOL_MINT;
}

/** The assets money can land as, stablecoins first: the listed ones Relay delivers. Mainnet's, since Relay only delivers there. */
export function landingAssets(network: RingsNetwork = "mainnet"): readonly RingsAsset[] {
  const order = ["usdc", "usdt", "sol"];
  return order.map((id) => ringsAssets(network).find((a) => a.id === id)).filter((a): a is RingsAsset => Boolean(a));
}

/** What a token lands as by default: USDT stays USDT, everything else becomes USDC. */
export function defaultLanding(token: Pick<BridgeToken, "symbol">, ready: Record<string, boolean> = {}): string {
  const want = /^USDT/.test(token.symbol) ? "usdt" : "usdc";
  return ready[want] === false ? (ready.usdc === false ? "sol" : "usdc") : want;
}

/** A Relay order into a private account on Solana. */
export type SolanaBridgeQuote = {
  requestId: string;
  /** The one-time deposit address on the source chain; empty when the wallet pays (evmTxs). */
  depositAddress: string;
  /** What the connected EVM wallet signs in order: an approve, then the deposit; or the deposit alone. */
  evmTxs: { to: string; data: string; value: string; chainId: number }[] | null;
  send: { amount: string; symbol: string; chain: string; chainId: number; logo: string; usd: number | null };
  /** What lands at the private account, then goes private whole. */
  receive: { amount: string; minimum: string; symbol: string; assetId: string; decimals: number; logo: string };
  /** Where Relay returns the money if it can't deliver: the paying wallet, or the address given. */
  refundTo: string;
  /** Everything taken in fees: Relay's, and Gloam's own when it takes one (appFee). */
  feeUsd: number;
  appFee: BridgeAppFee | null;
  /** The paying chain's network fee, when Relay prices it (the wallet pays it). */
  gasUsd: number | null;
  timeSec: number;
  bitcoin: boolean;
};

// ---------------------------------------------------------------- a transfer on its way

/**
 * A transfer this browser started, kept until its money is private (or the
 * person starts over), so a closed tab picks it up again. Holds nothing secret:
 * Relay's request id, the deposit address and what was quoted.
 */
export type TrackedBridge = {
  v: 1;
  requestId: string;
  depositAddress: string;
  mode: "wallet" | "address";
  send: SolanaBridgeQuote["send"];
  receive: SolanaBridgeQuote["receive"];
  refundTo: string;
  /** The deposit's hash on the source chain, when the wallet paid and said so. */
  hash: string | null;
  /** The wallet gave no clear answer on the deposit. */
  unsure: boolean;
  /**
   * How much of the landing asset was already waiting at the account when this
   * transfer started, in base units: only more than that is this transfer's
   * money arriving (it all goes private together).
   */
  baseline?: string;
  feeUsd: number;
  appFee: BridgeAppFee | null;
  timeSec: number;
  bitcoin: boolean;
  startedAt: number;
};

export function trackedFrom(
  q: SolanaBridgeQuote,
  mode: TrackedBridge["mode"],
  now: number,
  sent: { hash?: string | null; unsure?: boolean; baseline?: bigint } = {}
): TrackedBridge {
  return {
    v: 1,
    requestId: q.requestId,
    depositAddress: mode === "address" ? q.depositAddress : "",
    mode,
    send: q.send,
    receive: q.receive,
    refundTo: q.refundTo,
    hash: sent.hash ?? null,
    unsure: Boolean(sent.unsure),
    ...(sent.baseline && sent.baseline > 0n ? { baseline: sent.baseline.toString() } : {}),
    feeUsd: q.feeUsd,
    appFee: q.appFee,
    timeSec: q.timeSec,
    bitcoin: q.bitcoin,
    startedAt: now,
  };
}

/** An address left waiting this long, never paid, is no longer offered (its money, if any, still shows as arrived). */
export const TRACKED_STALE_MS = 24 * 60 * 60 * 1000;

export const trackedKey = (network: RingsNetwork, account: string) => `gloam:solana-bridge:v1:${network}:${account}`;

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

/** The transfer on its way for this private account, read back safely (anything malformed is no transfer). */
export function loadTracked(store: KV | null, key: string): TrackedBridge | null {
  try {
    const raw = store?.getItem(key);
    if (!raw) return null;
    const t = JSON.parse(raw) as Partial<TrackedBridge>;
    const ok =
      t?.v === 1 &&
      typeof t.requestId === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(t.requestId) &&
      typeof t.depositAddress === "string" &&
      (t.mode === "wallet" || t.mode === "address") &&
      typeof t.send?.amount === "string" &&
      typeof t.receive?.assetId === "string" &&
      typeof t.startedAt === "number";
    return ok ? (t as TrackedBridge) : null;
  } catch {
    return null;
  }
}

export function saveTracked(store: KV | null, key: string, t: TrackedBridge | null): void {
  try {
    if (t) store?.setItem(key, JSON.stringify(t));
    else store?.removeItem(key);
  } catch {
    // private mode or full storage: the money still shows as arrived on the next visit
  }
}

// ---------------------------------------------------------------- money at the private account's own address

/** Money sitting at the private account's address, not private yet: one deposit each. */
export type Arrival = {
  assetId: string;
  /** Everything there, in base units: all of it goes private. */
  amount: bigint;
  /** The token account it sits in; null for SOL. */
  tokenAccount: string | null;
};

/**
 * What is waiting at the private account's address, from its SOL balance and
 * its token accounts: each listed asset at or over the least the relay will
 * deposit. A frozen token account can't be moved, so it is left out.
 */
export function arrivalsFrom(
  held: { lamports: bigint; tokens: readonly { account: string; mint: string; amount: bigint; frozen?: boolean }[] },
  network: RingsNetwork = SOLANA_RINGS_NETWORK
): Arrival[] {
  const out: Arrival[] = [];
  for (const a of ringsAssets(network)) {
    const min = RELAYED_DEPOSIT_MIN[a.id];
    if (min === undefined) continue;
    if (!a.mint) {
      if (held.lamports >= min) out.push({ assetId: a.id, amount: held.lamports, tokenAccount: null });
      continue;
    }
    for (const t of held.tokens) {
      if (t.mint === a.mint && !t.frozen && t.amount >= min) out.push({ assetId: a.id, amount: t.amount, tokenAccount: t.account });
    }
  }
  return out;
}

/** An SPL token account's mint, owner, amount and state, from its 165 bytes. Null when it isn't one. */
export function readTokenAccount(data: Uint8Array): { mint: Uint8Array; owner: Uint8Array; amount: bigint; frozen: boolean } | null {
  if (data.length < 165) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const state = data[108];
  if (state !== 1 && state !== 2) return null;
  return { mint: data.slice(0, 32), owner: data.slice(32, 64), amount: view.getBigUint64(64, true), frozen: state === 2 };
}

// ---------------------------------------------------------------- the flow

/** Making arrived money private. */
export type ShieldState =
  | { kind: "idle" }
  | { kind: "arrived"; amount: bigint }
  | { kind: "working"; amount: bigint }
  | { kind: "failed"; amount: bigint; message: string };

export type Flow =
  | { kind: "form"; error: string | null }
  | { kind: "quoting" }
  | { kind: "review"; quote: SolanaBridgeQuote; at: number; signing: boolean; progress: string | null; error: string | null }
  | { kind: "track"; t: TrackedBridge; relay: BridgeStage; shield: ShieldState; qr: string | null }
  | { kind: "landed"; t: TrackedBridge; amount: bigint; signature: string | null };

export type FlowEvent =
  | { type: "quoting" }
  | { type: "quoteFailed"; error: string }
  | { type: "review"; quote: SolanaBridgeQuote; at: number }
  | { type: "signing"; quote?: SolanaBridgeQuote; at?: number; progress: string | null }
  | { type: "signFailed"; error: string }
  | { type: "track"; t: TrackedBridge }
  | { type: "qr"; requestId: string; qr: string }
  | { type: "status"; stage: BridgeStage }
  | { type: "arrived"; amount: bigint }
  /** Nothing of the landing asset is at the address any more. */
  | { type: "gone" }
  | { type: "shielding" }
  | { type: "shielded"; amount: bigint; signature: string | null }
  | { type: "shieldFailed"; message: string }
  | { type: "reset"; error?: string | null };

export const FORM: Flow = { kind: "form", error: null };

function baselineOf(t: TrackedBridge): bigint {
  try {
    return BigInt(t.baseline ?? "0");
  } catch {
    return 0n;
  }
}

/**
 * The flow's one place of change. A transfer is tracked from the moment there
 * is something to follow (a deposit address shown, or the wallet's deposit
 * sent): Relay's word moves it along; money at the private account wins over
 * any later Relay word, since it is there either way; making it private either
 * lands (done) or fails and can be tried again, the money staying put.
 */
export function flowReducer(s: Flow, e: FlowEvent): Flow {
  switch (e.type) {
    case "reset":
      return { kind: "form", error: e.error ?? null };
    case "quoting":
      return s.kind === "form" || s.kind === "review" ? { kind: "quoting" } : s;
    case "quoteFailed":
      return s.kind === "quoting" ? { kind: "form", error: e.error } : s.kind === "review" ? { ...s, signing: false, progress: null, error: e.error } : s;
    case "review":
      return s.kind === "quoting" || s.kind === "review" ? { kind: "review", quote: e.quote, at: e.at, signing: false, progress: null, error: null } : s;
    case "signing":
      return s.kind === "review"
        ? { ...s, ...(e.quote ? { quote: e.quote } : {}), ...(e.at ? { at: e.at } : {}), signing: true, progress: e.progress, error: null }
        : s;
    case "signFailed":
      return s.kind === "review" ? { ...s, signing: false, progress: null, error: e.error } : s;
    case "track":
      return { kind: "track", t: e.t, relay: "waiting", shield: { kind: "idle" }, qr: null };
    case "qr":
      return s.kind === "track" && s.t.requestId === e.requestId ? { ...s, qr: e.qr } : s;
    case "status":
      // Relay can only move forward; once money is at the account, its word no longer decides anything.
      if (s.kind !== "track") return s;
      if (s.relay === "done" || s.relay === "refunded" || (s.relay === "failed" && e.stage !== "refunded")) return s;
      if (s.relay === "moving" && e.stage === "waiting") return s;
      return { ...s, relay: e.stage };
    case "arrived":
      if (s.kind !== "track" || e.amount <= 0n) return s;
      if (s.shield.kind === "idle") return e.amount > baselineOf(s.t) ? { ...s, shield: { kind: "arrived", amount: e.amount } } : s;
      if (s.shield.kind === "failed") return { ...s, shield: { ...s.shield, amount: e.amount } };
      if (s.shield.kind === "arrived") return { ...s, shield: { kind: "arrived", amount: e.amount } };
      return s;
    case "gone":
      if (s.kind !== "track") return s;
      // It was here and now isn't: it went private (another tab, or an answer that came late).
      if (s.shield.kind === "arrived" || s.shield.kind === "failed") return { kind: "landed", t: s.t, amount: s.shield.amount, signature: null };
      // What was waiting before this transfer went private on its own: anything from now on is this transfer's.
      if (s.shield.kind === "idle" && s.t.baseline) {
        const { baseline: _gone, ...t } = s.t;
        void _gone;
        return { ...s, t };
      }
      return s;
    case "shielding":
      return s.kind === "track" && (s.shield.kind === "arrived" || s.shield.kind === "failed") ? { ...s, shield: { kind: "working", amount: s.shield.amount } } : s;
    case "shielded":
      return s.kind === "track" ? { kind: "landed", t: s.t, amount: e.amount, signature: e.signature } : s;
    case "shieldFailed":
      return s.kind === "track" && s.shield.kind === "working" ? { ...s, shield: { kind: "failed", amount: s.shield.amount, message: e.message } } : s;
  }
}

/** Where a tracked transfer stands, in the words the panel uses. */
export type TrackPhase = "waiting" | "moving" | "arrived" | "shielding" | "notPrivate" | "refunded" | "failed";

export function trackPhase(s: Extract<Flow, { kind: "track" }>): TrackPhase {
  if (s.shield.kind === "working") return "shielding";
  if (s.shield.kind === "failed") return "notPrivate";
  if (s.shield.kind === "arrived") return "arrived";
  if (s.relay === "refunded") return "refunded";
  if (s.relay === "failed") return "failed";
  if (s.relay === "done") return "arrived";
  return s.relay === "moving" ? "moving" : "waiting";
}

/** Whether to look for the money at the private account: always while tracked and not yet private. */
export function watchingArrivals(s: Flow): boolean {
  return s.kind === "track" && s.shield.kind !== "working";
}

/** Whether to ask Relay how it stands: until it is finished, or the money is here. */
export function watchingRelay(s: Flow): boolean {
  return s.kind === "track" && s.shield.kind === "idle" && (s.relay === "waiting" || s.relay === "moving");
}

/** A tracked transfer the card still offers: anything moving, and an unpaid address for a day. */
export function trackedLive(t: TrackedBridge | null, now: number): boolean {
  return Boolean(t && now - t.startedAt < TRACKED_STALE_MS);
}

/** The plain words for where Relay returns money that can't be delivered. */
export function refundPlace(t: Pick<TrackedBridge, "mode" | "send">): string {
  return t.mode === "wallet" ? `your wallet on ${t.send.chain}` : `your ${t.send.chain} address`;
}

/** The one line on what is public, said wherever money comes in from another chain. */
export const SOLANA_BRIDGE_PRIVACY_NOTE =
  "Bridging in is public, like any deposit: the chain you pay from and Relay show it. Once private on Solana, the token and amount stay hidden.";
