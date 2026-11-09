/**
 * The Gloam partner program: partner accounts, fee settings, and the
 * accounting of what each partner brought in, by where it was seen:
 *   api    relayed or reported with the partner's API key
 *   link   opened from the partner's link (a link code, lib/partnerLinks) and
 *          checked on chain once it landed (lib/partnerAttribution)
 *   chain  a past cash out found on chain paying one of the partner's own
 *          receiving addresses (lib/partnerBackfill)
 * Server only.
 *
 * How fees can work, honestly:
 *  - A private payment hides its amount from everyone, the relay included. So
 *    a partner's fee on one can only be a flat amount per payment.
 *  - Deposits and cash outs cross between a public wallet and the vault, so
 *    their amount is public, and a fee can be a share of it (basis points).
 *  - Collecting a fee for real needs a fee output inside the circuits and the
 *    vault contract, which the mainnet pools do not have yet. So nothing is
 *    charged on any network, mainnet or testnet: this file records what each
 *    partner's key brought in and the fee that would have applied under the
 *    partner's setting at the time. The only fee taken on mainnet is Gloam's
 *    own 0.5% on cash outs, kept by the pool.
 *
 * What is recorded per transaction: network, kind, tx hash, time, where it was
 * seen (source), and for public edges only the asset and amount (both already
 * on chain: a deposit's, a cash out's, a private swap's input) and the vault's
 * own cash-out fee on it. Never a note, a secret, a wallet, an IP, a recipient
 * of a private send, or a private amount. A private swap carries no partner fee.
 *
 * Mainnet and testnet are kept apart everywhere (every counter names its
 * network, and every view is for one tier), and testnet activity is counted but
 * never valued in dollars.
 *
 * Storage (lib/partnersKv), all under gloam:partners:v1:
 *   partner:<id>            partner record (JSON)
 *   relay-approved:<id>     "1" when an admin approved the relay's larger budget
 *   name-ok:<id>            the account name an admin approved to show in links
 *   owner:<address>         partner id for a wallet (one account per wallet)
 *   partners                set of partner ids
 *   removed:<id>            an admin removed this account (JSON; lib/partnerRemove): it reads as
 *                           no account from then on, and its past activity stays under its id
 *   removed-owner:<address> the wallet's last removed account, for the notice in the portal (JSON)
 *   tx:<chainId>:<hash>     partner id that a transaction is attributed to
 *   txrec:<chainId>:<hash>  that partner and the record, so a claim can be moved (JSON)
 *   events:<id>             newest-first list of activity records (capped)
 *   stats2:<id>             running counters (fields below)
 *   day2:<id>:<YYYY-MM-DD>  per-day counters, kept 120 days
 *   v2:<id>                 set once the account's older counters were replayed into stats2
 *
 * Counter fields: <network>|<source>|<kind>|<metric>, metric n (count), usd
 * (volume, USD micros), fee (would-be partner fee, USD micros), vf (the vault's
 * fee, USD micros), unp (public edges with no price), vfu (vault fees with no
 * price); a|<chainId>|<asset>|<kind>|vt|ft|vft per asset (volume, partner fee and
 * vault fee, micro-units, all-time only); last|<tier>.
 */
import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { loadEthUsd } from "./live-quotes";
import { getNetwork, isNetworkKey, NETWORK_KEYS, networkName, type GloamNetwork, type NetworkKey } from "./networks";
import { cleanText } from "./paymentNote";
import { readSwapRef } from "./swapLink";
import { hashNumbers, jsonOf, k, kv, kv1, type KvCommand } from "./partnersKv";
import { randomId } from "./apiKeys";
import { isDollarStable, shieldTokensFor, supportsNativeShield } from "./tokens";

// ---------------------------------------------------------------- fees

export type PartnerFees = {
  /** Flat fee per private payment, in US cents. */
  privatePaymentCents: number;
  /** Share of each cash out, in basis points (1 bp = 0.01%). */
  cashoutBps: number;
  /** Share of each deposit, in basis points. */
  depositBps: number;
};

export const FEE_LIMITS: Record<keyof PartnerFees, { min: number; max: number }> = {
  privatePaymentCents: { min: 0, max: 100 },
  cashoutBps: { min: 0, max: 100 },
  depositBps: { min: 0, max: 100 },
};

export const DEFAULT_FEES: PartnerFees = { privatePaymentCents: 0, cashoutBps: 0, depositBps: 0 };

export class PartnerError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "bad_request"
  ) {
    super(message);
  }
}

/** Whole numbers inside FEE_LIMITS, or a plain-language reason. */
export function validateFees(input: unknown, base: PartnerFees = DEFAULT_FEES): PartnerFees {
  if (input == null) return { ...base };
  if (typeof input !== "object") throw new PartnerError("Fees must be an object.", 400, "bad_fees");
  const raw = input as Record<string, unknown>;
  const out: PartnerFees = { ...base };
  for (const field of Object.keys(FEE_LIMITS) as (keyof PartnerFees)[]) {
    if (raw[field] === undefined) continue;
    const v = typeof raw[field] === "string" && raw[field] !== "" ? Number(raw[field]) : raw[field];
    const { min, max } = FEE_LIMITS[field];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      const what =
        field === "privatePaymentCents"
          ? `The fee per private payment must be a whole number of cents from ${min} to ${max}.`
          : `The ${field === "cashoutBps" ? "cash out" : "deposit"} fee must be a whole number of basis points from ${min} to ${max} (${max / 100}%).`;
      throw new PartnerError(what, 400, "bad_fees");
    }
    out[field] = v;
  }
  return out;
}

export type EdgeAmount = {
  /** Smallest units, as on chain. */
  amount: bigint;
  decimals: number;
  /** USD per whole token, in micro-dollars; null when there is no price. */
  priceMicros: bigint | null;
};

export type Commission = {
  /** Would-be fee in micro-dollars, null when a public edge has no price. */
  feeUsdMicros: bigint | null;
  /** Would-be fee in the transaction's own token (smallest units); public edges only. */
  feeToken: bigint | null;
  /** USD value of a public edge in micro-dollars; null for private payments or no price. */
  volumeUsdMicros: bigint | null;
};

/**
 * What a partner key brought in. A private swap is counted with its input (the
 * asset and amount the swap's unshield names, public on chain) and carries no
 * partner fee: there is no fee setting for swaps.
 */
export type ActivityKind = "private_payment" | "cash_out" | "deposit" | "private_swap";
export const ACTIVITY_KINDS: ActivityKind[] = ["private_payment", "cash_out", "deposit", "private_swap"];

