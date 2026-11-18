/**
 * Spending limits: the policy half (pure, no I/O).
 *
 * The same model as the Gloam MCP server (mcp/src/policy.ts): the agent's
 * owner decides which actions may move money, which assets, how much per
 * payment and per rolling 24 hours, who may be paid, and a date after which
 * nothing moves. Every function that moves money checks the policy before it
 * signs anything, and no policy means no spending.
 *
 * Two differences, on purpose. First, every cap belongs to one asset. The MCP lets a
 * pair of agent-wide caps stand in for each asset, and caps count in each
 * asset's own units, so "50" next to USDC and ETH meant 50 USDC and 50 ETH (a
 * finding from the Base audit). Here an agent-wide number is refused with the
 * reason, and each asset carries its own maxPerPayment and maxPerDay. Second,
 * the caps bound money leaving the agent (payments and cash outs). Adding to
 * its own private balance only has to be an allowed action on a listed asset;
 * it is not capped and does not count against the day, so an ACP provider that
 * adds its earnings privately does not use up its payout budget.
 *
 * Assets are matched by chain and contract address, never by a symbol someone
 * else wrote, and amounts are compared in raw units with each asset's real
 * decimals.
 *
 * Honest scope: the limits are enforced by this plugin, off-chain. The vault
 * contract does not know them. They bind the agent because the agent can only
 * move money through these functions; whoever holds the key outside them is
 * not bound.
 */
import { formatUnits, isAddress, parseUnits, type Address } from "viem";
import { getGloamNetwork, networkName } from "@gloamtrade/sdk";
import { NETWORK_KEYS, type NetworkKey } from "./networks.js";

/** What can move money: add to the private balance, pay privately, cash out to a public address. */
export type SpendAction = "add" | "pay" | "cash_out";
export const SPEND_ACTIONS: SpendAction[] = ["add", "pay", "cash_out"];

/** The recipient a claim link payment counts as: whoever ends up holding the link. */
export const CLAIM_LINK_RECIPIENT = "claim-link";

const ACTION_WORDS: Record<SpendAction, string> = {
  add: "add money to its private balance",
  pay: "pay privately",
  cash_out: "cash out to a public address",
};

/** One money-moving action, before it is signed. */
export type Spend = {
  action: SpendAction;
  chainId: number;
  asset: Address;
  amountWei: bigint;
  /** A Gloam address (gloamr1.), a 0x address for a cash out, "claim-link", or null for an add. */
  recipient: string | null;
};

export type AssetLimit = {
  symbol: string;
  address: Address;
  chainId: number;
  decimals: number;
  maxPerPayment: bigint;
  maxPerDay: bigint;
};

export type SpendPolicy = {
  agent: string;
  /** Where the limits came from, for the limits report. */
  source: string;
  expiresAt: Date | null;
  recipients: "any" | string[];
  actions: SpendAction[];
  assets: AssetLimit[];
};

export type LoadedPolicy =
  | { mode: "enforced"; policy: SpendPolicy }
  | { mode: "unset"; agent: string }
  | { mode: "invalid"; agent: string; source: string; error: string };

export type Refusal = { code: string; message: string };

// ------------------------------------------------------------------ config shape

/** One asset's caps, in the asset's own units ("25" means 25 USDC). */
export type AssetLimitConfig = {
  maxPerPayment: string | number;
  maxPerDay: string | number;
  /** The network this asset is on. Default: the plugin's own network. */
  network?: NetworkKey;
  /** Needed only for a token given by address that the network's vault does not list. */
  decimals?: number;
};

/** The limits an owner writes, in code or in a JSON file. Every asset has its own caps. */
export type LimitsConfig = {
  /** Nothing moves after this ("2026-12-31" is through the end of that day, UTC). */
  expiresAt?: string;
  /** Who may be paid: "any", or a list of Gloam addresses, 0x addresses (cash outs) and "claim-link". */
  recipients: "any" | string[];
  /** Which actions may move money. Default: all three. */
  actions?: SpendAction[];
  /** Asset symbol (or token address) to its own caps. */
  assets: Record<string, AssetLimitConfig>;
};

const ONE_NUMBER_FOR_ALL =
  "One maxPerPayment or maxPerDay for every asset is not allowed: caps count in each asset's own units, so one number would mean 50 USDC and 50 ETH. Give each asset its own maxPerPayment and maxPerDay under \"assets\".";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function extraKeys(o: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(o).filter((k) => !allowed.includes(k));
}

function capText(v: unknown, what: string): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim()) return v.trim();
  throw new Error(`${what} is missing. Each asset needs its own maxPerPayment and maxPerDay.`);
}

