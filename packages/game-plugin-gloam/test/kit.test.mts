/**
 * What agent kits build on (a fake chain, a stubbed tree, prover and send): a
 * note store kept by the kit's own backend, an x402 price paid privately with
 * its X-PAYMENT value handed back (and never paid twice when an answer is
 * lost), and a partner key that sends through the partner relay.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  BASE_SEPOLIA_USDC,
  IncrementalMerkleTreePoseidon,
  buildGloamPaymentRequirements,
  decodePaymentHeader,
  generateReceiveKey,
  hexToField,
  makeBoundNotePoseidon,
  openGloamPaymentNote,
  verifyGloamPayment,
  verifyPaymentNoteBinding,
  type GloamIntent,
} from "@gloamtrade/sdk";
import type { Address, Hex, PublicClient } from "viem";
import { GloamAgent, fileNoteBackend, shutdownProver, type GloamAgentOptions, type NoteStoreBackend } from "../src/engine.ts";
import { NoteStore, noteStoreKey, type StoredNote } from "../src/noteStore.ts";

const CIRCUITS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "app", "public", "circuits");
const usdc = BASE_SEPOLIA_USDC as Address;
const LIMITS = { recipients: "any" as const, assets: { USDC: { maxPerPayment: "25", maxPerDay: "100" } } };
const hashOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

after(() => shutdownProver());

/** A backend a kit could write: here, a string in memory. It only ever holds ciphertext. */
function memoryBackend(): NoteStoreBackend & { text: string | null; writes: number } {
  const b = {
    where: "memory:test",
    text: null as string | null,
    writes: 0,
    read: () => b.text,
    write(text: string) {
      b.text = text;
      b.writes++;
    },
    lock: <T,>(fn: () => T) => fn(),
  };
  return b;
}

type Internals = { submitIntent: (intent: GloamIntent) => Promise<Hex>; tree: unknown; prover: () => Promise<unknown> };

async function setup(opts: Partial<GloamAgentOptions> & { send?: "lands" | "lost" | "lost_after_landing" } = {}) {
  const seen = new Set<string>();
  const spent = new Set<string>();
  const client = {
    chain: { id: 84532 },
    getChainId: async () => 84532,
    getBlockNumber: async () => 1_000n,
    readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      if (functionName === "commitmentSeen") return seen.has(String(args![0]).toLowerCase());
      if (functionName === "isSpent") return spent.has(String(args![0]).toLowerCase());
      throw new Error(`fake chain: no ${functionName}`);
    },
    waitForTransactionReceipt: async () => ({ status: "success" as const, blockNumber: 1_000n, logs: [] }),
    getTransactionReceipt: async () => ({ status: "success" as const, blockNumber: 1_000n, logs: [] }),
  } as unknown as PublicClient;
  const dir = mkdtempSync(join(tmpdir(), "gloam-kit-"));
  const { send, ...agentOpts } = opts;
  const agent = new GloamAgent({
    network: "base",
    rpc: "http://127.0.0.1:1",
    submit: "wallet",
    agentId: "unit",
    dataDir: dir,
    env: { GLOAM_AGENT_PRIVATE_KEY: `0x${randomBytes(32).toString("hex")}`, GLOAM_NOTE_STORE: join(dir, "notes.json") },
    artifacts: { dir: CIRCUITS, url: "http://127.0.0.1:1/never" },
    limits: LIMITS,
    publicClient: client,
    sender: { address: "0x00000000000000000000000000000000000000a1", sendCalls: async () => hashOf(999) },
    ...agentOpts,
  });
  const internals = agent as unknown as Internals;
  const tree = new IncrementalMerkleTreePoseidon();
  await tree.init();
  const leaves: string[] = [];
  const pathForCommitment = async (c: Hex) => {
    let i = leaves.indexOf(c.toLowerCase());
    if (i < 0) {
      await tree.insert(hexToField(c));
      i = leaves.push(c.toLowerCase()) - 1;
    }
    return tree.path(i);
  };
  internals.tree = { sync: async () => ({ pathForCommitment, leafInfo: () => null }) };
  internals.prover = async () => async () => ({ proofBytes: "0x00" as Hex });
  const land = (intent: GloamIntent) => {
    const exec = intent.exec!;
    spent.add(String(exec.args[2]).toLowerCase());
    if (exec.fn === "transfer") for (const c of exec.args[3] as readonly Hex[]) seen.add(c.toLowerCase());
  };
  let sends = 0;
  if (!opts.apiKey) {
    internals.submitIntent = async (intent) => {
      sends++;
      if (send === "lost") throw new Error("The relay did not answer in time.");
      land(intent);
      if (send === "lost_after_landing") throw new Error("The relay did not answer in time.");
      return hashOf(sends);
    };
  }
  const addNote = async (amountWei: bigint) => {
    const n = await makeBoundNotePoseidon(amountWei, usdc);
    seen.add(n.commitment.toLowerCase());
    return agent.store.add({
      network: "base", chainId: 84532, pool: agent.network.pool, asset: usdc, symbol: "USDC", decimals: 6,
      amountWei: amountWei.toString(), secret: n.secret, commitment: n.commitment, nullifier: n.nullifier,
      status: "unspent", origin: "shield", createdTx: null,
    } as never);
  };
  return { agent, addNote, seen, spent, land, sends: () => sends };
}

