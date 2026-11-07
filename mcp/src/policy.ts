/**
 * Agent spending limits: the policy half (pure, no I/O).
 *
 * The owner who runs this MCP server gives each agent a budget: which tools it
 * may use to move money, which assets, how much per payment and per rolling 24
 * hours, who it may pay, and a date after which it cannot spend at all. Every
 * spend tool checks the policy before it signs anything.
 *
 * Honest scope: these limits are enforced by this MCP server, off-chain. The
 * vault contract does not know about them, so anyone holding the agent's key
 * outside this server is not bound by them. Pair them with a key that only this
 * server holds (or a policy-enforcing wallet) for a hard boundary.
 *
 * Assets are matched by chain and contract address, never by the symbol a
 * payee writes in a 402 challenge, so a payment cannot slip past by relabeling
 * a token. Amounts are compared in raw units using each asset's real decimals.
 *
 * Mainnet and testnet are different chains, so a limit names one of them. A
 * symbol on both (USDG, pathUSD, OUSD, Base's USDC, EURC and ETH, and Ethereum
 * Sepolia's PYUSD), or a
 * token address on both (pathUSD and OUSD sit at the same address on Tempo
 * mainnet and testnet; ETH is the zero address everywhere), means the TESTNET
 * asset unless the entry says "network": "robinhood-mainnet" / "tempo-mainnet" /
 * "base-mainnet" / "ethereum-mainnet". So a config written for testnet never
 * starts approving mainnet assets by itself. Mainnet-only symbols (USDC.e,
 * USDT0, GLOAM, USDT, BDX, PONS, CASHCAT, AI, ORBIO) and mainnet-only addresses
 * (USDG on Robinhood Chain mainnet, USDC on Base, every Ethereum token) name the
 * mainnet asset directly. A symbol on two mainnets (USDT and BDX on Base and Ethereum) names
 * the first listed, Base; name "ethereum-mainnet" for Ethereum's. BDX sits at
 * the same address on both, so its address alone names Base's too.
 */
import { formatUnits, isAddress, parseUnits, type Address } from "viem";
import { z } from "zod";
import {
  BASE_BDX,
  BASE_EURC,
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_EURC,
  BASE_SEPOLIA_USDC,
  BASE_USDC,
  BASE_USDT,
  ETHEREUM_BDX,
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
  GLOAM_NETWORKS,
  GLOAM_TOKEN,
  NATIVE_ASSET,
  RH_MAINNET_CHAIN_ID,
  RH_MAINNET_AI,
  RH_MAINNET_CASHCAT,
  RH_MAINNET_GRIFT,
  RH_MAINNET_ORBIO,
  RH_MAINNET_PONS,
  RH_MAINNET_USDG,
  RH_USDG,
  TEMPO_MAINNET_CHAIN_ID,
  TEMPO_OUSD,
  TEMPO_PATHUSD,
  TEMPO_USDCE,
  TEMPO_USDT0,
  networkName as sdkNetworkName,
  elysiumChainId,
  mainnetNetwork,
} from "@gloamtrade/sdk";
import type { NetworkKey } from "./networks.js";

export type SpendTool = "pay" | "send" | "shield" | "swap";
/**
 * The tools an agent may use when its limits list none. "swap" is not among them: an
 * owner allows private swaps by listing "swap" in tools (or GLOAM_LIMIT_TOOLS).
 */
export const SPEND_TOOLS: SpendTool[] = ["pay", "send", "shield"];
/** Every tool a limits config can name. */
export const ALL_SPEND_TOOLS: SpendTool[] = ["pay", "send", "shield", "swap"];

const TOOL_WORDS: Record<SpendTool, string> = {
  pay: "pay privately (gloam_execute_private_pay)",
  send: "send publicly (gloam_execute_transfer)",
  shield: "shield into a private balance (gloam_execute_shield)",
  swap: 'swap privately (gloam_execute_private_swap; the owner lists "swap" in tools to allow it)',
};

