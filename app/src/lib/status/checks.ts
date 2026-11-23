/**
 * The status page's checks (status.gloam.trade, /status, /api/status, and the
 * history cron). Each part of Gloam is asked once, with a timeout, and
 * answers operational, degraded or down, with how long it took, a short
 * reason and a few live facts. Server only.
 *
 * Platform: the site's pages (home, /app, /docs, /verify, /transparency), an
 *   HTTP 200 each, and the Upstash Redis store (a write and a read).
 * API: the partner API index (/api/v1), the vault leaves the app reads for
 *   claims, payments and balances (/api/vault-leaves, per network), and the
 *   browser RPC proxy (/api/rpc, per proxied network).
 * Payments and relay: per network, the relay as /api/relay reports it, the
 *   relay account's gas against the relay's own reserve, and this hour's
 *   spend against its cap (lib/relay/spendCap). While Gloam on Solana is on
 *   (lib/solanaRings/config), its fee relay as /api/solana/relay reports it
 *   (on, funded) and the relay account's SOL, read through /api/solana/rpc.
 * Networks: for every network people can see (lib/networks shownNetworks: no
 *   hidden testnet, nothing behind an off flag), the RPC the server reads
 *   through (lib/serverRpc): the latest block and its age; then the vault (one
 *   eth_call, nextIndex) and its proof verifier (verify of an empty proof,
 *   which must say false). Solana, while it is on: getHealth through the
 *   site's own Solana RPC (/api/solana/rpc), the one the app reads.
 * Bridge and integrations: Relay (relay.link) per chain, the hosted MCP server
 *   (a ping), the Glim bot's Telegram webhook, Turnkey's own status page, and,
 *   as information only, the SDK's and MCP's latest versions on npm.
 *
 * Nothing here carries an RPC URL, a key or an env value out. Reasons and
 * details are sentences written here, never an error's message: a viem error
 * names the URL it called, a private RPC URL can carry its key, and the bot's
 * token is in Telegram's URL.
 */
import "server-only";
import { createPublicClient, formatUnits, parseAbi, type Address, type PublicClient } from "viem";
import { isNetworkWritable, networkName, shownNetworks, type GloamNetwork } from "@/lib/networks";
import { readRateLimit } from "@/lib/mcpRemote/rateLimit";
import { kv, kvBackend } from "@/lib/partnersKv";
import { maxGasPriceWei } from "@/lib/relay/gasCeiling";
import {
  RELAY_RESERVE_GAS,
  TEMPO_FEE_MANAGER,
  TEMPO_FEE_RESERVE,
  TEMPO_PATH_USD,
  isTempoChain,
  tempoFeeAbi,
} from "@/lib/relay/server";
import { NEW_SEND_SHARE_PCT, hourlySpendWei } from "@/lib/relay/spendCap";
import { rpcProxyChainIds } from "@/lib/rpcProxy";
import { serverTransport } from "@/lib/serverRpc";
import { RINGS_PROXY_PATHS, RINGS_RELAY_LOW_LAMPORTS, SOLANA_NAME, SOLANA_RINGS_ENABLED } from "@/lib/solanaRings/config";
import {
  formatLatency,
  joinNames,
  worst,
  type Health,
  type PackageVersion,
  type PartCheck,
  type StatusPart,
  type StatusSnapshot,
} from "./model";

/** The live site: its pages and its own API are checked where people reach them. */
export const STATUS_SITE = "https://www.gloam.trade";
const RELAY_API = "https://api.relay.link";
const TURNKEY_STATUS = "https://www.turnkey-status.com/api/v2/summary.json";
const NPM = "https://registry.npmjs.org";
export const PACKAGES = ["@gloamtrade/sdk", "@gloamtrade/mcp"] as const;

/** One RPC call or HTTP request waits this long. */
const CALL_TIMEOUT_MS = 8_000;
/** A whole part's check never runs past this, whatever it waits on. */
const PART_CAP_MS = 10_000;
/** Answered, but slower than this: degraded. */
const SLOW_MS = 4_000;
/** The store answers from memory: slower than this is degraded. */
const STORE_SLOW_MS = 1_500;
/**
 * The relay stops on a chain when an account's gas is under its reserve (a
 * couple of sends, lib/relay/server RELAY_RESERVE_GAS, TEMPO_FEE_RESERVE).
 * Under this many times the reserve, about 20 sends at today's gas, the page
 * says it is low, so it is topped up before it stops.
 */