/** The fee a partner's setting puts on one transaction. Pure; rounds down. */
export function commissionFor(kind: ActivityKind, fees: PartnerFees, edge?: EdgeAmount | null): Commission {
  if (kind === "private_payment") {
    return { feeUsdMicros: BigInt(fees.privatePaymentCents) * 10_000n, feeToken: null, volumeUsdMicros: null };
  }
  if (kind === "private_swap") {
    // No partner fee on a swap: only its input's dollar value, when it has a price.
    const volumeUsdMicros =
      edge && edge.amount >= 0n && edge.priceMicros != null ? (edge.amount * edge.priceMicros) / 10n ** BigInt(edge.decimals) : null;
    return { feeUsdMicros: 0n, feeToken: 0n, volumeUsdMicros };
  }
  if (!edge || edge.amount < 0n) return { feeUsdMicros: null, feeToken: null, volumeUsdMicros: null };
  const bps = BigInt(kind === "cash_out" ? fees.cashoutBps : fees.depositBps);
  const feeToken = (edge.amount * bps) / 10_000n;
  if (edge.priceMicros == null) return { feeUsdMicros: null, feeToken, volumeUsdMicros: null };
  const volumeUsdMicros = (edge.amount * edge.priceMicros) / 10n ** BigInt(edge.decimals);
  return { feeUsdMicros: (volumeUsdMicros * bps) / 10_000n, feeToken, volumeUsdMicros };
}

/** Smallest units to micro-units (six decimals), so token sums fit a 64-bit counter. */
export function toMicroUnits(raw: bigint, decimals: number): bigint {
  return decimals >= 6 ? raw / 10n ** BigInt(decimals - 6) : raw * 10n ** BigInt(6 - decimals);
}

/** "$0.05 per private payment", "0.25% of each cash out". */
export function describeFee(kind: ActivityKind, fees: PartnerFees): string {
  if (kind === "private_swap") return "No partner fee on private swaps";
  if (kind === "private_payment") return `$${(fees.privatePaymentCents / 100).toFixed(2)} per private payment`;
  const bps = kind === "cash_out" ? fees.cashoutBps : fees.depositBps;
  return `${(bps / 100).toFixed(2)}% of each ${kind === "cash_out" ? "cash out" : "deposit"}`;
}

// ---------------------------------------------------------------- assets + prices

export type AssetInfo = { symbol: string; decimals: number; stable: boolean };

/** A public-edge asset Gloam knows on a network: listed tokens, plus the native coin where it shields. */
export function assetInfo(net: GloamNetwork, asset: Address): AssetInfo | null {
  const a = asset.toLowerCase();
  if (a === zeroAddress) {
    return supportsNativeShield(net.chainId)
      ? { symbol: net.primaryAsset.symbol, decimals: net.primaryAsset.decimals, stable: false }
      : null;
  }
  const t = shieldTokensFor(net.chainId).find((x) => x.address.toLowerCase() === a);
  return t ? { symbol: t.symbol, decimals: t.decimals, stable: isDollarStable(t) } : null;
}

let ethPrice: { at: number; micros: bigint | null } | null = null;

/**
 * USD per whole token in micro-dollars, at the time of the transaction.
 * Stablecoins count as $1; ETH from the price feed the app already uses
 * (cached five minutes); stock tokens and unknown tokens are left unpriced.
 */
export async function priceMicrosFor(info: AssetInfo | null): Promise<bigint | null> {
  if (!info) return null;
  if (info.stable) return 1_000_000n;
  if (info.symbol !== "ETH") return null;
  if (!ethPrice || Date.now() - ethPrice.at > 5 * 60_000) {
    const usd = await loadEthUsd().catch(() => null);
    ethPrice = { at: Date.now(), micros: usd && usd > 0 ? BigInt(Math.round(usd * 1e6)) : null };
  }
  return ethPrice.micros;
}

// ---------------------------------------------------------------- partners

export type PayoutAddresses = Partial<Record<NetworkKey, Address>>;

export type Partner = {
  id: string;
  /** The wallet that signs in, lowercase. */
  owner: Address;
  name: string;
  website: string | null;
  /** Where fees would be paid, per network. */
  payout: PayoutAddresses;
  fees: PartnerFees;
  /**
   * Set by a Gloam admin, never by the partner, and kept under its own key apart
   * from the record, so a save of the record never changes it. Payment messages from
   * an approved account's keys use the relay's larger message budget; every other
   * account's keys share one the size of the budget for messages sent without a key.
   */
  relayApproved?: boolean;
  /**
   * The name an admin approved to show in links ("From Motion · Gloam partner"),
   * kept under its own key like relayApproved. Locked: a later rename shows only
   * once an admin approves it again. null: nothing is shown.
   */
  approvedName?: string | null;
  createdAt: number;
  updatedAt: number;
};

export const PARTNER_NAME_MAX = 60;

/**
 * Why a name can't be an account's name, or null. The rules a swap link's ref
 * is held to (lib/swapLink readSwapRef): a plain name of at most 32 characters
 * and 4 words, no web address, no markup, and never "Gloam"; and plain ASCII
 * only, so no look-alike letters.
 */
export function partnerNameProblem(name: string): string | null {
  if (name.length < 2) return "Add your app's name (at least two characters).";
  // plain ASCII only, so a look-alike letter (a Cyrillic "о" in "Glоam") can't pass
  if (/[^\x20-\x7e]/.test(name)) return "Use plain letters and digits (A to Z, 0 to 9) and spaces.";
  const { ref, problem } = readSwapRef(name);
  if (!ref || ref !== name) {
    return problem && /Gloam/.test(problem)
      ? "A partner name can't include Gloam."
      : "Use a plain name: letters and digits, up to 32 characters and 4 words, no web address.";
  }
  return null;
}

export function cleanPartnerName(raw: unknown): string {
  return cleanText(typeof raw === "string" ? raw : "", PARTNER_NAME_MAX);
}

/** An http(s) URL, normalized, or null for empty. Throws on anything else. */
export function cleanWebsite(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new PartnerError("The website must be a link.", 400, "bad_website");
  const s = raw.trim();
  if (!s) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    throw new PartnerError("That website does not look like a link.", 400, "bad_website");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PartnerError("The website must start with https://.", 400, "bad_website");
  }
  if (url.username || url.password || !url.hostname.includes(".")) {
    throw new PartnerError("That website does not look like a link.", 400, "bad_website");
  }
  const out = url.toString().replace(/\/$/, "");
  if (out.length > 200) throw new PartnerError("That link is too long.", 400, "bad_website");
  return out;
}

/** Checksummed payout addresses per known network. Empty strings clear one. */
export function validatePayout(input: unknown, base: PayoutAddresses = {}): PayoutAddresses {
  if (input == null) return { ...base };
  if (typeof input !== "object") throw new PartnerError("Payout addresses must be an object.", 400, "bad_payout");
  const out: PayoutAddresses = { ...base };
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isNetworkKey(key)) throw new PartnerError(`Unknown network "${key.slice(0, 24)}".`, 400, "bad_payout");
    if (value === null || value === "") {
      delete out[key];
      continue;
    }
    if (typeof value !== "string" || !isAddress(value.trim(), { strict: false }) || value.trim().toLowerCase() === zeroAddress) {
      throw new PartnerError(`The ${getNetwork(key).label} payout address is not a valid wallet address.`, 400, "bad_payout");
    }
    out[key] = getAddress(value.trim());
  }
  return out;
}