/** One money-moving action an agent asked for, before it is signed. */
export type Spend = {
  tool: SpendTool;
  network: NetworkKey;
  chainId: number;
  asset: Address;
  amountWei: bigint;
  /** Who receives it: a Gloam receive tag or 0x address. null for a shield (the agent's own balance). */
  recipient: string | null;
  /** A swap: the asset it buys. It must be one the owner allows (swapTo, else the agent's assets). */
  assetOut?: Address;
};

/** An asset a swap may buy (swapTo): no caps, only which asset on which network. */
export type SwapTarget = { symbol: string; address: Address; chainId: number | null };

export type AssetLimit = {
  symbol: string;
  address: Address;
  /** null: this token address on any Gloam network */
  chainId: number | null;
  decimals: number;
  maxPerPayment: bigint;
  maxPerDay: bigint;
};

export type AgentPolicy = {
  agent: string;
  /** Where the limits came from, for get_limits. */
  source: string;
  /** Spending stops after this instant. */
  expiresAt: Date | null;
  recipients: "any" | string[];
  tools: SpendTool[];
  assets: AssetLimit[];
  /** What a swap may buy. null: only the agent's own assets (`assets`). */
  swapTo: SwapTarget[] | null;
};

/** What the server runs with: enforced limits, an explicit opt-out, or nothing (every spend refused). */
export type LoadedPolicy =
  | { mode: "enforced"; policy: AgentPolicy }
  | { mode: "off"; agent: string; source: string }
  | { mode: "unset"; agent: string }
  | { mode: "invalid"; agent: string; source: string; error: string };

export type Refusal = { code: string; message: string };

// ------------------------------------------------------------------ known assets

/**
 * `stable`: a stablecoin (dollar or euro), whose amounts count currency units,
 * so one agent-wide cap can cover several of them. Required, so a newly
 * listed asset can't be left out of that rule.
 */
type KnownAsset = { symbol: string; chainId: number; address: Address; decimals: number; stable: boolean };

const RH = GLOAM_NETWORKS.robinhood.chainId;
const TEMPO = GLOAM_NETWORKS.tempo.chainId;

/** Chain id of each network a limit can name, mainnet or testnet (whether or not this build has its pool). */
export const NETWORK_CHAIN_IDS: Record<NetworkKey, number> = {
  robinhood: RH,
  tempo: TEMPO,
  base: BASE_SEPOLIA_CHAIN_ID,
  ethereum: ETHEREUM_SEPOLIA_CHAIN_ID,
  "robinhood-mainnet": RH_MAINNET_CHAIN_ID,
  "tempo-mainnet": TEMPO_MAINNET_CHAIN_ID,
  "base-mainnet": BASE_MAINNET_CHAIN_ID,
  "ethereum-mainnet": ETHEREUM_MAINNET_CHAIN_ID,
  // 0 until the SDK has Elysium's chain id (src/elysium.ts): a limit naming it is refused then.
  "elysium-mainnet": elysiumChainId() ?? 0,
};

/** The chain id a limit's network names; refuses Elysium while the SDK has no chain id for it. */
function networkChainId(key: NetworkKey): number {
  const id = NETWORK_CHAIN_IDS[key];
  if (!id) throw new Error(`${key} is not available in this version of @gloamtrade/mcp yet. Update the package.`);
  return id;
}

