import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createPublicClient, formatUnits, parseAbi, type Address, type ContractFunctionParameters, type PublicClient } from "viem";
import { normalize } from "viem/ens";
import { NETWORK_KEYS, getNetwork, type GloamNetwork, type NetworkKey } from "@/lib/networks";
import { loadPrices, type Prices } from "@/lib/onchainMetrics";
import { serverTransport } from "@/lib/serverRpc";
import { erc20BalanceOfAbi, isDollarStable, type OnchainToken } from "@/lib/tokens";
import { holdableTokens } from "@/lib/vaultAssets";

/**
 * What a wallet holds in public right now, across the mainnets where one read
 * covers it: every token Gloam lists there plus plain ETH, in one multicall per
 * chain, priced the way /stats prices a vault. Server only, so the link preview
 * can use it too.
 *
 * Privacy: the wallet is never logged and never leaves this process except in
 * the read to the chain. Results sit in this process's memory for a moment,
 * under a key salted fresh for each instance, so there is no list of looked-up
 * addresses here or in Redis, and an error is never printed with its message
 * (a viem error carries the request).
 */

/**
 * Robinhood Chain first: its read has to work. Base and Ethereum add to the
 * total when they answer, and Elysium (an Orbit chain with Multicall3, read the
 * same way) once it is a network (lib/elysium.ts). Tempo has no gas coin and
 * reads differently, so it is not here.
 */
const CHAINS: NetworkKey[] = [
  "robinhood-mainnet",
  "base-mainnet",
  "ethereum-mainnet",
  ...(NETWORK_KEYS.includes("elysium-mainnet") ? (["elysium-mainnet"] as const) : []),
];
const REQUIRED: NetworkKey = "robinhood-mainnet";

const ROBINHOOD_CHAIN_ID = 4663;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
/** The read has no retries to speak of: a person is waiting, and they can press retry. */
const READ_TIMEOUT_MS = 8_000;
/** How long a read is reused, and how many are held at most. */
const FRESH_MS = 60_000;
const MAX_HELD = 500;

export type XrayHolding = {
  /** TokenLogo id. */
  id: string;
  symbol: string;
  chainId: number;
  chain: string;
  /** Whole units, as read. */
  amount: string;
  /** Null: nothing prices it, so it is not in the total. */
  usd: number | null;
};

export type XrayBalances = {
  /** Sum of the priced holdings. */
  totalUsd: number;
  /** Largest first; a holding with no price comes after the priced ones. */
  holdings: XrayHolding[];
  /** False when the price feeds did not answer in time, so the total can not be trusted as one. */
  priced: boolean;
  /** USD per whole token on Robinhood Chain, by lowercase address: what history is valued at. */
  marks: Record<string, number>;
  /** Networks read. */
  chains: string[];
  /** Networks that did not answer, so they are not in the total. */
  missed: string[];
  /** Transactions this wallet has sent on Robinhood Chain. Null for a contract, whose count means something else. */
  sent: number | null;
  /** ms */
  readAt: number;
};

export class XrayReadFailed extends Error {
  constructor() {
    super("xray_read_failed");
    this.name = "XrayReadFailed";
  }
}

const clients = new Map<number, PublicClient>();

/**
 * Offchain lookups are off: an ENS name with an offchain resolver makes the
 * reader fetch a URL the name's owner picks, and this runs on the server.
 */
function clientFor(n: GloamNetwork): PublicClient {
  const hit = clients.get(n.chainId);
  if (hit) return hit;
  const c = createPublicClient({
    chain: n.chain,
    ccipRead: false,
    transport: serverTransport(n, { timeout: READ_TIMEOUT_MS, retryCount: 1, retryDelay: 400 }),
  });
  clients.set(n.chainId, c);
  return c;
}

/** Forgotten with the instance, so a key here can not be tested against a list of addresses from outside it. */
const SALT = randomBytes(16);

function saltedKey(text: string): string {
  return createHash("sha256").update(SALT).update(text.toLowerCase()).digest("base64url");
}

/** A short memory, oldest out first. */
function shortCache<T>(freshMs: number, maxHeld = MAX_HELD) {
  const held = new Map<string, { at: number; value: T }>();
  return {
    get(key: string): T | undefined {
      const hit = held.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.at < freshMs) return hit.value;
      held.delete(key);
      return undefined;
    },
    set(key: string, value: T) {
      held.delete(key);
      if (held.size >= maxHeld) held.delete(held.keys().next().value!);
      held.set(key, { at: Date.now(), value });
    },
  };
}

/* ---------------------------------------------------------------- pricing */

/** USD for `units` of a listed token. Null when nothing prices it (EURC, or a feed that is down). */
function tokenUsd(t: OnchainToken, units: number, prices: Prices | null): number | null {
  if (isDollarStable(t)) return units;
  if (!prices) return null;
  if (t.id === "weth") return prices.ethUsd != null ? units * prices.ethUsd : null;
  const mark = prices.marks.get(t.address.toLowerCase());
  return mark != null ? units * mark : null;
}

/* -------------------------------------------------------------------- ENS */

const ensCache = shortCache<Address | null>(5 * 60_000);

/** The address an ENS name points at, or null when it points at none. */
export async function resolveEnsName(name: string): Promise<Address | null> {
  const key = saltedKey(name);
  const known = ensCache.get(key);
  if (known !== undefined) return known;
  let address: Address | null;
  try {
    address = await clientFor(getNetwork("ethereum-mainnet")).getEnsAddress({ name: normalize(name) });
  } catch {
    throw new XrayReadFailed();
  }
  ensCache.set(key, address);
  return address;
}

/* ------------------------------------------------------------------- read */

