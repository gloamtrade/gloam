/**
 * The public ledger behind /transparency: everything anyone can read about a
 * Gloam vault straight from the chain, with no keys and no Gloam server.
 *
 * - Holdings: balanceOf(vault) for every token the vault can hold (the listed
 *   ones plus those a private swap lands in, lib/vaultAssets), plus the native
 *   balance where the chain has one, and each stock token's uiMultiplier so it
 *   is priced as the app prices it.
 * - Counts: Shielded / Transferred / Unshielded (and SealedSwapped) logs from
 *   the vault, PaymentMemo logs from the payment-message board, all since the
 *   vault's deploy block.
 * - Recent activity: the newest of those logs. Deposits and cash-outs carry a
 *   public token and amount by design; transfers and trades carry neither.
 *
 * Logs are read in bounded chunks (the network's own getLogs limit, halved on
 * a range error), a few at a time, from public RPCs. Results are cached in
 * memory and sessionStorage, and a refresh only reads the blocks since.
 */

import {
  createPublicClient,
  parseAbi,
  parseAbiItem,
  toEventSelector,
  type Address,
  type PublicClient,
} from "viem";
import { getNetwork, type GloamNetwork, type NetworkKey } from "@/lib/networks";
import { erc20BalanceOfAbi, isDollarStable, shieldTokensFor, supportsNativeShield, type OnchainToken } from "@/lib/tokens";
import { hasUiMultiplier, holdableTokens } from "@/lib/vaultAssets";
import { getLogsSafe } from "@/lib/logRange";
import { readTransport } from "@/lib/readTransport";

export type ActivityKind = "deposit" | "transfer" | "cashout" | "trade";

export type PublicEvent = {
  kind: ActivityKind;
  block: string;
  logIndex: number;
  tx: string;
  /** Deposits and cash-outs only: public by design. */
  asset?: Address;
  amount?: string;
  /** Unix seconds; 0 while unknown. */
  ts: number;
};

export type VaultHolding = {
  id: string;
  symbol: string;
  /** null = the chain's native coin */
  address: Address | null;
  decimals: number;
  stable: boolean;
  /** Raw units held by the vault. */
  raw: string;
  /** Absent on ledgers cached before swap-landed tokens were read. */
  kind?: OnchainToken["kind"];
  /** CoinGecko id, for a price where the markets feed has none. */
  coingecko?: string;
  /** Add lists it. False for a token only a private swap lands in (shown only while held). */
  listed?: boolean;
  /** A stock token's uiMultiplier (raw, 1e18 = 1), read with the balance; null when that read failed. */
  uiMultiplier?: string | null;
};

export type Ledger = {
  network: NetworkKey;
  pool: Address;
  memo: Address | null;
  fromBlock: string;
  scannedTo: string;
  /** Unix seconds of the vault's deploy block (0 if unknown). */
  startTs: number;
  counts: {
    deposits: number;
    transfers: number;
    cashouts: number;
    trades: number;
    memos: number;
  };
  /** Newest first. */
  recent: PublicEvent[];
  holdings: VaultHolding[];
  /** ms since epoch */
  checkedAt: number;
  /** How long the last read took, in ms. */
  tookMs: number;
  /** Blocks read by the last pass. */
  blocksRead: string;
  /**
   * Set when a pass could not read everything: the vault's logs from
   * `logsFrom` on (null: all read), and whether the balances are the last
   * ones read rather than fresh. The next pass resumes from there.
   */
  incomplete?: { logsFrom: string | null; holdings: boolean };
};

const RECENT_KEEP = 12;
/** Requests in flight per chain. Tempo's public RPC answers 429 to bursts. */
const PARALLEL: Record<number, number> = { 46630: 4, 42431: 3, 84532: 3, 11155111: 3, 4663: 2, 4217: 3, 8453: 3, 1: 3 };
/**
 * First span to ask for per getLogs. Robinhood's public RPC takes millions of
 * blocks in one call (the vault's whole history today); Tempo caps at 100k.
 * A range error splits the span in half either way.
 */
