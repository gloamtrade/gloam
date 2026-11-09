/**
 * Private x402 end to end, on the real engine and the real seller helper with
 * a fake chain both read (a stubbed tree, prover and send): a seller who
 * already sells through standard x402 adds the Gloam price, a buyer agent
 * previews and pays it, the seller secures the payment before it serves, and
 * a payment presented twice is served once. Then the 402 shapes standard
 * clients read, and a deposit signed through the guard with the real prover.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import {
  IncrementalMerkleTreePoseidon,
  decodeRequirements,
  generateReceiveKey,
  hexToField,
  makeBoundNotePoseidon,
  type GloamIntent,
  type NoteExport,
  type SweepChain,
} from "@gloamtrade/sdk";
import { shutdownProver, type CallSender } from "@gloamtrade/game-plugin-gloam/engine";
import { createGloamSeller, createGloamToolPack, findGloamPrice, protectWithGloam, type DecodedCall } from "../src/index.ts";
import { NET, USDC, hashOf } from "./helpers.mts";

const CIRCUITS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "app", "public", "circuits");
const LIMITS = { recipients: "any" as const, assets: { USDC: { maxPerPayment: "25", maxPerDay: "100" } } };
const NOTE_KEY = "44".repeat(32);

after(() => shutdownProver());

/** One fake vault both sides read: leaves, spent nullifiers, a tree for paths. */
async function fakeVault() {
  const seen = new Set<string>();
  const spent = new Set<string>();
  const tree = new IncrementalMerkleTreePoseidon();
  await tree.init();
  const leaves: string[] = [];
  const pathForCommitment = async (c: Hex) => {
    if (!seen.has(c.toLowerCase())) return null;
    let i = leaves.indexOf(c.toLowerCase());
    if (i < 0) {
      await tree.insert(hexToField(c));
      i = leaves.push(c.toLowerCase()) - 1;
    }
    return tree.path(i);
  };
  const land = (intent: GloamIntent) => {
    const exec = intent.exec!;
    spent.add(String(exec.args[2]).toLowerCase());
    for (const c of exec.args[3] as readonly Hex[]) seen.add(c.toLowerCase());
  };
  const client = {
    chain: { id: NET.chainId },
    getChainId: async () => NET.chainId,
    getBlockNumber: async () => 1_000n,
    getBalance: async () => 10n ** 18n,
    readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      if (functionName === "commitmentSeen") return seen.has(String(args![0]).toLowerCase());
      if (functionName === "isSpent") return spent.has(String(args![0]).toLowerCase());
      if (functionName === "balanceOf") return 1_000_000_000n;
      if (functionName === "allowance") return 0n;
      throw new Error(`fake chain: no ${functionName}`);
    },
    waitForTransactionReceipt: async () => ({ status: "success" as const, blockNumber: 1_000n, logs: [] }),
    getTransactionReceipt: async () => ({ status: "success" as const, blockNumber: 1_000n, logs: [] }),
  } as unknown as PublicClient;
  const chain: SweepChain = {
    chainId: async () => NET.chainId,
    isSpent: async (n) => spent.has(n.toLowerCase()),
    isCommitmentSeen: async (c) => seen.has(c.toLowerCase()),
    pathForCommitment,
    waitForReceipt: async () => ({ status: "success" }),
  };
  return { seen, spent, land, client, chain, pathForCommitment };
}

const standProver = async () => ({ proofBytes: "0x00" as Hex });

