/**
 * Gloam x402, scheme "gloam-cashout": a private payer and a public payee.
 *
 * Some x402 gateways pay out to a public address (a creator's splitter
 * contract) and settle standard "exact" payments in USDG on Robinhood Chain.
 * With gloam-cashout the payer stays private: the agent cashes out of its
 * private Gloam balance straight to the gateway's payTo. The chain shows USDG
 * leaving the Gloam vault to payTo. It does not show the agent's wallet (the
 * Gloam relay sends the cash out) or which deposit or payment funded it.
 *
 * The wire format, agreed with the gateway:
 *
 *   402 accepts entry  { scheme: "gloam-cashout", network: "eip155:4663",
 *                        asset: USDG, payTo: <0x splitter>, amount: G,
 *                        quoteId: <secret per-402 id>, maxTimeoutSeconds? }
 *   G (gross)          ceil(price * 10000 / (10000 - bps)) + tag, where bps is
 *                      the vault's live withdrawFeeBps() and tag is 1 to 9999,
 *                      unique per quote. The vault keeps floor(G * bps / 10000)
 *                      and sends the rest, at least the price, to payTo.
 *   the payment        a vault unshield of exactly G to payTo, which emits
 *                      Unshielded(nullifier, USDG, payTo, G)
 *   X-PAYMENT          base64 JSON { scheme: "gloam-cashout", txHash, quoteId }
 *
 * The gateway checks the receipt (verifyGloamCashout): the Unshielded log from
 * the vault with amount G, the USDG Transfer from the vault to payTo of at
 * least the price, a block time inside the quote window, and that it has not
 * seen the txHash before (its own store).
 *
 * Nothing secret leaves the payer: the header carries a public tx hash and the
 * gateway's own quoteId. Never the note, a key or the private balance.
 */
import { createPublicClient, getAddress, http, isAddress, isAddressEqual, pad, parseAbiItem, toEventSelector, type Address, type Hex, type PublicClient } from "viem";
import { fromB64, toB64 } from "./b64.js";
import { buildUnshieldIntent } from "./builders.js";
import { RH_MAINNET_CHAIN, RH_MAINNET_CHAIN_ID, RH_MAINNET_USDG, cashOutFee, cashOutTargetProblem } from "./constants.js";
import { readCashOutFeeBps, type FeeReader } from "./fee.js";
import type { GloamIntent, IntentExec } from "./intents.js";
import { MAINNET_POOLS } from "./mainnet.js";
import type { PoseidonMerklePath } from "./merkle.js";
import type { Prover } from "./prove.js";
import { relayIntent, type RelayOptions } from "./relay.js";
import { UNSHIELDED_EVENT } from "./swap.js";
import { GLOAM_X402_SCHEME } from "./x402.js";

export const GLOAM_CASHOUT_SCHEME = "gloam-cashout" as const;
/** CAIP-2 id of the only network the scheme runs on: Robinhood Chain mainnet. */
export const GLOAM_CASHOUT_NETWORK = "eip155:4663" as const;
export const GLOAM_CASHOUT_CHAIN_ID = RH_MAINNET_CHAIN_ID;
/** USDG on Robinhood Chain mainnet, 6 decimals. */
export const GLOAM_CASHOUT_ASSET: Address = getAddress(RH_MAINNET_USDG);
export const GLOAM_CASHOUT_DECIMALS = 6;
/** The Gloam vault on Robinhood Chain mainnet. The unshield, and so the Unshielded log, comes from here. */
export const GLOAM_CASHOUT_VAULT: Address = getAddress(MAINNET_POOLS[4663].pool!);
/** The per-quote tag added to the gross amount runs from 1 to this. */
export const GLOAM_CASHOUT_TAG_MAX = 9999;

