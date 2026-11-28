/**
 * Self-test: Gloam's Starknet routes (/api/starknet/rpc, /relay, /prove) and
 * what they stand on (lib/starknetPrivacy/proxyPolicy, server, starkscanProver),
 * with every node and prover faked: no request leaves the process.
 *
 *  - the RPC proxy: only reads pass (nothing that sends, no devnet methods, event
 *    pages capped); same-origin and JSON only; batches capped; a refused call in
 *    a batch is answered alone; the node's URL comes from the server.
 *  - the relay: what it sends goes through relayPolicy and then the chain (an
 *    account deploy only once, an approve only from a Gloam account, a proof only
 *    while the pool's own STRK fee is off, the fee from the environment, the cap
 *    on an approve); limits answer 429 or 503 before anything is sent; a failed
 *    send says why without the key; the route refuses malformed bodies, more than
 *    one call, other sites; GET names the relay, its fee, whether it is funded and
 *    whether it sends moves (off on mainnet with no fee and no sponsored budget),
 *    reads the relay's STRK at most once per 20 seconds, and holds each IP to 60 a minute.
 *  - the prover: only starknet_proveTransaction and starknet_specVersion; a
 *    prover URL is passed on as is; mainnet goes through Starkscan's job API
 *    (key header, a stable Idempotency-Key from the body, submit then poll) and
 *    answers in the proving service's shape; Starkscan's refusals become plain
 *    errors; the adapter as the SDK's prover takes the pool's message as output.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-starknet-routes.mts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { ec, hash, num, outsideExecution, type Call } from "starknet";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const RELAY = "0x25a6c9f0c15ef30c139065096b4b8e563e6b86191fd600a4f0616df8f22fb77";
const POOL = "0x707b48deabbccebce6e3e0af4d9d232fb860e95bffe7efa66ac250b9e28acff";
const USDC = "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const NODE = "https://node.selftest/rpc";
const STARKSCAN = "https://api.starkscan.co/v1/SN_MAIN/prove";

const env = process.env as Record<string, string | undefined>;
for (const k of Object.keys(env)) if (k.startsWith("NEXT_PUBLIC_STARKNET_") || k.startsWith("STARKNET_") || k.startsWith("GLOAM_STARKNET_")) delete env[k];
delete env.UPSTASH_REDIS_REST_URL;
delete env.UPSTASH_REDIS_REST_TOKEN;
env.NEXT_PUBLIC_STARKNET_ENABLED = "1";
env.NEXT_PUBLIC_STARKNET_NETWORK = "mainnet";
env.NEXT_PUBLIC_STARKNET_POOL = POOL;
env.STARKNET_RPC_URL = NODE;
env.STARKSCAN_API_KEY = "selftest-starkscan-key";
env.STARKNET_RELAY_FEE = "0.01";
env.STARKNET_MAX_APPROVE = "1000";
// The relay's key: a throwaway made here, in this process only.
const SECRET = "0x0" + randomBytes(30).toString("hex");
env.GLOAM_STARKNET_RELAYER_ADDRESS = RELAY;
env.GLOAM_STARKNET_RELAYER_SECRET = SECRET;

let pass = 0;
const ok = (c: unknown, msg: string) => {
  assert.ok(c, msg);
  pass++;
};
const eq = <T,>(a: T, b: T, msg: string) => {
  assert.deepEqual(a, b, msg);
  pass++;
};

/* ------------------------------------------------------------------ a fake world: the node and Starkscan */
type Seen = { url: string; method: string; headers: Record<string, string>; body: unknown };
const seen: Seen[] = [];
let starkscan: (url: string, init: RequestInit) => Response = () => new Response("{}", { status: 500 });
const DISCOVERY = "https://discovery.nodes.starknet.org";
let discovery: (url: string, init: RequestInit) => Response = () => new Response("{}", { status: 500 });
const nodeAnswer: (call: { method: string; params: unknown; id: unknown }) => unknown = (c) => {
  if (c.method === "starknet_specVersion") return "0.10.0";
  if (c.method === "starknet_chainId") return "0x534e5f4d41494e";
  if (c.method === "starknet_getNonce") return "0x7";
  if (c.method === "starknet_call") return ["0x2b5e3af16b1880000", "0x0"]; // 50 STRK
  if (c.method === "starknet_blockNumber") return 1234;
  return null;
};
let nodeDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const text = typeof init.body === "string" ? init.body : "";
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  seen.push({ url, method: init.method ?? "GET", headers, body });
  if (url.startsWith(NODE)) {
    if (nodeDown) throw new Error("connect ECONNREFUSED");
    const one = (c: { method: string; params: unknown; id: unknown }) => ({ jsonrpc: "2.0", id: c.id, result: nodeAnswer(c) });
    const out = Array.isArray(body) ? (body as never[]).map(one) : one(body as never);
    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
  }
  if (url.startsWith(STARKSCAN)) return starkscan(url, init);
  if (url.startsWith(DISCOVERY)) return discovery(url, init);
  if (url.startsWith("https://prover.selftest")) {
    const b = body as { id: unknown };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { proof: "QUJD", proof_facts: ["0x1"], l2_to_l1_messages: [] } }), { headers: { "content-type": "application/json" } });
  }
  return realFetch(input as never, init);
}) as typeof fetch;

const config = await import("../src/lib/starknetPrivacy/config");
const proxy = await import("../src/lib/starknetPrivacy/proxyPolicy");
const server = await import("../src/lib/starknetPrivacy/server");
const policy = await import("../src/lib/starknetPrivacy/relayPolicy");
const account = await import("../src/lib/starknetPrivacy/account");
const scan = await import("../src/lib/starknetPrivacy/starkscanProver");
const rpcRoute = await import("../src/app/api/starknet/rpc/route");
const relayRoute = await import("../src/app/api/starknet/relay/route");
const proveRoute = await import("../src/app/api/starknet/prove/route");
const discoveryRoute = await import("../src/app/api/starknet/discovery/route");
const keysRoute = await import("../src/app/api/starknet/discovery/ohttp-keys/route");
const { kv1, resetMemoryKv } = await import("../src/lib/partnersKv");
const { CallData, CairoCustomEnum, CairoOption, CairoOptionVariant } = await import("starknet");
const { PrivacyPoolABI } = await import("@starkware-libs/starknet-privacy-sdk/abi");

const info = (ip = "203.0.113.7") => new Request("https://www.gloam.trade/api/starknet/relay", { headers: { "x-forwarded-for": ip } });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://www.gloam.trade${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/* ------------------------------------------------------------------ the proxy's rules */
{
  for (const m of ["starknet_call", "starknet_getClassHashAt", "starknet_getNonce", "starknet_blockNumber", "starknet_getTransactionReceipt", "starknet_getTransactionStatus", "starknet_chainId", "starknet_specVersion", "starknet_getStorageAt"])
    ok(proxy.starknetRpcCallAllowed({ method: m, params: [] }), `${m} passes`);
  for (const m of ["starknet_addInvokeTransaction", "starknet_addDeployAccountTransaction", "starknet_addDeclareTransaction", "starknet_estimateFee", "starknet_simulateTransactions", "starknet_traceTransaction", "devnet_mint", "devnet_createBlock", "eth_call", ""])
    ok(!proxy.starknetRpcCallAllowed({ method: m, params: [] }), `${m || "an empty method"} is refused`);
  ok(proxy.starknetRpcCallAllowed({ method: "starknet_getEvents", params: { filter: { chunk_size: 1000 } } }), "an event page of 1000 passes");
  ok(!proxy.starknetRpcCallAllowed({ method: "starknet_getEvents", params: { filter: { chunk_size: 1001 } } }), "an event page over 1000 is refused");
  ok(!proxy.starknetRpcCallAllowed({ method: "starknet_getEvents", params: { filter: {} } }), "an event page with no size is refused");
  ok(proxy.STARKNET_PROVE_METHODS.has("starknet_proveTransaction") && proxy.STARKNET_PROVE_METHODS.size === 2, "the prover passes only proveTransaction and specVersion");
}