/** A buyer pack on the real engine, its tree, prover and send stubbed onto the fake vault. */
async function buyer(v: Awaited<ReturnType<typeof fakeVault>>, fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gloam-kit-pack-"));
  const pack = createGloamToolPack({
    network: "base",
    rpc: "http://127.0.0.1:1",
    agentId: "buyer",
    dataDir: dir,
    env: { GLOAM_NOTE_KEY: NOTE_KEY, GLOAM_NOTE_STORE: join(dir, "notes.json") },
    artifacts: { dir: CIRCUITS, url: "http://127.0.0.1:1/never" },
    limits: LIMITS,
    publicClient: v.client,
    fetch: fetchImpl,
    allowHttp: true,
    ...extra,
  });
  const internals = pack.agent as unknown as { tree: unknown; prover: () => Promise<unknown>; submitIntent: (i: GloamIntent) => Promise<Hex> };
  internals.tree = { sync: async () => ({ pathForCommitment: v.pathForCommitment, leafInfo: () => null }) };
  internals.prover = async () => standProver;
  let n = 0;
  internals.submitIntent = async (intent) => {
    v.land(intent);
    return hashOf(++n);
  };
  const fund = async (amountWei: bigint) => {
    const note = await makeBoundNotePoseidon(amountWei, USDC);
    v.seen.add(note.commitment.toLowerCase());
    pack.agent!.store.add({
      network: "base", chainId: NET.chainId, pool: NET.pool, asset: USDC, symbol: "USDC", decimals: 6,
      amountWei: amountWei.toString(), secret: note.secret, commitment: note.commitment, nullifier: note.nullifier,
      status: "unspent", origin: "shield", createdTx: null,
    } as never);
  };
  return { pack, fund };
}

/** A standard x402 v1 middleware stand-in: 402 with an exact price unless X-PAYMENT is one it knows. */
const standardV1 = async (req: Request) =>
  req.headers.get("x-payment") === "standard-ok"
    ? new Response("served by standard x402", { status: 200 })
    : new Response(
        JSON.stringify({
          x402Version: 1,
          error: "X-PAYMENT header is required",
          accepts: [{ scheme: "exact", network: "base-sepolia", maxAmountRequired: "250000", resource: req.url, description: "", mimeType: "application/json", payTo: "0x00000000000000000000000000000000000000e5", maxTimeoutSeconds: 60, asset: USDC }],
        }),
        { status: 402, headers: { "content-type": "application/json" } }
      );

async function seller(v: Awaited<ReturnType<typeof fakeVault>>) {
  const key = await generateReceiveKey();
  const saved: NoteExport[] = [];
  let sweeps = 0;
  const s = createGloamSeller({
    receiveKey: key,
    network: "base",
    client: v.client,
    chain: v.chain,
    prove: standProver,
    submit: async (intent) => {
      v.land(intent);
      return hashOf(1000 + ++sweeps);
    },
    saveNote: (fresh) => void saved.push(fresh),
  });
  const handler = protectWithGloam({
    seller: s,
    price: (req) => (new URL(req.url).pathname === "/v1/quote" ? { amount: "0.25" } : null),
    handler: async () => new Response(JSON.stringify({ quote: 42 }), { headers: { "content-type": "application/json" } }),
    standard: standardV1,
  });
  return { s, key, saved, handler, sweeps: () => sweeps };
}

test("a buyer agent previews a seller's Gloam price, pays it privately, and is served once the seller secured it", { timeout: 60_000 }, async () => {
  const v = await fakeVault();
  const shop = await seller(v);
  const requests: Request[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const req = new Request(url, init);
    requests.push(req);
    return shop.handler(req);
  }) as typeof fetch;
  const { pack, fund } = await buyer(v, fetchImpl);
  await fund(10_000_000n);

  const p = await pack.call("gloam_preview_pay_x402", { url: "http://shop.test/v1/quote?q=TSLA" });
  assert.equal(p.status, "preview", JSON.stringify(p));
  const d = p.details as Record<string, unknown>;
  assert.equal(d.amount, "0.25 USDC");
  assert.equal(d.to, shop.key.tag);
  assert.equal(d.resource, "http://shop.test/v1/quote");
  assert.deepEqual(d.alsoOffered, ["exact on base-sepolia"]);
  assert.equal(requests.length, 1, "the preview made one unpaid request");

  const r = await pack.call("gloam_execute", { previewId: p.previewId, digest: p.digest });
  assert.equal(r.status, "ok", JSON.stringify(r));
  assert.equal(r.body, JSON.stringify({ quote: 42 }));
  assert.equal(shop.saved.length, 1, "the seller stored its fresh note before the sweep went out");
  assert.equal(shop.saved[0]!.amountWei, "250000");
  const receipt = JSON.parse(Buffer.from(String(r.paymentResponse), "base64").toString());
  assert.equal(receipt.scheme, "gloam-private");
  assert.equal(requests[1]!.headers.get("x-payment")?.startsWith("gloamx402pay1:"), true);

  // The same payment presented again is not served again.
  const replay = await shop.handler(new Request("http://shop.test/v1/quote", { headers: { "x-payment": requests[1]!.headers.get("x-payment")! } }));
  assert.equal(replay.status, 402);
  assert.equal(((await replay.json()) as { status: string }).status, "used");
  assert.equal(shop.sweeps(), 1);

  // And executing the preview again does not pay again.
  assert.equal((await pack.call("gloam_execute", { previewId: p.previewId })).repeated, true);
  assert.equal(requests.length, 2);
  // Standard x402 still works on the same route.
  assert.equal((await shop.handler(new Request("http://shop.test/v1/quote", { headers: { "x-payment": "standard-ok" } }))).status, 200);
});

