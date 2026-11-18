/**
 * Reads split by age, for a chain whose fresh public RPC keeps only recent history.
 *
 * Some public RPCs are at the chain head but keep only the last few thousand
 * blocks of logs, receipts and state (publicnode on Ethereum Sepolia: about
 * 10,000 blocks). The ones that keep everything can trail the head by a minute
 * or more (Tenderly's Sepolia gateway, measured 2026-10-25: a new receipt shows
 * up there 25 s after its block at the median and over 2 minutes at the 90th
 * percentile, against about 3 s on publicnode). A deposit waits on receipts and
 * fresh state, and rebuilding the pool tree reads logs back to its deploy
 * block, so neither RPC serves both.
 *
 * gloamReadTransport sends every request to the fresh RPC except reads about
 * blocks older than `recentBlocks` below the head:
 *  - eth_getLogs over old blocks goes to the history RPC; a range that crosses
 *    the line is split there, old part to history, recent part to fresh, and
 *    the logs are joined in block order;
 *  - state at an old block (eth_call, balances, code, storage) goes to history;
 *  - a receipt the fresh RPC no longer has (null for a transaction it shows
 *    mined before the line) is asked of the history RPC.
 * Head reads, receipts of new transactions, sends and filters never go to
 * history. A network whose RPC keeps everything has no history RPC and reads
 * through plain `http`, as before.
 *
 * splitReadTransport only routes: it calls the two transports it is given and
 * hands back their answers and their errors untouched. An app with its own copy
 * of viem builds those with its own `http` (the Gloam app and MCP do), so an
 * error stays an instance of its viem's classes (`instanceof HttpRequestError`
 * still holds); gloamReadTransport is the same split built with this package's
 * `http`, for apps that share the SDK's viem.
 */
import { http, toHex, type EIP1193RequestFn, type HttpTransportConfig, type Transport } from "viem";

/** Where reads about old blocks go when a network's default RPC keeps only recent history. */
export interface HistoryRpc {
  /** An RPC that keeps every block's logs, receipts and state. It may trail the head. */
  url: string;
  /**
   * How far below the head the default RPC is trusted for logs, receipts and
   * state, in blocks, with a margin under what it keeps. Reads about older
   * blocks go to `url`.
   */
  recentBlocks: bigint;
}

/** Where one request goes. `split` is an eth_getLogs range: blocks below `at` to history, the rest to fresh. */
export type ReadRoute = { to: "fresh" } | { to: "history" } | { to: "split"; at: bigint };

/** Which param holds the block tag, for the state reads that take one. */
const BLOCK_PARAM: Record<string, number> = {
  eth_call: 1,
  eth_estimateGas: 1,
  eth_createAccessList: 1,
  eth_simulateV1: 1,
  eth_getBalance: 1,
  eth_getCode: 1,
  eth_getTransactionCount: 1,
  eth_getStorageAt: 2,
  eth_getProof: 2,
  eth_getBlockReceipts: 0,
};

/**
 * The block a tag names, or null for the head side ("latest", "pending",
 * "safe", "finalized", nothing at all, or a block hash, which only the fresh
 * RPC is asked about). "earliest" is block 0.
 */
export function taggedBlock(tag: unknown): bigint | null {
  if (tag === "earliest") return 0n;
  if (typeof tag === "string" && /^0x[0-9a-fA-F]+$/.test(tag)) return BigInt(tag);
  if (typeof tag === "number" && Number.isSafeInteger(tag) && tag >= 0) return BigInt(tag);
  if (tag && typeof tag === "object" && "blockNumber" in tag) return taggedBlock((tag as { blockNumber: unknown }).blockNumber);
  return null;
}

/** Whether routing this request needs the head: it names a block number. */
export function namesBlock(method: string, params: readonly unknown[] | undefined): boolean {
  if (method === "eth_getLogs") {
    const f = params?.[0] as { fromBlock?: unknown; blockHash?: unknown } | undefined;
    return Boolean(f) && !f!.blockHash && taggedBlock(f!.fromBlock) !== null;
  }
  const i = BLOCK_PARAM[method];
  return i !== undefined && taggedBlock(params?.[i]) !== null;
}

/**
 * Where a request goes, given `line`: the oldest block the fresh RPC is
 * trusted for (head minus recentBlocks). Pure.
 */