/* ------------------------------------------------------------------ the RPC route */
{
  seen.length = 0;
  let res = await rpcRoute.POST(post("/api/starknet/rpc", { jsonrpc: "2.0", id: 1, method: "starknet_blockNumber", params: [] }));
  eq(res.status, 200, "a read answers");
  eq(((await res.json()) as { result: unknown }).result, 1234, "with the node's answer");
  eq(seen.at(-1)?.url, NODE, "read from the server's node (STARKNET_RPC_URL)");

  seen.length = 0;
  res = await rpcRoute.POST(post("/api/starknet/rpc", [
    { jsonrpc: "2.0", id: 1, method: "starknet_chainId", params: [] },
    { jsonrpc: "2.0", id: 2, method: "starknet_addInvokeTransaction", params: [] },
  ]));
  const replies = (await res.json()) as { id: number; result?: unknown; error?: { code: number } }[];
  eq(replies.map((r) => [r.id, r.error?.code ?? "ok"]), [[1, "ok"], [2, -32601]], "in a batch, the send is refused alone");
  eq((seen.at(-1)?.body as { method: string }[]).map((c) => c.method), ["starknet_chainId"], "and never reaches the node");

  res = await rpcRoute.POST(post("/api/starknet/rpc", { jsonrpc: "2.0", id: 1, method: "starknet_chainId" }, { "sec-fetch-site": "cross-site" }));
  eq(res.status, 403, "another site is refused");
  res = await rpcRoute.POST(new Request("https://www.gloam.trade/api/starknet/rpc", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }));
  eq(res.status, 415, "a body that isn't JSON is refused");
  res = await rpcRoute.POST(post("/api/starknet/rpc", Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "starknet_chainId" }))));
  eq(res.status, 400, "a batch over 20 is refused");
  res = await rpcRoute.POST(post("/api/starknet/rpc", "x".repeat(proxy.STARKNET_RPC_MAX_BODY + 10)));
  eq(res.status, 413, "a body over the cap is refused");
  nodeDown = true;
  res = await rpcRoute.POST(post("/api/starknet/rpc", { jsonrpc: "2.0", id: 1, method: "starknet_chainId" }));
  nodeDown = false;
  eq(res.status, 502, "a node that is down answers 502");
}

/* ------------------------------------------------------------------ the relay's rules, from the environment */
const cfg = config.starknetConfig("mainnet", env);
{
  eq(server.relayKeys(env), { address: RELAY, secret: SECRET }, "the relay's address and key come from the environment");
  eq(server.relayKeys({ GLOAM_STARKNET_RELAYER_ADDRESS: RELAY }), null, "no key, no relay");
  eq(server.relayKeys({ GLOAM_STARKNET_RELAYER_ADDRESS: RELAY, GLOAM_STARKNET_RELAYER_SECRET: "not-hex" }), null, "a malformed key, no relay");
  eq(server.relayKeys({ GLOAM_STARKNET_RELAYER_ADDRESS: RELAY, GLOAM_STARKNET_RELAYER_SECRET: "0x0" }), null, "a zero key, no relay");
  const amounts = server.relayAmounts(cfg, env);
  eq(amounts.fee[num.toHex(BigInt(USDC))], 10_000n, "the fee: 0.01 USDC");
  eq(amounts.maxApprove[num.toHex(BigInt(USDC))], 1_000_000_000n, "the approve cap: 1,000 USDC");
  const dflt = server.relayAmounts(cfg, {});
  eq([dflt.fee[num.toHex(BigInt(USDC))], dflt.maxApprove[num.toHex(BigInt(USDC))]], [0n, 10_000_000_000n], "by default no fee and a 10,000 USDC cap");
  eq(server.wholeToBase("1.5", 6), 1_500_000n, "whole tokens to base units");
  eq(server.wholeToBase("1.1234567", 6), null, "more places than the token has is refused");
  eq(server.wholeToBase("-1", 6), null, "a negative amount is refused");
  eq(server.starknetUpstream(cfg, {}), cfg.rpcUrl, "the public node by default");
}