// Testnet assets first: a symbol on both sides resolves to the testnet unless a network is named.
export const KNOWN_ASSETS: KnownAsset[] = [
  { symbol: "ETH", chainId: RH, address: NATIVE_ASSET, decimals: 18, stable: false },
  { symbol: "USDG", chainId: RH, address: RH_USDG, decimals: 6, stable: true },
  { symbol: "OUSD", chainId: TEMPO, address: TEMPO_OUSD, decimals: 6, stable: true },
  { symbol: "PathUSD", chainId: TEMPO, address: TEMPO_PATHUSD, decimals: 6, stable: true },
  { symbol: "AlphaUSD", chainId: TEMPO, address: "0x20c0000000000000000000000000000000000001", decimals: 6, stable: true },
  { symbol: "BetaUSD", chainId: TEMPO, address: "0x20c0000000000000000000000000000000000002", decimals: 6, stable: true },
  { symbol: "ThetaUSD", chainId: TEMPO, address: "0x20c0000000000000000000000000000000000003", decimals: 6, stable: true },
  // Base Sepolia: test funds, after the older testnets so "ETH" alone stays Robinhood Chain testnet.
  { symbol: "USDC", chainId: BASE_SEPOLIA_CHAIN_ID, address: BASE_SEPOLIA_USDC, decimals: 6, stable: true },
  { symbol: "EURC", chainId: BASE_SEPOLIA_CHAIN_ID, address: BASE_SEPOLIA_EURC, decimals: 6, stable: true },
  { symbol: "ETH", chainId: BASE_SEPOLIA_CHAIN_ID, address: NATIVE_ASSET, decimals: 18, stable: false },
  // Ethereum Sepolia: a testnet too, after Base Sepolia, so a bare "USDC" stays Base Sepolia's.
  { symbol: "USDC", chainId: ETHEREUM_SEPOLIA_CHAIN_ID, address: ETHEREUM_SEPOLIA_USDC, decimals: 6, stable: true },
  { symbol: "USDG", chainId: ETHEREUM_SEPOLIA_CHAIN_ID, address: ETHEREUM_SEPOLIA_USDG, decimals: 6, stable: true },
  { symbol: "PYUSD", chainId: ETHEREUM_SEPOLIA_CHAIN_ID, address: ETHEREUM_SEPOLIA_PYUSD, decimals: 6, stable: true },
  { symbol: "EURC", chainId: ETHEREUM_SEPOLIA_CHAIN_ID, address: ETHEREUM_SEPOLIA_EURC, decimals: 6, stable: true },
  { symbol: "ETH", chainId: ETHEREUM_SEPOLIA_CHAIN_ID, address: NATIVE_ASSET, decimals: 18, stable: false },
  // Mainnet: exactly what the mainnet pools list.
  { symbol: "USDG", chainId: RH_MAINNET_CHAIN_ID, address: RH_MAINNET_USDG, decimals: 6, stable: true },
  { symbol: "GLOAM", chainId: RH_MAINNET_CHAIN_ID, address: GLOAM_TOKEN, decimals: 18, stable: false },
  { symbol: "GRIFT", chainId: RH_MAINNET_CHAIN_ID, address: RH_MAINNET_GRIFT, decimals: 18, stable: false },
  { symbol: "ETH", chainId: RH_MAINNET_CHAIN_ID, address: NATIVE_ASSET, decimals: 18, stable: false },
  { symbol: "PONS", chainId: RH_MAINNET_CHAIN_ID, address: RH_MAINNET_PONS, decimals: 18, stable: false },
  { symbol: "CASHCAT", chainId: RH_MAINNET_CHAIN_ID, address: RH_MAINNET_CASHCAT, decimals: 18, stable: false },
  { symbol: "AI", chainId: RH_MAINNET_CHAIN_ID, address: RH_MAINNET_AI, decimals: 18, stable: false },
  { symbol: "ORBIO", chainId: RH_MAINNET_CHAIN_ID, address: RH_MAINNET_ORBIO, decimals: 18, stable: false },
  { symbol: "USDC.e", chainId: TEMPO_MAINNET_CHAIN_ID, address: TEMPO_USDCE, decimals: 6, stable: true },
  { symbol: "pathUSD", chainId: TEMPO_MAINNET_CHAIN_ID, address: TEMPO_PATHUSD, decimals: 6, stable: true },
  { symbol: "USDT0", chainId: TEMPO_MAINNET_CHAIN_ID, address: TEMPO_USDT0, decimals: 6, stable: true },
  { symbol: "OUSD", chainId: TEMPO_MAINNET_CHAIN_ID, address: TEMPO_OUSD, decimals: 6, stable: true },
  { symbol: "USDC", chainId: BASE_MAINNET_CHAIN_ID, address: BASE_USDC, decimals: 6, stable: true },
  { symbol: "EURC", chainId: BASE_MAINNET_CHAIN_ID, address: BASE_EURC, decimals: 6, stable: true },
  { symbol: "USDT", chainId: BASE_MAINNET_CHAIN_ID, address: BASE_USDT, decimals: 6, stable: true },
  { symbol: "ETH", chainId: BASE_MAINNET_CHAIN_ID, address: NATIVE_ASSET, decimals: 18, stable: false },
  { symbol: "BDX", chainId: BASE_MAINNET_CHAIN_ID, address: BASE_BDX, decimals: 9, stable: false },
  // Ethereum after Base, so "USDT" alone keeps naming Base's as before; name the network for Ethereum's.
  { symbol: "USDC", chainId: ETHEREUM_MAINNET_CHAIN_ID, address: ETHEREUM_USDC, decimals: 6, stable: true },
  { symbol: "USDT", chainId: ETHEREUM_MAINNET_CHAIN_ID, address: ETHEREUM_USDT, decimals: 6, stable: true },
  { symbol: "USDG", chainId: ETHEREUM_MAINNET_CHAIN_ID, address: ETHEREUM_USDG, decimals: 6, stable: true },
  { symbol: "PYUSD", chainId: ETHEREUM_MAINNET_CHAIN_ID, address: ETHEREUM_PYUSD, decimals: 6, stable: true },
  { symbol: "EURC", chainId: ETHEREUM_MAINNET_CHAIN_ID, address: ETHEREUM_EURC, decimals: 6, stable: true },
  { symbol: "ETH", chainId: ETHEREUM_MAINNET_CHAIN_ID, address: NATIVE_ASSET, decimals: 18, stable: false },
  { symbol: "BDX", chainId: ETHEREUM_MAINNET_CHAIN_ID, address: ETHEREUM_BDX, decimals: 9, stable: false },
  // Elysium, once the SDK has its values: USDC only, after the others so a bare "USDC" keeps its old meaning.
  ...(mainnetNetwork("elysium")?.assets ?? []).map((a) => ({ symbol: a.symbol, chainId: mainnetNetwork("elysium")!.chainId, address: a.address, decimals: a.decimals, stable: true })),
];