const SPAN: Record<number, bigint> = { 46630: 4_000_000n, 4663: 4_000_000n };
/** The first getLogs span for a network: SPAN where set, else its own limit. */
export function logSpan(n: GloamNetwork): bigint {
  return SPAN[n.chainId] ?? n.logRange;
}
/**
 * Span per getLogs on the transparency read. Smaller than logSpan: Robinhood
 * Chain makes about 370,000 blocks a day, and one query over the whole history
 * grew slow enough to time out on a phone, failing the page at "50%".
 */
const LEDGER_SPAN: Record<number, bigint> = { 46630: 1_000_000n, 4663: 500_000n };
/**
 * Blocks left unread at the head. A balanced RPC can answer getLogs from a
 * node a block behind the one that gave the head, and returns nothing for
 * blocks it doesn't have yet; reading to the very head would mark them read.
 */
const HEAD_LAG: Record<number, bigint> = {
  46630: 20n,
  4663: 20n,
  84532: 20n,
  8453: 20n,
  1: 2n,
  11155111: 4n,
  // Elysium mainnet and testnet: blocks every ~100 ms, so 20 blocks is about 2 s.
  99901: 20n,
  99801: 20n,
};
const FRESH_MS = 30_000;
const CACHE_PREFIX = "gloam_transparency_v1";

const POOL_EVENTS = [
  parseAbiItem(
    "event Shielded(bytes32 indexed commitment, address indexed asset, uint256 amount, uint256 leafIndex, address indexed from)"
  ),
  parseAbiItem("event Transferred(bytes32 indexed nullifier, bytes32[2] newCommitments)"),
  parseAbiItem(
    "event Unshielded(bytes32 indexed nullifier, address indexed asset, address indexed to, uint256 amount)"
  ),
  parseAbiItem(
    "event SealedSwapped(bytes32 indexed nullifier, address indexed assetIn, address indexed assetOut, bytes32 newCommitmentOut, bytes32 newCommitmentChange)"
  ),
] as const;

/** Both board versions: the first also indexed the poster. */
const MEMO_TOPICS = new Set([
  toEventSelector("PaymentMemo(bytes32,address,bytes)"),
  toEventSelector("PaymentMemo(bytes32,bytes)"),
]);

// ------------------------------------------------------------------ clients

const clients = new Map<number, PublicClient>();

export function clientFor(n: GloamNetwork): PublicClient {
  const hit = clients.get(n.chainId);
  if (hit) return hit;
  const c = createPublicClient({
    chain: n.chain,
    // The chain's public RPCs in order (lib/rpcList), and old logs from the
    // network's history RPC where they keep only recent ones (lib/readTransport);
    // 429s, 5xx and timeouts are retried with exponential backoff (0.5s, 1s, 2s, 4s).
    transport: readTransport(n, { timeout: 20_000, retryCount: 4, retryDelay: 500 }),
  });
  clients.set(n.chainId, c);
  return c;
}

const gates = new Map<number, { active: number; waiting: (() => void)[] }>();

/** Every RPC call for a chain goes through here, so at most PARALLEL run at once. */
export async function gated<T>(chainId: number, call: () => Promise<T>): Promise<T> {
  let g = gates.get(chainId);
  if (!g) {
    g = { active: 0, waiting: [] };
    gates.set(chainId, g);
  }
  const max = PARALLEL[chainId] ?? 3;
  while (g.active >= max) await new Promise<void>((r) => g.waiting.push(r));
  g.active++;
  try {
    return await call();
  } finally {
    g.active--;
    g.waiting.shift()?.();
  }
}

/** Runs tasks in index order; the chain gate decides how many are in flight. */
async function runAll<T>(count: number, run: (i: number) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: count }, (_, i) => run(i)));
}

// The shared reader (retries, halves a span the node refuses as too wide or
// too big). Re-exported for lib/walletActivity, which reads through this module.
export { getLogsSafe };

export function ranges(from: bigint, to: bigint, step: bigint): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let s = from; s <= to; s += step) {
    out.push([s, s + step - 1n > to ? to : s + step - 1n]);
  }
  return out;
}

function hexTs(v: unknown): number {
  try {
    if (typeof v === "string" || typeof v === "bigint") return Number(BigInt(v));
  } catch {
    /* ignore */
  }
  return 0;
}

