/**
 * The server side of gloam.trade's JSON-RPC proxy (app/api/rpc/[chainId]; the
 * browser side is lib/rpcProxy). A browser asks it only when the chain's public
 * RPC failed for it, and it answers from the server's own RPC for the chain
 * (lib/serverRpc: GLOAM_RPC_URL_<chainId> when set, else the public RPC).
 *
 * What a request may ask:
 *  - only the mainnets in rpcProxyChainIds, POST, JSON, at most
 *    RPC_PROXY_MAX_BODY bytes and RPC_PROXY_MAX_BATCH calls;
 *  - only the read methods in RPC_PROXY_METHODS, never a send;
 *  - a log read names the contracts it reads, as every read the app makes does;
 *  - each call in a batch counts towards a per-IP limit, and the calls that
 *    pass it towards one limit for everyone, so the proxy is no free public RPC.
 *
 * Each call gets the node's own answer: its result, or its JSON-RPC error with
 * the code, message and data (a range error a log walk splits on, a revert).
 * A node that failed (down, timed out, rate limited) is an upstream error, and
 * when every call failed that way the request answers 502, so the browser
 * rests the proxy as it would any node (lib/rpcList).
 *
 * Nothing here logs a request body, a param or an address.
 */
import { NextResponse } from "next/server";
import { BaseError, HttpRequestError, RpcRequestError, toHex, type EIP1193RequestFn } from "viem";
import { readCappedBody } from "./cspReport";
import { addRateCount, clientIp } from "./mcpRemote/rateLimit";
import { NETWORK_KEYS, getNetwork, type GloamNetwork, type NetworkKey } from "./networks";
import { RPC_PROXY_MAX_BATCH, RPC_PROXY_MAX_BODY, RPC_PROXY_METHODS, rpcProxyChainIds } from "./rpcProxy";
import { serverTransport } from "./serverRpc";

/** Calls per IP per minute, each call in a batch counted. */
export const RPC_PROXY_PER_IP_PER_MIN = 600;
/** Calls per minute from everyone together: the most the server's RPC is asked through the proxy. */
export const RPC_PROXY_ALL_PER_MIN = 20_000;
/** Addresses one log read may name. */
const MAX_LOG_ADDRESSES = 20;
/** Params one call may carry (eth_call's four is the most any allowed method takes). */
const MAX_PARAMS = 4;
/** How long one upstream call waits, and how long a whole request may take. */
const UPSTREAM_TIMEOUT_MS = 8_000;
const DEADLINE_MS = 20_000;

/** Chains whose RPC takes JSON-RPC batches: the browser batches there too (lib/wagmi). */
const BATCH_UPSTREAM: ReadonlySet<NetworkKey> = new Set(["robinhood-mainnet", "elysium-mainnet"]);

const NO_STORE = { "Cache-Control": "no-store" };

type RpcId = number | string | null;
export type RpcError = { code: number; message: string; data?: unknown };
export type RpcReply = { jsonrpc: "2.0"; id: RpcId; result?: unknown; error?: RpcError };
export type RpcCall = { id: number | string; method: string; params: unknown[] };

const PARSE_ERROR: RpcError = { code: -32700, message: "Parse error" };
const INVALID_REQUEST: RpcError = { code: -32600, message: "Invalid request" };

const ok = (id: RpcId, result: unknown): RpcReply => ({ jsonrpc: "2.0", id, result });
const fail = (id: RpcId, error: RpcError): RpcReply => ({ jsonrpc: "2.0", id, error });

/** The live mainnet the proxy serves for this path segment, or null. */
export function proxiedNetwork(chainId: string): GloamNetwork | null {
  if (!/^[1-9][0-9]{0,9}$/.test(chainId)) return null;
  const id = Number(chainId);
  if (!rpcProxyChainIds().includes(id)) return null;
  const key = NETWORK_KEYS.find((k) => getNetwork(k).chainId === id && !getNetwork(k).testnet);
  return key ? getNetwork(key) : null;
}