/** "Robinhood Chain", "Tempo testnet" and so on; "any network" for a limit that names none. */
export function networkName(chainId: number | null): string {
  return chainId == null ? "any network" : sdkNetworkName(chainId);
}

/** The label for an asset an agent tried to move (known symbol, else a short address). */
export function assetLabel(chainId: number, asset: Address): string {
  const k = KNOWN_ASSETS.find((a) => a.chainId === chainId && a.address.toLowerCase() === asset.toLowerCase());
  return k ? k.symbol : `${asset.slice(0, 6)}…${asset.slice(-4)}`;
}

// ------------------------------------------------------------------ config shape

const amount = z.union([z.string(), z.number()]).transform((v) => String(v).trim());
const network = z.enum(["robinhood", "tempo", "base", "ethereum", "robinhood-mainnet", "tempo-mainnet", "base-mainnet", "ethereum-mainnet", "elysium-mainnet"]);

const assetEntry = z
  .object({
    maxPerPayment: amount.optional(),
    maxPerDay: amount.optional(),
    /** Needed for a token given by address that Gloam does not know. */
    decimals: z.number().int().min(0).max(36).optional(),
    network: network.optional(),
  })
  .strict();

const agentSchema = z
  .object({
    expiresAt: z.string().optional(),
    recipients: z.union([z.literal("any"), z.array(z.string().min(1)).min(1)]),
    tools: z.array(z.enum(["pay", "send", "shield", "swap"])).min(1).optional(),
    maxPerPayment: amount.optional(),
    maxPerDay: amount.optional(),
    assets: z.union([z.array(z.string().min(1)).min(1), z.record(assetEntry)]),
    /** What a private swap may buy; left out, only the assets above. */
    swapTo: z.union([z.array(z.string().min(1)).min(1), z.record(z.object({ network: network.optional() }).strict())]).optional(),
  })
  .strict();

const fileSchema = z.object({ agents: z.record(agentSchema) }).strict();

export type AgentConfig = z.input<typeof agentSchema>;
export type LimitsFile = z.input<typeof fileSchema>;