/** One gloam-cashout entry in a 402's `accepts`, as read (parseGloamCashoutRequirement). */
export interface GloamCashoutRequirement {
  scheme: typeof GLOAM_CASHOUT_SCHEME;
  /** "eip155:4663" on the wire. A bare 4663 is read too. */
  network: string | number;
  asset: string;
  /** The public payee: the gateway's splitter address. */
  payTo: string;
  /** G, the gross amount the agent cashes out, in base units (6 decimals), as a decimal string. */
  amount: string;
  /** The gateway's secret id for this 402. Echoed back untouched in the payment header. */
  quoteId: string;
  /** x402's timeout for the paid retry, when the gateway sends one. */
  maxTimeoutSeconds?: number;
  /** When the quote stops being payable, unix seconds, when the gateway sends one. */
  expiresAt?: number;
  /** The vault the gateway expects the cash out from, when it names one. */
  vault?: string;
  resource?: string;
  description?: string;
  /** The entry's extra, untouched. */
  extra?: Record<string, unknown>;
}

/** What the agent sends back as X-PAYMENT, base64 JSON. */
export interface GloamCashoutPayment {
  scheme: typeof GLOAM_CASHOUT_SCHEME;
  txHash: Hex;
  quoteId: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A time in unix seconds from seconds, milliseconds, a numeric string or an ISO date; undefined otherwise. */
function unixSeconds(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v > 1e12 ? v / 1000 : v);
  if (typeof v === "string" && v.trim()) {
    const t = v.trim();
    if (/^\d+$/.test(t)) return unixSeconds(Number(t));
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return undefined;
}

/**
 * Read one x402 `accepts` entry as a gloam-cashout requirement, or null when it
 * is another scheme. Reads the fields as sent and checks none of them: run
 * gloamCashoutProblem before paying. quoteId is taken as is (top level, else
 * extra.quoteId) and never changed.
 */
export function parseGloamCashoutRequirement(entry: unknown): GloamCashoutRequirement | null {
  if (!isObj(entry) || entry.scheme !== GLOAM_CASHOUT_SCHEME) return null;
  const extra = isObj(entry.extra) ? entry.extra : undefined;
  const pick = (k: string): unknown => (entry[k] !== undefined ? entry[k] : extra?.[k]);
  const amount = entry.amount ?? entry.maxAmountRequired;
  const quoteId = pick("quoteId");
  const timeout = entry.maxTimeoutSeconds;
  const expiresAt = unixSeconds(pick("expiresAt") ?? pick("validBefore") ?? pick("expiry") ?? pick("expires"));
  const vault = pick("vault");
  return {
    scheme: GLOAM_CASHOUT_SCHEME,
    network: typeof entry.network === "number" ? entry.network : String(entry.network ?? ""),
    asset: String(entry.asset ?? ""),
    payTo: String(entry.payTo ?? ""),
    amount: typeof amount === "number" && Number.isSafeInteger(amount) ? String(amount) : typeof amount === "string" ? amount.trim() : "",
    quoteId: typeof quoteId === "string" ? quoteId : "",
    ...(typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? { maxTimeoutSeconds: timeout } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(typeof vault === "string" ? { vault } : {}),
    ...(typeof entry.resource === "string" ? { resource: entry.resource } : isObj(entry.resource) && typeof entry.resource.url === "string" ? { resource: entry.resource.url } : {}),
    ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    ...(extra ? { extra } : {}),
  };
}

type HeaderSource = Headers | Record<string, string | null | undefined> | null | undefined;
const headerOf = (h: HeaderSource, name: string): string | null => {
  if (!h) return null;
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name);
  const rec = h as Record<string, string | null | undefined>;
  const k = Object.keys(rec).find((x) => x.toLowerCase() === name);
  return k ? (rec[k] ?? null) : null;
};

/**
 * Every x402 `accepts` entry a 402 answer carries: the v2 PAYMENT-REQUIRED
 * header (base64 JSON) first, then a JSON body (v1 or v2). Anything that does
 * not parse is skipped.
 */
export function x402AcceptsOf(headers: HeaderSource, body: string | null | undefined): unknown[] {
  const out: unknown[] = [];
  const raw = headerOf(headers, "payment-required")?.trim();
  if (raw && !raw.startsWith("gloamx402req1:")) {
    try {
      const pr = JSON.parse(fromB64(raw)) as unknown;
      if (isObj(pr) && Array.isArray(pr.accepts)) out.push(...pr.accepts);
    } catch {
      /* not base64 JSON */
    }
  }
  const t = (body ?? "").trim();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t) as unknown;
      if (isObj(j) && Array.isArray(j.accepts)) out.push(...j.accepts);
    } catch {
      /* not JSON */
    }
  }
  return out;
}

