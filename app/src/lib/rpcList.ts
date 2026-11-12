/**
 * A chain's public RPCs, in order, as one transport that keeps working while
 * one of them is down or slow. Every read the app and the server make goes
 * through it (lib/rhClient, lib/wagmi, lib/serverRpc).
 *
 * Each request goes to the first RPC in the list that is not resting, and on
 * down the list if that one fails. One that fails as a node (a timeout, a
 * dropped connection, an HTTP error, a rate limit) rests for REST_MS: it is
 * not asked again until then, so a node that is down costs one failed request
 * per REST_MS, not one per request. When every RPC is resting they are all
 * asked again, in order, so the list never refuses a request by itself. An
 * RPC that answers with a JSON-RPC error is not resting (the answer is about
 * the request, a range it does not serve, say) and the next one is asked; if
 * none serves it, the first such answer is the error passed on. A revert is
 * final, as with viem's fallback. Each RPC is asked once per pass
 * (a hung node costs one timeout, not one per retry); `config.retryCount`
 * more passes are made only while every failure was a node failure.
 *
 * A URL in NO_LOG_RPCS (lib/networks) is never asked for eth_getLogs: those
 * public RPCs refuse or cap log reads (a log walk that fell back to one would
 * split itself into hundreds of tiny reads), or trail the head (the newest
 * logs would be missing). A URL in NO_SEND_RPCS (one trailing the head) never
 * takes a send, even while every other RPC in the list is resting.
 *
 * Sends: with `sendTo: "one"` a signed transaction goes to exactly one RPC,
 * the first that is not resting, and never on to another. A copy of a send
 * the first node may have taken could only revert or come back as a nonce
 * clash that hides it (lib/relay/server reads that failure as maybe_sent).
 *
 * `proxy` (browser only): gloam.trade's own RPC proxy for the chain
 * (lib/rpcProxy), asked after every public RPC and only for the read methods
 * it serves. It never takes a send. It rests like any other RPC.
 */
import {
  BaseError,
  ExecutionRevertedError,
  HttpRequestError,
  LimitExceededRpcError,
  TimeoutError,
  http,
  type EIP1193RequestFn,
  type HttpTransportConfig,
  type Transport,
} from "viem";
import { NO_LOG_RPCS, NO_SEND_RPCS } from "./networks";
import { RPC_PROXY_MAX_BATCH, RPC_PROXY_METHODS } from "./rpcProxy";

/** How long an RPC that failed as a node is passed over. */
export const REST_MS = 30_000;

/** The calls that put a signed transaction out. */
export const SEND_METHODS = ["eth_sendRawTransaction", "eth_sendRawTransactionSync"];

/** Per URL: until when it is passed over. Shared by every list that names the URL. */
const restUntil = new Map<string, number>();

/** Test hook: every RPC healthy again, as on a fresh page or instance. */
export function resetRpcRest(): void {
  restUntil.clear();
}

export function isResting(url: string, now = Date.now()): boolean {
  return (restUntil.get(url) ?? 0) > now;
}

/** Pass `url` over for REST_MS. */
export function restRpc(url: string): void {
  restUntil.set(url, Date.now() + REST_MS);
}

function codeOf(e: unknown): number | null {
  const c = (e as { code?: unknown })?.code;
  return typeof c === "number" ? c : null;
}

/**
 * The node failed, not the request: it timed out, the connection dropped, it
 * answered an HTTP error, or it says it is rate limited. A JSON-RPC answer
 * about the request itself (bad params, a range it does not serve) is not one.
 */
export function nodeFailed(err: unknown): boolean {
  const hit = (e: unknown) =>
    e instanceof TimeoutError ||
    e instanceof HttpRequestError ||
    e instanceof LimitExceededRpcError ||
    [429, -32005, -32007].includes(codeOf(e) ?? 0);
  if (hit(err)) return true;
  return err instanceof BaseError && err.walk(hit) !== null;
}