export const LOW_GAS_TIMES = 10n;
/** How long after a failed Telegram delivery the bot still reads as degraded. */
const GLIM_ERROR_WINDOW_S = 15 * 60;
/** Updates waiting at Telegram past this: the bot is behind. */
const GLIM_BACKLOG = 50;

const POOL_ABI = parseAbi([
  "function nextIndex() view returns (uint256)",
  "function verifier() view returns (address)",
]);
const VERIFIER_ABI = parseAbi(["function verify(bytes proof, uint256[] publicInputs) view returns (bool)"]);

/** The site's pages, checked for an HTTP 200. */
export const PAGES: { id: string; name: string; path: string }[] = [
  { id: "web:home", name: "Website", path: "/" },
  { id: "web:app", name: "App", path: "/app" },
  { id: "web:docs", name: "Docs", path: "/docs" },
  { id: "web:verify", name: "Verify", path: "/verify" },
  { id: "web:transparency", name: "Transparency", path: "/transparency" },
];

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

/** The listed networks the browser RPC proxy serves. */
function proxiedNetworks(): GloamNetwork[] {
  const ids = rpcProxyChainIds();
  return statusNetworks().filter((n) => ids.includes(n.chainId));
}

export const networkPartId = (chainId: number) => `network:${chainId}`;
export const relayPartId = (chainId: number) => `relay:${chainId}`;
/** Gloam on Solana's parts: it has no chain id and no vault, only its fee relay and its RPC. */
export const SOLANA_RELAY_PART = "relay:solana";
export const SOLANA_NETWORK_PART = "network:solana";

/** Every part the page lists, in its order within each group (the groups' order is lib/status/model GROUPS). */
export function statusParts(): StatusPart[] {
  const nets = statusNetworks();
  const proxied = proxiedNetworks();
  return [
    ...nets.map((n) => ({ id: relayPartId(n.chainId), name: `Relay on ${networkName(n)}`, group: "payments" as const, chainId: n.chainId })),
    ...(SOLANA_RINGS_ENABLED
      ? [{ id: SOLANA_RELAY_PART, name: `Relay on ${SOLANA_NAME}`, group: "payments" as const, note: "Pays the fees of private accounts" }]
      : []),
    ...nets.map((n) => ({ id: networkPartId(n.chainId), name: networkName(n), group: "networks" as const, chainId: n.chainId })),
    ...(SOLANA_RINGS_ENABLED ? [{ id: SOLANA_NETWORK_PART, name: SOLANA_NAME, group: "networks" as const, note: "Helius Privacy Rings" }] : []),
    { id: "bridge", name: "Relay bridge", group: "api", note: "relay.link" },
    { id: "leaves", name: "Vault leaves", group: "api", note: "What claims, payments and balances read" },
    ...(proxied.length
      ? [{ id: "rpc-proxy", name: "RPC proxy", group: "api" as const, note: joinNames(proxied.map((n) => networkName(n))) }]
      : []),
    { id: "mcp", name: "Hosted MCP", group: "api" },
    { id: "api", name: "Partner API", group: "api" },
    { id: "glim", name: "Glim", group: "integrations", note: "Telegram bot" },
    { id: "turnkey", name: "Turnkey", group: "integrations", note: "Email and passkey wallets" },
    ...PAGES.map((p) => ({ id: p.id, name: p.name, group: "platform" as const })),
    { id: "database", name: "Database", group: "platform", note: "Upstash Redis" },
  ];
}

type Verdict = { status: Health; latencyMs: number | null; reason: string | null; detail?: string | null };

const ok = (latencyMs: number | null, detail: string | null = null): Verdict => ({ status: "operational", latencyMs, reason: null, detail });
const slow = (ms: number, detail: string | null = null): Verdict => ({
  status: "degraded",
  latencyMs: ms,
  reason: `Slow to answer (${formatLatency(ms)}).`,
  detail,
});