/** The first gloam-cashout entry in a 402 answer (x402AcceptsOf), or null. */
export function findGloamCashoutRequirement(headers: HeaderSource, body: string | null | undefined): GloamCashoutRequirement | null {
  for (const e of x402AcceptsOf(headers, body)) {
    const r = parseGloamCashoutRequirement(e);
    if (r) return r;
  }
  return null;
}

export type GloamX402SchemeName = typeof GLOAM_X402_SCHEME | typeof GLOAM_CASHOUT_SCHEME;

/**
 * Which Gloam scheme to pay when a 402 offers one or both. With both, the
 * caller's `prefer` wins, and without one it is gloam-private, as before this
 * scheme existed (the payee stays private too). With only gloam-cashout,
 * alone or next to standard x402 (exact), it is gloam-cashout. A preference
 * for a scheme that is not offered falls back to the one that is.
 */
export function chooseGloamX402Scheme(
  offered: { gloamPrivate: boolean; gloamCashout: boolean },
  prefer?: GloamX402SchemeName | null
): GloamX402SchemeName | null {
  if (prefer === GLOAM_CASHOUT_SCHEME && offered.gloamCashout) return GLOAM_CASHOUT_SCHEME;
  if (prefer === GLOAM_X402_SCHEME && offered.gloamPrivate) return GLOAM_X402_SCHEME;
  if (offered.gloamPrivate) return GLOAM_X402_SCHEME;
  if (offered.gloamCashout) return GLOAM_CASHOUT_SCHEME;
  return null;
}

export type GloamCashoutRefusalCode =
  | "wrong_scheme"
  | "wrong_network"
  | "wrong_asset"
  | "wrong_vault"
  | "bad_payee"
  | "bad_amount"
  | "no_quote_id"
  | "no_max_amount"
  | "over_max_amount"
  | "expired";

export class GloamCashoutRefusal extends Error {
  constructor(
    readonly code: GloamCashoutRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "GloamCashoutRefusal";
  }
}

/** quoteId travels in a header: a non-empty string of at most this many characters. */
export const GLOAM_CASHOUT_QUOTE_ID_MAX = 1024;

export interface GloamCashoutCheckOptions {
  /**
   * The most the caller will cash out, in base units (6 decimals). Required: a
   * gloam-cashout payment is never made without a cap. Compared with G, the
   * gross amount, which is a little above the price (the vault's fee and the tag).
   */
  maxAmount: bigint | null | undefined;
  /** Now, in unix seconds. Default the clock. */
  now?: number;
}

/**
 * Why a gloam-cashout requirement must not be paid, or null when it can be:
 * network eip155:4663, asset USDG, the Gloam vault (when the entry names one),
 * payTo a 0x address a cash out can reach, amount a whole positive number, a
 * quoteId, a cap (maxAmount) at or above the amount, and not expired.
 */
