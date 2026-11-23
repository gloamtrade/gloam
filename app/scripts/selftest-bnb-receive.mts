/**
 * Self-test: a payment to a Gloam address on BNB Chain lands in a fresh
 * browser, read through the vault client the app really uses (lib/rhClient
 * publicClientFor), not one built for the test.
 *
 * Support case, 23 Nov 2026: $5 paid privately on BNB Chain to a friend's
 * Gloam address; the transfer and its payment message were both on chain, but
 * his balance showed 0.00. BNB Chain's public RPCs keep about a day of logs,
 * and every read goes through the pruned-logs check (lib/readTransport). The
 * vault client gave that check nowhere to send an older read, so a walk of the
 * payment board from its deploy block (any browser with no cursor yet, and the
 * Receive inbox every time) threw once the board was more than a day old. The
 * pass then kept no cursor, so every later pass failed the same way and no
 * payment on BNB Chain ever landed. Now the vault client sends old log reads to
 * gloam.trade's proxy (or NEXT_PUBLIC_BNB_ARCHIVE_RPC_URL), like wagmi does.
 *
 * Against fake RPCs: publicnode keeps logs for the last 220,000 blocks only,
 * the dataseed refuses log reads, and the proxy keeps every log but takes at
 * most 10,000 blocks a read (the message gloam.trade's proxy gives on BNB):
 *  - the board's memos are read from its deploy block: blocks older than half a
 *    day straight from the proxy, 10,000 a read (through publicnode first, the
 *    first pass took 860 s live), the newest from publicnode
 *  - payments in USDT and USDC (18 decimals), BNB and BDX (9) to a fresh Gloam
 *    address land in one pass, with the cursor written at the head
 *  - the next pass reads on from the cursor on publicnode alone
 *  - with the proxy down too, the pass lands nothing and the cursor stays put
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-bnb-receive.mts
 */
import assert from "node:assert/strict";
import { localStorage } from "./browser-shim.mjs";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  multicall3Abi,
  type Address,
  type Hex,
} from "viem";

for (const k of Object.keys(process.env)) if (k.startsWith("NEXT_PUBLIC_BNB_")) delete process.env[k];
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.NEXT_PUBLIC_BNB_ENABLED = "1";
process.env.NEXT_PUBLIC_BNB_LIVE_SINCE = "19 November 2026";
const win = globalThis.window as unknown as Record<string, unknown>;
win.setTimeout = setTimeout;
win.clearTimeout = clearTimeout;
localStorage.setItem("gloam.network", "bnb-mainnet");

const POOL = getAddress("0x89d3042390204f57b8b4F8949D3c2203E4002164");
const BOARD = getAddress("0xb692c86B13f65a123f45cF9A21580b2dDC7B8a79");
const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");
const USDC = getAddress("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d");
const BDX = getAddress("0x9d10a1ec41Fe7878429BB457e31F9b050D38c633");
const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";

// ── fake chain ──
let HEAD = 135_300_000n;
const PRUNED_FROM = HEAD - 220_000n; // publicnode keeps about a day of logs (a day is ~190,000 blocks)
const PROXY_RANGE = 10_000n;
let proxyDown = false;
type BoardLog = { block: bigint; topics: Hex[]; data: Hex; tx: Hex; index: number };
const boardLogs: BoardLog[] = [];
const inVault = new Set<string>();
const spent = new Set<string>();
const asked: { host: string; method: string; from?: bigint; to?: bigint; refused?: boolean; address?: string }[] = [];
const hex = (n: bigint) => `0x${n.toString(16)}`;

const shield = await import("../src/lib/shield");

