/**
 * Self-test: what the Starknet RPC proxy's limits cost in Upstash commands
 * (lib/starknetPrivacy/server starknetProxyRate, on lib/mcpRemote/rateLimit
 * hitBatchedCount), measured against the code it replaced (two addRateCount
 * calls per read: INCRBY and EXPIRE per IP, and again for everyone), with a
 * fake Upstash that counts every command.
 *
 *  - commands per read, before and after: a normal two minutes of reads (50
 *    IPs on 3 instances), everyone at the 20,000 a minute cap (4 instances),
 *    and one IP far over its 600 a minute
 *  - the limits still hold: one IP on one instance gets exactly 600 calls a
 *    minute; on several instances at most `slack` more per instance; everyone
 *    at most 20,000 plus `slack` per instance; the next minute starts afresh
 *  - the counts are the same Redis keys as before (readRateLimit reads them),
 *    with no IP in the clear
 *  - Redis down: nothing throws, each instance still holds an IP to its limit,
 *    and a down Redis is asked once per batch, not per read
 *  - the route itself (/api/starknet/rpc): reads pass with a fraction of the
 *    commands, and an IP over its limit gets 429
 *
 * fetch is stubbed (Upstash and the node); nothing leaves this process.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-starknet-proxy-rate.mts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Module from "node:module";
import { fileURLToPath } from "node:url";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const NODE = "https://node.selftest/rpc";
const env = process.env as Record<string, string | undefined>;
for (const k of Object.keys(env)) if (k.startsWith("NEXT_PUBLIC_STARKNET_") || k.startsWith("STARKNET_") || k.startsWith("GLOAM_STARKNET_")) delete env[k];
env.NODE_ENV = "test";
delete env.VERCEL;
env.GLOAM_RATE_LIMIT_KEY = randomBytes(32).toString("hex");
env.UPSTASH_REDIS_REST_URL = "https://redis.test";
env.UPSTASH_REDIS_REST_TOKEN = "test-token";
env.NEXT_PUBLIC_STARKNET_ENABLED = "1";
env.NEXT_PUBLIC_STARKNET_NETWORK = "mainnet";
env.NEXT_PUBLIC_STARKNET_POOL = "0x707b48deabbccebce6e3e0af4d9d232fb860e95bffe7efa66ac250b9e28acff";
env.STARKNET_RPC_URL = NODE;

let pass = 0;
const ok = (c: unknown, msg: string) => {
  assert.ok(c, msg);
  pass++;
};
const eq = <T,>(a: T, b: T, msg: string) => {
  assert.deepEqual(a, b, msg);
  pass++;
};

/* ------------------------------------------------------------------ a fake Upstash that counts commands */
type Cmd = (string | number)[];
const store = new Map<string, number>();
let commands = 0;
let pipelines = 0;
let redisDown = false;
let nodeCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("https://redis.test/")) {
    pipelines++;
    const body = JSON.parse(String(init.body ?? "[]")) as Cmd[];
    commands += body.length;
    if (redisDown) return new Response("down", { status: 503 });
    return Response.json(
      body.map((c) => {
        const [op, key, arg] = [String(c[0]), String(c[1]), Number(c[2] ?? 1)];
        if (op === "INCR" || op === "INCRBY") {
          const n = (store.get(key) ?? 0) + (op === "INCR" ? 1 : arg);
          store.set(key, n);
          return { result: n };
        }
        if (op === "GET") return { result: store.has(key) ? String(store.get(key)) : null };
        if (op === "EXPIRE") return { result: 1 };
        return { error: `unknown ${op}` };
      })
    );
  }
  if (url.startsWith(NODE)) {
    const body = JSON.parse(String(init.body ?? "null")) as { id: unknown }[];
    nodeCalls += body.length;
    return Response.json(body.map((c) => ({ jsonrpc: "2.0", id: c.id, result: 1234 })));
  }
  throw new Error(`selftest-starknet-proxy-rate: no network calls allowed (${url})`);
}) as typeof fetch;

const { addRateCount, readRateLimit } = await import("../src/lib/mcpRemote/rateLimit");
const server = await import("../src/lib/starknetPrivacy/server");
const rpcRoute = await import("../src/app/api/starknet/rpc/route");

const PER_IP = server.STARKNET_PROXY_PER_IP_PER_MIN;
const ALL = server.STARKNET_PROXY_ALL_PER_MIN;
const SLACK_IP = server.STARKNET_PROXY_SYNC.perIp.slack;
const SLACK_ALL = server.STARKNET_PROXY_SYNC.all.slack;
eq([PER_IP, ALL], [600, 20_000], "the limits themselves are unchanged: 600 calls a minute per IP, 20,000 for everyone");