test("a kit's own backend keeps the note store, and it only ever sees ciphertext", async () => {
  const backend = memoryBackend();
  const { agent, addNote } = await setup({ noteBackend: backend });
  const note: StoredNote = await addNote(5_000_000n);
  assert.ok(backend.writes > 0 && backend.text, "the store was written to the backend");
  assert.ok(!backend.text!.includes(note.secret.slice(2)), "the secret never reaches the backend in the clear");
  assert.ok(!backend.text!.includes("5000000"), "nor the amount");
  assert.equal(agent.store.path, "memory:test");
  // Reopened from the same backend with the same key, the note is there.
  const kit = memoryBackend();
  const { key, source } = noteStoreKey({ GLOAM_NOTE_KEY: "11".repeat(32) });
  new NoteStore(kit, "kit", key, source).add({ ...note } as never);
  assert.equal(new NoteStore(kit, "kit", key, source).list().length, 1);
  // A wrong key, or another agent, never overwrites what the backend holds.
  const other = noteStoreKey({ GLOAM_NOTE_KEY: "22".repeat(32) });
  const before = kit.text;
  assert.throws(() => new NoteStore(kit, "kit", other.key, other.source).add({ ...note } as never), /cannot be opened/);
  assert.throws(() => new NoteStore(kit, "other-agent", key, source).add({ ...note } as never), /belongs to agent "kit"/);
  assert.equal(kit.text, before);
  // The file backend is the default, unchanged.
  assert.equal(fileNoteBackend("/tmp/x.json").where, "/tmp/x.json");
});

test("an x402 price is paid privately, and the header it hands back is what the seller settles", { timeout: 60_000 }, async () => {
  const { agent, addNote } = await setup();
  await addNote(10_000_000n);
  const seller = await generateReceiveKey();
  const requirements = buildGloamPaymentRequirements({
    amountWei: 250_000n, asset: usdc, assetSymbol: "USDC", payTo: seller.tag,
    resource: "https://api.example.com/v1/quote?token=SECRET123", network: 84532, poolAddress: agent.network.pool,
  });
  const out = await agent.payX402({ requirements });
  assert.equal(out.status, "done", JSON.stringify(out));
  assert.equal(out.action, "pay_x402");
  const header = String(out.paymentHeader);
  const payload = decodePaymentHeader(header);
  assert.equal(payload.scheme, "gloam-private");
  assert.equal(payload.payload.txHash, out.hash, "the settlement transaction is in the header");
  assert.match(payload.payload.paymentNote, /^gloam2t\./, "the payment note travels sealed");
  const note = await openGloamPaymentNote(payload.payload.paymentNote, seller);
  assert.equal(note.amountWei, "250000");
  assert.ok(await verifyPaymentNoteBinding(note));
  assert.equal(verifyGloamPayment({ requirements, payload, note }).ok, true);
  assert.ok(!JSON.stringify(out).includes("SECRET123"), "a token in the resource URL never reaches the outcome");
  assert.ok(!JSON.stringify(out).includes(note.secret.slice(2)), "nor the payment note's secret");
  // Change came back, and the payment counts against the day.
  assert.deepEqual(agent.notes().map((n) => `${n.origin}:${n.amount}:${n.status}`).sort(), ["change:9.75:unspent", "payment:0.25:spent", "shield:10:spent"]);
  assert.equal((agent.limitsReport() as { assets: { usedLast24h: string }[] }).assets[0]!.usedLast24h, "0.25");
});