/** An answer every node would give: a revert, or the user said no. Never asked of the next RPC. */
function final(err: unknown): boolean {
  const hit = (e: unknown) =>
    e instanceof ExecutionRevertedError ||
    [4001, -32003, 5000].includes(codeOf(e) ?? 0) ||
    (e instanceof Error && ExecutionRevertedError.nodeMessage.test(e.message));
  if (hit(err)) return true;
  return err instanceof BaseError && err.walk(hit) !== null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RpcListOptions = {
  /** "one": a send goes to exactly one RPC (the first not resting), never on to another. */
  sendTo?: "one";
  /** gloam.trade's RPC proxy for this chain (lib/rpcProxy), asked last. Null or absent: none. */
  proxy?: string | null;
};

/**
 * The RPCs a request may go to, in the order they are asked. `proxy`, when
 * it is in the list, is asked only for the read methods it serves.
 */
export function rpcOrder(list: readonly string[], method: string, now = Date.now(), proxy: string | null = null): number[] {
  const serves = (i: number) => list[i] !== proxy || RPC_PROXY_METHODS.has(method);
  const all = list.map((_, i) => i).filter(serves);
  const barred = method === "eth_getLogs" ? NO_LOG_RPCS : SEND_METHODS.includes(method) ? NO_SEND_RPCS : null;
  const able = barred ? all.filter((i) => !barred.has(list[i]!)) : all;
  const pool = able.length ? able : all;
  const awake = pool.filter((i) => !isResting(list[i]!, now));
  return awake.length ? awake : pool;
}

/** The proxy's http config: a batch never bigger than the proxy takes. */
function proxyConfig(config: HttpTransportConfig): HttpTransportConfig {
  const batch = config.batch;
  if (!batch) return config;
  const own = typeof batch === "object" ? batch : {};
  return { ...config, batch: { ...own, batchSize: Math.min(own.batchSize ?? RPC_PROXY_MAX_BATCH, RPC_PROXY_MAX_BATCH) } };
}

/**
 * `urls` as one transport, in order, with resting as above. One URL and no
 * `sendTo` is plain `http`, as before. `config` is each RPC's http config
 * (timeout, batch); its `retryCount` and `retryDelay` apply to the list.
 */
export function rpcListTransport(urls: readonly string[], config: HttpTransportConfig = {}, opts: RpcListOptions = {}): Transport {
  const publicList = [...new Set(urls.filter(Boolean))];
  if (publicList.length === 0) throw new Error("rpcListTransport needs at least one RPC");
  const proxy = opts.proxy && !publicList.includes(opts.proxy) ? opts.proxy : null;
  const list = proxy ? [...publicList, proxy] : publicList;
  if (list.length === 1 && !opts.sendTo) return http(list[0], config);
  const { retryCount, retryDelay = 150, ...each } = config;
  const passes = 1 + (retryCount ?? 0);
  const inners = list.map((u) => http(u, { ...(u === proxy ? proxyConfig(each) : each), retryCount: 0 }));
  return (params) => {
    const ts = inners.map((t) => t({ ...params, retryCount: 0 }));
    const ask = async (i: number, args: Parameters<EIP1193RequestFn>[0], options?: Parameters<EIP1193RequestFn>[1]) => {
      try {
        return await ts[i]!.request(args, options);
      } catch (e) {
        if (nodeFailed(e)) restRpc(list[i]!);
        throw e;
      }
    };
    const request: EIP1193RequestFn = async (args, options) => {
      if (opts.sendTo === "one" && SEND_METHODS.includes(args.method)) {
        // exactly one RPC, once: its answer or its error is final
        return ask(rpcOrder(list, args.method, Date.now(), proxy)[0]!, args, options) as never;
      }
      let last: unknown;
      // the first answer about the request is the one passed on (a range error a
      // log walk splits on, say), not a later RPC's different refusal
      let answer: unknown = null;
      for (let pass = 0; pass < passes; pass++) {
        if (pass > 0) await sleep(retryDelay * 2 ** (pass - 1));
        for (const i of rpcOrder(list, args.method, Date.now(), proxy)) {
          try {
            return (await ask(i, args, options)) as never;
          } catch (e) {
            last = e;
            if (final(e)) throw e;
            if (!nodeFailed(e)) answer ??= e;
          }
        }
        // an answer about the request: asking again will not change it
        if (answer) throw answer;
      }
      throw last;
    };
    return { ...ts[0]!, request } as ReturnType<Transport>;
  };
}