test("a paid request the seller did not serve yet is presented again, never paid again", { timeout: 60_000 }, async () => {
  const v = await fakeVault();
  const shop = await seller(v);
  let down = true;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const req = new Request(url, init);
    if (req.headers.get("x-payment") && down) return new Response("busy", { status: 503 });
    return shop.handler(req);
  }) as typeof fetch;
  const { pack, fund } = await buyer(v, fetchImpl);
  await fund(10_000_000n);
  const p = await pack.call("gloam_preview_pay_x402", { url: "http://shop.test/v1/quote" });
  const first = await pack.call("gloam_execute", { previewId: p.previewId });
  assert.equal(first.status, "paid_not_served", JSON.stringify(first));
  down = false;
  const second = await pack.call("gloam_execute", { previewId: p.previewId });
  assert.equal(second.status, "ok", JSON.stringify(second));
  const payments = pack.agent!.notes().filter((n) => n.origin === "payment");
  assert.equal(payments.length, 1, "one payment, presented twice");
});

test("a resource that sells only standard x402 is reported, not paid; a price over maxAmount is refused", async () => {
  const v = await fakeVault();
  const shop = await seller(v);
  const onlyExact = (async (url: string, init?: RequestInit) => standardV1(new Request(url, init))) as typeof fetch;
  const { pack, fund } = await buyer(v, onlyExact);
  await fund(10_000_000n);
  const r = await pack.call("gloam_preview_pay_x402", { url: "http://shop.test/v1/quote" });
  assert.equal(r.code, "no_gloam_price");
  assert.match(String(r.message), /exact on base-sepolia: pay that with a standard x402 client/);

  const both = (async (url: string, init?: RequestInit) => shop.handler(new Request(url, init))) as typeof fetch;
  const b = await buyer(v, both);
  await b.fund(10_000_000n);
  assert.equal((await b.pack.call("gloam_preview_pay_x402", { url: "http://shop.test/v1/quote", maxAmount: "0.1" })).code, "over_max_amount");
  assert.equal((await b.pack.call("gloam_preview_pay_x402", { url: "http://shop.test/free" })).status, "not_payment_required");
  const strict = await buyer(v, both, { allowHttp: false });
  assert.equal((await strict.pack.call("gloam_preview_pay_x402", { url: "http://shop.test/v1/quote" })).code, "bad_input");
});

test("the Gloam price rides in a header next to a standard v1 answer, whose body stays as it was", async () => {
  const v = await fakeVault();
  const shop = await seller(v);
  const res = await shop.handler(new Request("http://shop.test/v1/quote"));
  assert.equal(res.status, 402);
  const body = (await res.clone().json()) as { accepts: { scheme: string }[] };
  // x402 v1 clients parse every accepts entry strictly (scheme "exact", a fixed network list): nothing is added there.
  assert.deepEqual(body.accepts.map((a) => a.scheme), ["exact"]);
  const header = res.headers.get("x-payment-required")!;
  const req = decodeRequirements(header);
  assert.equal(req.scheme, "gloam-private");
  assert.equal(req.payTo, shop.key.tag);
  assert.equal(req.maxAmountRequired, "250000");
  assert.equal(req.resource, "http://shop.test/v1/quote");
  const found = findGloamPrice(res.headers, await res.text());
  assert.ok(found.ok && found.requirements.payTo === shop.key.tag);
});

