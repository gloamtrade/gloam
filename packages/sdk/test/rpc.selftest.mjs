/**
 * SDK self-test: reads split by age (src/rpc.ts).
 *
 * A network whose fresh RPC keeps only recent history (Ethereum Sepolia) reads
 * the head, receipts and recent logs and state there, and only older blocks
 * from its history RPC; every other network reads through plain http. Two fake
 * RPCs stand in for the real ones and record what each is asked: nothing
 * reaches any host.
 *
 * Run after build:  node test/rpc.selftest.mjs
 */
import { createPublicClient, custom, parseAbi, toHex } from "viem";

const {
  readRoute,
  namesBlock,
  taggedBlock,
  splitReadTransport,
  gloamReadTransport,
  gloamNetworks,
  testnetNetwork,
  GLOAM_NETWORKS,
  ETHEREUM_SEPOLIA_CHAIN,
  ETHEREUM_SEPOLIA_HISTORY_RPC,
  ETHEREUM_MAINNET_CHAIN,
} = await import("../dist/index.js");

globalThis.fetch = async (url) => {
  throw new Error(`rpc selftest: no network calls allowed (${String(url)})`);
};

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  checks++;
}

// ── the networks ─────────────────────────────────────────────────────────────────
assert(ETHEREUM_SEPOLIA_CHAIN.rpcUrls.default.http[0] === "https://ethereum-sepolia-rpc.publicnode.com", "Sepolia's first RPC is publicnode, at the head");
assert(ETHEREUM_SEPOLIA_HISTORY_RPC.url === "https://sepolia.gateway.tenderly.co", "Sepolia's history RPC is Tenderly's gateway");
assert(ETHEREUM_SEPOLIA_HISTORY_RPC.recentBlocks === 9_000n, "older than 9,000 blocks goes to history, under the ~10,000 publicnode keeps");
assert(ETHEREUM_MAINNET_CHAIN.rpcUrls.default.http[0] === "https://rpc.mevblocker.io", "Ethereum mainnet reads MEV Blocker, at the head and with all history");
for (const n of [...gloamNetworks(), GLOAM_NETWORKS.robinhood, GLOAM_NETWORKS.tempo]) {
  if (n.chainId === 11155111) {
    assert(n.rpcUrl === "https://ethereum-sepolia-rpc.publicnode.com" && n.historyRpc === ETHEREUM_SEPOLIA_HISTORY_RPC, "Sepolia: fresh rpcUrl plus a history RPC");
    assert(gloamReadTransport(n)({}).config.type === "gloamRead", "Sepolia reads through the split");
  } else {
    assert(n.historyRpc === null, `${n.key}: one RPC keeps everything, no history RPC`);
    if (n.chainId === 56) {
      // BNB Chain (once its pool is in): its public RPCs drop old logs, so reads go through the
      // pruned-logs guard (bnb.selftest.mjs checks the guard itself).
      assert(n.logCanary !== null && gloamReadTransport(n)({}).config.type === "gloamPrunedGuard", `${n.key}: reads through the pruned-logs guard`);
    } else {
      assert(gloamReadTransport(n)({}).config.type === "http", `${n.key}: plain http, as before`);
    }
  }
}
const sepolia = testnetNetwork("ethereum");
if (sepolia) assert(sepolia.historyRpc?.url === "https://sepolia.gateway.tenderly.co", "testnetNetwork(\"ethereum\") names the history RPC");

