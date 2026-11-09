/**
 * Self-test: securing a claimed payment (lib/claimSweep) and its bookkeeping.
 *
 * Runs the app's own code (note store, sweep, reconcile) against an in-memory
 * pool that follows ShieldPoolPoseidon.transfer's rules (known root, nullifier
 * spent once, both outputs inserted); proofs are not checked here, the SDK's
 * sweep self-test proves one for real. Covers: a clean secure, the payer
 * spending it back first, a closed wallet prompt and a retry, a relay that
 * sent the move but lost its reply, a receipt that timed out, a payment not in
 * the vault yet (kept, listed apart, never counted until it lands: review
 * finding 6, 23 Oct 2026), the wrong network, and a backup restored before or
 * after securing, here or in a browser without those notes (user report, 24 Oct
 * 2026). Throughout, the balance must never count the money twice or lose it.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-claim-sweep.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mjs";
import type { Address, Hex } from "viem";
import {
  IncrementalMerkleTreePoseidon,
  fieldToHex,
  hexToField,
  noteCommitmentPoseidon,
  noteNullifierPoseidon,
  randomSecretField,
  type PoseidonMerklePath,
} from "@gloamtrade/sdk";

const { getActiveNetwork } = await import("../src/lib/networks");
const { getAllNotes, setAllNotes } = await import("../src/lib/noteVault");
const {
  activeSpendableNotes,
  exportNotesBackup,
  importNotesBackup,
  loadLocalNotes,
  markNoteRecovered,
  saveLocalNote,
  sumByAsset,
  unfundedClaims,
} = await import("../src/lib/shield");
const { backupSpentCheck, claimFunded, claimNoteId, isUnsecuredClaim, reconcileClaims, reconcileUnfunded, secureClaim } =
  await import("../src/lib/claimSweep");
type LocalNote = import("../src/lib/shield").LocalNote;
type ClaimEnv = import("../src/lib/claimSweep").ClaimEnv;

/** The block the mock pool's pinned reads report. */
const BLOCK = BigInt(1);

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const net = getActiveNetwork();
const POOL = net.pool as Address;
const ASSET = "0x00000000000000000000000000000000000000ee" as Address;
const ME = "0x1111111111111111111111111111111111111111" as Address;
const lc = (h: string) => h.toLowerCase();

