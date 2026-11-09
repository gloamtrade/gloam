/**
 * Self-test: relay guard rails from the 2026-10-11 audit (R-1, I-3).
 *
 *  - payment message cap: the largest real sealed ticket fits, 2,049 bytes
 *    and the board's 8,192 are refused; sealed tickets are padded, so their
 *    size says nothing about the amount and little about the note (L-2)
 *  - the one-request-per-spend lock in memory mode: a second take is refused,
 *    a release lets the next one in, it expires, and a stale release leaves a
 *    newer holder alone
 *  - the relay against a fake chain: a copy of a proof that is being sent is
 *    refused with a 409, the spent check runs before the dry run on sends and
 *    cash outs, the lock is dropped when nothing went out and kept once
 *    something did (or may have)
 *  - a sent transaction: a reverted receipt for that very send drops the lock
 *    and lets the note move, after the hash is back; a successful one, a
 *    missing one, a failed read or a send with no hash keeps it, and copies
 *    sent meanwhile are refused without a second send
 *  - a send that may have reached a node (a dropped connection, a 502, a
 *    private RPC that took it and never answered) is reported maybe_sent and
 *    never sent again, with the public RPC never handed the raw send; only a
 *    real nonce or replacement refusal from the node is retried, once
 *  - payment messages: a relayed transfer hands back a memo ticket for its
 *    payment, the payer's ticketed message gets through after 40 strangers
 *    have tried, partner keys keep their own few, the app client keeps the
 *    ticket and sends it, no secret means no ticket, and no limit keys on an IP;
 *    strangers' messages stop at their own network budget and never take a
 *    send's slot, so sends, the payer's heads-up and partner keys still go
 *  - cash outs to the vault or the memo board are refused before any chain
 *    call, on the server, in the shared check the app uses, and in the SDK;
 *    so are a listed token contract, a swap router and the zero address, while
 *    a wallet is never refused. The SDK alone, with no list from the app, refuses
 *    every one of them
 *  - Redis set but not answering: every send, cash out and payment message is
 *    refused relay_off before any chain call, logged once per outage; the
 *    per-spend lock never runs on memory then, nor in a production build with
 *    no Redis at all; with Redis back, the next send locks in Redis again
 *  - a private RPC (GLOAM_RPC_URL_<chainId>) that answers for another chain is
 *    never used: every chain has the vault at the same address, so its reads
 *    would look real. Reads go to the chain's public RPC, and a send is refused
 *    before it reaches any node. One that has not answered eth_chainId (down,
 *    slow, timed out) is passed over for a while: reads and the relay's one
 *    send go to the public RPC, and it is asked again later
 *
 * fetch is stubbed for the whole run: chain calls go to an in-process fake
 * that answers the few JSON-RPC methods the relay uses, at the chain's public
 * RPC and at a made-up private one, and anything else fails. The relay key is a throwaway made here. Nothing reaches any host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-relay.mts
 */