/** A stored record with its approvals, which live under their own keys. */
function withApproval(raw: unknown, approved: unknown, nameOk: unknown = null): Partner | null {
  const p = jsonOf<Partner>(raw);
  return p ? { ...p, relayApproved: approved === "1", approvedName: typeof nameOk === "string" && nameOk ? nameOk : null } : null;
}

/** The record as stored: everything but the approvals. */
function recordOf(p: Partner): string {
  const { relayApproved: _approval, approvedName: _name, ...rest } = p;
  return JSON.stringify(rest);
}

export function isPartnerId(id: unknown): id is string {
  return typeof id === "string" && /^ptr_[A-Za-z0-9]{6,32}$/.test(id);
}

/** Null for an unknown id, and for an account an admin removed, whatever is left under its keys. */
export async function getPartner(id: string): Promise<Partner | null> {
  if (!isPartnerId(id)) return null;
  const [raw, approved, nameOk, removed] = await kv([
    ["GET", k("partner", id)],
    ["GET", k("relay-approved", id)],
    ["GET", k("name-ok", id)],
    ["EXISTS", k("removed", id)],
  ]);
  if (Number(removed) > 0) return null;
  return withApproval(raw, approved, nameOk);
}

/** What the portal tells a wallet whose account an admin removed. */
export type RemovedNotice = { name: string; removedAt: number };

/** The wallet's last removed account, when it has no account now; null otherwise. */
export async function removedNoticeFor(owner: string): Promise<RemovedNotice | null> {
  const r = jsonOf<{ name?: unknown; removedAt?: unknown }>(await kv1(["GET", k("removed-owner", owner.toLowerCase())]));
  return r && typeof r.name === "string" && typeof r.removedAt === "number" ? { name: r.name, removedAt: r.removedAt } : null;
}

export async function getPartnerByOwner(owner: string): Promise<Partner | null> {
  const id = await kv1(["GET", k("owner", owner.toLowerCase())]);
  return typeof id === "string" ? getPartner(id) : null;
}

export type PartnerInput = {
  name?: unknown;
  website?: unknown;
  payout?: unknown;
  fees?: unknown;
};

/** Throws a PartnerError for what a new account would refuse, making nothing. */
export function checkNewPartner(input: PartnerInput): void {
  const problem = partnerNameProblem(cleanPartnerName(input.name));
  if (problem) throw new PartnerError(problem, 400, "bad_name");
  cleanWebsite(input.website);
  validatePayout(input.payout, {});
  validateFees(input.fees, DEFAULT_FEES);
}

/** Creates the wallet's partner account, or updates it. Never changes its approval (setRelayApproved). */
export async function upsertPartner(owner: Address, input: PartnerInput): Promise<Partner> {
  const existing = await getPartnerByOwner(owner);
  const now = Date.now();
  const name = input.name === undefined && existing ? existing.name : cleanPartnerName(input.name);
  // a new name follows the plain-name rules; an account's earlier name stays as it was
  if (!existing || name !== existing.name) {
    const problem = partnerNameProblem(name);
    if (problem) throw new PartnerError(problem, 400, "bad_name");
  }
  const website = input.website === undefined && existing ? existing.website : cleanWebsite(input.website);
  const payout = validatePayout(input.payout, existing?.payout ?? {});
  const fees = validateFees(input.fees, existing?.fees ?? DEFAULT_FEES);

  if (existing) {
    const next: Partner = { ...existing, name, website, payout, fees, updatedAt: now };
    await kv1(["SET", k("partner", existing.id), recordOf(next)]);
    return next;
  }
  const partner: Partner = {
    id: randomId("ptr"),
    owner: owner.toLowerCase() as Address,
    name,
    website,
    payout,
    fees,
    createdAt: now,
    updatedAt: now,
  };
  // The account first, then the wallet's claim on it: a claim with no account behind it locks the wallet out.
  await kv1(["SET", k("partner", partner.id), recordOf(partner)]);
  const [claimed] = await kv([["SET", k("owner", partner.owner), partner.id, "NX"]]);
  if (claimed !== "OK") {
    // Two tabs signed up at once: keep the first account.
    const first = await getPartnerByOwner(owner);
    if (first) {
      await kv1(["DEL", k("partner", partner.id)]).catch(() => undefined);
      return first;
    }
    // A claim with nothing behind it, from a signup that stopped halfway: this one takes its place.
    await kv1(["SET", k("owner", partner.owner), partner.id]);
  }
  await kv1(["SADD", k("partners"), partner.id]);
  return partner;
}

/**
 * Admin only: approves this account for the relay's larger message budget, or takes
 * that back. Written under its own key, never with the record. Null when there is no
 * such account.
 */
export async function setRelayApproved(id: string, approved: boolean): Promise<Partner | null> {
  if (!(await getPartner(id))) return null;
  await kv1(approved ? ["SET", k("relay-approved", id), "1"] : ["DEL", k("relay-approved", id)]);
  return getPartner(id);
}

/**
 * Admin only: approves the account's current name to show in links, or takes
 * that back. The name must follow the plain-name rules. Null when there is no
 * such account.
 */
export async function setApprovedName(id: string, approve: boolean): Promise<Partner | null> {
  const p = await getPartner(id);
  if (!p) return null;
  if (approve) {
    const problem = partnerNameProblem(p.name);
    if (problem) throw new PartnerError(`This name can't be shown in links: ${problem}`, 400, "bad_name");
    await kv1(["SET", k("name-ok", id), p.name]);
  } else {
    await kv1(["DEL", k("name-ok", id)]);
  }
  return getPartner(id);
}

export async function listPartners(): Promise<Partner[]> {
  const ids = (await kv1(["SMEMBERS", k("partners")])) as string[];
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const raw = await kv(
    ids.flatMap((id) => [["GET", k("partner", id)], ["GET", k("relay-approved", id)], ["GET", k("name-ok", id)]] as KvCommand[])
  );
  return ids
    .map((_, i) => withApproval(raw[3 * i], raw[3 * i + 1], raw[3 * i + 2]))
    .filter((p): p is Partner => Boolean(p))
    .sort((a, b) => b.createdAt - a.createdAt);
}

// ---------------------------------------------------------------- accounting

/** Where a partner's activity was seen (see the top of this file). */
export type ActivitySource = "api" | "link" | "chain";
export const ACTIVITY_SOURCES: ActivitySource[] = ["api", "link", "chain"];
export const SOURCE_LABEL: Record<ActivitySource, string> = {
  api: "Via API key",
  link: "Via link",
  chain: "Matched on chain",
};

/** Mainnet and testnet are never added together. */
export type Tier = "mainnet" | "testnet";
export const TIERS: Tier[] = ["mainnet", "testnet"];

export function tierOf(network: NetworkKey): Tier {
  return getNetwork(network).testnet ? "testnet" : "mainnet";
}

export function isTier(raw: unknown): raw is Tier {
  return raw === "mainnet" || raw === "testnet";
}