/** The vault, following transfer's rules. `hold` queues a transfer instead of applying it. */
function mockPool() {
  const tree = new IncrementalMerkleTreePoseidon();
  const index = new Map<string, number>();
  const roots = new Set<string>();
  const spent = new Set<string>();
  const receipts = new Map<string, "success" | "reverted">();
  let n = 0;
  async function insert(c: Hex) {
    index.set(lc(c), await tree.insert(hexToField(c)));
    roots.add(lc(fieldToHex(tree.currentRoot)));
  }
  async function apply(args: readonly [Hex, Hex, Hex, readonly [Hex, Hex]]) {
    const [, root, nullifier, outs] = args;
    const ok = roots.has(lc(root)) && !spent.has(lc(nullifier)) && outs.every((c) => !index.has(lc(c)));
    if (ok) {
      spent.add(lc(nullifier));
      for (const c of outs) await insert(c);
    }
    return ok;
  }
  return {
    insert,
    spent,
    index,
    async transfer(args: readonly [Hex, Hex, Hex, readonly [Hex, Hex]]): Promise<Hex> {
      const hash = `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
      receipts.set(hash, (await apply(args)) ? "success" : "reverted");
      return hash;
    },
    apply,
    env(over: Partial<ClaimEnv> = {}): ClaimEnv {
      return {
        chainId: net.chainId,
        pool: POOL,
        chain: {
          isSpent: async (nf) => spent.has(lc(nf)),
          isCommitmentSeen: async (c) => index.has(lc(c)),
          pathForCommitment: async (c) => {
            const i = index.get(lc(c));
            return i == null ? null : ((await tree.path(i)) as PoseidonMerklePath);
          },
          waitForReceipt: async (h) => ({ status: receipts.get(h) ?? "reverted" }),
        },
        prove: async () => ({ proofBytes: "0xdeadbeef" }),
        relay: (t) => this.transfer([t.proof, t.root, t.nullifier, t.commitments]),
        leafIndexOf: async (c) => index.get(lc(c)),
        // both reads at one "block", as the app does
        stateAt: async (nf, c) => ({ spent: nf ? spent.has(lc(nf)) : null, seen: index.has(lc(c)), block: BLOCK }),
        ...over,
      };
    },
  };
}

/** A payment someone made to us: in the pool, and claimed into this browser. */
async function claimed(pool: ReturnType<typeof mockPool>, amount: bigint, opts: { inPool?: boolean; unfunded?: boolean } = {}) {
  const secret = await randomSecretField();
  const commitment = fieldToHex(await noteCommitmentPoseidon(secret, amount, ASSET));
  const nullifier = fieldToHex(await noteNullifierPoseidon(secret, hexToField(commitment)));
  if (opts.inPool !== false) await pool.insert(commitment);
  const note: LocalNote = {
    id: claimNoteId(),
    chainId: net.chainId,
    pool: POOL,
    asset: ASSET,
    amountWei: amount.toString(),
    commitment,
    secret: fieldToHex(secret),
    nullifier,
    bound: true,
    scheme: "poseidon",
    from: ME,
    createdAt: Date.now(),
    status: "open",
    source: "local",
    note: "Invoice 042",
    ...(opts.unfunded !== undefined ? { unfunded: opts.unfunded } : {}),
  };
  saveLocalNote(note);
  await new Promise((r) => setTimeout(r, 2)); // distinct ids
  return note;
}

/** What the balance counts for notes tied to this claim (the claim and its fresh notes). */
function counted(claim: LocalNote): LocalNote[] {
  return activeSpendableNotes(getAllNotes()).filter(
    (n) => n.id === claim.id || n.sweptFrom?.id === claim.id
  );
}
function byId(id: string) {
  return getAllNotes().find((n) => n.id === id)!;
}
function freshOf(claim: LocalNote) {
  return getAllNotes().filter((n) => n.sweptFrom?.id === claim.id);
}
const total = (ns: LocalNote[]) => ns.reduce((s, n) => s + BigInt(n.amountWei), 0n);
/** A note as a restore wrote it: under a new id of its own, found by its commitment. */
function restored(n: LocalNote): LocalNote {
  return getAllNotes().find((m) => m.commitment.toLowerCase() === n.commitment.toLowerCase() && m.secret !== "0x")!;
}
/** What the balance counts of these notes, found by commitment. */
function countedOf(...ns: LocalNote[]): LocalNote[] {
  const cs = new Set(ns.map((n) => n.commitment.toLowerCase()));
  return activeSpendableNotes(getAllNotes()).filter((m) => cs.has(m.commitment.toLowerCase()));
}

const noWallet = async (): Promise<Hex> => {
  throw new Error("wallet should not be used");
};

/** One sync, in the order hooks/useLocalShieldNotes runs it, with the spent check on the mock vault. */
async function syncAsTheAppDoes(pool: ReturnType<typeof mockPool>, env: ClaimEnv) {
  await reconcileUnfunded(env);
  await reconcileClaims(env);
  for (const n of loadLocalNotes(ME)) {
    if (n.nullifier && n.nullifier !== "0x" && n.status !== "recovered" && n.secret !== "0x" && pool.spent.has(lc(n.nullifier))) {
      markNoteRecovered(n.id);
    }
  }
}

await test("secure through the relay: the money moves to a fresh note only we know", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 25_000_000n);
  assert.equal(isUnsecuredClaim(claim), true);
  const stages: string[] = [];
  const r = await secureClaim(
    { note: claim, relay: true, sendWithWallet: noWallet, onStage: (s) => stages.push(s) },
    pool.env()
  );
  assert.equal(r.status, "swept");
  assert.equal(r.final, true);
  assert.equal(pool.spent.has(lc(claim.nullifier!)), true, "the claimed note is spent by the move");
  const [fresh] = freshOf(claim);
  assert.ok(fresh, "fresh note saved");
  assert.equal(fresh.sweepPending, false);
  assert.equal(fresh.amountWei, claim.amountWei);
  assert.notEqual(lc(fresh.secret), lc(claim.secret), "a new secret the payer never saw");
  assert.equal(fresh.leafIndex, pool.index.get(lc(fresh.commitment)));
  assert.equal(fresh.note, "Invoice 042", "the payer's note stays with the money");
  assert.equal(byId(claim.id).status, "recovered");
  assert.equal(byId(claim.id).secured, true);
  assert.equal(isUnsecuredClaim(byId(claim.id)), false);
  assert.deepEqual(counted(claim).map((n) => n.id), [fresh.id]);
  assert.equal(total(counted(claim)), 25_000_000n);
  assert.ok(stages.some((s) => /relay/.test(s)));
});

await test("payer spends it back first: the claim is dropped, nothing counted", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 7_000_000n);
  // The payer knows the secret and moves it before we secure.
  pool.spent.add(lc(claim.nullifier!));
  const r = await secureClaim({ note: claim, relay: true, sendWithWallet: noWallet }, pool.env());
  assert.equal(r.status, "already_spent");
  assert.equal(r.final, false);
  assert.equal(byId(claim.id).status, "recovered");
  assert.equal(byId(claim.id).secured, undefined);
  assert.equal(freshOf(claim).length, 0, "nothing proved or saved for a spent note");
  assert.equal(total(counted(claim)), 0n);
});

await test("wallet prompt closed, then a retry through the relay", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 3_000_000n);
  const r1 = await secureClaim(
    {
      note: claim,
      relay: false,
      sendWithWallet: async () => {
        throw new Error("User rejected the request.");
      },
    },
    pool.env()
  );
  assert.equal(r1.status, "failed");
  assert.match(r1.reason ?? "", /rejected/);
  assert.equal(isUnsecuredClaim(byId(claim.id)), true, "still the claimed note, still flagged");
  assert.equal(freshOf(claim).length, 1);
  assert.equal(freshOf(claim)[0]!.sweepPending, true, "kept, but not counted");
  assert.equal(total(counted(claim)), 3_000_000n, "counted once, as the claimed note");

  const r2 = await secureClaim({ note: byId(claim.id), relay: true, sendWithWallet: noWallet }, pool.env());
  assert.equal(r2.status, "swept");
  assert.equal(total(counted(claim)), 3_000_000n, "counted once, as the fresh note");
  // The first attempt's note can never land now: reconcile retires it.
  assert.equal(await reconcileClaims(pool.env()), true);
  const fresh = freshOf(claim);
  assert.equal(fresh.filter((n) => n.status !== "recovered").length, 1);
  assert.equal(fresh.filter((n) => n.sweepPending).length, 0);
  assert.equal(total(counted(claim)), 3_000_000n);
  assert.equal(await reconcileClaims(pool.env()), false, "nothing left to settle");
});

await test("relay sent the move but lost its reply: it lands later and counts", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 9_000_000n);
  let held: readonly [Hex, Hex, Hex, readonly [Hex, Hex]] | null = null;
  const r = await secureClaim(
    { note: claim, relay: true, sendWithWallet: noWallet },
    pool.env({
      relay: async (t) => {
        held = [t.proof, t.root, t.nullifier, t.commitments];
        throw new Error("Could not reach the relay. Check your connection.");
      },
    })
  );
  // Nothing has landed yet, so the sweep reports it as not gone through...
  assert.equal(r.status, "failed");
  // ...but the fresh note is kept: the relay may still have sent it.
  const [pending] = freshOf(claim);
  assert.equal(pending!.sweepPending, true);
  assert.equal(total(counted(claim)), 9_000_000n, "still counted once, as the claimed note");

  assert.equal(await reconcileClaims(pool.env()), false, "not landed yet: stays pending");
  assert.ok(held);
  assert.equal(await pool.apply(held!), true, "the relay's transaction lands");

  assert.equal(await reconcileClaims(pool.env()), true);
  const fresh = byId(pending!.id);
  assert.equal(fresh.sweepPending, false);
  assert.equal(fresh.status, "open");
  assert.equal(fresh.leafIndex, pool.index.get(lc(fresh.commitment)));
  assert.equal(byId(claim.id).secured, true);
  assert.equal(byId(claim.id).status, "recovered");
  assert.deepEqual(counted(claim).map((n) => n.id), [fresh.id]);
  assert.equal(total(counted(claim)), 9_000_000n);
});

await test("retry after a lost reply that landed meanwhile: secured, no second move", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 6_000_000n);
  // First try: the relay sends it, the reply is lost, and it lands later.
  const r1 = await secureClaim(
    { note: claim, relay: true, sendWithWallet: noWallet },
    pool.env({
      relay: async (t) => {
        await pool.apply([t.proof, t.root, t.nullifier, t.commitments]);
        throw new Error("Could not reach the relay. Check your connection.");
      },
      chain: {
        ...pool.env().chain,
        // The chain has not shown it yet when the sweep looks.
        isCommitmentSeen: async () => false,
        isSpent: async () => false,
      },
    })
  );
  assert.equal(r1.status, "failed");
  assert.equal(isUnsecuredClaim(byId(claim.id)), true);
  // The person presses Secure again.
  let sent = 0;
  const r2 = await secureClaim(
    { note: byId(claim.id), relay: true, sendWithWallet: noWallet },
    pool.env({
      relay: async (t) => {
        sent++;
        return pool.transfer([t.proof, t.root, t.nullifier, t.commitments]);
      },
    })
  );
  assert.equal(r2.status, "swept", "reported as secured, not as taken back");
  assert.equal(sent, 0, "no second move sent");
  assert.equal(byId(claim.id).secured, true);
  assert.equal(total(counted(claim)), 6_000_000n);
});

await test("receipt timed out: pending until the chain shows it", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 4_000_000n);
  let held: readonly [Hex, Hex, Hex, readonly [Hex, Hex]] | null = null;
  const base = pool.env();
  const r = await secureClaim(
    { note: claim, relay: true, sendWithWallet: noWallet },
    {
      ...base,
      relay: async (t) => {
        held = [t.proof, t.root, t.nullifier, t.commitments];
        return `0x${"ab".repeat(32)}` as Hex;
      },
      chain: {
        ...base.chain,
        waitForReceipt: async () => {
          throw new Error("Timed out while waiting for transaction");
        },
      },
    }
  );
  assert.equal(r.status, "unconfirmed");
  assert.equal(freshOf(claim)[0]!.sweepPending, true);
  assert.equal(total(counted(claim)), 4_000_000n);
  await pool.apply(held!);
  assert.equal(await reconcileClaims(pool.env()), true);
  assert.equal(byId(claim.id).secured, true);
  assert.equal(total(counted(claim)), 4_000_000n);
});

await test("payment not in the vault yet: nothing sent, still flagged, and out of the balance", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 1_000_000n, { inPool: false });
  const r = await secureClaim({ note: claim, relay: true, sendWithWallet: noWallet }, pool.env());
  assert.equal(r.status, "not_settled");
  assert.equal(freshOf(claim).length, 0);
  assert.equal(isUnsecuredClaim(byId(claim.id)), true);
  assert.equal(byId(claim.id).unfunded, true);
  assert.equal(total(counted(claim)), 0n, "never counted before the vault shows it");
});

// Review finding 6, 23 Oct 2026: a claim code nobody paid must not show as money.
await test("an unpaid claim is kept, listed apart and never counted, until the vault shows it", async () => {
  const pool = mockPool();
  const env = pool.env();
  // a code that opens fine (secret, amount, asset agree) but was never paid into the vault
  const secret = await randomSecretField();
  const commitment = fieldToHex(await noteCommitmentPoseidon(secret, 40_000_000n, ASSET));
  assert.equal(await claimFunded(commitment, env), false, "the claim flow sees it is not in the vault");
  assert.equal(await claimFunded(commitment, pool.env({ chain: { ...env.chain, isCommitmentSeen: async () => { throw new Error("rpc down"); } } })), false, "an unread vault counts as not yet");
  const claim = await claimed(pool, 40_000_000n, { inPool: false, unfunded: true });
  const before = sumByAsset(getAllNotes()).get(lc(ASSET)) ?? 0n;
  assert.equal(total(counted(claim)), 0n);
  assert.ok(unfundedClaims(getAllNotes()).some((n) => n.id === claim.id), "listed as waiting");
  assert.equal(await reconcileUnfunded(env), false, "still not there");
  assert.equal(byId(claim.id).unfunded, true);
  // the payment lands
  await pool.insert(claim.commitment);
  assert.equal(await reconcileUnfunded(env), true);
  assert.equal(byId(claim.id).unfunded, false);
  assert.equal(total(counted(claim)), 40_000_000n, "counted once the vault shows it");
  assert.equal((sumByAsset(getAllNotes()).get(lc(ASSET)) ?? 0n) - before, 40_000_000n);
  assert.equal(unfundedClaims(getAllNotes()).some((n) => n.id === claim.id), false);
});

await test("a claim saved before this check is checked once, and taken out of the balance if unpaid", async () => {
  const pool = mockPool();
  const unpaid = await claimed(pool, 2_000_000n, { inPool: false });
  const paid = await claimed(pool, 3_000_000n);
  assert.equal(total(counted(unpaid)), 2_000_000n, "an old claim, never checked");
  assert.equal(await reconcileUnfunded(pool.env()), true);
  assert.equal(byId(unpaid.id).unfunded, true);
  assert.equal(total(counted(unpaid)), 0n);
  assert.equal(byId(paid.id).unfunded, false, "a paid one is marked checked");
  assert.equal(total(counted(paid)), 3_000_000n);
  // an unreadable vault changes nothing
  const env = pool.env();
  await pool.insert(unpaid.commitment);
  assert.equal(await reconcileUnfunded(pool.env({ chain: { ...env.chain, isCommitmentSeen: async () => { throw new Error("rpc down"); } } })), false);
  assert.equal(byId(unpaid.id).unfunded, true);
});

// ---------------------------------------------------------------- restoring a backup (user report, 24 Oct 2026)
// A claimed and secured 10 USDG showed for a few seconds after a backup restore,
// then went: the backup's copy of the claim was written over this browser's,
// counted although the sweep had spent it, and retired again by the next sync.

await test("a backup from before securing, restored where it was secured: the money stays, once, in the swept note", async () => {
  const pool = mockPool();
  const env = pool.env();
  const claim = await claimed(pool, 10_000_000n);
  const backup = JSON.stringify(await exportNotesBackup(ME));
  assert.equal((await secureClaim({ note: claim, relay: true, sendWithWallet: noWallet }, env)).status, "swept");
  const [fresh] = freshOf(claim);

  const res = await importNotesBackup(backup, ME, backupSpentCheck(env));
  assert.equal(res.ok, true);
  assert.deepEqual(counted(claim).map((n) => n.id), [fresh!.id], "only the swept note counts, never the spent claim next to it");
  assert.equal(total(counted(claim)), 10_000_000n);
  assert.equal(byId(claim.id).status, "recovered");
  assert.equal(byId(claim.id).secured, true, "the claim stays secured");

  await syncAsTheAppDoes(pool, env);
  assert.deepEqual(counted(claim).map((n) => n.id), [fresh!.id], "still in the balance after the sync");
  assert.equal(total(counted(claim)), 10_000_000n);
  assert.equal(byId(claim.id).secured, true, "Prove still shows it secured");
});

await test("a backup made while the move was on its way, restored where it landed: nothing goes back to waiting", async () => {
  const pool = mockPool();
  const env = pool.env();
  const claim = await claimed(pool, 10_000_000n);
  let backup = "";
  const r = await secureClaim(
    { note: claim, relay: true, sendWithWallet: noWallet },
    pool.env({
      relay: async (t) => {
        backup = JSON.stringify(await exportNotesBackup(ME)); // the claim, and its fresh note still pending
        return pool.transfer([t.proof, t.root, t.nullifier, t.commitments]);
      },
    })
  );
  assert.equal(r.status, "swept");
  const [fresh] = freshOf(claim);
  assert.ok(JSON.parse(backup).notes.some((n: LocalNote) => n.id === fresh!.id && n.sweepPending), "the backup holds it pending");

  await importNotesBackup(backup, ME, backupSpentCheck(env));
  assert.equal(byId(fresh!.id).sweepPending, false, "the landed note stays landed");
  assert.deepEqual(counted(claim).map((n) => n.id), [fresh!.id]);
  await syncAsTheAppDoes(pool, env);
  assert.equal(total(counted(claim)), 10_000_000n);
  assert.equal(byId(claim.id).secured, true);
});

await test("a claim an older restore wrote over is secured again on the next sync, and counted once", async () => {
  const pool = mockPool();
  const env = pool.env();
  const claim = await claimed(pool, 10_000_000n);
  const stale = { ...claim }; // the backup's copy, from before securing
  assert.equal((await secureClaim({ note: claim, relay: true, sendWithWallet: noWallet }, env)).status, "swept");
  const [fresh] = freshOf(claim);
  // what restoring did before it merged: the backup's copy written over this browser's
  await saveLocalNote(stale);
  assert.equal(byId(claim.id).secured, undefined);

  await syncAsTheAppDoes(pool, env);
  assert.equal(byId(claim.id).secured, true, "Prove shows it secured again");
  assert.equal(byId(claim.id).status, "recovered");
  assert.deepEqual(counted(claim).map((n) => n.id), [fresh!.id]);
  assert.equal(await reconcileClaims(env), false, "nothing left to mark");
});

/** This browser without these notes: a new device, or one whose storage was cleared. */
const forget = (claim: LocalNote) => setAllNotes(getAllNotes().filter((n) => n.id !== claim.id && n.sweptFrom?.id !== claim.id));

await test("the same backup where those notes aren't: the spent claim never counts, not even before a sync, and the restore says so", async () => {
  const pool = mockPool();
  const env = pool.env();
  const claim = await claimed(pool, 10_000_000n);
  const backup = JSON.stringify(await exportNotesBackup(ME));
  assert.equal((await secureClaim({ note: claim, relay: true, sendWithWallet: noWallet }, env)).status, "swept");
  await forget(claim);

  const res = await importNotesBackup(backup, ME, backupSpentCheck(env));
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.moved, 1, "the claim is reported as spent since the backup");
  assert.equal(res.movedClaims, 1);
  assert.equal(restored(claim).status, "recovered", "kept as history: the payment can still be proved");
  assert.ok(restored(claim).id !== claim.id && restored(claim).id.startsWith("imp-"), "under a new id, still a claim");
  assert.equal(total(countedOf(claim)), 0n, "never shown as money");
  await syncAsTheAppDoes(pool, env);
  assert.equal(total(countedOf(claim)), 0n);
});

await test("a backup holding the swept note restores it, counted straight away and after the sync", async () => {
  const pool = mockPool();
  const env = pool.env();
  const claim = await claimed(pool, 10_000_000n);
  assert.equal((await secureClaim({ note: claim, relay: true, sendWithWallet: noWallet }, env)).status, "swept");
  const backup = JSON.stringify(await exportNotesBackup(ME));
  const [fresh] = freshOf(claim);
  await forget(claim);
  assert.equal(total(counted(claim)), 0n);

  const res = await importNotesBackup(backup, ME, backupSpentCheck(env));
  assert.ok(res.ok && res.count >= 1 && res.moved === 0);
  assert.deepEqual(countedOf(claim, fresh!).map((n) => n.commitment), [fresh!.commitment]);
  assert.notEqual(restored(fresh!).sweptFrom?.id, claim.id, "the move it came by names no note here");
  await syncAsTheAppDoes(pool, env);
  assert.deepEqual(countedOf(claim, fresh!).map((n) => n.commitment), [fresh!.commitment]);
  assert.equal(total(countedOf(claim, fresh!)), 10_000_000n);
});

await test("a restore that can't read the vault still adds the note, for the sync to settle", async () => {
  const pool = mockPool();
  const env = pool.env();
  const claim = await claimed(pool, 10_000_000n);
  const backup = JSON.stringify(await exportNotesBackup(ME));
  assert.equal((await secureClaim({ note: claim, relay: true, sendWithWallet: noWallet }, env)).status, "swept");
  await forget(claim);
  const down = pool.env({ chain: { ...env.chain, isSpent: async () => { throw new Error("rpc down"); } } });
  const res = await importNotesBackup(backup, ME, backupSpentCheck(down));
  assert.ok(res.ok && res.moved === 0);
  assert.equal(restored(claim).status, "open", "never dropped: a secret is only ever added");
  await syncAsTheAppDoes(pool, env);
  assert.equal(restored(claim).status, "recovered", "the sync retires it once the vault answers");
});

await test("a claim on another network is refused before anything runs", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 1_000_000n);
  await assert.rejects(
    secureClaim({ note: claim, relay: true, sendWithWallet: noWallet }, pool.env({ chainId: 1 })),
    /Switch to the network/
  );
  assert.equal(freshOf(claim).length, 0);
});

await test("a wrong amount is caught before anything is sent", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 2_000_000n);
  const lying = { ...claim, amountWei: "20000000" };
  const r = await secureClaim({ note: lying, relay: true, sendWithWallet: noWallet }, pool.env());
  assert.equal(r.status, "bad_note");
  assert.equal(freshOf(claim).length, 0);
});

// ---------------------------------------------------------------- private swaps (review F-2)

/** A swap's two pending notes (the new one, and the refund note that keeps what a refund needs). */
async function swapNotes(pool: ReturnType<typeof mockPool>, amount: bigint) {
  const spentNote = await claimed(pool, amount);
  const from = { id: spentNote.id, nullifier: spentNote.nullifier! };
  const fresh = async (id: string, value: bigint, extra: Partial<LocalNote>) => {
    const secret = await randomSecretField();
    const commitment = fieldToHex(await noteCommitmentPoseidon(secret, value, ASSET));
    const n: LocalNote = {
      id,
      chainId: net.chainId,
      pool: POOL,
      asset: ASSET,
      amountWei: value.toString(),
      commitment,
      secret: fieldToHex(secret),
      nullifier: fieldToHex(await noteNullifierPoseidon(secret, hexToField(commitment))),
      bound: true,
      scheme: "poseidon",
      from: ME,
      createdAt: Date.now(),
      status: "open",
      source: "local",
      sweptFrom: from,
      sweepPending: true,
      ...extra,
    };
    saveLocalNote(n);
    return n;
  };
  const out = await fresh(`sw-${Date.now()}`, 7_000_000n, {});
  const refund = await fresh(`swr-${Date.now()}`, amount - amount / 100n, {
    vaultSwap: {
      router: "0x00000000000000000000000000000000000beef1",
      assetIn: ASSET,
      amountIn: amount.toString(),
      out: { commitment: out.commitment, asset: ASSET, amount: out.amountWei },
      route: [],
    },
  });
  return { spentNote, out, refund };
}

await test("swap: an unshield sent alone keeps the refund note pending and finishes it", async () => {
  const pool = mockPool();
  const { spentNote, out, refund } = await swapNotes(pool, 20_000_000n);
  pool.spent.add(lc(spentNote.nullifier!)); // the unshield, sent on its own: money at the escrow
  const finished: string[] = [];
  const env = pool.env({ escrowWaiting: async () => true, finishRefund: async (n) => void finished.push(n.id) });
  await reconcileClaims(env);
  assert.equal(byId(refund.id).status, "open", "the refund note is not dead");
  assert.equal(byId(refund.id).sweepPending, true, "still pending, out of the balance");
  assert.equal(byId(out.id).status, "recovered", "the swap's new note can never land now");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(finished, [refund.id], "the refund is finished");
  // the refund lands: counted, once
  await pool.insert(refund.commitment);
  await reconcileClaims(env);
  assert.equal(byId(refund.id).sweepPending, false);
  assert.equal(byId(refund.id).status, "open");
});

await test("swap: a refund note the vault's fee outgrew is held for the exit, not given up", async () => {
  const pool = mockPool();
  const { spentNote, refund } = await swapNotes(pool, 10_000_000n);
  pool.spent.add(lc(spentNote.nullifier!));
  let tried = 0;
  await reconcileClaims(pool.env({ escrowWaiting: async () => "short", finishRefund: async () => void tried++ }));
  assert.equal(byId(refund.id).status, "open", "the money is still there");
  assert.equal(byId(refund.id).sweepPending, true, "and out of the balance");
  assert.equal(byId(refund.id).refundHeld, "blocked", "which is what shows the exit");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(tried, 0, "this refund note can't land, so no proof is spent on it");
});

await test("swap: an unreadable escrow keeps the refund note pending, and nothing is finished blind", async () => {
  const pool = mockPool();
  const { spentNote, refund } = await swapNotes(pool, 10_000_000n);
  pool.spent.add(lc(spentNote.nullifier!));
  let tried = 0;
  const env = pool.env({ escrowWaiting: async () => null, finishRefund: async () => void tried++ });
  await reconcileClaims(env);
  assert.equal(byId(refund.id).sweepPending, true);
  assert.equal(byId(refund.id).status, "open");
  assert.equal(tried, 0);
  // a read that throws counts as unread too
  await reconcileClaims(pool.env({ escrowWaiting: async () => Promise.reject(new Error("rpc down")) }));
  assert.equal(byId(refund.id).status, "open");
});

await test("swap: once the swap landed, the empty escrow lets the refund note go", async () => {
  const pool = mockPool();
  const { spentNote, out, refund } = await swapNotes(pool, 10_000_000n);
  pool.spent.add(lc(spentNote.nullifier!));
  await pool.insert(out.commitment); // the swap itself landed
  await reconcileClaims(pool.env({ escrowWaiting: async () => false }));
  assert.equal(byId(out.id).sweepPending, false, "the new note counts");
  assert.equal(byId(refund.id).status, "recovered", "the refund note can never land");
});

await test("swap: a refund landing between the reads is never given up", async () => {
  const pool = mockPool();
  const { spentNote, refund } = await swapNotes(pool, 10_000_000n);
  pool.spent.add(lc(spentNote.nullifier!));
  // At the pinned block the escrow still held the money; by the latest block the
  // refund has landed and emptied it. The escrow must be read at the pinned block.
  const reads: (bigint | undefined)[] = [];
  const env = pool.env({
    escrowWaiting: async (_n, block) => {
      reads.push(block);
      return block === BLOCK;
    },
    finishRefund: async () => {},
  });
  await reconcileClaims(env);
  assert.deepEqual(reads, [BLOCK], "the escrow is read at the block the vault was read at");
  assert.equal(byId(refund.id).status, "open", "not given up");
  // and with no pinned block at all, it waits rather than guessing
  await reconcileClaims(pool.env({ stateAt: async () => ({ spent: true, seen: false, block: null }), escrowWaiting: async () => false }));
  assert.equal(byId(refund.id).status, "open");
  await pool.insert(refund.commitment);
  await reconcileClaims(env);
  assert.equal(byId(refund.id).sweepPending, false, "it lands and counts");
});

// The note store's writes land on disk encrypted, never as plaintext.
await new Promise((r) => setTimeout(r, 50));
const stored = localStorage.getItem("gloam.shield.notes.v1") ?? "";
assert.ok(stored.startsWith("gloamenc1:"), "notes stored encrypted");

console.log(`\n${passed} claim-sweep checks passed`);