/** "4 min", "45 s". */
function ageText(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 7_200) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3_600)} h`;
}

/** "0.00441", "5.8", "1,250": three significant figures. */
function amountText(units: bigint, decimals: number): string {
  const n = Number(formatUnits(units, decimals));
  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 }).format(n);
}

// ---------------------------------------------------------------- verdicts (pure, for the self-test)

export type VerifierAnswer = "rejects" | "accepts" | null;

/**
 * A network: its head through the server's RPC, its vault and its verifier.
 * The head decides down; a vault or verifier with no answer is degraded; a
 * verifier that accepts an empty proof is down.
 */
export function judgeNetwork(
  net: Pick<GloamNetwork, "family" | "testnet">,
  r: { head: { ms: number; blockAgeS: number } | null; vault: boolean; verifier: VerifierAnswer }
): Verdict {
  if (!r.head) return { status: "down", latencyMs: null, reason: "The RPC did not answer.", detail: null };
  const age = Math.max(0, r.head.blockAgeS);
  const { stale, stopped } = blockAgeLimits(net);
  const parts = r.vault && r.verifier === "rejects" ? "Vault and verifier answer" : null;
  const detail = [`Latest block ${ageText(age)} ago`, parts].filter(Boolean).join(" · ");
  if (age >= stopped) return { status: "down", latencyMs: r.head.ms, reason: `No new block for ${ageText(age)}.`, detail };
  if (r.verifier === "accepts") return { status: "down", latencyMs: r.head.ms, reason: "The verifier accepted an empty proof.", detail };
  if (age >= stale) return { status: "degraded", latencyMs: r.head.ms, reason: `The latest block is ${ageText(age)} old.`, detail };
  if (!r.vault && r.verifier === null) return { status: "degraded", latencyMs: r.head.ms, reason: "The vault and its verifier did not answer.", detail };
  if (!r.vault) return { status: "degraded", latencyMs: r.head.ms, reason: "The vault did not answer.", detail };
  if (r.verifier === null) return { status: "degraded", latencyMs: r.head.ms, reason: "The proof verifier did not answer.", detail };
  if (r.head.ms > SLOW_MS) return slow(r.head.ms, detail);
  return ok(r.head.ms, detail);
}

export interface RelayNetworkAnswer {
  chainId: number;
  enabled?: boolean;
  lowBalance?: boolean;
  gasHigh?: boolean;
  relayer?: string | null;
}

export interface RelayNetRead {
  /** /api/relay's answer: null when it did not answer at all. */
  api: { ms: number; network: RelayNetworkAnswer | null } | null;
  /** The relay account's gas and the relay's reserve, in the gas coin's smallest unit. */
  gas: { left: bigint; reserve: bigint; decimals: number; symbol: string } | null;
  /** This hour's spend as a share of the cap, 0 to 100 and over, or null (no cap, or unread). */
  spendPct: number | null;
}

/**
 * The relay on one network. Off (or out of gas): down. Gas under LOW_GAS_TIMES
 * its reserve, waiting for gas to come down, or this hour's cap used up for new
 * sends: degraded.
 */
export function judgeRelayNet(r: RelayNetRead): Verdict {
  const facts: string[] = [];
  if (r.gas) facts.push(`Gas ${amountText(r.gas.left, r.gas.decimals)} ${r.gas.symbol}`);
  if (r.spendPct !== null) facts.push(`${Math.min(100, Math.floor(r.spendPct))}% of this hour's cap used`);
  const detail = facts.length ? facts.join(" · ") : null;
  if (!r.api) return { status: "down", latencyMs: null, reason: "The relay did not answer.", detail };
  const n = r.api.network;
  const ms = r.api.ms;
  if (!n || n.enabled !== true) {
    return { status: "down", latencyMs: ms, reason: n?.lowBalance ? "Out of gas: paused until it is topped up." : "Paused.", detail };
  }
  if (r.gas && r.gas.left < r.gas.reserve * LOW_GAS_TIMES) {
    // the reserve is a couple of sends
    const sends = r.gas.reserve > 0n ? Number((r.gas.left * 2n) / r.gas.reserve) : 0;
    return { status: "degraded", latencyMs: ms, reason: `Low on gas: about ${sends} sends left.`, detail };
  }
  if (n.gasHigh === true) return { status: "degraded", latencyMs: ms, reason: "Waiting for network gas to come down.", detail };
  if (r.spendPct !== null && r.spendPct >= Number(NEW_SEND_SHARE_PCT)) {
    return { status: "degraded", latencyMs: ms, reason: "This hour's cap is used up for new sends.", detail };
  }
  if (ms > SLOW_MS) return slow(ms, detail);
  return ok(ms, detail);
}

export interface SolanaRelayRead {
  /** /api/solana/relay's answer: null when it did not answer at all. */
  api: { ms: number; on: boolean; funded: boolean } | null;
  /** The relay account's SOL in lamports, read through the site's Solana RPC, or null when unread. */
  lamports: bigint | null;
}

/**
 * Gloam's fee relay on Solana. Off, or reporting itself unfunded (the app
 * pauses Solana payments then): down. Its SOL under LOW_GAS_TIMES the line at
 * which it reports itself unfunded: degraded, so it is topped up first.
 */