import assert from "node:assert/strict";
import { encodeFunctionData, getAddress, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.CHAINALYSIS_API_KEY;
process.env.GLOAM_RELAYER_PRIVATE_KEY = generatePrivateKey();

const {
  IN_FLIGHT_MESSAGE,
  MAYBE_SENT_MESSAGE,
  RELAY_MEMO_MAX_BYTES,
  RelayError,
  asMemo,
  memoTicket,
  relayMemo,
  relayPoolAbi,
  relayTransfer,
  relayUnshield,
  sendFailure,
} = await import("../src/lib/relay/server");
const relayClient = await import("../src/lib/relay/client");
const { INFLIGHT_TTL_SEC, inflightKey, releaseIfReverted, takeInflight } = await import("../src/lib/relay/inflight");
const {
  CASH_OUT_TO_BOARD_MESSAGE,
  CASH_OUT_TO_ROUTER_MESSAGE,
  CASH_OUT_TO_TOKEN_MESSAGE,
  CASH_OUT_TO_VAULT_MESSAGE,
  CASH_OUT_TO_ZERO_MESSAGE,
  cashOutTargetProblem,
} = await import("../src/lib/cashOutTarget");
const { swapRoutersOn } = await import("../src/lib/vaultSwap");
const { cashOutTargetProblem: sdkCashOutTargetProblem } = await import("@gloamtrade/sdk");
const { RH_MAINNET_SWAP_TOKENS, RH_MAINNET_TOKENS, TEMPO_MAINNET_TOKENS, shieldTokensFor } = await import("../src/lib/tokens");
const { POST: relayPost } = await import("../src/app/api/relay/route");
const partners = await import("../src/lib/partners");
const partnerLinks = await import("../src/lib/partnerLinks");
const { k: partnersKey } = await import("../src/lib/partnersKv");
const { linkNullifierHash } = await import("../src/lib/partnerCode");
const { spendIdOf } = await import("../src/lib/partnerAttribution");
const { resetRpcChecks, serverTransport } = await import("../src/lib/serverRpc");
const { getNetwork } = await import("../src/lib/networks");
const { buildNotePackage, encodeNotePackage } = await import("../src/lib/notePackage");
const { encryptTicketForTag } = await import("../src/lib/receiveTag");
const { PAY_MEMO_MAX_BYTES, ticketToMemoBytes } = await import("../src/lib/payMemo");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

function isRelayError(code: string, status: number, message?: string) {
  return (e: unknown) => {
    assert.ok(e instanceof RelayError, `expected a RelayError, got ${String(e)}`);
    assert.equal(e.code, code);
    assert.equal(e.status, status);
    if (message) assert.equal(e.message, message);
    return true;
  };
}

const net = getNetwork("robinhood");
assert.ok(net.pool && net.payMemo, "robinhood needs a pool and a memo board");
const POOL = net.pool;
const BOARD = net.payMemo.address;
const RPC = net.chain.rpcUrls.default.http[0];
const CLEAN = "0x1111111111111111111111111111111111111111" as Address;
const PROOF = ("0x" + "22".repeat(256)) as Hex;
const H32 = ("0x" + "11".repeat(32)) as Hex;
const TX_HASH = ("0x" + "ab".repeat(32)) as Hex;
let n = 0;
/** A fresh nullifier per case, so locks from one case never touch another. */
function nullifier(): Hex {
  n++;
  return `0x${n.toString(16).padStart(64, "0")}` as Hex;
}

// ---------------------------------------------------------------- fake chain

/**
 * How the node answers a raw send: "ok"; "reject" (out of gas); "drop" (the
 * connection drops, the node may have it); "http502"; "known" (the node already
 * holds it); "nonce_once" (a real nonce clash on the first send, then ok);
 * "private_took" (the private RPC takes it and the connection drops, then the
 * public RPC, where it already landed, calls it a nonce too low).
 */
type SendMode = "ok" | "reject" | "drop" | "http502" | "known" | "nonce_once" | "private_took";
/** What the node says about the send's receipt: how it ended, "none" yet, or a failed read. */
type ReceiptMode = "success" | "reverted" | "none" | "error";
/** How the dry run (eth_estimateGas) answers: "ok", or "revert" (a bad proof). */
type EstimateMode = "ok" | "revert";
const chain = { spent: false, known: true, seen: true, send: "ok" as SendMode, receipt: "success" as ReceiptMode, estimate: "ok" as EstimateMode };
const calls: string[] = [];
/** Which RPC got each raw send. */
const sends: ("public" | "private" | "wrong")[] = [];
/** Reads of the send's receipt: they run on their own after a send, so they stay out of `calls`. */
const receiptReads: string[] = [];
/** A fake Upstash REST endpoint: "up" answers, "down" drops the connection. */
const REDIS_URL = "https://redis.selftest.invalid";
const redisState = { mode: "up" as "up" | "down", data: new Map<string, string>(), commands: [] as string[] };
function redisAnswer(cmd: (string | number)[]): { result?: unknown; error?: string } {
  const [name, ...a] = cmd.map(String);
  redisState.commands.push(`${name} ${a[0] ?? ""}`);
  const d = redisState.data;
  switch (name!.toUpperCase()) {
    case "SET": {
      if (a.includes("NX") && d.has(a[0]!)) return { result: null };
      d.set(a[0]!, a[1]!);
      return { result: "OK" };
    }
    case "GET":
      return { result: d.get(a[0]!) ?? null };
    case "DEL":
      return { result: d.delete(a[0]!) ? 1 : 0 };
    case "EVAL": // the lock release: delete only when it is still ours
      return { result: d.get(a[2]!) === a[3] ? (d.delete(a[2]!), 1) : 0 };
    case "INCR": {
      const n = Number(d.get(a[0]!) ?? 0) + 1;
      d.set(a[0]!, String(n));
      return { result: n };
    }
    case "INCRBY": {
      const n = Number(d.get(a[0]!) ?? 0) + Number(a[1]);
      d.set(a[0]!, String(n));
      return { result: n };
    }
    case "EXPIRE":
      return { result: 1 };
    default:
      return { error: `fake redis: ${name}` };
  }
}
/** Every method the wrong-chain RPC was asked. */
const wrongCalls: string[] = [];
const PRIVATE_RPC = "https://private-rpc.selftest.invalid";
/** A private RPC set for this chain by mistake: it is another chain's node. */
const WRONG_RPC = "https://wrong-chain-rpc.selftest.invalid";
const WRONG_CHAIN_ID = 8453;
/**
 * A private RPC that has not said which chain it serves: eth_chainId gets a
 * 503 until `says` is set, while every other call is answered from its own
 * state (block 0xdead, every send taken). It may be another chain's node.
 */
const UNCHECKED_RPC = "https://unchecked-rpc.selftest.invalid";
const unchecked = { says: null as number | null, calls: [] as string[] };
/** A private RPC that never answers: every call waits until the caller gives up. */
const HUNG_RPC = "https://hung-rpc.selftest.invalid";
const hung: string[] = [];
/**
 * A private RPC that says this chain on eth_chainId and then fails the other
 * calls: "503" answers a 503, "hang" never answers, "ok" answers.
 */
const FLAKY_RPC = "https://flaky-rpc.selftest.invalid";
const flaky = { mode: "ok" as "ok" | "503" | "hang", calls: [] as string[] };
const NONCE_TOO_LOW = { code: -32000, message: "nonce too low: address 0x0000000000000000000000000000000000000000, tx: 0 state: 1" };
const SEL = {
  spent: toFunctionSelector("spent(bytes32)"),
  isKnownRoot: toFunctionSelector("isKnownRoot(bytes32)"),
  commitmentSeen: toFunctionSelector("commitmentSeen(bytes32)"),
};
const word = (b: boolean) => "0x" + (b ? "1" : "0").padStart(64, "0");
const Z32 = "0x" + "00".repeat(32);
const BLOCK = {
  number: "0x1",
  hash: "0x" + "12".repeat(32),
  parentHash: Z32,
  nonce: "0x0000000000000000",
  sha3Uncles: Z32,
  logsBloom: "0x" + "00".repeat(256),
  transactionsRoot: Z32,
  stateRoot: Z32,
  receiptsRoot: Z32,
  miner: "0x" + "00".repeat(20),
  difficulty: "0x0",
  totalDifficulty: "0x0",
  extraData: "0x",
  size: "0x1",
  gasLimit: "0x1c9c380",
  gasUsed: "0x0",
  timestamp: "0x1",
  baseFeePerGas: "0x1",
  transactions: [],
  uncles: [],
};

type RpcReq = { id: number; method: string; params?: unknown[] };

function receiptFor(hash: string, status: "success" | "reverted") {
  return {
    transactionHash: hash,
    transactionIndex: "0x0",
    blockHash: BLOCK.hash,
    blockNumber: "0x1",
    from: "0x" + "00".repeat(20),
    to: POOL,
    cumulativeGasUsed: "0x1",
    gasUsed: "0x1",
    effectiveGasPrice: "0x1",
    contractAddress: null,
    logs: [],
    logsBloom: BLOCK.logsBloom,
    status: status === "success" ? "0x1" : "0x0",
    type: "0x2",
  };
}

function answer(r: RpcReq): { result?: unknown; error?: { code: number; message: string } } {
  switch (r.method) {
    case "eth_chainId":
      return { result: toHex(net.chainId) };
    case "eth_blockNumber":
      return { result: "0x1" };
    case "eth_getBlockByNumber":
      return { result: BLOCK };
    case "eth_getTransactionCount":
      return { result: "0x0" };
    case "eth_maxPriorityFeePerGas":
    case "eth_gasPrice":
      return { result: "0x1" };
    case "eth_estimateGas":
      if (chain.estimate === "revert") return { error: { code: 3, message: "execution reverted: InvalidProof" } };
      return { result: "0x1b7740" };
    case "eth_call": {
      const data = String((r.params?.[0] as { data?: string; input?: string })?.data ?? (r.params?.[0] as { input?: string })?.input);
      const sel = data.slice(0, 10);
      if (sel === SEL.spent) return { result: word(chain.spent) };
      if (sel === SEL.isKnownRoot) return { result: word(chain.known) };
      if (sel === SEL.commitmentSeen) return { result: word(chain.seen) };
      return { error: { code: -32000, message: `fake chain: unknown call ${sel}` } };
    }
    // the fake node keeps no pending transactions: one without a receipt is gone (relay/server assertEarlierSendSettled)
    case "eth_getTransactionByHash":
      return { result: null };
    case "eth_getTransactionReceipt":
      if (chain.receipt === "error") return { error: { code: -32000, message: "fake chain: receipt read failed" } };
      return { result: chain.receipt === "none" ? null : receiptFor(String(r.params?.[0]), chain.receipt) };
    case "eth_sendRawTransaction":
      if (chain.send === "reject") return { error: { code: -32000, message: "insufficient funds for gas * price + value" } };
      if (chain.send === "known") return { error: { code: -32000, message: "already known" } };
      if (chain.send === "nonce_once" && sends.length === 1) return { error: NONCE_TOO_LOW };
      if (chain.send === "private_took") return { error: NONCE_TOO_LOW };
      return { result: TX_HASH };
    default:
      return { error: { code: -32601, message: `fake chain: ${r.method} not handled` } };
  }
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = (typeof input === "string" ? input : input instanceof URL ? input.href : input.url).replace(/\/$/, "");
  // the app's relay client (lib/relay/client) posts here: hand it to the route itself
  if (url === "/api/relay") {
    return relayPost(new Request("http://localhost/api/relay", { method: init?.method ?? "GET", headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.200" }, body: init?.body }));
  }
  if (url === REDIS_URL || url === `${REDIS_URL}/pipeline`) {
    if (redisState.mode === "down") throw new TypeError("fetch failed");
    const cmds = JSON.parse(String(init?.body)) as (string | number)[] | (string | number)[][];
    const out = url.endsWith("/pipeline") ? (cmds as (string | number)[][]).map(redisAnswer) : redisAnswer(cmds as (string | number)[]);
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url === HUNG_RPC) {
    const body = JSON.parse(String(init?.body)) as RpcReq | RpcReq[];
    hung.push(...(Array.isArray(body) ? body : [body]).map((r) => r.method));
    return new Promise<Response>((_, reject) => {
      const s = init?.signal;
      if (s?.aborted) return reject(s.reason);
      s?.addEventListener("abort", () => reject(s.reason ?? new Error("aborted")));
    });
  }
  if (url === UNCHECKED_RPC) {
    const body = JSON.parse(String(init?.body)) as RpcReq | RpcReq[];
    const list = Array.isArray(body) ? body : [body];
    unchecked.calls.push(...list.map((r) => r.method));
    if (list.some((r) => r.method === "eth_chainId") && unchecked.says === null) {
      return new Response("busy", { status: 503 });
    }
    const out = list.map((r) =>
      r.method === "eth_chainId"
        ? { jsonrpc: "2.0", id: r.id, result: toHex(unchecked.says!) }
        : r.method === "eth_blockNumber"
          ? { jsonrpc: "2.0", id: r.id, result: "0xdead" }
          : { jsonrpc: "2.0", id: r.id, ...answer(r) }
    );
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url === FLAKY_RPC) {
    const body = JSON.parse(String(init?.body)) as RpcReq | RpcReq[];
    const list = Array.isArray(body) ? body : [body];
    flaky.calls.push(...list.map((r) => r.method));
    const onlyChainId = list.every((r) => r.method === "eth_chainId");
    if (!onlyChainId && flaky.mode === "503") return new Response("busy", { status: 503 });
    if (!onlyChainId && flaky.mode === "hang") {
      return new Promise<Response>((_, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) return reject(sig.reason);
        sig?.addEventListener("abort", () => reject(sig.reason ?? new Error("aborted")));
      });
    }
    const out = list.map((r) =>
      r.method === "eth_blockNumber" ? { jsonrpc: "2.0", id: r.id, result: "0xbeef" } : { jsonrpc: "2.0", id: r.id, ...answer(r) }
    );
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const via = url === RPC.replace(/\/$/, "") ? "public" : url === PRIVATE_RPC ? "private" : url === WRONG_RPC ? "wrong" : null;
  if (!via) throw new Error(`selftest: no network (${url})`);
  const body = JSON.parse(String(init?.body)) as RpcReq | RpcReq[];
  const list = Array.isArray(body) ? body : [body];
  for (const r of list) {
    if (r.method === "eth_getTransactionReceipt") receiptReads.push(String(r.params?.[0]));
    else calls.push(r.method === "eth_call" ? `eth_call:${callName(r)}` : r.method);
  }
  if (via === "wrong") {
    wrongCalls.push(...list.map((r) => r.method));
    const out = list.map((r) =>
      r.method === "eth_chainId" ? { jsonrpc: "2.0", id: r.id, result: toHex(WRONG_CHAIN_ID) } : { jsonrpc: "2.0", id: r.id, ...answer(r) }
    );
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const isSend = list.some((r) => r.method === "eth_sendRawTransaction");
  if (isSend) sends.push(via);
  // A dropped connection on the send: the node may or may not have the transaction.
  if (isSend && (chain.send === "drop" || (chain.send === "private_took" && via === "private"))) {
    throw new TypeError("fetch failed");
  }
  if (isSend && chain.send === "http502") return new Response("bad gateway", { status: 502 });
  const out = list.map((r) => ({ jsonrpc: "2.0", id: r.id, ...answer(r) }));
  return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

function callName(r: RpcReq): string {
  const data = String((r.params?.[0] as { data?: string })?.data ?? "");
  const sel = data.slice(0, 10);
  return sel === SEL.spent ? "spent" : sel === SEL.isKnownRoot ? "isKnownRoot" : sel === SEL.commitmentSeen ? "commitmentSeen" : sel;
}

function reset(state: Partial<typeof chain> = {}) {
  Object.assign(chain, { spent: false, known: true, seen: true, send: "ok", receipt: "success", estimate: "ok" }, state);
  calls.length = 0;
  sends.length = 0;
  receiptReads.length = 0;
}

/** Runs `fn` with GLOAM_RPC_URL set for the test network, so relay sends go to the private RPC first. */
async function withPrivateRpc(fn: () => Promise<void>) {
  const name = `GLOAM_RPC_URL_${net.chainId}`;
  process.env[name] = PRIVATE_RPC;
  // a case before may have left it passed over (a send it dropped): start each one checked afresh
  resetRpcChecks();
  try {
    await fn();
  } finally {
    delete process.env[name];
  }
}

/** True when nobody holds the lock for this spend (takes it and lets it go again). */
async function lockFree(nul: Hex): Promise<boolean> {
  const l = await takeInflight(inflightKey(net.chainId, nul));
  if (!l) return false;
  await l.release();
  return true;
}

/** The relay reads the receipt on its own after a send: waits until it has, `times` times over. */
async function receiptRead(times = 1) {
  for (let i = 0; i < 1_000 && receiptReads.length < times; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(receiptReads.length >= times, "the relay read the receipt");
  // what it does with the answer comes a few ticks after the read
  await new Promise((r) => setTimeout(r, 20));
}

function transferBody(nul: Hex) {
  return { proof: PROOF, root: H32, nullifier: nul, commitments: [H32, H32] };
}

function unshieldBody(nul: Hex, to: string) {
  return { proof: PROOF, root: H32, nullifier: nul, asset: "0x0000000000000000000000000000000000000000", to, amount: "1" };
}

function req(url: string, body: unknown, ip = "203.0.113.9") {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------- memo cap

async function receiveTag(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return "gloamr1." + Buffer.from(spki).toString("base64url");
}

async function sealedMemo(note: string, amountWei = (2n ** 256n - 1n).toString(), chainId: number | undefined = 11155111): Promise<Hex> {
  const pack = buildNotePackage({
    pool: getAddress(POOL),
    asset: getAddress("0x20c0000000000000000000000000000000000001"),
    amountWei,
    secret: ("0x" + "f".repeat(64)) as Hex,
    commitment: ("0x" + "e".repeat(64)) as Hex,
    note,
    // every new code names its chain; the longest id Gloam knows has 8 digits
    chainId,
  });
  return ticketToMemoBytes(await encryptTicketForTag(encodeNotePackage(pack), await receiveTag()));
}

const bytesOf = (memo: Hex) => (memo.length - 2) / 2;
const memoOf = (bytes: number) => ("0x" + "ab".repeat(bytes)) as Hex;

await test("memo cap is 2048 bytes, under the board's 8192", () => {
  assert.equal(RELAY_MEMO_MAX_BYTES, 2048);
  assert.equal(PAY_MEMO_MAX_BYTES, 8192);
});

await test("the largest real sealed ticket is 1739 bytes and fits", async () => {
  // 80 lone surrogates: each one JSON-escapes to \uXXXX, 6 bytes, the most any character costs.
  const worst = await sealedMemo("\uD800".repeat(80));
  assert.equal(bytesOf(worst), 1739);
  // an older code with no chain pads up to the same size
  assert.equal(bytesOf(await sealedMemo("\uD800".repeat(80), undefined, undefined)), 1739);
  assert.equal(asMemo(worst), worst);
  // 80 emoji (4 bytes each), a note made of real characters: padded to the 1024-byte step.
  const emoji = await sealedMemo("\u{1F600}".repeat(80));
  assert.equal(bytesOf(emoji), 1535);
  assert.equal(asMemo(emoji), emoji);
  // No note at all: padded to the 512-byte step (any amount a note can hold, below 2^128).
  assert.equal(bytesOf(await sealedMemo("", ((1n << 128n) - 1n).toString())), 852);
  // A longer note is cut to 80 characters before it is sealed.
  assert.equal(bytesOf(await sealedMemo("\uD800".repeat(500))), 1739);
});

await test("sealed messages come in three sizes, whatever the amount and note (L-2)", async () => {
  // every amount a note can hold, 1 base unit to 2^128 - 1, no note: one size
  const amounts = ["1", "10000", "1000000", "100000000", "10000000000000", ((1n << 128n) - 1n).toString()];
  const noNote = new Set<number>();
  for (const w of amounts) noNote.add(bytesOf(await sealedMemo("", w)));
  assert.deepEqual([...noNote], [852]);
  // an amount no note can hold (2^256 - 1, refused when opened) still seals under the cap
  assert.ok(bytesOf(await sealedMemo("", (2n ** 256n - 1n).toString())) <= 1739);
  // any note: one of three sizes, and never past the largest a ticket was before
  const sizes = new Set<number>();
  for (const note of ["a", "rent", "x".repeat(20), "x".repeat(40), "x".repeat(80), "\u{1F600}".repeat(40), "\uD800".repeat(80)]) {
    for (const w of ["1", "100000000", (2n ** 256n - 1n).toString()]) sizes.add(bytesOf(await sealedMemo(note, w)));
  }
  assert.ok([...sizes].every((n) => n === 852 || n === 1535 || n === 1739), `sizes ${[...sizes].join(", ")}`);
});

await test("2048 bytes pass, 2049 and 8192 are refused as too large", () => {
  assert.equal(asMemo(memoOf(2048)), memoOf(2048));
  assert.throws(() => asMemo(memoOf(2049)), isRelayError("bad_request", 400, "The payment message is too large."));
  assert.throws(() => asMemo(memoOf(8192)), isRelayError("bad_request", 400, "The payment message is too large."));
});

await test("malformed memos are refused", () => {
  for (const bad of [undefined, 42, "", "0x", "0xabc", "abab", "0xzz", "0x" + "ab".repeat(10) + "g0"]) {
    assert.throws(() => asMemo(bad), isRelayError("bad_request", 400, "Invalid payment message."));
  }
});

await test("relay refuses an oversize memo before any chain call", async () => {
  reset();
  await assert.rejects(
    relayMemo(net, { paymentCommitment: H32, memo: memoOf(2049) }),
    isRelayError("bad_request", 400, "The payment message is too large.")
  );
  assert.deepEqual(calls, []);
});

await test("relay posts the largest real ticket end to end", async () => {
  reset();
  const worst = await sealedMemo("\uD800".repeat(80));
  assert.equal(await relayMemo(net, { paymentCommitment: H32, memo: worst }), TX_HASH);
  assert.equal(calls[0], "eth_call:commitmentSeen");
  assert.ok(calls.includes("eth_estimateGas") && calls.includes("eth_sendRawTransaction"));
});

// ---------------------------------------------------------------- lock, memory mode

await test("lock: ttl is 180 s and keys ignore nullifier case", () => {
  assert.equal(INFLIGHT_TTL_SEC, 180);
  const lower = "0x" + "ab".repeat(32);
  assert.equal(inflightKey(46630, lower), inflightKey(46630, lower.toUpperCase().replace("0X", "0x")));
  assert.notEqual(inflightKey(46630, lower), inflightKey(42431, lower));
});

await test("lock: second take refused, release lets the next one in", async () => {
  const key = inflightKey(net.chainId, nullifier());
  const a = await takeInflight(key);
  assert.ok(a);
  assert.equal(a.store, "memory");
  assert.equal(await takeInflight(key), null);
  assert.equal(await takeInflight(key), null);
  await a.release();
  const b = await takeInflight(key);
  assert.ok(b);
  await b.release();
});

await test("lock: expires after its ttl", async () => {
  const key = inflightKey(net.chainId, nullifier());
  const t0 = 1_700_000_000_000;
  assert.ok(await takeInflight(key, 2, t0));
  assert.equal(await takeInflight(key, 2, t0 + 1_999), null);
  const again = await takeInflight(key, 2, t0 + 2_000);
  assert.ok(again);
  await again.release();
});

await test("lock: a stale release leaves the newer holder alone", async () => {
  const key = inflightKey(net.chainId, nullifier());
  const t0 = 1_700_000_100_000;
  const old = await takeInflight(key, 1, t0);
  assert.ok(old);
  const newer = await takeInflight(key, 1, t0 + 1_000);
  assert.ok(newer);
  await old.release();
  assert.equal(await takeInflight(key, 1, t0 + 1_001), null);
  await newer.release();
  const next = await takeInflight(key, 1, t0 + 1_002);
  assert.ok(next);
  await next.release();
});

// ---------------------------------------------------------------- relay, one request per spend

await test("a copy of a proof being sent is refused with 409 before any chain call", async () => {
  reset();
  const nul = nullifier();
  const held = await takeInflight(inflightKey(net.chainId, nul));
  assert.ok(held);
  await assert.rejects(relayTransfer(net, transferBody(nul)), isRelayError("in_flight", 409, IN_FLIGHT_MESSAGE));
  await assert.rejects(relayUnshield(net, unshieldBody(nul, CLEAN)), isRelayError("in_flight", 409, IN_FLIGHT_MESSAGE));
  // Same nullifier in capitals is the same spend.
  await assert.rejects(
    relayTransfer(net, transferBody(nul.toUpperCase().replace("0X", "0x") as Hex)),
    isRelayError("in_flight", 409)
  );
  const res = await relayPost(req("http://localhost/api/relay", { chainId: net.chainId, action: "transfer", ...transferBody(nul) }));
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { ok: false, error: IN_FLIGHT_MESSAGE, code: "in_flight" });
  assert.deepEqual(calls, []);
  await held.release();
});

await test("send: spent check before the dry run; a spent note never reaches it and frees the lock", async () => {
  reset({ spent: true });
  const nul = nullifier();
  await assert.rejects(relayTransfer(net, transferBody(nul)), isRelayError("AlreadySpent", 409));
  assert.ok(calls.includes("eth_call:spent"));
  assert.ok(!calls.includes("eth_estimateGas"));
  assert.ok(await lockFree(nul));
});

await test("cash out: spent check before the dry run; a spent note never reaches it and frees the lock", async () => {
  reset({ spent: true });
  const nul = nullifier();
  await assert.rejects(relayUnshield(net, unshieldBody(nul, CLEAN)), isRelayError("AlreadySpent", 409));
  assert.ok(calls.includes("eth_call:spent"));
  assert.ok(!calls.includes("eth_estimateGas"));
  assert.ok(await lockFree(nul));
});

await test("an unknown root frees the lock", async () => {
  reset({ known: false });
  const nul = nullifier();
  await assert.rejects(relayTransfer(net, transferBody(nul)), isRelayError("UnknownRoot", 409));
  assert.ok(await lockFree(nul));
});

await test("a send the node refuses frees the lock, so the user can retry", async () => {
  reset({ send: "reject" });
  const nul = nullifier();
  await assert.rejects(relayTransfer(net, transferBody(nul)), isRelayError("relay_empty", 503));
  assert.ok(calls.indexOf("eth_call:spent") < calls.indexOf("eth_estimateGas"));
  assert.ok(calls.includes("eth_sendRawTransaction"));
  assert.ok(await lockFree(nul));
});

await test("send: once sent, the lock holds and a duplicate is refused without a chain call", async () => {
  reset();
  const nul = nullifier();
  assert.equal(await relayTransfer(net, transferBody(nul)), TX_HASH);
  const spentAt = calls.indexOf("eth_call:spent");
  assert.ok(spentAt >= 0 && spentAt < calls.indexOf("eth_estimateGas"));
  assert.ok(calls.indexOf("eth_estimateGas") < calls.indexOf("eth_sendRawTransaction"));
  calls.length = 0;
  await assert.rejects(relayTransfer(net, transferBody(nul)), isRelayError("in_flight", 409));
  assert.deepEqual(calls, []);
  assert.equal(await lockFree(nul), false);
});

// ---------------------------------------------------------------- a partner link's binding (V2, V3)

await test("V2: the before-broadcast hook runs once the checks, dry run and holds pass, just before the raw send; never for a refused request", async () => {
  // a send that goes out: called once, after the dry run, before the raw send
  reset();
  const seen: string[][] = [];
  assert.equal(await relayTransfer(net, transferBody(nullifier()), undefined, { beforeBroadcast: () => void seen.push([...calls]) }), TX_HASH);
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.includes("eth_estimateGas") && !seen[0]!.includes("eth_sendRawTransaction"));
  assert.ok(calls.includes("eth_sendRawTransaction"));
  // it is handed the call that goes out, so a binding names that exact payment (lib/partnerAttribution spendIdOf)
  reset();
  const handed: { to: string; data: Hex }[] = [];
  const nulA = nullifier();
  assert.equal(await relayUnshield(net, unshieldBody(nulA, CLEAN), undefined, { beforeBroadcast: (tx) => void handed.push(tx) }), TX_HASH);
  assert.equal(handed.length, 1);
  assert.equal(handed[0]!.to.toLowerCase(), POOL.toLowerCase());
  const id = spendIdOf(net, { to: handed[0]!.to, input: handed[0]!.data });
  assert.ok(id && id.nullifier.toLowerCase() === nulA.toLowerCase());
  // the same payment with another proof is the same payment; another recipient is not
  const call = (proof: Hex, to: Address) =>
    encodeFunctionData({ abi: relayPoolAbi, functionName: "unshield", args: [proof, H32, nulA, "0x0000000000000000000000000000000000000000", to, 1n] });
  assert.equal(spendIdOf(net, { to: POOL, input: call(("0x" + "33".repeat(256)) as Hex, CLEAN) })?.id, id.id);
  assert.notEqual(spendIdOf(net, { to: POOL, input: call(PROOF, "0x2222222222222222222222222222222222222222") })?.id, id.id);
  // what the hook returns is called when the send surely didn't go out (the node refused it), not when it went out
  let undone = 0;
  reset({ send: "reject" });
  await assert.rejects(relayTransfer(net, transferBody(nullifier()), undefined, { beforeBroadcast: () => () => void undone++ }), isRelayError("relay_empty", 503));
  assert.equal(undone, 1);
  reset();
  assert.equal(await relayTransfer(net, transferBody(nullifier()), undefined, { beforeBroadcast: () => () => void undone++ }), TX_HASH);
  assert.equal(undone, 1);
  // a send the node may have taken keeps it
  reset({ send: "drop" });
  await assert.rejects(relayTransfer(net, transferBody(nullifier()), undefined, { beforeBroadcast: () => () => void undone++ }), isRelayError("maybe_sent", 502, MAYBE_SENT_MESSAGE));
  assert.equal(undone, 1);
  // a hook that throws changes nothing about the send
  reset();
  assert.equal(await relayUnshield(net, unshieldBody(nullifier(), CLEAN), undefined, { beforeBroadcast: () => {
    throw new Error("store down");
  } }), TX_HASH);
  // refused before anything goes out: a spent note, an unknown root, a dry run that reverts, a spend in flight
  const never = () => assert.fail("the hook ran for a refused request");
  reset({ spent: true });
  await assert.rejects(relayTransfer(net, transferBody(nullifier()), undefined, { beforeBroadcast: never }), isRelayError("AlreadySpent", 409));
  reset({ known: false });
  await assert.rejects(relayUnshield(net, unshieldBody(nullifier(), CLEAN), undefined, { beforeBroadcast: never }), isRelayError("UnknownRoot", 409));
  reset({ estimate: "revert" });
  await assert.rejects(relayTransfer(net, transferBody(nullifier()), undefined, { beforeBroadcast: never }));
  assert.ok(!calls.includes("eth_sendRawTransaction"));
  reset();
  const nul = nullifier();
  const held = await takeInflight(inflightKey(net.chainId, nul));
  assert.ok(held);
  await assert.rejects(relayTransfer(net, transferBody(nul), undefined, { beforeBroadcast: never }), isRelayError("in_flight", 409));
  await held.release();
});

await test("V2, V3: a relay request with a partner's code that the relay refuses leaves nothing in the partner store", async () => {
  const p = await partners.upsertPartner("0x000000000000000000000000000000000000dEaD", { name: "Mallory" });
  const code = (await partnerLinks.issueLinkCode({ partnerId: p.id, by: "partner" })).code;
  const mem = (globalThis as { __gloamPartnersMem?: Map<string, unknown> }).__gloamPartnersMem;
  const bound = (nul: Hex) =>
    mem?.has(partnersKey("relayspendnf", net.chainId, linkNullifierHash(nul).toLowerCase())) ||
    [...(mem?.keys() ?? [])].some((key) => key.startsWith(partnersKey("relayspend", net.chainId) + ":"));
  const cases: [Partial<typeof chain>, string][] = [
    [{ spent: true }, "transfer"],
    [{ known: false }, "transfer"],
    [{ estimate: "revert" }, "transfer"],
    [{ spent: true }, "unshield"],
  ];
  for (const [state, action] of cases) {
    reset(state);
    const nul = nullifier();
    const body = action === "transfer" ? transferBody(nul) : unshieldBody(nul, CLEAN);
    const res = await relayPost(req("http://localhost/api/relay", { chainId: net.chainId, action, ...body, partnerCode: code }, `198.51.100.${n % 250}`));
    const out = (await res.json()) as { code?: string };
    console.log(`    ${action} ${JSON.stringify(state)}: ${res.status} ${out.code}`);
    assert.ok(calls.includes("eth_call:spent"), "the request reached the relay's checks");
    assert.ok(!calls.includes("eth_sendRawTransaction"));
    assert.equal(bound(nul), false, `${action} ${JSON.stringify(state)} bound a spend`);
  }
  // nor a request for a spend already in flight (a copy of a proof being sent)
  reset();
  const nul = nullifier();
  const held = await takeInflight(inflightKey(net.chainId, nul));
  assert.ok(held);
  const res = await relayPost(req("http://localhost/api/relay", { chainId: net.chainId, action: "transfer", ...transferBody(nul), partnerCode: code }));
  assert.equal(res.status, 409);
  assert.equal(bound(nul), false);
  await held.release();
});

await test("cash out: once sent, the lock holds; spent check came before the dry run", async () => {
  reset();
  const nul = nullifier();
  assert.equal(await relayUnshield(net, unshieldBody(nul, CLEAN)), TX_HASH);
  const spentAt = calls.indexOf("eth_call:spent");
  assert.ok(spentAt >= 0 && spentAt < calls.indexOf("eth_estimateGas"));
  await assert.rejects(relayUnshield(net, unshieldBody(nul, CLEAN)), isRelayError("in_flight", 409));
});

await test("a send that landed keeps the lock once its receipt is read", async () => {
  reset({ receipt: "success" });
  const nul = nullifier();
  assert.equal(await relayTransfer(net, transferBody(nul)), TX_HASH);
  await receiptRead();
  assert.deepEqual(receiptReads, [TX_HASH], "that send's own receipt");
  await assert.rejects(relayTransfer(net, transferBody(nul)), isRelayError("in_flight", 409));
  assert.equal(sends.length, 1);
});

await test("send: a reverted receipt frees the lock, so the note can move at once", async () => {
  reset({ receipt: "reverted" });
  const nul = nullifier();
  assert.equal(await relayTransfer(net, transferBody(nul)), TX_HASH);
  await receiptRead();
  assert.ok(await lockFree(nul));
  reset();
  assert.equal(await relayTransfer(net, transferBody(nul)), TX_HASH);
  assert.equal(sends.length, 1, "the next spend of the note goes out");
});

await test("cash out: a reverted receipt frees the lock", async () => {
  reset({ receipt: "reverted" });
  const nul = nullifier();
  assert.equal(await relayUnshield(net, unshieldBody(nul, CLEAN)), TX_HASH);
  await receiptRead();
  assert.ok(await lockFree(nul));
});

await test("no receipt yet: the reply doesn't wait for it, the lock holds, and a late reverted receipt frees it", async () => {
  reset({ receipt: "none" });
  const nul = nullifier();
  const res = await relayPost(req("http://localhost/api/relay", { chainId: net.chainId, action: "transfer", ...transferBody(nul) }, "203.0.113.60"));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { hash: Hex }).hash, TX_HASH);
  await receiptRead();
  await assert.rejects(relayTransfer(net, transferBody(nul)), isRelayError("in_flight", 409));
  chain.receipt = "error";
  await receiptRead(2);
  await assert.rejects(relayTransfer(net, transferBody(nul)), isRelayError("in_flight", 409));
  chain.receipt = "reverted";
  await receiptRead(3);
  assert.ok(await lockFree(nul));
  assert.equal(sends.length, 1);
});

await test("copies sent together: one goes out, and only a reverted receipt lets the next one try", async () => {
  reset({ receipt: "none" });
  const nul = nullifier();
  const tries = await Promise.allSettled(Array.from({ length: 6 }, () => relayTransfer(net, transferBody(nul))));
  assert.equal(tries.filter((t) => t.status === "fulfilled").length, 1);
  for (const t of tries) if (t.status === "rejected") isRelayError("in_flight", 409)(t.reason);
  assert.equal(sends.length, 1);
  await receiptRead();
  await assert.rejects(relayTransfer(net, transferBody(nul)), isRelayError("in_flight", 409));
  assert.equal(sends.length, 1, "still one out");
  chain.receipt = "reverted";
  await receiptRead(2);
  chain.receipt = "none";
  receiptReads.length = 0;
  const again = await Promise.allSettled(Array.from({ length: 6 }, () => relayTransfer(net, transferBody(nul))));
  assert.equal(again.filter((t) => t.status === "fulfilled").length, 1);
  assert.equal(sends.length, 2, "one more, and no more than one");
  await receiptRead();
  chain.receipt = "success";
});

await test("a spent or stale note still costs nothing after a reverted receipt", async () => {
  reset({ receipt: "reverted" });
  const nul = nullifier();
  assert.equal(await relayTransfer(net, transferBody(nul)), TX_HASH);
  await receiptRead();
  chain.spent = true;
  calls.length = 0;
  await assert.rejects(relayTransfer(net, transferBody(nul)), isRelayError("AlreadySpent", 409));
  assert.ok(!calls.includes("eth_estimateGas"));
  assert.equal(sends.length, 1);
});

await test("a send with no hash never reads a receipt, and keeps the lock even if the chain shows a revert", async () => {
  reset({ send: "drop", receipt: "reverted" });
  const nul = nullifier();
  await assert.rejects(relayTransfer(net, transferBody(nul)), isRelayError("maybe_sent", 502, MAYBE_SENT_MESSAGE));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(receiptReads, []);
  assert.equal(await lockFree(nul), false);
});

await test("the watch only ever frees on a reverted receipt, and gives up keeping the lock", async () => {
  const held = async (outcome: () => Promise<"success" | "reverted" | null>) => {
    const key = inflightKey(net.chainId, nullifier());
    const lock = await takeInflight(key);
    assert.ok(lock);
    let reads = 0;
    await releaseIfReverted(
      lock,
      () => {
        reads++;
        return outcome();
      },
      30,
      5,
    );
    const free = await takeInflight(key);
    await free?.release();
    return { free: free !== null, reads };
  };
  const neverAnswers = await held(async () => null);
  assert.equal(neverAnswers.free, false, "a timeout frees nothing");
  assert.ok(neverAnswers.reads > 1, "it kept looking until the time ran out");
  const failing = await held(async () => {
    throw new Error("rpc down");
  });
  assert.equal(failing.free, false, "a read that fails frees nothing");
  assert.ok(failing.reads > 1);
  assert.deepEqual(await held(async () => "success"), { free: false, reads: 1 });
  assert.deepEqual(await held(async () => "reverted"), { free: true, reads: 1 });
});

await test("a reverted receipt read after the lock lapsed leaves the newer holder alone", async () => {
  const key = inflightKey(net.chainId, nullifier());
  const t0 = Date.now();
  const old = await takeInflight(key, 1, t0);
  assert.ok(old);
  const newer = await takeInflight(key, 1, t0 + 1_000);
  assert.ok(newer);
  await releaseIfReverted(old, async () => "reverted");
  assert.equal(await takeInflight(key, 1, t0 + 1_001), null, "the newer holder keeps it");
  await newer.release();
});

await test("a send that may have gone out (dropped connection) is maybe_sent, sent once, and keeps the lock", async () => {
  reset({ send: "drop" });
  const nul = nullifier();
  await assert.rejects(relayTransfer(net, transferBody(nul)), isRelayError("maybe_sent", 502, MAYBE_SENT_MESSAGE));
  // viem's message lists the request, "nonce" included: that is no reason to send a second copy
  assert.deepEqual(sends, ["public"]);
  assert.equal(await lockFree(nul), false);
});

await test("a 502 on the send is maybe_sent and never sent again", async () => {
  reset({ send: "http502" });
  const nul = nullifier();
  await assert.rejects(relayTransfer(net, transferBody(nul)), isRelayError("maybe_sent", 502, MAYBE_SENT_MESSAGE));
  assert.deepEqual(sends, ["public"]);
  assert.equal(await lockFree(nul), false);
});

await test("'already known' means the node holds it: maybe_sent, never sent again", async () => {
  reset({ send: "known" });
  const nul = nullifier();
  await assert.rejects(relayTransfer(net, transferBody(nul)), isRelayError("maybe_sent", 502, MAYBE_SENT_MESSAGE));
  assert.deepEqual(sends, ["public"]);
  assert.equal(await lockFree(nul), false);
});

await test("a real nonce clash from the node is retried once from the chain's nonce", async () => {
  reset({ send: "nonce_once" });
  const nul = nullifier();
  assert.equal(await relayTransfer(net, transferBody(nul)), TX_HASH);
  assert.deepEqual(sends, ["public", "public"]);
  // the second send read the nonce from the chain again
  assert.ok(calls.lastIndexOf("eth_getTransactionCount") > calls.indexOf("eth_sendRawTransaction"));
});

await test("private RPC took the send and dropped: never replayed on the public RPC, maybe_sent, lock kept", async () => {
  await withPrivateRpc(async () => {
    reset({ send: "private_took" });
    const nul = nullifier();
    await assert.rejects(relayTransfer(net, transferBody(nul)), isRelayError("maybe_sent", 502, MAYBE_SENT_MESSAGE));
    assert.deepEqual(sends, ["private"]);
    assert.equal(await lockFree(nul), false);
  });
});

await test("sendOnce: the public backup answers reads but never gets a raw send", async () => {
  await withPrivateRpc(async () => {
    reset({ send: "private_took" });
    const raw = ("0x" + "02".repeat(100)) as Hex;
    const once = serverTransport(net, { retryCount: 0 }, { sendOnce: true })({ chain: net.chain });
    await assert.rejects(once.request({ method: "eth_sendRawTransaction", params: [raw] }));
    assert.deepEqual(sends, ["private"]);
    // reads still fall back: the private RPC is down for reads too here, and the public one answers
    const down = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(PRIVATE_RPC)) throw new TypeError("fetch failed");
      return down(input, init);
    }) as typeof fetch;
    try {
      assert.equal(await once.request({ method: "eth_chainId" }), toHex(net.chainId));
    } finally {
      globalThis.fetch = down;
    }
    // without sendOnce (server reads), the public RPC stays a full backup
    // (checked afresh: the failed reads above have the private RPC passed over for a while)
    resetRpcChecks();
    sends.length = 0;
    const reads = serverTransport(net, { retryCount: 0 })({ chain: net.chain });
    await assert.rejects(reads.request({ method: "eth_sendRawTransaction", params: [raw] }));
    assert.deepEqual(sends, ["private", "public"]);
  });
});

// ---------------------------------------------------------------- payment message tickets (M-2, L-3)

const MEMO_SECRET = "selftest-memo-secret-" + "x".repeat(32);
/** A fresh payment commitment per case, so message counts from one case never touch another. */
function payment(): Hex {
  n++;
  return `0x${(0xc000_0000 + n).toString(16).padStart(64, "0")}` as Hex;
}
const memoBody = (c: Hex, extra: Record<string, unknown> = {}) => ({ chainId: net.chainId, action: "memo", paymentCommitment: c, memo: memoOf(64), ...extra });
const transferTo = (c: Hex) => ({ chainId: net.chainId, action: "transfer", ...transferBody(nullifier()), commitments: [c, H32] });

async function post(ip: string, body: unknown) {
  const res = await relayPost(req("http://localhost/api/relay", body, ip));
  return { status: res.status, json: (await res.json()) as { ok: boolean; code?: string; hash?: Hex; memoTicket?: string | null } };
}

function withMemoSecret(secret: string | undefined) {
  if (secret === undefined) delete process.env.GLOAM_RELAY_MEMO_SECRET;
  else process.env.GLOAM_RELAY_MEMO_SECRET = secret;
}

await test("memo ticket: a relayed transfer hands back one for its payment, and only for it", async () => {
  withMemoSecret(MEMO_SECRET);
  reset();
  const pay = payment();
  const { status, json } = await post("203.0.113.9", transferTo(pay));
  assert.equal(status, 200);
  assert.equal(json.hash, TX_HASH);
  assert.ok(json.memoTicket && /^[A-Za-z0-9_-]{43}$/.test(json.memoTicket), "a 32-byte base64url ticket");
  assert.equal(json.memoTicket, memoTicket(net.chainId, pay));
  assert.equal(memoTicket(net.chainId, pay.toUpperCase().replace("0X", "0x")), json.memoTicket, "any case");
  assert.notEqual(memoTicket(net.chainId, payment()), json.memoTicket);
  assert.notEqual(memoTicket(net.chainId + 1, pay), json.memoTicket);
});

await test("memo DoS: 40 strangers can't block the payer's ticketed heads-up", async () => {
  withMemoSecret(MEMO_SECRET);
  reset();
  const pay = payment();
  const ticket = (await post("203.0.113.9", transferTo(pay))).json.memoTicket!;
  let accepted = 0;
  for (let i = 0; i < 40; i++) {
    const r = await post(`198.51.100.${i + 1}`, memoBody(pay));
    if (r.status === 200) accepted++;
    else assert.deepEqual([r.status, r.json.code], [409, "memo_sent"]);
  }
  assert.equal(accepted, 10, "strangers share a small allowance per payment");
  // a made-up ticket, or another payment's, is a stranger's
  assert.equal((await post("198.51.100.99", memoBody(pay, { ticket: memoTicket(net.chainId, payment()) }))).status, 409);
  assert.equal((await post("198.51.100.99", memoBody(pay, { ticket: "A".repeat(43) }))).status, 409);
  assert.equal((await post("198.51.100.99", memoBody(pay, { ticket: 42 }))).status, 409);
  // the payer's own few, from any IP
  for (const ip of ["203.0.113.9", "203.0.113.10", "2001:db8::1"]) {
    const r = await post(ip, memoBody(pay, { ticket }));
    assert.equal(r.status, 200);
    assert.equal(r.json.hash, TX_HASH);
  }
  assert.equal((await post("203.0.113.9", memoBody(pay, { ticket }))).status, 409, "and only a few");
});

await test("partner accounts keep their own few per payment, apart from strangers and each other", async () => {
  withMemoSecret(MEMO_SECRET);
  reset();
  const pay = payment();
  const body = { paymentCommitment: pay, memo: memoOf(64) };
  for (let i = 0; i < 10; i++) assert.equal(await relayMemo(net, body), TX_HASH);
  await assert.rejects(relayMemo(net, body), isRelayError("memo_sent", 409));
  for (const from of [{ partner: "ptr_a1b2c3", approved: true }, { partner: "ptr_d4e5f6", approved: false }]) {
    for (let i = 0; i < 3; i++) assert.equal(await relayMemo(net, body, from), TX_HASH);
    await assert.rejects(relayMemo(net, body, from), isRelayError("memo_sent", 409));
    // the same account through another key, or approved since: still the same few
    await assert.rejects(relayMemo(net, body, { ...from, approved: !from.approved }), isRelayError("memo_sent", 409));
  }
});

await test("memo budgets: an account no admin approved shares one budget with every such account, strangers' size, never the paid one", async () => {
  withMemoSecret(MEMO_SECRET);
  reset();
  const counts = (globalThis as { __gloamMcpRate?: Map<string, { n: number }> }).__gloamMcpRate!;
  for (const k of [...counts.keys()]) if (/:relay-(?:net|memo)/.test(k)) counts.delete(k);
  const sum = (bucket: string) => [...counts.entries()].filter(([k]) => k.includes(`:${bucket}:`)).reduce((a, [, v]) => a + v.n, 0);
  // many accounts, three messages a payment each, over many payments
  let accepted = 0;
  let refused = 0;
  for (let p = 0; p < 400 && refused === 0; p++) {
    const pay = payment();
    for (let a = 0; a < 3 && refused === 0; a++) {
      try {
        await relayMemo(net, { paymentCommitment: pay, memo: memoOf(64) }, { partner: `ptr_free${p % 50}x${a}`, approved: false });
        accepted++;
      } catch (e) {
        assert.ok(isRelayError("memo_busy", 429)(e), String(e));
        refused++;
      }
    }
  }
  assert.equal(accepted, 600, "the same size as the budget for messages with no key");
  assert.equal(sum("relay-memo-key-net"), 600, "the one turned away was given back");
  assert.equal(sum("relay-memo-net"), 0, "none from the paid budget");
  assert.equal(sum("relay-memo-open-net"), 0, "nor the strangers' one");
  // strangers, the payer's ticket and an approved account all still go
  const pay = payment();
  assert.equal(await relayMemo(net, { paymentCommitment: pay, memo: memoOf(64) }), TX_HASH);
  assert.equal(await relayMemo(net, { paymentCommitment: pay, memo: memoOf(64), ticket: memoTicket(net.chainId, pay) }), TX_HASH);
  assert.equal(await relayMemo(net, { paymentCommitment: pay, memo: memoOf(64) }, { partner: "ptr_approved1", approved: true }), TX_HASH);
  assert.equal(sum("relay-memo-net"), 2);
  for (const k of [...counts.keys()]) if (/:relay-(?:net|memo)/.test(k)) counts.delete(k);
});

await test("no memo limit keys on the poster's IP", async () => {
  withMemoSecret(MEMO_SECRET);
  reset();
  const counts = (globalThis as { __gloamMcpRate?: Map<string, unknown> }).__gloamMcpRate!;
  const memoKeys = () => [...counts.keys()].filter((k) => /:relay-memo(?:-all)?:/.test(k));
  const before = new Set(memoKeys());
  const added = () => memoKeys().filter((k) => !before.has(k)).length;
  const ips = ["198.51.100.1", "198.51.100.2", "2a01:4f8:c17:1234::1", "2a01:dead:beef::1"];
  const pay = payment();
  for (const ip of ips) await post(ip, memoBody(pay));
  // strangers: one shared count, whoever posted from where
  assert.equal(added(), 1);
  const ticket = memoTicket(net.chainId, pay)!;
  for (const ip of ips) await post(ip, memoBody(pay, { ticket }));
  // and one for the payer
  assert.equal(added(), 2);
});

await test("memo budget (GHSA-5gwv-jpjr-x34r): strangers' messages can't use up the network's sends", async () => {
  withMemoSecret(MEMO_SECRET);
  reset();
  const counts = (globalThis as { __gloamMcpRate?: Map<string, { n: number }> }).__gloamMcpRate!;
  for (const k of [...counts.keys()]) if (/:relay-(?:net|memo)/.test(k)) counts.delete(k);
  const spendSlots = () => [...counts.entries()].filter(([k]) => /:relay-net:/.test(k)).reduce((a, [, v]) => a + v.n, 0);
  // spread over many payments, as an attacker reading /api/vault-leaves would
  let accepted = 0;
  let refused = 0;
  for (let p = 0; p < 80 && refused === 0; p++) {
    const pay = payment();
    for (let i = 0; i < 10; i++) {
      try {
        await relayMemo(net, { paymentCommitment: pay, memo: memoOf(64) });
        accepted++;
      } catch (e) {
        assert.ok(isRelayError("memo_busy", 429)(e));
        refused++;
        break;
      }
    }
  }
  assert.ok(refused > 0, `strangers' messages stop at their own hourly budget (accepted ${accepted})`);
  assert.equal(spendSlots(), 0, "no stranger message took a send's slot");
  // sends still go, and the payer's ticketed heads-up and a partner key's still go
  const pay = payment();
  const { status, json } = await post("203.0.113.9", transferTo(pay));
  assert.equal(status, 200);
  assert.equal(spendSlots(), 1);
  assert.equal(await relayMemo(net, { paymentCommitment: pay, memo: memoOf(64), ticket: json.memoTicket }), TX_HASH);
  assert.equal(await relayMemo(net, { paymentCommitment: pay, memo: memoOf(64) }, { partner: "ptr_budget1", approved: true }), TX_HASH);
  assert.equal(spendSlots(), 1, "messages never count as sends");
  for (const k of [...counts.keys()]) if (/:relay-(?:net|memo)/.test(k)) counts.delete(k);
});

await test("app client: keeps the transfer's ticket and sends it with that payment's message", async () => {
  withMemoSecret(MEMO_SECRET);
  reset();
  const pay = payment();
  // strangers used up the shared allowance first
  for (let i = 0; i < 10; i++) await relayMemo(net, { paymentCommitment: pay, memo: memoOf(64) });
  const sent = await relayClient.relayTransfer({ chainId: net.chainId, proof: PROOF, root: H32, nullifier: nullifier(), commitments: [pay, H32] });
  assert.equal(sent, TX_HASH);
  assert.equal(await relayClient.relayMemo({ chainId: net.chainId, paymentCommitment: pay, memo: memoOf(64) }), TX_HASH);
  // a payment this browser never relayed has no ticket: a stranger's share, used up here
  const other = payment();
  for (let i = 0; i < 10; i++) await relayMemo(net, { paymentCommitment: other, memo: memoOf(64) });
  await assert.rejects(
    relayClient.relayMemo({ chainId: net.chainId, paymentCommitment: other, memo: memoOf(64) }),
    (e: unknown) => e instanceof relayClient.RelaySubmitError && e.code === "memo_sent"
  );
});

await test("app client: a heads-up the relay's node has not seen yet is tried again, other refusals are not", async () => {
  reset();
  const keep = { ...relayClient.MEMO_NOT_SEEN_RETRY };
  relayClient.MEMO_NOT_SEEN_RETRY.delayMs = 0;
  const real = globalThis.fetch;
  let refusals = 0;
  let memoPosts = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/relay") && init?.body && String(init.body).includes('"action":"memo"')) {
      memoPosts++;
      if (refusals > 0) {
        refusals--;
        return new Response(JSON.stringify({ ok: false, error: "That payment is not in the vault yet.", code: "not_seen" }), { status: 409 });
      }
    }
    return real(input, init);
  }) as typeof fetch;
  try {
    refusals = 2;
    assert.equal(await relayClient.relayMemo({ chainId: net.chainId, paymentCommitment: payment(), memo: memoOf(64) }), TX_HASH);
    assert.equal(memoPosts, 3, "two not_seen answers, then it goes");
    memoPosts = 0;
    refusals = 5;
    await assert.rejects(
      relayClient.relayMemo({ chainId: net.chainId, paymentCommitment: payment(), memo: memoOf(64) }),
      (e: unknown) => e instanceof relayClient.RelaySubmitError && e.code === "not_seen"
    );
    assert.equal(memoPosts, 3, "three tries at most");
  } finally {
    globalThis.fetch = real;
    Object.assign(relayClient.MEMO_NOT_SEEN_RETRY, keep);
  }
});