function logsFor(url: string, f: { address?: string; fromBlock?: string; toBlock?: string }): unknown[] {
  const from = BigInt(f.fromBlock ?? "0x0");
  const to = f.toBlock ? BigInt(f.toBlock) : HEAD;
  const keepsFrom = url.includes("/api/rpc/56") ? 0n : PRUNED_FROM;
  if (to < keepsFrom) return [];
  const lo = from > keepsFrom ? from : keepsFrom;
  const addr = String(f.address).toLowerCase();
  // the canary: USDT logs at every block the node still keeps
  if (addr === USDT.toLowerCase()) {
    return [{ address: USDT, blockNumber: hex(lo), blockHash: `0x${"11".repeat(32)}`, transactionHash: `0x${"22".repeat(32)}`, transactionIndex: "0x0", logIndex: "0x0", data: "0x", topics: [], removed: false }];
  }
  if (addr !== BOARD.toLowerCase()) return [];
  return boardLogs
    .filter((l) => l.block >= lo && l.block <= to)
    .map((l) => ({ address: BOARD, blockNumber: hex(l.block), blockHash: `0x${"33".repeat(32)}`, transactionHash: l.tx, transactionIndex: "0x0", logIndex: hex(BigInt(l.index)), data: l.data, topics: l.topics, removed: false }));
}

function vaultRead(data: Hex): Hex {
  const call = decodeFunctionData({ abi: shield.shieldPoolAbi, data });
  const arg = String((call.args as readonly unknown[] | undefined)?.[0] ?? "").toLowerCase();
  if (call.functionName === "commitmentSeen") return encodeFunctionResult({ abi: shield.shieldPoolAbi, functionName: "commitmentSeen", result: inVault.has(arg) } as never);
  if (call.functionName === "isSpent") return encodeFunctionResult({ abi: shield.shieldPoolAbi, functionName: "isSpent", result: spent.has(arg) } as never);
  throw new Error(`fake vault: ${call.functionName} not expected`);
}

function answer(url: string, method: string, params: unknown[]): unknown {
  if (method === "eth_chainId") return "0x38";
  if (method === "eth_blockNumber") return hex(HEAD);
  if (method === "eth_getLogs") return logsFor(url, params[0] as never);
  if (method === "eth_call") {
    const c = params[0] as { to: string; data: Hex };
    if (c.to.toLowerCase() === POOL.toLowerCase()) return vaultRead(c.data);
    if (c.to.toLowerCase() === MULTICALL3) {
      const { args } = decodeFunctionData({ abi: multicall3Abi, data: c.data });
      const calls = (args as unknown as [{ target: string; callData: Hex }[]])[0];
      return encodeFunctionResult({
        abi: multicall3Abi,
        functionName: "aggregate3",
        result: calls.map((x) => {
          if (x.target.toLowerCase() !== POOL.toLowerCase()) return { success: false, returnData: "0x" as Hex };
          try {
            return { success: true, returnData: vaultRead(x.callData) };
          } catch {
            return { success: false, returnData: "0x" as Hex };
          }
        }),
      });
    }
  }
  throw new Error(`fake RPC: ${method} not expected`);
}

globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!/^https:\/\/(bsc-rpc\.publicnode\.com|bsc-dataseed\.bnbchain\.org|gloam\.trade\/api\/rpc\/56)/.test(url)) {
    throw new Error(`selftest-bnb-receive: no network calls allowed (${url})`);
  }
  const host = new URL(url).host + (url.includes("/api/rpc/") ? " (proxy)" : "");
  if (proxyDown && url.includes("/api/rpc/56")) return new Response("upstream down", { status: 502 });
  const body = JSON.parse(init?.body ?? "null");
  const one = (b: { id: number; method: string; params?: unknown[] }) => {
    const f = (b.params ?? [])[0] as { fromBlock?: string; toBlock?: string; address?: string } | undefined;
    asked.push({ host, method: b.method, from: f?.fromBlock ? BigInt(f.fromBlock) : undefined, to: f?.toBlock ? BigInt(f.toBlock) : undefined, address: f?.address?.toLowerCase() });
    if (b.method === "eth_getLogs" && url.includes("bsc-dataseed")) return { jsonrpc: "2.0", id: b.id, error: { code: -32005, message: "limit exceeded" } };
    if (b.method === "eth_getLogs" && url.includes("/api/rpc/56")) {
      const r = asked[asked.length - 1]!;
      if (r.from !== undefined && r.to !== undefined && r.to - r.from + 1n > PROXY_RANGE) {
        r.refused = true;
        return { jsonrpc: "2.0", id: b.id, error: { code: -32602, message: "block range too large: maximum block range is 10000" } };
      }
    }
    try {
      return { jsonrpc: "2.0", id: b.id, result: answer(url, b.method, b.params ?? []) };
    } catch (e) {
      return { jsonrpc: "2.0", id: b.id, error: { code: -32000, message: String((e as Error).message) } };
    }
  };
  const out = Array.isArray(body) ? body.map(one) : one(body);
  return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const slot = await import("../src/lib/accountSlot");
