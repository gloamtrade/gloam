/**
 * The "gloam" payment method, intent "charge": shapes, parsing and bindings.
 *
 * A gloam charge is paid with a private transfer inside the Gloam shielded
 * pool. The payment output is a note the payer creates for exactly the
 * requested amount and asset; it travels in the credential sealed to the
 * payee's receive tag, so only the payee can open it. The public chain sees a
 * shielded transfer (a nullifier and two commitments) and nothing else.
 *
 * Wire shapes (see docs/mpp/draft-gloam-charge-00.md):
 *
 *   request  { amount, currency, recipient: "gloamr1.…", description?, externalId?,
 *              methodDetails: { chainId, pool, decimals?, supportedModes? } }
 *   payload  { type: "hash", hash, ticket, binding }                       (push)
 *            { type: "transfer", transfer: { proof, root, nullifier,
 *                                            newCommitments }, ticket, binding } (pull)
 */

import type { Address, Hex } from "viem";
import {
  buildGloamPaymentRequirements,
  isReceiveTag,
  getGloamNetwork,
  gloamNetworks,
  isMainnetChainId,
  elysiumMainnetConfig,
  ELYSIUM_TESTNET,
  ELYSIUM_TESTNET_CHAIN_ID,
  networkForChainId,
  networkName,
  BASE_EURC,
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_EURC,
  BASE_SEPOLIA_USDC,
  BASE_USDC,
  BASE_USDT,
  ETHEREUM_EURC,
  ETHEREUM_MAINNET_CHAIN_ID,
  ETHEREUM_PYUSD,
  ETHEREUM_USDC,
  ETHEREUM_USDG,
  ETHEREUM_USDT,
  ETHEREUM_SEPOLIA_CHAIN_ID,
  ETHEREUM_SEPOLIA_EURC,
  ETHEREUM_SEPOLIA_PYUSD,
  ETHEREUM_SEPOLIA_USDC,
  ETHEREUM_SEPOLIA_USDG,
  GLOAM_TOKEN,
  NATIVE_ASSET,
  RH_MAINNET_CHAIN_ID,
  RH_MAINNET_USDG,
  RH_USDG,
  TEMPO_OUSD,
  TEMPO_PATHUSD,
  TEMPO_MAINNET_CHAIN_ID,
  TEMPO_USDCE,
  TEMPO_USDT0,
  type GloamNetwork,
  type GloamNetworkKey,
  type GloamPaymentRequirements,
} from "@gloamtrade/sdk";
import { canonicalJson, hmacBase64url, type PaymentChallenge } from "./wire.js";

export const GLOAM_METHOD = "gloam" as const;
export const GLOAM_CHARGE_INTENT = "charge" as const;
/** Domain separator of the credential's challenge binding. */
export const GLOAM_BINDING_DOMAIN = "gloam-mpp-charge-v1" as const;

/** push: the payer broadcasts its own transfer. pull: the server submits it. */
export type GloamMode = "push" | "pull";
export const GLOAM_MODES: readonly GloamMode[] = ["push", "pull"];

export interface GloamChargeMethodDetails {
  /** Chain the shielded pool lives on: Tempo 4217 or Robinhood Chain 4663 (mainnet), Tempo Moderato 42431 or Robinhood Chain testnet 46630; Base 8453, Base Sepolia 84532 and Ethereum 1 once their pools are in; Elysium mainnet once the SDK has its values. */
  chainId: number;
  /** The Gloam pool the transfer settles through. Clients and servers accept only the official pool for chainId. */
  pool: Address;
  /** Token decimals, for display only. */
  decimals?: number;
  /** Submission modes the server accepts. Absent means both. */
  supportedModes?: GloamMode[];
}

export interface GloamChargeRequest {
  /** Base units, as a decimal string. */
  amount: string;
  /** Token address; the zero address is the chain's native unit. */
  currency: Address;
  /** The payee's receive tag (gloamr1.…). The payment note is sealed to it. */
  recipient: string;
  description?: string;
  externalId?: string;
  methodDetails: GloamChargeMethodDetails;
}

