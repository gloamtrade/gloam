/**
 * x402 scheme gloam-cashout over MCP: gloam_fetch_paid pays a gateway's
 * gloam-cashout price with a cash out of exactly the quoted USDG to its public
 * payTo, through the relay, and retries with X-PAYMENT. Driven through a real MCP
 * client over an in-memory transport, on a fake chain and relay; proofs stubbed.
 *
 *   pnpm --filter @gloamtrade/mcp test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { keccak256, toHex, type Address, type Hex } from "viem";
import {
  GloamRelayError,
  IncrementalMerkleTreePoseidon,
  buildGloamPaymentRequirements,
  cashoutGross,
  decodeGloamCashoutHeader,
  generateReceiveKey,
  hexToField,
  makeBoundNotePoseidon,
} from "@gloamtrade/sdk";
import { createGloamServer, type ServerDeps } from "../src/server.js";
import type { Signer } from "../src/signer.js";
import { openNoteStore } from "../src/noteStore.js";

type Env = Record<string, string | undefined>;
const POOL = "0x39e28cde55cab798874746ac52cb4b5cc99a0194" as Address;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const SPLITTER = "0x5111111111111111111111111111111111111115" as Address;
const URL_ = "https://gateway.test/v1/tool";
const G = cashoutGross(1_000_000n, 812, 50);
const QUOTE_ID = "qt_mcp_51d0";
const lc = (h: string) => h.toLowerCase();
const word = (a: string) => `0x${lc(a).slice(2).padStart(64, "0")}` as Hex;
const UNSHIELDED = keccak256(toHex("Unshielded(bytes32,address,address,uint256)"));

const cashoutEntry = (over: Record<string, unknown> = {}) => ({
  scheme: "gloam-cashout",
  network: "eip155:4663",
  asset: USDG,
  payTo: SPLITTER,
  amount: G.toString(),
  quoteId: QUOTE_ID,
  maxTimeoutSeconds: 120,
  ...over,
});
const exactEntry = { scheme: "exact", network: "eip155:4663", amount: "1000000", asset: USDG, payTo: SPLITTER, maxTimeoutSeconds: 60 };

function setup(opts: { unshield?: "lands" | "unclear" } = {}) {
  const tree = new IncrementalMerkleTreePoseidon();
  const index = new Map<string, number>();
  const spent = new Set<string>();
  const receipts = new Map<string, { status: "success" | "reverted"; blockNumber: bigint; logs: unknown[] }>();
  let n = 0;
  const hash = () => `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
  const insert = async (c: Hex) => void index.set(lc(c), await tree.insert(hexToField(c)));
  const client = {
    getChainId: async () => 4663,
    getBlockNumber: async () => 1000n,
    waitForTransactionReceipt: async ({ hash: h }: { hash: Hex }) => receipts.get(h) ?? { status: "reverted", blockNumber: 1000n, logs: [] },
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "isSpent") return spent.has(lc(args![0] as string));
      if (functionName === "withdrawFeeBps") return 50;
      throw new Error(`unexpected read ${functionName}`);
    },
  };
  const relayed: { fn: string; args: readonly unknown[] }[] = [];
  const prover = async () => ({ proofBytes: `0x${"ab".repeat(256)}` as Hex });
  const deps: Partial<ServerDeps> = {
    signer: () => null,
    publicClient: () => client as unknown as Signer["publicClient"],
    shieldProver: async () => prover,
    transferProver: async () => prover,
    unshieldProver: async () => prover,
    syncTree: (async () => ({
      pathForCommitment: async (c: Hex) => (index.has(lc(c)) ? tree.path(index.get(lc(c))!) : null),
    })) as unknown as ServerDeps["syncTree"],
    relay: async (intent) => {
      const exec = intent.exec!;
      relayed.push({ fn: exec.fn, args: exec.args });
      if (exec.fn === "unshield" && opts.unshield === "unclear") throw new GloamRelayError("No answer from the relay.", "maybe_sent");
      const h = hash();
      spent.add(lc(exec.args[2] as string));
      if (exec.fn === "transfer") {
        for (const c of exec.args[3] as readonly Hex[]) await insert(c);
        receipts.set(h, { status: "success", blockNumber: 1000n, logs: [] });
      } else {
        const [, , nullifier, asset, to, amount] = exec.args as [Hex, Hex, Hex, Address, Address, bigint];
        receipts.set(h, { status: "success", blockNumber: 1000n, logs: [{ address: POOL, topics: [UNSHIELDED, nullifier, word(asset), word(to)], data: toHex(amount, { size: 32 }) }] });
      }
      return h;
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "gloam-x402-cashout-"));
  const env: Env = {
    GLOAM_AGENT_ID: "payer",
    GLOAM_NOTE_KEY: "c4".repeat(32),
    GLOAM_NOTE_STORE: join(dir, "notes.json"),
    GLOAM_SPEND_LOG: join(dir, "log.json"),
    GLOAM_LIMIT_ASSETS: "USDG",
    GLOAM_LIMIT_NETWORK: "robinhood-mainnet",
    GLOAM_LIMIT_MAX_PER_PAYMENT: "1000",
    GLOAM_LIMIT_MAX_PER_DAY: "5000",
    GLOAM_LIMIT_RECIPIENTS: "any",
    GLOAM_LIMIT_TOOLS: "pay",
  };
  const keep = async (amount: bigint) => {
    const note = await makeBoundNotePoseidon(amount, USDG);
    await insert(note.commitment as Hex);
    return openNoteStore(env).add({
      network: "robinhood-mainnet",
      chainId: 4663,
      pool: POOL,
      asset: USDG,
      symbol: "USDG",
      decimals: 6,
      amountWei: amount.toString(),
      secret: note.secret as Hex,
      commitment: note.commitment as Hex,
      nullifier: note.nullifier as Hex,
      status: "unspent",
      origin: "shield",
      createdTx: null,
    });
  };
  return { deps, env, relayed, keep };
}

/** A gateway: 402 listing `accepts` in PAYMENT-REQUIRED (and `body` as the body), 200 for a gloam-cashout header. */
function gateway(accepts: unknown[], body: unknown = {}) {
  const presented: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const req = new Request(url, init);
    const h = req.headers.get("x-payment");
    if (h) {
      presented.push(h);
      const p = decodeGloamCashoutHeader(h);
      if (p.quoteId === QUOTE_ID) return new Response(JSON.stringify({ result: "served" }), { status: 200 });
    }
    const pr = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url }, accepts })).toString("base64");
    return new Response(JSON.stringify(body), { status: 402, headers: { "PAYMENT-REQUIRED": pr, "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, presented };
}

async function connect(deps: Partial<ServerDeps>) {
  const server = createGloamServer(deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gloam-x402-cashout-test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const raw = (r.content as { type: string; text: string }[])[0]!.text;
    return { json: JSON.parse(raw) as Record<string, any>, raw };
  };
}

test("gloam_fetch_paid pays a gloam-cashout price: a split, then exactly G to payTo, then the retry; the same quote is never paid twice", async () => {
  const t = setup();
  const gw = gateway([exactEntry, cashoutEntry()]);
  const note = await t.keep(10_000_000n);
  const call = await connect({ ...t.deps, env: t.env, fetch: gw.fetchImpl });
  const { json: r, raw } = await call("gloam_fetch_paid", { url: URL_, maxAmount: 1.1 });
  assert.equal(r.status, "ok", raw);
  assert.equal(r.body, JSON.stringify({ result: "served" }));
  assert.equal(r.scheme, "gloam-cashout");
  assert.deepEqual(t.relayed.map((x) => x.fn), ["transfer", "unshield"], "split privately, then the cash out");
  const [, , , asset, to, amount] = t.relayed[1]!.args as [Hex, Hex, Hex, Address, Address, bigint];
  assert.equal(lc(asset), lc(USDG));
  assert.equal(lc(to), lc(SPLITTER));
  assert.equal(BigInt(amount), G);
  assert.equal(gw.presented.length, 1);
  assert.deepEqual(decodeGloamCashoutHeader(gw.presented[0]!), { scheme: "gloam-cashout", txHash: r.hash, quoteId: QUOTE_ID });
  assert.equal(r.submittedBy, "gloam-relay (agent wallet hidden)");
  assert.match(r.privacy, /cash out is public/);
  assert.ok(!raw.includes(note.secret.slice(2)), "no secret in the answer");
  const left = openNoteStore(t.env).list().filter((n) => n.status === "unspent").map((n) => n.amountWei);
  assert.deepEqual(left, [(10_000_000n - G).toString()], "the change stays private");

  // The same quote again (a call whose answer was lost): presented again, nothing new paid.
  const again = await call("gloam_fetch_paid", { url: URL_, maxAmount: 1.1 });
  assert.equal(again.json.status, "ok", again.raw);
  assert.equal(again.json.reused, true);
  assert.equal(t.relayed.length, 2, "never paid twice");
  assert.equal(gw.presented[1], gw.presented[0]);
});

test("refused before any note moves: no maxAmount, over it, wrong network, no quote id", async () => {
  for (const [over, args, code] of [
    [{}, {}, "no_max_amount"],
    [{}, { maxAmount: 1.0 }, "over_max_amount"],
    [{ network: "eip155:8453" }, { maxAmount: 2 }, "wrong_network"],
    [{ quoteId: undefined }, { maxAmount: 2 }, "no_quote_id"],
  ] as [Record<string, unknown>, Record<string, unknown>, string][]) {
    const t = setup();
    await t.keep(10_000_000n);
    const call = await connect({ ...t.deps, env: t.env, fetch: gateway([cashoutEntry(over)]).fetchImpl });
    const { json: r, raw } = await call("gloam_fetch_paid", { url: URL_, ...args });
    assert.equal(r.code, code, raw);
    assert.equal(t.relayed.length, 0);
  }
});

test("both schemes offered: gloam-private by default, gloam-cashout when preferred", async () => {
  const tag = (await generateReceiveKey()).tag;
  const priv = buildGloamPaymentRequirements({ amountWei: 1_000_000n, asset: USDG, assetSymbol: "USDG", payTo: tag, resource: URL_, network: 4663, poolAddress: POOL });
  const t = setup();
  await t.keep(10_000_000n);
  const call = await connect({ ...t.deps, env: t.env, fetch: gateway([cashoutEntry()], { accepts: [priv] }).fetchImpl });
  const def = await call("gloam_fetch_paid", { url: URL_, maxAmount: 2 });
  assert.equal(def.json.status, "no_signer", def.raw);
  assert.equal(t.relayed.length, 0, "the private scheme was chosen (it needs a signer here)");
  const pick = await call("gloam_fetch_paid", { url: URL_, maxAmount: 2, prefer: "gloam-cashout" });
  assert.equal(pick.json.status, "ok", pick.raw);
  assert.equal(pick.json.scheme, "gloam-cashout");
});

test("a cash out whose answer was lost is never sent again: the next call says it is in progress", async () => {
  const t = setup({ unshield: "unclear" });
  await t.keep(G);
  const call = await connect({ ...t.deps, env: t.env, fetch: gateway([cashoutEntry()]).fetchImpl });
  const first = await call("gloam_fetch_paid", { url: URL_, maxAmount: 2 });
  assert.equal(first.json.status, "error", first.raw);
  assert.match(first.json.check, /never paid twice/);
  assert.deepEqual(t.relayed.map((x) => x.fn), ["unshield"], "a note of exactly G needs no split");
  const second = await call("gloam_fetch_paid", { url: URL_, maxAmount: 2 });
  assert.equal(second.json.status, "payment_in_progress", second.raw);
  assert.equal(t.relayed.length, 1);
});