export function gloamCashoutProblem(req: GloamCashoutRequirement, opts: GloamCashoutCheckOptions): GloamCashoutRefusal | null {
  const no = (code: GloamCashoutRefusalCode, m: string) => new GloamCashoutRefusal(code, m);
  if (!req || req.scheme !== GLOAM_CASHOUT_SCHEME) return no("wrong_scheme", `Not a ${GLOAM_CASHOUT_SCHEME} requirement.`);
  const network = String(req.network).trim();
  if (network !== GLOAM_CASHOUT_NETWORK && network !== String(GLOAM_CASHOUT_CHAIN_ID)) {
    return no("wrong_network", `A ${GLOAM_CASHOUT_SCHEME} payment runs on ${GLOAM_CASHOUT_NETWORK} (Robinhood Chain) only, not ${network || "an unnamed network"}.`);
  }
  if (!isAddress(String(req.asset), { strict: false }) || !isAddressEqual(req.asset as Address, GLOAM_CASHOUT_ASSET)) {
    return no("wrong_asset", `A ${GLOAM_CASHOUT_SCHEME} payment is in USDG (${GLOAM_CASHOUT_ASSET}), not ${req.asset || "an unnamed asset"}.`);
  }
  if (req.vault !== undefined && (!isAddress(req.vault, { strict: false }) || !isAddressEqual(req.vault as Address, GLOAM_CASHOUT_VAULT))) {
    return no("wrong_vault", `The quote names the vault ${req.vault}. Gloam's vault on Robinhood Chain is ${GLOAM_CASHOUT_VAULT}.`);
  }
  if (!isAddress(String(req.payTo), { strict: false })) return no("bad_payee", "payTo is not a 0x address.");
  const lost = cashOutTargetProblem(req.payTo, { chainId: GLOAM_CASHOUT_CHAIN_ID, pool: GLOAM_CASHOUT_VAULT });
  if (lost) return no("bad_payee", lost);
  if (!/^[0-9]{1,40}$/.test(String(req.amount)) || BigInt(req.amount) <= 0n) return no("bad_amount", "The amount is not a whole, positive number of base units.");
  if (typeof req.quoteId !== "string" || !req.quoteId || req.quoteId.length > GLOAM_CASHOUT_QUOTE_ID_MAX) {
    return no("no_quote_id", "The quote has no quoteId, so a payment could not be matched to it. Not paying.");
  }
  if (opts.maxAmount === undefined || opts.maxAmount === null) {
    return no("no_max_amount", `A ${GLOAM_CASHOUT_SCHEME} payment needs a maxAmount, the most you will cash out for it. Not paying.`);
  }
  if (BigInt(req.amount) > opts.maxAmount) {
    return no("over_max_amount", `The quote asks for ${req.amount} base units, more than the maxAmount of ${opts.maxAmount}. Not paying.`);
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (req.expiresAt !== undefined && now >= req.expiresAt) return no("expired", "The quote has expired. Ask the resource for a new one.");
  return null;
}

/** gloamCashoutProblem, thrown. Returns the amount G as a bigint and payTo checksummed. */
export function assertGloamCashoutPayable(req: GloamCashoutRequirement, opts: GloamCashoutCheckOptions): { gross: bigint; payTo: Address } {
  const p = gloamCashoutProblem(req, opts);
  if (p) throw p;
  return { gross: BigInt(req.amount), payTo: getAddress(req.payTo) };
}

// ── the payment header ────────────────────────────────────────────────────────

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** The X-PAYMENT value: base64 of the JSON { scheme, txHash, quoteId }, encoded as the SDK's other x402 headers are. */
export function encodeGloamCashoutHeader(p: { txHash: Hex; quoteId: string }): string {
  if (!TX_HASH.test(p.txHash)) throw new Error("txHash is not a transaction hash.");
  if (typeof p.quoteId !== "string" || !p.quoteId) throw new Error("A gloam-cashout payment needs the quote's quoteId.");
  const body: GloamCashoutPayment = { scheme: GLOAM_CASHOUT_SCHEME, txHash: p.txHash, quoteId: p.quoteId };
  return toB64(JSON.stringify(body));
}

/** Read an X-PAYMENT value as a gloam-cashout payment. Throws on anything else. */
export function decodeGloamCashoutHeader(h: string): GloamCashoutPayment {
  let o: unknown;
  try {
    o = JSON.parse(fromB64(h.trim()));
  } catch {
    throw new Error("The payment header is not base64 JSON.");
  }
  if (!isObj(o) || o.scheme !== GLOAM_CASHOUT_SCHEME) throw new Error(`The payment header is not a ${GLOAM_CASHOUT_SCHEME} payment.`);
  if (typeof o.txHash !== "string" || !TX_HASH.test(o.txHash)) throw new Error("The payment header has no valid txHash.");
  if (typeof o.quoteId !== "string" || !o.quoteId) throw new Error("The payment header has no quoteId.");
  return { scheme: GLOAM_CASHOUT_SCHEME, txHash: o.txHash as Hex, quoteId: o.quoteId };
}

// ── pricing (gateway side) ────────────────────────────────────────────────────

/**
 * G for a price: ceil(price * 10000 / (10000 - bps)) + tag. The vault keeps
 * floor(G * bps / 10000), so payTo gets at least the price. tag is 1 to 9999
 * and unique per open quote, so a cash out of G points at one quote.
 */
export function cashoutGross(price: bigint, tag: number | bigint, bps: number): bigint {
  if (price <= 0n) throw new Error("price must be positive");
  const t = BigInt(tag);
  if (t < 1n || t > BigInt(GLOAM_CASHOUT_TAG_MAX)) throw new Error(`tag must be 1 to ${GLOAM_CASHOUT_TAG_MAX}`);
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) throw new Error("bps must be an integer from 0 to 9999");
  const keep = 10_000n - BigInt(bps);
  return (price * 10_000n + keep - 1n) / keep + t;
}