export function judgeSolanaRelay(r: SolanaRelayRead): Verdict {
  const low = BigInt(RINGS_RELAY_LOW_LAMPORTS);
  const detail = r.lamports !== null ? `Gas ${amountText(r.lamports, 9)} SOL` : null;
  if (!r.api) return { status: "down", latencyMs: null, reason: "The relay did not answer.", detail };
  const { ms } = r.api;
  if (!r.api.on) return { status: "down", latencyMs: ms, reason: "Paused.", detail };
  if (!r.api.funded) {
    // funded is false when the relay's own balance read fails too
    const reason =
      r.lamports === null
        ? "Paused: it reports too little SOL for fees."
        : r.lamports < low
          ? "Out of SOL for fees: paused until it is topped up."
          : "Paused: it could not read its own balance.";
    return { status: "down", latencyMs: ms, reason, detail };
  }
  if (r.lamports !== null && r.lamports < low * LOW_GAS_TIMES) return { status: "degraded", latencyMs: ms, reason: "Low on SOL for fees.", detail };
  if (ms > SLOW_MS) return slow(ms, detail);
  return ok(ms, detail);
}

/** What getHealth said: "ok", behind the chain (Solana's node-unhealthy error), another error, or nothing readable. */
export type SolanaHealth = "ok" | "behind" | "error" | null;

/** Solana's JSON-RPC code for a node that is behind or unhealthy. */
const SOLANA_NODE_UNHEALTHY = -32005;

/** getHealth's JSON-RPC answer, as a SolanaHealth. */
export function solanaHealthOf(body: unknown): SolanaHealth {
  const b = body as { result?: unknown; error?: { code?: unknown } | null } | null | undefined;
  if (b?.result === "ok") return "ok";
  if (b?.error && typeof b.error === "object") return b.error.code === SOLANA_NODE_UNHEALTHY ? "behind" : "error";
  return null;
}

/**
 * Solana through the site's own RPC (/api/solana/rpc, the one the app reads),
 * by getHealth. No answer, or a refusal (off, not set up): down. Behind, an
 * error, or busy: degraded.
 */
export function judgeSolanaNetwork(r: { ms: number; httpStatus: number; health: SolanaHealth } | null): Verdict {
  if (!r) return { status: "down", latencyMs: null, reason: "The RPC did not answer.", detail: null };
  if (r.httpStatus === 429) return { status: "degraded", latencyMs: r.ms, reason: "Busy: it asked us to slow down.", detail: null };
  if (r.httpStatus < 200 || r.httpStatus >= 300) return { status: "down", latencyMs: r.ms, reason: `The RPC answered ${r.httpStatus}.`, detail: null };
  if (r.health === null) return { status: "down", latencyMs: r.ms, reason: "The RPC did not answer.", detail: null };
  if (r.health === "behind") return { status: "degraded", latencyMs: r.ms, reason: "The RPC is behind the chain.", detail: null };
  if (r.health === "error") return { status: "degraded", latencyMs: r.ms, reason: "The RPC answered with an error.", detail: null };
  if (r.ms > SLOW_MS) return slow(r.ms);
  return ok(r.ms);
}

/**
 * The same request made per network (or per chain), judged as one part. Each
 * read has a name and either answered well (`ok`), answered badly, or did not
 * answer (`ms` null). None well: down. Some: degraded, naming the rest.
 */
export function judgeEach(
  reads: { name: string; ms: number | null; ok: boolean }[],
  words: { none: string; some: (names: string) => string; all: string }
): Verdict {
  if (reads.length === 0) return { status: "down", latencyMs: null, reason: words.none, detail: null };
  const answered = reads.filter((r) => r.ms !== null).map((r) => r.ms as number);
  const slowest = answered.length ? Math.max(...answered) : null;
  const bad = reads.filter((r) => r.ms === null || !r.ok).map((r) => r.name);
  if (bad.length === reads.length) return { status: "down", latencyMs: slowest, reason: words.all, detail: null };
  if (bad.length) return { status: "degraded", latencyMs: slowest, reason: words.some(joinNames(bad)), detail: null };
  if (slowest !== null && slowest > SLOW_MS) return slow(slowest);
  return ok(slowest);
}