/* ------------------------------------------------------------------ instances: each has its own memory */
const G = globalThis as { __gloamRateBatch?: Map<string, unknown>; __gloamMcpRate?: Map<string, unknown> };
let instances: Map<string, unknown>[] = [];
function fresh(n: number) {
  store.clear();
  commands = 0;
  pipelines = 0;
  instances = Array.from({ length: n }, () => new Map());
  G.__gloamMcpRate = new Map();
}
const on = (i: number) => (G.__gloamRateBatch = instances[i % instances.length]);
const req = (ip: string) => new Request("https://www.gloam.trade/api/starknet/rpc", { method: "POST", headers: { "x-forwarded-for": ip } });

/** The proxy's limit as it was: a shared count per IP, then for everyone, each INCRBY + EXPIRE. */
async function before(ip: string, calls: number, now: number): Promise<boolean> {
  if ((await addRateCount(ip, "sn-proxy", calls, now)) > PER_IP) return false;
  return (await addRateCount("all", "sn-proxy-all", calls, now)) <= ALL;
}
async function after(ip: string, calls: number, now: number): Promise<boolean> {
  return (await server.starknetProxyRate(req(ip), calls, now)).allowed;
}

type Read = { ip: string; calls: number; now: number; instance: number };
/** Runs every read through one of the two; commands per read, calls allowed. */
async function run(reads: Read[], which: typeof before, n: number) {
  fresh(n);
  let allowed = 0;
  for (const r of reads) {
    on(r.instance);
    if (await which(r.ip, r.calls, r.now)) allowed += r.calls;
  }
  return { perRead: commands / reads.length, commands, allowed };
}

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
const T0 = Date.UTC(2031, 5, 1, 12, 0, 0);
const report: string[] = [];

/* ------------------------------------------------------------------ a normal two minutes */
{
  // 50 IPs, each a read a second (a page following its move: blocks, receipts, notes), 1 to 3 calls each, over 3 instances.
  const reads: Read[] = [];
  for (let s = 0; s < 120; s++)
    for (let i = 0; i < 50; i++) reads.push({ ip: `198.51.100.${i + 1}`, calls: [1, 1, 2, 1, 3][(s + i) % 5]!, now: T0 + s * 1000 + i * 7, instance: Math.floor(rand() * 3) });
  const b = await run(reads, before, 3);
  const a = await run(reads, after, 3);
  eq(b.perRead, 4, "before: every read cost 4 Upstash commands");
  eq(a.allowed, b.allowed, "after: the same reads pass");
  ok(a.perRead <= 0.5, `after: at most half a command per read (${a.perRead.toFixed(3)})`);
  report.push(`normal (50 IPs, 3 instances, 6,000 reads): ${b.perRead.toFixed(2)} -> ${a.perRead.toFixed(3)} commands per read (${b.commands} -> ${a.commands})`);
}

/* ------------------------------------------------------------------ everyone at the cap */
{
  // 200 IPs x 100 reads in one minute (20,000 calls, the cap), then 1,000 more, over 4 instances.
  const minute = T0 + 10 * 60_000;
  const reads: Read[] = [];
  for (let k = 0; k < 20_000; k++) reads.push({ ip: `203.0.113.${(k % 200) + 1}`, calls: 1, now: minute + Math.floor((k * 55_000) / 20_000), instance: k % 4 });
  const extra: Read[] = [];
  for (let k = 0; k < 1_000; k++) extra.push({ ip: `192.0.2.${(k % 200) + 1}`, calls: 1, now: minute + 55_000 + Math.floor(k * 4), instance: k % 4 });
  const b = await run([...reads, ...extra], before, 4);
  const a = await run([...reads, ...extra], after, 4);
  eq(b.allowed, ALL, "before: exactly 20,000 calls pass in the minute");
  ok(a.allowed >= ALL - 4 * SLACK_ALL && a.allowed <= ALL + 4 * (SLACK_ALL + 1), `after: 20,000 pass, give or take ${SLACK_ALL} per instance (${a.allowed})`);
  ok(a.commands * 10 < b.commands, `after: under a tenth of the commands (${a.commands} vs ${b.commands})`);
  report.push(`at the cap (20,000 + 1,000 reads, 4 instances): ${b.perRead.toFixed(2)} -> ${a.perRead.toFixed(3)} commands per read (${b.commands} -> ${a.commands}); calls let through ${b.allowed} -> ${a.allowed}`);
}