/** The payer's transfer call, transfer(proof, root, nullifier, newCommitments) on the pool. */
export interface GloamTransferCall {
  proof: Hex;
  root: Hex;
  nullifier: Hex;
  /** [payment note, change note]. The first is the payment. */
  newCommitments: [Hex, Hex];
}

export interface GloamHashPayload {
  type: "hash";
  /** The payer's transfer transaction, already broadcast. */
  hash: Hex;
  /** The payment note package (gloam1.…) sealed to the recipient tag (gloam2t.…). */
  ticket: string;
  /** base64url HMAC-SHA256 keyed by the payment note secret over the challenge. */
  binding: string;
}

export interface GloamTransferPayload {
  type: "transfer";
  transfer: GloamTransferCall;
  ticket: string;
  binding: string;
}

export type GloamChargePayload = GloamHashPayload | GloamTransferPayload;

/** Receipt fields for a gloam charge (on top of status, method, timestamp, reference). */
export interface GloamChargeReceipt {
  status: "success";
  method: typeof GLOAM_METHOD;
  timestamp: string;
  /** The sweep transaction that moved the payment into a note only the payee knows. */
  reference: Hex;
  challengeId: string;
  chainId: number;
  externalId?: string;
  [field: string]: unknown;
}

/** A charge failure, with the Problem Details code a server should answer with. */
export class GloamChargeError extends Error {
  constructor(
    readonly code:
      | "verification-failed"
      | "invalid-payload"
      | "invalid-challenge"
      | "payment-expired"
      | "bad-request"
      | "method-unsupported",
    message: string,
    /** True when the same credential may succeed later (the transfer is not mined yet, a sweep is unconfirmed). */
    readonly retryable = false
  ) {
    super(message);
    this.name = "GloamChargeError";
  }
}

// ── the official pools ───────────────────────────────────────────────────────

/** chainId -> official Gloam pool. Pass your own map only for a private deployment you trust. */
export type GloamPools = Record<number, Address>;

/**
 * Gloam's pools on every network it runs on: the mainnets whose pool is in the
 * SDK this package was built with, and the testnets.
 */
export const OFFICIAL_POOLS: GloamPools = Object.fromEntries(gloamNetworks().map((n) => [n.chainId, n.pool])) as GloamPools;

export function officialPool(chainId: number, pools: GloamPools = OFFICIAL_POOLS): Address | undefined {
  return pools[chainId];
}

const lc = (s: string) => s.toLowerCase();
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;

/** Decimals of the assets Gloam knows (native ETH and GLOAM 18; the stablecoins 6), or undefined. */
export function assetDecimals(currency: Address): number | undefined {
  const c = lc(currency);
  if (c === lc(NATIVE_ASSET) || c === lc(GLOAM_TOKEN)) return 18;
  const sixes = [
    TEMPO_PATHUSD,
    TEMPO_OUSD,
    TEMPO_USDCE,
    TEMPO_USDT0,
    RH_USDG,
    RH_MAINNET_USDG,
    BASE_USDC,
    BASE_EURC,
    BASE_USDT,
    BASE_SEPOLIA_USDC,
    BASE_SEPOLIA_EURC,
    ETHEREUM_USDC,
    ETHEREUM_USDT,
    ETHEREUM_USDG,
    ETHEREUM_PYUSD,
    ETHEREUM_EURC,
    ETHEREUM_SEPOLIA_USDC,
    ETHEREUM_SEPOLIA_USDG,
    ETHEREUM_SEPOLIA_PYUSD,
    ETHEREUM_SEPOLIA_EURC,
  ];
  if (sixes.some((a) => c === lc(a))) return 6;
  // Elysium's USDC, once the SDK has its values: its own decimals, read on chain at launch.
  const ely = elysiumMainnetConfig();
  if (ely && c === lc(ely.usdc)) return ely.usdcDecimals;
  // Elysium testnet's USDC: its address and decimals are Kinetiq's published ones.
  if (ELYSIUM_TESTNET.usdc && c === lc(ELYSIUM_TESTNET.usdc)) return ELYSIUM_TESTNET.usdcDecimals;
  return undefined;
}