await test("no secret: no ticket is handed out, and everyone but partner keys shares the small allowance", async () => {
  for (const secret of [undefined, "", "too-short-to-trust"]) {
    withMemoSecret(secret);
    reset();
    const pay = payment();
    assert.equal(memoTicket(net.chainId, pay), null);
    assert.equal((await post("203.0.113.9", transferTo(pay))).json.memoTicket, null);
    // a ticket made with the secret once set opens nothing now
    withMemoSecret(MEMO_SECRET);
    const old = memoTicket(net.chainId, pay);
    withMemoSecret(secret);
    for (let i = 0; i < 10; i++) assert.equal((await post(`198.51.100.${i + 1}`, memoBody(pay, { ticket: old }))).status, 200);
    assert.equal((await post("203.0.113.9", memoBody(pay, { ticket: old }))).status, 409);
    assert.equal(await relayMemo(net, { paymentCommitment: pay, memo: memoOf(64) }, { partner: "ptr_a1b2c3", approved: false }), TX_HASH);
  }
  withMemoSecret(undefined);
});

// ---------------------------------------------------------------- cash out to the vault

await test("shared check: vault and memo board refused, any case; wallets pass", () => {
  assert.equal(cashOutTargetProblem(POOL, net), CASH_OUT_TO_VAULT_MESSAGE);
  assert.equal(cashOutTargetProblem(POOL.toLowerCase(), net), CASH_OUT_TO_VAULT_MESSAGE);
  assert.equal(cashOutTargetProblem(getAddress(POOL), net), CASH_OUT_TO_VAULT_MESSAGE);
  assert.equal(cashOutTargetProblem(BOARD.toLowerCase(), net), CASH_OUT_TO_BOARD_MESSAGE);
  assert.equal(cashOutTargetProblem(CLEAN, net), null);
  assert.equal(cashOutTargetProblem(CLEAN, { chainId: net.chainId, pool: null, payMemo: null }), null);
  assert.equal(CASH_OUT_TO_VAULT_MESSAGE, "That address is the vault itself. Cash out to a wallet you control.");
});