const scope = await import("../src/lib/accountScope");
slot.enforceAccountScope(true);
scope.setPageReload(() => {});
const vault = await import("../src/lib/noteVault");
const receive = await import("../src/lib/receiveTag");
const pkg = await import("../src/lib/notePackage");
const poseidon = await import("../src/lib/poseidon");
const notePos = await import("../src/lib/notePoseidon");
const memo = await import("../src/lib/payMemo");
const nets = await import("../src/lib/networks");
const auto = await import("../src/lib/autoReceive");
const { publicClientFor } = await import("../src/lib/rhClient");

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const NET = nets.getNetwork("bnb-mainnet");
assert.equal(NET.pool?.toLowerCase(), POOL.toLowerCase(), "BNB Chain is on, with its vault");
assert.equal(NET.payMemo?.address.toLowerCase(), BOARD.toLowerCase(), "and its payment board");
assert.ok(NET.payMemo!.deployBlock < PRUNED_FROM, "the board is older than what publicnode keeps");

const memoEvent = {
  type: "event",
  name: "PaymentMemo",
  inputs: [
    { name: "paymentCommitment", type: "bytes32", indexed: true },
    { name: "memo", type: "bytes", indexed: false },
  ],
} as const;
let logIndex = 0;
/** Posts a payment's code on the board at `block`, as the payer's app does after the transfer. */
function post(commitment: Hex, ticket: string, block: bigint) {
  const topics = encodeEventTopics({ abi: [memoEvent], eventName: "PaymentMemo", args: { paymentCommitment: commitment } }) as Hex[];
  const data = encodeAbiParameters([{ type: "bytes" }], [memo.ticketToMemoBytes(ticket)]);
  boardLogs.push({ block, topics, data, tx: `0x${(logIndex + 1).toString(16).padStart(64, "0")}`, index: logIndex++ });
}