/** Check the shape of an owner's limits (throws a plain reason). */
function parseLimitsShape(raw: unknown): LimitsConfig {
  if (!isObj(raw)) throw new Error("limits must be an object with recipients and assets.");
  if ("maxPerPayment" in raw || "maxPerDay" in raw) throw new Error(ONE_NUMBER_FOR_ALL);
  const extra = extraKeys(raw, ["expiresAt", "recipients", "actions", "assets"]);
  if (extra.length) throw new Error(`limits: unknown field ${extra.map((k) => `"${k}"`).join(", ")}.`);
  if (raw.expiresAt !== undefined && typeof raw.expiresAt !== "string") throw new Error("limits.expiresAt must be a date string.");
  const r = raw.recipients;
  if (!(r === "any" || (Array.isArray(r) && r.length > 0 && r.every((x) => typeof x === "string" && x.trim().length > 0)))) {
    throw new Error('limits.recipients must be "any" or a non-empty list of Gloam addresses, 0x addresses or "claim-link".');
  }
  if (raw.actions !== undefined) {
    const a = raw.actions;
    if (!Array.isArray(a) || !a.length || !a.every((x) => (SPEND_ACTIONS as unknown[]).includes(x))) {
      throw new Error('limits.actions must list one or more of "add", "pay", "cash_out".');
    }
  }
  if (!isObj(raw.assets)) throw new Error("limits.assets must map each asset to its own maxPerPayment and maxPerDay.");
  const assets: Record<string, AssetLimitConfig> = {};
  for (const [k, v] of Object.entries(raw.assets)) {
    if (!isObj(v)) throw new Error(`limits.assets.${k} must have maxPerPayment and maxPerDay.`);
    const bad = extraKeys(v, ["maxPerPayment", "maxPerDay", "network", "decimals"]);
    if (bad.length) throw new Error(`limits.assets.${k}: unknown field ${bad.map((b) => `"${b}"`).join(", ")}.`);
    if (v.network !== undefined && !(NETWORK_KEYS as readonly unknown[]).includes(v.network)) {
      throw new Error(`limits.assets.${k}.network must be one of: ${NETWORK_KEYS.join(", ")}.`);
    }
    if (v.decimals !== undefined && !(Number.isInteger(v.decimals) && (v.decimals as number) >= 0 && (v.decimals as number) <= 36)) {
      throw new Error(`limits.assets.${k}.decimals must be a whole number from 0 to 36.`);
    }
    assets[k] = {
      maxPerPayment: capText(v.maxPerPayment, `limits.assets.${k}.maxPerPayment`),
      maxPerDay: capText(v.maxPerDay, `limits.assets.${k}.maxPerDay`),
      network: v.network as NetworkKey | undefined,
      decimals: v.decimals as number | undefined,
    };
  }
  return {
    expiresAt: raw.expiresAt as string | undefined,
    recipients: r as "any" | string[],
    actions: raw.actions as SpendAction[] | undefined,
    assets,
  };
}

/** "2026-12-31" means through the end of that day (UTC); a full timestamp is taken as written. */
export function parseExpiry(input: string): Date | null {
  const s = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T23:59:59.999Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

function toRaw(value: string, decimals: number, what: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`${what} must be a plain number like "5" or "0.25", got "${value}".`);
  const [, frac = ""] = value.split(".");
  if (frac.length > decimals) throw new Error(`${what} has more than ${decimals} decimal places.`);
  return parseUnits(value, decimals);
}

export function normalizeRecipient(r: string): string {
  const s = r.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : s;
}

/**
 * Turn an owner's limits into an enforceable policy (throws with a plain reason).
 * `network` is the plugin's own network: an asset entry with no network is on it.
 */
