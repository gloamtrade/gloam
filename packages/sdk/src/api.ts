/**
 * Gloam API client (v1), for partners.
 *
 * Partners get an API key at https://gloam.trade/partners. Payments relayed
 * with the key are attributed to the partner, who sets their own fee and sees
 * volume and commissions in the portal. Partner fees are not collected yet, on
 * mainnet or testnet: the portal shows the fees your setting would apply, and
 * responses say charged: false. On mainnet the pool itself keeps Gloam's 0.5%
 * cash-out fee (see cashOutFee).
 *
 *   const gloam = new GloamApiClient({ apiKey: process.env.GLOAM_API_KEY! });
 *   const { hash } = await gloam.relay(sendIntent);          // private payment
 *   await gloam.relaySwap(swapIntent.relay);                  // private swap (store swapIntent.recovery first)
 *   await gloam.attributeDeposit({ chainId, txHash });        // a deposit your app made
 *   const report = await gloam.verifyProof("gloamfunds1:...");
 *
 * Keep the key on your server. The API does not answer browsers on other
 * sites (no CORS), so call it from your backend.
 *
 * Every response is { v: 1, ok, data | error: { code, message }, requestId };
 * the client returns `data` and throws GloamApiError with the code otherwise.
 */
import type { Address, Hex } from "viem";
import type { GloamNetworkKey } from "./constants.js";
import type { GloamIntent } from "./intents.js";
import { RELAY_MAYBE_SENT } from "./relay.js";
import type { SweepSubmitter } from "./sweep.js";
import { assertSwapSendable, type SwapRelayCall } from "./swapIntent.js";

export const GLOAM_API_URL = "https://gloam.trade";

export interface GloamApiOptions {
  /** gloam_live_... for the mainnets, gloam_test_... for the testnets. */
  apiKey: string;
  /** Defaults to https://gloam.trade. */
  baseUrl?: string;
  /** Custom fetch (tests, edge runtimes). */
  fetch?: typeof fetch;
}

export class GloamApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly requestId: string | null
  ) {
    super(message);
    this.name = "GloamApiError";
  }
}

export type PartnerActivityKind = "private_payment" | "cash_out" | "deposit" | "private_swap";

export interface PartnerActivity {
  id: string;
  kind: PartnerActivityKind;
  network: string;
  chainId: number;
  txHash: Hex;
  ts: number;
  keyId: string | null;
  asset: Address | null;
  symbol: string | null;
  decimals: number | null;
  amount: string | null;
  volumeUsd: number | null;
  feeUsd: number | null;
  feeToken: string | null;
  feeBasis: string;
}

export type RelayAttribution =
  | { recorded: true; kind: PartnerActivityKind; activity: PartnerActivity }
  | { recorded: false; kind: PartnerActivityKind | null; reason: "not_billable" | "duplicate" | "storage_error" };

export interface ApiRelayResult {
  hash: Hex;
  chainId: number;
  network: string;
  action: "transfer" | "unshield" | "memo" | "swap" | "swapExit";
  attribution: RelayAttribution;
  /** False today on every network: partner fees are shown, not yet taken. */
  charged: boolean;
}

export interface ApiProofCheck {
  label: string;
  state: "pass" | "fail" | "unknown";
  detail?: string;
}

export interface ApiProofReport {
  /** gloamdisc1 (the older balance disclosure) is never ok: anyone can copy one from a public deposit. */
  format: "gloamfunds1" | "gloampay1" | "gloamroll1" | "gloambal1" | "gloamdisc1";
  kind: "funds" | "payment" | "payroll" | "balance";
  ok: boolean;
  expired: boolean;
  checks: ApiProofCheck[];
  paidAt: number | null;
  paidBetween: [number, number] | null;
  claims: Record<string, unknown>;
  /** The network the proof names, when Gloam runs on it. `testnet: true` means test funds, never mainnet. */
  network?: { chainId: number; key: string; name: string; testnet: boolean } | null;
}

export interface ApiPaymentRequest {
  url: string;
  network: string;
  asset: { symbol: string; address: Address; decimals: number };
  amount: string | null;
  note: string | null;
  name: string | null;
}