const NETWORK_KEYS = [
  "robinhood", "tempo", "base", "ethereum", "robinhood-mainnet", "tempo-mainnet", "base-mainnet", "ethereum-mainnet",
] as const;

await test("shared check: the zero address, a listed token and a swap router are refused, any case, on every network", () => {
  const ZERO = "0x0000000000000000000000000000000000000000";
  for (const key of NETWORK_KEYS) {
    const n = getNetwork(key);
    assert.equal(cashOutTargetProblem(ZERO, n), CASH_OUT_TO_ZERO_MESSAGE, key);
    const tokens = [...shieldTokensFor(n.chainId)];
    if (n.chainId === 4663) tokens.push(...RH_MAINNET_SWAP_TOKENS);
    for (const t of tokens) {
      assert.equal(cashOutTargetProblem(t.address, n), CASH_OUT_TO_TOKEN_MESSAGE, `${t.symbol} on ${key}`);
      assert.equal(cashOutTargetProblem(t.address.toLowerCase(), n), CASH_OUT_TO_TOKEN_MESSAGE);
    }
    for (const r of swapRoutersOn(n.chainId)) {
      assert.equal(cashOutTargetProblem(r.address, n), CASH_OUT_TO_ROUTER_MESSAGE, `${r.address} on ${key}`);
      assert.equal(cashOutTargetProblem(r.address.toLowerCase(), n), CASH_OUT_TO_ROUTER_MESSAGE);
      // what the router swaps between, and the WETH it holds, are tokens (a native ETH note's address(0) is not)
      for (const a of [...r.assets.filter((x) => BigInt(x) !== 0n), ...(r.weth ? [r.weth] : [])]) assert.equal(cashOutTargetProblem(a, n), CASH_OUT_TO_TOKEN_MESSAGE, `${a} on ${key}`);
    }
  }
  // Both Robinhood Chain routers (the one new swaps use and the older one kept for refunds) and Tempo's are covered.
  assert.ok(swapRoutersOn(4663).length >= 2 && swapRoutersOn(4217).length >= 1);
});