export type ActivityRecord = {
  /** 2 for records counted into stats2; older ones were replayed into it once (ensureMigrated). */
  v?: 2;
  id: string;
  kind: ActivityKind;
  network: NetworkKey;
  chainId: number;
  txHash: Hex;
  /** ms since epoch: when Gloam recorded it, or the block's time for a link or an on-chain match. */
  ts: number;
  /** Where it was seen. Records from before sources existed have none and read as "api". */
  source?: ActivitySource;
  /** The API key that brought it in (source "api"). */
  keyId: string | null;
  /** The partner's link code it came through (source "link"). */
  linkCode?: string | null;
  /**
   * How a link count was bound (source "link"): "relay", the relay bound the code to the
   * transaction it sent (fee-split grade); "wallet", the payer's app registered it before
   * its wallet sent (attribution grade). lib/partnerAttribution.
   */
  linkBind?: "relay" | "wallet" | null;
  /** The vault's own cash-out fee on it, smallest units of `asset`; null when not known. */
  vaultFee?: string | null;
  vaultFeeUsd?: number | null;
  /** Public edges only (deposits, cash outs, a swap's input): what is already on chain. */
  asset: Address | null;
  symbol: string | null;
  decimals: number | null;
  /** Smallest units. */
  amount: string | null;
  /** null on testnet, and for a token with no price. */
  volumeUsd: number | null;
  /** Would-be fee in USD (null on testnet, or when a public edge has no price). */
  feeUsd: number | null;
  /** Would-be fee in the transaction's own token, smallest units (public edges). */
  feeToken: string | null;
  /** The setting that produced the fee, e.g. "0.25% of each cash out". */
  feeBasis: string;
};

const EVENTS_MAX = 200;
const DAY_TTL_SEC = 120 * 86_400;
const TX_TTL_SEC = 400 * 86_400;

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const micros = (v: bigint | null): number | null => (v == null ? null : Number(v) / 1e6);
const toMicros = (v: number | null | undefined): bigint | null => (v == null ? null : BigInt(Math.round(v * 1e6)));

/** A stored record as shown: one from before sources existed came in with a key. */
function normalized(r: ActivityRecord): ActivityRecord {
  return { ...r, source: r.source ?? "api", linkCode: r.linkCode ?? null, linkBind: r.linkBind ?? null, vaultFee: r.vaultFee ?? null, vaultFeeUsd: r.vaultFeeUsd ?? null };
}

/**
 * The counter fields one record adds (see the top of this file), all worked out
 * from the record itself, so a claim can be taken back exactly (reverseActivity).
 * Pure.
 */
export function incrementsOf(r: ActivityRecord): [string, bigint][] {
  const base = `${r.network}|${r.source ?? "api"}|${r.kind}|`;
  const out: [string, bigint][] = [[`${base}n`, 1n]];
  // a link count the payer's wallet registered, apart from the relay-bound ones
  if ((r.source ?? "api") === "link" && r.linkBind === "wallet") out.push([`${base}nw`, 1n]);
  const fee = toMicros(r.feeUsd);
  if (fee != null) out.push([`${base}fee`, fee]);
  if (r.kind !== "private_payment") {
    const usd = toMicros(r.volumeUsd);
    out.push(usd != null ? [`${base}usd`, usd] : [`${base}unp`, 1n]);
  }
  const vf = r.vaultFee == null ? null : BigInt(r.vaultFee);
  const vfUsd = toMicros(r.vaultFeeUsd);
  if (vfUsd != null && vfUsd > 0n) out.push([`${base}vf`, vfUsd]);
  else if (vf != null && vf > 0n) out.push([`${base}vfu`, 1n]);
  if (r.kind !== "private_payment" && r.asset && r.decimals != null && r.amount != null) {
    const tag = `a|${r.chainId}|${r.asset.toLowerCase()}|${r.kind}|`;
    out.push([`${tag}vt`, toMicroUnits(BigInt(r.amount), r.decimals)]);
    if (r.feeToken != null && r.kind !== "private_swap") out.push([`${tag}ft`, toMicroUnits(BigInt(r.feeToken), r.decimals)]);
    if (vf != null && vf > 0n) out.push([`${tag}vft`, toMicroUnits(vf, r.decimals)]);
  }
  return out;
}

/** The commands that add (or, with sign -1, take back) one record's counters for a partner. */
function counterCommands(partnerId: string, r: ActivityRecord, sign: 1n | -1n): KvCommand[] {
  const incr = incrementsOf(r);
  const dayKey = k("day2", partnerId, utcDay(r.ts));
  const cmds: KvCommand[] = [];
  for (const [f, v] of incr) cmds.push(["HINCRBY", k("stats2", partnerId), f, (v * sign).toString()]);
  for (const [f, v] of incr) if (!f.startsWith("a|")) cmds.push(["HINCRBY", dayKey, f, (v * sign).toString()]);
  cmds.push(["EXPIRE", dayKey, DAY_TTL_SEC]);
  return cmds;
}

/**
 * Attribute one transaction to a partner and count it. A transaction can be
 * attributed once, to one partner (first claim wins); a second claim returns
 * `duplicate`. Prices are read at the time of recording, on mainnet only: a
 * testnet transaction is counted, never valued.
 */