/** A BNB Chain payment of `wei` of `asset`, made like the payer's app makes one. */
async function payment(asset: Address, wei: bigint) {
  const secret = poseidon.fieldToHex(BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(31))).toString("hex")}`)) as Hex;
  const commitment = (poseidon.fieldToHex(await notePos.noteCommitmentPoseidon(poseidon.hexToField(secret), wei, asset)) as Hex).toLowerCase() as Hex;
  const plain = pkg.encodeNotePackage(pkg.buildNotePackage({ pool: POOL, asset, amountWei: wei.toString(), secret, commitment, chainId: 56 }));
  inVault.add(commitment);
  return { commitment, plain };
}

const cursorValue = () => {
  const k = [...Array(localStorage.length).keys()].map((i) => localStorage.key(i)!).find((x) => x.startsWith("gloam.receive.cursor.v1:56:"));
  return k ? localStorage.getItem(k) : null;
};
/** Reads of the payment board since `from` (the vault's own walk, for the tree, is left out). */
const logReads = (from: number) => asked.slice(from).filter((a) => a.method === "eth_getLogs" && a.address === BOARD.toLowerCase());

const ME = getAddress("0x1511000000000000000000000000000000000dfe");
await scope.signInAs(ME);
await vault.unlockNoteVault();
const myTag = (await receive.getOrCreateReceiveIdentity()).tag;
assert.ok(myTag.startsWith("gloamr1."), "a fresh Gloam address");

// one payment three days old (only the proxy has it), the rest from the last hour
const old = await payment(USDT, 5_000_000_000_000_000_000n);
post(old.commitment, await receive.encryptTicketForTag(old.plain, myTag), NET.payMemo!.deployBlock + 50_000n);

await test("a fresh browser reads BNB Chain's board from its deploy block, old logs through the proxy", async () => {
  const at = asked.length;
  const memos = await memo.fetchPaymentMemos(publicClientFor(NET), undefined, HEAD, NET);
  assert.equal(memos.length, 1, "the three-day-old memo is found");
  assert.equal(memos[0]!.paymentCommitment.toLowerCase(), old.commitment);
  const reads = logReads(at);
  assert.ok(reads.some((r) => r.host.endsWith("(proxy)")), "older blocks were read from the proxy");
  assert.ok(!reads.some((r) => r.host.includes("dataseed")), "never from the dataseed, which refuses logs");
  const proxied = reads.filter((r) => r.host.endsWith("(proxy)"));
  const split = HEAD - memo.PUBLIC_LOG_BLOCKS;
  assert.ok(proxied.every((r) => !r.refused && r.to! - r.from! + 1n <= PROXY_RANGE), "in reads the proxy takes (10,000 blocks)");
  assert.ok(proxied.every((r) => r.to! < split), "only blocks older than half a day go to the proxy");
  const pub = reads.filter((r) => r.host === "bsc-rpc.publicnode.com");
  assert.ok(pub.length > 0 && pub.every((r) => r.from! >= split), "publicnode is asked only for the newest blocks");
  const oldBlocks = Number(split - NET.payMemo!.deployBlock);
  assert.ok(proxied.length <= Math.ceil(oldBlocks / Number(PROXY_RANGE)) + 1, `one read per 10,000 old blocks (${proxied.length})`);
});

await test("USDT, USDC, BNB and BDX paid to a fresh Gloam address land in one pass, cursor at the head", async () => {
  const usdc = await payment(USDC, 2_500_000_000_000_000_000n);
  const bnb = await payment(NATIVE, 10_000_000_000_000_000n);
  const bdx = await payment(BDX, 7_000_000_000n);
  post(usdc.commitment, await receive.encryptTicketForTag(usdc.plain, myTag), HEAD - 9_000n);
  post(bnb.commitment, await receive.encryptTicketForTag(bnb.plain, myTag), HEAD - 8_000n);
  post(bdx.commitment, await receive.encryptTicketForTag(bdx.plain, myTag), HEAD - 7_000n);
  assert.equal(cursorValue(), null, "no cursor yet: the pass starts at the board's deploy block");
  const landed = await auto.receiveWaitingPayments(NET, ME, { force: true });
  assert.deepEqual(landed.map((l) => l.label).sort(), ["0.01 BNB", "2.50 USDC", "5.00 USDT", "7.00 BDX"]);
  assert.ok(landed.every((l) => l.networkKey === "bnb-mainnet"));
  const saved = vault.getAllNotes().filter((n) => n.chainId === 56);
  assert.equal(saved.length, 4, "all four saved to the balance");
  assert.equal(cursorValue(), HEAD.toString(), "read up to the head");
});

await test("the next pass reads on from the cursor, on publicnode alone", async () => {
  HEAD += 5_000n;
  const p = await payment(USDT, 1_000_000_000_000_000_000n);
  post(p.commitment, await receive.encryptTicketForTag(p.plain, myTag), HEAD - 100n);
  const at = asked.length;
  const landed = await auto.receiveWaitingPayments(NET, ME, { force: true });
  assert.deepEqual(landed.map((l) => l.label), ["1.00 USDT"]);
  const reads = logReads(at);
  assert.ok(reads.length > 0 && reads.every((r) => r.host === "bsc-rpc.publicnode.com"), "the board's recent blocks: no proxy read");
  assert.equal(cursorValue(), HEAD.toString());
});

await test("with the proxy down too, nothing lands and the cursor stays where it was", async () => {
  const before = cursorValue();
  // a reset (keys restored) sends the next pass back to the deploy block, through the proxy
  const { resetReceiveCursors } = await import("../src/lib/receiveCursor");
  resetReceiveCursors();
  proxyDown = true;
  HEAD += 1_000n;
  const landed = await auto.receiveWaitingPayments(NET, ME, { force: true });
  assert.deepEqual(landed, []);
  assert.equal(cursorValue(), null, "no cursor written over a failed read");
  proxyDown = false;
  void before;
});

console.log(`\nselftest-bnb-receive: ${passed} passed`);
process.exit(0);