/** Known assets, for labels only (never for matching: matching is by address). */
export function assetSymbol(chainId: number, currency: Address): string {
  const c = lc(currency);
  const ely = elysiumMainnetConfig();
  // Elysium's gas coin is HYPE, and its vault takes USDC only.
  if (ely && chainId === ely.chainId) {
    if (c === lc(NATIVE_ASSET)) return "HYPE";
    if (c === lc(ely.usdc)) return "USDC";
  }
  if (chainId === ELYSIUM_TESTNET_CHAIN_ID) {
    if (c === lc(NATIVE_ASSET)) return "HYPE";
    if (ELYSIUM_TESTNET.usdc && c === lc(ELYSIUM_TESTNET.usdc)) return "USDC";
  }
  if (c === lc(NATIVE_ASSET)) return "ETH";
  if (c === lc(TEMPO_PATHUSD)) return isMainnetChainId(chainId) ? "pathUSD" : "PathUSD";
  if (c === lc(TEMPO_OUSD)) return "OUSD";
  if (c === lc(TEMPO_USDCE)) return "USDC.e";
  if (c === lc(TEMPO_USDT0)) return "USDT0";
  if (c === lc(RH_USDG) || c === lc(RH_MAINNET_USDG)) return "USDG";
  if (c === lc(GLOAM_TOKEN)) return "GLOAM";
  if (c === lc(BASE_USDC) || c === lc(BASE_SEPOLIA_USDC) || c === lc(ETHEREUM_USDC) || c === lc(ETHEREUM_SEPOLIA_USDC)) return "USDC";
  if (c === lc(BASE_EURC) || c === lc(BASE_SEPOLIA_EURC) || c === lc(ETHEREUM_EURC) || c === lc(ETHEREUM_SEPOLIA_EURC)) return "EURC";
  if (c === lc(BASE_USDT) || c === lc(ETHEREUM_USDT)) return "USDT";
  if (c === lc(ETHEREUM_USDG) || c === lc(ETHEREUM_SEPOLIA_USDG)) return "USDG";
  if (c === lc(ETHEREUM_PYUSD) || c === lc(ETHEREUM_SEPOLIA_PYUSD)) return "PYUSD";
  return "TOKEN";
}

/** The network names a charge takes: "tempo-mainnet", "robinhood-mainnet", "tempo", "robinhood", and "base-mainnet" / "base" / "ethereum-mainnet" / "ethereum" (Ethereum Sepolia) once their pools are in; "elysium-mainnet" and "elysium" (Elysium testnet) once the SDK has Elysium's values. */
export type GloamChargeNetwork = GloamNetworkKey;

// ── building and parsing requests ─────────────────────────────────────────────

export interface BuildChargeRequestParams {
  /** Price in base units. */
  amountWei: bigint;
  /** Payee receive tag (gloamr1.…). */
  recipient: string;
  /**
   * "tempo-mainnet" or "robinhood-mainnet" (mainnet), "tempo" or "robinhood"
   * (the testnets), or a chain id. "base-mainnet", "base" (Base Sepolia) and
   * "ethereum" (Ethereum Sepolia) work once the SDK has their pools, and
   * "elysium-mainnet" and "elysium" (its testnet; USDC, gas in HYPE) once it
   * has Elysium's values. Default
   * "tempo" (Tempo testnet), as in 0.0.x.
   */
  network?: GloamChargeNetwork | number;
  /**
   * Token address. Default: the network's first stablecoin (USDC.e on Tempo
   * mainnet, USDG on Robinhood Chain mainnet, USDC on Base, PathUSD on Tempo
   * testnet) and native ETH on Robinhood Chain testnet.
   */
  currency?: Address;
  decimals?: number;
  modes?: GloamMode[];
  description?: string;
  externalId?: string;
  pools?: GloamPools;
}