export async function recordActivity(args: {
  partner: Partner;
  keyId: string | null;
  network: GloamNetwork;
  kind: ActivityKind;
  txHash: Hex;
  /** Public edges: the asset and amount the chain shows. */
  edge?: { asset: Address; amount: bigint } | null;
  /** Where it was seen; "api" when left out. */
  source?: ActivitySource;
  /** The link code it came through (source "link"). */
  linkCode?: string | null;
  /** How that link count was bound (source "link"). */
  linkBind?: "relay" | "wallet" | null;
  /** The vault's own fee on a public edge, smallest units of its asset; null or left out when not known. */
  vaultFee?: bigint | null;
  /** When it happened, ms (the block's time for a link or an on-chain match): it keeps its own day and never moves `last` back. */
  now?: number;
}): Promise<{ recorded: true; record: ActivityRecord } | { recorded: false; reason: "duplicate" }> {
  const { partner, network: net, kind } = args;
  const source: ActivitySource = args.source ?? "api";
  const now = args.now ?? Date.now();
  const txHash = args.txHash.toLowerCase() as Hex;
  const [claim] = await kv([["SET", k("tx", net.chainId, txHash), partner.id, "NX", "EX", TX_TTL_SEC]]);
  if (claim !== "OK") return { recorded: false, reason: "duplicate" };

  const testnet = net.testnet === true;
  let info: AssetInfo | null = null;
  let edgeAmount: EdgeAmount | null = null;
  if (kind !== "private_payment" && args.edge) {
    info = assetInfo(net, args.edge.asset);
    edgeAmount = {
      amount: args.edge.amount,
      decimals: info?.decimals ?? 18,
      // test tokens have no price: a testnet transaction is never worth dollars here
      priceMicros: testnet ? null : await priceMicrosFor(info),
    };
  }
  let c = commissionFor(kind, partner.fees, edgeAmount);
  if (testnet) c = { ...c, feeUsdMicros: null, volumeUsdMicros: null };
  // Deposits and private payments are free in the vault: their fee is 0, known.
  const vaultFee =
    kind === "private_payment" || kind === "deposit" ? 0n : args.vaultFee != null && args.vaultFee >= 0n ? args.vaultFee : null;
  const vaultFeeUsdMicros =
    vaultFee == null
      ? null
      : vaultFee === 0n
        ? 0n
        : edgeAmount?.priceMicros != null
          ? (vaultFee * edgeAmount.priceMicros) / 10n ** BigInt(edgeAmount.decimals)
          : null;

  const record: ActivityRecord = {
    v: 2,
    id: randomId("act"),
    kind,
    network: net.key,
    chainId: net.chainId,
    txHash,
    ts: now,
    source,
    keyId: source === "api" ? args.keyId : null,
    linkCode: source === "link" ? (args.linkCode ?? null) : null,
    linkBind: source === "link" ? (args.linkBind ?? null) : null,
    vaultFee: vaultFee == null ? null : vaultFee.toString(),
    vaultFeeUsd: micros(vaultFeeUsdMicros),
    asset: kind === "private_payment" || !args.edge ? null : (getAddress(args.edge.asset) as Address),
    symbol: info?.symbol ?? null,
    decimals: info?.decimals ?? null,
    amount: kind === "private_payment" || !args.edge ? null : args.edge.amount.toString(),
    volumeUsd: micros(c.volumeUsdMicros),
    feeUsd: micros(c.feeUsdMicros),
    feeToken: c.feeToken == null ? null : c.feeToken.toString(),
    feeBasis: describeFee(kind, partner.fees),
  };
  const json = JSON.stringify(record);
  const lastField = `last|${tierOf(net.key)}`;

  // A private payment never moves "last": its time would point at it on chain.
  // A transaction counted at its own (earlier) time never moves "last" back.
  let setLast = kind !== "private_payment";
  if (setLast && args.now !== undefined) {
    const prev = Number(await kv1(["HGET", k("stats2", partner.id), lastField]));
    setLast = !(Number.isFinite(prev) && prev >= now);
  }

  const cmds: KvCommand[] = [
    ["LPUSH", k("events", partner.id), json],
    ["LTRIM", k("events", partner.id), 0, EVENTS_MAX - 1],
    ["SET", k("txrec", net.chainId, txHash), JSON.stringify({ partnerId: partner.id, json }), "EX", TX_TTL_SEC],
    ...counterCommands(partner.id, record, 1n),
  ];
  if (setLast) cmds.push(["HSET", k("stats2", partner.id), lastField, now]);
  await kv(cmds);
  return { recorded: true, record };
}

/**
 * Claims a transaction for a partner without counting it: a swap's refund or exit sent
 * with its key. It brings money back and is no one's swap or deposit, and once claimed
 * it can't be attributed as either. True when this call claimed it.
 */
export async function claimTransaction(partner: Pick<Partner, "id">, chainId: number, txHash: Hex): Promise<boolean> {
  const [claim] = await kv([["SET", k("tx", chainId, txHash.toLowerCase()), partner.id, "NX", "EX", TX_TTL_SEC]]);
  return claim === "OK";
}

/** Who a transaction is attributed to, if anyone. */
export async function attributedTo(chainId: number, txHash: string): Promise<string | null> {
  const v = await kv1(["GET", k("tx", chainId, txHash.toLowerCase())]);
  return typeof v === "string" ? v : null;
}

/** Who a transaction was counted to, and its record; null when it was not counted (or only claimed). */
export async function countedRecord(chainId: number, txHash: string): Promise<{ partnerId: string; record: ActivityRecord } | null> {
  const raw = jsonOf<{ partnerId: string; json: string }>(await kv1(["GET", k("txrec", chainId, txHash.toLowerCase())]));
  const record = raw ? jsonOf<ActivityRecord>(raw.json) : null;
  return raw && record ? { partnerId: raw.partnerId, record: normalized(record) } : null;
}

/**
 * Takes a counted transaction back from its partner, exactly as it was counted,
 * and frees its claim: for a cash out to another partner's own address, which the
 * on-chain match gives to that partner (lib/partnerBackfill), or for a relayed one whose
 * transaction reverted (lib/partnerRelay). Null when it was not counted.
 *
 * The record is taken with GETDEL, so of two reversals of one transaction at once only
 * one finds it, and its counters come off once.
 */
export async function reverseActivity(chainId: number, txHash: string): Promise<{ partnerId: string; record: ActivityRecord } | null> {
  const h = txHash.toLowerCase();
  const raw = jsonOf<{ partnerId: string; json: string }>(await kv1(["GETDEL", k("txrec", chainId, h)]));
  const record = raw ? jsonOf<ActivityRecord>(raw.json) : null;
  if (!raw || !record) return null;
  await kv([
    ...counterCommands(raw.partnerId, normalized(record), -1n),
    ["LREM", k("events", raw.partnerId), 0, raw.json],
    ["DEL", k("tx", chainId, h)],
  ]);
  return { partnerId: raw.partnerId, record: normalized(record) };
}

/**
 * Counters written before this layout (stats:<id>, mainnet and testnet together)
 * are replayed once into stats2 from the account's own activity list, each record
 * under its own network and day. An account with more older activity than the list
 * keeps (200) gets the flag "partial:<missing>", which the admin view shows.
 */
export async function ensureMigrated(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const flags = await kv(ids.map((id) => ["GET", k("v2", id)] as KvCommand));
  for (let i = 0; i < ids.length; i++) {
    if (typeof flags[i] === "string") continue;
    await migrateOne(ids[i]!);
  }
}

async function migrateOne(id: string): Promise<void> {
  const [lock] = await kv([["SET", k("v2lock", id), "1", "NX", "EX", 60]]);
  if (lock !== "OK") return;
  try {
    const [rawList, v1] = await kv([
      ["LRANGE", k("events", id), 0, -1],
      ["HGETALL", k("stats", id)],
    ]);
    const legacy = (Array.isArray(rawList) ? rawList : [])
      .map((r) => jsonOf<ActivityRecord>(r))
      .filter((r): r is ActivityRecord => Boolean(r) && r!.v !== 2)
      .map(normalized);
    const cmds: KvCommand[] = [];
    const last: Partial<Record<Tier, number>> = {};
    for (const r of legacy) {
      cmds.push(...counterCommands(id, r, 1n));
      if (r.kind === "private_payment") continue; // never sets "last" (see recordActivity)
      const t = tierOf(r.network);
      last[t] = Math.max(last[t] ?? 0, r.ts);
    }
    const prev = hashNumbers(await kv1(["HGETALL", k("stats2", id)]));
    for (const t of TIERS) {
      if (last[t] && !(prev[`last|${t}`] >= last[t]!)) cmds.push(["HSET", k("stats2", id), `last|${t}`, last[t]!]);
    }
    const old = hashNumbers(v1);
    const counted = ACTIVITY_KINDS.reduce((n, kind) => n + (old[`n:${kind}`] ?? 0), 0);
    cmds.push(["SET", k("v2", id), counted > legacy.length ? `partial:${counted - legacy.length}` : "1"]);
    await kv(cmds);
  } finally {
    await kv1(["DEL", k("v2lock", id)]).catch(() => undefined);
  }
}