// ── the route of one request ───────────────────────────────────────────────────────
const LINE = 1_000n;
const route = (m, p) => JSON.stringify(readRoute(m, p, LINE), (_, v) => (typeof v === "bigint" ? v.toString() : v));
assert(route("eth_blockNumber", []) === '{"to":"fresh"}', "head read: fresh");
assert(route("eth_getTransactionReceipt", ["0x01"]) === '{"to":"fresh"}', "receipt: fresh");
assert(route("eth_sendRawTransaction", ["0x01"]) === '{"to":"fresh"}', "send: fresh");
assert(route("eth_call", [{}, "latest"]) === '{"to":"fresh"}', "call at latest: fresh");
assert(route("eth_call", [{}]) === '{"to":"fresh"}', "call with no block: fresh");
assert(route("eth_call", [{}, toHex(999n)]) === '{"to":"history"}', "call below the line: history");
assert(route("eth_call", [{}, toHex(1_000n)]) === '{"to":"fresh"}', "call at the line: fresh");
assert(route("eth_call", [{}, { blockNumber: toHex(5n) }]) === '{"to":"history"}', "EIP-1898 block number below the line: history");
assert(route("eth_call", [{}, { blockHash: "0xab" }]) === '{"to":"fresh"}', "by block hash: fresh");
assert(route("eth_getBalance", ["0x00", "earliest"]) === '{"to":"history"}', "earliest: history");
assert(route("eth_getStorageAt", ["0x00", "0x0", toHex(10n)]) === '{"to":"history"}', "storage below the line: history");
assert(route("eth_getLogs", [{ fromBlock: toHex(1_500n), toBlock: "latest" }]) === '{"to":"fresh"}', "recent logs: fresh");
assert(route("eth_getLogs", [{ fromBlock: toHex(10n), toBlock: toHex(999n) }]) === '{"to":"history"}', "old logs: history");
assert(route("eth_getLogs", [{ fromBlock: toHex(10n), toBlock: "latest" }]) === '{"to":"split","at":"1000"}', "logs across the line: split at it");
assert(route("eth_getLogs", [{ fromBlock: toHex(10n) }]) === '{"to":"split","at":"1000"}', "logs to the head (no toBlock): split");
assert(route("eth_getLogs", [{ blockHash: "0xab" }]) === '{"to":"fresh"}', "logs by block hash: fresh");
assert(route("eth_getLogs", [{}]) === '{"to":"fresh"}', "logs with no range (latest): fresh");
assert(namesBlock("eth_call", [{}, toHex(1n)]) && !namesBlock("eth_call", [{}, "latest"]) && !namesBlock("eth_blockNumber", []), "only a numbered block needs the head");
assert(taggedBlock("safe") === null && taggedBlock("finalized") === null && taggedBlock("pending") === null, "safe, finalized, pending: the head side");

// ── the transport, over two fake RPCs ───────────────────────────────────────────────
const HEAD = 20_000n;
const OLD_TX = "0x" + "11".repeat(32);
const NEW_TX = "0x" + "22".repeat(32);
const PENDING_TX = "0x" + "33".repeat(32);
const POOL = "0x00000000000000000000000000000000000000aa";
const receiptOf = (hash, bn) => ({
  transactionHash: hash, blockNumber: toHex(bn), blockHash: "0x" + "00".repeat(32), transactionIndex: "0x0", from: POOL, to: POOL,
  cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [], logsBloom: "0x" + "00".repeat(256), status: "0x1", type: "0x2", contractAddress: null,
});
const log = (bn) => ({ address: POOL, blockNumber: toHex(bn), blockHash: "0x" + "00".repeat(32), data: "0x", logIndex: "0x0", removed: false, topics: [], transactionHash: OLD_TX, transactionIndex: "0x0" });