export function resolveLimits(agent: string, raw: unknown, source: string, network: NetworkKey): SpendPolicy {
  const cfg = parseLimitsShape(raw);

  let expiresAt: Date | null = null;
  if (cfg.expiresAt !== undefined) {
    expiresAt = parseExpiry(cfg.expiresAt);
    if (!expiresAt) throw new Error(`expiresAt "${cfg.expiresAt}" is not a date. Use YYYY-MM-DD or an ISO timestamp.`);
  }

  const entries = Object.entries(cfg.assets);
  if (!entries.length) throw new Error("List at least one asset the agent may move, each with its own maxPerPayment and maxPerDay.");

  const assets = entries.map(([key, entry]): AssetLimit => {
    const k = key.trim();
    const netKey = entry.network ?? network;
    const net = getGloamNetwork(netKey);
    if (!net) throw new Error(`${k}: ${netKey} has no Gloam pool in this SDK version.`);
    const listed = net.assets.find((a) =>
      isAddress(k) ? a.address.toLowerCase() === k.toLowerCase() : a.symbol.toLowerCase() === k.toLowerCase()
    );
    let address: Address;
    let decimals: number;
    let symbol: string;
    if (listed) {
      ({ address, decimals, symbol } = listed);
      // A listed asset counts in its own decimals: 6 for USDT on BNB Chain (18 there) would cap a trillionth of what was meant.
      if (entry.decimals !== undefined && entry.decimals !== decimals) {
        throw new Error(`${symbol} on ${networkName(net.chainId)} has ${decimals} decimals, not ${entry.decimals}. Leave "decimals" out for an asset the vault lists.`);
      }
    } else if (isAddress(k)) {
      if (entry.decimals === undefined) throw new Error(`Asset ${k} is not one the ${net.label} vault lists; add "decimals" for it.`);
      address = k;
      decimals = entry.decimals;
      symbol = `${k.slice(0, 6)}…${k.slice(-4)}`;
    } else {
      throw new Error(`Unknown asset "${k}" on ${networkName(net.chainId)}. Use ${net.assets.map((a) => a.symbol).join(", ")}, or a 0x token address with decimals.`);
    }
    const maxPerPayment = toRaw(String(entry.maxPerPayment), decimals, `${symbol} maxPerPayment`);
    const maxPerDay = toRaw(String(entry.maxPerDay), decimals, `${symbol} maxPerDay`);
    if (maxPerPayment > maxPerDay) throw new Error(`${symbol}: maxPerPayment is above maxPerDay.`);
    return { symbol, address, chainId: net.chainId, decimals, maxPerPayment, maxPerDay };
  });

  return {
    agent,
    source,
    expiresAt,
    recipients: cfg.recipients === "any" ? "any" : cfg.recipients.map(normalizeRecipient),
    actions: cfg.actions ?? SPEND_ACTIONS,
    assets,
  };
}

/**
 * The policy from what the owner passed: a limits object in code, or a JSON
 * file. The file can hold one agent's limits, or the Gloam MCP server's
 * format ({ "agents": { "<id>": { ... } } }) keyed by the agent id. Nothing
 * passed means every spend is refused until the owner sets limits.
 */
export function loadLimits(args: {
  agent: string;
  network: NetworkKey;
  limits?: LimitsConfig;
  file?: string;
  readFile: (path: string) => string;
}): LoadedPolicy {
  const { agent, network } = args;
  if (args.limits && args.file) {
    return { mode: "invalid", agent, source: "options", error: "Limits were passed both in code and as a file. Use one." };
  }
  if (args.limits) {
    try {
      return { mode: "enforced", policy: resolveLimits(agent, args.limits, "plugin options", network) };
    } catch (e) {
      return { mode: "invalid", agent, source: "plugin options", error: (e as Error).message };
    }
  }
  if (args.file) {
    const source = `file ${args.file}`;
    let json: unknown;
    try {
      json = JSON.parse(args.readFile(args.file));
    } catch (e) {
      const why = e instanceof SyntaxError ? "it is not valid JSON" : "it could not be read";
      return { mode: "invalid", agent, source, error: `The limits file ${args.file} is unusable: ${why}.` };
    }
    let raw: unknown = json;
    if (json && typeof json === "object" && "agents" in json) {
      const agents = (json as { agents?: Record<string, unknown> }).agents ?? {};
      raw = agents[agent];
      if (!raw) {
        return { mode: "invalid", agent, source, error: `No limits for agent "${agent}" in ${args.file}. Add it under "agents", or set GLOAM_AGENT_ID to one that is there.` };
      }
    }
    try {
      return { mode: "enforced", policy: resolveLimits(agent, raw, source, network) };
    } catch (e) {
      return { mode: "invalid", agent, source, error: (e as Error).message };
    }
  }
  return { mode: "unset", agent };
}

// ------------------------------------------------------------------ the check

export const DAY_MS = 24 * 60 * 60 * 1000;

/** A spend that happened (or is in flight) and counts against the daily cap. */
export type CountedSpend = { chainId: number; asset: Address; amountWei: bigint; at: number };

export function findAssetLimit(policy: SpendPolicy, chainId: number, asset: Address): AssetLimit | undefined {
  return policy.assets.find((a) => a.chainId === chainId && a.address.toLowerCase() === asset.toLowerCase());
}

/** What already counts against one asset's daily cap: the rolling last 24 hours, so a burst cannot straddle midnight. */
export function windowFor(limit: AssetLimit, counted: CountedSpend[], now: number) {
  const inWindow = counted.filter(
    (c) => c.at > now - DAY_MS && c.chainId === limit.chainId && c.asset.toLowerCase() === limit.address.toLowerCase()
  );
  const spent = inWindow.reduce((s, c) => s + c.amountWei, 0n);
  const oldest = inWindow.reduce<number | null>((m, c) => (m == null || c.at < m ? c.at : m), null);
  return { spent, count: inWindow.length, nextReleaseAt: oldest == null ? null : oldest + DAY_MS };
}