const defaultAsset = (net: GloamNetwork) => net.assets[0]!;

/** Chain ids of the networks whose pool comes with an SDK release, pool or not. */
const PUBLISHED_POOL_CHAINS: Partial<Record<GloamNetworkKey, number>> = {
  "robinhood-mainnet": RH_MAINNET_CHAIN_ID,
  "tempo-mainnet": TEMPO_MAINNET_CHAIN_ID,
  "base-mainnet": BASE_MAINNET_CHAIN_ID,
  base: BASE_SEPOLIA_CHAIN_ID,
  "ethereum-mainnet": ETHEREUM_MAINNET_CHAIN_ID,
  ethereum: ETHEREUM_SEPOLIA_CHAIN_ID,
};

/** Resolve a network name or chain id to a chain id, plus that network's default asset. */
export function resolveNetwork(network: BuildChargeRequestParams["network"] = "tempo") {
  if (typeof network === "number") {
    const known = networkForChainId(network);
    const asset = known ? defaultAsset(known) : null;
    return {
      chainId: network,
      currency: asset?.address ?? TEMPO_PATHUSD,
      decimals: asset?.decimals ?? 6,
    };
  }
  const net = getGloamNetwork(network);
  if (!net) {
    if (network === "elysium-mainnet") throw new Error("Elysium mainnet is not live in this version of @gloamtrade/sdk yet. Update it once it is.");
    if (network === "elysium") throw new Error("Elysium testnet is not live in this version of @gloamtrade/sdk yet. Update it once it is.");
    const id = PUBLISHED_POOL_CHAINS[network];
    throw new Error(
      id !== undefined
        ? `This version of @gloamtrade/sdk has no ${networkName(id)}${isMainnetChainId(id) ? " mainnet" : ""} pool yet. Update it.`
        : `Unknown Gloam network "${network}".`
    );
  }
  const asset = defaultAsset(net);
  return { chainId: net.chainId, currency: asset.address, decimals: asset.decimals };
}

/** Server side: the request of a gloam charge challenge. */
export function buildGloamChargeRequest(p: BuildChargeRequestParams): GloamChargeRequest {
  if (p.amountWei <= 0n) throw new Error("amountWei must be positive.");
  if (!isReceiveTag(p.recipient)) {
    throw new Error("recipient must be a Gloam receive tag (gloamr1.…), so the payment can be sealed to the payee.");
  }
  const net = resolveNetwork(p.network);
  const pool = officialPool(net.chainId, p.pools);
  if (!pool) throw new Error(`There is no Gloam pool on chain ${net.chainId}.`);
  const currency = p.currency ?? net.currency;
  if (!ADDRESS.test(currency)) throw new Error("currency must be a token address.");
  const modes = p.modes ? [...new Set(p.modes)] : undefined;
  if (modes && (modes.length === 0 || modes.some((m) => !GLOAM_MODES.includes(m)))) {
    throw new Error('modes must be a non-empty subset of ["push", "pull"].');
  }
  const decimals = p.decimals ?? assetDecimals(currency);
  return {
    amount: p.amountWei.toString(),
    currency,
    recipient: p.recipient.trim(),
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.externalId !== undefined ? { externalId: p.externalId } : {}),
    methodDetails: {
      chainId: net.chainId,
      pool,
      ...(decimals !== undefined ? { decimals } : {}),
      // Absent means both, so only write it when the server narrows it.
      ...(modes && modes.length < GLOAM_MODES.length ? { supportedModes: modes } : {}),
    },
  };
}

