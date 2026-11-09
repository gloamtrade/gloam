/**
 * The spend gate every money-moving tool goes through: load this agent's
 * limits (fresh on every call, so the owner can tighten them without a
 * restart), check the spend, reserve it in the log, and settle it afterwards.
 * Also builds the get_limits and get_spending_report answers.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatUnits, type Address } from "viem";
import { networkForChainId } from "@gloamtrade/sdk";
import {
  DAY_MS,
  KNOWN_ASSETS,
  assetLabel,
  checkSpend,
  findAssetLimit,
  loadPolicy,
  networkName,
  refusalFor,
  windowFor,
  type LoadedPolicy,
  type Refusal,
  type Spend,
} from "./policy.js";
import { COUNTED_STATUSES, SpendLog, counted, type SpendEntry, type SpendStatus } from "./spendLog.js";

type Env = Record<string, string | undefined>;

export const ENFORCED_BY =
  "Enforced by this MCP server before it signs (off-chain). The vault contract does not know these limits, so they bind the agent only while its key is held by this server and nowhere else.";

export function currentPolicy(env: Env = process.env): LoadedPolicy {
  return loadPolicy(env, (p) => readFileSync(p, "utf8"));
}

function agentOf(loaded: LoadedPolicy): string {
  return loaded.mode === "enforced" ? loaded.policy.agent : loaded.agent;
}

export function spendLogPath(agent: string, env: Env = process.env): string {
  return env.GLOAM_SPEND_LOG?.trim() || join(homedir(), ".gloam", `spend-log.${agent.replace(/[^\w.-]+/g, "_")}.json`);
}

/** The decimals the owner's limits give an asset, else Gloam's own list; null when neither names it. */
function knownDecimals(loaded: LoadedPolicy, chainId: number, asset: Address): number | null {
  if (loaded.mode === "enforced") {
    const limit = findAssetLimit(loaded.policy, chainId, asset);
    if (limit) return limit.decimals;
  }
  return KNOWN_ASSETS.find((a) => a.chainId === chainId && a.address.toLowerCase() === asset.toLowerCase())?.decimals ?? null;
}

function decimalsOf(loaded: LoadedPolicy, chainId: number, asset: Address): number {
  return knownDecimals(loaded, chainId, asset) ?? 18;
}

/** An asset's decimals from the owner's limits or Gloam's list, or null: a caller that sizes a cap by them must not guess. */
export function assetDecimals(chainId: number, asset: Address, env: Env = process.env): number | null {
  return knownDecimals(currentPolicy(env), chainId, asset);
}

/** Payments only ever go through Gloam's own pool on that network. */
function poolRefusal(spend: Spend & { pool?: Address }): Refusal | null {
  if (!spend.pool) return null;
  const net = networkForChainId(spend.chainId);
  if (net && net.pool.toLowerCase() === spend.pool.toLowerCase()) return null;
  return {
    code: "unknown_pool",
    message: `This payment names pool ${spend.pool}, which is not Gloam's pool on ${networkName(spend.chainId)}. Not paying through it.`,
  };
}

export type Gate =
  | { ok: true; entryId: string; logPath: string; mode: "enforced" | "off" }
  | { ok: false; refusal: { status: "refused"; code: string; message: string; agent: string; enforcedBy: string } };

/**
 * Check a spend and, when it is allowed, reserve it in the log as pending.
 * Call right before signing; settle the result with settleSpend.
 */