function fakeRpc(name, keeps) {
  const calls = [];
  const transport = custom({
    async request({ method, params }) {
      calls.push({ method, params });
      switch (method) {
        case "eth_chainId":
          return toHex(11155111);
        case "eth_blockNumber":
          return toHex(name === "fresh" ? HEAD : HEAD - 8n); // history trails the head
        case "eth_getTransactionByHash": {
          const bn = params[0] === OLD_TX ? 100n : params[0] === NEW_TX ? HEAD - 1n : null;
          return bn === null && params[0] !== PENDING_TX ? null : { hash: params[0], blockNumber: bn === null ? null : toHex(bn) };
        }
        case "eth_getTransactionReceipt":
          if (params[0] === OLD_TX) return keeps === "all" ? receiptOf(OLD_TX, 100n) : null; // fresh dropped it
          if (params[0] === NEW_TX) return name === "fresh" ? receiptOf(NEW_TX, HEAD - 1n) : null; // history trails
          return null;
        case "eth_getLogs": {
          const from = BigInt(params[0].fromBlock);
          const to = params[0].toBlock === "latest" || params[0].toBlock === undefined ? HEAD : BigInt(params[0].toBlock);
          if (keeps !== "all" && from < HEAD - 10_000n) throw new Error("pruned history unavailable");
          return [log(from), log(to)];
        }
        case "eth_call":
          return "0x" + (name === "fresh" ? "01" : "02").padStart(64, "0");
        case "eth_sendRawTransaction":
          return NEW_TX;
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  });
  return { calls, transport };
}

const fresh = fakeRpc("fresh", "recent");
const history = fakeRpc("history", "all");
const client = createPublicClient({
  chain: ETHEREUM_SEPOLIA_CHAIN,
  transport: splitReadTransport({ fresh: fresh.transport, history: history.transport, recentBlocks: 9_000n }),
});
const asked = (rpc, method) => rpc.calls.filter((c) => c.method === method);
const reset = () => {
  fresh.calls.length = 0;
  history.calls.length = 0;
};

assert((await client.getBlockNumber({ cacheTime: 0 })) === HEAD, "head from the fresh RPC");
assert(history.calls.length === 0, "a head read never asks history");

reset();
const r1 = await client.getTransactionReceipt({ hash: NEW_TX });
assert(r1.blockNumber === HEAD - 1n && history.calls.length === 0, "a new receipt comes from fresh, history untouched");

reset();
const waited = await client.waitForTransactionReceipt({ hash: NEW_TX, pollingInterval: 10 });
assert(waited.status === "success" && history.calls.length === 0, "a receipt wait reads fresh only (the trailing RPC would not have it yet)");

reset();
const r2 = await client.getTransactionReceipt({ hash: OLD_TX });
assert(r2.blockNumber === 100n && asked(history, "eth_getTransactionReceipt").length === 1, "a receipt fresh no longer keeps comes from history");

reset();
let pendingNull = false;
try {
  await client.getTransactionReceipt({ hash: PENDING_TX });
} catch {
  pendingNull = true;
}
assert(pendingNull && history.calls.length === 0, "a pending transaction's missing receipt does not ask history");

reset();
const abi = parseAbi(["function currentRoot() view returns (bytes32)"]);
const atHead = await client.readContract({ address: POOL, abi, functionName: "currentRoot" });
assert(atHead.endsWith("01") && history.calls.length === 0, "state at the head: fresh");
const old = await client.readContract({ address: POOL, abi, functionName: "currentRoot", blockNumber: 50n });
assert(old.endsWith("02") && asked(history, "eth_call").length === 1, "state at an old block: history");
const recent = await client.readContract({ address: POOL, abi, functionName: "currentRoot", blockNumber: HEAD - 100n });
assert(recent.endsWith("01") && asked(history, "eth_call").length === 1, "state at a recent block: fresh");

reset();
const logs = await client.getLogs({ address: POOL, fromBlock: 100n, toBlock: "latest" });
const line = HEAD - 9_000n;
const [h] = asked(history, "eth_getLogs");
const [f] = asked(fresh, "eth_getLogs");
assert(h && BigInt(h.params[0].fromBlock) === 100n && BigInt(h.params[0].toBlock) === line - 1n, "the old part of a tree walk goes to history, up to the line");
assert(f && BigInt(f.params[0].fromBlock) === line && f.params[0].toBlock === "latest", "the recent part goes to fresh, from the line to the head");
assert(logs.map((l) => l.blockNumber).join() === [100n, line - 1n, line, HEAD].join(), "logs joined in block order");

reset();
await client.getLogs({ address: POOL, fromBlock: 100n, toBlock: 5_000n });
assert(asked(history, "eth_getLogs").length === 1 && asked(fresh, "eth_getLogs").length === 0, "an old span: history only");
await client.getLogs({ address: POOL, fromBlock: HEAD - 50n, toBlock: HEAD });
assert(asked(history, "eth_getLogs").length === 1 && asked(fresh, "eth_getLogs").length === 1, "a recent span: fresh only");
assert(asked(fresh, "eth_blockNumber").length === 0, "the head read earlier places the line; no extra head read within a minute");

reset();
await client.request({ method: "eth_sendRawTransaction", params: ["0x02"] });
assert(asked(fresh, "eth_sendRawTransaction").length === 1 && history.calls.length === 0, "a send never goes to history");

// viem's fallback skips a transport for a method its config excludes: the split
// keeps the fresh RPC's exclusion (a relay's public backup never gets a raw send)
const excluded = gloamReadTransport(
  { rpcUrl: "https://fresh.test", historyRpc: { url: "https://history.test", recentBlocks: 9_000n } },
  { methods: { exclude: ["eth_sendRawTransaction"] } }
)({});
assert(excluded.config.type === "gloamRead" && excluded.config.methods?.exclude?.[0] === "eth_sendRawTransaction", "the split carries the fresh RPC's methods");

// no history: the fresh transport itself
const same = fakeRpc("fresh", "recent");
assert(splitReadTransport({ fresh: same.transport, history: null, recentBlocks: 9_000n }) === same.transport, "no history RPC: fresh as is");

console.log(`rpc selftest: ${checks} checks passed`);
