/**
 * Note custody tests: the encrypted note store, its lock, and the tools that
 * use it, driven through a real MCP client over an in-memory transport.
 *
 *   pnpm --filter @gloamtrade/mcp test
 *
 * No chain: a mock pool applies shieldBound and transfer with the contract's
 * rules (known root, nullifier spent once, fresh commitments), and proofs are
 * stubbed. Covers: encryption at rest, wrong keys, the lock across processes,
 * shield -> pay -> verify (sweep) end to end, replays, a payer spending a
 * payment back, the x402 fetch round trip, the legacy flag, that limits still
 * gate before any proving, and that no tool result ever carries a secret.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TransactionNotFoundError, encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex } from "viem";
import {
  IncrementalMerkleTreePoseidon,
  buildPrivateSendIntent,
  decodePaymentHeader,
  decodeRequirements,
  encodePaymentHeader,
  encodeNotePackage,
  encodeRequirements,
  fieldToHex,
  FIELD_PRIME,
  hexToField,
  openGloamPaymentNote,
  sealToReceiveTag,
  GloamRelayError,
  GLOAM_NETWORKS,
  GLOAM_VS_ZONE,
  TEMPO_PATHUSD,
} from "@gloamtrade/sdk";
import { createGloamServer, type ServerDeps } from "../src/server.js";
import type { Signer } from "../src/signer.js";
import { NoteStore, noteStoreKey, openNoteStore, type NewNote } from "../src/noteStore.js";
import { noteBroadcast } from "../src/walletSend.js";
import { keptPoolTrees, poolTreeParams } from "../src/poolTree.js";

type Env = Record<string, string | undefined>;
const TEMPO = GLOAM_NETWORKS.tempo;
const KEY_A = "a1".repeat(32);
const KEY_B = "b2".repeat(32);

function sampleNote(over: Partial<NewNote> = {}): NewNote {
  return {
    network: "tempo",
    chainId: TEMPO.chainId,
    pool: TEMPO.pool,
    asset: TEMPO_PATHUSD,
    symbol: "PathUSD",
    decimals: 6,
    amountWei: "1234567",
    secret: `0x${"5e".repeat(31)}` as Hex,
    commitment: `0x${"c0".repeat(32)}` as Hex,
    nullifier: `0x${"0f".repeat(32)}` as Hex,
    status: "unspent",
    origin: "shield",
    createdTx: null,
    ...over,
  };
}

const tmp = () => mkdtempSync(join(tmpdir(), "gloam-notes-"));

// ------------------------------------------------------------------ child modes (lock races)

if (process.argv.includes("--add-notes") || process.argv.includes("--reserve")) {
  const env = JSON.parse(process.env.TEST_ENV!) as Env;
  const store = openNoteStore(env);
  if (process.argv.includes("--add-notes")) {
    for (let i = 0; i < 5; i++) store.add(sampleNote({ label: `${process.pid}-${i}` }));
    process.stdout.write("ok");
  } else {
    try {
      store.reserveForSpend(process.env.TEST_HANDLE!);
      process.stdout.write("ok");
    } catch {
      process.stdout.write("refused");
    }
  }
} else {
  // ---------------------------------------------------------------- the store

  test("a purchase is claimed once, and its sends stay on record until the answer arrived", () => {
    const dir = tmp();
    const env: Env = { GLOAM_AGENT_ID: "bot", GLOAM_NOTE_KEY: KEY_A, GLOAM_NOTE_STORE: join(dir, "notes.json") };
    const store = openNoteStore(env);
    const ten = 10 * 60_000;
    const me = (n: number) => `${process.pid}:srv:${n}`;
    const sent = (handle: string, input: string | null = null, header = "h") => ({ note: handle, input, header });
    const payment = (over: Partial<NewNote> = {}) => store.add(sampleNote({ origin: "payment", status: "pending", pending: "create", ...over }));

    // Of two calls, one holds it; the other is told it is running, and that counts as a retry.
    assert.deepEqual(store.claimPayment("a", ten, me(1)), { claimed: true });
    const running = openNoteStore(env).claimPayment("a", ten, me(2));
    assert.ok(!running.claimed && running.running);
    assert.equal(running.attempt.retried, true);

    // Nothing went out: the record goes, whatever the caller heard.
    assert.equal(store.closePayment("a", me(1), false), null);
    assert.deepEqual(store.claimPayment("a", ten, me(3)), { claimed: true });
    assert.equal(store.closePayment("a", me(3), true), null);

    // A send whose note was taken back surely never went out.
    store.claimPayment("a2", ten, me(30));
    const gone = payment();
    store.markSend("a2", me(30), sent(gone.handle));
    store.remove(gone.handle);
    assert.equal(store.closePayment("a2", me(30), false), null);

    // Heard about a landed payment: gone, and the next call is a new purchase.
    const paid = payment();
    store.claimPayment("b", ten, me(4));
    assert.equal(store.markSend("b", me(4), sent(paid.handle)), true);
    store.update(paid.handle, { status: "spent" });
    assert.equal(store.closePayment("b", me(4), true), null);
    assert.deepEqual(store.claimPayment("b", ten, me(5)), { claimed: true });
    store.closePayment("b", me(5), true);

    // Not heard: it stays, and one later call takes it over.
    const kept = payment();
    store.claimPayment("c", ten, me(6));
    store.markSend("c", me(6), sent(kept.handle, null, "early"));
    store.markPresented("c", me(6), kept.handle, { header: "final", authorization: "Payment x" });
    store.update(kept.handle, { status: "spent" });
    const during = store.claimPayment("c", ten, me(7));
    assert.ok(!during.claimed && during.running, "while the first call runs it is not presented twice");
    assert.deepEqual(store.closePayment("c", me(6), true), { landed: kept.handle }, "a retry came, so the first caller may not have heard");
    const takeOver = store.claimPayment("c", ten, me(8));
    assert.ok(!takeOver.claimed && !takeOver.running);
    assert.equal(takeOver.sends[0]!.header, "final");
    assert.equal(takeOver.attempt.authorization, "Payment x");
    assert.equal(store.closePayment("c", me(6), true), null, "a call that gave it up has no say");
    assert.equal(store.closePayment("c", me(8), true), null);

    // Whatever became of a send, a later call is shown it, oldest first, with its notes: dead and pending ones too.
    const funding = store.add(sampleNote({ status: "pending", pending: "spend" }));
    const dead = payment();
    const pending = payment();
    store.claimPayment("d", ten, me(10));
    store.markSend("d", me(10), sent(dead.handle, funding.handle));
    store.markDead(dead.handle);
    assert.deepEqual(store.closePayment("d", me(10), false), { landed: null });
    const again = store.claimPayment("d", ten, me(11));
    assert.ok(!again.claimed && !again.running);
    assert.equal(again.sends[0]!.funding?.handle, funding.handle);
    store.markSend("d", me(11), sent(pending.handle, funding.handle));
    store.closePayment("d", me(11), false);
    const both = store.claimPayment("d", ten, me(12));
    assert.ok(!both.claimed);
    assert.deepEqual(both.sends.map((x) => x.note), [dead.handle, pending.handle]);
    store.closePayment("d", me(12), false);

    // Never reached a send: free once its process is gone, or it is old. A live one holds, and a call that gave way cannot send.
    store.claimPayment("e", ten, `${2 ** 22 + 1}:gone:1`);
    assert.deepEqual(store.claimPayment("e", ten, me(13)), { claimed: true });
    assert.ok(!store.claimPayment("e", ten, me(14)).claimed);
    assert.deepEqual(store.claimPayment("e", 0, me(15)), { claimed: true });
    assert.equal(store.markSend("e", me(13), sent("n-late")), false);
    store.closePayment("e", me(15), true);

    // A payment presented by hand and served is finished, by either form it was handed out in.
    const byHand = payment({ status: "spent" });
    store.claimPayment("i", ten, me(21));
    store.markSend("i", me(21), sent(byHand.handle, null, "h6"));
    store.markPresented("i", me(21), byHand.handle, { authorization: "Payment y" });
    store.closePayment("i", me(21), false);
    store.dropPresented("something else");
    assert.ok(!store.claimPayment("i", 0, me(31)).claimed);
    store.closePayment("i", me(31), false);
    store.dropPresented("Payment y");
    assert.deepEqual(store.claimPayment("i", ten, me(32)), { claimed: true });
    store.closePayment("i", me(32), true);

    // A challenge is paid once: an answer that arrived does not clear it, nor does presenting it.
    const single = payment({ status: "spent" });
    store.claimPayment("j", ten, me(22), true);
    store.markSend("j", me(22), sent(single.handle, null, "h7"));
    assert.deepEqual(store.closePayment("j", me(22), true), { landed: single.handle });
    store.dropPresented("h7");
    assert.ok(!store.claimPayment("j", ten, me(23)).claimed);
    store.closePayment("j", me(23), true);

    // Records age from the last thing that happened to them, and one not known to have landed or not stays.
    const open_ = payment();
    store.claimPayment("k", ten, me(24));
    store.markSend("k", me(24), sent(open_.handle));
    store.closePayment("k", me(24), false);
    const late = payment();
    store.claimPayment("l", ten, me(25));
    store.markSend("l", me(25), sent(late.handle));
    store.closePayment("l", me(25), false);
    const realNow = Date.now;
    const hours = (h: number) => {
      Date.now = () => realNow() + h * 60 * 60 * 1000;
    };
    try {
      hours(23);
      store.update(late.handle, { status: "spent" }); // a refresh finds it landed, a day on
      hours(40);
      const held = store.claimPayment("l", ten, me(26));
      assert.ok(!held.claimed, "still there the day after that was found out");
      store.closePayment("l", me(26), false);
      hours(50);
      assert.deepEqual(store.claimPayment("l", ten, me(27)), { claimed: true }, "a day after its payment last changed it goes, though a retry came since");
      assert.deepEqual(store.claimPayment("j", ten, me(28)), { claimed: true }, "so does a challenge");
      const stillOpen = store.claimPayment("k", ten, me(29));
      assert.ok(!stillOpen.claimed && !stillOpen.running, "not known yet: still held");
      store.closePayment("k", me(29), false);
      hours(33 * 24);
      assert.deepEqual(store.claimPayment("k", ten, me(33)), { claimed: true }, "but not for ever");
    } finally {
      Date.now = realNow;
    }
  });

  test("serving a payment late never rolls a note's own status back (it was read before the lock)", () => {
    const dir = tmp();
    const env: Env = { GLOAM_AGENT_ID: "bot", GLOAM_NOTE_KEY: KEY_A, GLOAM_NOTE_STORE: join(dir, "notes.json") };
    const store = openNoteStore(env);
    const paid = `0x${"ab".repeat(32)}` as Hex;
    const tx = `0x${"77".repeat(32)}` as Hex;
    // confirmed, then picked to pay with: a late serve must not make it spendable again
    const mid = store.add(sampleNote({ sweptFrom: paid }));
    store.update(mid.handle, { status: "pending", pending: "spend" });
    const one = store.claimServed(mid.handle, { status: "unspent", createdTx: tx });
    assert.ok(one.claimed);
    assert.equal(one.claimed && one.note.status, "pending");
    assert.equal(store.get(mid.handle)!.pending, "spend");
    assert.equal(store.get(mid.handle)!.served, true);
    // already spent stays spent
    const spent = store.add(sampleNote({ sweptFrom: `0x${"cd".repeat(32)}` as Hex, status: "spent" }));
    store.claimServed(spent.handle, { status: "unspent" });
    assert.equal(store.get(spent.handle)!.status, "spent");
    // a note still being created takes the confirmed status
    const fresh = store.add(sampleNote({ sweptFrom: `0x${"ef".repeat(32)}` as Hex }));
    store.update(fresh.handle, { status: "pending", pending: "create" });
    store.claimServed(fresh.handle, { status: "unspent", createdTx: tx });
    assert.equal(store.get(fresh.handle)!.status, "unspent");
    assert.equal(store.get(fresh.handle)!.pending, undefined);
    assert.equal(store.get(fresh.handle)!.createdTx, tx);
  });

  test("the note store is encrypted at rest and opens only with its key", () => {
    const dir = tmp();
    const env: Env = { GLOAM_AGENT_ID: "bot", GLOAM_NOTE_KEY: KEY_A, GLOAM_NOTE_STORE: join(dir, "notes.json") };
    const store = openNoteStore(env);
    const added = store.add(sampleNote());
    assert.match(added.handle, /^n-[a-z2-9]{10}$/);
    assert.ok(!added.handle.includes("5e5e"), "the handle is not derived from the secret");

    const raw = readFileSync(env.GLOAM_NOTE_STORE!, "utf8");
    const file = JSON.parse(raw);
    assert.equal(file.format, "gloam-note-store");
    assert.equal(file.cipher, "aes-256-gcm");
    assert.equal(file.keySource, "GLOAM_NOTE_KEY");
    for (const leak of ["5e5e5e", "c0c0c0", "0f0f0f", "1234567", "unspent", "PathUSD", added.handle]) {
      assert.ok(!raw.includes(leak), `the file on disk does not show ${leak}`);
    }
    assert.equal(statSync(env.GLOAM_NOTE_STORE!).mode & 0o777, 0o600, "only the owner can read the file");

    // Same key: everything comes back.
    const again = openNoteStore(env).get(added.handle);
    assert.equal(again?.secret, sampleNote().secret);
    assert.equal(again?.amountWei, "1234567");

    // Wrong key: refused, and the file is never overwritten.
    const wrong = openNoteStore({ ...env, GLOAM_NOTE_KEY: KEY_B });
    assert.throws(() => wrong.list(), /cannot be opened: the key does not match/);
    assert.throws(() => wrong.add(sampleNote()), /never overwritten/);
    assert.equal(readFileSync(env.GLOAM_NOTE_STORE!, "utf8"), raw, "a failed write leaves the store untouched");

    // A tampered file does not decrypt.
    const tampered = { ...file, data: Buffer.from("x".repeat(40)).toString("base64") };
    writeFileSync(env.GLOAM_NOTE_STORE!, JSON.stringify(tampered));
    assert.throws(() => openNoteStore(env).list(), /cannot be opened/);
    writeFileSync(env.GLOAM_NOTE_STORE!, raw);

    // The store is bound to its agent.
    const other = join(dir, "other.json");
    copyFileSync(env.GLOAM_NOTE_STORE!, other);
    assert.throws(() => openNoteStore({ ...env, GLOAM_AGENT_ID: "mallory", GLOAM_NOTE_STORE: other }).list(), /belongs to agent "bot"/);
  });

  test("the store key: GLOAM_NOTE_KEY, else derived from the signer, never missing", () => {
    const pk = `0x${"11".repeat(32)}`;
    const a = noteStoreKey({ GLOAM_AGENT_PRIVATE_KEY: pk });
    const b = noteStoreKey({ GLOAM_AGENT_PRIVATE_KEY: pk });
    assert.equal(a.source, "signer");
    assert.ok(a.key.equals(b.key), "derivation is stable");
    assert.ok(!a.key.equals(Buffer.from("11".repeat(32), "hex")), "the store key is not the signing key");
    const n = noteStoreKey({ GLOAM_AGENT_PRIVATE_KEY: pk, GLOAM_NOTE_KEY: KEY_A });
    assert.equal(n.source, "GLOAM_NOTE_KEY");
    assert.ok(!n.key.equals(a.key));
    assert.throws(() => noteStoreKey({ GLOAM_NOTE_KEY: "correct horse battery staple" }), /32 random bytes in hex/);
    assert.throws(() => noteStoreKey({}), /no key for the note store/);

    // Switching key source explains itself.
    const dir = tmp();
    const env: Env = { GLOAM_AGENT_PRIVATE_KEY: pk, GLOAM_NOTE_STORE: join(dir, "n.json") };
    openNoteStore(env).add(sampleNote());
    assert.throws(() => openNoteStore({ ...env, GLOAM_NOTE_KEY: KEY_A }).list(), /written with a key derived from the signer/);
  });

  test("a payment is settled by one verify at a time; a claim left by a crash or a failed write does not block it", () => {
    const store = openNoteStore({ GLOAM_NOTE_KEY: KEY_A, GLOAM_NOTE_STORE: join(tmp(), "n.json") });
    const nf = `0x${"ab".repeat(32)}` as Hex;
    const ten = 10 * 60 * 1000;
    assert.equal(store.claimSettle(nf, ten, "a"), true);
    assert.equal(store.claimSettle(nf, ten, "b"), false, "another verify waits");
    assert.equal(store.claimSettle(nf, ten, "a"), true, "a claim this same server left behind (its release failed) is taken back");
    store.releaseSettle(nf);
    assert.equal(store.claimSettle(nf, ten, "b"), true);
    // A claim from a process that is gone (pid 2^22 + 1 is above every real pid here) does not wait out the ten minutes.
    const gone = `0x${"cd".repeat(32)}` as Hex;
    assert.equal(store.claimSettle(gone, ten, `${2 ** 22 + 1}:x`), true);
    assert.equal(store.claimSettle(gone, ten, `${process.pid}:y`), true);
    assert.equal(store.claimSettle(gone, ten, `${process.pid}:z`), false, "a live one does");
  });

  test("a note is reserved for one spend at a time", () => {
    const env: Env = { GLOAM_NOTE_KEY: KEY_A, GLOAM_NOTE_STORE: join(tmp(), "n.json") };
    const store = openNoteStore(env);
    const { handle } = store.add(sampleNote());
    const r = store.reserveForSpend(handle);
    assert.equal(r.status, "pending");
    assert.equal(r.pending, "spend");
    assert.throws(() => store.reserveForSpend(handle), /in use by a transaction/);
    store.update(handle, { status: "unspent" });
    assert.equal(store.get(handle)?.pending, undefined, "pending is cleared with the status");
    assert.throws(() => store.reserveForSpend(handle, () => "too small"), /too small/);
    assert.equal(store.get(handle)?.status, "unspent", "a failed check reserves nothing");
    store.update(handle, { status: "spent" });
    assert.throws(() => store.reserveForSpend(handle), /already spent/);
    assert.throws(() => store.reserveForSpend("n-nope"), /no note "n-nope"/);
  });

  const runChildren = (mode: string, env: Env, n: number, extra: Env = {}) => {
    const self = fileURLToPath(import.meta.url);
    const tsx = join(fileURLToPath(new URL("..", import.meta.url)), "node_modules", ".bin", "tsx");
    return Promise.all(
      Array.from(
        { length: n },
        () =>
          new Promise<string>((resolve, reject) => {
            const child = spawn(tsx, [self, mode], { env: { ...process.env, ...extra, TEST_ENV: JSON.stringify(env) } });
            let out = "";
            child.stdout.on("data", (d) => (out += d));
            child.on("error", reject);
            child.on("close", () => resolve(out.trim()));
          })
      )
    );
  };

  test("parallel server processes never lose a note or double-reserve one (the store is locked)", async () => {
    const env: Env = { GLOAM_NOTE_KEY: KEY_A, GLOAM_NOTE_STORE: join(tmp(), "n.json") };
    const adds = await runChildren("--add-notes", env, 6);
    assert.deepEqual(adds, Array(6).fill("ok"));
    const notes = openNoteStore(env).list();
    assert.equal(notes.length, 30, "6 processes x 5 notes, none lost");
    assert.equal(new Set(notes.map((n) => n.handle)).size, 30, "handles are unique");

    const { handle } = openNoteStore(env).add(sampleNote());
    const races = await runChildren("--reserve", env, 6, { TEST_HANDLE: handle });
    assert.equal(races.filter((r) => r === "ok").length, 1, races.join(","));
  });

  // ---------------------------------------------------------------- the tools, over MCP

  /** A pool that follows the contract's rules for shieldBound and transfer. */
  function mockChain() {
    const tree = new IncrementalMerkleTreePoseidon();
    const index = new Map<string, number>();
    const roots = new Set<string>();
    const spent = new Set<string>();
    const receipts = new Map<string, "success" | "reverted">();
    const calls: string[] = [];
    let n = 0;
    const lc = (h: string) => h.toLowerCase();
    const insert = async (c: string) => {
      index.set(lc(c), await tree.insert(hexToField(c)));
      roots.add(lc(fieldToHex(tree.currentRoot)));
    };
    async function apply(fn: string, args: readonly unknown[]): Promise<Hex> {
      const hash = `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
      let ok = true;
      if (fn === "shieldBound") {
        const c = String(args[2]);
        ok = !index.has(lc(c));
        if (ok) await insert(c);
      } else if (fn === "transfer") {
        const [, root, nullifier, outs] = args as [Hex, Hex, Hex, Hex[]];
        ok = roots.has(lc(root)) && !spent.has(lc(nullifier)) && outs.every((c) => !index.has(lc(c)));
        if (ok) {
          spent.add(lc(nullifier));
          for (const c of outs) await insert(c);
        }
      }
      receipts.set(hash, ok ? "success" : "reverted");
      return hash;
    }
    const publicClient = {
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: receipts.get(hash) ?? "reverted", from: "0x0000000000000000000000000000000000000abc" }),
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: receipts.get(hash) ?? "reverted" }),
      readContract: async ({ functionName, args }: { functionName: string; args: [Hex] }) =>
        functionName === "isSpent" ? spent.has(lc(args[0])) : index.has(lc(args[0])),
    };
    const walletClient = {
      writeContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
        calls.push(functionName);
        return apply(functionName, args);
      },
      sendTransaction: async () => {
        calls.push("send");
        return apply("send", []);
      },
    };
    const syncTree = async () => ({
      pathForCommitment: async (c: Hex) => (index.has(lc(c)) ? tree.path(index.get(lc(c))!) : null),
    });
    return { publicClient, walletClient, syncTree, calls, apply, path: (c: Hex) => tree.path(index.get(lc(c))!) };
  }

  type Chain = ReturnType<typeof mockChain>;

  function makeDeps(chain: Chain, env: Env, extra: Partial<ServerDeps> = {}) {
    const proofs = { count: 0 };
    const prover = async () => {
      proofs.count++;
      return { proofBytes: "0xdeadbeef" as Hex };
    };
    const deps: Partial<ServerDeps> = {
      env,
      signer: (net) =>
        env.GLOAM_AGENT_PRIVATE_KEY
          ? ({ account: { address: "0x0000000000000000000000000000000000000abc" }, network: net, walletClient: chain.walletClient, publicClient: chain.publicClient } as unknown as Signer)
          : null,
      publicClient: () => chain.publicClient as unknown as Signer["publicClient"],
      shieldProver: async () => prover,
      transferProver: async () => prover,
      syncTree: chain.syncTree as unknown as ServerDeps["syncTree"],
      relay: async (intent) => chain.apply("transfer", intent.exec!.args),
      ...extra,
    };
    return { deps, proofs };
  }

  /** Every tool result text this test has seen, for the secret scan. */
  const seen: string[] = [];

  async function connect(deps: Partial<ServerDeps>) {
    const server = createGloamServer(deps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "gloam-test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      const raw = (r.content as { type: string; text: string }[])[0]!.text;
      seen.push(raw);
      return JSON.parse(raw);
    };
    return { call, client };
  }

  function partyEnv(name: string, dir: string, over: Env = {}): Env {
    return {
      GLOAM_AGENT_ID: name,
      GLOAM_AGENT_PRIVATE_KEY: `0x${(name === "payer" ? "11" : "22").repeat(32)}`,
      GLOAM_NOTE_STORE: join(dir, `${name}-notes.json`),
      GLOAM_SPEND_LOG: join(dir, `${name}-log.json`),
      ...over,
    };
  }

  const PAYER_LIMITS: Env = {
    GLOAM_LIMIT_ASSETS: "PathUSD",
    GLOAM_LIMIT_MAX_PER_PAYMENT: "10",
    GLOAM_LIMIT_MAX_PER_DAY: "50",
    GLOAM_LIMIT_RECIPIENTS: "any",
    GLOAM_LIMIT_TOOLS: "pay,shield",
  };

  /** Every secret either party holds: note secrets (hex and decimal), receive keys, and the payment notes in flight. */
  function secretsOf(envs: Env[], extra: string[] = []): string[] {
    const out: string[] = [...extra];
    for (const env of envs) {
      const data = openNoteStore(env);
      for (const n of data.list()) out.push(n.secret.slice(2).toLowerCase(), hexToField(n.secret).toString());
      const rk = data.receiveKey();
      if (rk?.privateJwk.d) out.push(rk.privateJwk.d);
    }
    return out.filter((s) => s.length >= 20);
  }

  function assertNoSecrets(secrets: string[]) {
    for (const raw of seen) {
      const low = raw.toLowerCase();
      for (const s of secrets) assert.ok(!low.includes(s.toLowerCase()), `a tool result leaked a secret: ${raw.slice(0, 200)}`);
    }
  }

  test("shield -> pay -> verify: handles only, sealed to the payee, swept before access", async () => {
    const dir = tmp();
    const chain = mockChain();
    const payerEnv = partyEnv("payer", dir, PAYER_LIMITS);
    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off" });
    const payer = makeDeps(chain, payerEnv);
    const payee = makeDeps(chain, payeeEnv);
    const P = await connect(payer.deps);
    const S = await connect(payee.deps);
    const paymentSecrets: string[] = [];

    // The agent shields and gets a handle, not a secret.
    const shield = await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    assert.equal(shield.status, "confirmed", JSON.stringify(shield));
    assert.match(shield.note.handle, /^n-/);
    assert.equal(shield.note.secret, undefined);
    assert.equal(shield.note.commitment, undefined);
    assert.equal(shield.note.amount, "10");
    assert.deepEqual(chain.calls, ["approve", "shieldBound"]);
    const stored = openNoteStore(payerEnv).get(shield.note.handle)!;
    assert.equal(stored.status, "unspent");
    assert.equal(stored.createdTx, shield.hash);

    const list = await P.call("gloam_list_notes", {});
    assert.equal(list.balances[0].spendable, "10");
    assert.equal(list.notes[0].handle, shield.note.handle);

    // The payee prices a resource to its own receive tag.
    const tag = await S.call("gloam_receive_tag");
    assert.match(tag.tag, /^gloamr1\./);
    const priced = await S.call("gloam_payment_requirements", {
      amount: 3, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "https://api.example/answer", network: "tempo",
    });
    assert.equal(priced.requirements.payTo, tag.tag);

    // The agent pays by handle (here: lets the server pick).
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    assert.equal(paid.status, "paid", JSON.stringify(paid));
    assert.equal(paid.sealedToPayee, true);
    assert.equal(paid.spentNote, shield.note.handle);
    assert.equal(paid.change.amount, "7");
    assert.equal(paid.paymentNote, undefined);
    assert.equal(paid.persistChangeNote, undefined);
    assert.match(paid.paymentHeader, /^gloamx402pay1:/);
    assert.match(decodePaymentHeader(paid.paymentHeader).payload.paymentNote, /^gloam2t\./);
    const payerStore = openNoteStore(payerEnv);
    assert.equal(payerStore.get(shield.note.handle)?.status, "spent");
    assert.equal(payerStore.get(paid.change.handle)?.status, "unspent");
    const opened = await openGloamPaymentNote(decodePaymentHeader(paid.paymentHeader).payload.paymentNote, openNoteStore(payeeEnv).receiveKey()!);
    paymentSecrets.push(opened.secret.slice(2), hexToField(opened.secret).toString());

    // The payee verifies: opens, checks, sweeps, and only then grants access.
    const v = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: paid.paymentHeader });
    assert.equal(v.status, "settled", JSON.stringify(v));
    assert.equal(v.grantAccess, true);
    assert.equal(v.final, true);
    assert.equal(v.received.amount, "3");
    assert.equal(v.received.origin, "received");
    const received = openNoteStore(payeeEnv).get(v.received.handle)!;
    assert.equal(received.status, "unspent");
    assert.notEqual(received.secret, opened.secret, "the payee's money sits under a secret the payer never saw");

    // The same header again: refused, not served twice.
    const replay = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: paid.paymentHeader });
    assert.equal(replay.status, "already_settled");
    assert.equal(replay.grantAccess, false);

    // The payer now cannot spend the payment back: the pool refuses the nullifier.
    const back = await buildPrivateSendIntent({
      secretHex: opened.secret, amountInWei: 3_000_000n, amountPayWei: 3_000_000n, asset: TEMPO_PATHUSD,
      path: await chain.path(opened.commitment), prove: async () => ({ proofBytes: "0x00" }), poolAddress: TEMPO.pool, chainId: TEMPO.chainId,
    });
    const h = await chain.apply("transfer", back.exec.args);
    assert.equal((await chain.publicClient.waitForTransactionReceipt({ hash: h })).status, "reverted");

    // A payer that spends the payment back BEFORE the sweep gets nothing.
    const paid2 = await P.call("gloam_execute_private_pay", { requirements: priced.encoded, note: paid.change.handle });
    assert.equal(paid2.status, "paid", JSON.stringify(paid2));
    const note2 = await openGloamPaymentNote(decodePaymentHeader(paid2.paymentHeader).payload.paymentNote, openNoteStore(payeeEnv).receiveKey()!);
    paymentSecrets.push(note2.secret.slice(2), hexToField(note2.secret).toString());
    const steal = await buildPrivateSendIntent({
      secretHex: note2.secret, amountInWei: 3_000_000n, amountPayWei: 3_000_000n, asset: TEMPO_PATHUSD,
      path: await chain.path(note2.commitment), prove: async () => ({ proofBytes: "0x00" }), poolAddress: TEMPO.pool, chainId: TEMPO.chainId,
    });
    await chain.apply("transfer", steal.exec.args);
    const before = openNoteStore(payeeEnv).list().length;
    const v2 = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: paid2.paymentHeader });
    assert.equal(v2.status, "already_spent", JSON.stringify(v2));
    assert.equal(v2.grantAccess, false);
    assert.match(v2.message, /do not grant access/);
    assert.equal(openNoteStore(payeeEnv).list().length, before, "nothing stored for a payment that was taken back");

    // No tool result, on either side, ever carried a secret.
    assertNoSecrets(secretsOf([payerEnv, payeeEnv], paymentSecrets));
  });

  test("a sealed ticket copied from the payment board is not an x402 payment", async () => {
    const dir = tmp();
    const chain = mockChain();
    const payerEnv = partyEnv("payer", dir, PAYER_LIMITS);
    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off" });
    const P = await connect(makeDeps(chain, payerEnv).deps);
    const S = await connect(makeDeps(chain, payeeEnv).deps);
    const priced = await S.call("gloam_payment_requirements", {
      amount: 1, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "answer", network: "tempo",
    });
    await P.call("gloam_execute_shield", { amount: 5, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    assert.equal(paid.status, "paid", JSON.stringify(paid));
    const payload = decodePaymentHeader(paid.paymentHeader);
    assert.match(String(payload.payload.binding), /^[A-Za-z0-9_-]{43}$/, "a current payer binds its payment");

    // What a stranger can build from the board: the same sealed ticket (a real, landed,
    // unspent note for this payee), in an X-PAYMENT of their own, with no binding.
    const lifted = { ...payload, payload: { paymentNote: payload.payload.paymentNote, txHash: null, exec: { fn: "transfer", poolAddress: payload.payload.exec.poolAddress } } };
    const before = openNoteStore(payeeEnv).list().length;
    const v = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: encodePaymentHeader(lifted as typeof payload) });
    assert.equal(v.grantAccess, false, JSON.stringify(v));
    assert.equal(v.status, "rejected", JSON.stringify(v));
    assert.equal(v.problem, "unbound-payment");
    assert.equal(openNoteStore(payeeEnv).list().length, before, "nothing is swept or stored for it");
    // a made-up binding is refused the same way
    const forged = { ...lifted, payload: { ...lifted.payload, binding: "C".repeat(43) } };
    const f = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: encodePaymentHeader(forged as typeof payload) });
    assert.equal(f.grantAccess, false, JSON.stringify(f));
    assert.equal(f.problem, "unbound-payment");

    // The payer's own header, with its binding, settles.
    const ok = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: paid.paymentHeader });
    assert.equal(ok.status, "settled", JSON.stringify(ok));
    assert.equal(ok.grantAccess, true);

    // A seller that still takes older payers can let unbound payments through, and only those.
    const allowEnv = { ...payeeEnv, GLOAM_X402_ALLOW_UNBOUND: "1" };
    const A = await connect(makeDeps(chain, allowEnv).deps);
    const paid2 = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    assert.equal(paid2.status, "paid", JSON.stringify(paid2));
    const p2 = decodePaymentHeader(paid2.paymentHeader);
    const wrong = await A.call("gloam_verify_payment", { requirements: priced.encoded, payment: encodePaymentHeader({ ...p2, payload: { ...p2.payload, binding: "D".repeat(43) } }) });
    assert.equal(wrong.grantAccess, false, "a wrong binding is refused even then");
    const old = { ...p2, payload: { ...p2.payload } };
    delete (old.payload as { binding?: string }).binding;
    const legacy = await A.call("gloam_verify_payment", { requirements: priced.encoded, payment: encodePaymentHeader(old) });
    assert.equal(legacy.status, "settled", JSON.stringify(legacy));
  });

  test("a payment note claiming amount + p is refused, not settled", async () => {
    const dir = tmp();
    const chain = mockChain();
    const payerEnv = partyEnv("payer", dir, PAYER_LIMITS);
    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off" });
    const P = await connect(makeDeps(chain, payerEnv).deps);
    const S = await connect(makeDeps(chain, payeeEnv).deps);
    const cheap = await S.call("gloam_payment_requirements", {
      amount: 1, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "cheap", network: "tempo",
    });
    const dear = await S.call("gloam_payment_requirements", {
      amount: 5, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "dear", network: "tempo",
    });
    await P.call("gloam_execute_shield", { amount: 5, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: cheap.encoded });
    assert.equal(paid.status, "paid", JSON.stringify(paid));

    // The payer re-seals its real 1 PathUSD payment note as 1 + p: Poseidon reads the
    // amount mod p, so it opens the same commitment, which is this transfer's output.
    const payload = decodePaymentHeader(paid.paymentHeader);
    const tag = (await S.call("gloam_receive_tag")).tag;
    const real = await openGloamPaymentNote(payload.payload.paymentNote, openNoteStore(payeeEnv).receiveKey()!);
    const forged = encodeNotePackage({ pool: TEMPO.pool, asset: real.asset, amountWei: (BigInt(real.amountWei) + FIELD_PRIME).toString(), secret: real.secret, commitment: real.commitment });
    payload.payload.paymentNote = await sealToReceiveTag(forged, tag);
    const before = openNoteStore(payeeEnv).list().length;
    const v = await S.call("gloam_verify_payment", { requirements: dear.encoded, payment: encodePaymentHeader(payload) });
    assert.equal(v.grantAccess, false, JSON.stringify(v));
    assert.equal(v.status, "rejected", JSON.stringify(v));
    assert.equal(openNoteStore(payeeEnv).list().length, before, "nothing is swept or stored for it");

    // The honest note still settles the price it really paid.
    const ok = await S.call("gloam_verify_payment", { requirements: cheap.encoded, payment: paid.paymentHeader });
    assert.equal(ok.status, "settled", JSON.stringify(ok));
    assert.equal(ok.received.amount, "1");
  });

  /** A payer that pays through a relay whose answer is unclear, and a payee to pay. */
  async function relayPayment(relayOn: (chain: Chain) => ServerDeps["relay"], opts: { unreadableSpend?: boolean } = {}) {
    const dir = tmp();
    const chain = mockChain();
    const relay = relayOn(chain);
    const payerEnv = partyEnv("payer", dir, { ...PAYER_LIMITS, GLOAM_USE_RELAY: "1" });
    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off" });
    // Optionally, the payer's isSpent reads fail (an RPC error) until readable() is called.
    let unreadable = Boolean(opts.unreadableSpend);
    const publicClient = {
      ...chain.publicClient,
      readContract: async (a: { functionName: string; args: [Hex] }) => {
        if (unreadable && a.functionName === "isSpent") throw new Error("HTTP request failed.\n\nStatus: 503");
        return chain.publicClient.readContract(a);
      },
    };
    const signer = (net: unknown) =>
      ({ account: { address: "0x0000000000000000000000000000000000000abc" }, network: net, walletClient: chain.walletClient, publicClient }) as unknown as Signer;
    const P = await connect(makeDeps(chain, payerEnv, { relay, ...(opts.unreadableSpend ? { signer } : {}) }).deps);
    const S = await connect(makeDeps(chain, payeeEnv).deps);
    const priced = await S.call("gloam_payment_requirements", {
      amount: 3, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "r", network: "tempo",
    });
    const shield = await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    const byOrigin = (o: string) => openNoteStore(payerEnv).list().filter((n) => n.origin === o);
    return { chain, payerEnv, payeeEnv, P, S, priced, input: shield.note.handle as string, paid, byOrigin, readable: () => void (unreadable = false) };
  }

  test("a relay send with an unclear answer keeps the change and the payment, which land later", async () => {
    let held: readonly unknown[] | null = null;
    const r = await relayPayment(() => async (intent) => {
      held = intent.exec!.args; // the node took it; it is mined after the relay gave up
      throw new GloamRelayError("The relay may have sent this payment. Check before sending it again.", "maybe_sent");
    });
    assert.equal(r.paid.status, "error", JSON.stringify(r.paid));
    const [change] = r.byOrigin("change");
    const [payment] = r.byOrigin("payment");
    assert.equal(change?.status, "pending", "the change note is kept");
    assert.equal(openNoteStore(r.payerEnv).get(r.input)?.status, "pending", "the input stays reserved, not spendable again");
    assert.equal(payment?.status, "pending", "the payment note was saved before the send");
    assert.match(r.paid.check, /refresh/);
    assert.match(r.paid.paymentHeader, /^gloamx402pay1:/, "the sealed payment comes back, to present if it lands");

    await r.chain.apply("transfer", held!);
    const list = await r.P.call("gloam_list_notes", { refresh: true });
    assert.ok(list.refreshed.some((x: string) => x.includes(`${change!.handle}: confirmed`)), JSON.stringify(list.refreshed));
    assert.ok(list.refreshed.some((x: string) => x.includes(`${payment!.handle}: payment landed`)), JSON.stringify(list.refreshed));
    assert.equal(list.balances[0].spendable, "7", "the change is spendable; the payment is not counted as the payer's");
    assert.equal(openNoteStore(r.payerEnv).get(r.input)?.status, "spent");
    assert.equal(openNoteStore(r.payerEnv).get(payment!.handle)?.status, "spent", "a payment that landed is the payee's");

    const v = await r.S.call("gloam_verify_payment", { requirements: r.priced.encoded, payment: r.paid.paymentHeader });
    assert.equal(v.status, "settled", JSON.stringify(v));
    assert.equal(v.grantAccess, true);
  });

  test("a relay that returns a reverting resend after the first copy landed loses nothing", async () => {
    const r = await relayPayment((chain) => async (intent) => {
      await chain.apply("transfer", intent.exec!.args); // the first copy lands
      return chain.apply("transfer", intent.exec!.args); // the resend reverts: the nullifier is spent
    });
    assert.equal(r.paid.status, "error", JSON.stringify(r.paid));
    const [change] = r.byOrigin("change");
    const [payment] = r.byOrigin("payment");
    assert.equal(change?.status, "pending", "the change note is kept");
    assert.equal(payment?.status, "pending", "the payment note is kept");
    assert.match(r.paid.error, /earlier copy/);
    const list = await r.P.call("gloam_list_notes", { refresh: true });
    assert.ok(list.refreshed.some((x: string) => x.includes(`${change!.handle}: confirmed`)), JSON.stringify(list.refreshed));
    assert.equal(list.balances[0].spendable, "7");
    const v = await r.S.call("gloam_verify_payment", { requirements: r.priced.encoded, payment: r.paid.paymentHeader });
    assert.equal(v.status, "settled", JSON.stringify(v));
  });

  test("a relay refusal frees the note and keeps the outputs dead, since the relay has seen the proof", async () => {
    const r = await relayPayment(() => async () => {
      throw new GloamRelayError("The payment did not pass the relay's check.", "check_failed");
    });
    assert.equal(r.paid.status, "error", JSON.stringify(r.paid));
    assert.equal(r.paid.paymentHeader, undefined);
    const input = openNoteStore(r.payerEnv).get(r.input);
    assert.equal(input?.status, "unspent", "the note is spendable again");
    assert.equal(input?.recheck, true, "and checked on every refresh, in case the refused proof lands after all");
    assert.deepEqual(r.byOrigin("change").map((n) => n.status), ["dead"], "the change is kept, dead, secret and all");
    assert.deepEqual(r.byOrigin("payment").map((n) => n.status), ["dead"], "the payment is kept, dead");
  });

  /**
   * A wallet (no relay) whose RPC takes the transaction named `fn` and then loses the
   * reply: the signer noted the hash before the RPC answered, as getSigner's does.
   * `mine` false leaves it in the mempool, to be applied by the test later.
   */
  function lossyWallet(chain: Chain, fn: string, opts: { mine?: boolean; error?: () => Error } = {}) {
    const broadcasts: Hex[] = [];
    const held: (readonly unknown[])[] = [];
    let lost = 0;
    const walletClient = {
      ...chain.walletClient,
      writeContract: async (call: { functionName: string; args: readonly unknown[] }) => {
        if (call.functionName !== fn || lost > 0) {
          const hash = await chain.walletClient.writeContract(call);
          noteBroadcast(hash);
          broadcasts.push(hash);
          return hash;
        }
        lost++;
        const hash = opts.mine === false ? (`0x${"77".repeat(32)}` as Hex) : await chain.apply(fn, call.args);
        if (opts.mine === false) held.push(call.args);
        noteBroadcast(hash); // what the signer's transport does before the RPC answers
        broadcasts.push(hash);
        throw opts.error?.() ?? new Error("HTTP request failed.\n\nStatus: 504\nURL: https://rpc.example\nRequest body: {\"method\":\"eth_sendRawTransaction\"}");
      },
    };
    const signer = (net: unknown) =>
      ({ account: { address: "0x0000000000000000000000000000000000000abc" }, network: net, walletClient, publicClient: chain.publicClient }) as unknown as Signer;
    return { signer, broadcasts, held };
  }

  test("a wallet send whose reply is lost after the node took it keeps the change and the payment, and counts", async () => {
    const dir = tmp();
    const chain = mockChain();
    const payerEnv = partyEnv("payer", dir, PAYER_LIMITS);
    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off" });
    const lossy = lossyWallet(chain, "transfer");
    const P = await connect(makeDeps(chain, payerEnv, { signer: lossy.signer }).deps);
    const S = await connect(makeDeps(chain, payeeEnv).deps);
    const priced = await S.call("gloam_payment_requirements", { amount: 3, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "r", network: "tempo" });
    const shield = await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    assert.equal(paid.status, "error", JSON.stringify(paid));
    assert.equal(paid.hash, lossy.broadcasts.at(-1), "the result names the transaction that went out");
    assert.match(paid.check, /refresh/);
    assert.match(paid.paymentHeader, /^gloamx402pay1:/, "the sealed payment comes back, to present once it lands");
    const notes = openNoteStore(payerEnv).list();
    const change = notes.find((n) => n.origin === "change");
    const payment = notes.find((n) => n.origin === "payment");
    assert.equal(change?.status, "pending", "the 7 change is kept");
    assert.equal(change?.createdTx, paid.hash, "with the transaction a refresh looks up");
    assert.equal(payment?.status, "pending", "the payee's 3 is kept");
    assert.equal(openNoteStore(payerEnv).get(shield.note.handle)?.status, "pending", "the 10 note stays reserved");
    const report = await P.call("gloam_get_spending_report", {});
    assert.equal(report.recentPayments.find((e: { tool: string }) => e.tool === "pay")?.status, "unconfirmed", "it counts against the limits");

    const list = await P.call("gloam_list_notes", { refresh: true });
    assert.ok(list.refreshed.some((x: string) => x.includes(`${change!.handle}: confirmed`)), JSON.stringify(list.refreshed));
    assert.ok(list.refreshed.some((x: string) => x.includes(`${payment!.handle}: payment landed`)), JSON.stringify(list.refreshed));
    assert.equal(list.balances[0].spendable, "7");
    const v = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: paid.paymentHeader });
    assert.equal(v.status, "settled", JSON.stringify(v));
  });

  test("a wallet send the node refused outright frees the note and keeps the outputs dead", async () => {
    const dir = tmp();
    const chain = mockChain();
    const payerEnv = partyEnv("payer", dir, PAYER_LIMITS);
    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off" });
    const refused = () => Object.assign(new Error("insufficient funds for gas * price + value"), { code: -32000 });
    const lossy = lossyWallet(chain, "transfer", { mine: false, error: refused });
    // The node does not have it, a block later.
    let block = 100n;
    const publicClient = {
      ...chain.publicClient,
      getBlockNumber: async () => block++,
      getTransaction: async ({ hash }: { hash: Hex }) => {
        throw new TransactionNotFoundError({ hash });
      },
    };
    const signer = (net: Parameters<ServerDeps["signer"]>[0]) => ({ ...lossy.signer(net), publicClient }) as unknown as Signer;
    const P = await connect(makeDeps(chain, payerEnv, { signer }).deps);
    const S = await connect(makeDeps(chain, payeeEnv).deps);
    const priced = await S.call("gloam_payment_requirements", { amount: 3, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "r", network: "tempo" });
    const shield = await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    assert.equal(paid.status, "error", JSON.stringify(paid));
    assert.match(paid.error, /insufficient funds/);
    assert.equal(paid.paymentHeader, undefined);
    const notes = openNoteStore(payerEnv).list();
    assert.equal(notes.find((n) => n.handle === shield.note.handle)?.status, "unspent", "the note is spendable again");
    assert.equal(notes.find((n) => n.handle === shield.note.handle)?.recheck, true, "and checked on every refresh");
    // the node had the signed transaction, proof and all: its outputs are kept, dead
    assert.deepEqual(notes.filter((n) => n.origin === "change" || n.origin === "payment").map((n) => n.status), ["dead", "dead"]);
    const report = await P.call("gloam_get_spending_report", {});
    assert.equal(report.recentPayments.find((e: { tool: string }) => e.tool === "pay")?.status, "failed");
  });

  test("a wallet deposit whose reply is lost keeps its note, which confirms", async () => {
    const dir = tmp();
    const chain = mockChain();
    const payerEnv = partyEnv("payer", dir, PAYER_LIMITS);
    const lossy = lossyWallet(chain, "shieldBound");
    const P = await connect(makeDeps(chain, payerEnv, { signer: lossy.signer }).deps);
    const shield = await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    assert.equal(shield.status, "error", JSON.stringify(shield));
    assert.equal(shield.hash, lossy.broadcasts.at(-1));
    const [note] = openNoteStore(payerEnv).list();
    assert.equal(note?.status, "pending", "the deposit's note is kept");
    const report = await P.call("gloam_get_spending_report", {});
    assert.equal(report.recentPayments[0].status, "unconfirmed", "the deposit counts against the limits");
    const list = await P.call("gloam_list_notes", { refresh: true });
    assert.equal(list.balances[0].spendable, "10", JSON.stringify(list));
  });

  test("a wallet sweep whose reply is lost while it is in the mempool keeps the fresh note", async () => {
    const dir = tmp();
    const chain = mockChain();
    const payerEnv = partyEnv("payer", dir, PAYER_LIMITS);
    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off" });
    const lossy = lossyWallet(chain, "transfer", { mine: false });
    const P = await connect(makeDeps(chain, payerEnv).deps);
    const S = await connect(makeDeps(chain, payeeEnv, { signer: lossy.signer }).deps);
    const priced = await S.call("gloam_payment_requirements", { amount: 3, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "r", network: "tempo" });
    await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    assert.equal(paid.status, "paid", JSON.stringify(paid));
    const v = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: paid.paymentHeader });
    assert.equal(v.grantAccess, false);
    assert.equal(v.status, "unconfirmed", JSON.stringify(v));
    assert.equal(v.hash, lossy.broadcasts.at(-1));
    const [fresh] = openNoteStore(payeeEnv).list().filter((n) => n.origin === "received");
    assert.equal(fresh?.status, "pending", "the fresh note is kept");
    await chain.apply("transfer", lossy.held[0]!); // mined
    const list = await S.call("gloam_list_notes", { refresh: true });
    assert.ok(list.refreshed.some((x: string) => x.includes(`${fresh!.handle}: confirmed`)), JSON.stringify(list.refreshed));
    assert.equal(list.balances[0].spendable, "3", "the payee holds the payment");
  });

  test("a relay send whose receipt wait throws keeps the change and the payment, and counts", async () => {
    const dir = tmp();
    const chain = mockChain();
    const payerEnv = partyEnv("payer", dir, { ...PAYER_LIMITS, GLOAM_USE_RELAY: "1" });
    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off" });
    let failReceipts = false;
    const publicClient = {
      ...chain.publicClient,
      waitForTransactionReceipt: async (a: { hash: Hex }) => {
        if (failReceipts) throw new Error("HTTP request failed.\n\nStatus: 429");
        return chain.publicClient.waitForTransactionReceipt(a);
      },
    };
    const signer = (net: unknown) =>
      ({ account: { address: "0x0000000000000000000000000000000000000abc" }, network: net, walletClient: chain.walletClient, publicClient }) as unknown as Signer;
    const P = await connect(makeDeps(chain, payerEnv, { signer }).deps);
    const S = await connect(makeDeps(chain, payeeEnv).deps);
    const priced = await S.call("gloam_payment_requirements", { amount: 3, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "r", network: "tempo" });
    await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    failReceipts = true;
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    failReceipts = false;
    assert.equal(paid.status, "error", JSON.stringify(paid));
    assert.ok(paid.hash, "the relay's hash comes back");
    const notes = openNoteStore(payerEnv).list();
    assert.equal(notes.find((n) => n.origin === "change")?.status, "pending");
    assert.equal(notes.find((n) => n.origin === "payment")?.status, "pending");
    const report = await P.call("gloam_get_spending_report", {});
    assert.equal(report.recentPayments.find((e: { tool: string }) => e.tool === "pay")?.status, "unconfirmed");
    const list = await P.call("gloam_list_notes", { refresh: true });
    assert.equal(list.balances[0].spendable, "7", JSON.stringify(list));
    const v = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: paid.paymentHeader });
    assert.equal(v.status, "settled", JSON.stringify(v));
  });

  test("a reverted send whose spend check cannot be read keeps everything pending until a refresh", async () => {
    const r = await relayPayment((chain) => async (intent) => {
      await chain.apply("transfer", intent.exec!.args); // the first copy lands
      return chain.apply("transfer", intent.exec!.args); // the copy whose hash comes back reverts
    }, { unreadableSpend: true });
    assert.equal(r.paid.status, "error", JSON.stringify(r.paid));
    assert.match(r.paid.error, /could not be read/);
    assert.match(r.paid.paymentHeader, /^gloamx402pay1:/);
    const [change] = r.byOrigin("change");
    assert.equal(change?.status, "pending", "the change is not thrown away on a failed read");
    assert.equal(r.byOrigin("payment")[0]?.status, "pending");
    const report = await r.P.call("gloam_get_spending_report", {});
    assert.equal(report.recentPayments.find((e: { tool: string }) => e.tool === "pay")?.status, "unconfirmed", "it may have gone through: it counts");
    r.readable();
    const list = await r.P.call("gloam_list_notes", { refresh: true });
    assert.ok(list.refreshed.some((x: string) => x.includes(`${change!.handle}: confirmed`)), JSON.stringify(list.refreshed));
    assert.equal(list.balances[0].spendable, "7");
  });

  // ------------------------------------------------ wallet sends under review: hashes, refusals, stuck sweeps

  const realNow = Date.now;
  /** Run `fn` as if `ms` had passed (past the ten-minute release window, say). */
  async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    Date.now = () => realNow() + ms;
    try {
      return await fn();
    } finally {
      Date.now = realNow;
    }
  }
  const HOUR = 60 * 60 * 1000;

  /**
   * A chain whose node knows only the transactions in `known`: getTransaction and
   * getTransactionReceipt answer for those alone, like a real node with one it never
   * got. Blocks move on every read.
   */
  function nodeView(chain: Chain, known: Set<string>) {
    let block = 1000n;
    return {
      ...chain.publicClient,
      getBlockNumber: async () => block++,
      getTransaction: async ({ hash }: { hash: Hex }) => {
        if (known.has(hash.toLowerCase())) return { hash };
        throw new TransactionNotFoundError({ hash });
      },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        if (!known.has(hash.toLowerCase())) throw new Error(`Transaction receipt with hash "${hash}" could not be found.`);
        return chain.publicClient.getTransactionReceipt({ hash });
      },
    };
  }

  /** A payer whose wallet is `walletClient` over `publicClient`, and a payee pricing 3 PathUSD. */
  async function walletParties(chain: Chain, walletClient: unknown, publicClient: unknown, payeeSigner?: ServerDeps["signer"]) {
    const dir = tmp();
    const payerEnv = partyEnv("payer", dir, PAYER_LIMITS);
    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off" });
    const signer = (net: unknown) =>
      ({ account: { address: "0x0000000000000000000000000000000000000abc" }, network: net, walletClient, publicClient }) as unknown as Signer;
    const P = await connect(makeDeps(chain, payerEnv, { signer }).deps);
    const S = await connect(makeDeps(chain, payeeEnv, payeeSigner ? { signer: payeeSigner, publicClient: () => publicClient as Signer["publicClient"] } : {}).deps);
    const priced = await S.call("gloam_payment_requirements", { amount: 3, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "r", network: "tempo" });
    return { P, S, priced, payerEnv, payeeEnv };
  }

  /** A transfer that lands, its hash noted for the send it belongs to, and known to the node. */
  async function lands(chain: Chain, known: Set<string>, args: readonly unknown[]) {
    const h = await chain.apply("transfer", args);
    noteBroadcast(h);
    known.add(h.toLowerCase());
    return h;
  }

  test("two pays at once: one that fails before it is sent frees its note at once, and never takes the other's hash", async () => {
    const chain = mockChain();
    const known = new Set<string>();
    let releaseA!: () => void;
    const bSent = new Promise<void>((r) => (releaseA = r));
    let transfers = 0;
    const walletClient = {
      ...chain.walletClient,
      writeContract: async (call: { functionName: string; args: readonly unknown[] }) => {
        if (call.functionName !== "transfer") return chain.walletClient.writeContract(call);
        if (++transfers === 1) {
          await bSent; // A's gas estimate fails, after B broadcast
          throw new Error('HTTP request failed.\n\nStatus: 503\nRequest body: {"method":"eth_estimateGas"}');
        }
        const h = await lands(chain, known, call.args);
        releaseA();
        return h;
      },
    };
    const { P, priced, payerEnv } = await walletParties(chain, walletClient, nodeView(chain, known));
    const a = await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const b = await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const [pa, pb] = await Promise.all([
      P.call("gloam_execute_private_pay", { requirements: priced.encoded, note: a.note.handle }),
      P.call("gloam_execute_private_pay", { requirements: priced.encoded, note: b.note.handle }),
    ]);
    const [failed, paid] = pa.status === "error" ? [pa, pb] : [pb, pa];
    const failedNote = pa.status === "error" ? a : b;
    assert.equal(paid.status, "paid", JSON.stringify(paid));
    assert.equal(failed.status, "error");
    assert.equal(failed.hash, undefined, "nothing went out for it, so it names no transaction");
    assert.equal(openNoteStore(payerEnv).get(failedNote.note.handle)?.status, "unspent", "its note is spendable again right away");
    const report = await P.call("gloam_get_spending_report", {});
    assert.deepEqual(report.recentPayments.filter((e: { tool: string }) => e.tool === "pay").map((e: { status: string }) => e.status).sort(), ["failed", "sent"]);
  });

  test("two pays at once on one nonce: the one refused as a replacement keeps its own hash and its note comes back later", async () => {
    const chain = mockChain();
    const known = new Set<string>();
    let releaseA!: () => void;
    const bLanded = new Promise<void>((r) => (releaseA = r));
    let transfers = 0;
    const aHash = `0x${"aa".repeat(32)}` as Hex;
    const walletClient = {
      ...chain.walletClient,
      writeContract: async (call: { functionName: string; args: readonly unknown[] }) => {
        if (call.functionName !== "transfer") return chain.walletClient.writeContract(call);
        if (++transfers === 1) {
          noteBroadcast(aHash); // A goes out with the same nonce as B ...
          await bLanded;
          throw Object.assign(new Error("replacement transaction underpriced"), { code: -32000 }); // ... and B got there first
        }
        const h = await lands(chain, known, call.args);
        releaseA();
        return h;
      },
    };
    const { P, priced, payerEnv } = await walletParties(chain, walletClient, nodeView(chain, known));
    const a = await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const b = await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const [pa, pb] = await Promise.all([
      P.call("gloam_execute_private_pay", { requirements: priced.encoded, note: a.note.handle }),
      P.call("gloam_execute_private_pay", { requirements: priced.encoded, note: b.note.handle }),
    ]);
    const [lost, won] = pa.status === "error" ? [pa, pb] : [pb, pa];
    const lostNote = pa.status === "error" ? a : b;
    assert.equal(won.status, "paid");
    assert.equal(lost.hash, aHash, `its own transaction, not the other's (${won.hash})`);
    assert.equal(openNoteStore(payerEnv).get(lostNote.note.handle)?.spentTx, aHash);
    await later(HOUR, () => P.call("gloam_list_notes", { refresh: true }));
    assert.equal(openNoteStore(payerEnv).get(lostNote.note.handle)?.status, "unspent", "its transaction never showed up: spendable again");
  });

  test("a coded timeout (-32002) after the node took it is not taken as a refusal, even when the node read lags", async () => {
    const chain = mockChain();
    const known = new Set<string>(); // the node answering reads has not seen it yet
    let lost = 0;
    const walletClient = {
      ...chain.walletClient,
      writeContract: async (call: { functionName: string; args: readonly unknown[] }) => {
        if (call.functionName !== "transfer") return chain.walletClient.writeContract(call);
        const h = await chain.apply("transfer", call.args); // it lands
        noteBroadcast(h);
        if (lost++ === 0) throw Object.assign(new Error("request timed out"), { code: -32002 });
        return h;
      },
    };
    const { P, priced, payerEnv } = await walletParties(chain, walletClient, nodeView(chain, known));
    await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    assert.equal(paid.status, "error");
    assert.ok(paid.hash, JSON.stringify(paid));
    const notes = openNoteStore(payerEnv).list();
    assert.equal(notes.find((n) => n.origin === "change")?.status, "pending", "the change is kept");
    assert.equal(notes.find((n) => n.origin === "payment")?.status, "pending", "the payment is kept");
  });

  test("a note made spendable again whose old send lands later is marked spent, and never picked to pay", async () => {
    const chain = mockChain();
    const known = new Set<string>();
    const held: (readonly unknown[])[] = [];
    let n = 0;
    const walletClient = {
      ...chain.walletClient,
      writeContract: async (call: { functionName: string; args: readonly unknown[] }) => {
        if (call.functionName === "transfer" && ++n === 1) {
          noteBroadcast(`0x${"77".repeat(32)}`); // sent, the reply lost, not mined, unknown to the node read later
          held.push(call.args);
          throw new Error("HTTP request failed.\n\nStatus: 504");
        }
        if (call.functionName === "transfer") {
          // estimateGas reverts on a spent nullifier, before anything is sent
          const [, , nullifier] = call.args as [Hex, Hex, Hex];
          if (await chain.publicClient.readContract({ functionName: "isSpent", args: [nullifier] })) throw Object.assign(new Error("execution reverted"), { code: 3 });
          return lands(chain, known, call.args);
        }
        return chain.walletClient.writeContract(call);
      },
    };
    const { P, S, priced, payerEnv } = await walletParties(chain, walletClient, nodeView(chain, known));
    const s = await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const p1 = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    assert.equal(p1.status, "error");
    const freed = await later(11 * 60 * 1000, () => P.call("gloam_list_notes", { refresh: true }));
    assert.ok(freed.refreshed.some((x: string) => x.includes(`${s.note.handle}: spendable again`)), JSON.stringify(freed.refreshed));
    known.add((await chain.apply("transfer", held[0]!)).toLowerCase()); // the old send lands after all

    // Before any refresh: the same payment again finds the first one, which landed.
    const retry = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    assert.equal(retry.status, "paid", JSON.stringify(retry));
    assert.equal(retry.reused, true);

    // And another payment must not pick the dead note.
    const other = await S.call("gloam_payment_requirements", { amount: 4, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "another", network: "tempo" });
    const p2 = await P.call("gloam_execute_private_pay", { requirements: other.encoded });
    assert.equal(p2.status, "error", JSON.stringify(p2));
    assert.match(p2.error, /No single private note/, "the dead 10 is not picked (the 7 change is still confirming)");
    assert.equal(openNoteStore(payerEnv).get(s.note.handle)?.status, "spent", "and it is marked spent");

    const list = await P.call("gloam_list_notes", { refresh: true });
    assert.equal(list.balances[0].spendable, "7", `the change, and not the spent 10: ${JSON.stringify(list.balances)}`);

    // The same check runs on every refresh for a note freed this way.
    const chain2 = mockChain();
    const known2 = new Set<string>();
    const held2: (readonly unknown[])[] = [];
    let m = 0;
    const wallet2 = {
      ...chain2.walletClient,
      writeContract: async (call: { functionName: string; args: readonly unknown[] }) => {
        if (call.functionName === "transfer" && ++m === 1) {
          noteBroadcast(`0x${"78".repeat(32)}`);
          held2.push(call.args);
          throw new Error("HTTP request failed.\n\nStatus: 504");
        }
        return chain2.walletClient.writeContract(call);
      },
    };
    const w2 = await walletParties(chain2, wallet2, nodeView(chain2, known2));
    const s2 = await w2.P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    await w2.P.call("gloam_execute_private_pay", { requirements: w2.priced.encoded });
    await later(11 * 60 * 1000, () => w2.P.call("gloam_list_notes", { refresh: true }));
    await chain2.apply("transfer", held2[0]!);
    const l2 = await w2.P.call("gloam_list_notes", { refresh: true });
    assert.ok(l2.refreshed.some((x: string) => x.includes(`${s2.note.handle}: spent`)), JSON.stringify(l2.refreshed));
    assert.equal(l2.balances[0].spendable, "7");
  });

  test("a wallet sweep that never reached the node is swept again once its transaction is unknown, and serves once", async () => {
    const chain = mockChain();
    const known = new Set<string>();
    let first = true;
    const payeeWallet = {
      ...chain.walletClient,
      writeContract: async (call: { functionName: string; args: readonly unknown[] }) => {
        if (call.functionName === "transfer" && first) {
          first = false;
          noteBroadcast(`0x${"66".repeat(32)}`); // noted, then the connection fails before the node got it
          throw new Error("HTTP request failed.\n\nDetails: fetch failed");
        }
        return call.functionName === "transfer" ? lands(chain, known, call.args) : chain.walletClient.writeContract(call);
      },
    };
    const view = nodeView(chain, known);
    const payeeSigner = (net: unknown) =>
      ({ account: { address: "0x0000000000000000000000000000000000000abc" }, network: net, walletClient: payeeWallet, publicClient: view }) as unknown as Signer;
    const { P, S, priced, payeeEnv } = await walletParties(chain, chain.walletClient, chain.publicClient, payeeSigner);
    await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    const v1 = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: paid.paymentHeader });
    assert.equal(v1.status, "unconfirmed", JSON.stringify(v1));
    const v2 = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: paid.paymentHeader });
    assert.equal(v2.status, "unconfirmed", "inside the release window it waits for the first sweep");
    assert.equal(v2.grantAccess, false);
    const v3 = await later(HOUR, () => S.call("gloam_verify_payment", { requirements: priced.encoded, payment: paid.paymentHeader }));
    assert.equal(v3.status, "settled", `the first sweep never showed up and the payment is unspent: swept again (${JSON.stringify(v3)})`);
    assert.equal(v3.grantAccess, true);
    const v4 = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: paid.paymentHeader });
    assert.equal(v4.status, "already_settled", "served once");
    assert.equal(v4.grantAccess, false);
    const l = await later(HOUR, () => S.call("gloam_list_notes", { refresh: true }));
    assert.ok(l.refreshed.some((x: string) => x.includes("dead, its payment was taken by another transaction")), JSON.stringify(l.refreshed));
    assert.equal(l.balances[0].spendable, "3");
    const received = openNoteStore(payeeEnv).list().filter((n) => n.origin === "received");
    assert.deepEqual(received.map((n) => n.status).sort(), ["dead", "unspent"], "one note for the payment, and the first sweep's kept as dead");
  });

  test("a sweep that confirms after its verify said unconfirmed serves the payer on the next verify, once", async () => {
    const dir = tmp();
    const chain = mockChain();
    const payerEnv = partyEnv("payer", dir, PAYER_LIMITS);
    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off" });
    const lossy = lossyWallet(chain, "transfer", { mine: false });
    const P = await connect(makeDeps(chain, payerEnv).deps);
    const S = await connect(makeDeps(chain, payeeEnv, { signer: lossy.signer }).deps);
    const priced = await S.call("gloam_payment_requirements", { amount: 3, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "r", network: "tempo" });
    await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    const v1 = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: paid.paymentHeader });
    assert.equal(v1.status, "unconfirmed");
    await chain.apply("transfer", lossy.held[0]!); // mined
    const v2 = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: paid.paymentHeader });
    assert.equal(v2.status, "settled", JSON.stringify(v2));
    assert.equal(v2.grantAccess, true, "the payer is served");
    const v3 = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: paid.paymentHeader });
    assert.equal(v3.status, "already_settled");
    assert.equal(v3.grantAccess, false, "and only once");
    assert.equal(openNoteStore(payeeEnv).list().filter((n) => n.origin === "received" && n.status === "unspent").length, 1);
  });

  test("one payment presented many times at once, while its sweep is mined but its receipt unread, is served once", async () => {
    const chain = mockChain();
    let sweepHash: Hex | null = null;
    let mined!: () => void;
    const onChain = new Promise<void>((r) => (mined = r));
    let readReceipt!: () => void;
    const receiptHeld = new Promise<void>((r) => (readReceipt = r));
    const payeeWallet = {
      ...chain.walletClient,
      writeContract: async (call: { functionName: string; args: readonly unknown[] }) => {
        const h = await chain.walletClient.writeContract(call); // on chain at once
        noteBroadcast(h);
        if (call.functionName === "transfer" && !sweepHash) {
          sweepHash = h;
          mined();
        }
        return h;
      },
    };
    // viem polls for a receipt, so the sweep is on chain a while before the verify that sent it reads it. Reads take 30ms.
    const payeeView = {
      ...chain.publicClient,
      readContract: async (a: { functionName: string; args: [Hex] }) => {
        await new Promise((r) => setTimeout(r, 30));
        return chain.publicClient.readContract(a);
      },
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        if (hash === sweepHash) await receiptHeld;
        return chain.publicClient.waitForTransactionReceipt({ hash });
      },
    };
    const payeeSigner = (net: unknown) =>
      ({ account: { address: "0x0000000000000000000000000000000000000abc" }, network: net, walletClient: payeeWallet, publicClient: payeeView }) as unknown as Signer;
    const { P, S, priced, payeeEnv } = await walletParties(chain, chain.walletClient, chain.publicClient, payeeSigner);
    await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    const args = { requirements: priced.encoded, payment: paid.paymentHeader };
    const first = S.call("gloam_verify_payment", args);
    await onChain;
    const replays = await Promise.all([1, 2, 3, 4, 5].map(() => S.call("gloam_verify_payment", args)));
    readReceipt();
    const all = [await first, ...replays, await S.call("gloam_verify_payment", args)];
    const grants = all.filter((v) => v.grantAccess === true);
    assert.equal(grants.length, 1, `one payment, served once: ${JSON.stringify(all.map((v) => v.status))}`);
    assert.equal(grants[0].hash, sweepHash, "with the sweep's hash, whichever verify served it");
    // The others wait while it is being settled, then hear it was settled.
    assert.ok(all.filter((v) => v.grantAccess !== true).every((v) => v.status === "unconfirmed" || v.status === "already_settled"), JSON.stringify(all.map((v) => v.status)));
    assert.equal(all.at(-1).status, "already_settled");
    const received = openNoteStore(payeeEnv).list().filter((n) => n.origin === "received");
    assert.equal(received.length, 1);
    assert.equal(received[0]!.status, "unspent");
    assert.equal(received[0]!.served, true);
    assert.equal(received[0]!.createdTx, sweepHash);
  });

  test("the change and payment of a send that never reached the node are dead once its note is spendable again, and never count", async () => {
    const chain = mockChain();
    const known = new Set<string>();
    let n = 0;
    const walletClient = {
      ...chain.walletClient,
      writeContract: async (call: { functionName: string; args: readonly unknown[] }) => {
        if (call.functionName === "transfer" && ++n === 1) {
          noteBroadcast(`0x${"77".repeat(32)}`); // sent, the reply lost, and the node never got it
          throw new Error("HTTP request failed.\n\nStatus: 504");
        }
        return call.functionName === "transfer" ? lands(chain, known, call.args) : chain.walletClient.writeContract(call);
      },
    };
    const { P, priced, payerEnv } = await walletParties(chain, walletClient, nodeView(chain, known));
    const s = await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const p1 = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    assert.equal(p1.status, "error", JSON.stringify(p1));
    const outputs = () => openNoteStore(payerEnv).list().filter((x) => x.createdTx === p1.hash);
    assert.deepEqual(outputs().map((x) => x.status), ["pending", "pending"], "kept while the send may land");
    const freed = await later(11 * 60 * 1000, () => P.call("gloam_list_notes", { refresh: true }));
    assert.ok(freed.refreshed.some((x: string) => x.includes(`${s.note.handle}: spendable again`)), JSON.stringify(freed.refreshed));
    assert.deepEqual(
      freed.balances.map((b: { spendable: string; confirming: string }) => [b.spendable, b.confirming]),
      [["10", "0"]],
      "the 10 once, not the 10 and a confirming 7 from a send that can no longer land"
    );
    assert.deepEqual(outputs().map((x) => x.status), ["dead", "dead"], JSON.stringify(freed.refreshed));
    const p2 = await P.call("gloam_execute_private_pay", { requirements: priced.encoded, note: s.note.handle });
    assert.equal(p2.status, "paid", JSON.stringify(p2));
    const l = await later(30 * 24 * HOUR, () => P.call("gloam_list_notes", { refresh: true }));
    assert.deepEqual(l.balances.map((b: { spendable: string; confirming: string }) => [b.spendable, b.confirming]), [["7", "0"]], JSON.stringify(l.balances));
    assert.ok(outputs().every((x) => x.status === "dead" && x.secret), "kept with their secrets, never counted");
    const dead = new Set(outputs().map((x) => x.handle));
    assert.ok(!l.notes.some((x: { handle: string }) => dead.has(x.handle)), "and listed only when asked");
    const all = await P.call("gloam_list_notes", { includeSpent: true });
    assert.equal(all.notes.filter((x: { handle: string }) => dead.has(x.handle)).length, 2);
  });

  test("a stale read never deletes a received note: it is marked dead, comes back when it shows up, and serves once", async () => {
    const chain = mockChain();
    // From the sweep on, the reads come from a node behind the one that mined it (the spend read from one that is not).
    let lag = false;
    const payeeWallet = {
      ...chain.walletClient,
      writeContract: async (call: { functionName: string; args: readonly unknown[] }) => {
        if (call.functionName !== "transfer") return chain.walletClient.writeContract(call);
        const h = await chain.apply("transfer", call.args); // mined
        noteBroadcast(h);
        lag = true;
        throw new Error("HTTP request failed.\n\nStatus: 504"); // and the reply lost
      },
    };
    let block = 1000n;
    const view = {
      ...chain.publicClient,
      getBlockNumber: async () => block++,
      getTransaction: async ({ hash }: { hash: Hex }) => {
        if (lag) throw new TransactionNotFoundError({ hash });
        return { hash };
      },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        if (lag) throw new Error(`Transaction receipt with hash "${hash}" could not be found.`);
        return chain.publicClient.getTransactionReceipt({ hash });
      },
      readContract: async (a: { functionName: string; args: [Hex] }) => (lag && a.functionName === "commitmentSeen" ? false : chain.publicClient.readContract(a)),
    };
    const payeeSigner = (net: unknown) =>
      ({ account: { address: "0x0000000000000000000000000000000000000abc" }, network: net, walletClient: payeeWallet, publicClient: view }) as unknown as Signer;
    const { P, S, priced, payeeEnv } = await walletParties(chain, chain.walletClient, chain.publicClient, payeeSigner);
    await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    const args = { requirements: priced.encoded, payment: paid.paymentHeader };
    const v1 = await S.call("gloam_verify_payment", args);
    assert.equal(v1.status, "unconfirmed", JSON.stringify(v1));
    const [fresh] = openNoteStore(payeeEnv).list().filter((n) => n.origin === "received");
    const l1 = await later(HOUR, () => S.call("gloam_list_notes", { refresh: true }));
    assert.ok(l1.refreshed.some((x: string) => x.includes(`${fresh!.handle}: dead`)), JSON.stringify(l1.refreshed));
    const kept = openNoteStore(payeeEnv).get(fresh!.handle);
    assert.equal(kept?.status, "dead", "the note is kept, not deleted");
    assert.equal(kept?.secret, fresh!.secret, "with its secret");
    assert.equal((await later(HOUR, () => S.call("gloam_verify_payment", args))).grantAccess, false, "not served on those reads");

    lag = false; // the node catches up
    const l2 = await later(HOUR + 2 * 60 * 1000, () => S.call("gloam_list_notes", { refresh: true })); // a dead note is looked at again after a minute
    assert.ok(l2.refreshed.some((x: string) => x.includes(`${fresh!.handle}: confirmed`)), JSON.stringify(l2.refreshed));
    assert.equal(l2.balances[0].spendable, "3", "the payee holds the payment");
    const v2 = await S.call("gloam_verify_payment", args);
    assert.equal(v2.status, "settled", JSON.stringify(v2));
    assert.equal(v2.grantAccess, true);
    const v3 = await S.call("gloam_verify_payment", args);
    assert.equal(v3.status, "already_settled");
  });

  test("a payee sweep whose relay answer is unclear keeps the fresh note, which lands later", async () => {
    const dir = tmp();
    const chain = mockChain();
    const payerEnv = partyEnv("payer", dir, PAYER_LIMITS);
    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off", GLOAM_USE_RELAY: "1" });
    let held: readonly unknown[] | null = null;
    const P = await connect(makeDeps(chain, payerEnv).deps);
    const S = await connect(
      makeDeps(chain, payeeEnv, {
        relay: async (intent) => {
          held = intent.exec!.args;
          throw new TypeError("fetch failed");
        },
      }).deps
    );
    const priced = await S.call("gloam_payment_requirements", {
      amount: 2, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "r", network: "tempo",
    });
    await P.call("gloam_execute_shield", { amount: 5, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    assert.equal(paid.status, "paid", JSON.stringify(paid));
    const v = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: paid.paymentHeader });
    assert.equal(v.grantAccess, false);
    assert.equal(v.status, "unconfirmed", JSON.stringify(v));
    const [fresh] = openNoteStore(payeeEnv).list().filter((n) => n.origin === "received");
    assert.equal(fresh?.status, "pending", "the fresh note is kept");
    await chain.apply("transfer", held!);
    const list = await S.call("gloam_list_notes", { refresh: true });
    assert.ok(list.refreshed.some((x: string) => x.includes(`${fresh!.handle}: confirmed`)), JSON.stringify(list.refreshed));
    assert.equal(list.balances[0].spendable, "2", "the payee holds the payment");
  });

  // ------------------------------------------------ one payment presented many times: what it costs

  /** A payee wallet whose sweeps take 20ms to go out, over reads that take 40ms; with collide, a sweep sent while another is out is refused as a replacement. */
  function slowPayee(chain: Chain, opts: { collide?: boolean } = {}) {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const count = { sweeps: 0, refused: 0, reverted: 0 };
    let out = 0;
    const walletClient = {
      ...chain.walletClient,
      writeContract: async (call: { functionName: string; args: readonly unknown[] }) => {
        if (call.functionName !== "transfer") return chain.walletClient.writeContract(call);
        count.sweeps++;
        if (opts.collide && out > 0) {
          count.refused++;
          noteBroadcast(`0x${(0xdead0000 + count.refused).toString(16).padStart(64, "0")}` as Hex);
          throw Object.assign(new Error("replacement transaction underpriced"), { code: -32000 });
        }
        out++;
        await wait(20);
        const h = await chain.apply("transfer", call.args);
        noteBroadcast(h);
        if ((await chain.publicClient.getTransactionReceipt({ hash: h })).status === "reverted") count.reverted++;
        out--;
        return h;
      },
    };
    const publicClient = {
      ...chain.publicClient,
      readContract: async (a: { functionName: string; args: [Hex] }) => {
        await wait(40);
        return chain.publicClient.readContract(a);
      },
      waitForTransactionReceipt: async (a: { hash: Hex }) => {
        await wait(40);
        return chain.publicClient.waitForTransactionReceipt(a);
      },
    };
    const signer = (net: unknown) =>
      ({ account: { address: "0x0000000000000000000000000000000000000abc" }, network: net, walletClient, publicClient }) as unknown as Signer;
    return { count, signer: signer as ServerDeps["signer"], publicClient, wait };
  }

  test("ten verifies of one payment at once send one sweep: none reverted, no dead notes left", async () => {
    for (const collide of [false, true]) {
      const chain = mockChain();
      const payee = slowPayee(chain, { collide });
      const { P, S, priced, payeeEnv } = await walletParties(chain, chain.walletClient, chain.publicClient, payee.signer);
      await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
      const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
      const args = { requirements: priced.encoded, payment: paid.paymentHeader };
      const out = await Promise.all(Array.from({ length: 10 }, (_, i) => payee.wait(i * 5).then(() => S.call("gloam_verify_payment", args))));
      await later(11 * 60 * 1000, () => S.call("gloam_list_notes", { refresh: true }));
      const report = { collide, statuses: out.map((v) => v.status), ...payee.count };
      assert.equal(out.filter((v) => v.grantAccess === true).length, 1, JSON.stringify(report));
      assert.equal(payee.count.sweeps, 1, `one sweep sent: ${JSON.stringify(report)}`);
      assert.deepEqual(openNoteStore(payeeEnv).list().filter((n) => n.origin === "received").map((n) => n.status), ["unspent"], JSON.stringify(report));
      assert.ok(out.every((v) => ["settled", "unconfirmed", "already_settled"].includes(v.status)), JSON.stringify(report));
    }
  });

  test("a store that cannot be written while a payment settles holds it back only until it can", async () => {
    const chain = mockChain();
    let dir = "";
    let armed = true;
    const view = {
      ...chain.publicClient,
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const r = await chain.publicClient.waitForTransactionReceipt({ hash });
        if (armed && chain.calls.filter((c) => c === "transfer").length === 2) {
          armed = false;
          chmodSync(dir, 0o500); // the sweep landed; the claim's lock and every write after it fail
        }
        return r;
      },
    };
    const payeeSigner = (net: unknown) =>
      ({ account: { address: "0x0000000000000000000000000000000000000abc" }, network: net, walletClient: chain.walletClient, publicClient: view }) as unknown as Signer;
    const { P, S, priced, payeeEnv } = await walletParties(chain, chain.walletClient, chain.publicClient, payeeSigner);
    dir = dirname(payeeEnv.GLOAM_NOTE_STORE!);
    await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    const args = { requirements: priced.encoded, payment: paid.paymentHeader };
    const v1 = await S.call("gloam_verify_payment", args);
    chmodSync(dir, 0o700);
    const [v2, v3] = await Promise.all([S.call("gloam_verify_payment", args), S.call("gloam_verify_payment", args)]);
    const v4 = await S.call("gloam_verify_payment", args);
    const all = [v1, v2, v3, v4];
    assert.equal(v1.grantAccess, false, JSON.stringify(v1));
    assert.equal(all.filter((v) => v.grantAccess === true).length, 1, `served once the store can be written: ${JSON.stringify(all.map((v) => v.status))}`);
    assert.equal(v4.status, "already_settled");
  });

  test("two servers on one note store (two processes) sweep a payment presented to both at once only once", async () => {
    const chain = mockChain();
    const payee = slowPayee(chain);
    const { P, S, priced, payeeEnv } = await walletParties(chain, chain.walletClient, chain.publicClient, payee.signer);
    const S2 = await connect(makeDeps(chain, payeeEnv, { signer: payee.signer, publicClient: () => payee.publicClient as unknown as Signer["publicClient"] }).deps);
    await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    const args = { requirements: priced.encoded, payment: paid.paymentHeader };
    const out = await Promise.all(Array.from({ length: 6 }, (_, i) => payee.wait(i * 5).then(() => (i % 2 ? S2 : S).call("gloam_verify_payment", args))));
    assert.equal(out.filter((v) => v.grantAccess === true).length, 1, JSON.stringify(out.map((v) => v.status)));
    assert.equal(payee.count.sweeps, 1, `one sweep sent: ${JSON.stringify({ statuses: out.map((v) => v.status), ...payee.count })}`);
  });

  test("a payment whose sweeps never land is swept again three times, then only after a wait that doubles", async () => {
    const chain = mockChain();
    const known = new Set<string>();
    let sweeps = 0;
    const payeeWallet = {
      ...chain.walletClient,
      writeContract: async (call: { functionName: string; args: readonly unknown[] }) => {
        if (call.functionName !== "transfer") return chain.walletClient.writeContract(call);
        sweeps++;
        noteBroadcast(`0x${(0x5eed0000 + sweeps).toString(16).padStart(64, "0")}` as Hex); // the connection fails before the node gets it
        throw new Error("HTTP request failed.\n\nDetails: fetch failed");
      },
    };
    const view = nodeView(chain, known);
    const payeeSigner = (net: unknown) =>
      ({ account: { address: "0x0000000000000000000000000000000000000abc" }, network: net, walletClient: payeeWallet, publicClient: view }) as unknown as Signer;
    const { P, S, priced } = await walletParties(chain, chain.walletClient, chain.publicClient, payeeSigner);
    await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    const args = { requirements: priced.encoded, payment: paid.paymentHeader };
    const MIN = 60 * 1000;
    const answers = [];
    for (let k = 0; k <= 6; k++) answers.push(await later(k * 11 * MIN, () => S.call("gloam_verify_payment", args)));
    assert.equal(sweeps, 4, `the first sweep and three more, ten minutes apart: ${JSON.stringify(answers.map((v) => v.status))}`);
    assert.ok(answers.every((v) => v.grantAccess === false));
    assert.match(answers.at(-1).message, /swept 4 times/, JSON.stringify(answers.at(-1)));
    await later(94 * MIN, () => S.call("gloam_verify_payment", args)); // an hour after the fourth
    assert.equal(sweeps, 5, "then one more an hour later");
    await later(155 * MIN, () => S.call("gloam_verify_payment", args));
    assert.equal(sweeps, 5, "and the next waits two hours");
    await later(215 * MIN, () => S.call("gloam_verify_payment", args));
    assert.equal(sweeps, 6);
  });

  test("sweeps that revert are sent again ten minutes apart, and once the cause is fixed the payment is served", async () => {
    const chain = mockChain();
    let broken = true;
    let sweeps = 0;
    const payeeWallet = {
      ...chain.walletClient,
      writeContract: async (call: { functionName: string; args: readonly unknown[] }) => {
        if (call.functionName !== "transfer") return chain.walletClient.writeContract(call);
        sweeps++;
        const args = [...call.args];
        if (broken) args[1] = `0x${"ee".repeat(32)}`; // say a misconfigured RPC or prover: the sweep reverts
        const h = await chain.apply("transfer", args);
        noteBroadcast(h);
        return h;
      },
    };
    const payeeSigner = (net: unknown) =>
      ({ account: { address: "0x0000000000000000000000000000000000000abc" }, network: net, walletClient: payeeWallet, publicClient: chain.publicClient }) as unknown as Signer;
    const { P, S, priced } = await walletParties(chain, chain.walletClient, chain.publicClient, payeeSigner);
    await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    const args = { requirements: priced.encoded, payment: paid.paymentHeader };
    const MIN = 60 * 1000;
    const now = [];
    for (let i = 0; i < 5; i++) now.push((await S.call("gloam_verify_payment", args)).status);
    assert.equal(sweeps, 1, `one sweep, not one per verify: ${JSON.stringify(now)}`);
    for (const t of [11, 22, 33, 44]) await later(t * MIN, () => S.call("gloam_verify_payment", args));
    assert.equal(sweeps, 4, "three more, ten minutes apart, then a wait");
    broken = false; // the operator fixes it
    const waiting = await later(50 * MIN, () => S.call("gloam_verify_payment", args));
    assert.equal(waiting.grantAccess, false);
    const served = await later(94 * MIN, () => S.call("gloam_verify_payment", args));
    assert.equal(served.status, "settled", JSON.stringify(served));
    assert.equal(served.grantAccess, true, "the payment is still swept and served once the cause is fixed");
    assert.equal((await later(30 * 24 * 60 * MIN, () => S.call("gloam_verify_payment", args))).status, "already_settled");
  });

  test("dead notes are checked again less and less often, at least once a week, and all at once when something new is seen", async () => {
    const chain = mockChain();
    const known = new Set<string>();
    let n = 0;
    let held: readonly unknown[] = [];
    const walletClient = {
      ...chain.walletClient,
      writeContract: async (call: { functionName: string; args: readonly unknown[] }) => {
        if (call.functionName === "transfer" && ++n === 1) {
          noteBroadcast(`0x${"77".repeat(32)}`); // the node does not get it (yet)
          held = call.args;
          throw new Error("HTTP request failed.\n\nStatus: 504");
        }
        return call.functionName === "transfer" ? lands(chain, known, call.args) : chain.walletClient.writeContract(call);
      },
    };
    const view = nodeView(chain, known);
    const reads = new Map<string, number>();
    const counted = {
      ...view,
      readContract: async (a: { functionName: string; args: [Hex] }) => {
        if (a.functionName === "commitmentSeen") reads.set(a.args[0].toLowerCase(), (reads.get(a.args[0].toLowerCase()) ?? 0) + 1);
        return view.readContract(a);
      },
    };
    const { P, priced, payerEnv } = await walletParties(chain, walletClient, counted);
    await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const p1 = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    const MIN = 60 * 1000;
    const t0 = 11 * MIN;
    await later(t0, () => P.call("gloam_list_notes", { refresh: true }));
    const dead = openNoteStore(payerEnv).list().filter((x) => x.createdTx === p1.hash);
    assert.deepEqual(dead.map((x) => x.status), ["dead", "dead"]);
    const readsOf = () => dead.reduce((s, x) => s + (reads.get(x.commitment.toLowerCase()) ?? 0), 0);
    const base = readsOf();
    for (let i = 0; i < 5; i++) await later(t0 + 10_000, () => P.call("gloam_list_notes", { refresh: true }));
    assert.equal(readsOf(), base, "not re-read on every refresh");
    await later(t0 + 2 * MIN, () => P.call("gloam_list_notes", { refresh: true }));
    assert.equal(readsOf(), base + 2, "read again once the wait is up");
    await later(t0 + 3 * MIN, () => P.call("gloam_list_notes", { refresh: true }));
    assert.equal(readsOf(), base + 2, "and the wait doubles");
    const DAY = 24 * 60 * MIN;
    await later(t0 + 8 * DAY, () => P.call("gloam_list_notes", { refresh: true }));
    assert.equal(readsOf(), base + 4, "a week on, it is still looked at");
    await later(t0 + 9 * DAY, () => P.call("gloam_list_notes", { refresh: true }));
    assert.equal(readsOf(), base + 4, "but the gap is a week at most, not every refresh");
    await later(t0 + 15 * DAY + MIN, () => P.call("gloam_list_notes", { refresh: true }));
    assert.equal(readsOf(), base + 6, "and again a week later");
    const after7d = readsOf();

    // Something new: the old send lands after all. The refresh that sees its note spent looks at every dead note.
    await chain.apply("transfer", held);
    const woke = await later(t0 + 16 * DAY, () => P.call("gloam_list_notes", { refresh: true }));
    assert.ok(readsOf() > after7d, JSON.stringify(woke.refreshed));
    assert.deepEqual(
      dead.map((x) => openNoteStore(payerEnv).get(x.handle)?.status).sort(),
      ["spent", "unspent"],
      `the change and the payment came back: ${JSON.stringify(woke.refreshed)}`
    );
    assert.equal(woke.balances[0].spendable, "7");
  });

  // ------------------------------------------------ a relay resend that reverted while its first copy landed

  /**
   * A payer (or payee) behind the relay, whose relay sends the first copy (it lands) and hands back the
   * hash of a resend, which reverts. While `lag` is on, the reads come from a node behind the one that
   * mined the first copy: commitments read unseen, and with lagSpend the spend reads unspent too.
   */
  function relayResend(chain: Chain, opts: { lagSpend?: boolean } = {}) {
    const state = { lag: true };
    const relay: ServerDeps["relay"] = async (intent) => {
      await chain.apply("transfer", intent.exec!.args); // the first copy lands
      return chain.apply("transfer", intent.exec!.args); // the resend reverts, and its hash comes back
    };
    const view = {
      ...chain.publicClient,
      readContract: async (a: { functionName: string; args: [Hex] }) =>
        state.lag && (a.functionName === "commitmentSeen" || (opts.lagSpend && a.functionName === "isSpent")) ? false : chain.publicClient.readContract(a),
    };
    const signer = (net: unknown) =>
      ({ account: { address: "0x0000000000000000000000000000000000000abc" }, network: net, walletClient: chain.walletClient, publicClient: view }) as unknown as Signer;
    return { state, relay, view, signer: signer as ServerDeps["signer"] };
  }

  test("a note whose transaction reads reverted is marked dead, not deleted: a relay's first copy may have landed", async () => {
    const chain = mockChain();
    const dir = tmp();
    const payerEnv = partyEnv("payer", dir, { ...PAYER_LIMITS, GLOAM_USE_RELAY: "1" });
    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off" });
    const r = relayResend(chain);
    r.state.lag = false; // the pay itself reads the spend right
    const P = await connect(makeDeps(chain, payerEnv, { relay: r.relay, signer: r.signer, publicClient: () => r.view as unknown as Signer["publicClient"] }).deps);
    const S = await connect(makeDeps(chain, payeeEnv).deps);
    const priced = await S.call("gloam_payment_requirements", { amount: 3, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "r", network: "tempo" });
    await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    assert.match(paid.error, /earlier copy/, JSON.stringify(paid));
    const [change] = openNoteStore(payerEnv).list().filter((n) => n.origin === "change");
    r.state.lag = true; // a refresh answered by a node behind: the change reads unseen, its resend reverted
    const l1 = await P.call("gloam_list_notes", { refresh: true });
    const kept = openNoteStore(payerEnv).get(change!.handle);
    assert.equal(kept?.status, "dead", `kept, with its secret (${JSON.stringify(l1.refreshed)})`);
    assert.equal(kept?.secret, change!.secret);
    r.state.lag = false;
    const l2 = await later(2 * 60 * 1000, () => P.call("gloam_list_notes", { refresh: true })); // a dead note is looked at again after a minute
    assert.ok(l2.refreshed.some((x: string) => x.includes(`${change!.handle}: confirmed`)), JSON.stringify(l2.refreshed));
    assert.equal(l2.balances[0].spendable, "7");
  });

  test("a dead note whose commitment is in the pool comes back however long after the stale read", async () => {
    for (const days of [3, 8, 40]) {
      const chain = mockChain();
      const env = partyEnv("payer", tmp(), PAYER_LIMITS);
      let lag = true;
      const view = {
        ...chain.publicClient,
        readContract: async (a: { functionName: string; args: [Hex] }) => (lag && a.functionName === "commitmentSeen" ? false : chain.publicClient.readContract(a)),
      };
      const signer = (net: unknown) =>
        ({ account: { address: "0x0000000000000000000000000000000000000abc" }, network: net, walletClient: chain.walletClient, publicClient: view }) as unknown as Signer;
      const P = await connect(makeDeps(chain, env, { signer: signer as ServerDeps["signer"], publicClient: () => view as unknown as Signer["publicClient"] }).deps);
      // A change note from a relay send: its first copy landed (the commitment is in the pool), the relay answered with a resend that reverted.
      const c = `0x${"0c".repeat(32)}` as Hex;
      await chain.apply("shieldBound", [null, null, c]);
      const n = openNoteStore(env).add(sampleNote({ commitment: c, status: "pending", pending: "create", origin: "change", createdTx: `0x${"ab".repeat(32)}` as Hex }));
      const first = await P.call("gloam_list_notes", { refresh: true });
      assert.ok(first.refreshed.some((x: string) => x.includes(`${n.handle}: dead`)), JSON.stringify(first.refreshed));
      lag = false;
      const back = await later(days * 24 * 60 * 60 * 1000, () => P.call("gloam_list_notes", { refresh: true }));
      assert.equal(openNoteStore(env).get(n.handle)?.status, "unspent", `${days} days on: ${JSON.stringify(back.refreshed)}`);
    }
  });

  test("a refresh that sees a reserved note's spend land looks at the dead notes at once", async () => {
    const chain = mockChain();
    const dir = tmp();
    const payerEnv = partyEnv("payer", dir, { ...PAYER_LIMITS, GLOAM_USE_RELAY: "1" });
    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off" });
    const r = relayResend(chain);
    r.state.lag = false;
    let spendUnreadable = false;
    const view = {
      ...r.view,
      readContract: async (a: { functionName: string; args: [Hex] }) => {
        if (spendUnreadable && a.functionName === "isSpent") throw new Error("HTTP request failed.\n\nStatus: 503");
        return r.view.readContract(a);
      },
    };
    const signer = (net: unknown) =>
      ({ account: { address: "0x0000000000000000000000000000000000000abc" }, network: net, walletClient: chain.walletClient, publicClient: view }) as unknown as Signer;
    const P = await connect(makeDeps(chain, payerEnv, { relay: r.relay, signer: signer as ServerDeps["signer"], publicClient: () => view as unknown as Signer["publicClient"] }).deps);
    const S = await connect(makeDeps(chain, payeeEnv).deps);
    const priced = await S.call("gloam_payment_requirements", { amount: 3, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "r", network: "tempo" });
    const shield = await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    spendUnreadable = true; // after the returned resend reverts, the spend cannot be read: everything stays pending
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    assert.match(paid.error, /could not be read/, JSON.stringify(paid));
    r.state.lag = true; // and a refresh on a node behind reads the change unseen and its transaction reverted
    await P.call("gloam_list_notes", { refresh: true });
    const [change] = openNoteStore(payerEnv).list().filter((n) => n.origin === "change");
    assert.equal(change?.status, "dead");
    assert.equal(openNoteStore(payerEnv).get(shield.note.handle)?.status, "pending", "the note stays reserved");
    spendUnreadable = false;
    r.state.lag = false;
    const l = await P.call("gloam_list_notes", { refresh: true });
    assert.ok(l.refreshed.some((x: string) => x.includes(`${shield.note.handle}: spent`)), JSON.stringify(l.refreshed));
    assert.ok(l.refreshed.some((x: string) => x.includes(`${change!.handle}: confirmed`)), `in the same refresh: ${JSON.stringify(l.refreshed)}`);
    assert.equal(l.balances[0].spendable, "7");
  });

  test("a pay whose returned resend reverted, on a lagging spend read, keeps its change and payment as dead and rechecks the note", async () => {
    const chain = mockChain();
    const dir = tmp();
    const payerEnv = partyEnv("payer", dir, { ...PAYER_LIMITS, GLOAM_USE_RELAY: "1" });
    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off" });
    const r = relayResend(chain, { lagSpend: true });
    r.state.lag = false;
    const P = await connect(makeDeps(chain, payerEnv, { relay: r.relay, signer: r.signer, publicClient: () => r.view as unknown as Signer["publicClient"] }).deps);
    const S = await connect(makeDeps(chain, payeeEnv).deps);
    const priced = await S.call("gloam_payment_requirements", { amount: 3, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "r", network: "tempo" });
    const shield = await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    r.state.lag = true; // the spend after the revert reads unspent from a node behind
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    assert.equal(paid.status, "error", JSON.stringify(paid));
    const outs = openNoteStore(payerEnv).list().filter((n) => n.origin === "change" || n.origin === "payment");
    assert.deepEqual(outs.map((n) => n.status), ["dead", "dead"], "kept with their secrets, in case the first copy landed");
    assert.equal(openNoteStore(payerEnv).get(shield.note.handle)?.recheck, true, "the note is spendable again, and checked on every refresh");
    r.state.lag = false;
    const l = await P.call("gloam_list_notes", { refresh: true });
    assert.ok(l.refreshed.some((x: string) => x.includes(`${shield.note.handle}: spent`)), JSON.stringify(l.refreshed));
    assert.ok(l.refreshed.some((x: string) => x.includes(": confirmed")), JSON.stringify(l.refreshed));
    assert.equal(l.balances[0].spendable, "7", "the change, which landed with the first copy");
  });

  test("a sweep whose returned resend reverted, on a lagging read, keeps the fresh note and serves it once", async () => {
    const chain = mockChain();
    const dir = tmp();
    const payerEnv = partyEnv("payer", dir, PAYER_LIMITS);
    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off", GLOAM_USE_RELAY: "1" });
    const r = relayResend(chain);
    const P = await connect(makeDeps(chain, payerEnv).deps);
    const S = await connect(makeDeps(chain, payeeEnv, { relay: r.relay, signer: r.signer, publicClient: () => r.view as unknown as Signer["publicClient"] }).deps);
    const priced = await S.call("gloam_payment_requirements", { amount: 3, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "r", network: "tempo" });
    await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    r.state.lag = false;
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    r.state.lag = true; // the payee's reads lag: the fresh note reads unseen after the returned resend reverted
    const args = { requirements: priced.encoded, payment: paid.paymentHeader };
    const v1 = await S.call("gloam_verify_payment", args);
    assert.equal(v1.grantAccess, false, JSON.stringify(v1));
    const [fresh] = openNoteStore(payeeEnv).list().filter((n) => n.origin === "received");
    assert.equal(fresh?.status, "dead", "the fresh note is kept, with its secret");
    r.state.lag = false;
    const v2 = await S.call("gloam_verify_payment", args);
    assert.equal(v2.status, "settled", JSON.stringify(v2));
    assert.equal(v2.grantAccess, true);
    assert.equal((await S.call("gloam_verify_payment", args)).status, "already_settled");
    assert.equal(openNoteStore(payeeEnv).list().filter((n) => n.origin === "received" && n.status === "unspent").length, 1);
  });

  test("limits still gate before any proving or signing, and refusals leave notes untouched", async () => {
    const dir = tmp();
    const chain = mockChain();
    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off" });
    const S = await connect(makeDeps(chain, payeeEnv).deps);
    const priced = await S.call("gloam_payment_requirements", {
      amount: 6, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "r", network: "tempo",
    });

    // No limits at all: the shield is refused and no note is minted.
    const unlimitedEnv = partyEnv("payer", dir);
    const u = makeDeps(chain, unlimitedEnv);
    const U = await connect(u.deps);
    const refusedShield = await U.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    assert.equal(refusedShield.status, "refused");
    assert.equal(refusedShield.code, "limits_unset");
    assert.equal(u.proofs.count, 0, "nothing proved");
    assert.deepEqual(chain.calls, [], "nothing signed");
    assert.equal(openNoteStore(unlimitedEnv).list().length, 0, "no note minted");

    // With limits: a payment over the per-payment cap is refused before proving.
    const payerEnv = partyEnv("payer2", dir, PAYER_LIMITS);
    const p = makeDeps(chain, payerEnv);
    const P = await connect(p.deps);
    const shield = await P.call("gloam_execute_shield", { amount: 10, network: "tempo" });
    assert.equal(shield.status, "confirmed");
    // The owner tightens the cap; the env is read on every call, so it applies at once.
    payerEnv.GLOAM_LIMIT_MAX_PER_PAYMENT = "5";
    const proofsBefore = p.proofs.count;
    const over = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    assert.equal(over.status, "refused");
    assert.equal(over.code, "over_per_payment");
    assert.equal(p.proofs.count, proofsBefore, "refused before proving");
    assert.equal(openNoteStore(payerEnv).get(shield.note.handle)?.status, "unspent", "the note is not reserved by a refusal");

    // A payTo that is not a receive tag is refused before the gate and the prover.
    const req = decodeRequirements(priced.encoded);
    const untagged = { ...req, payTo: "gloam:rcpt:someone", maxAmountRequired: "1000000", privacy: GLOAM_VS_ZONE };
    const bad = await P.call("gloam_execute_private_pay", { requirements: JSON.stringify(untagged) });
    assert.equal(bad.status, "refused");
    assert.equal(bad.code, "payto_not_receive_tag");
    assert.match(bad.message, /receive tag/);
    assert.equal(p.proofs.count, proofsBefore);

    // Asking the payee side for requirements with a non-tag payTo is an error too.
    const badReq = await S.call("gloam_payment_requirements", { amount: 1, payTo: "gloam:rcpt:x", resource: "r" });
    assert.equal(badReq.status, "error");
    assert.match(badReq.error, /must be a Gloam receive tag/);
  });

  test("a payee that cannot sweep says the payment is not final; with the relay it settles", async () => {
    const dir = tmp();
    const chain = mockChain();
    const payerEnv = partyEnv("payer", dir, PAYER_LIMITS);
    const P = await connect(makeDeps(chain, payerEnv).deps);
    // A payee with no signer: its store key comes from GLOAM_NOTE_KEY.
    const payeeEnv: Env = { GLOAM_AGENT_ID: "shop", GLOAM_NOTE_KEY: KEY_B, GLOAM_NOTE_STORE: join(dir, "shop.json") };
    const S = await connect(makeDeps(chain, payeeEnv).deps);
    const priced = await S.call("gloam_payment_requirements", {
      amount: 2, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "r", network: "tempo",
    });
    await P.call("gloam_execute_shield", { amount: 5, network: "tempo" });
    const paid = await P.call("gloam_execute_private_pay", { requirements: priced.encoded });
    assert.equal(paid.status, "paid", JSON.stringify(paid));

    const v = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: paid.paymentHeader });
    assert.equal(v.status, "verified_not_final");
    assert.equal(v.grantAccess, false);
    assert.equal(v.final, false);
    assert.match(v.finality, /spend the money back/);

    const R = await connect(makeDeps(chain, { ...payeeEnv, GLOAM_USE_RELAY: "1" }).deps);
    const settled = await R.call("gloam_verify_payment", { requirements: priced.encoded, payment: paid.paymentHeader });
    assert.equal(settled.status, "settled", JSON.stringify(settled));
    assert.equal(settled.sweptBy, "gloam-relay");
    assert.equal(settled.grantAccess, true);

    // A requirements object pointing at some other pool is not settled at all.
    const req = decodeRequirements(priced.encoded);
    const fake = encodeRequirements({ ...req, poolAddress: "0x000000000000000000000000000000000000dEaD" });
    const wrongPool = await R.call("gloam_verify_payment", { requirements: fake, payment: paid.paymentHeader });
    assert.equal(wrongPool.status, "rejected");
    assert.equal(wrongPool.grantAccess, false);

    assertNoSecrets(secretsOf([payerEnv, payeeEnv]));
  });

  test("gloam_fetch_paid: the whole 402 round trip stays inside the server", async () => {
    const dir = tmp();
    const chain = mockChain();
    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off" });
    const S = await connect(makeDeps(chain, payeeEnv).deps);
    const priced = await S.call("gloam_payment_requirements", {
      amount: 1, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "https://api.example/answer", network: "tempo",
    });
    // A resource server that prices in x402 and serves only after its own Gloam MCP says grantAccess.
    const requests: (string | null)[] = [];
    const resourceServer = (async (_url: string, init?: RequestInit) => {
      const xPayment = new Headers(init?.headers).get("x-payment");
      requests.push(xPayment);
      if (!xPayment) {
        return new Response(JSON.stringify({ x402Version: 1, error: "payment required", accepts: [{ scheme: "exact" }, priced.requirements] }), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      }
      const v = await S.call("gloam_verify_payment", { requirements: priced.encoded, payment: xPayment });
      return v.grantAccess
        ? new Response("the answer is 42", { status: 200, headers: { "x-payment-response": "settled" } })
        : new Response(JSON.stringify(v), { status: 402 });
    }) as typeof fetch;

    const payerEnv = partyEnv("payer", dir, PAYER_LIMITS);
    const P = await connect(makeDeps(chain, payerEnv, { fetch: resourceServer }).deps);
    await P.call("gloam_execute_shield", { amount: 5, network: "tempo" });

    const tooMuch = await P.call("gloam_fetch_paid", { url: "https://api.example/answer", maxAmount: 0.5 });
    assert.equal(tooMuch.status, "refused");
    assert.equal(tooMuch.code, "over_max_amount");

    const r = await P.call("gloam_fetch_paid", { url: "https://api.example/answer" });
    assert.equal(r.status, "ok", JSON.stringify(r));
    assert.equal(r.httpStatus, 200);
    assert.equal(r.body, "the answer is 42");
    assert.equal(r.paid.amount, "1");
    assert.equal(r.paymentResponse, "settled");
    assert.equal(r.paymentHeader, undefined, "a served request does not hand the header to the agent");
    assert.equal(requests.at(-1)?.startsWith("gloamx402pay1:"), true, "the retry carried the payment");

    const free = await P.call("gloam_fetch_paid", { url: "https://api.example/answer", paymentHeader: requests.at(-1)! });
    assert.equal(free.status, "payment_not_accepted", "a spent header is not accepted twice");

    assertNoSecrets(secretsOf([payerEnv, payeeEnv]));
  });

  test("gloam_fetch_paid: maxAmount counts in the asset's real decimals, and is refused for an asset whose decimals nobody has told it", async () => {
    const dir = tmp();
    const chain = mockChain();
    // A 6-decimal token Gloam does not list, priced at 5 tokens.
    const TOKEN = "0x2222222222222222222222222222222222222222";
    const S = await connect(makeDeps(chain, partyEnv("payee", dir, { GLOAM_LIMITS: "off" })).deps);
    const priced = await S.call("gloam_payment_requirements", {
      amount: 5, decimals: 6, assetSymbol: "TKN", asset: TOKEN, resource: "https://api.example/answer", network: "tempo",
    });
    const resourceServer = (async () =>
      new Response(JSON.stringify({ x402Version: 1, accepts: [priced.requirements] }), {
        status: 402,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    // The owner's limits file gives the token its decimals: 5 is more than a maxAmount of 1.
    const limits = join(dir, "limits.json");
    const agents = { payer: { recipients: "any", tools: ["pay"], assets: { [TOKEN]: { decimals: 6, network: "tempo", maxPerPayment: "10", maxPerDay: "50" } } } };
    writeFileSync(limits, JSON.stringify({ agents }));
    const listed = await connect(makeDeps(chain, partyEnv("payer", dir, { GLOAM_LIMITS_FILE: limits }), { fetch: resourceServer }).deps);
    const over = await listed.call("gloam_fetch_paid", { url: "https://api.example/answer", maxAmount: 1 });
    assert.equal(over.status, "refused", JSON.stringify(over));
    assert.equal(over.code, "over_max_amount");
    assert.match(over.message, /asks 5 /);

    // With no limits to give the decimals, they would have been guessed as 18 and the cap passed: now it refuses.
    const unknown = await connect(makeDeps(chain, partyEnv("payer", dir, { GLOAM_LIMITS: "off" }), { fetch: resourceServer }).deps);
    const guess = await unknown.call("gloam_fetch_paid", { url: "https://api.example/answer", maxAmount: 1 });
    assert.equal(guess.status, "refused", JSON.stringify(guess));
    assert.equal(guess.code, "unknown_decimals");
    assert.deepEqual(chain.calls, [], "nothing was signed or paid");
  });

  test("GLOAM_EXPOSE_NOTE_SECRETS=1 brings back secrets, and only then", async () => {
    const dir = tmp();
    const chain = mockChain();

    const safeEnv = partyEnv("payer", dir, PAYER_LIMITS);
    const safe = await connect(makeDeps(chain, safeEnv).deps);
    const tools = await safe.client.listTools();
    const pay = tools.tools.find((t) => t.name === "gloam_execute_private_pay")!;
    assert.ok(!("noteSecret" in (pay.inputSchema.properties ?? {})), "no secret argument by default");
    assert.ok("note" in (pay.inputSchema.properties ?? {}), "pay takes a note handle");
    for (const t of ["gloam_list_notes", "gloam_receive_tag", "gloam_fetch_paid"]) assert.ok(tools.tools.some((x) => x.name === t), `${t} is offered`);

    const legacyEnv = partyEnv("old", dir, { ...PAYER_LIMITS, GLOAM_EXPOSE_NOTE_SECRETS: "1" });
    const old = await connect(makeDeps(chain, legacyEnv).deps);
    const oldTools = await old.client.listTools();
    const oldPay = oldTools.tools.find((t) => t.name === "gloam_execute_private_pay")!;
    assert.ok("noteSecret" in (oldPay.inputSchema.properties ?? {}), "legacy mode accepts a secret");
    const shield = await old.call("gloam_execute_shield", { amount: 4, network: "tempo" });
    assert.equal(shield.status, "confirmed");
    assert.equal(shield.note.secret, openNoteStore(legacyEnv).get(shield.note.handle)?.secret, "legacy mode returns the secret");
    assert.match(shield.warning, /unsafe|spend that money/i);

    const payeeEnv = partyEnv("payee", dir, { GLOAM_LIMITS: "off" });
    const S = await connect(makeDeps(chain, payeeEnv).deps);
    const priced = await S.call("gloam_payment_requirements", {
      amount: 1, decimals: 6, assetSymbol: "PathUSD", asset: TEMPO_PATHUSD, resource: "r", network: "tempo",
    });
    const paid = await old.call("gloam_execute_private_pay", { requirements: priced.encoded, noteSecret: shield.note.secret, noteAmount: 4 });
    assert.equal(paid.status, "paid", JSON.stringify(paid));
    assert.ok(paid.paymentNote.secret && paid.persistChangeNote.secret, "legacy mode returns payment and change secrets");
    assert.equal(paid.sealedToPayee, true, "the header is still sealed to a receive tag");
    // The scan used above is not vacuous: legacy mode leaks on purpose, and it is caught.
    assert.throws(() => assertNoSecrets(secretsOf([legacyEnv])), /leaked a secret/);
  });

  test("the pool tree is kept per chain and pool: one leaf-list load, then only new blocks; an RPC error is an error", async () => {
    const pool = "0x39e28cde55cab798874746ac52cb4b5cc99a0194" as Address;
    const abi = parseAbi(["event Shielded(bytes32 indexed commitment, address indexed asset, uint256 amount, uint256 leafIndex, address indexed from)"]);
    const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
    /** A Robinhood Chain RPC (raw logs, address-only reads) whose pool root follows its logs. */
    const chain = (chainId: number) => {
      const logs: { blockNumber: bigint; c: Hex }[] = [];
      const state = { head: 1_000n, reads: [] as [bigint, bigint][], fail: null as Error | null };
      const rootAt = async (block: bigint) => {
        const tree = new IncrementalMerkleTreePoseidon();
        await tree.init();
        for (const l of logs.filter((x) => x.blockNumber <= block).sort((x, y) => (x.blockNumber < y.blockNumber ? -1 : 1))) await tree.insert(hexToField(l.c));
        return fieldToHex(tree.currentRoot);
      };
      const client = {
        chain: { id: chainId },
        getBlockNumber: async () => state.head,
        getLogs: async ({ address, fromBlock, toBlock, ...rest }: { address: Address; fromBlock: bigint; toBlock: bigint }) => {
          assert.equal(Object.keys(rest).length, 0, "read by address only");
          if (state.fail) throw state.fail;
          state.reads.push([fromBlock, toBlock]);
          return logs
            .filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && address.toLowerCase() === pool)
            .map((l) => ({
              address: pool,
              topics: encodeEventTopics({ abi, eventName: "Shielded", args: { commitment: l.c, asset: TEMPO_PATHUSD, from: TEMPO_PATHUSD } }),
              data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1n, 0n]),
              blockNumber: l.blockNumber,
              logIndex: 0,
              transactionHash: word(l.blockNumber),
              removed: false,
            }));
        },
        readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
          if (functionName === "currentRoot") return rootAt(blockNumber ?? state.head);
          throw new Error(`unexpected ${functionName}`);
        },
      };
      return { client: client as never, logs, state };
    };

    const rh = chain(4663);
    const c1 = word(11n);
    rh.logs.push({ blockNumber: 500n, c: c1 });
    const seeded: string[] = [];
    const trees = keptPoolTrees({
      seed: (network) => async () => {
        seeded.push(network);
        return { v: 1, pool, deployBlock: "100", toBlock: "900", leafCount: 1, items: [{ k: "s", c: [c1], bn: "500", li: 0 }] };
      },
    });
    const net = { key: "robinhood-mainnet", chainId: 4663, pool, deployBlock: 100n };

    const p1 = await (await trees(rh.client, poolTreeParams(net))).pathForCommitment(c1);
    assert.equal(p1?.leafIndex, 0, "the path, from the leaf list");
    assert.deepEqual(seeded, ["robinhood-mainnet"], "a cold start loads the leaf list for the network");
    assert.deepEqual(rh.state.reads, [[885n, 1_000n]], "and reads only the blocks after it (less 16 re-read)");

    // The next spend, through a new client for the same network: the same tree, only the new blocks.
    rh.state.head = 1_200n;
    const c2 = word(22n);
    rh.logs.push({ blockNumber: 1_150n, c: c2 });
    rh.state.reads = [];
    const p2 = await (await trees(chain(4663).client, poolTreeParams(net))).pathForCommitment(c2);
    assert.equal(p2?.leafIndex, 1, "the new leaf's path");
    assert.deepEqual(rh.state.reads, [[985n, 1_200n]], "one read of the blocks since the last spend, on the first client");
    assert.equal(seeded.length, 1, "no second leaf-list load");

    // The same pool address on another chain is another tree.
    const tempo = chain(4217);
    tempo.logs.push({ blockNumber: 950n, c: word(33n) });
    const other = await (await trees(tempo.client, poolTreeParams({ ...net, key: "tempo-mainnet", chainId: 4217 }))).pathForCommitment(word(33n));
    assert.equal(other?.leafIndex, 0, "its own tree");
    assert.deepEqual(seeded, ["robinhood-mainnet", "tempo-mainnet"], "with its own leaf list");
    assert.ok(tempo.state.reads.some(([from]) => from === 100n), "which does not match this pool's root here, so the chain is walked from the deploy block");

    // An RPC that fails is an error, never "not in the tree yet".
    rh.state.head = 1_300n;
    rh.state.fail = Object.assign(new Error("RPC error"), { code: -32601, details: "the method eth_getLogs does not exist/is not available" });
    await assert.rejects((await trees(rh.client, poolTreeParams(net))).pathForCommitment(c2), /chain 4663: eth_getLogs .* failed/);
    rh.state.fail = null;
    assert.equal((await (await trees(rh.client, poolTreeParams(net))).pathForCommitment(c2))?.leafIndex, 1, "and the next try goes through");
  });
}