/** Strictly parse a decoded request. Throws GloamChargeError("bad-request") with a plain reason. */
export function parseGloamChargeRequest(input: unknown): GloamChargeRequest {
  const bad = (why: string) => new GloamChargeError("bad-request", `This gloam charge request is not valid: ${why}.`);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("it is not an object");
  const r = input as Record<string, unknown>;
  if (typeof r.amount !== "string" || !UINT.test(r.amount) || BigInt(r.amount) <= 0n) throw bad("amount must be a positive whole number of base units");
  if (typeof r.currency !== "string" || !ADDRESS.test(r.currency)) throw bad("currency must be a token address");
  if (typeof r.recipient !== "string" || !isReceiveTag(r.recipient)) throw bad("recipient must be a Gloam receive tag (gloamr1.…)");
  const md = r.methodDetails as Record<string, unknown> | undefined;
  if (!md || typeof md !== "object") throw bad("methodDetails is missing");
  if (typeof md.chainId !== "number" || !Number.isSafeInteger(md.chainId) || md.chainId <= 0) throw bad("methodDetails.chainId must be a chain id");
  if (typeof md.pool !== "string" || !ADDRESS.test(md.pool)) throw bad("methodDetails.pool must be the pool address");
  if (md.decimals !== undefined && (typeof md.decimals !== "number" || !Number.isInteger(md.decimals) || md.decimals < 0 || md.decimals > 36)) {
    throw bad("methodDetails.decimals must be a whole number");
  }
  let supportedModes: GloamMode[] | undefined;
  if (md.supportedModes !== undefined) {
    if (!Array.isArray(md.supportedModes) || md.supportedModes.length === 0 || md.supportedModes.some((m) => m !== "push" && m !== "pull")) {
      throw bad('methodDetails.supportedModes must list "push" and/or "pull"');
    }
    supportedModes = md.supportedModes as GloamMode[];
  }
  if (md.version !== undefined && md.version !== 1) throw bad(`methodDetails.version ${String(md.version)} is not supported`);
  return {
    amount: r.amount,
    currency: r.currency as Address,
    recipient: r.recipient,
    ...(typeof r.description === "string" ? { description: r.description } : {}),
    ...(typeof r.externalId === "string" ? { externalId: r.externalId } : {}),
    methodDetails: {
      chainId: md.chainId,
      pool: md.pool as Address,
      ...(typeof md.decimals === "number" ? { decimals: md.decimals } : {}),
      ...(supportedModes ? { supportedModes } : {}),
    },
  };
}

/** Modes a request allows. */
export const allowedModes = (r: GloamChargeRequest): GloamMode[] => r.methodDetails.supportedModes ?? [...GLOAM_MODES];

/** Strictly parse a credential payload. Throws GloamChargeError("invalid-payload"). */
export function parseGloamChargePayload(input: unknown): GloamChargePayload {
  const bad = (why: string) => new GloamChargeError("invalid-payload", `This gloam credential payload is not valid: ${why}.`);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("it is not an object");
  const p = input as Record<string, unknown>;
  if (typeof p.ticket !== "string" || !p.ticket.startsWith("gloam2t.")) throw bad("ticket must be a payment note sealed to the recipient (gloam2t.…)");
  if (typeof p.binding !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(p.binding)) throw bad("binding must be a base64url HMAC-SHA256");
  if (p.type === "hash") {
    if (typeof p.hash !== "string" || !HEX32.test(p.hash)) throw bad("hash must be a transaction hash");
    return { type: "hash", hash: p.hash as Hex, ticket: p.ticket, binding: p.binding };
  }
  if (p.type === "transfer") {
    const t = p.transfer as Record<string, unknown> | undefined;
    if (!t || typeof t !== "object") throw bad("transfer is missing");
    if (typeof t.proof !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(t.proof)) throw bad("transfer.proof must be hex bytes");
    for (const k of ["root", "nullifier"] as const) {
      if (typeof t[k] !== "string" || !HEX32.test(t[k] as string)) throw bad(`transfer.${k} must be bytes32`);
    }
    const c = t.newCommitments;
    if (!Array.isArray(c) || c.length !== 2 || c.some((x) => typeof x !== "string" || !HEX32.test(x))) {
      throw bad("transfer.newCommitments must be two bytes32 values");
    }
    return {
      type: "transfer",
      transfer: { proof: t.proof as Hex, root: t.root as Hex, nullifier: t.nullifier as Hex, newCommitments: [c[0] as Hex, c[1] as Hex] },
      ticket: p.ticket,
      binding: p.binding,
    };
  }
  throw bad('type must be "hash" or "transfer"');
}