/** Telegram's word on the bot's webhook. Pure, for the self-test. */
export function judgeGlim(
  info: { ms: number; url: string; pending: number; lastErrorAt: number | null } | null,
  nowS: number,
  configured = true
): Verdict {
  if (!configured) return { status: "down", latencyMs: null, reason: "Not set up on this server.", detail: null };
  if (!info) return { status: "down", latencyMs: null, reason: "Telegram did not answer.", detail: null };
  if (!info.url) return { status: "down", latencyMs: info.ms, reason: "No webhook is set.", detail: null };
  if (info.lastErrorAt !== null && nowS - info.lastErrorAt < GLIM_ERROR_WINDOW_S) {
    return { status: "degraded", latencyMs: info.ms, reason: "Telegram could not reach the bot in the last 15 minutes.", detail: null };
  }
  if (info.pending > GLIM_BACKLOG) return { status: "degraded", latencyMs: info.ms, reason: `${info.pending} messages waiting.`, detail: null };
  if (info.ms > SLOW_MS) return slow(info.ms);
  return ok(info.ms);
}

/**
 * The parts of Turnkey that Gloam's email and passkey wallets lean on, by the
 * names on Turnkey's status page. Its dashboard, onramps and the rest are left
 * out: people never touch them through Gloam.
 */
export const TURNKEY_PARTS = ["APIs", "Authentication", "Auth Proxy", "Email", "SDKs"] as const;

const TURNKEY_STATE: Record<string, Health> = {
  operational: "operational",
  degraded_performance: "degraded",
  partial_outage: "degraded",
  under_maintenance: "degraded",
  major_outage: "down",
};

/**
 * Turnkey's own status page, told in our words, for the parts Gloam uses
 * (TURNKEY_PARTS). If none of them is listed by that name any more, its
 * overall indicator. Pure, for the self-test.
 */