/* ------------------------------------------------------------------ relaySend against a fake chain */
type Sent = { calls: Call[]; proof?: unknown };
function fakeChain(o: { deployed?: Set<string>; classes?: Record<string, string>; poolFee?: bigint; sendThrows?: string } = {}) {
  const sent: Sent[] = [];
  const chain = {
    async classHashAt(a: string) {
      const k = num.toHex(BigInt(a));
      if (o.classes?.[k]) return o.classes[k];
      return o.deployed?.has(k) ? config.STARKNET_ACCOUNT_CLASS_HASH : null;
    },
    async poolFeeAmount() {
      return o.poolFee ?? 0n;
    },
    async send(calls: Call[], proof?: unknown) {
      if (o.sendThrows) throw new Error(o.sendThrows);
      sent.push({ calls, proof });
      return "0xabc";
    },
  };
  return { chain, sent };
}
const okRate = async () => "ok" as const;
// relaySend never sends one call twice (a second copy would revert and cost STRK): the checks
// below send the same call again on purpose, so each starts with the store empty.
const relaySend: typeof server.relaySend = (x) => {
  resetMemoryKv();
  return server.relaySend(x);
};
const pub = ec.starkCurve.getStarkKey("0x4242");
const acct = account.accountAddress(pub);
const NOW = 1_800_000_000_000;
const approveFor = (from: string, amount: bigint): Call => ({
  contractAddress: from,
  entrypoint: policy.OUTSIDE_V2_ENTRYPOINT,
  calldata: [RELAY, "0x7", num.toHex(NOW / 1000 - 60), num.toHex(NOW / 1000 + 600), "0x1", USDC, policy.APPROVE_SELECTOR, "0x3", POOL, num.toHex(amount), "0x0", "0x2", "0x1", "0x2"],
});
const cd = new CallData(PrivacyPoolABI);
const applyCall = (acts: InstanceType<typeof CairoCustomEnum>[]): Call => ({
  contractAddress: POOL,
  entrypoint: "apply_actions",
  calldata: cd.compile("apply_actions", { actions: acts, screening: new CairoOption(CairoOptionVariant.None) }),
});
const to = (addr: string, amount: number) => new CairoCustomEnum({ TransferTo: { to_addr: addr, token: USDC, amount } });
const PROOF = { proofFacts: ["0x1", "0x2"], proof: "QUJD" };
{
  let f = fakeChain();
  let r = await relaySend({ calls: [account.deployAccountCall(pub)], cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(r.ok && r.decision.kind === "deploy" && f.sent.length === 1, "a new account's deploy is sent");
  f = fakeChain({ deployed: new Set([num.toHex(BigInt(acct))]) });
  r = await relaySend({ calls: [account.deployAccountCall(pub)], cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(!r.ok && r.code === "already_deployed" && f.sent.length === 0, "a deployed account's deploy is not paid for again");

  f = fakeChain({ deployed: new Set([num.toHex(BigInt(acct))]) });
  r = await relaySend({ calls: [approveFor(acct, 1_000_000n)], cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(r.ok && r.decision.kind === "approve" && f.sent.length === 1, "a Gloam account's approve is sent");
  const other = "0x0700000000000000000000000000000000000000000000000000000000000001";
  f = fakeChain({ classes: { [num.toHex(BigInt(other))]: "0x123" } });
  r = await relaySend({ calls: [approveFor(other, 1_000_000n)], cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(!r.ok && r.status === 422 && f.sent.length === 0, "another account's approve is refused");
  f = fakeChain({ deployed: new Set([num.toHex(BigInt(acct))]) });
  r = await relaySend({ calls: [approveFor(acct, 2_000_000_000n)], cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(!r.ok && /approve_amount/.test(r.message) && f.sent.length === 0, "an approve over the environment's cap is refused");

  const OUT = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd";
  f = fakeChain();
  r = await relaySend({ calls: [applyCall([to(OUT, 250_000)])], proof: PROOF, cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(!r.ok && /fee_missing/.test(r.message) && f.sent.length === 0, "a proof that doesn't pay the relay's fee is refused");
  r = await relaySend({ calls: [applyCall([to(OUT, 250_000), to(RELAY, 10_000)])], proof: PROOF, cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(r.ok && r.decision.kind === "apply" && f.sent.length === 1, "a cash out paying the fee is sent");
  eq(f.sent[0]?.proof, PROOF, "with its proof");
  eq(f.sent[0]?.calls.length, 1, "with no pool fee, the apply goes alone");
  const STRK_FEE = 4_500_000_000_000_000_000n;
  f = fakeChain({ poolFee: STRK_FEE });
  const cashOut = applyCall([to(OUT, 250_000), to(RELAY, 10_000)]);
  r = await relaySend({ calls: [cashOut], proof: PROOF, cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(r.ok && f.sent.length === 1, "the pool's own STRK fee is paid by the relay");
  const strkApprove = (amount: bigint) => ({ contractAddress: config.STARKNET_STRK, entrypoint: "approve", calldata: [num.toHex(BigInt(POOL)), num.toHex(amount), "0x0"] });
  eq(f.sent[0]?.calls, [strkApprove(STRK_FEE), cashOut, strkApprove(0n)], "in one transaction: approve exactly the fee, apply, approve 0");
  f = fakeChain({ poolFee: 11n * 10n ** 18n });
  r = await relaySend({ calls: [cashOut], proof: PROOF, cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(!r.ok && r.code === "pool_fee_high" && r.status === 503 && f.sent.length === 0, "a pool fee over the cap (10 STRK by default): paused, nothing sent");
  r = await relaySend({ calls: [cashOut], proof: PROOF, cfg, relay: RELAY, chain: f.chain, env: { ...env, STARKNET_MAX_POOL_FEE: "20" }, now: NOW, rate: okRate });
  ok(r.ok && f.sent.length === 1, "a higher cap set in the environment lets it through");

  // The canonical pool: pinned to its class, and a deposit's screening attestation checked before paying.
  const PIN = "0xc1a55";
  const pinned = { ...cfg, poolClassHash: PIN };
  const poolKey = num.toHex(BigInt(POOL));
  const from = (addr: string, amount: number) => new CairoCustomEnum({ TransferFrom: { from_addr: addr, token: USDC, amount } });
  const attested = (c: Call, at: number): Call => ({ ...c, calldata: [...(c.calldata as string[]).slice(0, -1), "0x0", num.toHex(at), "0x123", "0x456"] });
  const add = applyCall([from(acct, 1_000_000), to(RELAY, 10_000)]);
  const nowS = NOW / 1000;
  f = fakeChain({ classes: { [poolKey]: PIN } });
  r = await relaySend({ calls: [cashOut], proof: PROOF, cfg: pinned, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(r.ok && f.sent.length === 1, "the pool still on its pinned class: sent");
  f = fakeChain({ classes: { [poolKey]: "0xbad" } });
  r = await relaySend({ calls: [cashOut], proof: PROOF, cfg: pinned, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(!r.ok && r.code === "pool_changed" && r.status === 503 && f.sent.length === 0, "the pool's code changed: paused until Gloam checks it");
  f = fakeChain();
  r = await relaySend({ calls: [cashOut], proof: PROOF, cfg: pinned, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(!r.ok && r.code === "upstream_unavailable" && f.sent.length === 0, "the pool's class unread: nothing sent");
  f = fakeChain({ classes: { [poolKey]: PIN } });
  r = await relaySend({ calls: [add], proof: PROOF, cfg: pinned, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(!r.ok && r.code === "screening_missing" && f.sent.length === 0, "a deposit with no screening attestation is refused before paying");
  r = await relaySend({ calls: [attested(add, nowS - 30)], proof: PROOF, cfg: pinned, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(r.ok && f.sent.length === 1, "a deposit with a fresh attestation is sent");
  r = await relaySend({ calls: [attested(add, nowS - server.SCREENING_SEND_WINDOW_S - 1)], proof: PROOF, cfg: pinned, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(!r.ok && r.code === "screening_expired" && r.status === 409 && f.sent.length === 1, "a stale attestation is refused, so the page proves again");
  r = await relaySend({ calls: [attested(cashOut, nowS - 30)], proof: PROOF, cfg: pinned, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(!r.ok && /unexpected_screening/.test(r.message) && f.sent.length === 1, "an attestation on a move with no deposit is refused (the pool would revert)");
  r = await relaySend({ calls: [add], proof: PROOF, cfg, relay: RELAY, chain: fakeChain().chain, env, now: NOW, rate: okRate });
  ok(r.ok, "a pool that isn't pinned isn't held to the canonical pool's screening rule");

  f = fakeChain();
  r = await relaySend({ calls: [account.deployAccountCall(pub)], cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: async () => "limited" });
  ok(!r.ok && r.status === 429 && f.sent.length === 0, "over the limit: 429, nothing sent");
  r = await relaySend({ calls: [account.deployAccountCall(pub)], cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: async () => "unavailable" });
  ok(!r.ok && r.status === 503 && f.sent.length === 0, "no shared count: 503, nothing sent");
  f = fakeChain({ sendThrows: `RPC: starknet_addInvokeTransaction failed ${"x".repeat(400)}` });
  r = await relaySend({ calls: [account.deployAccountCall(pub)], cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(!r.ok && r.status === 502 && r.message.length < 300 && !r.message.includes(SECRET.slice(2)), "a failed send says why, short, never with the key");
}

/* ------------------------------------------------------------------ the relay under load, and a changed pool */
{
  const { RpcError } = await import("starknet");
  const PIN = "0xc1a55";
  const pinned = { ...cfg, poolClassHash: PIN };
  const poolKey = num.toHex(BigInt(POOL));
  const acctKey = num.toHex(BigInt(acct));

  // A node's refusal names its reason: starknet.js puts the whole request first, which the old cut kept
  // instead of the reason (a nonce clash read "Starknet refused it: RPC: starknet_addInvokeTransaction with params {...").
  const params = { invoke_transaction: { calldata: Array.from({ length: 40 }, (_, i) => `0x${i}`) } };
  const nonceClash = new RpcError({ code: 52, message: "Invalid transaction nonce", data: "Account nonce: 1; got: 0." } as never, "starknet_addInvokeTransaction", params);
  let f = fakeChain();
  f.chain.send = async () => {
    throw nonceClash;
  };
  let r = await relaySend({ calls: [account.deployAccountCall(ec.starkCurve.getStarkKey("0x77"))], cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(!r.ok && r.code === "send_failed" && r.message.includes("52: Invalid transaction nonce: Account nonce: 1; got: 0.") && r.message.length < 300, "a refused send keeps the node's reason, short");

  // The pool changed under its pin: an approve to it is not sent either (it would let the new code take the tokens).
  f = fakeChain({ deployed: new Set([acctKey]), classes: { [poolKey]: "0xbad" } });
  r = await relaySend({ calls: [approveFor(acct, 1_000_000n)], cfg: pinned, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(!r.ok && r.code === "pool_changed" && r.status === 503 && f.sent.length === 0, "a changed pool pauses approves too");
  f = fakeChain({ deployed: new Set([acctKey]), classes: { [poolKey]: PIN } });
  r = await relaySend({ calls: [approveFor(acct, 1_000_000n)], cfg: pinned, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  ok(r.ok && f.sent.length === 1, "the pool on its pin: the approve is sent");

  // Sends at once go one at a time: the relay is one account, and two sends at once read the same nonce.
  resetMemoryKv();
  let live = 0;
  let most = 0;
  const order: number[] = [];
  const slow = fakeChain();
  slow.chain.send = async (calls: Call[]) => {
    live++;
    most = Math.max(most, live);
    await new Promise((res) => setTimeout(res, 15));
    order.push(Number(BigInt((calls[0]!.calldata as string[])[1]!) % 1000n));
    live--;
    return "0xabc";
  };
  const many = await Promise.all(
    [1, 2, 3, 4, 5].map((i) => server.relaySend({ calls: [account.deployAccountCall(ec.starkCurve.getStarkKey(num.toHex(9000 + i)))], cfg, relay: RELAY, chain: slow.chain, env, now: NOW, rate: okRate }))
  );
  ok(many.every((x) => x.ok) && most === 1 && order.length === 5, "five sends at once: all sent, never two at the same time");

  // Across instances the lock is in the shared store: while another holds it, a send waits, then says busy.
  resetMemoryKv();
  await kv1(["SET", `gloam:starknet:v1:relay-lock:${num.toHex(BigInt(RELAY))}`, "someone-else", "NX", "EX", 30]);
  f = fakeChain();
  const t0 = Date.now();
  r = await server.relaySend({ calls: [account.deployAccountCall(ec.starkCurve.getStarkKey("0x78"))], cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate, lockWaitMs: 300 });
  ok(!r.ok && r.code === "relay_busy" && r.status === 503 && f.sent.length === 0 && Date.now() - t0 >= 300, "another instance's send in flight: this one waits, then says busy, nothing sent");
  await kv1(["DEL", `gloam:starknet:v1:relay-lock:${num.toHex(BigInt(RELAY))}`]);
  r = await server.relaySend({ calls: [account.deployAccountCall(ec.starkCurve.getStarkKey("0x78"))], cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate, lockWaitMs: 300 });
  ok(r.ok && f.sent.length === 1, "once it is free, the send goes");

  // The same call twice is sent once: under the lock a second copy would land and revert, paid by the relay.
  resetMemoryKv();
  f = fakeChain();
  const cashOut = applyCall([to("0x0123", 250_000), to(RELAY, 10_000)]);
  const both = await Promise.all([0, 1].map(() => server.relaySend({ calls: [cashOut], proof: PROOF, cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate })));
  ok(both.filter((x) => x.ok).length === 1 && both.some((x) => !x.ok && x.code === "already_sent" && x.status === 409) && f.sent.length === 1, "the same proven call sent twice at once goes out once");
  f = fakeChain({ sendThrows: "refused" });
  const again = applyCall([to("0x0124", 250_000), to(RELAY, 10_000)]);
  r = await server.relaySend({ calls: [again], proof: PROOF, cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: okRate });
  const g = fakeChain();
  const r2 = await server.relaySend({ calls: [again], proof: PROOF, cfg, relay: RELAY, chain: g.chain, env, now: NOW, rate: okRate });
  ok(!r.ok && r.code === "send_failed" && r2.ok && g.sent.length === 1, "a send the node refused can be sent again");
  resetMemoryKv();
}

/* ------------------------------------------------------------------ an account's open */
{
  // An account's open owes no fee (it has nothing to pay one from) and is counted as an open.
  const write = () => new CairoCustomEnum({ WriteOnce: { storage_address: "0x77", value: ["0x1", "0x2"] } });
  const open = applyCall([write(), write()]);
  const kinds: string[] = [];
  const f = fakeChain();
  let r = await server.relaySend({ calls: [open], proof: PROOF, cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: async (k) => (kinds.push(k), "ok") });
  ok(r.ok && r.decision.kind === "apply" && r.decision.setup && f.sent.length === 1, "with the relay's fee on (0.01 USDC here), an open is still sent");
  r = await server.relaySend({ calls: [applyCall([to("0x0123", 250_000), to(RELAY, 10_000)])], proof: PROOF, cfg, relay: RELAY, chain: f.chain, env, now: NOW, rate: async (k) => (kinds.push(k), "ok") });
  eq(kinds, ["open", "move"], "an open is counted as an open, a move as a move");
  const day = Date.UTC(2033, 0, 1, 12);
  const openReq = post("/api/starknet/relay", {}, { "x-forwarded-for": "198.51.100.77" });
  const opens: string[] = [];
  for (let i = 0; i < 6; i++) opens.push(await server.starknetRelayRate(openReq, "open", day, "mainnet"));
  eq(opens, ["ok", "ok", "ok", "ok", "ok", "limited"], "opens: five a day per IP, like deploys");
}

/* ------------------------------------------------------------------ mainnet: a move pays the relay's fee, or a sponsored budget */
{
  // With no fee set the relay paid about 7 STRK for any proven move, anyone's (StarkWare's prover is a
  // public image). On mainnet a move now needs the fee, or STARKNET_SPONSORED_MOVES_PER_DAY.
  const noFee: Record<string, string | undefined> = { ...env };
  delete noFee.STARKNET_RELAY_FEE;
  const write = () => new CairoCustomEnum({ WriteOnce: { storage_address: "0x77", value: ["0x1", "0x2"] } });
  const open = applyCall([write(), write()]);
  const cashOut = applyCall([to("0x0125", 250_000)]);
  const acctKey = num.toHex(BigInt(acct));
  const kinds: string[] = [];
  const rate = async (k: string) => (kinds.push(k), "ok" as const);
  let f = fakeChain({ deployed: new Set([acctKey]) });
  let reads = 0;
  const classHashAt = f.chain.classHashAt;
  f.chain.classHashAt = async (a: string) => (reads++, classHashAt(a));
  let r = await relaySend({ calls: [cashOut], proof: PROOF, cfg, relay: RELAY, chain: f.chain, env: noFee, now: NOW, rate });
  ok(!r.ok && r.code === "fee_unset" && r.status === 503 && f.sent.length === 0 && kinds.length === 0 && reads === 0, "mainnet, no relay fee set: a move is refused before anything is read, counted or sent");
  r = await relaySend({ calls: [approveFor(acct, 1_000_000n)], cfg, relay: RELAY, chain: f.chain, env: { ...noFee, STARKNET_RELAY_FEE: "0" }, now: NOW, rate });
  ok(!r.ok && r.code === "fee_unset" && f.sent.length === 0, "a fee of 0 is no fee: an add's approve is refused too (its add couldn't follow)");
  r = await relaySend({ calls: [open], proof: PROOF, cfg, relay: RELAY, chain: f.chain, env: noFee, now: NOW, rate });
  ok(r.ok && f.sent.length === 1, "an account's open still goes (it owes no fee and has its own cap)");
  const sponsor = { ...noFee, STARKNET_SPONSORED_MOVES_PER_DAY: "2" };
  r = await relaySend({ calls: [cashOut], proof: PROOF, cfg, relay: RELAY, chain: f.chain, env: sponsor, now: NOW, rate });
  ok(r.ok && f.sent.length === 2, "with a sponsored budget set, a move with no fee goes");
  r = await relaySend({ calls: [approveFor(acct, 1_000_000n)], cfg, relay: RELAY, chain: f.chain, env: sponsor, now: NOW, rate });
  ok(r.ok && f.sent.length === 3, "and so does an add's approve");
  eq(kinds, ["open", "sponsored", "approve"], "the move counted against the sponsored budget, the approve and the open not");

  // The sponsored count is everyone's, for the day, and on mainnet it fails closed.
  const day = Date.UTC(2035, 0, 1, 12);
  const got: string[] = [];
  for (let i = 0; i < 3; i++) got.push(await server.starknetRelayRate(post("/api/starknet/relay", {}, { "x-forwarded-for": `198.51.100.${90 + i}` }), "sponsored", day, "mainnet", sponsor));
  eq(got, ["ok", "ok", "day_used"], "two sponsored moves a day (2 set here), from any IPs, then the day is used");
  const nodeEnv = env.NODE_ENV;
  env.NODE_ENV = "production";
  const shut = await server.starknetRelayRate(post("/api/starknet/relay", {}, { "x-forwarded-for": "198.51.100.99" }), "sponsored", day + 86_400_000, "mainnet", sponsor);
  env.NODE_ENV = nodeEnv;
  eq(shut, "unavailable", "no shared count (production without Redis): no sponsored move");

  // Devnet and Sepolia keep sending a move with no fee.
  for (const network of ["sepolia", "devnet"] as const) {
    kinds.length = 0;
    f = fakeChain();
    r = await relaySend({ calls: [cashOut], proof: PROOF, cfg: { ...cfg, network, poolClassHash: null }, relay: RELAY, chain: f.chain, env: noFee, now: NOW, rate });
    ok(r.ok && f.sent.length === 1 && kinds[0] === "move", `${network}: a move with no fee is sent as before`);
  }

  // The route says so plainly.
  const fee = env.STARKNET_RELAY_FEE;
  delete env.STARKNET_RELAY_FEE;
  const make = server.starknetRelayChains.make;
  f = fakeChain();
  server.starknetRelayChains.make = () => f.chain;
  resetMemoryKv();
  const res = await relayRoute.POST(post("/api/starknet/relay", { calls: [{ ...cashOut, calldata: (cashOut.calldata as string[]).map((x) => num.toHex(BigInt(x))) }], proof: PROOF }, { "x-forwarded-for": "198.51.100.120" }));
  const body = (await res.json()) as { error?: { code: string; message: string } };
  eq([res.status, body.error?.code, f.sent.length], [503, "fee_unset", 0], "the relay route refuses it, 503 fee_unset");
  ok(/isn't set to send private moves on Starknet yet/.test(body.error?.message ?? ""), "with a message that says why");
  server.starknetRelayChains.make = make;
  env.STARKNET_RELAY_FEE = fee;
}

/* ------------------------------------------------------------------ mainnet: what a day of opens and moves can cost */
{
  eq(server.relayCaps("mainnet", {}), { opensPerIpPerDay: 5, opensPerDay: 20, appliesPerDay: 200, sponsoredPerDay: 0 }, "mainnet: 20 opens a day (5 per IP), 200 moves, none sponsored");
  eq(server.relayCaps("devnet", {}), { opensPerIpPerDay: 5, opensPerDay: 300, appliesPerDay: 5_000, sponsoredPerDay: 0 }, "elsewhere, as before");
  eq(server.relayCaps("sepolia", { STARKNET_SPONSORED_MOVES_PER_DAY: "9" }).sponsoredPerDay, 0, "a sponsored budget is mainnet only");
  eq(
    server.relayCaps("mainnet", { STARKNET_OPENS_PER_DAY: "3", STARKNET_OPENS_PER_IP_PER_DAY: "1", STARKNET_APPLIES_PER_DAY: "50", STARKNET_SPONSORED_MOVES_PER_DAY: "4" }),
    { opensPerIpPerDay: 1, opensPerDay: 3, appliesPerDay: 50, sponsoredPerDay: 4 },
    "each from the environment"
  );
  eq(server.relayCaps("mainnet", { STARKNET_OPENS_PER_DAY: "lots", STARKNET_APPLIES_PER_DAY: "-1" }), { opensPerIpPerDay: 5, opensPerDay: 20, appliesPerDay: 200, sponsoredPerDay: 0 }, "a value that isn't a whole number keeps the default");

  const opens: string[] = [];
  const d1 = Date.UTC(2035, 1, 1, 12);
  for (let i = 0; i < 21; i++) opens.push(await server.starknetRelayRate(post("/api/starknet/relay", {}, { "x-forwarded-for": `192.0.2.${i + 1}` }), "open", d1, "mainnet", {}));
  ok(opens.slice(0, 20).every((x) => x === "ok") && opens[20] === "day_used", "21 opens from 21 IPs: the 21st waits for tomorrow");
  const few: string[] = [];
  for (let i = 0; i < 3; i++) few.push(await server.starknetRelayRate(post("/api/starknet/relay", {}, { "x-forwarded-for": "192.0.2.200" }), "open", d1 + 86_400_000, "mainnet", { STARKNET_OPENS_PER_IP_PER_DAY: "2" }));
  eq(few, ["ok", "ok", "limited"], "STARKNET_OPENS_PER_IP_PER_DAY holds one IP");

  // 200 moves a day for everyone, even spread over the day (the per-minute caps never bite here).
  const d2 = Date.UTC(2035, 2, 1, 0, 0, 30);
  const moves: string[] = [];
  for (let i = 0; i < 201; i++) moves.push(await server.starknetRelayRate(post("/api/starknet/relay", {}, { "x-forwarded-for": `198.18.${Math.floor(i / 200)}.${(i % 200) + 1}` }), "move", d2 + i * 60_000, "mainnet", {}));
  ok(moves.slice(0, 200).every((x) => x === "ok") && moves[200] === "day_used", "the 201st move of the day is refused");
  const set: string[] = [];
  for (let i = 0; i < 4; i++) set.push(await server.starknetRelayRate(post("/api/starknet/relay", {}, { "x-forwarded-for": `198.19.0.${i + 1}` }), "move", d2 + 86_400_000 + i * 60_000, "mainnet", { STARKNET_APPLIES_PER_DAY: "3" }));
  eq(set, ["ok", "ok", "ok", "day_used"], "STARKNET_APPLIES_PER_DAY sets it");
  const approves: string[] = [];
  for (let i = 0; i < 4; i++) approves.push(await server.starknetRelayRate(post("/api/starknet/relay", {}, { "x-forwarded-for": `198.19.1.${i + 1}` }), "approve", d2 + 86_400_000 + i * 60_000, "mainnet", { STARKNET_APPLIES_PER_DAY: "3" }));
  ok(approves.every((x) => x === "ok"), "approves aren't moves: they cost gas only and don't count against it");
}

/* ------------------------------------------------------------------ the relay route */
{
  const f = fakeChain();
  const make = server.starknetRelayChains.make;
  server.starknetRelayChains.make = () => f.chain;
  let res = await relayRoute.POST(post("/api/starknet/relay", { calls: [account.deployAccountCall(pub)] }));
  let body = (await res.json()) as { ok: boolean; txHash?: string; kind?: string };
  eq([res.status, body.ok, body.kind, body.txHash], [200, true, "deploy", "0xabc"], "the route sends an account deploy");
  res = await relayRoute.POST(post("/api/starknet/relay", { calls: [account.deployAccountCall(pub), account.deployAccountCall(pub)] }));
  eq(res.status, 400, "two calls are refused");
  res = await relayRoute.POST(post("/api/starknet/relay", { calls: [{ contractAddress: config.STARKNET_UDC, entrypoint: "deploy_contract", calldata: ["hello"] }] }));
  eq(res.status, 400, "calldata that isn't a number is refused");
  res = await relayRoute.POST(post("/api/starknet/relay", { calls: [account.deployAccountCall(pub)], proof: { proofFacts: ["zz"], proof: "QUJD" } }));
  eq(res.status, 400, "a proof fact that isn't hex is refused");
  res = await relayRoute.POST(post("/api/starknet/relay", "not json"));
  eq(res.status, 400, "a body that isn't JSON is refused");
  res = await relayRoute.POST(post("/api/starknet/relay", { calls: [{ contractAddress: "0x5", entrypoint: "transfer", calldata: ["0x1"] }] }));
  body = (await res.json()) as never;
  eq(res.status, 422, "a call outside the rules is refused");
  res = await relayRoute.POST(post("/api/starknet/relay", { calls: [account.deployAccountCall(pub)] }, { "sec-fetch-site": "cross-site" }));
  eq(res.status, 403, "another site is refused");
  // The per-minute tries, held on one clock minute.
  const at = Date.UTC(2031, 0, 1, 0, 0, 5);
  server.starknetRelayClock.now = () => at;
  const statuses: number[] = [];
  for (let i = 0; i < 32; i++) statuses.push((await relayRoute.POST(post("/api/starknet/relay", { calls: [{ contractAddress: "0x5", entrypoint: "transfer", calldata: ["0x1"] }] }, { "x-forwarded-for": "198.51.100.9" }))).status);
  server.starknetRelayClock.now = () => Date.now();
  ok(statuses.slice(0, 30).every((s) => s === 422) && statuses.slice(30).every((s) => s === 429), "after 30 tries a minute, one IP gets 429 before any check");
  server.starknetRelayChains.make = make;

  const get = (await (await relayRoute.GET(info())).json()) as { on: boolean; funded: boolean; moves: string; relayer: string; network: string; pool: string; fee: Record<string, string> };
  eq([get.on, get.funded, get.relayer, get.network, get.pool], [true, true, RELAY, "mainnet", POOL], "GET: on, funded (50 STRK, over the 30 STRK line), its address, the network and the pool");
  eq(get.fee[num.toHex(BigInt(USDC))], "10000", "GET: the fee per token");
  eq(get.moves, "on", "GET: moves on (a fee is set)");
  ok(!JSON.stringify(get).includes(SECRET.slice(2)), "GET never shows the key");
}

/* ------------------------------------------------------------------ the relay's GET: a light limit, its STRK read once per 20 s, moves on or off */
{
  type Info = { ok: boolean; funded?: boolean; moves?: string; error?: { code: string } };
  const at = Date.UTC(2032, 0, 1, 0, 0, 0);
  const strkReads = () => seen.filter((x) => x.url === NODE && [x.body].flat().some((c) => (c as { method?: string } | null)?.method === "starknet_call")).length;
  const read = async (ms: number, ip = "198.51.100.40") => {
    server.starknetRelayClock.now = () => at + ms;
    const res = await relayRoute.GET(info(ip));
    return { status: res.status, body: (await res.json()) as Info, retry: res.headers.get("retry-after") };
  };
  try {
    const start = strkReads();
    let r = await read(0);
    eq([r.status, r.body.funded, strkReads() - start], [200, true, 1], "GET reads the relay's STRK once");
    for (let i = 1; i <= 9; i++) r = await read(i * 1_000, `198.51.100.${40 + i}`);
    eq(strkReads() - start, 1, "ten GETs within 20 seconds, from ten IPs: still one read of the node");
    r = await read(server.RELAY_STRK_CACHE_MS + 1);
    eq([r.body.funded, strkReads() - start], [true, 2], "after 20 seconds it reads again");
    const both = await Promise.all([read(2 * server.RELAY_STRK_CACHE_MS + 2, "198.51.100.60"), read(2 * server.RELAY_STRK_CACHE_MS + 2, "198.51.100.61")]);
    eq([both.every((x) => x.body.funded === true), strkReads() - start], [true, 3], "two GETs at the same moment share one read");
    nodeDown = true;
    r = await read(3 * server.RELAY_STRK_CACHE_MS + 10);
    eq([r.status, r.body.funded, strkReads() - start], [200, false, 4], "a node that doesn't answer: not funded");
    r = await read(3 * server.RELAY_STRK_CACHE_MS + 2_010);
    eq(strkReads() - start, 4, "and it isn't asked again by every caller");
    nodeDown = false;
    r = await read(3 * server.RELAY_STRK_CACHE_MS + server.RELAY_STRK_MISS_MS + 11);
    eq([r.body.funded, strkReads() - start], [true, 5], "five seconds after a failed read it asks again");

    // 60 a minute per IP, counted in memory (no Redis call), then 429.
    const minute = at + 10 * 60_000;
    const statuses: number[] = [];
    for (let i = 0; i < server.STARKNET_RELAY_INFO_PER_IP_PER_MIN + 1; i++) {
      server.starknetRelayClock.now = () => minute + i * 100;
      statuses.push((await relayRoute.GET(info("198.51.100.70"))).status);
    }
    ok(statuses.slice(0, 60).every((s) => s === 200) && statuses[60] === 429, "one IP: 60 GETs a minute, then 429");
    r = await read(10 * 60_000 + 7_000, "198.51.100.70");
    eq([r.status, r.body.error?.code, Number(r.retry) > 0], [429, "rate_limited", true], "with Retry-After and a plain code");
    eq((await read(10 * 60_000 + 7_000, "198.51.100.71")).status, 200, "another IP is not held");
    eq((await read(11 * 60_000, "198.51.100.70")).status, 200, "the next minute it answers again");

    // Moves "off" on mainnet with no fee and no sponsored budget, exactly when relaySend says fee_unset.
    const fee = env.STARKNET_RELAY_FEE;
    delete env.STARKNET_RELAY_FEE;
    eq((await read(12 * 60_000, "198.51.100.72")).body.moves, "off", "GET: no relay fee and no sponsored budget on mainnet: moves off");
    env.STARKNET_SPONSORED_MOVES_PER_DAY = "3";
    eq((await read(12 * 60_000, "198.51.100.73")).body.moves, "on", "a sponsored budget: moves on");
    delete env.STARKNET_SPONSORED_MOVES_PER_DAY;
    env.STARKNET_RELAY_FEE = "0";
    eq((await read(12 * 60_000, "198.51.100.74")).body.moves, "off", "a fee of 0 is no fee");
    env.STARKNET_RELAY_FEE = fee;
    eq((await read(12 * 60_000, "198.51.100.75")).body.moves, "on", "the fee back: moves on");
    const noFee = { ...env, STARKNET_RELAY_FEE: undefined };
    eq(server.relayMoves(cfg, noFee), "off", "relayMoves: mainnet, no fee");
    eq(server.relayMoves(cfg, { ...noFee, STARKNET_SPONSORED_MOVES_PER_DAY: "1" }), "on", "relayMoves: a sponsored budget");
    eq([server.relayMoves({ ...cfg, network: "sepolia" }, noFee), server.relayMoves({ ...cfg, network: "devnet" }, noFee)], ["on", "on"], "relayMoves: Sepolia and devnet send moves with no fee");
    const cashOut = applyCall([to("0x0126", 250_000)]);
    const off = await relaySend({ calls: [cashOut], proof: PROOF, cfg, relay: RELAY, chain: fakeChain().chain, env: noFee, now: NOW, rate: okRate });
    ok(!off.ok && off.code === "fee_unset", "and relaySend refuses the move GET called off");
  } finally {
    nodeDown = false;
    server.starknetRelayClock.now = () => Date.now();
  }
}

/* ------------------------------------------------------------------ the prover */
const TX = { type: "INVOKE", version: "0x3", sender_address: POOL, calldata: ["0x1"], signature: ["0x1", "0x2"], nonce: "0x7" };
const RESULT = { proof: "UFJPT0Y=", proof_facts: ["0xa", "0xb"], l2_to_l1_messages: [{ from_address: POOL, to_address: "0x0", payload: ["0xc1a55", "0x5", "0x6"] }] };
{
  let res = await proveRoute.POST(post("/api/starknet/prove", { jsonrpc: "2.0", id: 1, method: "starknet_call", params: [] }));
  eq(((await res.json()) as { error: { code: number } }).error.code, -32601, "only the prover's methods pass");
  res = await proveRoute.POST(post("/api/starknet/prove", { jsonrpc: "2.0", id: 2, method: "starknet_specVersion", params: [] }));
  eq(((await res.json()) as { result: string }).result, "0.10.0", "specVersion answers");
  res = await proveRoute.POST(post("/api/starknet/prove", { jsonrpc: "2.0", id: 3, method: "starknet_proveTransaction", params: { block_id: { block_number: 100 }, transaction: TX } }, { "sec-fetch-site": "cross-site" }));
  eq(res.status, 403, "another site is refused");

  const keys: string[] = [];
  let polls = 0;
  starkscan = (url, init) => {
    const h = new Headers(init.headers);
    eq(h.get("X-Starkscan-Api-Key"), "selftest-starkscan-key", "Starkscan gets the key, in its header");
    if ((init.method ?? "GET") === "POST") {
      keys.push(h.get("Idempotency-Key") ?? "");
      const b = JSON.parse(String(init.body)) as { block_id: unknown; transaction: unknown };
      eq(b.block_id, { block_number: 100 }, "the block to prove at goes as is");
      return new Response(JSON.stringify({ jobId: "job_1", status: "queued", terminal: false, pollAfterSeconds: 0.001 }), { status: 202 });
    }
    polls++;
    eq(url, `${STARKSCAN}/job_1`, "then it polls the job");
    return new Response(JSON.stringify(polls < 2 ? { jobId: "job_1", status: "dispatched", pollAfterSeconds: 0.001 } : { jobId: "job_1", status: "succeeded", terminal: true, result: RESULT }), { status: 200 });
  };
  const call = { jsonrpc: "2.0", id: 4, method: "starknet_proveTransaction", params: { block_id: { block_number: 100 }, transaction: TX } };
  res = await proveRoute.POST(post("/api/starknet/prove", call));
  eq(((await res.json()) as { result: unknown }).result, RESULT, "mainnet proves through Starkscan, answered in the proving service's shape");
  polls = 0;
  await proveRoute.POST(post("/api/starknet/prove", call));
  ok(/^gloam-[0-9a-f]{48}-r0$/.test(keys[0]!) && keys[0] === keys[1], "the same request carries the same Idempotency-Key");

  // Only the pool's own proof invocations spend Gloam's proof quota.
  starkscan = () => {
    throw new Error("Starkscan must not be called");
  };
  res = await proveRoute.POST(post("/api/starknet/prove", { ...call, params: { ...call.params, transaction: { ...TX, sender_address: "0x5" } } }));
  eq(((await res.json()) as { error: { code: number } }).error.code, -32602, "a transaction from anyone but the pool is refused before Starkscan");

  // Today's quota used up: a plain busy answer the SDK does not retry (only -32005 is retried).
  let posts = 0;
  starkscan = () => {
    posts++;
    return new Response(JSON.stringify({ error: { code: "prover_daily_budget_exhausted", message: "Out of proofs for this UTC day" } }), { status: 429, headers: { "Retry-After": "3600" } });
  };
  res = await proveRoute.POST(post("/api/starknet/prove", call));
  let e = ((await res.json()) as { error: { code: number; message: string } }).error;
  eq([e.code, e.message, posts], [-32603, "Starknet is busy. Try again later.", 1], "quota used up: one request, a plain busy message, not retried");
  // Starkscan's API puts an HTTP error's code at the top of its envelope ({ code, message, docSlug, requestId },
  // read from api.starkscan.co on 2026-11-27), not under `error`. Read that way, the quota looked like a busy
  // prover: -32005, which the SDK retries four times, then "The prover is busy".
  posts = 0;
  starkscan = () => {
    posts++;
    return new Response(JSON.stringify({ code: "prover_daily_budget_exhausted", message: "Daily prover budget exhausted", docSlug: "api/strk20-prover", requestId: "r1" }), { status: 429, headers: { "Retry-After": "3600" } });
  };
  res = await proveRoute.POST(post("/api/starknet/prove", call));
  e = ((await res.json()) as { error: { code: number; message: string } }).error;
  eq([e.code, e.message, posts], [-32603, "Starknet is busy. Try again later.", 1], "quota used up, in Starkscan's own envelope: the same plain busy answer, not retried");

  // New proofs are counted, not requests: each new Starkscan key is one proof of the key's day (10 by
  // default). The request limits (10 a minute, 300 a day per IP) sat far above that, so one caller could
  // spend the whole day in a minute.
  {
    const day = Date.UTC(2034, 0, 1, 12);
    server.starknetRelayClock.now = () => day;
    let newJobs = 0;
    starkscan = (url, init) => {
      if ((init.method ?? "GET") === "POST") {
        newJobs++;
        return new Response(JSON.stringify({ jobId: "job_9", status: "succeeded", terminal: true, result: RESULT }), { status: 200 });
      }
      return new Response(JSON.stringify({ jobId: "job_9", status: "succeeded", terminal: true, result: RESULT }), { status: 200 });
    };
    const at = (block: number, ip: string) =>
      proveRoute.POST(post("/api/starknet/prove", { ...call, params: { ...call.params, block_id: { block_number: block } } }, { "x-forwarded-for": ip }));
    const got: (number | string)[] = [];
    for (let b = 300; b < 306; b++) {
      const rr = await at(b, "198.51.100.40");
      const j = (await rr.json()) as { result?: unknown; error?: { code: number } };
      got.push(j.result ? "proved" : rr.status);
    }
    eq([got, newJobs], [["proved", "proved", "proved", "proved", "proved", 429], 5], "one IP: five new proofs a day, the sixth refused (429, not retried) before Starkscan");
    newJobs = 0;
    const rr = await at(300, "198.51.100.40");
    ok(((await rr.json()) as { result?: unknown }).result !== undefined, "the same request again is the same Starkscan job: still answered");
    env.STARKSCAN_DAILY_PROOFS = "7";
    const more: (number | string)[] = [];
    for (const [b, ip] of [[400, "198.51.100.41"], [401, "198.51.100.42"], [402, "198.51.100.43"]] as const) {
      const r3 = await at(b, ip);
      const j = (await r3.json()) as { result?: unknown; error?: { code: number; message: string } };
      more.push(j.result ? "proved" : `${j.error?.code} ${j.error?.message}`);
    }
    eq(more, ["proved", "proved", "-32603 Starknet is busy. Try again later."], "Gloam's day of proofs used (7 set here): the route says busy itself, without asking Starkscan");
    delete env.STARKSCAN_DAILY_PROOFS;
    server.starknetRelayClock.now = () => Date.now();
  }


  // A failed job passes the prover's own code on (10000: screening refused the deposit).
  starkscan = (url, init) =>
    (init.method ?? "GET") === "POST"
      ? new Response(JSON.stringify({ jobId: "job_2", status: "queued", pollAfterSeconds: 0.001 }), { status: 202 })
      : new Response(JSON.stringify({ jobId: "job_2", status: "failed", terminal: true, error: { source: "prover", code: 10000, message: "Transaction rejected", data: "screening_blocked" } }), { status: 200 });
  res = await proveRoute.POST(post("/api/starknet/prove", { ...call, params: { ...call.params, block_id: { block_number: 101 } } }));
  e = ((await res.json()) as { error: { code: number; message: string; data?: unknown } }).error as never;
  eq([(e as { code: number }).code, (e as { data?: unknown }).data], [10000, "screening_blocked"], "a screening refusal keeps its code and reason for the SDK");

  starkscan = () => new Response(JSON.stringify({ error: { message: "no prove scope" } }), { status: 403 });
  res = await proveRoute.POST(post("/api/starknet/prove", call));
  const err = ((await res.json()) as { error: { message: string } }).error;
  ok(/can't prove yet/.test(err.message), "a key without prove scope says so plainly");

  env.STARKNET_PROVER_URL = "https://prover.selftest/rpc";
  seen.length = 0;
  res = await proveRoute.POST(post("/api/starknet/prove", call));
  eq(((await res.json()) as { result: { proof: string } }).result.proof, "QUJD", "a prover URL is passed on as is");
  eq((seen.at(-1)?.body as { method: string }).method, "starknet_proveTransaction", "with the same method");
  delete env.STARKNET_PROVER_URL;
}

/* ------------------------------------------------------------------ Starkscan's adapter */
{
  const opts = (f: (url: string, init: RequestInit) => Response, timeoutMs = 2_000) => ({
    url: STARKSCAN,
    apiKey: "k",
    timeoutMs,
    sleep: async () => {},
    fetch: (async (u: string, i: RequestInit) => f(u, i)) as unknown as typeof fetch,
  });
  const job = (status: string, extra: object = {}) => new Response(JSON.stringify({ jobId: "j", status, pollAfterSeconds: 1, ...extra }), { status: 200 });
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return "resolved";
    } catch (e) {
      return e instanceof scan.StarkscanProveError ? e.code : "other";
    }
  };
  eq(await code(scan.starkscanProve(opts(() => new Response("{}", { status: 404 })), 1, TX)), "relay_off", "404: the relay is off");
  eq(await code(scan.starkscanProve(opts((u, i) => (i.method === "POST" ? job("queued") : job("failed", { error: { message: "INVALID_SIGNATURE" } }))), 1, TX)), "failed", "a failed job fails");
  eq(await code(scan.starkscanProve(opts((u, i) => (i.method === "POST" ? job("queued") : job("unknown_delivery"))), 1, TX)), "lost", "a lost answer says so");
  eq(await code(scan.starkscanProve(opts((u, i) => (i.method === "POST" ? job("queued") : job("unavailable"))), 1, TX)), "unavailable", "a busy prover says so");
  eq(await code(scan.starkscanProve(opts(() => job("queued"), 1), 1, TX)), "timeout", "a job that never finishes times out");
  eq(await code(scan.starkscanProve(opts((u, i) => (i.method === "POST" ? job("queued") : job("succeeded", { result: { proof: 5 } }))), 1, TX)), "bad_answer", "a proof that can't be read is refused");
  eq(await code(scan.starkscanProve({ ...opts(() => job("queued")), apiKey: "" }, 1, TX)), "no_key", "no key, no request");
  eq(await code(scan.starkscanProve(opts(() => new Response(JSON.stringify({ error: { code: "prover_key_concurrency" } }), { status: 429 })), 1, TX)), "unavailable", "too many proofs at once: busy, so the SDK retries");
  eq(await code(scan.starkscanProve(opts(() => new Response(JSON.stringify({ error: { code: "prover_daily_budget_exhausted" } }), { status: 429 })), 1, TX)), "quota", "the day's quota used up says so");
  eq(await code(scan.starkscanProve(opts(() => new Response(JSON.stringify({ code: "prover_daily_budget_exhausted", message: "Daily prover budget exhausted" }), { status: 429 })), 1, TX)), "quota", "and in Starkscan's own envelope (the code at the top)");
  eq(await code(scan.starkscanProve(opts(() => new Response(JSON.stringify({ code: "prover_key_concurrency" }), { status: 429 })), 1, TX)), "unavailable", "too many at once in that envelope: still busy, retried");
  let asked = 0;
  eq(await code(scan.starkscanProve({ ...opts(() => (asked++, job("queued"))), admit: async () => "quota" }, 1, TX)), "quota", "a key the route won't admit is never sent");
  eq(asked, 0, "Starkscan was never asked");
  const failed = await scan.starkscanProve(opts((u, i) => (i.method === "POST" ? job("queued") : job("failed", { error: { code: 55, message: "Account validation failed" } }))), 1, TX).catch((x: unknown) => x as InstanceType<typeof scan.StarkscanProveError>);
  eq((failed as InstanceType<typeof scan.StarkscanProveError>).prover, { code: 55 }, "a failed job carries the prover's own code");

  // A result Starkscan already handed over can't come back: the next round proves again under a new key.
  const rounds = scan.memoryRounds();
  const idems: string[] = [];
  let given = false;
  const again = await scan.starkscanProve(
    {
      ...opts((u, i) => {
        if (i.method === "POST") {
          const k = new Headers(i.headers).get("Idempotency-Key") ?? "";
          idems.push(k);
          // The first round's job already gave its result away.
          if (k.endsWith("-r0")) return job("succeeded", { terminal: true, resultUnavailableReason: "delivered_or_expired" });
          return job("queued");
        }
        given = true;
        return job("succeeded", { terminal: true, result: RESULT });
      }),
      rounds,
    },
    1,
    TX
  );
  eq(again, RESULT, "a new round proves again");
  ok(given && idems.length === 2 && idems[0]!.endsWith("-r0") && idems[1]!.endsWith("-r1") && idems[0]!.slice(0, -3) === idems[1]!.slice(0, -3), "under the same body's key, next round");

  // The answer is cut to what the SDK reads; a deposit's attestation is kept.
  const SIG = { issued_at: 1_795_000_000, sig_r: "0x1", sig_s: "0x2" };
  eq(scan.asResult({ ...RESULT, extra: 1, additional_data: { signature: { ...SIG, more: true } } }), { ...RESULT, additional_data: { signature: SIG } }, "extra fields dropped, the attestation kept");
  eq(scan.asResult({ ...RESULT, additional_data: { signature: { issued_at: "soon", sig_r: "0x1", sig_s: "0x2" } } }), null, "a malformed attestation is refused");
  eq(scan.asResult({ ...RESULT, l2_to_l1_messages: [{ from_address: POOL, payload: [] }] }), null, "a message with no to_address is refused");

  const provider = new scan.StarkscanProofProvider(
    opts((u, i) => (i.method === "POST" ? job("queued") : job("succeeded", { result: RESULT }))),
    config.STARKNET_CHAIN_IDS.mainnet as never,
    { nodeUrl: NODE, poolAddress: POOL }
  );
  const proof = await provider.prove(TX as never, 100);
  eq([proof.data, proof.proofFacts, proof.output], [RESULT.proof, RESULT.proof_facts, RESULT.l2_to_l1_messages[0]!.payload], "as the SDK's prover: the proof, its facts and the pool's message");
  const details = (await provider.getDefaultDetails()) as { nonce?: bigint };
  eq(details.nonce, 7n, "its details carry the pool's nonce, read from the node");
}

/* ------------------------------------------------------------------ discovery through Gloam (OHTTP relay) */
{
  const sealed = new Uint8Array([1, 2, 3, 250, 0, 7]);
  const answer = new Uint8Array([9, 8, 7]);
  let got: { url: string; type: string | null; body: Uint8Array; headers: Record<string, string> } | null = null;
  discovery = (url, init) => {
    const h = Object.fromEntries(new Headers(init.headers).entries());
    got = { url, type: h["content-type"] ?? null, body: new Uint8Array(init.body as Uint8Array), headers: h };
    return new Response(answer, { headers: { "content-type": "message/ohttp-res" } });
  };
  const ohttp = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request("https://www.gloam.trade/api/starknet/discovery", {
      method: "POST",
      headers: { "content-type": "message/ohttp-req", "sec-fetch-site": "same-origin", "x-forwarded-for": "203.0.113.7", cookie: "a=b", ...headers },
      body,
    });
  let res = await discoveryRoute.POST(ohttp(sealed));
  eq([res.status, res.headers.get("content-type")], [200, "message/ohttp-res"], "a sealed request is relayed and its sealed answer comes back");
  eq(Array.from(new Uint8Array(await res.arrayBuffer())), Array.from(answer), "byte for byte");
  const g = got as unknown as { url: string; type: string | null; body: Uint8Array; headers: Record<string, string> };
  eq([g.url, g.type, Array.from(g.body)], [DISCOVERY, "message/ohttp-req", Array.from(sealed)], "the service gets the sealed bytes as they came");
  ok(!("x-forwarded-for" in g.headers) && !("cookie" in g.headers), "and nothing about who asked");
  res = await discoveryRoute.POST(ohttp(sealed, { "content-type": "application/json" }));
  eq(res.status, 415, "only sealed requests pass");
  res = await discoveryRoute.POST(ohttp(sealed, { "sec-fetch-site": "cross-site" }));
  eq(res.status, 403, "another site is refused");
  res = await discoveryRoute.POST(ohttp(new Uint8Array(proxy.STARKNET_DISCOVERY_MAX_BODY + 1)));
  eq(res.status, 413, "a body over the cap is refused");
  eq(discoveryRoute.GET().status, 405, "GET is not a discovery request");

  const keyBytes = new Uint8Array([0, 41, 1, 0, 32]);
  discovery = (url) => (url === `${DISCOVERY}/ohttp-keys` ? new Response(keyBytes, { headers: { "content-type": "application/ohttp-keys" } }) : new Response("no", { status: 404 }));
  res = await keysRoute.GET();
  eq([res.status, res.headers.get("content-type"), Array.from(new Uint8Array(await res.arrayBuffer()))], [200, "application/ohttp-keys", Array.from(keyBytes)], "the service's key config comes through Gloam");
  discovery = () => new Response("<html>", { headers: { "content-type": "text/html" } });
  res = await keysRoute.GET();
  eq(res.status, 502, "anything but a key config is refused");
}

/* ------------------------------------------------------------------ a real outside execution passes end to end */
{
  // Signed by a real key, built the way the page builds it (Account.getOutsideTransaction is
  // what lib/starknetPrivacy/session calls; here its output shape, by outsideExecution).
  const call = outsideExecution.buildExecuteFromOutsideCall({
    outsideExecution: { caller: RELAY, nonce: "0x1", execute_after: NOW / 1000 - 60, execute_before: NOW / 1000 + 600, calls: [{ to: USDC, selector: hash.getSelectorFromName("approve"), calldata: [POOL, "0xf4240", "0x0"] }] },
    signature: ["0x1", "0x2"],
    signerAddress: acct,
    version: "2" as never,
  } as never);
  const d = policy.checkRelayCall(call, server.relayContext(cfg, RELAY, env, NOW));
  ok(d.ok && d.kind === "approve" && d.amount === 1_000_000n, "an outside execution built by starknet.js passes as an approve");
}

/* ------------------------------------------------------------------ the browser gets the pool */
{
  // Next puts a NEXT_PUBLIC_ value into the browser only where it is written out in full;
  // process.env as a whole is empty there (the pool read as unset on 2026-11-25's devnet run).
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/starknetPrivacy/config.ts", import.meta.url), "utf8");
  ok(/env: Env = starknetEnv\(\)/.test(src) && !/env: Env = process\.env/.test(src), "the config's default environment names each variable");
  for (const k of ["NEXT_PUBLIC_STARKNET_POOL", "NEXT_PUBLIC_STARKNET_USDC", "NEXT_PUBLIC_STARKNET_DEVNET_RPC"])
    ok(src.includes(`${k}: process.env.${k}`), `${k} is read in full`);
  eq(config.starknetEnv().NEXT_PUBLIC_STARKNET_POOL, POOL, "and reads the pool");
}

/* ------------------------------------------------------------------ proofs per IP a day */
{
  eq(server.starkscanProofsPerIp({}), 5, "one IP starts 5 new proofs a day by default");
  eq(server.starkscanProofsPerIp({ STARKSCAN_PROOFS_PER_IP_PER_DAY: "20", STARKSCAN_DAILY_PROOFS: "30" }), 20, "STARKSCAN_PROOFS_PER_IP_PER_DAY raises it");
  eq(server.starkscanProofsPerIp({ STARKSCAN_PROOFS_PER_IP_PER_DAY: "50", STARKSCAN_DAILY_PROOFS: "30" }), 30, "never above the key's day");
  eq(server.starkscanProofsPerIp({ STARKSCAN_PROOFS_PER_IP_PER_DAY: "0" }), 5, "zero or junk keeps the default");
  eq(server.starkscanProofsPerIp({ STARKSCAN_PROOFS_PER_IP_PER_DAY: "x" }), 5, "junk keeps the default");
}

globalThis.fetch = realFetch;
console.log(`selftest-starknet-routes: ${pass} checks passed`);