test("an x402 price on another network, vault or payee kind is refused before anything is spent", async () => {
  const { agent, addNote } = await setup();
  await addNote(10_000_000n);
  const seller = await generateReceiveKey();
  const base = buildGloamPaymentRequirements({ amountWei: 1n, asset: usdc, payTo: seller.tag, resource: "r", network: 84532, poolAddress: agent.network.pool });
  await assert.rejects(agent.payX402({ requirements: { ...base, network: 4663 } }), /Robinhood Chain/);
  await assert.rejects(agent.payX402({ requirements: { ...base, poolAddress: "0x0000000000000000000000000000000000000001" } }), /different vault/);
  await assert.rejects(agent.payX402({ requirements: { ...base, payTo: "0x00000000000000000000000000000000000000b2" } }), /Gloam address/);
  await assert.rejects(agent.payX402({ requirements: { ...base, scheme: "exact" } as never }), /gloam-private/);
  await assert.rejects(agent.payX402({ requirements: { ...base, maxAmountRequired: "1.5" } }), /whole/);
  assert.deepEqual(agent.notes().map((n) => n.status), ["unspent"]);
});

test("an x402 payment whose answer was lost is never paid twice, and the same header comes back once it lands", { timeout: 60_000 }, async () => {
  const { agent, addNote, sends } = await setup({ send: "lost_after_landing" });
  await addNote(10_000_000n);
  const seller = await generateReceiveKey();
  const requirements = buildGloamPaymentRequirements({ amountWei: 500_000n, asset: usdc, payTo: seller.tag, resource: "mcp://tool/summarize", network: 84532, poolAddress: agent.network.pool });
  const first = await agent.payX402({ requirements });
  assert.equal(first.status, "unconfirmed", JSON.stringify(first));
  const firstHeader = String(first.paymentHeader);
  assert.ok(firstHeader.startsWith("gloamx402pay1:"));
  const again = await agent.payX402({ requirements });
  assert.equal(again.alreadyPaid, true, JSON.stringify(again));
  assert.equal(sends(), 1, "nothing was sent the second time");
  const a = decodePaymentHeader(firstHeader);
  const b = decodePaymentHeader(String(again.paymentHeader));
  assert.equal(b.payload.paymentNote, a.payload.paymentNote, "the same sealed payment");
});

test("with a partner key, private payments and their messages go through the partner relay", { timeout: 60_000 }, async () => {
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  let land: ((i: GloamIntent) => void) | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), auth: new Headers(init.headers).get("authorization"), body });
    if (body.action === "transfer") land!({ exec: { fn: "transfer", args: [body.proof, body.root, body.nullifier, body.commitments] } } as unknown as GloamIntent);
    return new Response(JSON.stringify({ ok: true, data: { hash: hashOf(calls.length), attribution: { recorded: true } } }), { status: 200 });
  }) as typeof fetch;
  try {
    const apiKey = `gloam_test_${"a".repeat(43)}`;
    const s = await setup({ apiKey, submit: "relay" });
    land = s.land;
    await s.addNote(10_000_000n);
    const payee = await generateReceiveKey();
    const out = await s.agent.pay({ to: payee.tag, amount: "2" });
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.ok(calls.length >= 1);
    for (const c of calls) {
      assert.equal(c.url, "https://gloam.trade/api/v1/relay");
      assert.equal(c.auth, `Bearer ${apiKey}`);
    }
    assert.equal(calls[0]!.body.action, "transfer");
    assert.ok(!JSON.stringify(out).includes(apiKey), "the key never shows in an outcome");
  } finally {
    globalThis.fetch = realFetch;
  }
});