await test("shared check: an agent on the SDK alone is refused every address the app refuses", () => {
  for (const key of NETWORK_KEYS) {
    const n = getNetwork(key);
    const alone = (to: string) => sdkCashOutTargetProblem(to, { chainId: n.chainId });
    const routers = swapRoutersOn(n.chainId);
    const tokens = [...shieldTokensFor(n.chainId).map((t) => t.address), ...routers.flatMap((r) => [...r.assets.filter((x) => BigInt(x) !== 0n), ...(r.weth ? [r.weth] : [])])];
    if (n.chainId === 4663) tokens.push(...RH_MAINNET_SWAP_TOKENS.map((t) => t.address));
    assert.ok(tokens.length > 0, key);
    assert.equal(alone(n.pool!), CASH_OUT_TO_VAULT_MESSAGE, key);
    assert.equal(alone(n.payMemo!.address), CASH_OUT_TO_BOARD_MESSAGE, key);
    for (const r of routers) assert.equal(alone(r.address), CASH_OUT_TO_ROUTER_MESSAGE, `${r.address} on ${key}`);
    for (const a of tokens) assert.equal(alone(a), CASH_OUT_TO_TOKEN_MESSAGE, `${a} on ${key}`);
  }
});

await test("shared check: wallets are never refused, and a token of another chain is just an address", () => {
  const rh = getNetwork("robinhood-mainnet");
  const tempo = getNetwork("tempo-mainnet");
  // an address one hex digit off a listed token or a router is a different address
  const off = (a: string) => `${a.slice(0, -1)}${a.endsWith("1") ? "2" : "1"}`;
  const wallets = [CLEAN, "0x00000000000000000000000000000000000000a1", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", off(RH_MAINNET_TOKENS[0]!.address), off(swapRoutersOn(4663)[0]!.address)];
  for (const key of NETWORK_KEYS) for (const w of wallets) assert.equal(cashOutTargetProblem(w, getNetwork(key)), null, `${w} on ${key}`);
  assert.equal(cashOutTargetProblem(RH_MAINNET_TOKENS[0]!.address, tempo), null);
  assert.equal(cashOutTargetProblem(TEMPO_MAINNET_TOKENS[0]!.address, rh), null);
});

await test("relay refuses a cash out to a token contract, a swap router or the zero address before any chain call or lock", async () => {
  reset();
  const rh = getNetwork("robinhood-mainnet");
  const cases: [typeof net, string, string][] = [
    [net, shieldTokensFor(net.chainId)[0]!.address, CASH_OUT_TO_TOKEN_MESSAGE],
    [net, "0x0000000000000000000000000000000000000000", CASH_OUT_TO_ZERO_MESSAGE],
    [rh, RH_MAINNET_TOKENS[0]!.address.toLowerCase(), CASH_OUT_TO_TOKEN_MESSAGE],
    [rh, swapRoutersOn(rh.chainId)[0]!.address, CASH_OUT_TO_ROUTER_MESSAGE],
    [rh, swapRoutersOn(rh.chainId)[1]!.address, CASH_OUT_TO_ROUTER_MESSAGE],
  ];
  for (const [n, to, message] of cases) {
    const nul = nullifier();
    await assert.rejects(relayUnshield(n, unshieldBody(nul, to)), isRelayError("vault_recipient", 400, message));
    assert.ok(await lockFree(nul));
  }
  assert.deepEqual(calls, []);
});

await test("relay refuses a cash out to the vault before any chain call or lock", async () => {
  reset();
  for (const to of [POOL, POOL.toLowerCase(), getAddress(POOL)]) {
    const nul = nullifier();
    await assert.rejects(relayUnshield(net, unshieldBody(nul, to)), isRelayError("vault_recipient", 400, CASH_OUT_TO_VAULT_MESSAGE));
    assert.ok(await lockFree(nul));
  }
  await assert.rejects(
    relayUnshield(net, unshieldBody(nullifier(), BOARD)),
    isRelayError("vault_recipient", 400, CASH_OUT_TO_BOARD_MESSAGE)
  );
  assert.deepEqual(calls, []);
});

await test("relay route answers 400 vault_recipient for a cash out to the vault", async () => {
  reset();
  const res = await relayPost(
    req("http://localhost/api/relay", { chainId: net.chainId, action: "unshield", ...unshieldBody(nullifier(), POOL) })
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, error: CASH_OUT_TO_VAULT_MESSAGE, code: "vault_recipient" });
  assert.deepEqual(calls, []);
});

