/**
 * Self-test: gloam.trade's JSON-RPC proxy (app/api/rpc/[chainId],
 * lib/rpcProxy, lib/rpcProxyServer), 12 Nov 2026.
 *
 * A user saw "In wallet 0 USDG", "No tokens yet" and "Could not load your
 * history" on Robinhood Chain mainnet while his wallet app showed the USDG.
 * The browser reads balances and wallet history from the chain's one public
 * RPC, and with that host blocked or refusing his IP every read failed. The
 * browser now asks gloam.trade's proxy after it. Checked here:
 *
 *  - the route serves only the mainnets with one public RPC, POST and JSON,
 *    only the read methods it lists (never a send), a log read only with an
 *    address, at most 20 calls a batch and 64 KB a body, not for another site;
 *  - each call gets the node's own answer (a range error keeps its code and
 *    message, a revert its data), refusals keep their place in a batch, and a
 *    request whose calls all failed at the node answers 502;
 *  - calls count per IP, each call in a batch counted, and only allowed calls
 *    count towards everyone's limit;
 *  - the upstream is the server's RPC (lib/serverRpc), one request per batch on
 *    Robinhood Chain;
 *  - in the browser the proxy is the last RPC in the list: asked only after the
 *    public RPC failed, never for a send or a method it does not serve, with
 *    batches split to its size; on the server there is no proxy at all.
 *
 * Nothing reaches any host: fetch is stubbed.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-rpc-proxy.mts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { toHex, type EIP1193RequestFn } from "viem";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "test";
env.GLOAM_RATE_LIMIT_KEY = randomBytes(32).toString("hex");
delete env.UPSTASH_REDIS_REST_URL;
delete env.UPSTASH_REDIS_REST_TOKEN;
delete env.GLOAM_RPC_URL_4663;
delete env.GLOAM_RPC_URL_4217;

const ORIGIN = "https://gloam.trade";
const RH_PUBLIC = "https://rpc.mainnet.chain.robinhood.com";
type RpcReq = { jsonrpc: "2.0"; id: number; method: string; params?: unknown[] };
type Reply = { jsonrpc: "2.0"; id: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };

/** What each fake host was asked: "public:eth_blockNumber", "proxy:[3]" (a batch of 3). */
const asked: string[] = [];
let publicMode: "ok" | "drop" = "ok";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = (typeof input === "string" ? input : input instanceof URL ? input.href : input.url).replace(/\/$/, "");
  if (url.startsWith(`${ORIGIN}/api/rpc/`)) {
    const body = JSON.parse(String(init?.body)) as RpcReq | RpcReq[];
    asked.push(Array.isArray(body) ? `proxy:[${body.length}]` : `proxy:${body.method}`);
    const chainId = url.slice(`${ORIGIN}/api/rpc/`.length);
    return route.POST(new Request(url, { method: "POST", headers: init?.headers, body: init?.body }), { params: Promise.resolve({ chainId }) });
  }
  if (url === RH_PUBLIC) {
    const body = JSON.parse(String(init?.body)) as RpcReq | RpcReq[];
    const list = Array.isArray(body) ? body : [body];
    asked.push(Array.isArray(body) ? `public:[${list.length}]` : `public:${list[0]!.method}`);
    if (publicMode === "drop") throw new TypeError("fetch failed");
    const out = list.map((r) => {
      if (r.method === "eth_getLogs") return { jsonrpc: "2.0", id: r.id, error: { code: -32602, message: "exceed maximum block range: 50000" } };
      if (r.method === "eth_call") return { jsonrpc: "2.0", id: r.id, error: { code: 3, message: "execution reverted", data: "0x08c379a0" } };
      return { jsonrpc: "2.0", id: r.id, result: toHex(777) };
    });
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  throw new Error(`selftest-rpc-proxy: no network calls allowed (${url})`);
}) as typeof fetch;

// the fetch stub above reaches the route only once a test runs, after this import
const route = await import("../src/app/api/rpc/[chainId]/route");
const proxyLib = await import("../src/lib/rpcProxyServer");
const { RPC_PROXY_MAX_BATCH, RPC_PROXY_MAX_BODY, RPC_PROXY_METHODS, rpcProxyChainIds, rpcProxyUrl } = await import("../src/lib/rpcProxy");
const { rpcListTransport, rpcOrder, resetRpcRest, isResting } = await import("../src/lib/rpcList");
const { resetRpcChecks } = await import("../src/lib/serverRpc");
const { getNetwork, NETWORK_KEYS } = await import("../src/lib/networks");

