/**
 * Self-test: which RPC each read goes to (lib/readTransport).
 *
 * Ethereum Sepolia's first RPC (publicnode) is at the chain head but keeps only
 * about 10,000 blocks; Tenderly's gateway keeps everything but trailed the head
 * by up to a few minutes on 2026-10-25, which held an Add privately on
 * "Approving…" for two minutes after the approval was mined. So the head,
 * receipts, balances and allowances read from publicnode, and only logs and
 * state older than 9,000 blocks from Tenderly. Every other network keeps one
 * RPC (Ethereum mainnet's MEV Blocker is at the head and keeps everything).
 *
 * Checked here: each network's choice, that the browser's clients (wagmi,
 * lib/rhClient) and the server's (lib/serverRpc) all read through it, Ethereum's
 * block polling, and the routing itself over two fake RPCs that record what
 * they are asked. Nothing reaches any host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-read-transport.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, custom, parseAbi, toHex, type Transport } from "viem";
import { splitReadTransport } from "@gloamtrade/sdk";

delete process.env.GLOAM_RPC_URL_11155111;
delete process.env.GLOAM_RPC_URL_1;
globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-read-transport: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const nets = await import("../src/lib/networks");
const { readTransport, BLOCK_POLL_MS } = await import("../src/lib/readTransport");
const { publicClientFor } = await import("../src/lib/rhClient");
const { serverTransport, resetRpcChecks } = await import("../src/lib/serverRpc");
const { resetRpcRest, restRpc, isResting } = await import("../src/lib/rpcList");

let n = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(
    () => {
      n++;
    },
    (e) => {
      console.error(`FAIL ${name}`);
      throw e;
    }
  );
}

const ALL: import("../src/lib/networks").NetworkKey[] = [
  "robinhood",
  "tempo",
  "base",
  "ethereum",
  "robinhood-mainnet",
  "tempo-mainnet",
  "base-mainnet",
  "ethereum-mainnet",
];

await check("Ethereum Sepolia: publicnode at the head, Tenderly for blocks older than 9,000", () => {
  const s = nets.getNetwork("ethereum");
  assert.equal(s.chain.rpcUrls.default.http[0], "https://ethereum-sepolia-rpc.publicnode.com");
  assert.equal(s.historyRpc?.url, "https://sepolia.gateway.tenderly.co");
  assert.equal(s.historyRpc?.recentBlocks, 9_000n, "under the ~10,000 blocks publicnode keeps");
  assert.equal(readTransport(s)({}).config.type, "gloamRead");
});

await check("every other network: its public RPC list alone, as before", () => {
  for (const key of ALL.filter((k) => k !== "ethereum")) {
    const net = nets.getNetwork(key);
    assert.equal(net.historyRpc, null, key);
    const t = readTransport(net)({});
    assert.equal(t.config.type, "http", key);
    assert.equal((t.value as { url?: string }).url, net.chain.rpcUrls.default.http[0], key);
  }
  // MEV Blocker is at the head and keeps old logs and state: no split on Ethereum mainnet
  assert.equal(nets.getNetwork("ethereum-mainnet").chain.rpcUrls.default.http[0], "https://rpc.mevblocker.io");
});

await check("the browser's vault client and the server's both read through the split", () => {
  const s = nets.getNetwork("ethereum");
  assert.equal(publicClientFor(s).transport.type, "gloamRead", "lib/rhClient: tree sync, notes, relay waits");
  assert.equal(serverTransport(s)({}).config.type, "gloamRead", "lib/serverRpc without a private RPC");
  assert.equal(serverTransport(s, {}, { sendOnce: true })({}).config.type, "gloamRead", "the relay's sends: fresh RPC only");
  assert.equal(publicClientFor(nets.getNetwork("base")).transport.type, "http");
});

await check("errors keep this app's viem classes through the split (the relay tells a maybe-sent send by them)", async () => {
  // fetch fails here, as a dropped connection would. The SDK has its own copy
  // of viem: an error from it would be another class than the app's own http
  // throws (Base reads through that plain http), and instanceof would fail.
  const failed = (key: "ethereum" | "base") =>
    createPublicClient({ chain: nets.getNetwork(key).chain, transport: readTransport(nets.getNetwork(key), { retryCount: 0 }) })
      .request({ method: "eth_sendRawTransaction", params: ["0x02"] })
      .then(
        () => new Error("sent"),
        (e: unknown) => e as Error
      );
  const [split, plain] = await Promise.all([failed("ethereum"), failed("base")]);
  assert.equal(split.name, "HttpRequestError");
  assert.equal(Object.getPrototypeOf(split), Object.getPrototypeOf(plain), "the same HttpRequestError class as the app's http");
});

await check("relay on Sepolia with a private RPC: a send it took and dropped is maybe_sent, never handed to the public split", async () => {
  // GLOAM_RPC_URL_11155111 set: the relay sends through fallback([private, public split]),
  // and the public side excludes raw sends. The split must carry that exclusion, or
  // fallback hands the send on and its MethodNotSupported error hides the dropped one,
  // so the relay would call it a plain RPC error and let the proof be sent again.
  const { sendFailure } = await import("../src/lib/relay/server");
  const PRIVATE = "https://private.selftest.invalid/rpc";
  const before = globalThis.fetch;
  for (const key of ["ethereum", "base"] as const) {
    const net = nets.getNetwork(key);
    const sends: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string };
      const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
      if (body.method === "eth_chainId") return reply(toHex(net.chainId));
      if (body.method === "eth_sendRawTransaction") {
        sends.push(url.startsWith(PRIVATE) ? "private" : new URL(url).host);
        if (url.startsWith(PRIVATE)) throw new TypeError("fetch failed"); // took it, then the connection dropped
        return reply(`0x${"ee".repeat(32)}`);
      }
      throw new Error(`selftest-read-transport: unexpected ${body.method} to ${url}`);
    }) as typeof fetch;
    process.env[`GLOAM_RPC_URL_${net.chainId}`] = PRIVATE;
    try {
      const t = serverTransport(net, { timeout: 30_000, retryCount: 0 }, { sendOnce: true })({ chain: net.chain });
      const err = await t.request({ method: "eth_sendRawTransaction", params: [`0x${"02".repeat(100)}`] }).then(
        () => null,
        (e: unknown) => e
      );
      assert.ok(err, `${key}: the dropped send fails`);
      assert.equal(sendFailure(err).code, "maybe_sent", `${key}: reported maybe_sent, so the proof is not sent again`);
      assert.deepEqual(sends, ["private"], `${key}: the raw send went to the private RPC only`);
    } finally {
      delete process.env[`GLOAM_RPC_URL_${net.chainId}`];
      globalThis.fetch = before;
    }
  }
  // what fallback reads to skip a transport: the split keeps the fresh RPC's exclusion
  const backup = readTransport(nets.getNetwork("ethereum"), { methods: { exclude: ["eth_sendRawTransaction"] } })({});
  assert.deepEqual(backup.config.methods, { exclude: ["eth_sendRawTransaction"] });
});

// ------------------------------------------------------------------ the real transports, fetch stubbed

const PUBLICNODE = "https://ethereum-sepolia-rpc.publicnode.com";
const TENDERLY = "https://sepolia.gateway.tenderly.co";
const HEAD_BN = 12_100_000n;
type Asked = { host: string; method: string; from?: bigint; to?: string };
async function withSepoliaRpcs(down: Set<string>, fn: (asked: Asked[]) => Promise<void>) {
  const asked: Asked[] = [];
  const before = globalThis.fetch;
  resetRpcRest();
  resetRpcChecks();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = (typeof input === "string" ? input : input instanceof URL ? input.href : input.url).replace(/\/$/, "");
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[];
    const list = Array.isArray(body) ? body : [body];
    for (const r of list) {
      const f = r.params?.[0] as { fromBlock?: string; toBlock?: string } | undefined;
      asked.push({ host: new URL(url).host.split(".")[0]!, method: r.method, ...(r.method === "eth_getLogs" ? { from: BigInt(f!.fromBlock!), to: f!.toBlock } : {}) });
    }
    if (down.has(url)) return new Response("busy", { status: 503 });
    const out = list.map((r) => {
      const result =
        r.method === "eth_chainId" ? toHex(11155111) :
        r.method === "eth_blockNumber" ? toHex(url === TENDERLY ? HEAD_BN - 8n : HEAD_BN) :
        r.method === "eth_getLogs" ? [] :
        r.method === "eth_sendRawTransaction" ? `0x${"ee".repeat(32)}` :
        null;
      return { jsonrpc: "2.0", id: r.id, result };
    });
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await fn(asked);
  } finally {
    globalThis.fetch = before;
    resetRpcRest();
    resetRpcChecks();
  }
}
const sepoliaClient = () =>
  createPublicClient({ chain: nets.getNetwork("ethereum").chain, transport: readTransport(nets.getNetwork("ethereum"), { retryCount: 0 }) });

await check("Sepolia's head side is its public list: publicnode down, the head comes from the next RPC", async () => {
  await withSepoliaRpcs(new Set([PUBLICNODE]), async (asked) => {
    const c = sepoliaClient();
    assert.equal(await c.getBlockNumber({ cacheTime: 0 }), HEAD_BN - 8n, "the list's next RPC answered");
    assert.deepEqual(asked.map((a) => `${a.host}:${a.method}`), ["ethereum-sepolia-rpc:eth_blockNumber", "sepolia:eth_blockNumber"]);
  });
});

await check("old logs go to the one history RPC, a range across the line is split, recent logs stay on the list", async () => {
  await withSepoliaRpcs(new Set(), async (asked) => {
    const c = sepoliaClient();
    await c.getBlockNumber({ cacheTime: 0 }); // places the line
    const line = HEAD_BN - 9_000n;
    asked.length = 0;
    await c.getLogs({ address: "0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef", fromBlock: 11_992_914n, toBlock: "latest" });
    const logs = asked.filter((a) => a.method === "eth_getLogs");
    assert.deepEqual(logs.map((a) => a.host).sort(), ["ethereum-sepolia-rpc", "sepolia"]);
    assert.equal(logs.find((a) => a.host === "sepolia")!.from, 11_992_914n, "Tenderly from the deploy block");
    assert.equal(logs.find((a) => a.host === "ethereum-sepolia-rpc")!.from, line, "publicnode from the line");
  });
});

await check("history is one RPC: Tenderly down, old logs fail rather than read from publicnode, which no longer has them", async () => {
  await withSepoliaRpcs(new Set([TENDERLY]), async (asked) => {
    const c = sepoliaClient();
    await c.getBlockNumber({ cacheTime: 0 });
    asked.length = 0;
    await assert.rejects(c.getLogs({ address: "0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef", fromBlock: 11_992_914n, toBlock: 11_995_000n }));
    assert.deepEqual([...new Set(asked.map((a) => a.host))], ["sepolia"], "never handed to publicnode");
  });
});

await check("the relay's sends with no private RPC: exactly one head RPC, never Tenderly", async () => {
  await withSepoliaRpcs(new Set(), async (asked) => {
    const t = serverTransport(nets.getNetwork("ethereum"), { timeout: 30_000, retryCount: 0 }, { sendOnce: true })({ chain: nets.getNetwork("ethereum").chain });
    await t.request({ method: "eth_sendRawTransaction", params: [`0x${"02".repeat(100)}`] });
    assert.deepEqual(asked.filter((a) => a.method === "eth_sendRawTransaction").map((a) => a.host), ["ethereum-sepolia-rpc"]);
  });
  await withSepoliaRpcs(new Set([PUBLICNODE]), async (asked) => {
    const t = serverTransport(nets.getNetwork("ethereum"), { timeout: 30_000, retryCount: 0 }, { sendOnce: true })({ chain: nets.getNetwork("ethereum").chain });
    await assert.rejects(t.request({ method: "eth_sendRawTransaction", params: [`0x${"02".repeat(100)}`] }));
    assert.deepEqual(asked.filter((a) => a.method === "eth_sendRawTransaction").map((a) => a.host), ["ethereum-sepolia-rpc"], "a failed send is never sent again elsewhere");
  });
});

await check("publicnode resting: sends and recent logs still never go to Tenderly, which trails the head", async () => {
  const net = nets.getNetwork("ethereum");
  // every history RPC is barred from list sends and list log reads
  for (const n of ALL.map((k) => nets.getNetwork(k))) {
    if (!n.historyRpc) continue;
    assert.ok(nets.NO_SEND_RPCS.has(n.historyRpc.url) && nets.NO_LOG_RPCS.has(n.historyRpc.url), n.key);
  }
  // a send that failed rests publicnode for 30 s; the next send still goes to it, never to Tenderly
  await withSepoliaRpcs(new Set([PUBLICNODE]), async (asked) => {
    const t = serverTransport(net, { timeout: 30_000, retryCount: 0 }, { sendOnce: true })({ chain: net.chain });
    await assert.rejects(t.request({ method: "eth_sendRawTransaction", params: [`0x${"02".repeat(100)}`] }));
    assert.ok(isResting(PUBLICNODE), "publicnode rests after failing");
    await assert.rejects(t.request({ method: "eth_sendRawTransaction", params: [`0x${"03".repeat(100)}`] }));
    assert.deepEqual(asked.filter((a) => a.method === "eth_sendRawTransaction").map((a) => a.host), ["ethereum-sepolia-rpc", "ethereum-sepolia-rpc"]);
  });
  // publicnode resting but up again: the send goes to it, and so does a recent log read; the head may come from Tenderly
  await withSepoliaRpcs(new Set(), async (asked) => {
    restRpc(PUBLICNODE);
    const t = serverTransport(net, { timeout: 30_000, retryCount: 0 }, { sendOnce: true })({ chain: net.chain });
    await t.request({ method: "eth_sendRawTransaction", params: [`0x${"04".repeat(100)}`] });
    const c = sepoliaClient();
    await c.getBlockNumber({ cacheTime: 0 });
    await c.getLogs({ address: "0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef", fromBlock: HEAD_BN - 100n, toBlock: "latest" });
    assert.deepEqual(asked.filter((a) => a.method === "eth_sendRawTransaction").map((a) => a.host), ["ethereum-sepolia-rpc"], "the send");
    assert.deepEqual(asked.filter((a) => a.method === "eth_getLogs").map((a) => a.host), ["ethereum-sepolia-rpc"], "the recent log read");
    assert.deepEqual(asked.filter((a) => a.method === "eth_blockNumber").map((a) => a.host), ["sepolia"], "a head read may go down the list");
  });
  // the browser's vault client too (wagmi and lib/rhClient read through the same list)
  await withSepoliaRpcs(new Set(), async (asked) => {
    restRpc(PUBLICNODE);
    await sepoliaClient().request({ method: "eth_sendRawTransaction", params: [`0x${"05".repeat(100)}`] });
    assert.deepEqual(asked.filter((a) => a.method === "eth_sendRawTransaction").map((a) => a.host), ["ethereum-sepolia-rpc"]);
  });
});

await check("wagmi: Sepolia through readTransport, every other chain through its list, Ethereum polled every 2 s", () => {
  const wagmi = readFileSync(new URL("../src/lib/wagmi.ts", import.meta.url), "utf8");
  assert.ok(wagmi.includes('[ethereumTestnet.id]: readTransport(getNetwork("ethereum"), { batch: { wait: 16 }, retryCount: 2 })'));
  for (const c of ["baseTestnet", "baseMainnet", "ethereumMainnet", "robinhoodTestnet", "robinhood", "tempoTestnet", "tempoMainnet"]) {
    assert.ok(new RegExp(`\\[${c}\\.id\\]: rpcListTransport\\(${c}\\.rpcUrls\\.default\\.http`).test(wagmi), c);
  }
  assert.ok(!/http\((ethereum|base)(Testnet|Mainnet)\.rpcUrls/.test(wagmi), "no chain read past its list");
  assert.ok(wagmi.includes("BLOCK_POLL_MS[c.id]") && wagmi.includes("pollingInterval"), "per-chain polling");
  assert.equal(BLOCK_POLL_MS[1], 2_000);
  assert.equal(BLOCK_POLL_MS[11155111], 2_000);
  assert.equal(BLOCK_POLL_MS[46630], undefined, "other chains keep viem's default");
  // the transparency ledger scans logs back to each deploy: it reads through the split too
  const ledger = readFileSync(new URL("../src/components/transparency/ledger.ts", import.meta.url), "utf8");
  assert.ok(ledger.includes("transport: readTransport(n,"));
});

// ------------------------------------------------------------------ routing, over fake RPCs

const HEAD = 12_100_000n; // about two weeks after the deploy
const LINE = HEAD - 9_000n;
const DEPLOY = 11_992_914n;
const POOL = "0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef" as const;
const MINED = `0x${"aa".repeat(32)}` as const; // an approval mined a block ago
const PENDING = `0x${"bb".repeat(32)}` as const;
const OLD = `0x${"cc".repeat(32)}` as const; // a payment from two weeks ago
type Filter = { fromBlock: string; toBlock?: string };
type Call = { method: string; params: unknown[] };
const filterOf = (c: Call) => c.params[0] as Filter;

function fake(name: "fresh" | "history") {
  const calls: Call[] = [];
  const receipt = (hash: string, bn: bigint) => ({
    transactionHash: hash, blockNumber: toHex(bn), blockHash: `0x${"00".repeat(32)}`, transactionIndex: "0x0",
    from: POOL, to: POOL, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [],
    logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x2", contractAddress: null,
  });
  const transport = custom({
    async request({ method, params = [] }: { method: string; params?: unknown[] }) {
      calls.push({ method, params });
      const hash = params[0] as string;
      const lag = name === "history" ? 9n : 0n; // Tenderly trailed the head by 4 to 9 blocks
      switch (method) {
        case "eth_chainId":
          return toHex(11155111);
        case "eth_blockNumber":
          return toHex(HEAD - lag);
        case "eth_getTransactionByHash":
          if (hash === PENDING) return { hash: PENDING, blockNumber: null };
          if (hash === MINED) return lag ? null : { hash: MINED, blockNumber: toHex(HEAD - 1n) };
          return { hash: OLD, blockNumber: toHex(DEPLOY + 5n) };
        case "eth_getTransactionReceipt":
          if (hash === MINED) return lag ? null : receipt(MINED, HEAD - 1n);
          if (hash === OLD) return name === "history" ? receipt(OLD, DEPLOY + 5n) : null; // publicnode dropped it
          return null;
        case "eth_call":
          return `0x${(name === "fresh" ? 20_000_000n : 0n).toString(16).padStart(64, "0")}`; // the allowance each one sees
        case "eth_getLogs": {
          const from = BigInt((params[0] as Filter).fromBlock);
          if (name === "fresh" && from < HEAD - 10_000n) throw new Error("pruned history unavailable");
          return [];
        }
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  });
  return { calls, transport };
}

const fresh = fake("fresh");
const history = fake("history");
const client = createPublicClient({
  chain: nets.ethereumTestnet,
  transport: splitReadTransport<Transport>({ fresh: fresh.transport, history: history.transport, recentBlocks: 9_000n }),
});
const historyAsked = (method?: string) => history.calls.filter((c) => !method || c.method === method).length;
const clear = () => {
  fresh.calls.length = 0;
  history.calls.length = 0;
};

await check("an approval mined a block ago: its receipt and the new allowance come from the head", async () => {
  clear();
  const r = await client.waitForTransactionReceipt({ hash: MINED, pollingInterval: 10 });
  assert.equal(r.blockNumber, HEAD - 1n);
  const allowance = await client.readContract({
    address: POOL,
    abi: parseAbi(["function allowance(address,address) view returns (uint256)"]),
    functionName: "allowance",
    args: [POOL, POOL],
  });
  assert.equal(allowance, 20_000_000n, "a reload sees the approval, so it never asks for a second one");
  assert.equal(historyAsked(), 0, "the trailing RPC is never asked");
});

await check("a pending transaction's missing receipt stays on the fresh RPC", async () => {
  clear();
  await assert.rejects(client.getTransactionReceipt({ hash: PENDING }));
  assert.equal(historyAsked(), 0);
});

await check("an old payment's receipt (pruned on publicnode) comes from history", async () => {
  clear();
  const r = await client.getTransactionReceipt({ hash: OLD });
  assert.equal(r.blockNumber, DEPLOY + 5n);
  assert.equal(historyAsked("eth_getTransactionReceipt"), 1);
});

await check("a tree walk from the deploy block: old spans to history, recent ones to the head", async () => {
  clear();
  // the walk's spans, 50,000 blocks a read (net.logRange)
  for (let from = DEPLOY; from <= HEAD; from += 50_000n) {
    const to = from + 49_999n > HEAD ? HEAD : from + 49_999n;
    await client.getLogs({ address: POOL, fromBlock: from, toBlock: to });
  }
  const h = history.calls.filter((c) => c.method === "eth_getLogs");
  const f = fresh.calls.filter((c) => c.method === "eth_getLogs");
  assert.ok(h.every((c) => BigInt(filterOf(c).toBlock!) < LINE), "history only below the line");
  assert.ok(f.every((c) => BigInt(filterOf(c).fromBlock) >= LINE), "fresh only from the line up");
  assert.equal(BigInt(filterOf(h[0]!).fromBlock), DEPLOY, "from the deploy block");
  assert.equal(BigInt(filterOf(f[f.length - 1]!).toBlock!), HEAD, "to the head");
});

await check("a log range the private RPC refuses (dRPC free plan, HTTP 400) goes to the public side and keeps the private RPC for every other call", async () => {
  const net = nets.getNetwork("robinhood-mainnet");
  const PRIVATE = "https://private.selftest.invalid/rpc";
  const PUBLIC = net.chain.rpcUrls.default.http[0]!;
  const asked: string[] = [];
  const before = globalThis.fetch;
  resetRpcRest();
  resetRpcChecks();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = (typeof input === "string" ? input : input instanceof URL ? input.href : input.url).replace(/\/$/, "");
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string };
    const side = url === PRIVATE ? "private" : url === PUBLIC.replace(/\/$/, "") ? "public" : url;
    asked.push(`${side}:${body.method}`);
    const json = (status: number, payload: object) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }), { status, headers: { "content-type": "application/json" } });
    if (body.method === "eth_chainId") return json(200, { result: toHex(net.chainId) });
    if (side === "private" && body.method === "eth_getLogs") {
      // an HTTP 400 that is not a JSON-RPC answer, as dRPC's keyed endpoint sends it
      return new Response(JSON.stringify({ message: "ranges over 10000 blocks are not supported on free plan", code: 35 }), { status: 400, headers: { "content-type": "application/json" } });
    }
    if (body.method === "eth_getLogs") return json(200, { result: [] });
    if (body.method === "eth_blockNumber") return json(200, { result: toHex(124_900_000n) });
    throw new Error(`selftest-read-transport: unexpected ${body.method} to ${url}`);
  }) as typeof fetch;
  process.env[`GLOAM_RPC_URL_${net.chainId}`] = PRIVATE;
  try {
    const c = createPublicClient({ chain: net.chain, transport: serverTransport(net, { retryCount: 0 }) });
    const logs = await c.getLogs({ address: "0x841DC046E5d8D3a6Fa2F0E4cC6D1Ef7Fb6b0e9e2", fromBlock: 124_000_000n, toBlock: 124_900_000n });
    assert.deepEqual(logs, [], "the public side answered the wide range");
    assert.ok(asked.includes("private:eth_getLogs") && asked.includes("public:eth_getLogs"), "tried private, then public");
    asked.length = 0;
    assert.equal(await c.getBlockNumber({ cacheTime: 0 }), 124_900_000n);
    assert.deepEqual(asked, ["private:eth_blockNumber"], "the next call still goes to the private RPC (not passed over)");
  } finally {
    delete process.env[`GLOAM_RPC_URL_${net.chainId}`];
    globalThis.fetch = before;
    resetRpcRest();
    resetRpcChecks();
  }
});

console.log(`read-transport: ${n} passed`);