/** A swap quote from the partner API (POST /api/v1/swaps/quote). Amounts are decimal strings of base units. */
export interface ApiSwapQuote {
  network: string;
  chainId: number;
  router: Address;
  routerVersion: 1 | 2 | 3;
  venue: "v4" | "tempo";
  assetIn: Address;
  assetOut: Address;
  amountIn: string;
  feeBps: number;
  available: string | null;
  amountOut: string | null;
  cost: string | null;
  leftover: string | null;
  route: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }[];
  hops: number;
  impactBps: number | null;
  pegBps: number | null;
  warnings: string[];
  /** The first thing that keeps this swap from going, or null. */
  stop: { code: string; message: string; fitsIn?: string; maxIn?: string; floorUsd?: number } | null;
  limits: { maxIn: string | null; outRoom: string | null };
  relay: { enabled: boolean; gasHigh: boolean } | null;
  floorUsd: number | null;
  valueChecked: false;
  deadlineSeconds: number;
  quotedAt: number;
  ttlMs: number;
  public: string;
}

/** One network's private swaps (GET /api/v1/swaps). */
export interface ApiSwapNetwork {
  network: string;
  chainId: number;
  label: string;
  testnet: boolean;
  live: boolean;
  router: Address | null;
  version: 1 | 2 | 3 | null;
  venue: "v4" | "tempo" | null;
  maxHops: number | null;
  deadlineSeconds: number | null;
  assets: { address: Address; symbol: string | null; decimals: number | null; native: boolean; opensLater: boolean }[];
  earlierRouters: { address: Address; version: 1 | 2 | 3 }[];
}

const KEY_RE = /^gloam_(test|live)_[A-Za-z0-9_-]{43}$/;

/** The relay body for a built private_send or unshield intent (same as /api/relay takes). */
export function relayBodyFor(intent: GloamIntent): Record<string, unknown> {
  const exec = intent.exec;
  if (!exec) throw new GloamApiError("This intent has no resolved call to relay.", "no_exec", 0, null);
  const a = exec.args;
  if (exec.fn === "transfer") {
    const [proof, root, nullifier, commitments] = a as readonly [Hex, Hex, Hex, readonly [Hex, Hex]];
    return { action: "transfer", chainId: intent.chainId, proof, root, nullifier, commitments: [...commitments] };
  }
  if (exec.fn === "unshield") {
    const [proof, root, nullifier, asset, to, amount] = a as readonly [Hex, Hex, Hex, Address, Address, bigint];
    return { action: "unshield", chainId: intent.chainId, proof, root, nullifier, asset, to, amount: amount.toString() };
  }
  throw new GloamApiError(
    `Only private sends and cash outs can be relayed (got ${exec.fn}). Deposits come from the depositor's own wallet; attribute them with attributeDeposit.`,
    "unsupported",
    0,
    null
  );
}

