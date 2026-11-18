/**
 * The status page's checks (status.gloam.trade, /status, /api/status, and the
 * history cron). Each part of Gloam is asked once, with a timeout, and
 * answers operational, degraded or down, with how long it took and a short
 * reason. Server only.
 *
 *  - Networks: for every network people can see (lib/networks shownNetworks,
 *    so no hidden testnet, and a network behind an off flag is not there), the
 *    RPC the server reads through (lib/serverRpc: the private one when set,
 *    the public list behind it): the latest block, how long it took, and how
 *    old the block is.
 *  - Vaults: one eth_call (nextIndex) to each of those networks' vault.
 *  - Gloam relay: /api/relay as the app reads it, per network.
 *  - Bridge: Relay's (relay.link) health for each of those chains.
 *  - App and API: /api/v1. Hosted MCP: a ping to /mcp.
 *  - Database: a write and a read on the Upstash Redis store.
 *
 * Nothing here carries an RPC URL, a key or an env value out. Reasons are
 * fixed sentences written here, never an error's message: a viem error names
 * the URL it called, and a private RPC URL can carry its key.
 */
import "server-only";
import { createPublicClient, parseAbi } from "viem";
import { isNetworkWritable, networkName, shownNetworks, type GloamNetwork } from "@/lib/networks";
import { kv, kvBackend } from "@/lib/partnersKv";
import { serverTransport } from "@/lib/serverRpc";
import {
  joinNames,
  worst,
  formatLatency,
  type Health,
  type PartCheck,
  type StatusPart,
  type StatusSnapshot,
} from "./model";

/** The live site: the app's own API, relay and MCP are checked where people reach them. */
export const STATUS_SITE = "https://www.gloam.trade";
const RELAY_API = "https://api.relay.link";

/** One RPC call or HTTP request waits this long. */
const CALL_TIMEOUT_MS = 8_000;
/** A whole part's check never runs past this, whatever it waits on. */
const PART_CAP_MS = 10_000;
/** Answered, but slower than this: degraded. */
const SLOW_MS = 4_000;
/** The store answers from memory: slower than this is degraded. */
const STORE_SLOW_MS = 1_500;

const POOL_ABI = parseAbi(["function nextIndex() view returns (uint256)"]);

/**
 * How old the latest block may be, in seconds, before the chain reads as
 * stale (degraded) and then stopped (down). Every chain Gloam runs on makes a
 * block every second or faster, except Ethereum (12 s slots, some missed).
 */
export function blockAgeLimits(net: Pick<GloamNetwork, "family" | "testnet">): { stale: number; stopped: number } {
  return net.family === "ethereum" ? { stale: 180, stopped: 900 } : { stale: 60, stopped: 600 };
}

/** The networks the page lists: the ones people can pick, with a vault in. */
export function statusNetworks(): GloamNetwork[] {
  return shownNetworks().filter(isNetworkWritable);
}

export function networkPartId(chainId: number): string {
  return `network:${chainId}`;
}

/** Every part the page lists, in its order. */
export function statusParts(): StatusPart[] {
  return [
    ...statusNetworks().map((n) => ({ id: networkPartId(n.chainId), name: networkName(n), group: "networks" as const, chainId: n.chainId })),
    { id: "vaults", name: "Vaults", group: "payments" },
    { id: "relay", name: "Gloam relay", group: "payments" },
    { id: "bridge", name: "Relay bridge", group: "bridge" },
    { id: "api", name: "App and API", group: "platform" },
    { id: "mcp", name: "Hosted MCP", group: "platform" },
    { id: "database", name: "Database", group: "platform" },
  ];
}

type Verdict = { status: Health; latencyMs: number | null; reason: string | null };

const ok = (latencyMs: number | null): Verdict => ({ status: "operational", latencyMs, reason: null });