export interface GloamCashoutQuoteAmounts {
  /** G: what the agent cashes out, and the Unshielded amount. */
  gross: bigint;
  feeBps: number;
  /** What the vault keeps from G. */
  fee: bigint;
  /** What payTo receives: G minus the fee, at least the price. */
  payeeReceives: bigint;
  tag: bigint;
}

/**
 * G for a price at the vault's fee right now (withdrawFeeBps, read live). Pass
 * a client on Robinhood Chain, an rpcUrl, or neither for the public RPC. The fee
 * can change on a 3-day timelock, so read it per quote, not once.
 */
export async function quoteGross(
  price: bigint,
  tag: number | bigint,
  opts: { client?: FeeReader; rpcUrl?: string } = {}
): Promise<GloamCashoutQuoteAmounts> {
  const client = opts.client ?? rhClient(opts.rpcUrl);
  const feeBps = await readCashOutFeeBps(client, GLOAM_CASHOUT_VAULT);
  const gross = cashoutGross(price, tag, feeBps);
  const fee = cashOutFee(gross, feeBps);
  return { gross, feeBps, fee, payeeReceives: gross - fee, tag: BigInt(tag) };
}

/** The 402 accepts entry for a quote (gateway side). quoteId is yours: keep it secret, one per 402. */
export function buildGloamCashoutRequirement(p: {
  payTo: Address;
  gross: bigint;
  quoteId: string;
  maxTimeoutSeconds?: number;
  expiresAt?: number;
  resource?: string;
  description?: string;
}): GloamCashoutRequirement {
  if (!isAddress(p.payTo, { strict: false })) throw new Error("payTo must be a 0x address");
  if (p.gross <= 0n) throw new Error("gross must be positive");
  if (!p.quoteId) throw new Error("quoteId is required");
  return {
    scheme: GLOAM_CASHOUT_SCHEME,
    network: GLOAM_CASHOUT_NETWORK,
    asset: GLOAM_CASHOUT_ASSET,
    payTo: getAddress(p.payTo),
    amount: p.gross.toString(),
    quoteId: p.quoteId,
    ...(p.maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds: p.maxTimeoutSeconds } : {}),
    ...(p.expiresAt !== undefined ? { expiresAt: p.expiresAt } : {}),
    ...(p.resource !== undefined ? { resource: p.resource } : {}),
    ...(p.description !== undefined ? { description: p.description } : {}),
  };
}

// ── paying (agent side) ───────────────────────────────────────────────────────

export interface GloamCashoutNote {
  secretHex: Hex;
  /** Must be exactly G: a cash out spends the whole note. Split a larger note first (a private send to yourself). */
  amountWei: bigint;
  path: PoseidonMerklePath;
}