export function readRoute(method: string, params: readonly unknown[] | undefined, line: bigint): ReadRoute {
  if (method === "eth_getLogs") {
    const f = params?.[0] as { fromBlock?: unknown; toBlock?: unknown; blockHash?: unknown } | undefined;
    if (!f || f.blockHash) return { to: "fresh" };
    const from = taggedBlock(f.fromBlock);
    if (from === null || from >= line) return { to: "fresh" };
    const to = taggedBlock(f.toBlock);
    if (to !== null && to < line) return { to: "history" };
    // to is at or past the line, or the head ("latest" or left out)
    return { to: "split", at: line };
  }
  const i = BLOCK_PARAM[method];
  if (i === undefined) return { to: "fresh" };
  const at = taggedBlock(params?.[i]);
  return at !== null && at < line ? { to: "history" } : { to: "fresh" };
}

/**
 * A viem transport from any copy of viem (an app's own viem is often not the
 * SDK's), as far as the split needs one.
 */
export type AnyTransport = (args: any) => {
  config: { timeout?: number | undefined; retryDelay?: number | undefined; methods?: unknown };
  request: (args: any, options?: any) => Promise<any>;
  value?: Record<string, unknown> | undefined;
};

export interface SplitReadOptions<T extends AnyTransport = Transport> {
  /** The RPC at the chain head: head reads, receipts, recent logs and state, sends. */
  fresh: T;
  /** The RPC that keeps the whole history, for reads about blocks older than `recentBlocks`; null reads everything through `fresh`. */
  history: T | null;
  recentBlocks: bigint;
  /** How long a head read from the fresh RPC places the line, ms. Default 60 s. */
  headTtlMs?: number;
}

type Rpc = { request: EIP1193RequestFn };
type RawTx = { blockNumber?: string | null } | null;

/**
 * The fresh/history split over two transports, typed as they are (the
 * caller's viem). With no history it is `fresh` itself.
 */
export function splitReadTransport<T extends AnyTransport = Transport>({ fresh, history, recentBlocks, headTtlMs = 60_000 }: SplitReadOptions<T>): T {
  if (!history) return fresh;
  const split = (args: Parameters<T>[0]) => {
    const f = fresh(args);
    const h = history(args);
    const fr = f as unknown as Rpc;
    const hr = h as unknown as Rpc;
    let head: { n: bigint; at: number } | null = null;
    let asking: Promise<bigint> | null = null;
    const saw = (n: bigint) => {
      if (!head || n >= head.n) head = { n, at: Date.now() };
    };
    // The line moves up with the head; a head up to headTtlMs old keeps it a
    // little low, which only sends a few more blocks to the fresh RPC.
    const line = async (): Promise<bigint> => {
      if (head && Date.now() - head.at < headTtlMs) return head.n - recentBlocks;
      asking ??= (fr.request({ method: "eth_blockNumber" }) as Promise<string>)
        .then((x) => {
          saw(BigInt(x));
          return BigInt(x);
        })
        .finally(() => {
          asking = null;
        });
      return (await asking) - recentBlocks;
    };

    const request = (async ({ method, params }: { method: string; params?: unknown }) => {
      const list = params as readonly unknown[] | undefined;
      if (method === "eth_getTransactionReceipt") {
        const receipt = await fr.request({ method, params: list as never });
        if (receipt !== null) return receipt;
        // Null is also what the fresh RPC says for a receipt older than it keeps:
        // ask history only for a transaction it shows mined before the line.
        const tx = (await fr.request({ method: "eth_getTransactionByHash", params: list as never }).catch(() => null)) as RawTx;
        const bn = taggedBlock(tx?.blockNumber);
        if (bn === null || bn >= (await line())) return receipt;
        return hr.request({ method, params: list as never });
      }
      if (!namesBlock(method, list)) {
        const out = await fr.request({ method, params: list as never });
        if (method === "eth_blockNumber" && typeof out === "string") saw(BigInt(out));
        return out;
      }
      const route = readRoute(method, list, await line());
      if (route.to === "fresh") return fr.request({ method, params: list as never });
      if (route.to === "history") return hr.request({ method, params: list as never });
      const filter = list![0] as Record<string, unknown>;
      const [old, recent] = await Promise.all([
        hr.request({ method, params: [{ ...filter, toBlock: toHex(route.at - 1n) }] as never }) as Promise<unknown[]>,
        fr.request({ method, params: [{ ...filter, fromBlock: toHex(route.at) }] as never }) as Promise<unknown[]>,
      ]);
      return [...old, ...recent];
    }) as EIP1193RequestFn;

    // Built by hand, not with createTransport: that would wrap the inner
    // transports' errors in this package's viem classes. Each inner transport
    // already retries, times out and maps errors. `methods` is the fresh RPC's
    // own: viem's fallback reads it to skip a transport for a method it
    // excludes (a relay's backup never handed a raw send), and the fresh RPC
    // is where every method that is not a read about old blocks goes.
    return {
      config: {
        key: "gloamRead",
        name: "Gloam read (fresh head, full history)",
        type: "gloamRead",
        request,
        methods: f.config.methods,
        retryCount: 0,
        retryDelay: f.config.retryDelay,
        timeout: f.config.timeout,
      },
      request,
      value: { ...(f.value ?? {}), history: h.value },
    };
  };
  return split as unknown as T;
}