function zodMessage(e: z.ZodError): string {
  return e.issues
    .slice(0, 3)
    .map((i) => `${i.path.length ? i.path.join(".") : "config"}: ${i.message}`)
    .join("; ");
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

/**
 * What an asset's amounts count: currency units for a stablecoin Gloam lists
 * (KnownAsset.stable: dollars, and EURC's euro, counted, never priced here),
 * otherwise the asset itself (ETH, GLOAM, an unknown token).
 */
function unitOf(known: KnownAsset | undefined, symbol: string, address: Address): string {
  if (known?.stable) return "stablecoin";
  return known ? symbol.toUpperCase() : address.toLowerCase();
}

function normalizeRecipient(r: string): string {
  const s = r.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : s;
}

/** Turn one agent's raw config into an enforceable policy (throws with a plain message). */
export function resolveAgent(agent: string, raw: AgentConfig, source: string): AgentPolicy {
  const parsed = agentSchema.safeParse(raw);
  if (!parsed.success) throw new Error(zodMessage(parsed.error));
  const cfg = parsed.data;

  let expiresAt: Date | null = null;
  if (cfg.expiresAt !== undefined) {
    expiresAt = parseExpiry(cfg.expiresAt);
    if (!expiresAt) throw new Error(`expiresAt "${cfg.expiresAt}" is not a date. Use YYYY-MM-DD or an ISO timestamp.`);
  }

  const entries: [string, z.infer<typeof assetEntry>][] = Array.isArray(cfg.assets)
    ? cfg.assets.map((k) => [k, {}])
    : Object.entries(cfg.assets);
  if (!entries.length) throw new Error("List at least one asset the agent may spend.");

  // Assets that take the agent-wide caps, and what their amounts count in.
  const shared: { symbol: string; unit: string }[] = [];
  const assets = entries.map(([key, entry]): AssetLimit => {
    const k = key.trim();
    let known: KnownAsset | undefined;
    let address: Address;
    let chainId: number | null;
    let decimals: number;
    let symbol: string;
    const wantChain = entry.network ? networkChainId(entry.network) : null;
    if (isAddress(k)) {
      known = KNOWN_ASSETS.find(
        (a) => a.address.toLowerCase() === k.toLowerCase() && (wantChain == null || a.chainId === wantChain)
      );
      address = k;
      chainId = wantChain ?? known?.chainId ?? null;
      decimals = known?.decimals ?? entry.decimals ?? -1;
      if (decimals < 0) throw new Error(`Asset ${k} is not one Gloam knows; add "decimals" for it.`);
      symbol = known?.symbol ?? `${k.slice(0, 6)}…${k.slice(-4)}`;
    } else {
      known = KNOWN_ASSETS.find(
        (a) => a.symbol.toLowerCase() === k.toLowerCase() && (wantChain == null || a.chainId === wantChain)
      );
      if (!known) {
        throw new Error(
          `Unknown asset "${k}". Use ${KNOWN_ASSETS.map((a) => a.symbol).join(", ")}, or a 0x token address with decimals.`
        );
      }
      ({ address, chainId, decimals, symbol } = known);
    }
    const perPayment = entry.maxPerPayment ?? cfg.maxPerPayment;
    const perDay = entry.maxPerDay ?? cfg.maxPerDay;
    if (perPayment === undefined || perDay === undefined) {
      throw new Error(`${symbol} needs both maxPerPayment and maxPerDay (on the asset or the agent).`);
    }
    if (entry.maxPerPayment === undefined || entry.maxPerDay === undefined) {
      shared.push({ symbol, unit: unitOf(known, symbol, address) });
    }
    return {
      symbol,
      address,
      chainId,
      decimals,
      maxPerPayment: toRaw(perPayment, decimals, `${symbol} maxPerPayment`),
      maxPerDay: toRaw(perDay, decimals, `${symbol} maxPerDay`),
    };
  });

  // One agent-wide number is counted in each asset's own units: "50" for USDC and ETH would
  // allow 50 ETH. It may only cap assets that count alike (the stablecoins).
  const units = [...new Set(shared.map((a) => a.unit))];
  if (units.length > 1) {
    const names = [...new Set(shared.map((a) => a.symbol))];
    throw new Error(
      `The agent-wide maxPerPayment and maxPerDay count in each asset's own units, so one number can't cap ${names.join(", ")} together: "${cfg.maxPerPayment ?? cfg.maxPerDay}" would mean that many of each. Set maxPerPayment and maxPerDay on each of them (GLOAM_LIMITS_FILE), or list assets of one kind only.`
    );
  }

  return {
    agent,
    source,
    expiresAt,
    recipients: cfg.recipients === "any" ? "any" : cfg.recipients.map(normalizeRecipient),
    tools: cfg.tools ?? SPEND_TOOLS,
    assets,
    swapTo: cfg.swapTo === undefined ? null : resolveSwapTargets(cfg.swapTo),
  };
}

/** swapTo entries: a symbol Gloam knows, or a 0x token address, each on the network it names (if any). */
function resolveSwapTargets(raw: string[] | Record<string, { network?: z.infer<typeof network> }>): SwapTarget[] {
  const entries: [string, { network?: z.infer<typeof network> }][] = Array.isArray(raw) ? raw.map((k) => [k, {}]) : Object.entries(raw);
  return entries.map(([key, entry]) => {
    const k = key.trim();
    const wantChain = entry.network ? networkChainId(entry.network) : null;
    if (isAddress(k)) {
      const known = KNOWN_ASSETS.find((a) => a.address.toLowerCase() === k.toLowerCase() && (wantChain == null || a.chainId === wantChain));
      return { symbol: known?.symbol ?? `${k.slice(0, 6)}…${k.slice(-4)}`, address: k, chainId: wantChain ?? known?.chainId ?? null };
    }
    if (/^eth$/i.test(k)) return { symbol: "ETH", address: NATIVE_ASSET, chainId: wantChain };
    const known = KNOWN_ASSETS.find((a) => a.symbol.toLowerCase() === k.toLowerCase() && (wantChain == null || a.chainId === wantChain));
    if (!known) throw new Error(`swapTo: unknown asset "${k}". Use a symbol Gloam knows or a 0x token address.`);
    return { symbol: known.symbol, address: known.address, chainId: known.chainId };
  });
}

/** Whether a swap may buy `assetOut` on `chainId`: one of swapTo when the owner set it, else one of the agent's assets. */
export function swapTargetAllowed(policy: AgentPolicy, chainId: number, assetOut: Address): boolean {
  const matches = (a: { address: Address; chainId: number | null }) => a.address.toLowerCase() === assetOut.toLowerCase() && (a.chainId == null || a.chainId === chainId);
  return policy.swapTo ? policy.swapTo.some(matches) : policy.assets.some(matches);
}

const ENV_KEYS = [
  "GLOAM_LIMIT_ASSETS",
  "GLOAM_LIMIT_MAX_PER_PAYMENT",
  "GLOAM_LIMIT_MAX_PER_DAY",
  "GLOAM_LIMIT_RECIPIENTS",
  "GLOAM_LIMIT_EXPIRES",
  "GLOAM_LIMIT_TOOLS",
  "GLOAM_LIMIT_NETWORK",
  "GLOAM_LIMIT_SWAP_TO",
] as const;

function list(v: string): string[] {
  return v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Load this server's policy from the environment:
 *   GLOAM_LIMITS=off            explicit opt-out (no limits, still logged)
 *   GLOAM_LIMITS_FILE=path      a JSON file with an "agents" map, keyed by GLOAM_AGENT_ID
 *   GLOAM_LIMIT_*               one agent's limits inline (GLOAM_LIMIT_NETWORK
 *                               names the network of every asset listed there)
 * With none of these, every spend is refused until the owner sets limits.
 */
export function loadPolicy(env: Record<string, string | undefined>, readFile: (path: string) => string): LoadedPolicy {
  const agent = env.GLOAM_AGENT_ID?.trim() || "default";
  const file = env.GLOAM_LIMITS_FILE?.trim();
  const inline = ENV_KEYS.some((k) => env[k]?.trim());

  if (env.GLOAM_LIMITS?.trim().toLowerCase() === "off") {
    if (file || inline) {
      return { mode: "invalid", agent, source: "env", error: "GLOAM_LIMITS=off is set together with limits. Pick one." };
    }
    return { mode: "off", agent, source: "GLOAM_LIMITS=off" };
  }
  if (file && inline) {
    return {
      mode: "invalid",
      agent,
      source: "env",
      error: "Limits are set in both GLOAM_LIMITS_FILE and GLOAM_LIMIT_* variables. Use one place.",
    };
  }

  if (file) {
    const source = `file ${file}`;
    let json: unknown;
    try {
      json = JSON.parse(readFile(file));
    } catch (e) {
      const why = e instanceof SyntaxError ? "it is not valid JSON" : "it could not be read";
      return { mode: "invalid", agent, source, error: `The limits file ${file} is unusable: ${why}.` };
    }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) return { mode: "invalid", agent, source, error: zodMessage(parsed.error) };
    const raw = parsed.data.agents[agent];
    if (!raw) {
      return {
        mode: "invalid",
        agent,
        source,
        error: `No limits for agent "${agent}" in ${file}. Add it under "agents", or set GLOAM_AGENT_ID to one that is there.`,
      };
    }
    try {
      return { mode: "enforced", policy: resolveAgent(agent, raw as AgentConfig, source) };
    } catch (e) {
      return { mode: "invalid", agent, source, error: (e as Error).message };
    }
  }

  if (inline) {
    const source = "GLOAM_LIMIT_* environment";
    const limitNetwork = env.GLOAM_LIMIT_NETWORK?.trim();
    if (limitNetwork && !network.safeParse(limitNetwork).success) {
      return {
        mode: "invalid",
        agent,
        source,
        error: `GLOAM_LIMIT_NETWORK "${limitNetwork}" is not a Gloam network. Use robinhood-mainnet, tempo-mainnet, base-mainnet, ethereum-mainnet, robinhood, tempo, base or ethereum.`,
      };
    }
    const assetKeys = list(env.GLOAM_LIMIT_ASSETS ?? "");
    const raw: Record<string, unknown> = {
      assets: limitNetwork ? Object.fromEntries(assetKeys.map((k) => [k, { network: limitNetwork }])) : assetKeys,
      maxPerPayment: env.GLOAM_LIMIT_MAX_PER_PAYMENT?.trim() || undefined,
      maxPerDay: env.GLOAM_LIMIT_MAX_PER_DAY?.trim() || undefined,
      recipients:
        env.GLOAM_LIMIT_RECIPIENTS?.trim().toLowerCase() === "any" ? "any" : list(env.GLOAM_LIMIT_RECIPIENTS ?? ""),
    };
    if (env.GLOAM_LIMIT_EXPIRES?.trim()) raw.expiresAt = env.GLOAM_LIMIT_EXPIRES.trim();
    if (env.GLOAM_LIMIT_TOOLS?.trim()) raw.tools = list(env.GLOAM_LIMIT_TOOLS);
    if (env.GLOAM_LIMIT_SWAP_TO?.trim()) {
      const to = list(env.GLOAM_LIMIT_SWAP_TO);
      raw.swapTo = limitNetwork ? Object.fromEntries(to.map((k) => [k, { network: limitNetwork }])) : to;
    }
    try {
      return { mode: "enforced", policy: resolveAgent(agent, raw as AgentConfig, source) };
    } catch (e) {
      return { mode: "invalid", agent, source, error: (e as Error).message.replace(/^assets: /, "GLOAM_LIMIT_ASSETS: ") };
    }
  }

  return { mode: "unset", agent };
}