/** A body as a list of calls, or why it is refused as a whole. */
export function parseRpcBody(text: string): { ok: true; batch: boolean; items: unknown[] } | { ok: false; status: number; reply: RpcReply } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, reply: fail(null, PARSE_ERROR) };
  }
  if (Array.isArray(body)) {
    if (body.length === 0) return { ok: false, status: 400, reply: fail(null, INVALID_REQUEST) };
    if (body.length > RPC_PROXY_MAX_BATCH) {
      return { ok: false, status: 400, reply: fail(null, { code: -32600, message: `Batch too large: at most ${RPC_PROXY_MAX_BATCH} calls` }) };
    }
    return { ok: true, batch: true, items: body };
  }
  if (body && typeof body === "object") return { ok: true, batch: false, items: [body] };
  return { ok: false, status: 400, reply: fail(null, INVALID_REQUEST) };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A log filter that names the contracts it reads: one address, or a short list. */
function namesContracts(filter: unknown): boolean {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return false;
  const a = (filter as { address?: unknown }).address;
  if (typeof a === "string") return ADDRESS.test(a);
  return Array.isArray(a) && a.length > 0 && a.length <= MAX_LOG_ADDRESSES && a.every((x) => typeof x === "string" && ADDRESS.test(x));
}

/** One call checked against the rules above: the call to make, or the error to answer. */
export function checkCall(item: unknown): { call: RpcCall } | { reply: RpcReply } {
  if (!item || typeof item !== "object" || Array.isArray(item)) return { reply: fail(null, INVALID_REQUEST) };
  const o = item as { id?: unknown; method?: unknown; params?: unknown };
  const id = typeof o.id === "number" || typeof o.id === "string" ? o.id : null;
  if (id === null || typeof o.method !== "string") return { reply: fail(id, INVALID_REQUEST) };
  if (!RPC_PROXY_METHODS.has(o.method)) return { reply: fail(id, { code: -32601, message: "Method not allowed on this proxy" }) };
  const params = o.params === undefined ? [] : o.params;
  if (!Array.isArray(params) || params.length > MAX_PARAMS) return { reply: fail(id, { code: -32602, message: "Invalid params" }) };
  if (o.method === "eth_getLogs" && !namesContracts(params[0])) {
    return { reply: fail(id, { code: -32602, message: "eth_getLogs needs an address" }) };
  }
  return { call: { id, method: o.method, params } };
}

/** The node's own JSON-RPC error inside a viem error, or null when the node failed instead. */
function nodeAnswer(e: unknown): RpcError | null {
  const found = e instanceof RpcRequestError ? e : e instanceof BaseError ? e.walk((x) => x instanceof RpcRequestError) : null;
  if (!(found instanceof RpcRequestError)) return null;
  const message = typeof found.details === "string" && found.details ? found.details : "RPC error";
  return found.data === undefined ? { code: found.code, message } : { code: found.code, message, data: found.data };
}

/** The node answered HTTP 429: it is busy, not down. */
function rateLimited(e: unknown): boolean {
  const hit = (x: unknown) => x instanceof HttpRequestError && x.status === 429;
  return hit(e) || (e instanceof BaseError && e.walk(hit) !== null);
}

/**
 * Each call's answer from `request` (the server's RPC), in order. `failed` is
 * how many calls the node itself failed (no answer about the call).
 */
export async function answerCalls(
  request: EIP1193RequestFn,
  chainId: number,
  calls: RpcCall[],
): Promise<{ replies: RpcReply[]; failed: number; firstError: string | null }> {
  let failed = 0;
  let firstError: string | null = null;
  const replies = await Promise.all(
    calls.map(async (c): Promise<RpcReply> => {
      // the proxy's own chain: no node needed
      if (c.method === "eth_chainId") return ok(c.id, toHex(chainId));
      try {
        return ok(c.id, await request({ method: c.method, params: c.params } as Parameters<EIP1193RequestFn>[0]));
      } catch (e) {
        const answer = nodeAnswer(e);
        if (answer) return fail(c.id, answer);
        failed++;
        firstError ??= e instanceof Error ? e.name : "error";
        // -32005 is what a busy node says: the browser rests the proxy and a log walk waits, not splits
        return fail(
          c.id,
          rateLimited(e) ? { code: -32005, message: "Upstream RPC is rate limited" } : { code: -32603, message: "Upstream RPC unavailable" },
        );
      }
    }),
  );
  return { replies, failed, firstError };
}

const upstreams = new Map<number, EIP1193RequestFn>();