/** "4 min", "45 s". */
function ageText(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 7_200) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3_600)} h`;
}

/** The RPC's answer about the head, judged. Pure, for the self-test. */
export function judgeHead(
  net: Pick<GloamNetwork, "family" | "testnet">,
  head: { ms: number; blockAgeS: number } | null
): Verdict {
  if (!head) return { status: "down", latencyMs: null, reason: "The RPC did not answer." };
  const age = Math.max(0, head.blockAgeS);
  const { stale, stopped } = blockAgeLimits(net);
  if (age >= stopped) return { status: "down", latencyMs: head.ms, reason: `No new block for ${ageText(age)}.` };
  if (age >= stale) return { status: "degraded", latencyMs: head.ms, reason: `The latest block is ${ageText(age)} old.` };
  if (head.ms > SLOW_MS) return { status: "degraded", latencyMs: head.ms, reason: `Slow to answer (${formatLatency(head.ms)}).` };
  return ok(head.ms);
}

/** Each network's vault read, judged as one part. Pure, for the self-test. */
export function judgeVaults(reads: { name: string; ms: number | null }[]): Verdict {
  if (reads.length === 0) return { status: "down", latencyMs: null, reason: "No vault to check." };
  const failed = reads.filter((r) => r.ms === null).map((r) => r.name);
  const answered = reads.filter((r) => r.ms !== null).map((r) => r.ms as number);
  const slowest = answered.length ? Math.max(...answered) : null;
  if (failed.length === reads.length) return { status: "down", latencyMs: null, reason: "No vault answered." };
  if (failed.length) return { status: "degraded", latencyMs: slowest, reason: `No answer from the vault on ${joinNames(failed)}.` };
  if (slowest !== null && slowest > SLOW_MS) return { status: "degraded", latencyMs: slowest, reason: `Slow to answer (${formatLatency(slowest)}).` };
  return ok(slowest);
}

export interface RelayNetworkAnswer {
  chainId: number;
  enabled?: boolean;
  gasHigh?: boolean;
}

/**
 * /api/relay's answer, judged for the networks the page lists. Pure, for the
 * self-test. Off everywhere: down. Off on some, or waiting for gas to come
 * down (Ethereum's ceiling): degraded.
 */
export function judgeRelay(
  nets: { chainId: number; name: string }[],
  answer: { ms: number; networks: RelayNetworkAnswer[] } | null
): Verdict {
  if (!answer) return { status: "down", latencyMs: null, reason: "The relay did not answer." };
  const byChain = new Map(answer.networks.map((n) => [Number(n.chainId), n]));
  const off: string[] = [];
  const waiting: string[] = [];
  for (const net of nets) {
    const n = byChain.get(net.chainId);
    if (!n || n.enabled !== true) off.push(net.name);
    else if (n.gasHigh === true) waiting.push(net.name);
  }
  if (nets.length > 0 && off.length === nets.length) return { status: "down", latencyMs: answer.ms, reason: "Paused on every network." };
  if (off.length) return { status: "degraded", latencyMs: answer.ms, reason: `Paused on ${joinNames(off)}.` };
  if (waiting.length) return { status: "degraded", latencyMs: answer.ms, reason: `Waiting for lower gas on ${joinNames(waiting)}.` };
  if (answer.ms > SLOW_MS) return { status: "degraded", latencyMs: answer.ms, reason: `Slow to answer (${formatLatency(answer.ms)}).` };
  return ok(answer.ms);
}

/** Relay's health per chain, judged as one part. Pure, for the self-test. */
export function judgeBridge(reads: { name: string; ms: number | null; healthy: boolean }[]): Verdict {
  if (reads.length === 0) return { status: "down", latencyMs: null, reason: "No chain to check." };
  const answered = reads.filter((r) => r.ms !== null);
  if (answered.length === 0) return { status: "down", latencyMs: null, reason: "Relay did not answer." };
  const slowest = Math.max(...answered.map((r) => r.ms as number));
  const unwell = reads.filter((r) => r.ms === null || !r.healthy).map((r) => r.name);
  if (unwell.length === reads.length) return { status: "down", latencyMs: slowest, reason: "Relay reports a problem on every chain." };
  if (unwell.length) return { status: "degraded", latencyMs: slowest, reason: `Relay reports a problem on ${joinNames(unwell)}.` };
  if (slowest > SLOW_MS) return { status: "degraded", latencyMs: slowest, reason: `Slow to answer (${formatLatency(slowest)}).` };
  return ok(slowest);
}

// ---------------------------------------------------------------- the checks

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number } | null> {
  const t0 = performance.now();
  try {
    const value = await fn();
    return { value, ms: Math.round(performance.now() - t0) };
  } catch {
    return null;
  }
}

/** A verdict by `ms` at the latest: a check that hangs reads as down, never as nothing. */
function capped(p: Promise<Verdict>, ms = PART_CAP_MS): Promise<Verdict> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Verdict>((resolve) => {
    timer = setTimeout(() => resolve({ status: "down", latencyMs: null, reason: `No answer in ${Math.round(ms / 1000)} s.` }), ms);
  });
  return Promise.race([p.catch((): Verdict => ({ status: "down", latencyMs: null, reason: "The check failed." })), late]).finally(() =>
    clearTimeout(timer)
  );
}

/** No Next data cache, ever: every check is a fresh answer. */
const FRESH: RequestInit = { cache: "no-store" };

async function getJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, { ...FRESH, ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** A network's head and its vault read, on one client through the server's own RPC. */
async function checkNetwork(net: GloamNetwork): Promise<{ head: Verdict; vaultMs: number | null }> {
  const client = createPublicClient({
    chain: net.chain,
    ccipRead: false,
    transport: serverTransport(net, { timeout: CALL_TIMEOUT_MS, retryCount: 0, fetchOptions: FRESH }),
  });
  const [block, vault] = await Promise.all([
    timed(() => client.getBlock({ blockTag: "latest" })),
    net.pool ? timed(() => client.readContract({ address: net.pool!, abi: POOL_ABI, functionName: "nextIndex" })) : null,
  ]);
  const head = block ? { ms: block.ms, blockAgeS: Date.now() / 1000 - Number(block.value.timestamp) } : null;
  return { head: judgeHead(net, head), vaultMs: vault ? vault.ms : null };
}

async function checkRelay(nets: GloamNetwork[]): Promise<Verdict> {
  const got = await timed(() => getJson(`${STATUS_SITE}/api/relay`));
  const networks = (got?.value as { ok?: boolean; networks?: RelayNetworkAnswer[] } | undefined)?.networks;
  return judgeRelay(
    nets.map((n) => ({ chainId: n.chainId, name: networkName(n) })),
    got && Array.isArray(networks) ? { ms: got.ms, networks } : null
  );
}

async function checkBridge(nets: GloamNetwork[]): Promise<Verdict> {
  const reads = await Promise.all(
    nets.map(async (n) => {
      const got = await timed(() => getJson(`${RELAY_API}/chains/health?chainId=${n.chainId}`));
      return { name: networkName(n), ms: got?.ms ?? null, healthy: (got?.value as { healthy?: unknown } | undefined)?.healthy === true };
    })
  );
  return judgeBridge(reads);
}

async function checkApi(): Promise<Verdict> {
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(`${STATUS_SITE}/api/v1`, { ...FRESH, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch {
    return { status: "down", latencyMs: null, reason: "The API did not answer." };
  }
  const ms = Math.round(performance.now() - t0);
  const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
  if (!res.ok || body?.ok !== true) return { status: "down", latencyMs: ms, reason: `The API answered ${res.status}.` };
  if (ms > SLOW_MS) return { status: "degraded", latencyMs: ms, reason: `Slow to answer (${formatLatency(ms)}).` };
  return ok(ms);
}

async function checkMcp(): Promise<Verdict> {
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(`${STATUS_SITE}/mcp`, {
      ...FRESH,
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    return { status: "down", latencyMs: null, reason: "The MCP server did not answer." };
  }
  const ms = Math.round(performance.now() - t0);
  if (res.status === 429) return { status: "degraded", latencyMs: ms, reason: "Busy: it asked us to slow down." };
  const body = (await res.json().catch(() => null)) as { result?: unknown } | null;
  if (!res.ok || !body || body.result === undefined) return { status: "down", latencyMs: ms, reason: `The MCP server answered ${res.status}.` };
  if (ms > SLOW_MS) return { status: "degraded", latencyMs: ms, reason: `Slow to answer (${formatLatency(ms)}).` };
  return ok(ms);
}

const PROBE_KEY = "gloam:status:v1:probe";

async function checkDatabase(): Promise<Verdict> {
  if (kvBackend() !== "redis") return { status: "down", latencyMs: null, reason: "Not set up on this server." };
  const stamp = String(Date.now());
  const got = await timed(() => kv([["SET", PROBE_KEY, stamp, "EX", 900], ["GET", PROBE_KEY]]));
  if (!got) return { status: "down", latencyMs: null, reason: "The database did not answer." };
  if (got.value[1] !== stamp) return { status: "degraded", latencyMs: got.ms, reason: "A write did not read back." };
  if (got.ms > STORE_SLOW_MS) return { status: "degraded", latencyMs: got.ms, reason: `Slow to answer (${formatLatency(got.ms)}).` };
  return ok(got.ms);
}

/** Every check at once. Never throws: a check that fails or hangs reads as down. */
export async function runStatusChecks(): Promise<StatusSnapshot> {
  const nets = statusNetworks();
  const parts = statusParts();
  const perNet = nets.map((n) =>
    checkNetwork(n).catch(() => ({ head: { status: "down", latencyMs: null, reason: "The check failed." } as Verdict, vaultMs: null }))
  );
  const netCapped = perNet.map((p) => capped(p.then((r) => r.head)));
  const vaults = capped(
    Promise.all(perNet).then((rs) => judgeVaults(rs.map((r, i) => ({ name: networkName(nets[i]!), ms: r.vaultMs }))))
  );
  const [netVerdicts, vaultVerdict, relay, bridge, api, mcp, database] = await Promise.all([
    Promise.all(netCapped),
    vaults,
    capped(checkRelay(nets)),
    capped(checkBridge(nets)),
    capped(checkApi()),
    capped(checkMcp()),
    capped(checkDatabase()),
  ]);
  const verdicts = new Map<string, Verdict>([
    ...nets.map((n, i) => [networkPartId(n.chainId), netVerdicts[i]!] as const),
    ["vaults", vaultVerdict],
    ["relay", relay],
    ["bridge", bridge],
    ["api", api],
    ["mcp", mcp],
    ["database", database],
  ]);
  const checked: PartCheck[] = parts.map((p) => {
    const v = verdicts.get(p.id) ?? { status: "down" as const, latencyMs: null, reason: "Not checked." };
    return { ...p, status: v.status, latencyMs: v.latencyMs, reason: v.reason };
  });
  return { checkedAt: Date.now(), overall: worst(checked.map((c) => c.status)), parts: checked };
}