test("on an x402 v2 answer the gloam entry joins PAYMENT-REQUIRED's accepts, where v2 clients skip schemes they do not know", async () => {
  const v = await fakeVault();
  const shop = await seller(v);
  const v2 = { x402Version: 2, resource: { url: "http://shop.test/v1/quote" }, accepts: [{ scheme: "exact", network: "eip155:84532", amount: "250000", asset: USDC, payTo: "0x00000000000000000000000000000000000000e5", maxTimeoutSeconds: 60 }] };
  const standard = new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(v2)).toString("base64") } });
  const req = shop.s.requirements({ amount: "0.25" }, "http://shop.test/v1/quote");
  const res = await shop.s.addToChallenge(standard, req);
  const pr = JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString()) as { accepts: { scheme: string; network: string; extra?: { gloam?: string } }[] };
  assert.deepEqual(pr.accepts.map((a) => `${a.scheme} ${a.network}`), ["exact eip155:84532", `gloam-private eip155:${NET.chainId}`]);
  // A buyer reading only PAYMENT-REQUIRED finds the price there too.
  const headers = new Headers({ "payment-required": res.headers.get("payment-required")! });
  const found = findGloamPrice(headers, "{}");
  assert.ok(found.ok, JSON.stringify(found));
  assert.equal(found.ok && found.requirements.maxAmountRequired, "250000");
});

test("a deposit through the pack signs only the previewed approve and shieldBound, with the real shield prover", { timeout: 120_000 }, async () => {
  const v = await fakeVault();
  const ABI = parseAbi(["function shieldBound(address asset, uint256 amount, bytes32 commitment, bytes proof) payable"]);
  const signed: string[][] = [];
  const shown: DecodedCall[][] = [];
  const inner: CallSender = {
    address: "0x00000000000000000000000000000000000000a1",
    async sendCalls(calls) {
      signed.push(calls.map((c) => c.data.slice(0, 10)));
      const last = calls[calls.length - 1]!;
      const d = decodeFunctionData({ abi: ABI, data: last.data });
      v.seen.add(String(d.args[2]).toLowerCase());
      return hashOf(9);
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "gloam-kit-shield-"));
  const pack = createGloamToolPack({
    network: "base",
    rpc: "http://127.0.0.1:1",
    agentId: "shield",
    dataDir: dir,
    env: { GLOAM_NOTE_KEY: NOTE_KEY, GLOAM_NOTE_STORE: join(dir, "notes.json") },
    artifacts: { dir: CIRCUITS, url: "http://127.0.0.1:1/never" },
    limits: LIMITS,
    publicClient: v.client,
    sender: inner,
    onSign: (calls) => (shown.push(calls), true),
  });
  const p = await pack.call("gloam_preview_shield", { amount: "5" });
  assert.equal(p.status, "preview", JSON.stringify(p));
  assert.equal(signed.length, 0);
  const r = await pack.call("gloam_execute", { previewId: p.previewId });
  assert.equal(r.status, "done", JSON.stringify(r));
  assert.equal(signed.length, 1);
  assert.deepEqual(shown[0]!.map((c) => `${c.fn}:${c.args.amount}`), ["approve:5000000", "shieldBound:5000000"]);
  const bal = await pack.call("gloam_balance", {});
  assert.equal((bal.privateBalance as { spendable: string }[])[0]!.spendable, "5");
  // The engine's own sender is the guarded one: outside a preview it signs nothing.
  const outside = await (pack.agent as unknown as { sender: CallSender }).sender.sendCalls([{ to: USDC, data: "0x095ea7b3" }]).catch((e: Error) => e.message);
  assert.match(String(outside), /only inside an approved preview/);
});