/**
 * The read transport for a network: plain `http(rpcUrl)` where that RPC keeps
 * everything, else the fresh/history split. `config` applies to both RPCs.
 * A network with a `logCanary` (BNB Chain, whose public RPCs keep about a day
 * of logs and answer an empty list for older blocks) reads through
 * guardPrunedLogs, so a missing history fails loudly instead of reading as
 * "no events". Pass your own `rpcUrl` (one that keeps every log) to read old
 * blocks there.
 */
export function gloamReadTransport(
  net: { rpcUrl: string; historyRpc?: HistoryRpc | null; logCanary?: LogCanary | null },
  config: HttpTransportConfig = {}
): Transport {
  const fresh = http(net.rpcUrl, config);
  const read =
    !net.historyRpc || net.historyRpc.url === net.rpcUrl
      ? fresh
      : splitReadTransport({
          fresh,
          history: http(net.historyRpc.url, config),
          recentBlocks: net.historyRpc.recentBlocks,
        });
  return net.logCanary ? guardPrunedLogs(read, net.logCanary) : read;
}

// ── pruned logs: fail loudly instead of reading "no events" ─────────────────────

/**
 * A contract that logs in (nearly) every block of a chain, used to tell "no
 * events here" from "this RPC has no logs this old". On BNB Chain it is USDT,
 * with dozens of transfers a block (BNB_LOG_CANARY in src/bnb.ts).
 */
export interface LogCanary {
  /** The contract whose logs are looked for. */
  address: `0x${string}`;
  /** Blocks read from the start of a range; one log in them is enough. */
  blocks: bigint;
  /** The first block the canary is known to log at; a range that starts earlier is checked here. */
  sinceBlock: bigint;
  /** An empty answer whose range starts within this many blocks of the head is trusted without a check. */
  trustRecentBlocks: bigint;
  /** What to do about it, named in the error (which RPC to set). */
  hint: string;
}

/**
 * An eth_getLogs read came back for blocks the RPC keeps no logs for: the
 * canary contract, which logs in every block, has none at the range's first
 * block. Some public RPCs (publicnode on BNB Chain) answer an empty list for
 * older ranges instead of an error, and only the newer part of a range that
 * straddles the oldest block they keep, which would read as "nothing happened"
 * and silently drop deposits, payments and notes. Nothing partial is returned.
 */
export class PrunedLogsError extends Error {
  readonly fromBlock: bigint;
  readonly toBlock: bigint | null;
  constructor(fromBlock: bigint, toBlock: bigint | null, hint: string) {
    super(
      `The RPC has no logs at block ${fromBlock}${toBlock !== null ? ` to ${toBlock}` : ""} (it answered an empty list where every block has logs), so this read cannot be trusted. ${hint}`
    );
    this.name = "PrunedLogsError";
    this.fromBlock = fromBlock;
    this.toBlock = toBlock;
  }
}

export interface GuardPrunedLogsOptions<T extends AnyTransport = Transport> {
  /**
   * Asked when the guarded RPC turns out to have no logs that old: an RPC that
   * keeps them (in the Gloam app, gloam.trade's own proxy, which reads through
   * the server's keyed RPC). Its empty answers are checked the same way.
   */
  archive?: T | null;
  /** How long a head read places the trust line, ms. Default 60 s. */
  headTtlMs?: number;
  /**
   * How long a block the canary showed an RPC still has logs at is trusted for
   * that RPC, ms: a later read starting at or after it asks no canary. Default
   * 10 minutes. An RPC drops its oldest logs first, so newer blocks are covered.
   */
  floorTtlMs?: number;
  /**
   * Ask `archive` when the guarded RPC fails a log read outright (down, or a
   * refusal), as the browser asked its proxy before. The archive's answer is
   * checked against its own canary. If the archive fails too, the guarded
   * RPC's error is thrown (a range error a walk splits on, say). Default false.
   */
  archiveOnError?: boolean;
}