export function judgeTurnkey(
  answer: { ms: number; indicator: string; components: { name: string; status: string }[] } | null
): Verdict {
  if (!answer) return { status: "down", latencyMs: null, reason: "Turnkey's status page did not answer.", detail: null };
  const { ms } = answer;
  const used = answer.components.filter((c) => (TURNKEY_PARTS as readonly string[]).includes(c.name));
  if (used.length) {
    const unwell = used.filter((c) => (TURNKEY_STATE[c.status] ?? "degraded") !== "operational");
    if (!unwell.length) return ok(ms, "As Turnkey reports it");
    const state = worst(unwell.map((c) => TURNKEY_STATE[c.status] ?? "degraded"));
    return { status: state, latencyMs: ms, reason: `Turnkey reports a problem with ${joinNames(unwell.map((c) => c.name))}.`, detail: null };
  }
  const { indicator } = answer;
  if (indicator === "none") return ok(ms, "As Turnkey reports it");
  if (indicator === "minor" || indicator === "maintenance") return { status: "degraded", latencyMs: ms, reason: "Turnkey reports a minor issue.", detail: null };
  if (indicator === "major" || indicator === "critical") return { status: "down", latencyMs: ms, reason: "Turnkey reports an outage.", detail: null };
  return { status: "degraded", latencyMs: ms, reason: "Turnkey reports an unknown state.", detail: null };
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

function request(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...FRESH, ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
}

async function getJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await request(url, init);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** The status code and time to the first byte; the body is never read. */
async function reach(url: string, init: RequestInit = {}): Promise<{ status: number; ms: number } | null> {
  const t0 = performance.now();
  try {
    const res = await request(url, init);
    const ms = Math.round(performance.now() - t0);
    await res.body?.cancel().catch(() => {});
    return { status: res.status, ms };
  } catch {
    return null;
  }
}

function clientFor(net: GloamNetwork): PublicClient {
  return createPublicClient({
    chain: net.chain,
    ccipRead: false,
    transport: serverTransport(net, { timeout: CALL_TIMEOUT_MS, retryCount: 0, fetchOptions: FRESH }),
  }) as PublicClient;
}

async function checkNetwork(net: GloamNetwork, client: PublicClient): Promise<Verdict> {
  const pool = net.pool!;
  const [block, count, verifier] = await Promise.all([
    timed(() => client.getBlock({ blockTag: "latest" })),
    timed(() => client.readContract({ address: pool, abi: POOL_ABI, functionName: "nextIndex" })),
    (async (): Promise<VerifierAnswer> => {
      try {
        const v = await client.readContract({ address: pool, abi: POOL_ABI, functionName: "verifier" });
        const said = await client.readContract({ address: v, abi: VERIFIER_ABI, functionName: "verify", args: ["0x", []] });
        return said ? "accepts" : "rejects";
      } catch {
        return null;
      }
    })(),
  ]);
  return judgeNetwork(net, {
    head: block ? { ms: block.ms, blockAgeS: Date.now() / 1000 - Number(block.value.timestamp) } : null,
    vault: count !== null,
    verifier,
  });
}

/** The relay account's gas on `net`, and the reserve under which the relay stops (lib/relay/server relayEmpty). */
async function relayGas(net: GloamNetwork, client: PublicClient, relayer: Address): Promise<RelayNetRead["gas"]> {
  try {
    if (isTempoChain(net.chainId)) {
      const chosen = await client.readContract({ address: TEMPO_FEE_MANAGER, abi: tempoFeeAbi, functionName: "userTokens", args: [relayer] });
      const token = chosen && chosen !== "0x0000000000000000000000000000000000000000" ? chosen : TEMPO_PATH_USD;
      const left = await client.readContract({ address: token, abi: tempoFeeAbi, functionName: "balanceOf", args: [relayer] });
      return { left, reserve: TEMPO_FEE_RESERVE, decimals: 6, symbol: "USD" };
    }
    const [left, gasPrice] = await Promise.all([client.getBalance({ address: relayer }), client.getGasPrice()]);
    const ceiling = maxGasPriceWei(net.chainId);
    const price = ceiling !== null && gasPrice > ceiling ? ceiling : gasPrice;
    return { left, reserve: price * RELAY_RESERVE_GAS, decimals: net.primaryAsset.decimals, symbol: net.primaryAsset.symbol };
  } catch {
    return null;
  }
}

/** This hour's relay spend on `chainId` as a share of its cap, from the relay's own count. Null with no cap or no store. */
async function relaySpendPct(chainId: number): Promise<number | null> {
  const cap = hourlySpendWei(chainId);
  if (cap === null || cap === 0n || kvBackend() !== "redis") return null;
  try {
    // the relay counts spend in gwei, per chain, per hour (lib/relay/server holdSpend)
    const used = await readRateLimit(`chain:${chainId}`, "relay-spend", Date.now(), 3600, { failClosed: true });
    return (used * 1e9 * 100) / Number(cap);
  } catch {
    return null;
  }
}

async function relayAnswer(): Promise<{ ms: number; networks: RelayNetworkAnswer[] } | null> {
  const got = await timed(() => getJson(`${STATUS_SITE}/api/relay`));
  const networks = (got?.value as { networks?: RelayNetworkAnswer[] } | undefined)?.networks;
  return got && Array.isArray(networks) ? { ms: got.ms, networks } : null;
}

async function checkRelayNet(
  net: GloamNetwork,
  client: PublicClient,
  answer: Promise<{ ms: number; networks: RelayNetworkAnswer[] } | null>
): Promise<Verdict> {
  const [api, spendPct] = await Promise.all([answer, relaySpendPct(net.chainId)]);
  const network = api?.networks.find((n) => Number(n.chainId) === net.chainId) ?? null;
  const relayer = typeof network?.relayer === "string" && /^0x[0-9a-fA-F]{40}$/.test(network.relayer) ? (network.relayer as Address) : null;
  const gas = relayer ? await relayGas(net, client, relayer) : null;
  return judgeRelayNet({ api: api ? { ms: api.ms, network } : null, gas, spendPct });
}

/** A Solana address (base58, 32 to 44 characters). */
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** One call to the site's Solana RPC, as the app makes it: its HTTP status and body, or null with no answer. */
async function solanaRpc(method: string, params: unknown[]): Promise<{ ms: number; status: number; body: unknown } | null> {
  const got = await timed(async () => {
    const res = await request(`${STATUS_SITE}${RINGS_PROXY_PATHS.rpc}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
  });
  return got ? { ms: got.ms, status: got.value.status, body: got.value.body } : null;
}

async function checkSolanaRelay(): Promise<Verdict> {
  const got = await timed(() => getJson(`${STATUS_SITE}${RINGS_PROXY_PATHS.relay}`));
  const v = got?.value as { ok?: unknown; on?: unknown; funded?: unknown; relayer?: unknown } | null | undefined;
  const api = got && v && v.ok === true ? { ms: got.ms, on: v.on === true, funded: v.funded === true } : null;
  const relayer = typeof v?.relayer === "string" && SOLANA_ADDRESS.test(v.relayer) ? v.relayer : null;
  let lamports: bigint | null = null;
  if (api && relayer) {
    const bal = await solanaRpc("getBalance", [relayer, { commitment: "confirmed" }]);
    const value = (bal?.body as { result?: { value?: unknown } } | null | undefined)?.result?.value;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) lamports = BigInt(value);
  }
  return judgeSolanaRelay({ api, lamports });
}

async function checkSolanaNetwork(): Promise<Verdict> {
  const got = await solanaRpc("getHealth", []);
  return judgeSolanaNetwork(got ? { ms: got.ms, httpStatus: got.status, health: solanaHealthOf(got.body) } : null);
}

async function checkPage(path: string): Promise<Verdict> {
  const got = await reach(`${STATUS_SITE}${path}`);
  if (!got) return { status: "down", latencyMs: null, reason: "The page did not load." };
  if (got.status < 200 || got.status >= 300) return { status: "down", latencyMs: got.ms, reason: `The page answered ${got.status}.` };
  return got.ms > SLOW_MS ? slow(got.ms) : ok(got.ms);
}

async function checkApi(): Promise<Verdict> {
  const t0 = performance.now();
  let res: Response;
  try {
    res = await request(`${STATUS_SITE}/api/v1`);
  } catch {
    return { status: "down", latencyMs: null, reason: "The API did not answer." };
  }
  const ms = Math.round(performance.now() - t0);
  const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
  if (!res.ok || body?.ok !== true) return { status: "down", latencyMs: ms, reason: `The API answered ${res.status}.` };
  return ms > SLOW_MS ? slow(ms) : ok(ms);
}

async function checkLeaves(nets: GloamNetwork[]): Promise<Verdict> {
  const reads = await Promise.all(
    nets.map(async (n) => {
      const got = await reach(`${STATUS_SITE}/api/vault-leaves?network=${encodeURIComponent(n.key)}`);
      return { name: networkName(n), ms: got?.ms ?? null, ok: got !== null && got.status === 200 };
    })
  );
  return judgeEach(reads, {
    none: "No network to check.",
    some: (names) => `Not answering for ${names}.`,
    all: "Not answering for any network.",
  });
}

async function checkRpcProxy(nets: GloamNetwork[]): Promise<Verdict> {
  const reads = await Promise.all(
    nets.map(async (n) => {
      const got = await timed(async () => {
        const res = await request(`${STATUS_SITE}/api/rpc/${n.chainId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        });
        const body = (await res.json().catch(() => null)) as { result?: unknown } | null;
        return res.ok && typeof body?.result === "string" && /^0x[0-9a-f]+$/i.test(body.result);
      });
      return { name: networkName(n), ms: got?.ms ?? null, ok: got?.value === true };
    })
  );
  return judgeEach(reads, {
    none: "No network to check.",
    some: (names) => `Not answering for ${names}.`,
    all: "Not answering for any network.",
  });
}