/* ------------------------------------------------------------------ one IP far over its limit */
{
  const minute = T0 + 20 * 60_000;
  const reads: Read[] = Array.from({ length: 3_000 }, (_, k) => ({ ip: "198.18.0.9", calls: 1, now: minute + k * 15, instance: 0 }));
  const b = await run(reads, before, 1);
  const a = await run(reads, after, 1);
  eq([b.allowed, a.allowed], [PER_IP, PER_IP], "one IP on one instance: exactly 600 calls a minute, before and after");
  ok(a.commands * 50 < b.commands, `after: refused reads cost nothing (${a.commands} vs ${b.commands} commands)`);
  report.push(`one IP over its limit (3,000 reads, 1 instance): ${b.perRead.toFixed(2)} -> ${a.perRead.toFixed(3)} commands per read (${b.commands} -> ${a.commands})`);

  const spread = await run(reads.map((r, k) => ({ ...r, instance: k % 3 })), after, 3);
  ok(spread.allowed >= PER_IP && spread.allowed <= PER_IP + 3 * (SLACK_IP + 1), `on 3 instances: at most ${SLACK_IP} more per instance (${spread.allowed})`);
  report.push(`one IP over its limit on 3 instances: ${spread.allowed} calls let through (limit ${PER_IP}, bound ${PER_IP + 3 * (SLACK_IP + 1)})`);

  // A batch of 20 calls counts as 20.
  const batched = await run(Array.from({ length: 40 }, (_, k) => ({ ip: "198.18.0.10", calls: 20, now: minute + k * 100, instance: 0 })), after, 1);
  eq(batched.allowed, PER_IP, "thirty batches of 20 calls pass, the rest are refused");

  // The next minute starts afresh, on the same instance's memory.
  fresh(1);
  on(0);
  for (let k = 0; k < PER_IP; k++) await after("198.18.0.11", 1, minute + k);
  ok(!(await after("198.18.0.11", 1, minute + 30_000)), "601st call in the minute: refused");
  ok(await after("198.18.0.11", 1, minute + 60_000), "the next minute: allowed again");
}

/* ------------------------------------------------------------------ the same keys, nothing in the clear */
{
  fresh(1);
  on(0);
  const now = T0 + 30 * 60_000;
  for (let k = 0; k < SLACK_IP; k++) await after("198.18.1.1", 1, now);
  eq(await readRateLimit("198.18.1.1", "sn-proxy", now), SLACK_IP, `after ${SLACK_IP} calls the batch is in Redis, under the key addRateCount used`);
  await addRateCount("198.18.1.1", "sn-proxy", 5, now);
  eq(await readRateLimit("198.18.1.1", "sn-proxy", now), SLACK_IP + 5, "and both write the one count (a deploy mid-minute keeps counting)");
  ok([...store.keys()].every((k) => !k.includes("198.18.1.1")), "no IP in a key");
}

/* ------------------------------------------------------------------ Redis down */
{
  fresh(1);
  on(0);
  redisDown = true;
  const now = T0 + 40 * 60_000;
  let allowed = 0;
  for (let k = 0; k < 900; k++) if (await after("198.18.2.2", 1, now + k * 10)) allowed++;
  redisDown = false;
  eq(allowed, PER_IP, "Redis down: this instance still holds the IP to 600, and nothing throws");
  ok(pipelines <= Math.ceil(PER_IP / SLACK_IP) + 8, `and asks a down Redis once per batch, not per read (${pipelines} calls for 900 reads)`);
}

/* ------------------------------------------------------------------ the route */
{
  fresh(1);
  on(0);
  const realNow = Date.now;
  const pinned = T0 + 50 * 60_000 + 1_000;
  Date.now = () => pinned;
  try {
    const call = (ip: string, n: number) =>
      rpcRoute.POST(
        new Request("https://www.gloam.trade/api/starknet/rpc", {
          method: "POST",
          headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": ip },
          body: JSON.stringify(n === 1 ? { jsonrpc: "2.0", id: 1, method: "starknet_blockNumber", params: [] } : Array.from({ length: n }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "starknet_blockNumber", params: [] }))),
        })
      );
    nodeCalls = 0;
    let fine = 0;
    for (let k = 0; k < 30; k++) if ((await call("198.18.3.3", 1)).status === 200) fine++;
    eq([fine, nodeCalls], [30, 30], "the route: 30 reads, each answered by the node");
    ok(commands <= 4, `with ${commands} Upstash commands (120 before)`);
    report.push(`route, one page's 30 reads: 120 -> ${commands} commands`);
    const statuses: number[] = [];
    for (let k = 0; k < 30; k++) statuses.push((await call("198.18.3.4", 20)).status);
    eq(statuses.filter((s) => s === 200).length, PER_IP / 20, "an IP's 600 calls a minute pass in batches of 20");
    const res = await call("198.18.3.4", 1);
    eq(res.status, 429, "the next read gets 429");
    ok(Number(res.headers.get("retry-after")) >= 1, "with Retry-After");
  } finally {
    Date.now = realNow;
  }
}

for (const line of report) console.log(`  ${line}`);
console.log(`selftest-starknet-proxy-rate: ${pass} checks passed`);
