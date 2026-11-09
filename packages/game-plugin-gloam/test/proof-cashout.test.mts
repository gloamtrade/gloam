/**
 * A cash out of a note behind a proof of funds (a fake chain, a stubbed tree and
 * send; the real funds prover where a proof is made). The note moves whole to a
 * fresh note first, kept before the move is sent, and the cash out spends the
 * fresh note; a move that fails cashes nothing out. A note behind no proof
 * cashes out as before.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { BASE_SEPOLIA_USDC, IncrementalMerkleTreePoseidon, hexToField, makeBoundNotePoseidon, type GloamIntent } from "@gloamtrade/sdk";
import type { Address, Hex, PublicClient } from "viem";
import { GloamAgent, shutdownProver } from "../src/index.ts";
import type { StoredNote } from "../src/noteStore.ts";
import { decodeProof } from "../src/proofs.ts";

const CIRCUITS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "app", "public", "circuits");
const usdc = BASE_SEPOLIA_USDC as Address;
const TO = "0x00000000000000000000000000000000000000b2" as Address;
const LIMITS = { recipients: "any" as const, assets: { USDC: { maxPerPayment: "25", maxPerDay: "100" } } };
const hashOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const same = (a: string, b: string) => BigInt(a) === BigInt(b);

after(() => shutdownProver());

type Sent = { fn: string; nullifier: Hex; outputs: Hex[]; storeAtSend: StoredNote[] };

type Internals = {
  submitIntent: (intent: GloamIntent) => Promise<Hex>;
  tree: unknown;
  prover: () => Promise<unknown>;
  requestKeyOf: (payTo: string, asset: { address: Address }, amountWei: bigint) => string;
};

/**
 * An agent whose sends are recorded and land at once, unless the move (a transfer) is
 * refused before it goes out or its answer is lost. Transfers and cash outs are proved
 * with a stand-in prover: which note each one spends is what is checked here.
 */
async function setup(move: "lands" | "refused" | "lost" = "lands") {
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
    getTransactionReceipt: async () => {
      throw new Error("fake chain: receipt not found");
    },
  } as unknown as PublicClient;
  const dir = mkdtempSync(join(tmpdir(), "gloam-proof-cashout-"));
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
  internals.tree = { sync: async () => ({ pathForCommitment }) };
  internals.prover = async () => async () => ({ proofBytes: "0x00" as Hex });

  const sent: Sent[] = [];
  internals.submitIntent = async (intent) => {
    const exec = intent.exec!;
    const nullifier = exec.args[2] as Hex;
    const outputs = exec.fn === "transfer" ? [...(exec.args[3] as readonly Hex[])] : [];
    sent.push({ fn: exec.fn, nullifier, outputs, storeAtSend: agent.store.list() });
    if (exec.fn === "transfer" && move === "refused") throw Object.assign(new Error("The relay refused it."), { notSent: true });
    if (exec.fn === "transfer" && move === "lost") throw new Error("The relay did not answer in time.");
    spent.add(nullifier.toLowerCase());
    for (const c of outputs) seen.add(c.toLowerCase());
    return hashOf(sent.length);
  };

  const addNote = async (amountWei: bigint, extra: Partial<StoredNote> = {}) => {
    const n = await makeBoundNotePoseidon(amountWei, usdc);
    seen.add(n.commitment.toLowerCase());
    return agent.store.add({
      network: "base", chainId: 84532, pool: agent.network.pool, asset: usdc, symbol: "USDC", decimals: 6,
      amountWei: amountWei.toString(), secret: n.secret, commitment: n.commitment, nullifier: n.nullifier,
      status: "unspent", origin: "shield", createdTx: null, ...extra,
    } as never);
  };
  return { agent, internals, sent, addNote };
}

test("a note behind a proof of funds moves to a fresh note before a cash out, and the cash out spends the fresh note", { timeout: 120_000 }, async () => {
  const { agent, sent, addNote } = await setup();
  const proven = await addNote(10_000_000n);
  const other = await addNote(3_000_000n);
  const made = await agent.proveFunds({ atLeast: "8", for: "Test reader" });
  assert.equal(made.status, "done", JSON.stringify(made));
  assert.ok(agent.store.get(proven.handle)?.fundsProofAt, "the note behind the proof is marked");
  assert.equal(agent.store.get(other.handle)?.fundsProofAt, undefined, "a note the proof does not use is not");
  const proof = decodeProof(String(made.proof));
  assert.ok(proof.kind === "funds" && proof.nullifiers.some((x) => same(x, proven.nullifier)), "the proof carries the note's nullifier");

  const out = await agent.cashOut({ amount: "10", to: TO });
  assert.equal(out.status, "done", JSON.stringify(out));
  assert.deepEqual(sent.map((s) => s.fn), ["transfer", "unshield"], "moved first, then cashed out");
  const [move, cash] = sent as [Sent, Sent];
  assert.ok(same(move.nullifier, proven.nullifier), "the move spends the proven note");
  const fresh = agent.store.list().find((n) => same(n.commitment, move.outputs[0]!));
  assert.ok(fresh, "the fresh note is in the store");
  assert.equal(fresh.amountWei, "10000000", "the whole note moved");
  assert.ok(
    move.storeAtSend.some((n) => n.handle === fresh.handle && n.secret === fresh.secret),
    "the fresh note was saved before the move was sent"
  );
  assert.ok(same(cash.nullifier, fresh.nullifier), "the cash out spends the fresh note");
  assert.ok(!same(cash.nullifier, proven.nullifier), "never the nullifier in the proof");
  assert.equal(fresh.fundsProofAt, undefined, "the fresh note is behind no proof");
  assert.equal(agent.store.get(proven.handle)?.status, "spent");
  assert.equal(fresh.status, "spent");
  assert.equal(out.moveHash, hashOf(1));
  assert.equal(out.splitHash, undefined);
  assert.match(String(out.moved), /proof of funds/);
});