// ------------------------------------------------------------------ cache

const memory = new Map<NetworkKey, Ledger>();

function cacheKey(n: GloamNetwork) {
  return `${CACHE_PREFIX}:${n.key}:${(n.pool ?? "").toLowerCase()}`;
}

/** The last ledger read in this tab, if any (memory first, then sessionStorage). */
export function cachedLedger(key: NetworkKey): Ledger | null {
  const n = getNetwork(key);
  const m = memory.get(key);
  if (m && m.pool.toLowerCase() === n.pool?.toLowerCase()) return m;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(cacheKey(n));
    if (!raw) return null;
    const l = JSON.parse(raw) as Ledger;
    if (l?.network !== key || !Array.isArray(l.recent) || !l.counts) return null;
    memory.set(key, l);
    return l;
  } catch {
    return null;
  }
}

function saveLedger(n: GloamNetwork, l: Ledger) {
  memory.set(n.key, l);
  try {
    window.sessionStorage.setItem(cacheKey(n), JSON.stringify(l));
  } catch {
    /* storage full or blocked: memory still has it */
  }
}

// ------------------------------------------------------------------ read

type Progress = (fraction: number) => void;

const inflight = new Map<NetworkKey, { promise: Promise<Ledger>; listeners: Set<Progress> }>();

/**
 * Reads (or refreshes) the public ledger for one network. Concurrent callers
 * share one read. A ledger read in the last 30s is returned as is unless
 * `force` is set.
 */
export function loadLedger(
  key: NetworkKey,
  opts: { onProgress?: Progress; force?: boolean } = {}
): Promise<Ledger> {
  const running = inflight.get(key);
  if (running) {
    if (opts.onProgress) running.listeners.add(opts.onProgress);
    return running.promise;
  }
  const prev = cachedLedger(key);
  if (prev && !prev.incomplete && !opts.force && Date.now() - prev.checkedAt < FRESH_MS) {
    return Promise.resolve(prev);
  }
  const listeners = new Set<Progress>(opts.onProgress ? [opts.onProgress] : []);
  const promise = readLedger(key, prev, (f) => listeners.forEach((l) => l(f))).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, { promise, listeners });
  return promise;
}