// ------------------------------------------------------------------ the check

export const DAY_MS = 24 * 60 * 60 * 1000;

/** A spend that already happened (or is in flight) and counts against the daily budget. */
export type CountedSpend = { chainId: number; asset: Address; amountWei: bigint; at: number };

export function findAssetLimit(policy: AgentPolicy, chainId: number, asset: Address): AssetLimit | undefined {
  return policy.assets.find(
    (a) => a.address.toLowerCase() === asset.toLowerCase() && (a.chainId == null || a.chainId === chainId)
  );
}

/**
 * What already counts against one asset's daily limit: the rolling last 24
 * hours, so a burst cannot straddle midnight. A limit with no network pools
 * that token address across networks (the cautious reading).
 */
export function windowFor(limit: AssetLimit, counted: CountedSpend[], now: number) {
  const inWindow = counted.filter(
    (c) =>
      c.at > now - DAY_MS &&
      c.asset.toLowerCase() === limit.address.toLowerCase() &&
      (limit.chainId == null || c.chainId === limit.chainId)
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

/**
 * Decide one spend against the policy and what already counts today. null means allowed.
 * `capped: false` checks everything but the amount caps, for money that was counted when it
 * first moved (a swap's exit pays out what the swap already spent).
 */
export function checkSpend(policy: AgentPolicy, spend: Spend, counted: CountedSpend[], now: number, opts: { capped?: boolean } = {}): Refusal | null {
  if (policy.expiresAt && now > policy.expiresAt.getTime()) {
    return {
      code: "expired",
      message: `This agent's permission to spend ended at ${policy.expiresAt.toISOString()}. The owner can move expiresAt later in the limits config.`,
    };
  }
  if (!policy.tools.includes(spend.tool)) {
    return {
      code: "tool_not_allowed",
      message: `This agent is not allowed to ${TOOL_WORDS[spend.tool]}. It may: ${policy.tools.join(", ")}.`,
    };
  }
  const limit = findAssetLimit(policy, spend.chainId, spend.asset);
  if (!limit) {
    return {
      code: "asset_not_allowed",
      message: `${assetLabel(spend.chainId, spend.asset)} on ${networkName(spend.chainId)} is not one of this agent's assets (${policy.assets
        .map((a) => a.symbol)
        .join(", ")}).`,
    };
  }
  if (spend.amountWei <= 0n) return { code: "bad_amount", message: "The amount must be above zero." };
  if (spend.recipient !== null && policy.recipients !== "any") {
    const who = normalizeRecipient(spend.recipient);
    if (!policy.recipients.includes(who)) {
      return {
        code: "recipient_not_allowed",
        message: `${shortRecipient(spend.recipient)} is not on this agent's list of allowed recipients.`,
      };
    }
  }
  if (spend.tool === "swap" && spend.assetOut && !swapTargetAllowed(policy, spend.chainId, spend.assetOut)) {
    return {
      code: "swap_to_not_allowed",
      message: `${assetLabel(spend.chainId, spend.assetOut)} on ${networkName(spend.chainId)} is not something this agent may swap into (${
        policy.swapTo ? `swapTo: ${policy.swapTo.map((a) => a.symbol).join(", ")}` : `its assets: ${policy.assets.map((a) => a.symbol).join(", ")}; the owner can add others in swapTo`
      }).`,
    };
  }
  if (opts.capped === false) return null;
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
      message: `That would bring the last 24 hours to ${fmt(w.spent + spend.amountWei, limit)}, over the limit of ${fmt(
        limit.maxPerDay,
        limit
      )} a day. ${fmt(left, limit)} is left right now.${when}`,
    };
  }
  return null;
}

/** Refusal for a server with no usable policy (fail closed). */
export function refusalFor(loaded: Exclude<LoadedPolicy, { mode: "enforced" } | { mode: "off" }>): Refusal {
  if (loaded.mode === "invalid") {
    return { code: "limits_invalid", message: `Spending is blocked because the limits config has a problem: ${loaded.error}` };
  }
  return {
    code: "limits_unset",
    message:
      "Spending is blocked until the owner sets limits for this agent: GLOAM_LIMITS_FILE (a JSON file) or GLOAM_LIMIT_ASSETS, GLOAM_LIMIT_MAX_PER_PAYMENT, GLOAM_LIMIT_MAX_PER_DAY and GLOAM_LIMIT_RECIPIENTS. GLOAM_LIMITS=off runs without limits.",
  };
}