/** The server's RPC for the chain as one request function, made once per instance. */
function upstreamFor(net: GloamNetwork): EIP1193RequestFn {
  const hit = upstreams.get(net.chainId);
  if (hit) return hit;
  const transport = serverTransport(net, {
    timeout: UPSTREAM_TIMEOUT_MS,
    retryCount: 1,
    // one upstream request for a browser's batch, not one per call
    ...(BATCH_UPSTREAM.has(net.key) ? { batch: { batchSize: RPC_PROXY_MAX_BATCH, wait: 0 } } : {}),
  });
  const request = transport({ chain: net.chain, retryCount: 1 }).request;
  upstreams.set(net.chainId, request);
  return request;
}

/** Test hook: answer through `request` instead of the server's RPC. */
export function setUpstreamForTest(chainId: number, request: EIP1193RequestFn | null): void {
  if (request) upstreams.set(chainId, request);
  else upstreams.delete(chainId);
}

/**
 * Counts the calls against this IP's limit, then the ones it may make against
 * everyone's. A client over its own limit adds nothing to the shared count, so
 * it cannot use that up for everyone else.
 */
export async function proxyRate(ip: string, calls: number, now = Date.now()): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const retryAfterSec = Math.max(1, 60 - (Math.floor(now / 1000) % 60));
  const mine = await addRateCount(ip, "rpc-proxy", calls, now);
  if (mine > RPC_PROXY_PER_IP_PER_MIN) return { allowed: false, retryAfterSec };
  const all = await addRateCount("all", "rpc-proxy-all", calls, now);
  return { allowed: all <= RPC_PROXY_ALL_PER_MIN, retryAfterSec };
}

function answer(replies: RpcReply[], batch: boolean, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(batch ? replies : replies[0], { status, headers: { ...NO_STORE, ...headers } });
}

/** POST /api/rpc/[chainId]. */
export async function rpcProxyResponse(req: Request, chainId: string): Promise<NextResponse> {
  const net = proxiedNetwork(chainId);
  if (!net) return NextResponse.json({ error: "unknown_chain" }, { status: 404, headers: NO_STORE });
  // Gloam's own pages only. Browsers say where a call comes from; a page on
  // another site is refused here (and by the CORS preflight a JSON POST needs).
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  if (!/^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "")) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415, headers: NO_STORE });
  }
  let text: string | null;
  try {
    text = await readCappedBody(req, RPC_PROXY_MAX_BODY);
  } catch {
    return answer([fail(null, PARSE_ERROR)], false, 400);
  }
  if (text === null) return answer([fail(null, { code: -32600, message: "Request too large" })], false, 413);
  const parsed = parseRpcBody(text);
  if (!parsed.ok) return answer([parsed.reply], false, parsed.status);

  const rate = await proxyRate(clientIp(req), parsed.items.length);
  if (!rate.allowed) {
    const limited: RpcError = { code: -32005, message: "Too many requests, rate limited" };
    const replies = parsed.items.map((item) => fail(checkedId(item), limited));
    return answer(replies, parsed.batch, 429, { "Retry-After": String(rate.retryAfterSec) });
  }

  const checked = parsed.items.map(checkCall);
  const calls = checked.flatMap((c) => ("call" in c ? [c.call] : []));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DEADLINE_MS);
  });
  const done = await Promise.race([answerCalls(upstreamFor(net), net.chainId, calls), late]).finally(() => clearTimeout(timer));
  if (!done) {
    console.warn("gloam_rpc_proxy_upstream", JSON.stringify({ chainId: net.chainId, calls: calls.length, error: "deadline" }));
    const replies = parsed.items.map((item) => fail(checkedId(item), { code: -32603, message: "Upstream RPC timed out" }));
    return answer(replies, parsed.batch, 504);
  }
  if (done.failed) {
    console.warn("gloam_rpc_proxy_upstream", JSON.stringify({ chainId: net.chainId, calls: calls.length, failed: done.failed, error: done.firstError }));
  }
  // the node answers in the calls' order; refusals keep their own place
  const byCall = new Map(calls.map((c, i) => [c, done.replies[i]!]));
  const replies = checked.map((c) => ("call" in c ? byCall.get(c.call)! : c.reply));
  // no call got an answer from any node: a failed node, to the browser
  const status = calls.length > 0 && done.failed === calls.length ? 502 : 200;
  return answer(replies, parsed.batch, status);
}

/** A call's id where it has a usable one, for an error that answers it. */
function checkedId(item: unknown): RpcId {
  const id = item && typeof item === "object" ? (item as { id?: unknown }).id : null;
  return typeof id === "number" || typeof id === "string" ? id : null;
}