await test("a private RPC that answers for another chain: reads go to the public RPC, a send is refused", async () => {
  const name = `GLOAM_RPC_URL_${net.chainId}`;
  process.env[name] = WRONG_RPC;
  try {
    reset();
    wrongCalls.length = 0;
    const nul = nullifier();
    await assert.rejects(relayUnshield(net, unshieldBody(nul, CLEAN)), isRelayError("relay_off", 503));
    // nothing but the chain id check reached the wrong node, and no node got a raw send
    assert.deepEqual(wrongCalls.filter((m) => m !== "eth_chainId"), [], `the wrong chain was asked: ${wrongCalls.join(", ")}`);
    assert.deepEqual(sends, []);
    // the spent check and the dry run were answered by this chain's public RPC
    assert.ok(calls.includes("eth_call:spent") && calls.includes("eth_estimateGas"));
    assert.equal(await lockFree(nul), true, "nothing went out, so the spend is free to retry");
    // a server read through the same transport: this chain's answer, from the public RPC
    wrongCalls.length = 0;
    const reads = serverTransport(net, { retryCount: 0 })({ chain: net.chain });
    assert.equal(await reads.request({ method: "eth_chainId" }), toHex(net.chainId));
    assert.deepEqual(wrongCalls.filter((m) => m !== "eth_chainId"), []);
  } finally {
    delete process.env[name];
  }
});