test("a move that fails cashes nothing out: the proven note is never cashed out directly", { timeout: 60_000 }, async () => {
  // Refused before it went out: an error, the note is free again and still marked, the fresh note is dropped.
  const refused = await setup("refused");
  const note = await refused.addNote(10_000_000n, { fundsProofAt: new Date().toISOString() });
  const out = await refused.agent.cashOut({ amount: "10", to: TO });
  assert.equal(out.status, "error", JSON.stringify(out));
  assert.match(String(out.message), /proof of funds/);
  assert.match(String(out.message), /Nothing was cashed out/);
  assert.deepEqual(refused.sent.map((s) => s.fn), ["transfer"], "no cash out was sent");
  assert.ok(same(refused.sent[0]!.nullifier, note.nullifier));
  assert.equal(refused.sent[0]!.storeAtSend.length, 2, "the fresh note was saved before the move was sent");
  const kept = refused.agent.store.get(note.handle);
  assert.equal(kept?.status, "unspent", "the note is free again");
  assert.ok(kept?.fundsProofAt, "and still marked, so the next cash out moves it too");
  assert.deepEqual(refused.agent.store.list().map((n) => n.handle), [note.handle], "the fresh note of a move that never went out is dropped");

  // Its answer lost: the move may land, so its fresh note is kept, nothing is cashed out, and the same cash out waits.
  const lost = await setup("lost");
  const held = await lost.addNote(10_000_000n, { fundsProofAt: new Date().toISOString() });
  const unsure = await lost.agent.cashOut({ amount: "10", to: TO });
  assert.equal(unsure.status, "unconfirmed", JSON.stringify(unsure));
  assert.match(String(unsure.message), /move to a fresh note before the cash out was sent/);
  assert.equal(unsure.cashedOut, "nothing yet");
  assert.deepEqual(lost.sent.map((s) => s.fn), ["transfer"], "no cash out was sent");
  const fresh = lost.agent.store.list().find((n) => same(n.commitment, lost.sent[0]!.outputs[0]!));
  assert.equal(fresh?.status, "pending", "the fresh note is kept: the move may have landed");
  assert.equal(lost.agent.store.get(held.handle)?.status, "pending", "the proven note stays held");
  const again = await lost.agent.cashOut({ amount: "10", to: TO });
  assert.equal(again.code, "unconfirmed_cash_out", JSON.stringify(again));
  assert.equal(lost.sent.length, 1, "nothing more was sent");
});

test("a note kept for a cash out and put behind a proof since is moved too", { timeout: 60_000 }, async () => {
  const { agent, internals, sent, addNote } = await setup();
  const key = internals.requestKeyOf(`cash_out:${TO.toLowerCase()}`, { address: usdc }, 10_000_000n);
  const ready = await addNote(10_000_000n, { origin: "change", requestKey: key, fundsProofAt: new Date().toISOString() });
  const out = await agent.cashOut({ amount: "10", to: TO });
  assert.equal(out.status, "done", JSON.stringify(out));
  assert.deepEqual(sent.map((s) => s.fn), ["transfer", "unshield"]);
  assert.ok(same(sent[0]!.nullifier, ready.nullifier), "the move spends the kept note");
  assert.ok(!same(sent[1]!.nullifier, ready.nullifier), "the cash out does not");
});

test("a note behind no proof cashes out directly, as before; a proven note above the amount is split as before", { timeout: 60_000 }, async () => {
  const whole = await setup();
  const note = await whole.addNote(10_000_000n);
  const out = await whole.agent.cashOut({ amount: "10", to: TO });
  assert.equal(out.status, "done", JSON.stringify(out));
  assert.deepEqual(whole.sent.map((s) => s.fn), ["unshield"], "no move");
  assert.ok(same(whole.sent[0]!.nullifier, note.nullifier));
  assert.equal(out.moveHash, undefined);
  assert.equal(out.splitHash, undefined);
  assert.equal(out.moved, undefined);

  const part = await setup();
  await part.addNote(10_000_000n, { fundsProofAt: new Date().toISOString() });
  const some = await part.agent.cashOut({ amount: "4", to: TO });
  assert.equal(some.status, "done", JSON.stringify(some));
  assert.deepEqual(part.sent.map((s) => s.fn), ["transfer", "unshield"], "a split, as before (it spends the note through a private send)");
  assert.equal(some.splitHash, hashOf(1));
  assert.equal(some.moveHash, undefined);
});