export class GloamApiClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly f: typeof fetch;

  constructor(opts: GloamApiOptions) {
    if (!opts || typeof opts.apiKey !== "string" || !KEY_RE.test(opts.apiKey.trim())) {
      throw new GloamApiError("apiKey must be a Gloam API key (gloam_test_... or gloam_live_...).", "invalid_key", 0, null);
    }
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl ?? GLOAM_API_URL).replace(/\/+$/, "");
    this.f = opts.fetch ?? fetch;
  }

  /** "test" or "live", from the key. */
  get env(): "test" | "live" {
    return this.apiKey.startsWith("gloam_live_") ? "live" : "test";
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.f(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      });
    } catch {
      throw new GloamApiError("Could not reach the Gloam API.", "network", 0, null);
    }
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      data?: T;
      error?: { code?: string; message?: string };
      requestId?: string;
    } | null;
    if (!res.ok || !json || json.ok !== true) {
      throw new GloamApiError(
        json?.error?.message ?? `Gloam API error (${res.status})`,
        json?.error?.code ?? "error",
        res.status,
        json?.requestId ?? null
      );
    }
    return json.data as T;
  }

  /** The partner and key behind this key. A cheap way to test a key. */
  me() {
    return this.request<{
      partner: { id: string; name: string; website: string | null; fees: Record<string, number>; payout: Record<string, Address> };
      key: { id: string; env: "test" | "live" };
      rateLimit: { limit: number; windowSec: number; remaining: number };
      charged: boolean;
    }>("GET", "/me");
  }

  /** Submit a built private_send or unshield intent through the relay, attributed to you. */
  relay(intent: GloamIntent): Promise<ApiRelayResult> {
    return this.request<ApiRelayResult>("POST", "/relay", relayBodyFor(intent));
  }

  /**
   * Send a private swap, its refund or its exit (buildSwapIntent's `relay`,
   * buildSwapRefund's or buildSwapExit's) through the relay with this key. A swap
   * is counted to you like a payment, never charged. Store the swap's recovery
   * record before calling this (sendSwap with swapSubmitter() does it for you).
   */
  relaySwap(call: SwapRelayCall): Promise<ApiRelayResult> {
    if (call.action !== "swap" && call.action !== "swapExit") {
      return Promise.reject(new GloamApiError("Only a swap or a swap exit goes through relaySwap.", "unsupported", 0, null));
    }
    assertSwapSendable(call);
    return this.request<ApiRelayResult>("POST", "/relay", { ...call.body, action: call.action });
  }

  /** A submitter for sendSwap that relays with this key. An unclear answer is marked maybeSent: the swap may still land. */
  swapSubmitter(): (call: SwapRelayCall) => Promise<Hex> {
    return async (call) => {
      try {
        return (await this.relaySwap(call)).hash;
      } catch (e) {
        // only a clear refusal says nothing went out; a swap refused before sending (SwapRefusedError) never reached the relay
        if (!(e instanceof GloamApiError) || !RELAY_MAYBE_SENT.has(e.code)) throw e;
        throw Object.assign(e, { maybeSent: true });
      }
    };
  }

  /** Private swaps on every network: live or not, the router, what it swaps between. */
  swapNetworks() {
    return this.request<{ networks: ApiSwapNetwork[]; public: string }>("GET", "/swaps");
  }

  /**
   * Quote a private swap on the server, with the stops the Gloam app applies. Read only.
   * `amountIn` is the whole note's value in base units. quoteSwap in this SDK gives the
   * same price from your own RPC.
   */
  swapQuote(args: { chainId?: number; network?: GloamNetworkKey; assetIn: Address; assetOut: Address; amountIn: bigint | string; via?: "relay" | "wallet" }) {
    return this.request<ApiSwapQuote>("POST", "/swaps/quote", { ...args, amountIn: args.amountIn.toString() });
  }

  /** Post an encrypted payment message for a payment that already landed. */
  relayMemo(args: { chainId: number; paymentCommitment: Hex; memo: Hex }): Promise<ApiRelayResult> {
    return this.request<ApiRelayResult>("POST", "/relay", { action: "memo", ...args });
  }

  /** A submitter for settleGloamPayment / sweepReceivedNote that relays with this key. */
  submitter(): SweepSubmitter {
    return async (intent) => {
      try {
        return (await this.relay(intent)).hash;
      } catch (e) {
        // Only a clear refusal says nothing went out. The rest may still land, so the sweep keeps its fresh note.
        if (e instanceof GloamApiError && !RELAY_MAYBE_SENT.has(e.code)) throw e;
        throw Object.assign(e as Error, { maybeSent: true });
      }
    };
  }

  /** Attribute a deposit your app made (at most 24 hours old), by its transaction hash. */
  attributeDeposit(args: { chainId: number; txHash: Hex }) {
    return this.request<{ activity: PartnerActivity; charged: boolean }>("POST", "/deposits", args);
  }

  /** Your attributed volume and would-be commissions, with up to `limit` recent items. */
  activity(limit = 50) {
    return this.request<Record<string, unknown>>("GET", `/activity?limit=${Math.max(1, Math.min(200, Math.floor(limit)))}`);
  }

  relayStatus() {
    return this.request<{ networks: { chainId: number; key: string; enabled: boolean; memo: boolean; lowBalance: boolean }[] }>(
      "GET",
      "/relay"
    );
  }

  vaults() {
    return this.request<{ vaults: Record<string, unknown>[] }>("GET", "/vaults");
  }

  vault(network: GloamNetworkKey) {
    return this.request<{ vault: Record<string, unknown> }>("GET", `/vaults/${network}`);
  }

  /** The vault's public leaf list. Rebuild the tree and check the root on chain before use. */
  leaves(network: GloamNetworkKey) {
    return this.request<{ chainId: number; pool: Address; toBlock: string; leafCount: number; items: unknown[] }>(
      "GET",
      `/vaults/${network}/leaves`
    );
  }

  /** Check a gloamfunds1 / gloampay1 / gloamroll1 / gloambal1 / gloamdisc1 proof on the server. */
  verifyProof(proof: string): Promise<ApiProofReport> {
    return this.request<ApiProofReport>("POST", "/proofs/verify", { proof });
  }

  /** A payment request link; the details ride after the # so no server sees them later. */
  paymentRequest(args: {
    to: string;
    network?: GloamNetworkKey;
    asset: string;
    amount?: string;
    note?: string;
    name?: string;
  }): Promise<ApiPaymentRequest> {
    return this.request<ApiPaymentRequest>("POST", "/payment-requests", args);
  }

  /** Public vault figures, as on /transparency. */
  stats() {
    return this.request<Record<string, unknown>>("GET", "/stats");
  }
}