/** "partial:<n>" when an account's older activity outran its list; null otherwise. */
export async function migrationNote(id: string): Promise<string | null> {
  const v = await kv1(["GET", k("v2", id)]);
  return typeof v === "string" && v.startsWith("partial:") ? v : null;
}

// ---------------------------------------------------------------- summaries

export type KindTotals = {
  count: number;
  volumeUsd: number;
  commissionUsd: number;
  unpriced: number;
  /** The vault's own cash-out fee on these, USD of the priced ones. */
  vaultFeeUsd: number;
  /** Ones that paid the vault a fee with no USD price for it. */
  vaultFeeUnpriced: number;
};

/** One source's share: counts, USD volume of public edges and the vault's fee, by kind and in all. */
export type SourceTotals = {
  counts: Record<ActivityKind, number>;
  /** Of `counts`, the link counts the payer's wallet registered (attribution grade); the rest of a link's are relay-bound. */
  walletBound: Record<ActivityKind, number>;
  /** USD of priced public edges (deposits, cash outs, swaps' inputs), by kind. */
  volumeUsdByKind: Record<ActivityKind, number>;
  vaultFeeUsdByKind: Record<ActivityKind, number>;
  volumeUsd: number;
  vaultFeeUsd: number;
};

export type AssetTotals = {
  network: NetworkKey;
  chainId: number;
  asset: Address;
  symbol: string;
  /** Whole tokens, as decimal strings (six places at most): what deposits and cash outs moved. */
  volume: string;
  /** Would-be partner fees in this token. */
  commission: string;
  /** Whole tokens: the inputs of private swaps in this token. */
  swapVolume: string;
  /** Whole tokens: the vault's own cash-out fee on these (cash outs and swaps). */
  vaultFee: string;
  /** Whole tokens moved, per kind. */
  byKind: Record<"cash_out" | "deposit" | "private_swap", string>;
};

/** One day's counts for one network, source and kind. */
export type DayRow = {
  network: NetworkKey;
  source: ActivitySource;
  kind: ActivityKind;
  count: number;
  /** null for private payments (no amount) and when nothing was priced (testnet). */
  volumeUsd: number | null;
  vaultFeeUsd: number;
};

export type DayTotals = {
  day: string;
  privatePayments: number;
  cashOuts: number;
  deposits: number;
  /** Private swaps. */
  swaps: number;
  /** USD of priced deposits and cash outs (swaps are not in it). */
  volumeUsd: number;
  /** USD of priced swap inputs. */
  swapVolumeUsd: number;
  commissionUsd: number;
  /** The vault's own fee on that day's cash outs and swaps, priced ones. */
  vaultFeeUsd: number;
  /** That day's activity by source and kind. */
  bySource: Record<ActivitySource, SourceTotals>;
  /** That day's activity by network, source and kind (for the CSV). */
  rows: DayRow[];
};

export type PartnerStats = {
  /** Every figure here is for this tier only. */
  tier: Tier;
  totals: {
    privatePayments: number;
    cashOuts: number;
    deposits: number;
    /** Private swaps. */
    privateSwaps: number;
    /** USD of priced deposits and cash outs. Swaps are counted apart, in swapVolumeUsd. 0 on testnet. */
    publicVolumeUsd: number;
    /** USD of the priced inputs of private swaps (each swap's asset and amount in). */
    swapVolumeUsd: number;
    /** Would-be commissions in USD, every kind, priced only. */
    commissionUsd: number;
    /** Deposits, cash outs and swaps with no USD price (counted, not valued): every one on testnet. */
    unpriced: number;
    /** The vault's own cash-out fee these brought in, USD of the priced ones. */
    vaultFeeUsd: number;
    /** Cash outs and swaps whose vault fee has no USD price. */
    vaultFeeUnpriced: number;
  };
  byKind: Record<ActivityKind, KindTotals>;
  bySource: Record<ActivitySource, SourceTotals>;
  /** The tier's networks only. */
  byNetwork: Partial<Record<NetworkKey, Record<ActivityKind, number>>>;
  byAsset: AssetTotals[];
  daily: DayTotals[];
  lastActivity: number | null;
};