const RH = 4663;
const PROXY = `${ORIGIN}/api/rpc/${RH}`;

let n = 0;
async function ok(name: string, fn: () => Promise<void> | void) {
  asked.length = 0;
  publicMode = "ok";
  resetRpcRest();
  resetRpcChecks();
  await fn();
  n++;
  console.log(`ok  ${name}`);
}

let ipSeq = 0;
/** POST to the route as a browser on gloam.trade would, from its own test IP unless one is given. */
function post(chainId: string | number, body: unknown, opts: { ip?: string; headers?: Record<string, string>; raw?: string } = {}) {
  const ip = opts.ip ?? `198.51.100.${++ipSeq}`;
  return route.POST(
    new Request(`${ORIGIN}/api/rpc/${chainId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip, ...opts.headers },
      body: opts.raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ chainId: String(chainId) }) },
  );
}
const call = (id: number, method: string, params: unknown[] = []) => ({ jsonrpc: "2.0", id, method, params });
const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";

/** Answers every call it is given and records them. */
const fakeAsked: string[] = [];
const fakeUpstream: EIP1193RequestFn = (async ({ method }: { method: string }) => {
  fakeAsked.push(method);
  if (method === "eth_blockNumber") return toHex(123);
  if (method === "eth_getBalance") return toHex(5);
  return null;
}) as unknown as EIP1193RequestFn;

// ------------------------------------------------------------------ which chains

await ok("only the live mainnets with one public RPC: Robinhood Chain, Tempo and Elysium", async () => {
  const ids = rpcProxyChainIds();
  assert.ok(ids.includes(RH), "Robinhood Chain mainnet");
  assert.ok(ids.includes(4217), "Tempo mainnet");
  if (NETWORK_KEYS.includes("elysium-mainnet")) assert.ok(ids.includes(getNetwork("elysium-mainnet").chainId), "Elysium mainnet");
  for (const other of [8453, 1, 46630, 42431, 84532, 11155111]) assert.ok(!ids.includes(other), `not ${other}`);
  for (const bad of ["8453", "1", "46630", "0", "04663", "4663.0", "abc", "", "99999999999"]) {
    const res = await post(bad, call(1, "eth_blockNumber"));
    assert.equal(res.status, 404, `chain ${JSON.stringify(bad)}`);
  }
  const get = route.GET();
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
});

// ------------------------------------------------------------------ what a request may ask

await ok("read methods only: a send, a signature or a filter is refused without reaching any node", async () => {
  proxyLib.setUpstreamForTest(RH, fakeUpstream);
  fakeAsked.length = 0;
  for (const m of ["eth_sendRawTransaction", "eth_sendRawTransactionSync", "eth_sendTransaction", "eth_sign", "personal_sign", "eth_newFilter", "debug_traceTransaction", "eth_getStorageAt", "admin_peers"]) {
    assert.ok(!RPC_PROXY_METHODS.has(m), m);
    const res = await post(RH, call(7, m, ["0x00"]));
    assert.equal(res.status, 200, m);
    const reply = (await res.json()) as Reply;
    assert.equal(reply.id, 7);
    assert.equal(reply.error?.code, -32601, m);
  }
  assert.deepEqual(fakeAsked, [], "no refused method reached the node");
  const res = await post(RH, call(8, "eth_blockNumber"));
  assert.deepEqual(await res.json(), { jsonrpc: "2.0", id: 8, result: toHex(123) });
  assert.equal(res.headers.get("cache-control"), "no-store");
  // the chain id is the proxy's own: no node needed
  fakeAsked.length = 0;
  assert.deepEqual(await (await post(RH, call(9, "eth_chainId"))).json(), { jsonrpc: "2.0", id: 9, result: toHex(RH) });
  assert.deepEqual(fakeAsked, []);
  proxyLib.setUpstreamForTest(RH, null);
});

await ok("a log read must name its contracts; params are a short list", async () => {
  proxyLib.setUpstreamForTest(RH, fakeUpstream);
  fakeAsked.length = 0;
  for (const filter of [{ fromBlock: "0x1", toBlock: "0x2" }, { address: [] }, { address: "0x12" }, { address: Array(21).fill(TOKEN) }, null, "x"]) {
    const reply = (await (await post(RH, call(1, "eth_getLogs", [filter]))).json()) as Reply;
    assert.equal(reply.error?.code, -32602, JSON.stringify(filter));
  }
  assert.deepEqual(fakeAsked, []);
  for (const filter of [{ address: TOKEN, fromBlock: "0x1", toBlock: "0x2" }, { address: [TOKEN, WALLET] }]) {
    const reply = (await (await post(RH, call(1, "eth_getLogs", [filter]))).json()) as Reply;
    assert.equal(reply.error, undefined, JSON.stringify(filter));
  }
  const tooMany = (await (await post(RH, call(1, "eth_call", [{}, "latest", {}, {}, {}]))).json()) as Reply;
  assert.equal(tooMany.error?.code, -32602);
  const notList = (await (await post(RH, { jsonrpc: "2.0", id: 1, method: "eth_call", params: { to: TOKEN } })).json()) as Reply;
  assert.equal(notList.error?.code, -32602);
  const noId = (await (await post(RH, { jsonrpc: "2.0", method: "eth_blockNumber" })).json()) as Reply;
  assert.equal(noId.error?.code, -32600, "a call without an id (a notification) is refused");
  proxyLib.setUpstreamForTest(RH, null);
});

await ok("batches: up to 20 calls, answered in order with refusals in place; bigger or empty is refused whole", async () => {
  proxyLib.setUpstreamForTest(RH, fakeUpstream);
  assert.equal(RPC_PROXY_MAX_BATCH, 20);
  const full = Array.from({ length: 20 }, (_, i) => call(i + 1, i === 4 ? "eth_sendRawTransaction" : "eth_blockNumber"));
  const res = await post(RH, full);
  assert.equal(res.status, 200);
  const replies = (await res.json()) as Reply[];
  assert.deepEqual(replies.map((r) => r.id), full.map((c) => c.id));
  assert.equal(replies[4]!.error?.code, -32601, "the send keeps its place, refused");
  assert.ok(replies.every((r, i) => i === 4 || r.result === toHex(123)));
  const over = await post(RH, Array.from({ length: 21 }, (_, i) => call(i + 1, "eth_blockNumber")));
  assert.equal(over.status, 400);
  assert.equal(((await over.json()) as Reply).error?.code, -32600);
  assert.equal((await post(RH, [])).status, 400);
  // not JSON, or JSON that is no call
  const bad = await post(RH, null, { raw: "{nope" });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as Reply).error?.code, -32700);
  for (const raw of ["null", "5", '"text"']) assert.equal((await post(RH, null, { raw })).status, 400, raw);
  proxyLib.setUpstreamForTest(RH, null);
});

await ok("a body over 64 KB, a body that is not JSON, and a call from another site are refused", async () => {
  proxyLib.setUpstreamForTest(RH, fakeUpstream);
  const big = JSON.stringify(call(1, "eth_call", [{ to: TOKEN, data: "0x" + "ab".repeat(RPC_PROXY_MAX_BODY / 2) }, "latest"]));
  assert.ok(big.length > RPC_PROXY_MAX_BODY);
  assert.equal((await post(RH, null, { raw: big })).status, 413);
  assert.equal((await post(RH, call(1, "eth_blockNumber"), { headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await post(RH, call(1, "eth_blockNumber"), { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await post(RH, call(1, "eth_blockNumber"), { headers: { "sec-fetch-site": "same-site" } })).status, 403);
  assert.equal((await post(RH, call(1, "eth_blockNumber"), { headers: { "sec-fetch-site": "same-origin" } })).status, 200);
  proxyLib.setUpstreamForTest(RH, null);
});

// ------------------------------------------------------------------ rate limits

await ok("each call counts against the IP's limit; only allowed calls count towards everyone's", async () => {
  const { RPC_PROXY_PER_IP_PER_MIN: mine, RPC_PROXY_ALL_PER_MIN: all, proxyRate } = proxyLib;
  // a minute of its own, so earlier checks do not count here
  const now = Date.UTC(2030, 0, 1, 12, 0, 30);
  assert.deepEqual(await proxyRate("203.0.113.1", mine, now), { allowed: true, retryAfterSec: 30 });
  assert.equal((await proxyRate("203.0.113.1", 1, now)).allowed, false, "one call over the IP's limit");
  // the refused call added nothing to the shared count: the IPs that fit under it at their limit still do
  const fits = Math.floor(all / mine) - 1;
  for (let i = 0; i < fits; i++) assert.equal((await proxyRate(`203.0.114.${i}`, mine, now)).allowed, true, `ip ${i}`);
  assert.equal((await proxyRate("203.0.115.1", mine, now)).allowed, false, "everyone together is capped");
  // the next minute starts afresh
  assert.equal((await proxyRate("203.0.113.1", 1, now + 60_000)).allowed, true);
  // through the route: a batch of 20 counts 20
  proxyLib.setUpstreamForTest(RH, fakeUpstream);
  const ip = "203.0.116.1";
  const batch = Array.from({ length: 20 }, (_, i) => call(i + 1, "eth_blockNumber"));
  let last: Response | null = null;
  for (let i = 0; i < mine / 20; i++) {
    last = await post(RH, batch, { ip });
    assert.equal(last.status, 200, `batch ${i}`);
  }
  const refused = await post(RH, call(1, "eth_blockNumber"), { ip });
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get("retry-after")) >= 1);
  assert.equal(((await refused.json()) as Reply).error?.code, -32005);
  assert.equal((await post(RH, call(1, "eth_blockNumber"), { ip: "203.0.116.2" })).status, 200, "another IP is not held up");
  proxyLib.setUpstreamForTest(RH, null);
});

// ------------------------------------------------------------------ the node's answers

await ok("the upstream is the server's RPC: one request per batch, node errors passed on whole, 502 when the node failed", async () => {
  // no test hook: the route builds serverTransport for Robinhood Chain (public RPC, no GLOAM_RPC_URL_4663)
  const res = await post(RH, [
    call(1, "eth_blockNumber"),
    call(2, "eth_getLogs", [{ address: TOKEN, fromBlock: "0x1", toBlock: "0xfffff" }]),
    call(3, "eth_call", [{ to: TOKEN, data: "0x" }, "latest"]),
    call(4, "eth_getBalance", [WALLET, "latest"]),
  ]);
  assert.equal(res.status, 200);
  assert.deepEqual(asked, ["public:[4]"], "one batch upstream, not one request per call");
  const replies = (await res.json()) as Reply[];
  assert.equal(replies[0]!.result, toHex(777));
  // a log walk splits on this message (lib/logRange), so it must arrive as the node said it
  assert.deepEqual(replies[1]!.error, { code: -32602, message: "exceed maximum block range: 50000" });
  assert.deepEqual(replies[2]!.error, { code: 3, message: "execution reverted", data: "0x08c379a0" });
  assert.equal(replies[3]!.result, toHex(777));
  // the node is down: every call failed there, so the request is a failed node too
  resetRpcRest();
  publicMode = "drop";
  asked.length = 0;
  const down = await post(RH, call(5, "eth_blockNumber"));
  assert.equal(down.status, 502);
  assert.equal(((await down.json()) as Reply).error?.code, -32603);
  // some calls answered: 200, each with its own answer
  proxyLib.setUpstreamForTest(RH, (async ({ method }: { method: string }) => {
    if (method === "eth_getBalance") throw new TypeError("fetch failed");
    return toHex(1);
  }) as unknown as EIP1193RequestFn);
  const mixed = await post(RH, [call(1, "eth_blockNumber"), call(2, "eth_getBalance", [WALLET, "latest"])]);
  assert.equal(mixed.status, 200);
  const m = (await mixed.json()) as Reply[];
  assert.equal(m[0]!.result, toHex(1));
  assert.equal(m[1]!.error?.code, -32603);
  proxyLib.setUpstreamForTest(RH, null);
});

// ------------------------------------------------------------------ the browser side

const g = globalThis as { window?: unknown };
function inBrowser<T>(fn: () => T): T {
  g.window = { location: { origin: ORIGIN } };
  try {
    return fn();
  } finally {
    delete g.window;
  }
}

await ok("rpcProxyUrl: an absolute same-origin URL in the browser, for the chains it serves; null on the server", () => {
  assert.equal(rpcProxyUrl(RH), null, "no window: the server never lists the proxy");
  assert.equal(inBrowser(() => rpcProxyUrl(RH)), PROXY);
  assert.equal(inBrowser(() => rpcProxyUrl(4217)), `${ORIGIN}/api/rpc/4217`);
  assert.equal(inBrowser(() => rpcProxyUrl(8453)), null, "Base has two public RPCs of its own");
  assert.equal(inBrowser(() => rpcProxyUrl(46630)), null, "no testnet");
  g.window = { location: { origin: "null" } };
  assert.equal(rpcProxyUrl(RH), null, "an opaque origin builds nothing");
  delete g.window;
  // the chain's own RPC list, which wallets add, never names the proxy
  assert.deepEqual(getNetwork("robinhood-mainnet").chain.rpcUrls.default.http, [RH_PUBLIC]);
});

await ok("in the list the proxy is last: asked only after the public RPC failed, never for a send or a method it does not serve", async () => {
  assert.deepEqual(rpcOrder([RH_PUBLIC, PROXY], "eth_blockNumber", Date.now(), PROXY), [0, 1]);
  assert.deepEqual(rpcOrder([RH_PUBLIC, PROXY], "eth_sendRawTransaction", Date.now(), PROXY), [0], "a send never goes to the proxy");
  assert.deepEqual(rpcOrder([RH_PUBLIC, PROXY], "eth_getStorageAt", Date.now(), PROXY), [0]);
  const tr = rpcListTransport([RH_PUBLIC], { timeout: 1_000 }, { proxy: PROXY })({});
  proxyLib.setUpstreamForTest(RH, fakeUpstream);
  // public RPC up: the proxy is not asked
  assert.equal(await tr.request({ method: "eth_blockNumber" }), toHex(777));
  assert.deepEqual(asked, ["public:eth_blockNumber"]);
  // public RPC blocked: the read goes on to the proxy, and the next reads skip the resting public RPC
  publicMode = "drop";
  asked.length = 0;
  assert.equal(await tr.request({ method: "eth_blockNumber" }), toHex(123));
  assert.deepEqual(asked, ["public:eth_blockNumber", "proxy:eth_blockNumber"]);
  assert.equal(isResting(RH_PUBLIC), true);
  asked.length = 0;
  assert.equal(await tr.request({ method: "eth_getBalance", params: [WALLET, "latest"] }), toHex(5));
  assert.deepEqual(asked, ["proxy:eth_getBalance"]);
  // a send, and a method the proxy does not serve, stay with the public RPC and fail there
  asked.length = 0;
  await assert.rejects(tr.request({ method: "eth_sendRawTransaction", params: ["0x02"] }));
  await assert.rejects(tr.request({ method: "eth_getStorageAt", params: [TOKEN, "0x0", "latest"] }));
  assert.ok(!asked.some((a) => a.startsWith("proxy:")), asked.join(","));
  proxyLib.setUpstreamForTest(RH, null);
});

await ok("a batch to the proxy is split to its size", async () => {
  proxyLib.setUpstreamForTest(RH, fakeUpstream);
  publicMode = "drop";
  const tr = rpcListTransport([RH_PUBLIC], { timeout: 1_000, batch: { wait: 5 } }, { proxy: PROXY })({});
  const wallets = Array.from({ length: 30 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
  const out = await Promise.all(wallets.map((w) => tr.request({ method: "eth_getBalance", params: [w, "latest"] })));
  assert.ok(out.every((v) => v === toHex(5)));
  const sizes = asked.filter((a) => a.startsWith("proxy:[")).map((a) => Number(a.slice(7, -1)));
  assert.ok(sizes.length >= 2 && sizes.every((s) => s <= RPC_PROXY_MAX_BATCH), asked.join(","));
  assert.equal(sizes.reduce((a, b) => a + b, 0), 30);
  proxyLib.setUpstreamForTest(RH, null);
});

await ok("the browser's transports list it: wagmi on the three chains, the wallet history, not the transparency ledger", async () => {
  const { readFileSync } = await import("node:fs");
  const wagmi = readFileSync(new URL("../src/lib/wagmi.ts", import.meta.url), "utf8");
  for (const c of ["robinhood", "tempoMainnet", "elysiumMainnet"]) {
    assert.ok(new RegExp(`\\{ proxy: rpcProxyUrl\\(${c}\\.id\\) \\}`).test(wagmi), c);
  }
  const activity = readFileSync(new URL("../src/lib/walletActivity.ts", import.meta.url), "utf8");
  assert.ok(activity.includes("clientFor(n, { proxyFallback: true })"));
  // the transparency page says it reads public nodes with no Gloam server between
  const { clientFor } = await import("../src/components/transparency/ledger");
  const net = getNetwork("robinhood-mainnet");
  inBrowser(() => {
    assert.notEqual(clientFor(net), clientFor(net, { proxyFallback: true }), "the ledger and the wallet history use separate clients");
  });
  proxyLib.setUpstreamForTest(RH, fakeUpstream);
  publicMode = "drop";
  const history = inBrowser(() => clientFor(net, { proxyFallback: true }));
  assert.equal(await history.getBlockNumber({ cacheTime: 0 }), 123n, "the wallet history reads through the proxy");
  resetRpcRest();
  asked.length = 0;
  const ledger = inBrowser(() => clientFor(net));
  await assert.rejects(ledger.getBlockNumber({ cacheTime: 0 }));
  assert.ok(!asked.some((a) => a.startsWith("proxy:")), "the ledger never asks the proxy");
  proxyLib.setUpstreamForTest(RH, null);
});

console.log(`\n${n} checks passed`);