type ChainRead = { n: GloamNetwork; tokens: OnchainToken[]; native: bigint; raw: bigint[]; sent: number | null };

const MULTICALL_ETH_ABI = parseAbi(["function getEthBalance(address) view returns (uint256)"]);

async function readChain(key: NetworkKey, wallet: Address): Promise<ChainRead> {
  const n = getNetwork(key);
  const c = clientFor(n);
  const tokens = holdableTokens(n.chainId);
  const calls: ContractFunctionParameters[] = [
    { address: MULTICALL3, abi: MULTICALL_ETH_ABI, functionName: "getEthBalance", args: [wallet] },
    ...tokens.map((t) => ({ address: t.address, abi: erc20BalanceOfAbi, functionName: "balanceOf", args: [wallet] })),
  ];
  // One eth_call for every balance on the chain, plain ETH included. All or nothing:
  // a chain with one balance missing would give a total that looks whole and is short.
  const [results, sent] = await Promise.all([
    c.multicall({ multicallAddress: MULTICALL3, allowFailure: false, contracts: calls }),
    key === REQUIRED ? sentCount(c, wallet) : Promise.resolve(null),
  ]);
  const [native, ...raw] = results as bigint[];
  return { n, tokens, native: native!, raw, sent };
}

/** The wallet's transaction count, or null for a contract (an EIP-7702 wallet is still a wallet). */
async function sentCount(c: PublicClient, wallet: Address): Promise<number | null> {
  const [code, count] = await Promise.all([c.getCode({ address: wallet }), c.getTransactionCount({ address: wallet })]);
  const contract = Boolean(code && code !== "0x" && !code.startsWith("0xef0100"));
  return contract ? null : count;
}

/** Pure: the receipt's balances from the chain reads. */
export function balancesFrom(reads: readonly ChainRead[], missed: readonly string[], prices: Prices | null, now = Date.now()): XrayBalances {
  const holdings: XrayHolding[] = [];
  for (const { n, tokens, native, raw } of reads) {
    const chain = { chainId: n.chainId, chain: n.label };
    if (native > 0n && n.primaryAsset.symbol === "ETH") {
      const units = Number(formatUnits(native, 18));
      holdings.push({ id: "eth", symbol: "ETH", ...chain, amount: formatUnits(native, 18), usd: prices?.ethUsd != null ? units * prices.ethUsd : null });
    } else if (native > 0n) {
      // Another gas coin (HYPE on Elysium): shown, not priced, so not in the total.
      const sym = n.primaryAsset.symbol;
      holdings.push({ id: sym.toLowerCase(), symbol: sym, ...chain, amount: formatUnits(native, n.primaryAsset.decimals), usd: null });
    }
    tokens.forEach((t, i) => {
      const v = raw[i];
      if (!v) return;
      const amount = formatUnits(v, t.decimals);
      holdings.push({ id: t.id, symbol: t.symbol, ...chain, amount, usd: tokenUsd(t, Number(amount), prices) });
    });
  }
  holdings.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  const marks: Record<string, number> = {};
  for (const t of holdableTokens(ROBINHOOD_CHAIN_ID)) {
    const usd = tokenUsd(t, 1, prices);
    if (usd != null) marks[t.address.toLowerCase()] = usd;
  }
  return {
    totalUsd: holdings.reduce((sum, h) => sum + (h.usd ?? 0), 0),
    holdings,
    priced: prices != null,
    marks,
    chains: reads.map((r) => r.n.label),
    missed: [...missed],
    sent: reads.find((r) => r.n.key === REQUIRED)?.sent ?? null,
    readAt: now,
  };
}

const balanceCache = shortCache<XrayBalances>(FRESH_MS);
const running = new Map<string, Promise<XrayBalances>>();

let pricesRunning: Promise<Prices | null> | null = null;

/**
 * Prices, waited for at most `ms`: past that, a card or a page has to say so
 * rather than show a smaller total. A cold read can take over twenty seconds,
 * so it is shared and left running: whoever asks next finds it done.
 */
async function pricesWithin(ms: number): Promise<Prices | null> {
  pricesRunning ??= loadPrices()
    .catch(() => null)
    .finally(() => {
      pricesRunning = null;
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms);
  });
  try {
    return await Promise.race([pricesRunning, wait]);
  } finally {
    clearTimeout(timer);
  }
}

async function read(wallet: Address, priceBudgetMs: number): Promise<XrayBalances> {
  const [settled, prices] = await Promise.all([
    Promise.allSettled(CHAINS.map((key) => readChain(key, wallet))),
    pricesWithin(priceBudgetMs),
  ]);
  const reads = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (!reads.some((r) => r.n.key === REQUIRED)) throw new XrayReadFailed();
  const missed = CHAINS.filter((_, i) => settled[i]!.status === "rejected").map((k) => getNetwork(k).label);
  return balancesFrom(reads, missed, prices);
}

/**
 * The wallet's balances: from memory for a minute, and one read at a time per
 * wallet. `priceBudgetMs` is how long the caller can wait on the price feeds;
 * a preview card has to answer in seconds, a person can wait a little longer.
 */
export async function readBalances(wallet: Address, priceBudgetMs = 8_000): Promise<XrayBalances> {
  const key = saltedKey(wallet);
  const hit = balanceCache.get(key);
  if (hit) return hit;
  const inFlight = running.get(key);
  if (inFlight) return inFlight;
  const p = read(wallet, priceBudgetMs)
    .then((b) => {
      // a read with no prices is not one to hand the next person
      if (b.priced) balanceCache.set(key, b);
      return b;
    })
    .finally(() => running.delete(key));
  running.set(key, p);
  return p;
}