export const isGloamChargeChallenge = (ch: Pick<PaymentChallenge, "method" | "intent">) =>
  ch.method === GLOAM_METHOD && ch.intent === GLOAM_CHARGE_INTENT;

// ── bridges to the SDK's x402 shapes ──────────────────────────────────────────

/**
 * The SDK's payment requirements for a gloam charge, so buildGloamPayment and
 * settleGloamPayment serve MPP unchanged. `resource` is a label (the realm or URL).
 */
export function toPaymentRequirements(request: GloamChargeRequest, resource: string, maxTimeoutSeconds = 600): GloamPaymentRequirements {
  return buildGloamPaymentRequirements({
    amountWei: BigInt(request.amount),
    asset: request.currency,
    assetSymbol: assetSymbol(request.methodDetails.chainId, request.currency),
    payTo: request.recipient,
    resource,
    description: request.description,
    network: request.methodDetails.chainId,
    poolAddress: request.methodDetails.pool,
    maxTimeoutSeconds,
  });
}

/** A gloam charge request carrying the same terms as x402 gloam-private requirements. */
export function fromPaymentRequirements(
  req: GloamPaymentRequirements,
  opts: { decimals?: number; modes?: GloamMode[]; externalId?: string } = {}
): GloamChargeRequest {
  return {
    amount: String(req.maxAmountRequired),
    currency: req.asset,
    recipient: req.payTo,
    ...(req.description ? { description: req.description } : {}),
    ...(opts.externalId !== undefined ? { externalId: opts.externalId } : {}),
    methodDetails: {
      chainId: Number(req.network),
      pool: req.poolAddress,
      ...(opts.decimals !== undefined ? { decimals: opts.decimals } : {}),
      ...(opts.modes && opts.modes.length < GLOAM_MODES.length ? { supportedModes: opts.modes } : {}),
    },
  };
}

/** The economically significant terms, for comparing a presented challenge with a route's price. */
export function chargeTerms(r: GloamChargeRequest) {
  return {
    amount: r.amount,
    currency: lc(r.currency),
    recipient: r.recipient.trim(),
    chainId: r.methodDetails.chainId,
    pool: lc(r.methodDetails.pool),
  };
}

/** The first term that differs, or null when they match. */
export function termsMismatch(expected: GloamChargeRequest, actual: GloamChargeRequest): string | null {
  const a = chargeTerms(expected);
  const b = chargeTerms(actual);
  for (const k of Object.keys(a) as (keyof typeof a)[]) if (a[k] !== b[k]) return k;
  return null;
}

// ── the challenge binding ────────────────────────────────────────────────────

/** 32 big-endian bytes of a field element given as hex. */
function secretBytes(secret: Hex): Uint8Array {
  const h = BigInt(secret).toString(16).padStart(64, "0");
  if (h.length > 64) throw new Error("The note secret is wider than 32 bytes.");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Bind a credential to exactly one challenge. Keyed by the payment note secret,
 * which only the payer and the payee know, over the challenge id, the realm and
 * the payment commitment. Someone who lifts a credential off the wire cannot
 * rebind it to another challenge without opening the sealed ticket.
 */
export async function challengeBinding(args: { secret: Hex; realm: string; challengeId: string; commitment: Hex }): Promise<string> {
  const msg = canonicalJson([GLOAM_BINDING_DOMAIN, args.realm, args.challengeId, lc(args.commitment)]);
  return hmacBase64url(secretBytes(args.secret), msg);
}