async function checkBridge(nets: GloamNetwork[]): Promise<Verdict> {
  const reads = await Promise.all(
    nets.map(async (n) => {
      const got = await timed(() => getJson(`${RELAY_API}/chains/health?chainId=${n.chainId}`));
      return { name: networkName(n), ms: got?.ms ?? null, ok: (got?.value as { healthy?: unknown } | undefined)?.healthy === true };
    })
  );
  return judgeEach(reads, {
    none: "No chain to check.",
    some: (names) => `Relay reports a problem on ${names}.`,
    all: "Relay did not answer for any chain.",
  });
}

async function checkMcp(): Promise<Verdict> {
  const t0 = performance.now();
  let res: Response;
  try {
    res = await request(`${STATUS_SITE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
  } catch {
    return { status: "down", latencyMs: null, reason: "The MCP server did not answer." };
  }
  const ms = Math.round(performance.now() - t0);
  if (res.status === 429) return { status: "degraded", latencyMs: ms, reason: "Busy: it asked us to slow down." };
  const body = (await res.json().catch(() => null)) as { result?: unknown } | null;
  if (!res.ok || !body || body.result === undefined) return { status: "down", latencyMs: ms, reason: `The MCP server answered ${res.status}.` };
  return ms > SLOW_MS ? slow(ms) : ok(ms);
}

async function checkGlim(): Promise<Verdict> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return judgeGlim(null, 0, false);
  // the token is in this URL: nothing about the request or its errors ever leaves this function
  const got = await timed(() => getJson(`https://api.telegram.org/bot${token}/getWebhookInfo`));
  const r = (got?.value as { ok?: boolean; result?: { url?: unknown; pending_update_count?: unknown; last_error_date?: unknown } } | undefined)
    ?.result;
  return judgeGlim(
    got && r
      ? {
          ms: got.ms,
          url: typeof r.url === "string" ? r.url : "",
          pending: Number(r.pending_update_count) || 0,
          lastErrorAt: Number(r.last_error_date) > 0 ? Number(r.last_error_date) : null,
        }
      : null,
    Date.now() / 1000
  );
}

async function checkTurnkey(): Promise<Verdict> {
  const got = await timed(() => getJson(TURNKEY_STATUS));
  const v = got?.value as { status?: { indicator?: unknown }; components?: { name?: unknown; status?: unknown }[] } | undefined;
  const indicator = v?.status?.indicator;
  const components = (Array.isArray(v?.components) ? v.components : [])
    .filter((c): c is { name: string; status: string } => typeof c?.name === "string" && typeof c?.status === "string")
    .map((c) => ({ name: c.name, status: c.status }));
  return judgeTurnkey(got && typeof indicator === "string" ? { ms: got.ms, indicator, components } : null);
}

const PROBE_KEY = "gloam:status:v1:probe";

async function checkDatabase(): Promise<Verdict> {
  if (kvBackend() !== "redis") return { status: "down", latencyMs: null, reason: "Not set up on this server." };
  const stamp = String(Date.now());
  const got = await timed(() => kv([["SET", PROBE_KEY, stamp, "EX", 900], ["GET", PROBE_KEY]]));
  if (!got) return { status: "down", latencyMs: null, reason: "The database did not answer." };
  if (got.value[1] !== stamp) return { status: "degraded", latencyMs: got.ms, reason: "A write did not read back." };
  return got.ms > STORE_SLOW_MS ? { status: "degraded", latencyMs: got.ms, reason: `Slow to answer (${formatLatency(got.ms)}).` } : ok(got.ms);
}

async function packageVersions(): Promise<PackageVersion[]> {
  return Promise.all(
    PACKAGES.map(async (name) => {
      const got = await timed(() => getJson(`${NPM}/${name.replace("/", "%2f")}/latest`));
      const v = (got?.value as { version?: unknown } | undefined)?.version;
      return { name, version: typeof v === "string" && /^\d+\.\d+\.\d+[\w.+-]*$/.test(v) ? v : null };
    })
  );
}

/** Every check at once. Never throws: a check that fails or hangs reads as down. */
export async function runStatusChecks(): Promise<StatusSnapshot> {
  const nets = statusNetworks();
  const clients = new Map(nets.map((n) => [n.chainId, clientFor(n)]));
  const relay = relayAnswer();
  const checks: [string, Promise<Verdict>][] = [
    ...PAGES.map((p) => [p.id, checkPage(p.path)] as [string, Promise<Verdict>]),
    ["database", checkDatabase()],
    ["api", checkApi()],
    ["leaves", checkLeaves(nets)],
    ["rpc-proxy", checkRpcProxy(proxiedNetworks())],
    ...nets.map((n) => [relayPartId(n.chainId), checkRelayNet(n, clients.get(n.chainId)!, relay)] as [string, Promise<Verdict>]),
    ...nets.map((n) => [networkPartId(n.chainId), checkNetwork(n, clients.get(n.chainId)!)] as [string, Promise<Verdict>]),
    ...(SOLANA_RINGS_ENABLED
      ? ([
          [SOLANA_RELAY_PART, checkSolanaRelay()],
          [SOLANA_NETWORK_PART, checkSolanaNetwork()],
        ] as [string, Promise<Verdict>][])
      : []),
    ["bridge", checkBridge(nets)],
    ["mcp", checkMcp()],
    ["glim", checkGlim()],
    ["turnkey", checkTurnkey()],
  ];
  const [verdicts, packages] = await Promise.all([
    Promise.all(checks.map(([id, p]) => capped(p).then((v) => [id, v] as const))),
    Promise.race([
      packageVersions(),
      new Promise<PackageVersion[]>((resolve) => setTimeout(() => resolve(PACKAGES.map((name) => ({ name, version: null }))), PART_CAP_MS)),
    ]),
  ]);
  const byId = new Map<string, Verdict>(verdicts);
  const parts: PartCheck[] = statusParts().map((p) => {
    const v = byId.get(p.id) ?? { status: "down" as const, latencyMs: null, reason: "Not checked." };
    return { ...p, status: v.status, latencyMs: v.latencyMs, reason: v.reason, detail: v.detail ?? null };
  });
  return { checkedAt: Date.now(), overall: worst(parts.map((c) => c.status)), parts, packages };
}