export interface BuildGloamCashoutParams extends GloamCashoutCheckOptions {
  requirement: GloamCashoutRequirement;
  /** A USDG note of exactly G in the Robinhood Chain vault. */
  note: GloamCashoutNote;
  /** The unshield prover (artifactProver over the unshield circuit, mainnet keys). */
  prove: Prover;
}

/**
 * The unsigned cash out for a gloam-cashout quote: an unshield of exactly G of
 * USDG to payTo from the Robinhood Chain vault. Checks the quote first
 * (gloamCashoutProblem) and refuses a note that is not exactly G.
 */
export async function buildGloamCashoutIntent(params: BuildGloamCashoutParams): Promise<GloamIntent<"unshield"> & { exec: IntentExec; gross: bigint; payTo: Address }> {
  const { gross, payTo } = assertGloamCashoutPayable(params.requirement, params);
  if (params.note.amountWei !== gross) {
    throw new Error(
      `The note holds ${params.note.amountWei} base units and the quote asks for exactly ${gross}. A cash out spends a whole note: split one first with a private send to yourself (buildPrivateSendIntent), or use GloamAgent.payX402Cashout, which does it.`
    );
  }
  const intent = await buildUnshieldIntent({
    secretHex: params.note.secretHex,
    amountWei: gross,
    asset: GLOAM_CASHOUT_ASSET,
    to: payTo,
    path: params.note.path,
    prove: params.prove,
    poolAddress: GLOAM_CASHOUT_VAULT,
    chainId: GLOAM_CASHOUT_CHAIN_ID,
  });
  return { ...intent, gross, payTo };
}

export interface PayGloamCashoutParams extends BuildGloamCashoutParams {
  /** Reads on Robinhood Chain: waits for the receipt. */
  client: Pick<PublicClient, "waitForTransactionReceipt">;
  /** Sends the built intent and returns its tx hash. Default: the Gloam relay, so the agent's wallet never shows. */
  submit?: (intent: GloamIntent) => Promise<Hex>;
  relay?: RelayOptions;
}

export interface PaidGloamCashout {
  txHash: Hex;
  /** The X-PAYMENT value for the retry. */
  header: string;
  payment: GloamCashoutPayment;
  gross: bigint;
  payTo: Address;
  blockNumber: bigint;
}

/**
 * Pay a gloam-cashout quote: build the cash out of exactly G to payTo, send it
 * (the Gloam relay by default), wait until it is mined, check the receipt shows
 * the vault's Unshielded log for it, and return the txHash and the X-PAYMENT
 * header. A send that throws may still land: look its note up before paying
 * the same quote again.
 */
export async function payGloamCashout(params: PayGloamCashoutParams): Promise<PaidGloamCashout> {
  const intent = await buildGloamCashoutIntent(params);
  const submit = params.submit ?? ((i: GloamIntent) => relayIntent(i, params.relay));
  const txHash = await submit(intent);
  const receipt = await params.client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`The cash out reverted (${txHash}).`);
  const nullifier = intent.exec.args[2] as Hex;
  const logs = receipt.logs as readonly { address: string; topics: readonly string[]; data: string }[];
  if (!unshieldedLogs(logs).some((l) => same(l.address, GLOAM_CASHOUT_VAULT) && same(l.nullifier, nullifier) && same(l.to, intent.payTo) && l.amount === intent.gross)) {
    throw new Error(`The transaction ${txHash} succeeded, but the cash out inside it did not happen.`);
  }
  const payment: GloamCashoutPayment = { scheme: GLOAM_CASHOUT_SCHEME, txHash, quoteId: params.requirement.quoteId };
  return { txHash, header: encodeGloamCashoutHeader(payment), payment, gross: intent.gross, payTo: intent.payTo, blockNumber: receipt.blockNumber };
}

// ── verifying (gateway side) ──────────────────────────────────────────────────