await test("a private RPC that has not answered eth_chainId is passed over: reads and the relay's one send go to the public RPC, until it says this chain", async () => {
  const name = `GLOAM_RPC_URL_${net.chainId}`;
  process.env[name] = UNCHECKED_RPC;
  try {
    reset();
    resetRpcChecks();
    unchecked.says = null;
    unchecked.calls.length = 0;
    const others = () => unchecked.calls.filter((m) => m !== "eth_chainId");
    const asked = () => unchecked.calls.filter((m) => m === "eth_chainId").length;
    // a relayed cash out goes out, once, through the public RPC; the unchecked node only got eth_chainId
    const nul = nullifier();
    assert.equal(await relayUnshield(net, unshieldBody(nul, CLEAN)), TX_HASH);
    assert.deepEqual(sends, ["public"]);
    assert.deepEqual(others(), [], `the unchecked node was asked: ${unchecked.calls.join(", ")}`);
    assert.equal(asked(), 1, "one check with no answer, then the node is passed over for a while");
    assert.equal(await lockFree(nul), false, "a transaction went out, so the spend stays locked");
    // reads in that while go to the public RPC without asking it again
    const reads = serverTransport(net, { retryCount: 0 })({ chain: net.chain });
    assert.equal(await reads.request({ method: "eth_blockNumber" }), "0x1");
    assert.equal(asked(), 1);
    // a raw send through the relay's transport: once, to the public RPC
    sends.length = 0;
    const once = serverTransport(net, { retryCount: 0 }, { sendOnce: true })({ chain: net.chain });
    assert.equal(await once.request({ method: "eth_sendRawTransaction", params: [("0x" + "02".repeat(100)) as Hex] }), TX_HASH);
    assert.deepEqual(sends, ["public"]);
    assert.deepEqual(others(), []);
    // after the while it is asked again; once it says this chain, it is used
    resetRpcChecks();
    unchecked.says = net.chainId;
    assert.equal(await reads.request({ method: "eth_blockNumber" }), "0xdead");
    assert.deepEqual(others(), ["eth_blockNumber"]);
  } finally {
    unchecked.says = null;
    resetRpcChecks();
    delete process.env[name];
  }
});