function microString(v: number): string {
  const neg = v < 0;
  const s = Math.abs(Math.trunc(v)).toString().padStart(7, "0");
  const out = `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, "");
  return (neg ? "-" : "") + (out || "0");
}

export function lastDays(n: number, now = Date.now()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(utcDay(now - i * 86_400_000));
  return out;
}

const zeroKinds = (): Record<ActivityKind, number> => ({ private_payment: 0, cash_out: 0, deposit: 0, private_swap: 0 });
const isKind = (s: string): s is ActivityKind => (ACTIVITY_KINDS as string[]).includes(s);
const isSource = (s: string): s is ActivitySource => (ACTIVITY_SOURCES as string[]).includes(s);

type Cell = { n: number; nw: number; usd: number; fee: number; vf: number; unp: number; vfu: number };
const emptyCell = (): Cell => ({ n: 0, nw: 0, usd: 0, fee: 0, vf: 0, unp: 0, vfu: 0 });

/** The tier's counter cells by network, source and kind, from one hash. */
function cellsOf(c: Record<string, number>, tier: Tier): Map<string, { network: NetworkKey; source: ActivitySource; kind: ActivityKind; cell: Cell }> {
  const out = new Map<string, { network: NetworkKey; source: ActivitySource; kind: ActivityKind; cell: Cell }>();
  for (const [field, v] of Object.entries(c)) {
    const parts = field.split("|");
    if (parts.length !== 4) continue;
    const [network, source, kind, metric] = parts as [string, string, string, string];
    if (!isNetworkKey(network) || !isSource(source) || !isKind(kind) || tierOf(network) !== tier) continue;
    if (!["n", "nw", "usd", "fee", "vf", "unp", "vfu"].includes(metric)) continue;
    const key = `${network}|${source}|${kind}`;
    const row = out.get(key) ?? { network, source, kind, cell: emptyCell() };
    row.cell[metric as keyof Cell] += v;
    out.set(key, row);
  }
  return out;
}

function sourcesOf(cells: ReturnType<typeof cellsOf>): Record<ActivitySource, SourceTotals> {
  const out = {} as Record<ActivitySource, SourceTotals>;
  for (const src of ACTIVITY_SOURCES) {
    const counts = zeroKinds();
    const walletBound = zeroKinds();
    const volumeUsdByKind = zeroKinds();
    const vaultFeeUsdByKind = zeroKinds();
    for (const { source, kind, cell } of cells.values()) {
      if (source !== src) continue;
      counts[kind] += cell.n;
      walletBound[kind] += cell.nw;
      volumeUsdByKind[kind] += cell.usd / 1e6;
      vaultFeeUsdByKind[kind] += cell.vf / 1e6;
    }
    const sum = (r: Record<ActivityKind, number>) => ACTIVITY_KINDS.reduce((s, kind) => s + r[kind], 0);
    out[src] = { counts, walletBound, volumeUsdByKind, vaultFeeUsdByKind, volumeUsd: sum(volumeUsdByKind), vaultFeeUsd: sum(vaultFeeUsdByKind) };
  }
  return out;
}

/** Turns a stats hash (and day hashes) into one tier's totals. Pure, for tests. */
export function summarizeStats(
  stats: Record<string, number>,
  days: { day: string; counters: Record<string, number> }[],
  tier: Tier = "mainnet"
): PartnerStats {
  const cells = cellsOf(stats, tier);
  const byKind = {} as Record<ActivityKind, KindTotals>;
  for (const kind of ACTIVITY_KINDS) {
    const t = { count: 0, volumeUsd: 0, commissionUsd: 0, unpriced: 0, vaultFeeUsd: 0, vaultFeeUnpriced: 0 };
    for (const { kind: k2, cell } of cells.values()) {
      if (k2 !== kind) continue;
      t.count += cell.n;
      t.volumeUsd += cell.usd / 1e6;
      t.commissionUsd += cell.fee / 1e6;
      t.unpriced += cell.unp;
      t.vaultFeeUsd += cell.vf / 1e6;
      t.vaultFeeUnpriced += cell.vfu;
    }
    byKind[kind] = t;
  }
  const byNetwork: Partial<Record<NetworkKey, Record<ActivityKind, number>>> = {};
  for (const net of NETWORK_KEYS) if (tierOf(net) === tier) byNetwork[net] = zeroKinds();
  for (const { network, kind, cell } of cells.values()) byNetwork[network]![kind] += cell.n;

  type Row = { volume: number; commission: number; swap: number; vaultFee: number; kinds: Record<string, number> };
  const assets = new Map<string, Row>();
  for (const [field, v] of Object.entries(stats)) {
    const m = /^a\|(\d+)\|(0x[0-9a-f]{40})\|([a-z_]+)\|(vt|ft|vft)$/.exec(field);
    if (!m) continue;
    const key = `${m[1]}:${m[2]}`;
    const kind = m[3]!;
    const row = assets.get(key) ?? { volume: 0, commission: 0, swap: 0, vaultFee: 0, kinds: {} };
    if (m[4] === "vt") {
      row.kinds[kind] = (row.kinds[kind] ?? 0) + v;
      if (kind === "private_swap") row.swap += v;
      else row.volume += v;
    } else if (m[4] === "ft") row.commission += v;
    else row.vaultFee += v;
    assets.set(key, row);
  }
  const byAsset: AssetTotals[] = [];
  for (const [key, row] of assets) {
    const [chain, asset] = key.split(":") as [string, Address];
    const net = NETWORK_KEYS.map(getNetwork).find((n) => String(n.chainId) === chain);
    if (!net || tierOf(net.key) !== tier) continue;
    byAsset.push({
      network: net.key,
      chainId: net.chainId,
      asset: getAddress(asset),
      symbol: assetInfo(net, asset)?.symbol ?? `${asset.slice(0, 6)}…${asset.slice(-4)}`,
      volume: microString(row.volume),
      commission: microString(row.commission),
      swapVolume: microString(row.swap),
      vaultFee: microString(row.vaultFee),
      byKind: {
        cash_out: microString(row.kinds.cash_out ?? 0),
        deposit: microString(row.kinds.deposit ?? 0),
        private_swap: microString(row.kinds.private_swap ?? 0),
      },
    });
  }
  byAsset.sort((a, b) => Number(b.volume) + Number(b.swapVolume) - (Number(a.volume) + Number(a.swapVolume)));

  const daily: DayTotals[] = days.map(({ day, counters }) => {
    const dc = cellsOf(counters, tier);
    const k = (kind: ActivityKind, m: keyof Cell) => [...dc.values()].filter((x) => x.kind === kind).reduce((s, x) => s + x.cell[m], 0);
    const rows: DayRow[] = [...dc.values()]
      .filter((x) => x.cell.n !== 0)
      .map((x) => ({
        network: x.network,
        source: x.source,
        kind: x.kind,
        count: x.cell.n,
        volumeUsd: x.kind === "private_payment" || (x.cell.usd === 0 && x.cell.unp > 0) ? null : x.cell.usd / 1e6,
        vaultFeeUsd: x.cell.vf / 1e6,
      }))
      .sort((a, b) => a.network.localeCompare(b.network) || a.source.localeCompare(b.source) || a.kind.localeCompare(b.kind));
    return {
      day,
      privatePayments: k("private_payment", "n"),
      cashOuts: k("cash_out", "n"),
      deposits: k("deposit", "n"),
      swaps: k("private_swap", "n"),
      volumeUsd: (k("cash_out", "usd") + k("deposit", "usd")) / 1e6,
      swapVolumeUsd: k("private_swap", "usd") / 1e6,
      commissionUsd: ACTIVITY_KINDS.reduce((s, kind) => s + k(kind, "fee"), 0) / 1e6,
      vaultFeeUsd: ACTIVITY_KINDS.reduce((s, kind) => s + k(kind, "vf"), 0) / 1e6,
      bySource: sourcesOf(dc),
      rows,
    };
  });

  return {
    tier,
    totals: {
      privatePayments: byKind.private_payment.count,
      cashOuts: byKind.cash_out.count,
      deposits: byKind.deposit.count,
      privateSwaps: byKind.private_swap.count,
      publicVolumeUsd: byKind.cash_out.volumeUsd + byKind.deposit.volumeUsd,
      swapVolumeUsd: byKind.private_swap.volumeUsd,
      commissionUsd: ACTIVITY_KINDS.reduce((s, kind) => s + byKind[kind].commissionUsd, 0),
      unpriced: byKind.cash_out.unpriced + byKind.deposit.unpriced + byKind.private_swap.unpriced,
      vaultFeeUsd: ACTIVITY_KINDS.reduce((s, kind) => s + byKind[kind].vaultFeeUsd, 0),
      vaultFeeUnpriced: ACTIVITY_KINDS.reduce((s, kind) => s + byKind[kind].vaultFeeUnpriced, 0),
    },
    byKind,
    bySource: sourcesOf(cells),
    byNetwork,
    byAsset,
    daily,
    lastActivity: stats[`last|${tier}`] ? stats[`last|${tier}`]! : null,
  };
}

export const STATS_DAYS = 14;
/** The most days a breakdown or an export reads: as long as day counters are kept. */
export const STATS_DAYS_MAX = 120;

/**
 * One partner's figures for one tier: totals, the last `days` days (14 unless
 * asked), and (optionally) the most recent activity on that tier.
 * `forPartner`: what the partner itself is shown. Private payments are never
 * listed one by one, and are counted only for days that have ended (UTC): today's
 * are left out of every figure until the day closes, and none ever moves
 * lastActivity, so no figure moves when one lands and none can be found on chain
 * by its time. Cash outs and swaps, public on chain, stay listed.
 */
export async function readPartnerStats(
  partnerId: string,
  opts: { recent?: number; days?: number; tier?: Tier; forPartner?: boolean } = {}
): Promise<PartnerStats & { recent: ActivityRecord[] }> {
  const tier = opts.tier ?? "mainnet";
  await ensureMigrated([partnerId]);
  const n = Math.max(1, Math.min(Math.trunc(opts.days ?? STATS_DAYS), STATS_DAYS_MAX));
  const days = lastDays(n);
  const recentN = Math.max(0, Math.min(opts.recent ?? 0, EVENTS_MAX));
  const cmds: KvCommand[] = [["HGETALL", k("stats2", partnerId)], ...days.map((d) => ["HGETALL", k("day2", partnerId, d)] as KvCommand)];
  if (recentN > 0) cmds.push(["LRANGE", k("events", partnerId), 0, EVENTS_MAX - 1]);
  const res = await kv(cmds);
  const stats = hashNumbers(res[0]);
  const dayRows = days.map((day, i) => ({ day, counters: hashNumbers(res[i + 1]) }));
  if (opts.forPartner) {
    // today's private payments wait for the day to close: out of the day and out of the totals
    const today = dayRows.find((d) => d.day === utcDay(Date.now()));
    if (today) {
      for (const [f, v] of Object.entries(today.counters)) {
        if (f.split("|")[2] !== "private_payment") continue;
        stats[f] = (stats[f] ?? 0) - v;
        today.counters[f] = 0;
      }
    }
  }
  const recentRaw = recentN > 0 ? (res[days.length + 1] as unknown[]) : [];
  // newest first by when it happened: a past one matched on chain is pushed with today's, but keeps its own time
  const recent = (Array.isArray(recentRaw) ? recentRaw : [])
    .map((r) => jsonOf<ActivityRecord>(r))
    .filter((r): r is ActivityRecord => Boolean(r))
    .map(normalized)
    .filter((r) => tierOf(r.network) === tier && !(opts.forPartner && r.kind === "private_payment"))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, recentN);
  return { ...summarizeStats(stats, dayRows, tier), recent };
}

export type PartnerTotals = PartnerStats["totals"] & { lastActivity: number | null; bySource: PartnerStats["bySource"] };

/** Every partner's all-time totals for a tier in one round trip, for the admin list, and the program's sum. */
export async function readAllPartnerTotals(ids: string[], tier: Tier = "mainnet"): Promise<{ byPartner: Record<string, PartnerTotals>; program: PartnerTotals }> {
  await ensureMigrated(ids);
  const res = ids.length ? await kv(ids.map((id) => ["HGETALL", k("stats2", id)] as KvCommand)) : [];
  const byPartner: Record<string, PartnerTotals> = {};
  const merged: Record<string, number> = {};
  ids.forEach((id, i) => {
    const h = hashNumbers(res[i]);
    const s = summarizeStats(h, [], tier);
    byPartner[id] = { ...s.totals, lastActivity: s.lastActivity, bySource: s.bySource };
    for (const [f, v] of Object.entries(h)) {
      if (f.startsWith("last|")) merged[f] = Math.max(merged[f] ?? 0, v);
      else merged[f] = (merged[f] ?? 0) + v;
    }
  });
  const all = summarizeStats(merged, [], tier);
  return { byPartner, program: { ...all.totals, lastActivity: all.lastActivity, bySource: all.bySource } };
}

// ---------------------------------------------------------------- CSV

const KIND_LABEL: Record<ActivityKind, string> = {
  private_payment: "Private payment",
  cash_out: "Cash out",
  deposit: "Deposit",
  private_swap: "Private swap",
};

/**
 * One cell. A cell a spreadsheet would run as a formula (=, +, -, @, a tab or a
 * carriage return first) gets an apostrophe in front, so it reads as text: a
 * partner's name is whatever they typed.
 */
export function csvCell(v: string | number | null | undefined): string {
  const raw = v == null ? "" : String(v);
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvLines = (rows: (string | number | null | undefined)[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

const usd2 = (n: number) => (Math.round(n * 1e6) / 1e6).toString();

/**
 * Per day, network, source and kind: count, USD volume and the vault's fee, one
 * row for each that had any activity, for one tier. Oldest day first. Testnet
 * rows carry no dollar figures: test tokens have no price.
 */
export function dailyCsv(partners: { id: string; name: string; daily: DayTotals[] }[]): string {
  const rows: (string | number)[][] = [["Date (UTC)", "Network", "Partner id", "Partner", "Source", "Kind", "Count", "Volume (USD)", "Vault fee (USD)"]];
  for (const p of partners) {
    for (const d of p.daily) {
      for (const r of d.rows) {
        const testnet = getNetwork(r.network).testnet === true;
        rows.push([
          d.day,
          networkName(getNetwork(r.network)),
          p.id,
          p.name,
          SOURCE_LABEL[r.source],
          KIND_LABEL[r.kind],
          r.count,
          r.kind === "private_payment" ? "Hidden" : testnet || r.volumeUsd == null ? "Not priced" : usd2(r.volumeUsd),
          testnet ? "Not priced" : usd2(r.vaultFeeUsd),
        ]);
      }
    }
  }
  return csvLines(rows);
}

/** Whole tokens from smallest units, exact. */
function units(raw: string | null | undefined, decimals: number | null | undefined): string {
  if (raw == null || decimals == null) return "";
  try {
    const v = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
    return frac ? `${v / base}.${frac}` : `${v / base}`;
  } catch {
    return "";
  }
}

/** One row per recorded transaction: only public facts. Newest first, as given. */
export function activityCsv(partners: { id: string; name: string; recent: ActivityRecord[] }[]): string {
  const rows: (string | number | null)[][] = [
    ["Time (UTC)", "Partner id", "Partner", "Source", "Network", "Chain id", "Kind", "Transaction", "Token", "Token address", "Amount", "Volume (USD)", "Vault fee", "Vault fee (USD)", "Link bound by"],
  ];
  for (const p of partners) {
    for (const r of p.recent) {
      const n = normalized(r);
      rows.push([
        new Date(n.ts).toISOString().replace("T", " ").slice(0, 19),
        p.id,
        p.name,
        SOURCE_LABEL[n.source ?? "api"],
        networkName(getNetwork(n.network)),
        n.chainId,
        KIND_LABEL[n.kind],
        n.txHash,
        n.symbol ?? "",
        n.asset ?? "",
        units(n.amount, n.decimals),
        n.volumeUsd == null ? "" : usd2(n.volumeUsd),
        units(n.vaultFee, n.decimals),
        n.vaultFeeUsd == null ? "" : usd2(n.vaultFeeUsd),
        n.source === "link" ? (n.linkBind === "relay" ? "Relay" : n.linkBind === "wallet" ? "Payer's wallet" : "") : "",
      ]);
    }
  }
  return csvLines(rows);
}

/** What a partner's own record looks like over the wire. */
export function partnerView(p: Partner) {
  return {
    id: p.id,
    owner: getAddress(p.owner),
    name: p.name,
    website: p.website,
    payout: p.payout,
    fees: p.fees,
    relayApproved: p.relayApproved === true,
    approvedName: p.approvedName ?? null,
    nameAwaitingApproval: (p.approvedName ?? null) !== p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