const UNSHIELDED_TOPIC = toEventSelector(UNSHIELDED_EVENT);
const TRANSFER_TOPIC = toEventSelector(parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"));

type RawLog = { address: string; topics: readonly string[]; data: string };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const word = (a: string) => pad(a.toLowerCase() as Hex, { size: 32 });
const topicAddr = (t: string | undefined): string => (t && t.length === 66 ? `0x${t.slice(26)}` : "");
const amountOf = (data: string): bigint | null => {
  try {
    return BigInt(data && data !== "0x" ? data.slice(0, 66) : "0x0");
  } catch {
    return null;
  }
};

function unshieldedLogs(logs: readonly RawLog[]) {
  return logs
    .filter((l) => l.topics[0] === UNSHIELDED_TOPIC && l.topics.length === 4)
    .map((l) => ({ address: l.address, nullifier: l.topics[1]!, asset: topicAddr(l.topics[2]), to: topicAddr(l.topics[3]), amount: amountOf(l.data) }));
}

export interface GloamCashoutQuote {
  /** The splitter the quote pays. */
  payTo: Address;
  /** G, as quoted. */
  gross: bigint | string;
  /** The price: payTo must receive at least this. */
  price: bigint | string;
  /** When the quote was issued, unix seconds. */
  issuedAt: number;
  /** How long it stays payable, in seconds. The block that mined the cash out must fall in [issuedAt, issuedAt + windowSec]. */
  windowSec: number;
}

/** The reads verifyGloamCashout makes. A viem PublicClient on Robinhood Chain fits. */
export type GloamCashoutReader = Pick<PublicClient, "getTransactionReceipt" | "getBlock" | "getChainId">;

export type GloamCashoutVerifyCode =
  | "bad_tx_hash"
  | "bad_quote"
  | "wrong_chain"
  | "not_found"
  | "reverted"
  | "no_unshield"
  | "not_vault"
  | "wrong_payee"
  | "wrong_amount"
  | "short_transfer"
  | "outside_window";

export interface GloamCashoutVerdict {
  ok: boolean;
  code: GloamCashoutVerifyCode | null;
  reason: string | null;
  txHash: Hex;
  blockNumber?: bigint;
  /** The mining block's timestamp, unix seconds. */
  blockTime?: number;
  /** The spent note's nullifier, from the Unshielded log. */
  nullifier?: Hex;
  /** The USDG the vault sent payTo in that Transfer. */
  received?: bigint;
  /**
   * Not checked here: that this txHash was not used before. Keep every txHash
   * you accept in your own store (with its quoteId) and refuse it next time.
   */
  replay: string;
}

export const GLOAM_CASHOUT_REPLAY_NOTE =
  "Not checked here: that this txHash was not used before. Record every accepted txHash (with its quoteId) in your own store, atomically with granting access, and refuse it next time.";

/**
 * Gateway side: check a gloam-cashout payment against the quote it answers.
 *   1. the receipt exists on Robinhood Chain and succeeded
 *   2. it has Unshielded(nullifier, USDG, payTo, G) emitted by the Gloam vault
 *      (a log with that shape from any other contract does not count)
 *   3. it has a USDG Transfer from the vault to payTo of at least the price
 *   4. the block time is inside [issuedAt, issuedAt + windowSec]
 * ok is true only when all four pass. It does NOT check that the txHash is
 * unused: that store is yours (see `replay`). Pass a client, an rpcUrl, or
 * neither for the public Robinhood Chain RPC.
 */
export async function verifyGloamCashout(args: {
  txHash: Hex;
  quote: GloamCashoutQuote;
  rpcUrl?: string;
  client?: GloamCashoutReader;
}): Promise<GloamCashoutVerdict> {
  const { txHash, quote } = args;
  const base = { txHash, replay: GLOAM_CASHOUT_REPLAY_NOTE };
  const fail = (code: GloamCashoutVerifyCode, reason: string, extra: Partial<GloamCashoutVerdict> = {}): GloamCashoutVerdict => ({ ok: false, code, reason, ...base, ...extra });
  if (typeof txHash !== "string" || !TX_HASH.test(txHash)) return fail("bad_tx_hash", "That is not a transaction hash.");
  let gross: bigint;
  let price: bigint;
  try {
    gross = BigInt(quote.gross);
    price = BigInt(quote.price);
  } catch {
    return fail("bad_quote", "The quote's gross and price must be whole numbers of base units.");
  }
  if (!isAddress(String(quote.payTo), { strict: false })) return fail("bad_quote", "The quote's payTo is not a 0x address.");
  if (gross <= 0n || price <= 0n || price > gross) return fail("bad_quote", "The quote needs 0 < price <= gross.");
  if (!Number.isFinite(quote.issuedAt) || !Number.isFinite(quote.windowSec) || quote.windowSec <= 0) {
    return fail("bad_quote", "The quote needs issuedAt (unix seconds) and a positive windowSec.");
  }
  const client = args.client ?? (rhClient(args.rpcUrl) as unknown as GloamCashoutReader);
  const chainId = await client.getChainId();
  if (chainId !== GLOAM_CASHOUT_CHAIN_ID) return fail("wrong_chain", `The RPC reads chain ${chainId}, not Robinhood Chain (${GLOAM_CASHOUT_CHAIN_ID}).`);
  let receipt: Awaited<ReturnType<GloamCashoutReader["getTransactionReceipt"]>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return fail("not_found", "No receipt for that transaction yet. It may still be pending; check again shortly.");
  }
  if (!receipt) return fail("not_found", "No receipt for that transaction yet. It may still be pending; check again shortly.");
  const at = { blockNumber: receipt.blockNumber };
  if (receipt.status !== "success") return fail("reverted", "The transaction reverted.", at);

  const logs = receipt.logs as readonly RawLog[];
  const unshields = unshieldedLogs(logs).filter((l) => same(l.asset, GLOAM_CASHOUT_ASSET));
  const fromVault = unshields.filter((l) => same(l.address, GLOAM_CASHOUT_VAULT));
  if (!fromVault.length) {
    return unshields.length
      ? fail("not_vault", "The Unshielded log in this transaction was not emitted by the Gloam vault.", at)
      : fail("no_unshield", "This transaction has no USDG cash out from the Gloam vault.", at);
  }
  const toPayee = fromVault.filter((l) => same(l.to, quote.payTo));
  if (!toPayee.length) return fail("wrong_payee", "The cash out in this transaction pays a different address than the quote's payTo.", at);
  const exact = toPayee.find((l) => l.amount === gross);
  if (!exact) return fail("wrong_amount", `The cash out is for ${toPayee[0]!.amount ?? "an unreadable amount"}, not the quoted ${gross}.`, at);

  const transfers = logs
    .filter((l) => same(l.address, GLOAM_CASHOUT_ASSET) && l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3)
    .filter((l) => same(l.topics[1] ?? "", word(GLOAM_CASHOUT_VAULT)) && same(l.topics[2] ?? "", word(quote.payTo)))
    .map((l) => amountOf(l.data) ?? 0n);
  const received = transfers.reduce((m, v) => (v > m ? v : m), 0n);
  const found = { ...at, nullifier: exact.nullifier as Hex, received };
  if (received < price) {
    return fail("short_transfer", transfers.length ? `payTo received ${received} USDG base units, below the price of ${price}.` : "There is no USDG transfer from the vault to payTo.", found);
  }

  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const blockTime = Number(block.timestamp);
  if (blockTime < quote.issuedAt || blockTime > quote.issuedAt + quote.windowSec) {
    return fail("outside_window", `The cash out was mined at ${blockTime}, outside the quote window ${quote.issuedAt} to ${quote.issuedAt + quote.windowSec}.`, { ...found, blockTime });
  }
  return { ok: true, code: null, reason: null, ...base, ...found, blockTime };
}

function rhClient(rpcUrl?: string): PublicClient {
  return createPublicClient({ chain: RH_MAINNET_CHAIN, transport: http(rpcUrl ?? RH_MAINNET_CHAIN.rpcUrls.default.http[0]) }) as PublicClient;
}