export function authorizeSpend(
  spend: Spend & { pool?: Address },
  env: Env = process.env,
  now: number = Date.now(),
  /** counts: false checks everything but the caps and never counts against them (a swap's exit). */
  opts: { counts?: boolean } = {}
): Gate {
  const loaded = currentPolicy(env);
  const agent = agentOf(loaded);
  const logPath = spendLogPath(agent, env);
  const log = new SpendLog(logPath);
  const decimals = decimalsOf(loaded, spend.chainId, spend.asset);
  const entry: Omit<SpendEntry, "status"> = {
    id: `sp-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    agent,
    tool: spend.tool,
    network: spend.network,
    chainId: spend.chainId,
    asset: spend.asset,
    symbol: assetLabel(spend.chainId, spend.asset),
    amountWei: spend.amountWei.toString(),
    amount: formatUnits(spend.amountWei, decimals),
    recipient: spend.recipient,
    ...(opts.counts === false ? { counts: false } : {}),
    at: new Date(now).toISOString(),
  };
  const refuse = (r: Refusal): Gate => ({
    ok: false,
    refusal: { status: "refused", code: r.code, message: r.message, agent, enforcedBy: ENFORCED_BY },
  });
  try {
    if (loaded.mode === "unset" || loaded.mode === "invalid") {
      const r = refusalFor(loaded);
      log.note({ ...entry, status: "refused", reason: r.message }, now);
      return refuse(r);
    }
    const out: { refusal: Refusal | null } = { refusal: null };
    const res = log.reserve(
      entry,
      (c) => {
        out.refusal =
          poolRefusal(spend) ?? (loaded.mode === "enforced" ? checkSpend(loaded.policy, spend, c, now, { capped: opts.counts !== false }) : null);
        return out.refusal?.message ?? null;
      },
      now
    );
    if (!res.ok) return refuse(out.refusal ?? { code: "refused", message: res.reason });
    return { ok: true, entryId: entry.id, logPath, mode: loaded.mode };
  } catch (e) {
    // No readable, writable log means no record, so nothing is spent.
    return refuse({ code: "log_unavailable", message: (e as Error).message });
  }
}

/** Record how a reserved spend ended. Never throws: the money question is already settled on-chain. */
export function settleSpend(
  gate: Extract<Gate, { ok: true }>,
  status: Exclude<SpendStatus, "pending" | "refused">,
  extra: { hash?: string; reason?: string } = {}
): string | undefined {
  try {
    new SpendLog(gate.logPath).settle(gate.entryId, status, extra);
    return undefined;
  } catch (e) {
    return `Could not update the spending log: ${(e as Error).message}`;
  }
}

/** For plans (no signer): would this spend be allowed right now? Reserves nothing. */
export function previewSpend(spend: Spend & { pool?: Address }, env: Env = process.env, now: number = Date.now()) {
  const loaded = currentPolicy(env);
  if (loaded.mode === "unset" || loaded.mode === "invalid") return { allowed: false, reason: refusalFor(loaded).message };
  const pool = poolRefusal(spend);
  if (pool) return { allowed: false, reason: pool.message };
  if (loaded.mode === "off") return { allowed: true, reason: "Limits are off (GLOAM_LIMITS=off)." };
  let entries: SpendEntry[] = [];
  try {
    entries = new SpendLog(spendLogPath(loaded.policy.agent, env)).read();
  } catch (e) {
    return { allowed: false, reason: (e as Error).message };
  }
  const r = checkSpend(loaded.policy, spend, counted(entries, loaded.policy.agent), now);
  return r ? { allowed: false, reason: r.message } : { allowed: true };
}

// ------------------------------------------------------------------ reports

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

export function limitsReport(env: Env = process.env, now: number = Date.now()) {
  const loaded = currentPolicy(env);
  const agent = agentOf(loaded);
  const base = { agent, spendLog: spendLogPath(agent, env), enforcedBy: ENFORCED_BY };
  switch (loaded.mode) {
    case "enforced": {
      const p = loaded.policy;
      return {
        ...base,
        mode: "enforced",
        source: p.source,
        expiresAt: p.expiresAt?.toISOString() ?? null,
        expired: p.expiresAt ? now > p.expiresAt.getTime() : false,
        tools: p.tools,
        recipients: p.recipients,
        swapTo: p.swapTo ? p.swapTo.map((a) => ({ symbol: a.symbol, network: networkName(a.chainId), address: a.address })) : "the assets below",
        assets: p.assets.map((a) => ({
          symbol: a.symbol,
          network: networkName(a.chainId),
          address: a.address,
          maxPerPayment: formatUnits(a.maxPerPayment, a.decimals),
          maxPerDay: formatUnits(a.maxPerDay, a.decimals),
          dayWindow: "rolling 24 hours",
        })),
      };
    }
    case "off":
      return { ...base, mode: "off", source: loaded.source, note: "No limits. Every spend is allowed, and still logged." };
    case "unset":
      return { ...base, mode: "not set", note: refusalFor(loaded).message };
    case "invalid":
      return { ...base, mode: "invalid", source: loaded.source, error: loaded.error, note: "Every spend is refused until this is fixed." };
  }
}

export function spendingReport(recent = 10, env: Env = process.env, now: number = Date.now()) {
  const loaded = currentPolicy(env);
  const agent = agentOf(loaded);
  const logPath = spendLogPath(agent, env);
  let entries: SpendEntry[];
  try {
    entries = new SpendLog(logPath).read().filter((e) => e.agent === agent);
  } catch (e) {
    return { agent, spendLog: logPath, error: (e as Error).message };
  }
  const counts = counted(entries, agent);
  const dayAgo = now - DAY_MS;

  const today =
    loaded.mode === "enforced"
      ? loaded.policy.assets.map((limit) => {
          const w = windowFor(limit, counts, now);
          const left = limit.maxPerDay > w.spent ? limit.maxPerDay - w.spent : 0n;
          return {
            symbol: limit.symbol,
            network: networkName(limit.chainId),
            spentToday: formatUnits(w.spent, limit.decimals),
            remainingToday: formatUnits(left, limit.decimals),
            maxPerDay: formatUnits(limit.maxPerDay, limit.decimals),
            maxPerPayment: formatUnits(limit.maxPerPayment, limit.decimals),
            payments: w.count,
            nextReleaseAt: iso(w.nextReleaseAt),
          };
        })
      : // No limits to measure against: just what moved, per asset.
        Object.values(
          entries
            .filter((e) => e.counts !== false && COUNTED_STATUSES.includes(e.status) && Date.parse(e.at) > dayAgo)
            .reduce<Record<string, { symbol: string; network: string; raw: bigint; decimals: number; payments: number }>>(
              (m, e) => {
                const k = `${e.chainId}:${e.asset.toLowerCase()}`;
                const d = decimalsOf(loaded, e.chainId, e.asset);
                const cur = m[k] ?? { symbol: e.symbol, network: networkName(e.chainId), raw: 0n, decimals: d, payments: 0 };
                cur.raw += BigInt(e.amountWei);
                cur.payments += 1;
                m[k] = cur;
                return m;
              },
              {}
            )
        ).map((x) => ({ symbol: x.symbol, network: x.network, spentToday: formatUnits(x.raw, x.decimals), remainingToday: null, payments: x.payments }));

  const view = (e: SpendEntry) => ({
    at: e.at,
    tool: e.tool,
    network: e.network,
    amount: e.amount,
    symbol: e.symbol,
    recipient: e.recipient,
    status: e.status,
    ...(e.counts === false ? { countedAgainstLimits: false } : {}),
    ...(e.hash ? { hash: e.hash } : {}),
    ...(e.reason ? { reason: e.reason } : {}),
  });
  const refused = entries.filter((e) => e.status === "refused");
  const n = Math.max(1, Math.min(50, Math.floor(recent)));

  return {
    agent,
    mode: loaded.mode === "unset" ? "not set" : loaded.mode,
    window: "last 24 hours (rolling)",
    today,
    recentPayments: entries
      .filter((e) => e.status !== "refused")
      .slice(-n)
      .reverse()
      .map(view),
    refusals: {
      last24h: refused.filter((e) => Date.parse(e.at) > dayAgo).length,
      recent: refused.slice(-5).reverse().map(view),
    },
    counts: "pending, sent and unconfirmed spends count against the limit; failed, reverted and refused ones do not.",
    spendLog: logPath,
    enforcedBy: ENFORCED_BY,
  };
}
