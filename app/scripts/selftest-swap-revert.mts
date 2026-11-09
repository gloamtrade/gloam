/**
 * Self-test: a private swap that lands and reverts (lib/vaultSwapRun
 * sendVaultSwap, lib/claimSweep moveRevertedNotes).
 *
 * Such a swap's unshield proof stays valid until its note is spent, so the app
 * marks the note and moves it whole to a fresh one as soon as the relay takes
 * it. Runs the app's own code (note store, sweep, reconcile) against an
 * in-memory vault that follows transfer's rules, as selftest-claim-sweep does,
 * plus that unshield sent on its own (the money goes to the swap's escrow) and
 * the refund out of the escrow, which a closed deposit limit refuses, and the
 * swap itself landing late, which the router refuses once the note is spent.
 * Proofs are not checked here. Covers: what does and doesn't mark a note, the
 * move starting as soon as the revert is known, the retry after a reload, a relay that is down,
 * refuses or loses its reply, a tab closed before the receipt, a swap with no
 * hash that shows nothing for an hour (and that same swap landing after all,
 * before or after the move), the unshield landing first or during the move, a
 * refund held on a closed limit, two tabs, a backup, and what spends a marked
 * note. Throughout, no note may be lost or counted twice.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-swap-revert.mts
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

const { getActiveNetwork, getNetwork } = await import("../src/lib/networks");
const { getAllNotes, setAllNotes } = await import("../src/lib/noteVault");
const {
  RELAY_SPEND_LOCK_MS,
  activeSpendableNotes,
  exportNotesBackup,
  heldSwapRefunds,
  importNotesBackup,
  saveLocalNote,
  sumByAsset,
  swapProofWait,
} = await import("../src/lib/shield");
const { spendPlanFor, spendWaitMessage } = await import("../src/lib/cashOutSplit");
const { checkPlan } = await import("../src/lib/cashOutPrivately");
const { MOVE_LAND_MS, SWAP_UNSEEN_MS, appClaimEnv, backupSpentCheck, moveRevertedNotes, reconcileClaims } = await import(
  "../src/lib/claimSweep"
);
const { SWAP_MAYBE_SENT, SWAP_REVERTED, SWAP_SPENT, sendVaultSwap } = await import("../src/lib/vaultSwapRun");
const { RelaySubmitError } = await import("../src/lib/relay/client");
const { INFLIGHT_TTL_SEC } = await import("../src/lib/relay/inflight");
type LocalNote = import("../src/lib/shield").LocalNote;
type ClaimEnv = import("../src/lib/claimSweep").ClaimEnv;
type Sender = import("../src/lib/vaultSwapRun").SwapSender;
type SwapCall = Parameters<Sender["relay"]>[0];

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  // each starts on an empty store: an old test's pending swap would soon be over an hour old
  await setAllNotes([]);
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

// Time is moved by hand: the relay's lock and the retries are minutes long.
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const after = (ms: number) => {
  skew += ms;
};
const passLock = () => after(RELAY_SPEND_LOCK_MS + 1);

const tick = () => new Promise((r) => setTimeout(r, 15));
async function until(ok: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (ok()) return;
    await tick();
  }
  assert.fail(`timed out waiting: ${what}`);
}

const net = getActiveNetwork();
const POOL = net.pool as Address;
const ASSET = "0x00000000000000000000000000000000000000ee" as Address;
const ROUTER = "0x00000000000000000000000000000000000beef1" as Address;
const ME = "0x1111111111111111111111111111111111111111" as Address;
const lc = (h: string) => h.toLowerCase();
const BLOCK = BigInt(1);
type Transfer = readonly [Hex, Hex, Hex, readonly [Hex, Hex]];

/** The vault, the swap's escrow, and the deposit limit the refund goes through. */
function mockVault() {
  const tree = new IncrementalMerkleTreePoseidon();
  const index = new Map<string, number>();
  const roots = new Set<string>();
  const spent = new Set<string>();
  const receipts = new Map<string, "success" | "reverted">();
  /** What waits at each swap's escrow, by the nullifier of the note it took. */
  const escrow = new Map<string, bigint>();
  /** The same for one try of a swap: by the note's nullifier and that try's refund note, as each try has its own escrow. */
  const escrowOfTry = new Map<string, bigint>();
  const tryKey = (nullifier: string, refundCommitment: string) => `${lc(nullifier)}|${lc(refundCommitment)}`;
  const state = { limitOpen: true, refundTries: 0, proofs: 0 };
  let n = 0;
  const newHash = () => `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
  async function insert(c: Hex) {
    index.set(lc(c), await tree.insert(hexToField(c)));
    roots.add(lc(fieldToHex(tree.currentRoot)));
  }
  async function apply(args: Transfer) {
    const [, root, nullifier, outs] = args;
    const ok = roots.has(lc(root)) && !spent.has(lc(nullifier)) && outs.every((c) => !index.has(lc(c)));
    if (ok) {
      spent.add(lc(nullifier));
      for (const c of outs) await insert(c);
    }
    return ok;
  }
  const vault = {
    insert,
    apply,
    spent,
    index,
    escrow,
    receipts,
    state,
    newHash,
    async transfer(args: Transfer): Promise<Hex> {
      const hash = newHash();
      receipts.set(hash, (await apply(args)) ? "success" : "reverted");
      return hash;
    },
    /**
     * The swap call itself landing. With the note unspent the new note lands. With
     * it spent and nothing at the escrow the router reverts (BadRefund, the swap's
     * contract test test_a_note_spent_elsewhere_has_nothing_to_refund): nothing moves.
     */
    async landSwap(source: LocalNote, out: LocalNote): Promise<boolean> {
      if (spent.has(lc(source.nullifier!))) return false;
      spent.add(lc(source.nullifier!));
      await insert(out.commitment);
      return true;
    },
    /** The swap's unshield sent on its own. False when the vault refuses it: the note is already spent. */
    replay(note: LocalNote): boolean {
      if (spent.has(lc(note.nullifier!))) return false;
      spent.add(lc(note.nullifier!));
      escrow.set(lc(note.nullifier!), BigInt(note.amountWei));
      return true;
    },
    /** One try's unshield sent on its own, into that try's escrow only. */
    replayInto(note: LocalNote, refund: LocalNote): boolean {
      if (spent.has(lc(note.nullifier!))) return false;
      spent.add(lc(note.nullifier!));
      escrowOfTry.set(tryKey(note.nullifier!, refund.commitment), BigInt(note.amountWei));
      return true;
    },
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
        prove: async () => {
          state.proofs++;
          return { proofBytes: "0xdeadbeef" };
        },
        relay: (t) => vault.transfer([t.proof, t.root, t.nullifier, t.commitments]),
        leafIndexOf: async (c) => index.get(lc(c)),
        stateAt: async (nf, c) => ({ spent: nf ? spent.has(lc(nf)) : null, seen: index.has(lc(c)), block: BLOCK }),
        escrowWaiting: async (note) =>
          escrow.has(lc(note.sweptFrom!.nullifier)) || escrowOfTry.has(tryKey(note.sweptFrom!.nullifier, note.commitment)),
        finishRefund: async (note) => {
          state.refundTries++;
          if (!state.limitOpen) {
            throw new RelaySubmitError("The vault is not taking that much of this asset right now.", "OverDepositLimit");
          }
          escrow.delete(lc(note.sweptFrom!.nullifier));
          escrowOfTry.delete(tryKey(note.sweptFrom!.nullifier, note.commitment));
          await insert(note.commitment);
          return true;
        },
        txOutcome: async (h) => receipts.get(h) ?? null,
        ...over,
      };
    },
  };
  return vault;
}
type Vault = ReturnType<typeof mockVault>;

let ids = 0;
async function makeNote(prefix: string, value: bigint, extra: Partial<LocalNote> = {}): Promise<LocalNote> {
  const secret = await randomSecretField();
  const commitment = fieldToHex(await noteCommitmentPoseidon(secret, value, ASSET));
  const n: LocalNote = {
    id: `${prefix}-${++ids}`,
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
    ...extra,
  };
  await saveLocalNote(n);
  return n;
}

/** A note in the vault and the two notes a swap of it saves before sending, as runVaultSwap does. */
async function swapNotes(pool: Vault, amount: bigint) {
  const source = await makeNote("co", amount);
  await pool.insert(source.commitment);
  const from = { id: source.id, nullifier: source.nullifier! };
  const out = await makeNote("sw", 7_000_000n, { sweptFrom: from, sweepPending: true });
  const refund = await makeNote("swr", amount - amount / 100n, {
    sweptFrom: from,
    sweepPending: true,
    vaultSwap: {
      router: ROUTER,
      assetIn: ASSET,
      amountIn: amount.toString(),
      out: { commitment: out.commitment, asset: ASSET, amount: out.amountWei },
      route: [],
    },
  });
  return { source, out, refund };
}

function callFor(source: LocalNote, out: LocalNote, refund: LocalNote): SwapCall {
  const d = (n: LocalNote) => ({ proof: "0x" as Hex, commitment: n.commitment, asset: ASSET, amount: BigInt(n.amountWei) });
  return {
    chainId: net.chainId,
    router: ROUTER,
    spend: { proof: "0x", root: "0x", nullifier: source.nullifier!, asset: ASSET, amount: BigInt(source.amountWei) },
    deposit: d(out),
    refund: d(refund),
    route: [],
  };
}

/** Sends a swap of a new note and returns its notes and the error the person would see. */
async function swap(pool: Vault, amount: bigint, over: Partial<Sender> = {}) {
  const notes = await swapNotes(pool, amount);
  const hash = pool.newHash();
  const send: Sender = {
    relay: async () => {
      pool.receipts.set(hash, "reverted");
      return hash;
    },
    wait: async (h) => pool.receipts.get(h)!,
    isSpent: async (nf) => pool.spent.has(lc(nf)),
    moveNote: () => {},
    ...over,
  };
  const { source, out, refund } = notes;
  const error = await sendVaultSwap(callFor(source, out, refund), { spentId: source.id, outId: out.id, refund }, send).then(
    () => null,
    (e: Error) => e
  );
  return { ...notes, hash, error };
}

let copies = 0;
/** Another tab's copy of the note store, or the one a reload starts with: over the same disk. */
async function otherStore() {
  const v = (await import(`../src/lib/noteVault.ts?tab=${++copies}`)) as typeof import("../src/lib/noteVault");
  await v.unlockNoteVault();
  await v.syncFromDisk();
  return v;
}
/** Another tab's copy of the sync, or the one a reload starts with: it remembers no tries. */
const otherSync = async () => (await import(`../src/lib/claimSweep.ts?tab=${++copies}`)) as typeof import("../src/lib/claimSweep");

const byId = (id: string) => getAllNotes().find((n) => n.id === id);
const note = (id: string) => byId(id)!;
/** What the balance counts for this note and everything saved from it. */
const counted = (source: LocalNote) =>
  activeSpendableNotes(getAllNotes()).filter((n) => n.id === source.id || n.sweptFrom?.id === source.id);
const countedIds = (source: LocalNote) => counted(source).map((n) => n.id);
const total = (source: LocalNote) => counted(source).reduce((s, n) => s + BigInt(n.amountWei), 0n);
/** The moves saved for a note (the sweep's fresh notes). */
const moves = (source: LocalNote) => getAllNotes().filter((n) => n.id.startsWith("swp-") && n.sweptFrom?.id === source.id);

// ---------------------------------------------------------------- what marks a note

const refused = {
  relay: async () => {
    throw new RelaySubmitError("The price moved since the quote.", "OverInput");
  },
};

await test("a swap the relay refused keeps both notes, out of the balance, and marks nothing yet", async () => {
  const pool = mockVault();
  const { source, out, refund, error } = await swap(pool, 20_000_000n, refused);
  assert.match(error!.message, /price moved/);
  assert.equal(note(out.id).sweepPending, true);
  assert.equal(note(refund.id).sweepPending, true);
  assert.equal(note(source.id).swapProofAt, undefined);
  assert.equal(spendPlanFor(note(source.id), BigInt(source.amountWei)), "direct");
  assert.deepEqual(countedIds(source), [source.id], "the balance shows the note once");
});

await test("a refused swap's unshield landing alone later comes back as its refund note", async () => {
  const pool = mockVault();
  const { source, refund } = await swap(pool, 20_000_000n, refused);
  assert.ok(pool.replay(source), "its proof stayed valid");
  await reconcileClaims(pool.env());
  await new Promise((r) => setTimeout(r, 5));
  await reconcileClaims(pool.env());
  assert.equal(note(refund.id).sweepPending, false, "the refund note landed");
  assert.equal(note(refund.id).status, "open");
  assert.equal(note(source.id).status, "recovered");
  assert.equal(total(source), BigInt(refund.amountWei), "counted once");
});

await test("a refused swap tried again: the first try's refund note and exit key stay until the note is spent, and come back if its escrow was paid", async () => {
  const pool = mockVault();
  const first = await swap(pool, 20_000_000n, refused);
  const { source } = first;
  // the second try saves its own two notes, with its own exit key, as runVaultSwap does
  const from = { id: source.id, nullifier: source.nullifier! };
  const out2 = await makeNote("sw", 7_000_000n, { sweptFrom: from, sweepPending: true });
  const refund2 = await makeNote("swr", BigInt(first.refund.amountWei), {
    sweptFrom: from,
    sweepPending: true,
    vaultSwap: { ...first.refund.vaultSwap!, exitKey: "0x00000000000000000000000000000000000e2e2e", deadline: "1" },
  });
  // however long it takes, nothing of the first try goes while the note is unspent
  after(3 * 3600_000);
  await reconcileClaims(pool.env({ relayReady: async () => false }));
  for (const n of [first.out, first.refund, out2, refund2]) assert.equal(note(n.id).sweepPending, true, n.id);
  assert.equal(note(first.refund.id).secret, first.refund.secret, "the first try's exit key comes from this note");
  // the first try's unshield lands in its own escrow ahead of the second try
  assert.ok(pool.replayInto(source, first.refund));
  await reconcileClaims(pool.env());
  await new Promise((r) => setTimeout(r, 5));
  await reconcileClaims(pool.env());
  assert.equal(note(first.refund.id).status, "open", "the first try's refund note landed");
  assert.equal(note(first.refund.id).sweepPending, false);
  assert.equal(note(refund2.id).status, "recovered", "the second try's escrow was never paid");
  assert.equal(note(out2.id).status, "recovered");
  assert.equal(note(first.out.id).status, "recovered");
  assert.equal(total(source), BigInt(first.refund.amountWei), "counted once");
});

await test("a refused swap's notes go once its note has moved", async () => {
  const pool = mockVault();
  const { source, out, refund } = await swap(pool, 20_000_000n, refused);
  pool.spent.add(lc(source.nullifier!)); // spent some other way, with nothing at the escrow
  await reconcileClaims(pool.env());
  assert.equal(note(refund.id).status, "recovered", "that proof can't land now");
  assert.equal(note(out.id).status, "recovered");
});

await test("a swap that may have gone out keeps its notes for the sync, and marks nothing", async () => {
  const pool = mockVault();
  const { source, out, refund, error } = await swap(pool, 20_000_000n, {
    relay: async () => {
      throw new RelaySubmitError("This may have gone out already.", "maybe_sent");
    },
  });
  assert.equal(error!.message, SWAP_MAYBE_SENT);
  assert.equal(note(out.id).sweepPending, true);
  assert.equal(note(refund.id).sweepPending, true);
  assert.equal(note(source.id).swapProofAt, undefined);
  await reconcileClaims(pool.env());
  assert.equal(note(source.id).swapProofAt, undefined, "the sync has nothing to read: no hash came back");
  assert.deepEqual(countedIds(source), [source.id]);
});

await test("a swap that landed marks nothing", async () => {
  const pool = mockVault();
  const { source, hash, error } = await swap(pool, 20_000_000n, { wait: async () => "success" });
  assert.equal(error, null);
  assert.equal(note(source.id).swapProofAt, undefined);
  assert.ok(hash);
});

await test("landed and reverted: the note is marked before the person hears, and counted once", async () => {
  const pool = mockVault();
  const before = Date.now();
  const { source, out, refund, hash, error } = await swap(pool, 20_000_000n);
  assert.equal(error!.message, SWAP_REVERTED);
  const marked = note(source.id);
  assert.ok(marked.swapProofAt! >= before, "marked with when it went out");
  assert.equal(note(refund.id).vaultSwap?.sent?.hash, hash);
  assert.equal(note(out.id).sweepPending, true, "the swap's notes stay saved");
  assert.equal(note(refund.id).sweepPending, true);
  assert.deepEqual(countedIds(source), [source.id]);
  assert.equal(total(source), 20_000_000n);
  // on disk, not only in this tab: another copy of the store reads it back, decrypted
  const tab = await otherStore();
  assert.equal(tab.getAllNotes().find((n) => n.id === source.id)?.swapProofAt, marked.swapProofAt);
});

await test("reverted because a copy already spent the note: says so, and nothing to move", async () => {
  const pool = mockVault();
  const { source, error } = await swap(pool, 20_000_000n, {
    relay: async (c) => {
      pool.spent.add(lc(c.spend.nullifier));
      const h = pool.newHash();
      pool.receipts.set(h, "reverted");
      return h;
    },
  });
  assert.equal(error!.message, SWAP_SPENT);
  assert.equal(note(source.id).swapProofAt, undefined);
});

await test("the tab closed before the receipt: the sync reads it, and marks the note only for a real revert", async () => {
  const pool = mockVault();
  const gaveUp = async () => {
    throw new Error("Timed out while waiting for transaction");
  };
  const a = await swap(pool, 20_000_000n, { relay: async () => pool.newHash(), wait: gaveUp });
  assert.equal(a.error!.message, SWAP_MAYBE_SENT);
  const sent = note(a.refund.id).vaultSwap!.sent!;
  assert.equal(note(a.source.id).swapProofAt, undefined);
  assert.equal(await reconcileClaims(pool.env()), false, "no receipt yet");
  assert.equal(note(a.source.id).swapProofAt, undefined);
  pool.receipts.set(sent.hash, "success");
  await reconcileClaims(pool.env());
  assert.equal(note(a.source.id).swapProofAt, undefined, "it landed: nothing to do");

  const b = await swap(pool, 20_000_000n, { relay: async () => pool.newHash(), wait: gaveUp });
  const hash = note(b.refund.id).vaultSwap!.sent!.hash;
  pool.receipts.set(hash, "reverted");
  assert.equal(await reconcileClaims(pool.env()), true);
  assert.equal(note(b.source.id).swapProofAt, note(b.refund.id).vaultSwap!.sent!.at);
  // an unreadable chain marks nothing
  const c = await swap(pool, 20_000_000n, { relay: async () => pool.newHash(), wait: gaveUp });
  await reconcileClaims(pool.env({ txOutcome: () => Promise.reject(new Error("rpc down")) }));
  assert.equal(note(c.source.id).swapProofAt, undefined);
});

// ---------------------------------------------------------------- the move

await test("the move starts as soon as the revert is known, with no sync and no wait, and the proof is dead", async () => {
  const pool = mockVault();
  let sends = 0;
  const env = pool.env({
    relay: (t) => {
      sends++;
      return pool.transfer([t.proof, t.root, t.nullifier, t.commitments]);
    },
  });
  let started = 0;
  const { source, out, refund, error } = await swap(pool, 20_000_000n, {
    moveNote: () => {
      started++;
      assert.ok(getAllNotes().some((n) => n.swapProofAt), "the mark is on the note before the move starts");
      void moveRevertedNotes(env);
    },
  });
  assert.equal(error!.message, SWAP_REVERTED);
  assert.equal(started, 1);
  await until(() => note(source.id).status === "recovered", "the move to land");
  assert.ok(swapProofWait(note(source.id)) > 0, "well before the relay's lock could have run out");
  assert.equal(sends, 1);
  assert.equal(pool.spent.has(lc(source.nullifier!)), true, "the old nullifier is spent");
  assert.equal(pool.replay(source), false, "so the swap's proof can't be used");

  const [moved] = moves(source);
  assert.ok(moved);
  assert.notEqual(lc(moved.secret), lc(source.secret));
  assert.equal(moved.sweepPending, false);
  assert.equal(moved.swapProofAt, undefined, "the fresh note is clean");
  assert.deepEqual(countedIds(source), [moved.id]);
  assert.equal(total(source), 20_000_000n);
  assert.equal(spendPlanFor(moved, BigInt(moved.amountWei)), "direct");
  // the swap's two notes can never land now: the next sync lets them go
  await reconcileClaims(env);
  assert.equal(note(out.id).status, "recovered");
  assert.equal(note(refund.id).status, "recovered");
  assert.deepEqual(countedIds(source), [moved.id]);
  assert.equal(sends, 1, "no second move");
});

await test("the sync that first reads a revert starts the move in the same pass", async () => {
  const pool = mockVault();
  const { source, refund } = await swap(pool, 20_000_000n, { wait: async () => Promise.reject(new Error("slow")) });
  assert.equal(note(source.id).swapProofAt, undefined);
  pool.receipts.set(note(refund.id).vaultSwap!.sent!.hash, "reverted");
  await reconcileClaims(pool.env());
  await until(() => note(source.id).status === "recovered", "the move to land");
  assert.equal(total(source), 20_000_000n);
});

await test("only a swap known to have reverted starts a move", async () => {
  const pool = mockVault();
  let started = 0;
  const moveNote = () => {
    started++;
  };
  await swap(pool, 20_000_000n, { moveNote, wait: async () => "success" });
  await swap(pool, 20_000_000n, { moveNote, wait: async () => Promise.reject(new Error("slow")) });
  await swap(pool, 20_000_000n, {
    moveNote,
    relay: async () => {
      throw new RelaySubmitError("This may have gone out already.", "maybe_sent");
    },
  });
  await swap(pool, 20_000_000n, {
    moveNote,
    relay: async () => {
      throw new RelaySubmitError("The price moved since the quote.", "OverInput");
    },
  });
  await swap(pool, 20_000_000n, { moveNote, isSpent: async () => true });
  assert.equal(started, 0);
});

await test("a relay still holding the note turns the first try away, and a later sync moves it", async () => {
  const pool = mockVault();
  const { source } = await swap(pool, 20_000_000n);
  let held = true;
  let tries = 0;
  const env = pool.env({
    relay: async (t) => {
      tries++;
      if (held) throw new RelaySubmitError("This payment is already being sent.", "in_flight");
      return pool.transfer([t.proof, t.root, t.nullifier, t.commitments]);
    },
  });
  await moveRevertedNotes(env);
  assert.equal(tries, 1);
  assert.equal(moves(source).length, 0);
  assert.deepEqual(countedIds(source), [source.id]);
  await moveRevertedNotes(env);
  assert.equal(tries, 1, "not again at once: each try is a proof");
  held = false;
  after(61_000);
  await moveRevertedNotes(env);
  assert.equal(note(source.id).status, "recovered");
  assert.equal(total(source), 20_000_000n);
});

await test("after a reload the move is tried again, from what is on disk", async () => {
  const pool = mockVault();
  const { source } = await swap(pool, 20_000_000n);
  passLock();
  // this tab tries with the relay down, then closes
  await moveRevertedNotes(
    pool.env({
      relay: async () => {
        throw new RelaySubmitError("The relay is off.", "relay_off");
      },
    })
  );
  assert.equal(note(source.id).status, "open");
  assert.ok(note(source.id).swapProofAt, "still marked");
  // the next load: a new copy of the sync, which remembers no tries, on what the store holds
  const loaded = await otherSync();
  await loaded.moveRevertedNotes(pool.env());
  assert.equal(note(source.id).status, "recovered");
  assert.equal(moves(source).filter((n) => n.status !== "recovered").length, 1);
  assert.equal(total(source), 20_000_000n);
});

await test("with the relay off no proof is made, and it goes once the relay is back", async () => {
  const pool = mockVault();
  const { source } = await swap(pool, 20_000_000n);
  passLock();
  await moveRevertedNotes(pool.env({ relayReady: async () => false }));
  await moveRevertedNotes(pool.env({ relayReady: () => Promise.reject(new Error("status down")) }));
  assert.equal(pool.state.proofs, 0);
  await moveRevertedNotes(pool.env({ relayReady: async () => true }));
  assert.equal(note(source.id).status, "recovered");
});

await test("a relay that turns the move away leaves no note behind, keeps the mark, and is asked again later", async () => {
  const pool = mockVault();
  const { source } = await swap(pool, 20_000_000n);
  passLock();
  let tries = 0;
  const env = pool.env({
    relay: async () => {
      tries++;
      throw new RelaySubmitError("This payment is already being sent.", "in_flight");
    },
  });
  await moveRevertedNotes(env);
  assert.equal(tries, 1);
  assert.equal(moves(source).length, 0, "its fresh note never went out");
  assert.equal(note(source.id).status, "open");
  assert.ok(note(source.id).secret.length > 10, "the note keeps its secret");
  assert.deepEqual(countedIds(source), [source.id]);
  await moveRevertedNotes(env);
  assert.equal(tries, 1, "not again at once");
  after(61_000);
  await moveRevertedNotes(env);
  assert.equal(tries, 2);
  after(61_000);
  await moveRevertedNotes(env);
  assert.equal(tries, 2, "each failed try waits longer: every one is a proof");
  after(61_000);
  await moveRevertedNotes(pool.env());
  assert.equal(note(source.id).status, "recovered");
  assert.equal(total(source), 20_000_000n);
});

await test("a failing read or proof changes nothing, and the sync goes on", async () => {
  const pool = mockVault();
  const { source } = await swap(pool, 20_000_000n);
  passLock();
  const env = pool.env();
  await moveRevertedNotes(pool.env({ chain: { ...env.chain, isSpent: () => Promise.reject(new Error("rpc down")) } }));
  assert.equal(note(source.id).unfunded, undefined);
  after(61_000);
  // a tree that can't be read is not news about the note: it stays in the balance
  await moveRevertedNotes(pool.env({ chain: { ...env.chain, pathForCommitment: async () => null } }));
  assert.equal(note(source.id).unfunded, undefined, "not marked as missing from the vault");
  assert.deepEqual(countedIds(source), [source.id]);
  after(121_000);
  await moveRevertedNotes(pool.env({ prove: () => Promise.reject(new Error("worker died")) }));
  assert.deepEqual(countedIds(source), [source.id]);
  after(241_000);
  await moveRevertedNotes(env);
  assert.equal(note(source.id).status, "recovered");
});

await test("a relay that lost its reply: the move is kept, not sent again, and counts when it lands", async () => {
  const pool = mockVault();
  const { source } = await swap(pool, 20_000_000n);
  passLock();
  let held: Transfer | null = null;
  let tries = 0;
  const lost = pool.env({
    relay: async (t) => {
      tries++;
      held = [t.proof, t.root, t.nullifier, t.commitments];
      throw new RelaySubmitError("Could not reach the relay.", "network");
    },
  });
  await moveRevertedNotes(lost);
  const [pending] = moves(source);
  assert.equal(pending!.sweepPending, true, "kept: it may have gone out");
  assert.deepEqual(countedIds(source), [source.id], "counted once, as the old note");
  after(120_000);
  await moveRevertedNotes(lost);
  assert.equal(tries, 1, "it gets time to land before another goes out");

  assert.equal(await pool.apply(held!), true);
  await reconcileClaims(pool.env());
  assert.equal(note(pending!.id).sweepPending, false);
  assert.equal(note(source.id).status, "recovered");
  assert.deepEqual(countedIds(source), [pending!.id]);
  assert.equal(total(source), 20_000_000n);
});

await test("a lost move that never lands gets a second one, and the first is retired", async () => {
  const pool = mockVault();
  const { source } = await swap(pool, 20_000_000n);
  passLock();
  await moveRevertedNotes(
    pool.env({
      relay: async () => {
        throw new RelaySubmitError("Could not reach the relay.", "network");
      },
    })
  );
  const [first] = moves(source);
  // syncs in the meantime don't use up its retries: it goes as soon as the time is up
  for (let i = 0; i < 4; i++) {
    after(MOVE_LAND_MS / 5);
    await moveRevertedNotes(pool.env());
    assert.equal(note(source.id).status, "open", "still waiting for the first to land");
  }
  after(MOVE_LAND_MS / 5 + 1);
  await moveRevertedNotes(pool.env());
  assert.equal(note(source.id).status, "recovered");
  await reconcileClaims(pool.env());
  assert.equal(note(first!.id).status, "recovered", "it can never land now");
  assert.equal(note(first!.id).sweepPending, false);
  assert.equal(countedIds(source).length, 1);
  assert.equal(total(source), 20_000_000n);
});

// ---------------------------------------------------------------- a swap with no hash, after an hour

/** A swap whose reply was lost: its notes are saved, no hash is. A swap from before hashes were saved looks the same. */
const lostSwap = (pool: Vault, amount: bigint) =>
  swap(pool, amount, {
    relay: async () => {
      throw new RelaySubmitError("This may have gone out already.", "maybe_sent");
    },
  });

await test("a swap with no hash under an hour old is left alone", async () => {
  assert.equal(SWAP_UNSEEN_MS, 3_600_000, "the rule is one hour");
  const pool = mockVault();
  const { source, out, refund } = await lostSwap(pool, 20_000_000n);
  after(SWAP_UNSEEN_MS - 60_000);
  assert.equal(await reconcileClaims(pool.env()), false);
  await tick();
  assert.equal(note(source.id).swapProofAt, undefined);
  assert.equal(pool.state.proofs, 0);
  assert.equal(pool.spent.has(lc(source.nullifier!)), false);
  assert.equal(spendPlanFor(note(source.id), BigInt(source.amountWei)), "direct");
  assert.equal(note(out.id).sweepPending, true, "it can still land");
  assert.equal(note(refund.id).sweepPending, true);
  assert.deepEqual(countedIds(source), [source.id]);
});

await test("over an hour with nothing landed: marked and moved like a proven revert", async () => {
  const pool = mockVault();
  const { source, out, refund } = await lostSwap(pool, 20_000_000n);
  after(SWAP_UNSEEN_MS + 1);
  const env = pool.env();
  assert.equal(await reconcileClaims(env), true);
  assert.equal(note(source.id).swapProofAt, refund.createdAt, "marked with when the swap was made");
  assert.equal(swapProofWait(note(source.id)), 0, "long past the relay's lock");
  assert.equal(spendWaitMessage(note(source.id)), null);
  assert.equal(spendPlanFor(note(source.id), BigInt(source.amountWei)), "move");
  await until(() => note(source.id).status === "recovered", "the move to land");
  assert.equal(pool.replay(source), false, "the swap's proof is dead");
  const [moved] = moves(source);
  assert.deepEqual(countedIds(source), [moved!.id]);
  await reconcileClaims(env);
  assert.equal(note(out.id).status, "recovered");
  assert.equal(note(refund.id).status, "recovered");
  assert.deepEqual(countedIds(source), [moved!.id]);
  assert.equal(total(source), 20_000_000n);
});

await test("the hour isn't enough on its own: the vault must show the note unspent", async () => {
  const pool = mockVault();
  const { source } = await lostSwap(pool, 20_000_000n);
  after(SWAP_UNSEEN_MS + 1);
  const env = pool.env();
  // unread: nothing is marked on a guess about the guess
  await reconcileClaims(pool.env({ chain: { ...env.chain, isSpent: () => Promise.reject(new Error("rpc down")) } }));
  assert.equal(note(source.id).swapProofAt, undefined);
  // spent, with the escrow unread, so the sync can't settle it yet: nothing to move
  pool.spent.add(lc(source.nullifier!));
  await reconcileClaims(pool.env({ escrowWaiting: async () => null }));
  assert.equal(note(source.id).swapProofAt, undefined);
});

await test("with a saved hash only the receipt decides, however old the swap is", async () => {
  const pool = mockVault();
  const { source, refund } = await swap(pool, 20_000_000n, {
    relay: async () => pool.newHash(),
    wait: async () => {
      throw new Error("Timed out while waiting for transaction");
    },
  });
  after(SWAP_UNSEEN_MS * 24);
  await reconcileClaims(pool.env());
  assert.equal(note(source.id).swapProofAt, undefined, "no receipt: no mark");
  pool.receipts.set(note(refund.id).vaultSwap!.sent!.hash, "reverted");
  await reconcileClaims(pool.env({ relayReady: async () => false }));
  assert.equal(note(source.id).swapProofAt, note(refund.id).vaultSwap!.sent!.at, "the proven path, unchanged");
});

await test("only a swap counts: an old pending split marks nothing", async () => {
  const pool = mockVault();
  const source = await makeNote("co", 20_000_000n);
  await pool.insert(source.commitment);
  await makeNote("chg", 5_000_000n, { sweptFrom: { id: source.id, nullifier: source.nullifier! }, sweepPending: true });
  after(SWAP_UNSEEN_MS * 24);
  await reconcileClaims(pool.env());
  assert.equal(note(source.id).swapProofAt, undefined);
});

await test("the swap lands after the move: it reverts, nothing moves, and the money is counted once", async () => {
  const pool = mockVault();
  const { source, out, refund } = await lostSwap(pool, 20_000_000n);
  after(SWAP_UNSEEN_MS + 1);
  await reconcileClaims(pool.env());
  await until(() => note(source.id).status === "recovered", "the move to land");
  assert.equal(await pool.landSwap(source, out), false, "the second spend fails");
  assert.equal(pool.index.has(lc(out.commitment)), false);
  await reconcileClaims(pool.env());
  const [moved] = moves(source);
  assert.equal(note(out.id).status, "recovered");
  assert.equal(note(refund.id).status, "recovered");
  assert.deepEqual(countedIds(source), [moved!.id]);
  assert.equal(total(source), 20_000_000n);
});

await test("the swap lands before the move does: the move fails, the swap stands, counted once", async () => {
  const pool = mockVault();
  const { source, out, refund } = await lostSwap(pool, 20_000_000n);
  after(SWAP_UNSEEN_MS + 1);
  let refused = 0;
  const env = pool.env({
    relay: async (t) => {
      assert.equal(await pool.landSwap(source, out), true, "the swap gets there first");
      const hash = await pool.transfer([t.proof, t.root, t.nullifier, t.commitments]);
      refused += pool.receipts.get(hash) === "reverted" ? 1 : 0;
      return hash;
    },
  });
  await reconcileClaims(env);
  await until(() => note(source.id).status === "recovered", "the note to be retired");
  assert.equal(refused, 1, "the second spend fails on chain");
  await reconcileClaims(pool.env());
  for (const m of moves(source)) assert.equal(note(m.id).status, "recovered", "the move can never land");
  assert.equal(note(out.id).sweepPending, false);
  assert.equal(note(out.id).status, "open");
  assert.equal(note(refund.id).status, "recovered");
  assert.deepEqual(countedIds(source), [out.id], "the swap's note, and nothing else");
  assert.ok(note(source.id).secret.length > 10, "history keeps its secret");
});

await test("the swap landed before the sync ever looked: nothing is marked or moved", async () => {
  const pool = mockVault();
  const { source, out, refund } = await lostSwap(pool, 20_000_000n);
  assert.equal(await pool.landSwap(source, out), true);
  after(SWAP_UNSEEN_MS + 1);
  await reconcileClaims(pool.env());
  await tick();
  assert.equal(pool.state.proofs, 0);
  assert.equal(moves(source).length, 0);
  assert.equal(note(source.id).swapProofAt, undefined);
  assert.equal(note(refund.id).status, "recovered");
  assert.deepEqual(countedIds(source), [out.id]);
});

await test("the unshield landed first, an hour on: the refund finishes and counts once", async () => {
  const pool = mockVault();
  const { source, refund } = await lostSwap(pool, 20_000_000n);
  assert.equal(pool.replay(source), true);
  after(SWAP_UNSEEN_MS + 1);
  const env = pool.env();
  await reconcileClaims(env);
  assert.equal(note(source.id).swapProofAt, undefined, "spent, and its money is at the escrow: nothing to move");
  await until(() => pool.index.has(lc(refund.commitment)), "the refund to land");
  await reconcileClaims(env);
  assert.equal(pool.state.proofs, 0);
  assert.deepEqual(countedIds(source), [refund.id]);
});

// ---------------------------------------------------------------- the proof used first

await test("the unshield landed first: the note is retired, and the refund note finishes and counts once", async () => {
  const pool = mockVault();
  const { source, out, refund } = await swap(pool, 20_000_000n);
  assert.equal(pool.replay(source), true);
  passLock();
  const env = pool.env();
  await moveRevertedNotes(env);
  assert.equal(pool.state.proofs, 0, "spent: nothing proved");
  assert.equal(moves(source).length, 0);
  assert.equal(note(source.id).status, "recovered");
  assert.equal(total(source), 0n, "the money is at the escrow, not in the balance");

  await reconcileClaims(env);
  assert.equal(note(out.id).status, "recovered");
  assert.equal(note(refund.id).refundHeld, "returning");
  assert.deepEqual(heldSwapRefunds(getAllNotes()).map((n) => n.id), [refund.id], "listed, so it doesn't just vanish");
  await until(() => pool.index.has(lc(refund.commitment)), "the refund to land");
  await reconcileClaims(env);
  assert.deepEqual(countedIds(source), [refund.id]);
  assert.equal(total(source), BigInt(refund.amountWei));
  assert.equal(heldSwapRefunds(getAllNotes()).some((n) => n.id === refund.id), false);
});

await test("the unshield landed during the move: the move is retired, the refund finishes, counted once", async () => {
  const pool = mockVault();
  const { source, refund } = await swap(pool, 20_000_000n);
  passLock();
  await moveRevertedNotes(
    pool.env({
      relay: (t) => {
        pool.replay(source);
        return pool.transfer([t.proof, t.root, t.nullifier, t.commitments]);
      },
    })
  );
  assert.equal(note(source.id).status, "recovered");
  const env = pool.env();
  await reconcileClaims(env);
  for (const m of moves(source)) assert.equal(note(m.id).status, "recovered", "a move that can never land");
  await until(() => pool.index.has(lc(refund.commitment)), "the refund to land");
  await reconcileClaims(env);
  assert.deepEqual(countedIds(source), [refund.id]);
});

await test("a closed limit: the refund keeps trying, the note is never given up, and the person is told", async () => {
  const pool = mockVault();
  const { source, refund } = await swap(pool, 20_000_000n);
  assert.equal(pool.replay(source), true);
  pool.state.limitOpen = false;
  passLock();
  const env = pool.env();
  await moveRevertedNotes(env);
  for (let i = 1; i <= 3; i++) {
    await reconcileClaims(env);
    await until(() => pool.state.refundTries === i, "another try");
    await until(() => note(refund.id).refundHeld === "blocked", "the note to say so");
    assert.equal(note(refund.id).sweepPending, true, "still pending");
    assert.equal(note(refund.id).status, "open", "never given up");
    assert.equal(note(refund.id).secret.length > 10, true);
    assert.equal(total(source), 0n, "not counted while it is held");
    assert.deepEqual(heldSwapRefunds(getAllNotes()).map((n) => n.id), [refund.id]);
  }
  // a reload changes nothing: it is all on the note
  const loaded = await otherSync();
  await loaded.reconcileClaims(env);
  await until(() => pool.state.refundTries === 4, "a try after the reload");
  assert.equal(note(refund.id).sweepPending, true);
  // a refusal that says nothing about the vault doesn't claim it is closed
  const other = await swap(pool, 10_000_000n);
  assert.equal(pool.replay(other.source), true);
  await reconcileClaims(
    pool.env({
      finishRefund: async () => {
        throw new RelaySubmitError("Could not reach the relay.", "network");
      },
    })
  );
  await tick();
  assert.equal(note(other.refund.id).refundHeld, "returning");
  // the limit opens again: it lands, and counts once
  pool.state.limitOpen = true;
  await reconcileClaims(env);
  await until(() => pool.index.has(lc(refund.commitment)), "the refund to land");
  await reconcileClaims(env);
  assert.equal(note(refund.id).sweepPending, false);
  assert.deepEqual(countedIds(source), [refund.id]);
  assert.equal(total(source), BigInt(refund.amountWei));
  assert.equal(heldSwapRefunds(getAllNotes()).some((n) => n.id === refund.id), false);
});

await test("a held refund the relay takes again says so", async () => {
  const pool = mockVault();
  const { source, refund } = await swap(pool, 20_000_000n);
  pool.replay(source);
  pool.state.limitOpen = false;
  const env = pool.env({
    // sent, but not landed yet
    finishRefund: async () => {
      if (!pool.state.limitOpen) throw new RelaySubmitError("Closed.", "OverDepositLimit");
      return true;
    },
  });
  await reconcileClaims(env);
  await until(() => note(refund.id).refundHeld === "blocked", "the note to say so");
  pool.state.limitOpen = true;
  await reconcileClaims(env);
  await until(() => note(refund.id).refundHeld === "returning", "the note to say so");
});

// ---------------------------------------------------------------- tabs, backups, other spends

await test("two tabs: one move goes, and the note counts once", async () => {
  const pool = mockVault();
  const { source } = await swap(pool, 20_000_000n);
  passLock();
  const other = await otherSync();
  let sends = 0;
  const env = pool.env({
    // proving takes a while, and neither tab has saved a fresh note until it is done
    prove: async () => {
      await tick();
      return { proofBytes: "0xdeadbeef" };
    },
    relay: (t) => {
      sends++;
      return pool.transfer([t.proof, t.root, t.nullifier, t.commitments]);
    },
  });
  await Promise.all([moveRevertedNotes(env), other.moveRevertedNotes(env)]);
  assert.equal(sends, 1, "Web Locks keep it to one tab");
  assert.equal(countedIds(source).length, 1);
  assert.equal(total(source), 20_000_000n);
});

await test("a move another tab just sent, not in this tab's copy of the notes yet: none goes out from here", async () => {
  const pool = mockVault();
  const { source } = await swap(pool, 20_000_000n);
  passLock();
  const tab = await otherStore();
  const theirs: LocalNote = {
    ...source,
    id: `swp-other-${++ids}`,
    sweptFrom: { id: source.id, nullifier: source.nullifier! },
    sweepPending: true,
    createdAt: Date.now(),
  };
  await tab.setAllNotes([theirs, ...tab.getAllNotes()]);
  assert.equal(byId(theirs.id), undefined, "this tab hasn't read it");
  await moveRevertedNotes(pool.env());
  assert.equal(pool.state.proofs, 0);
  assert.equal(note(theirs.id).sweepPending, true, "read from disk before anything was proved");
});

await test("two tabs with no Web Locks: both send, one lands, the sync retires the other, counted once", async () => {
  const pool = mockVault();
  const { source } = await swap(pool, 20_000_000n);
  passLock();
  const other = await otherSync();
  Object.defineProperty(globalThis.navigator, "locks", { value: undefined, configurable: true });
  try {
    const env = pool.env();
    const later = pool.env({
      // the second tab's proof finishes a little later, as it would
      prove: async () => {
        await tick();
        return { proofBytes: "0xdeadbeef" };
      },
    });
    await Promise.all([moveRevertedNotes(env), other.moveRevertedNotes(later)]);
    await reconcileClaims(env);
  } finally {
    delete (globalThis.navigator as { locks?: unknown }).locks;
  }
  assert.equal(note(source.id).status, "recovered");
  assert.equal(moves(source).filter((n) => n.status !== "recovered").length, 1);
  assert.equal(moves(source).filter((n) => n.sweepPending).length, 0);
  assert.equal(countedIds(source).length, 1);
  assert.equal(total(source), 20_000_000n);
});

await test("the mark survives a backup: restored elsewhere, the note still moves", async () => {
  const pool = mockVault();
  const env = pool.env();
  const { source, out, refund } = await swap(pool, 20_000_000n);
  const backup = JSON.stringify(await exportNotesBackup(ME));
  const gone = new Set([source.id, out.id, refund.id]);
  await setAllNotes(getAllNotes().filter((n) => !gone.has(n.id)));
  const res = await importNotesBackup(backup, ME, backupSpentCheck(env));
  assert.ok(res.ok);
  // restored under new ids of their own, found by commitment; the refund still names its source
  const back = (n: LocalNote) => getAllNotes().find((m) => m.commitment.toLowerCase() === n.commitment.toLowerCase())!;
  const [src, ref] = [back(source), back(refund)];
  assert.ok(src.id !== source.id && ref.id !== refund.id);
  assert.ok(src.swapProofAt);
  assert.equal(ref.vaultSwap?.sent?.hash !== undefined, true);
  assert.equal(ref.sweptFrom?.id, src.id, "the refund names the restored source");
  passLock();
  await moveRevertedNotes(env);
  assert.equal(back(source).status, "recovered");
  assert.equal(total(src), 20_000_000n);
});

await test("a marked note of another network is left for that network", async () => {
  const pool = mockVault();
  const { source } = await swap(pool, 20_000_000n);
  passLock();
  await moveRevertedNotes(pool.env({ chainId: 1 }));
  assert.equal(pool.state.proofs, 0);
  assert.equal(note(source.id).status, "open");
  assert.ok(note(source.id).swapProofAt);
  // the app's own env keeps to the network it is given, whichever one the page shows
  const base = getNetwork("base");
  assert.notEqual(base.chainId, net.chainId);
  assert.equal(appClaimEnv(undefined, base).chainId, base.chainId);
  assert.equal(appClaimEnv().chainId, net.chainId);
});

await test("a cash out waiting with the relay keeps its note: it spends it anyway", async () => {
  const pool = mockVault();
  const { source } = await swap(pool, 20_000_000n);
  passLock();
  const list = getAllNotes().map((n) =>
    n.id === source.id ? { ...n, cashOut: { job: "j", at: Date.now(), to: ME, state: "scheduled" as const } } : n
  );
  await setAllNotes(list);
  await moveRevertedNotes(pool.env());
  assert.equal(pool.state.proofs, 0);
  assert.equal(note(source.id).status, "open");
});

await test("a marked note can't be swapped or cashed out until the relay takes it, and then moves first", async () => {
  const pool = mockVault();
  const { source } = await swap(pool, 20_000_000n);
  const marked = note(source.id);
  const amount = BigInt(marked.amountWei);
  assert.match(spendWaitMessage(marked)!, /Try again in a minute/);
  assert.match(spendWaitMessage({ swapProofAt: Date.now() - RELAY_SPEND_LOCK_MS + 30_000 })!, /Try again in a minute/);
  assert.throws(() => checkPlan(marked, [amount / 2n, amount / 2n], [ME, ME]), /moving to a fresh private balance/);
  passLock();
  assert.equal(spendWaitMessage(marked), null);
  assert.doesNotThrow(() => checkPlan(marked, [amount / 2n, amount / 2n], [ME, ME]));
  assert.equal(spendPlanFor(marked, amount), "move", "the whole note moves first");
  assert.equal(spendPlanFor(marked, amount - 1n), "split", "a part spends it through a transfer too");
});

await test("the balance by asset never holds a swap's pending notes or a held refund", async () => {
  const pool = mockVault();
  const { source } = await swap(pool, 20_000_000n);
  assert.equal(sumByAsset(getAllNotes()).get(lc(ASSET)), 20_000_000n);
  pool.replay(source);
  const env = pool.env({ finishRefund: async () => false });
  await moveRevertedNotes(env);
  passLock();
  await moveRevertedNotes(env);
  await reconcileClaims(env);
  await tick();
  assert.equal(sumByAsset(getAllNotes()).get(lc(ASSET)) ?? 0n, 0n);
});

await test("the wait follows the relay's lock", async () => {
  assert.equal(RELAY_SPEND_LOCK_MS, INFLIGHT_TTL_SEC * 1000, "lib/relay/inflight changed: change lib/shield too");
  for (const s of [SWAP_REVERTED, SWAP_SPENT, spendWaitMessage({ swapProofAt: Date.now() })!]) assert.equal(s.includes("—"), false);
});

// The note store's writes land on disk encrypted, never as plaintext.
await new Promise((r) => setTimeout(r, 50));
const stored = localStorage.getItem("gloam.shield.notes.v1") ?? "";
assert.ok(stored.startsWith("gloamenc1:"), "notes stored encrypted");

console.log(`\n${passed} swap-revert checks passed`);