async function readLedger(key: NetworkKey, prev: Ledger | null, progress: Progress): Promise<Ledger> {
  const n = getNetwork(key);
  if (!n.pool || n.deployBlock == null) throw new Error(`${n.label} has no vault yet.`);
  const vault = n.pool;
  const started = performance.now();
  const c = clientFor(n);

  const id = n.chainId;
  const head = await gated(id, () => c.getBlockNumber());
  const lag = HEAD_LAG[id] ?? 2n;
  const fromBlock = n.deployBlock;
  const resume = prev && BigInt(prev.scannedTo) >= fromBlock ? BigInt(prev.scannedTo) + 1n : fromBlock;
  // A lagging node behind the balancer can answer an older head. The scan never
  // ends below where the last pass stopped, or those blocks would be read (and
  // counted) twice.
  const tip = head > lag ? head - lag : head;
  const latest = tip > resume - 1n ? tip : resume - 1n;
  const memo = n.payMemo;
  const memoFrom = memo ? (memo.deployBlock > fromBlock ? memo.deployBlock : fromBlock) : 0n;
  const memoResume = resume > memoFrom ? resume : memoFrom;

  const span = LEDGER_SPAN[id] ?? logSpan(n);
  const poolRanges = resume <= latest ? ranges(resume, latest, span) : [];
  const memoRanges = memo && memoResume <= latest ? ranges(memoResume, latest, span) : [];
  const total = poolRanges.length + memoRanges.length + 1; // +1: balances
  let done = 0;
  const tick = () => progress(Math.min(1, ++done / total));
  progress(0);

  // A range or the balances failing no longer fails the page: each part is
  // kept or marked missing, and what was read is shown while the rest is
  // read again.
  const kept = <T,>(p: Promise<T>): Promise<T | null> => p.then((v) => v, () => null);
  const [poolParts, memoParts, freshHoldings, startTs] = await Promise.all([
    runAll(poolRanges.length, async (i) => {
      const [a, b] = poolRanges[i];
      const logs = await kept(
        getLogsSafe(
          (from, to) =>
            gated(id, () => c.getLogs({ address: vault, events: POOL_EVENTS, fromBlock: from, toBlock: to })),
          a,
          b
        )
      );
      tick();
      return logs;
    }),
    memo
      ? runAll(memoRanges.length, async (i) => {
          const [a, b] = memoRanges[i];
          const logs = await kept(
            getLogsSafe((from, to) => gated(id, () => c.getLogs({ address: memo.address, fromBlock: from, toBlock: to })), a, b)
          );
          tick();
          return logs;
        })
      : Promise.resolve([]),
    kept(readHoldings(n, c, vault)).then((h) => {
      tick();
      return h;
    }),
    prev?.startTs
      ? Promise.resolve(prev.startTs)
      : gated(id, () => c.getBlock({ blockNumber: fromBlock }))
          .then((b) => Number(b.timestamp))
          .catch(() => 0),
  ]);

  // Only an unbroken run of ranges from where the last pass stopped counts.
  // A range that failed, and everything after it, is read again next pass, so
  // nothing is counted twice or skipped.
  const readThrough = (parts: (unknown[] | null)[], rs: [bigint, bigint][], start: bigint) => {
    let end = start - 1n;
    for (let i = 0; i < rs.length; i++) {
      if (parts[i] === null) break;
      end = rs[i]![1];
    }
    return end;
  };
  const poolEnd = readThrough(poolParts, poolRanges, resume);
  const memoEnd = memo ? (memoRanges.length ? readThrough(memoParts, memoRanges, memoResume) : latest) : latest;
  const scannedTo = poolEnd < memoEnd ? poolEnd : memoEnd;
  const upTo = <L extends { blockNumber: bigint | null }>(parts: (L[] | null)[]) =>
    parts.flatMap((p) => p ?? []).filter((l) => (l.blockNumber ?? 0n) <= scannedTo);
  const poolLogs = upTo(poolParts);
  if (!prev && poolRanges.length > 0 && poolEnd < poolRanges[0]![0] && freshHoldings === null) {
    // Nothing at all came back: there is nothing to show yet.
    throw new Error(`Could not read ${n.label}.`);
  }

  const counts = prev
    ? { ...prev.counts }
    : { deposits: 0, transfers: 0, cashouts: 0, trades: 0, memos: 0 };
  counts.memos += upTo(memoParts).filter((l) => l.topics[0] && MEMO_TOPICS.has(l.topics[0])).length;
  const holdings = freshHoldings ?? prev?.holdings ?? [];
  const logsFrom = scannedTo < latest ? String(scannedTo + 1n) : null;

  const fresh: PublicEvent[] = [];
  for (const log of poolLogs) {
    const base = {
      block: String(log.blockNumber ?? 0n),
      logIndex: log.logIndex ?? 0,
      tx: log.transactionHash ?? "",
      ts: hexTs((log as { blockTimestamp?: unknown }).blockTimestamp),
    };
    switch (log.eventName) {
      case "Shielded":
        counts.deposits++;
        fresh.push({ ...base, kind: "deposit", asset: log.args.asset, amount: String(log.args.amount ?? 0n) });
        break;
      case "Unshielded":
        counts.cashouts++;
        fresh.push({ ...base, kind: "cashout", asset: log.args.asset, amount: String(log.args.amount ?? 0n) });
        break;
      case "Transferred":
        counts.transfers++;
        fresh.push({ ...base, kind: "transfer" });
        break;
      case "SealedSwapped":
        counts.trades++;
        fresh.push({ ...base, kind: "trade" });
        break;
    }
  }

  const recent = [...fresh, ...(prev?.recent ?? [])]
    .sort((a, b) => {
      const d = BigInt(b.block) - BigInt(a.block);
      return d !== 0n ? (d > 0n ? 1 : -1) : b.logIndex - a.logIndex;
    })
    .slice(0, RECENT_KEEP);

  // Times for the rows shown. Tempo puts them on the log; Robinhood needs the block.
  const missing = [...new Set(recent.filter((e) => !e.ts).map((e) => e.block))];
  const times = new Map<string, number>();
  await runAll(missing.length, async (i) => {
    try {
      const b = await gated(id, () => c.getBlock({ blockNumber: BigInt(missing[i]) }));
      times.set(missing[i], Number(b.timestamp));
    } catch {
      /* shown as a block number instead */
    }
  });
  const timed = recent.map((e) => (e.ts ? e : { ...e, ts: times.get(e.block) ?? 0 }));

  const ledger: Ledger = {
    network: key,
    pool: vault,
    memo: memo?.address ?? null,
    fromBlock: String(fromBlock),
    scannedTo: String(scannedTo >= fromBlock ? scannedTo : fromBlock - 1n),
    startTs,
    counts,
    recent: timed,
    holdings,
    checkedAt: Date.now(),
    tookMs: Math.round(performance.now() - started),
    blocksRead: String(scannedTo >= resume ? scannedTo - resume + 1n : 0n),
    ...(logsFrom || freshHoldings === null ? { incomplete: { logsFrom, holdings: freshHoldings === null } } : {}),
  };
  saveLedger(n, ledger);
  progress(1);
  return ledger;
}