/**
 * Wraps a transport so an eth_getLogs answer about old blocks is only passed
 * on once the same RPC shows it has logs from the range's first block on: it
 * is asked for the canary's logs there, and if those are missing the read
 * goes to `archive` (when given) or throws PrunedLogsError. This covers an
 * empty answer and a partial one alike: a range that straddles the oldest
 * block an RPC keeps comes back with only its newer part (publicnode on BNB
 * Chain, checked 18 November 2026). Recent ranges, reads by block hash and
 * every other method pass through untouched. Each RPC's proven block is kept
 * for `floorTtlMs`, so a walk from the deploy block costs one canary read.
 *
 * Wrap one RPC (or a list whose log reads go to one RPC), never a fallback
 * across RPCs that keep different history: the canary must be answered by the
 * RPC that answered the read.
 */
export function guardPrunedLogs<T extends AnyTransport = Transport>(inner: T, canary: LogCanary, opts: GuardPrunedLogsOptions<T> = {}): T {
  const headTtlMs = opts.headTtlMs ?? 60_000;
  const floorTtlMs = opts.floorTtlMs ?? 600_000;
  const guarded = (args: Parameters<T>[0]) => {
    const t = inner(args);
    const ir = t as unknown as Rpc;
    const ar = opts.archive ? (opts.archive(args) as unknown as Rpc) : null;
    let head: { n: bigint; at: number } | null = null;
    const headNow = async (rpc: Rpc): Promise<bigint> => {
      if (head && Date.now() - head.at < headTtlMs) return head.n;
      const n = BigInt((await rpc.request({ method: "eth_blockNumber" })) as string);
      head = { n, at: Date.now() };
      return n;
    };
    // per RPC: the oldest block the canary showed it has logs at, and when
    const floors = new Map<Rpc, { block: bigint; at: number }>();
    const keepsFrom = async (rpc: Rpc, from: bigint): Promise<boolean> => {
      const at = from < canary.sinceBlock ? canary.sinceBlock : from;
      const floor = floors.get(rpc);
      if (floor && Date.now() - floor.at < floorTtlMs && at >= floor.block) return true;
      const logs = (await rpc.request({
        method: "eth_getLogs",
        params: [{ address: canary.address, fromBlock: toHex(at), toBlock: toHex(at + canary.blocks - 1n) }] as never,
      })) as unknown[];
      const has = Array.isArray(logs) && logs.length > 0;
      if (has) floors.set(rpc, { block: at, at: Date.now() });
      return has;
    };
    /** The range's first block when the answer needs the canary's word, else null. */
    const oldFrom = async (rpc: Rpc, list: readonly unknown[] | undefined): Promise<bigint | null> => {
      const f = list?.[0] as { fromBlock?: unknown; toBlock?: unknown; blockHash?: unknown } | undefined;
      if (!f || f.blockHash) return null;
      const from = taggedBlock(f.fromBlock);
      if (from === null) return null; // "latest" and friends: the head
      const to = taggedBlock(f.toBlock);
      // a range that ends before the canary logs at all says nothing either way
      if (to !== null && to < canary.sinceBlock) return null;
      if (from + canary.trustRecentBlocks >= (await headNow(rpc))) return null;
      return from;
    };
    const toOf = (list: readonly unknown[] | undefined) => taggedBlock((list?.[0] as { toBlock?: unknown } | undefined)?.toBlock);
    const fromArchive = async (rpc: Rpc, method: string, list: readonly unknown[] | undefined, from: bigint | null) => {
      const again = await rpc.request({ method, params: list as never });
      if (!Array.isArray(again)) return again;
      const at = from ?? (await oldFrom(rpc, list));
      if (at === null || (await keepsFrom(rpc, at))) return again;
      throw new PrunedLogsError(at, toOf(list), canary.hint);
    };
    const request = (async ({ method, params }: { method: string; params?: unknown }) => {
      const list = params as readonly unknown[] | undefined;
      if (method !== "eth_getLogs") return ir.request({ method, params: list as never });
      let out: unknown;
      try {
        out = await ir.request({ method, params: list as never });
      } catch (e) {
        if (!ar || !opts.archiveOnError) throw e;
        try {
          return await fromArchive(ar, method, list, null);
        } catch {
          throw e;
        }
      }
      if (!Array.isArray(out)) return out;
      const from = await oldFrom(ir, list);
      if (from === null || (await keepsFrom(ir, from))) return out;
      if (ar) return fromArchive(ar, method, list, from);
      throw new PrunedLogsError(from, toOf(list), canary.hint);
    }) as EIP1193RequestFn;
    return {
      config: { ...t.config, key: "gloamPrunedGuard", name: "Gloam read (pruned logs refused)", type: "gloamPrunedGuard", request, retryCount: 0 },
      request,
      value: t.value,
    };
  };
  return guarded as unknown as T;
}