function fmt(raw: bigint, limit: AssetLimit): string {
  return `${formatUnits(raw, limit.decimals)} ${limit.symbol}`;
}

function shortRecipient(r: string): string {
  return r.length > 24 ? `${r.slice(0, 14)}…${r.slice(-6)}` : r;
}

/** Decide one spend against the policy and what already counts. null means allowed. */
export function checkSpend(policy: SpendPolicy, spend: Spend, counted: CountedSpend[], now: number): Refusal | null {
  if (policy.expiresAt && now > policy.expiresAt.getTime()) {
    return {
      code: "expired",
      message: `This agent's permission to move money ended at ${policy.expiresAt.toISOString()}. The owner can set a later expiresAt.`,
    };
  }
  if (!policy.actions.includes(spend.action)) {
    return {
      code: "action_not_allowed",
      message: `This agent is not allowed to ${ACTION_WORDS[spend.action]}. It may: ${policy.actions.map((a) => ACTION_WORDS[a]).join("; ")}.`,
    };
  }
  const limit = findAssetLimit(policy, spend.chainId, spend.asset);
  if (!limit) {
    return {
      code: "asset_not_allowed",
      message: `That asset on ${networkName(spend.chainId)} is not one this agent may move (${policy.assets.map((a) => a.symbol).join(", ")}).`,
    };
  }
  if (spend.amountWei <= 0n) return { code: "bad_amount", message: "The amount must be above zero." };
  // Adding to its own private balance moves nothing away from the agent: allowed or not, never capped.
  if (spend.action === "add") return null;
  if (spend.recipient !== null && policy.recipients !== "any") {
    if (!policy.recipients.includes(normalizeRecipient(spend.recipient))) {
      return {
        code: "recipient_not_allowed",
        message: `${shortRecipient(spend.recipient)} is not on this agent's list of allowed recipients.`,
      };
    }
  }
  if (spend.amountWei > limit.maxPerPayment) {
    return {
      code: "over_per_payment",
      message: `${fmt(spend.amountWei, limit)} is over this agent's limit of ${fmt(limit.maxPerPayment, limit)} per payment.`,
    };
  }
  const w = windowFor(limit, counted, now);
  if (w.spent + spend.amountWei > limit.maxPerDay) {
    const left = limit.maxPerDay > w.spent ? limit.maxPerDay - w.spent : 0n;
    const when = w.nextReleaseAt ? ` More frees up from ${new Date(w.nextReleaseAt).toISOString()}.` : "";
    return {
      code: "over_daily",
      message: `That would bring the last 24 hours to ${fmt(w.spent + spend.amountWei, limit)}, over the limit of ${fmt(limit.maxPerDay, limit)} a day. ${fmt(left, limit)} is left now.${when}`,
    };
  }
  return null;
}

/** Refusal when there is no usable policy (fail closed). */
export function refusalFor(loaded: Exclude<LoadedPolicy, { mode: "enforced" }>): Refusal {
  if (loaded.mode === "invalid") {
    return { code: "limits_invalid", message: `Spending is blocked because the limits have a problem: ${loaded.error}` };
  }
  return {
    code: "limits_unset",
    message:
      "Spending is blocked until the owner sets limits for this agent: pass `limits` to the plugin, or point GLOAM_LIMITS_FILE at a JSON file. Each asset needs its own maxPerPayment and maxPerDay.",
  };
}

/** The limits as the agent may read them (and as getEnvironment shows them). */
export function limitsView(loaded: LoadedPolicy, counted: CountedSpend[], now: number) {
  if (loaded.mode !== "enforced") {
    return { enforced: false, reason: refusalFor(loaded).message };
  }
  const p = loaded.policy;
  return {
    enforced: true,
    source: p.source,
    expiresAt: p.expiresAt?.toISOString() ?? null,
    actions: p.actions,
    recipients: p.recipients === "any" ? "any" : `${p.recipients.length} allowed`,
    assets: p.assets.map((a) => {
      const w = windowFor(a, counted, now);
      const left = a.maxPerDay > w.spent ? a.maxPerDay - w.spent : 0n;
      return {
        asset: a.symbol,
        network: networkName(a.chainId),
        maxPerPayment: formatUnits(a.maxPerPayment, a.decimals),
        maxPerDay: formatUnits(a.maxPerDay, a.decimals),
        usedLast24h: formatUnits(w.spent, a.decimals),
        leftNow: formatUnits(left, a.decimals),
      };
    }),
    enforcedBy: "This plugin, before it signs (off-chain). The vault contract does not know these limits.",
  };
}