const UI_MULTIPLIER_ABI = parseAbi(["function uiMultiplier() view returns (uint256)"]);

/**
 * Each token's balance, and each stock's uiMultiplier. One Multicall3 call where
 * the chain has it (Robinhood Chain mainnet reads about 50 values), else one
 * call per value. A stock whose multiplier fails is left unpriced, never wrong;
 * a failed balance fails the read, as before, so the last balances read are kept.
 */
async function readHoldings(n: GloamNetwork, c: PublicClient, vault: Address): Promise<VaultHolding[]> {
  const listed = new Set(shieldTokensFor(n.chainId).map((t) => t.address.toLowerCase()));
  const tokens = holdableTokens(n.chainId);
  const stocks = tokens.filter((t) => hasUiMultiplier(n.chainId, t));
  const balanceCall = (t: OnchainToken) =>
    ({ address: t.address, abi: erc20BalanceOfAbi, functionName: "balanceOf", args: [vault] }) as const;
  const multCall = (t: OnchainToken) => ({ address: t.address, abi: UI_MULTIPLIER_ABI, functionName: "uiMultiplier" }) as const;

  let balances: bigint[];
  let mults: (bigint | null)[];
  const batched = n.chain.contracts?.multicall3
    ? await gated(n.chainId, () =>
        c.multicall({ contracts: [...tokens.map(balanceCall), ...stocks.map(multCall)], allowFailure: true })
      ).catch(() => null)
    : null;
  if (batched && batched.slice(0, tokens.length).every((r) => r.status === "success")) {
    balances = batched.slice(0, tokens.length).map((r) => r.result as bigint);
    mults = batched.slice(tokens.length).map((r) => (r.status === "success" ? (r.result as bigint) : null));
  } else {
    [balances, mults] = await Promise.all([
      Promise.all(tokens.map((t) => gated(n.chainId, () => c.readContract(balanceCall(t))))),
      Promise.all(stocks.map((t) => gated(n.chainId, () => c.readContract(multCall(t))).catch(() => null))),
    ]);
  }
  const multOf = new Map(stocks.map((t, i) => [t.address.toLowerCase(), mults[i] ?? null]));

  const rows: VaultHolding[] = tokens.map((t, i) => {
    const a = t.address.toLowerCase();
    const stock = multOf.has(a);
    const mult = multOf.get(a);
    return {
      id: t.id,
      symbol: t.symbol,
      address: t.address,
      decimals: t.decimals,
      stable: isDollarStable(t),
      raw: String(balances[i]),
      kind: t.kind,
      ...(t.coingecko ? { coingecko: t.coingecko } : {}),
      listed: listed.has(a),
      ...(stock ? { uiMultiplier: mult == null ? null : String(mult) } : {}),
    };
  });
  if (supportsNativeShield(n.chainId)) {
    const v = await gated(n.chainId, () => c.getBalance({ address: vault }));
    rows.push({
      id: "native",
      symbol: n.primaryAsset.symbol,
      address: null,
      decimals: n.primaryAsset.decimals,
      stable: false,
      raw: String(v),
      listed: true,
    });
  }
  return rows;
}