await test("a private RPC that hangs costs one short wait: the read and the send go to the public RPC, the send once", async () => {
  const name = `GLOAM_RPC_URL_${net.chainId}`;
  process.env[name] = HUNG_RPC;
  try {
    reset();
    resetRpcChecks();
    hung.length = 0;
    const t0 = Date.now();
    const reads = serverTransport(net, { timeout: 300, retryCount: 0 })({ chain: net.chain });
    assert.equal(await reads.request({ method: "eth_blockNumber" }), "0x1");
    const once = serverTransport(net, { timeout: 300, retryCount: 0 }, { sendOnce: true })({ chain: net.chain });
    assert.equal(await once.request({ method: "eth_sendRawTransaction", params: [("0x" + "02".repeat(100)) as Hex] }), TX_HASH);
    assert.deepEqual(sends, ["public"]);
    assert.deepEqual(hung, ["eth_chainId"], "asked once, then passed over");
    assert.ok(Date.now() - t0 < 2_000, `took ${Date.now() - t0} ms`);
    // a send to the public RPC that may have gone out is still maybe_sent, and never sent again
    reset({ send: "drop" });
    const nul = nullifier();
    await assert.rejects(relayTransfer(net, transferBody(nul)), isRelayError("maybe_sent", 502, MAYBE_SENT_MESSAGE));
    assert.deepEqual(sends, ["public"]);
    assert.equal(await lockFree(nul), false);
  } finally {
    resetRpcChecks();
    delete process.env[name];
  }
});

await test("a private RPC that said this chain and then fails is passed over too: the failed read goes on to the public RPC, the next calls skip it, a send it may have taken is never sent again", async () => {
  const name = `GLOAM_RPC_URL_${net.chainId}`;
  process.env[name] = FLAKY_RPC;
  try {
    reset();
    resetRpcChecks();
    flaky.calls.length = 0;
    const others = () => flaky.calls.filter((m) => m !== "eth_chainId");
    // a healthy check, then a 503 on the read itself: answered by the public RPC in the same call
    flaky.mode = "503";
    const reads = serverTransport(net, { timeout: 300, retryCount: 1 })({ chain: net.chain });
    assert.equal(await reads.request({ method: "eth_blockNumber" }), "0x1");
    assert.deepEqual(flaky.calls, ["eth_chainId", "eth_blockNumber"], "asked once, not once per retry");
    // passed over now: reads and the relay's one send go to the public RPC without asking it
    flaky.mode = "ok";
    assert.equal(await reads.request({ method: "eth_blockNumber" }), "0x1");
    const once = serverTransport(net, { timeout: 300, retryCount: 0 }, { sendOnce: true })({ chain: net.chain });
    assert.equal(await once.request({ method: "eth_sendRawTransaction", params: [("0x" + "02".repeat(100)) as Hex] }), TX_HASH);
    assert.deepEqual(sends, ["public"]);
    assert.deepEqual(others(), ["eth_blockNumber"]);
    // checked again after the pause, and used once it says this chain
    resetRpcChecks();
    assert.equal(await reads.request({ method: "eth_blockNumber" }), "0xbeef");

    // a send it takes and never answers: one timeout, maybe_sent, never handed to the public RPC
    resetRpcChecks();
    reset();
    flaky.calls.length = 0;
    flaky.mode = "hang";
    const t0 = Date.now();
    const sendOnce = serverTransport(net, { timeout: 300, retryCount: 0 }, { sendOnce: true })({ chain: net.chain });
    const err = await sendOnce.request({ method: "eth_sendRawTransaction", params: [("0x" + "03".repeat(100)) as Hex] }).then(
      () => assert.fail("the hung send answered"),
      (e: unknown) => e
    );
    assert.equal(sendFailure(err).code, "maybe_sent");
    assert.deepEqual(sends, [], "a send the private RPC may hold never goes to the public RPC");
    assert.deepEqual(others(), ["eth_sendRawTransaction"]);
    assert.ok(Date.now() - t0 < 2_000, `took ${Date.now() - t0} ms`);
    // the next send (a new one) skips it and goes out once, through the public RPC
    assert.equal(await sendOnce.request({ method: "eth_sendRawTransaction", params: [("0x" + "04".repeat(100)) as Hex] }), TX_HASH);
    assert.deepEqual(sends, ["public"]);
    assert.deepEqual(others(), ["eth_sendRawTransaction"]);
  } finally {
    flaky.mode = "ok";
    resetRpcChecks();
    delete process.env[name];
  }
});

// ---------------------------------------------------------------- Redis down (M-1)

/** Runs `fn` with the fake Redis set as the shared store, and counts the outage logs. */
async function withRedis(fn: (logs: { down: () => number; back: () => number }) => Promise<void>) {
  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = "selftest-token";
  const err = console.error;
  const info = console.info;
  const lines: string[] = [];
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.info = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await fn({
      down: () => lines.filter((l) => l.includes("gloam_relay_store_down")).length,
      back: () => lines.filter((l) => l.includes("gloam_relay_store_back")).length,
    });
  } finally {
    console.error = err;
    console.info = info;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    redisState.mode = "up";
  }
}

const relayOff = (e: unknown) =>
  isRelayError("relay_off", 503, "The relay is off on this network right now. Send from your wallet.")(e);

await test("Redis set but not answering: every relayed send is refused relay_off before any chain call, logged once", async () => {
  await withRedis(async (logs) => {
    redisState.mode = "down";
    reset();
    for (const body of [
      { chainId: net.chainId, action: "transfer", ...transferBody(nullifier()) },
      { chainId: net.chainId, action: "unshield", ...unshieldBody(nullifier(), CLEAN) },
      { chainId: net.chainId, action: "memo", paymentCommitment: H32, memo: memoOf(64) },
    ]) {
      const res = await relayPost(req("http://localhost/api/relay", body, "203.0.113.77"));
      assert.equal(res.status, 503, body.action);
      assert.deepEqual(await res.json(), { ok: false, error: "The relay is off on this network right now. Send from your wallet.", code: "relay_off" });
    }
    // past the route too: the per-spend lock itself never falls back to memory
    await assert.rejects(relayUnshield(net, unshieldBody(nullifier(), CLEAN)), relayOff);
    await assert.rejects(relayTransfer(net, transferBody(nullifier())), relayOff);
    assert.deepEqual(calls, [], "no chain call");
    assert.deepEqual(sends, []);
    assert.equal(logs.down(), 1, "the outage is logged once");
  });
});

await test("Redis back: the next send locks in Redis, and the recovery is logged", async () => {
  await withRedis(async (logs) => {
    redisState.mode = "down";
    reset();
    await assert.rejects(relayTransfer(net, transferBody(nullifier())), relayOff);
    redisState.mode = "up";
    redisState.commands.length = 0;
    const nul = nullifier();
    const res = await relayPost(req("http://localhost/api/relay", { chainId: net.chainId, action: "transfer", ...transferBody(nul) }, "203.0.113.78"));
    assert.equal(res.status, 200);
    assert.ok(redisState.commands.includes(`SET ${inflightKey(net.chainId, nul)}`), "the per-spend lock is in Redis");
    assert.deepEqual(sends, ["public"]);
    assert.equal(logs.back(), 1);
  });
});

await test("with Redis, a reverted receipt drops the lock by its token, and a newer holder's stays", async () => {
  await withRedis(async () => {
    reset({ receipt: "reverted" });
    const nul = nullifier();
    const key = inflightKey(net.chainId, nul);
    assert.equal(await relayTransfer(net, transferBody(nul)), TX_HASH);
    await receiptRead();
    assert.equal(redisState.data.has(key), false, "dropped");

    reset({ receipt: "none" });
    const other = nullifier();
    const otherKey = inflightKey(net.chainId, other);
    assert.equal(await relayTransfer(net, transferBody(other)), TX_HASH);
    await receiptRead();
    assert.ok(redisState.data.has(otherKey));
    // the lock lapsed and another request holds it now
    redisState.data.set(otherKey, "a-newer-holder");
    chain.receipt = "reverted";
    await receiptRead(2);
    assert.equal(redisState.data.get(otherKey), "a-newer-holder");
  });
});

await test("a production build with no Redis never keeps the per-spend lock in memory", async () => {
  const env = process.env as Record<string, string | undefined>;
  const before = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    reset();
    await assert.rejects(takeInflight(inflightKey(net.chainId, nullifier())));
    await assert.rejects(relayUnshield(net, unshieldBody(nullifier(), CLEAN)), relayOff);
    assert.deepEqual(sends, []);
  } finally {
    env.NODE_ENV = before;
  }
  // local dev and self-tests (no Redis, not production): memory, as before
  const lock = await takeInflight(inflightKey(net.chainId, nullifier()));
  assert.ok(lock && lock.store === "memory");
  await lock.release();
});

await test("SDK builder refuses a cash out to the pool before proving", async () => {
  const { buildUnshieldIntent } = await import("@gloamtrade/sdk");
  let proved = false;
  await assert.rejects(
    buildUnshieldIntent({
      secretHex: ("0x" + "01".repeat(32)) as Hex,
      amountWei: 1n,
      to: POOL.toLowerCase() as Address,
      poolAddress: POOL,
      path: {} as never,
      prove: async () => {
        proved = true;
        throw new Error("should not prove");
      },
    }),
    /vault itself/
  );
  assert.equal(proved, false);
});

console.log(`\nrelay: ${passed} passed`);
