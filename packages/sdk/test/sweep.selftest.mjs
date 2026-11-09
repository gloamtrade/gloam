/**
 * Payee sweep self-test: an x402 payment is final only after the payee moves
 * the received note into a fresh note only it knows.
 *
 * Runs against an in-memory pool that enforces what ShieldPoolPoseidon.transfer
 * enforces (known root, nullifier spent once, fresh commitments, insert both
 * outputs), with a mocked submitter. Covers the happy path, a payer who spends
 * the note back first, a payer who front-runs the sweep, a payment that never
 * landed, a replayed header, relay failures, and a sweep that landed while its
 * receipt was lost. When the transfer artifacts are present it also proves the
 * zero-change sweep with snarkjs and verifies it against the transfer vkey.
 *
 * Run after build:  node test/sweep.selftest.mjs
 */
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  IncrementalMerkleTreePoseidon,
  noteCommitmentPoseidon,
  noteNullifierPoseidon,
  fieldToHex,
  hexToField,
  generateReceiveKey,
  buildGloamPaymentRequirements,
  buildGloamPayment,
  buildPrivateSendIntent,
  verifyGloamPayment,
  openGloamPaymentNote,
  settleGloamPayment,
  sweepReceivedNote,
  GloamRelayError,
  relaySubmitter,
  packGroth16Proof,
  transferCallArgs,
  GLOAM_NOT_FINAL,
  SEALED_VAULT,
  FIELD_PRIME,
  encodeNotePackage,
  sealToReceiveTag,
  encodePaymentHeader,
  decodePaymentHeader,
  checkGloamPaymentBinding,
  gloamPaymentBinding,
  receiptInsertsCommitment,
} from "../dist/index.js";
import { keccak256, toBytes } from "viem";

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  checks++;
}

const STABLE = "0x00000000000000000000000000000000000000ee";
const NETWORK = 46630;
const stubProve = async () => ({ proofBytes: "0xdeadbeef" });

/** A pool that follows the contract's transfer rules (proofs are not checked here). */
function mockPool() {
  const tree = new IncrementalMerkleTreePoseidon();
  const index = new Map();
  const roots = new Set();
  const spent = new Set();
  const receipts = new Map();
  let n = 0;
  const lc = (h) => h.toLowerCase();
  const insert = async (c) => {
    index.set(lc(c), await tree.insert(hexToField(c)));
    roots.add(fieldToHex(tree.currentRoot));
  };
  return {
    insert,
    spent,
    /** Apply transfer(proof, root, nullifier, [c0, c1]); returns a tx hash, receipt "reverted" on any rule break. */
    async transfer(args) {
      const [, root, nullifier, outs] = args;
      const hash = `0x${(++n).toString(16).padStart(64, "0")}`;
      const ok = roots.has(lc(root)) && !spent.has(lc(nullifier)) && outs.every((c) => !index.has(lc(c)));
      if (ok) {
        spent.add(lc(nullifier));
        for (const c of outs) await insert(c);
      }
      receipts.set(hash, ok ? "success" : "reverted");
      return hash;
    },
    chain: {
      isSpent: async (nf) => spent.has(lc(nf)),
      isCommitmentSeen: async (c) => index.has(lc(c)),
      pathForCommitment: async (c) => (index.has(lc(c)) ? tree.path(index.get(lc(c))) : null),
      waitForReceipt: async (hash) => ({ status: receipts.get(hash) ?? "reverted" }),
    },
  };
}

/** A payer note in the pool, a sealed payment to `payee`, broadcast into the pool. */
async function paidPool(payee, { broadcast = true, secret = 4242n, noteAmount = 1000n, price = 400n } = {}) {
  const pool = mockPool();
  await pool.insert(fieldToHex(await noteCommitmentPoseidon(7n, 5n, STABLE))); // a decoy leaf
  const c = fieldToHex(await noteCommitmentPoseidon(secret, noteAmount, STABLE));
  await pool.insert(c);
  const req = buildGloamPaymentRequirements({ amountWei: price, asset: STABLE, assetSymbol: "USD", payTo: payee.tag, resource: "r", network: NETWORK });
  const built = await buildGloamPayment({
    requirements: req,
    senderSecretHex: fieldToHex(secret),
    senderNoteAmountWei: noteAmount,
    path: await pool.chain.pathForCommitment(c),
    prove: stubProve,
  });
  if (broadcast) {
    const hash = await pool.transfer(built.intent.exec.args);
    assert((await pool.chain.waitForReceipt(hash)).status === "success", "payer's transfer lands");
    built.payload.payload.txHash = hash;
  }
  return { pool, req, built };
}

const submitTo = (pool, log = []) => async (intent) => {
  log.push("submit");
  return pool.transfer(transferCallArgs(intent));
};

const payee = await generateReceiveKey();
const stranger = await generateReceiveKey();

// ── 1. happy path: open, verify, sweep, final ─────────────────────────────────
{
  const { pool, req, built } = await paidPool(payee);
  const verifyOnly = verifyGloamPayment({ requirements: req, payload: built.payload, note: await openGloamPaymentNote(built.payload.payload.paymentNote, payee) });
  assert(verifyOnly.ok && verifyOnly.final === false && verifyOnly.finality === GLOAM_NOT_FINAL, "verify without a sweep is ok but not final");

  const order = [];
  const r = await settleGloamPayment({
    requirements: req,
    payload: built.payload,
    receiveKey: payee,
    prove: stubProve,
    chain: pool.chain,
    submit: submitTo(pool, order),
    beforeSubmit: (fresh) => order.push(`stored ${fresh.commitment}`),
  });
  assert(r.grantAccess === true && r.final === true && r.status === "swept", `settle grants access after the sweep (${r.reason})`);
  assert(order[0].startsWith("stored ") && order[1] === "submit", "the fresh note is handed over for storage before the sweep is submitted");
  assert(r.freshNote && r.freshNote.amountWei === "400", "fresh note carries the whole payment");
  assert(r.freshNote.secret !== built.paymentNote.secret, "fresh note has a new secret the payer never saw");
  assert(await pool.chain.isCommitmentSeen(r.freshNote.commitment), "fresh note is in the pool");
  const payNullifier = fieldToHex(await noteNullifierPoseidon(hexToField(built.paymentNote.secret), hexToField(built.paymentNote.commitment)));
  assert(await pool.chain.isSpent(payNullifier), "the received note is now spent by the payee");
  assert(r.sweep.hash && r.verify.ok, "result carries the sweep hash and the verify");

  // The payer tries to spend the payment back after being served: the pool refuses.
  const back = await buildPrivateSendIntent({
    secretHex: built.paymentNote.secret, amountInWei: 400n, amountPayWei: 400n, asset: STABLE,
    path: await pool.chain.pathForCommitment(built.paymentNote.commitment), prove: stubProve, poolAddress: SEALED_VAULT, chainId: NETWORK,
  });
  const h = await pool.transfer(back.exec.args);
  assert((await pool.chain.waitForReceipt(h)).status === "reverted", "after the sweep the payer cannot spend the payment back");

  // Replaying the same X-PAYMENT header cannot buy a second access.
  const again = await settleGloamPayment({ requirements: req, payload: built.payload, receiveKey: payee, prove: stubProve, chain: pool.chain, submit: submitTo(pool) });
  assert(again.grantAccess === false && again.status === "already_spent", "a replayed header is refused");
}

// ── 2. payer spends the note back before the payee sweeps ─────────────────────
{
  const { pool, req, built } = await paidPool(payee);
  const back = await buildPrivateSendIntent({
    secretHex: built.paymentNote.secret, amountInWei: 400n, amountPayWei: 400n, asset: STABLE,
    path: await pool.chain.pathForCommitment(built.paymentNote.commitment), prove: stubProve, poolAddress: SEALED_VAULT, chainId: NETWORK,
  });
  await pool.transfer(back.exec.args);
  const log = [];
  let stored = 0;
  const r = await settleGloamPayment({
    requirements: req, payload: built.payload, receiveKey: payee, prove: stubProve, chain: pool.chain,
    submit: submitTo(pool, log), beforeSubmit: () => stored++,
  });
  assert(r.grantAccess === false && r.status === "already_spent", "refused: the nullifier is already spent");
  assert(/do not grant access/.test(r.reason), "the reason says not to grant access");
  assert(log.length === 0 && stored === 0, "nothing proved, stored or submitted");
  assert(r.freshNote === null, "no fresh note");
}

// ── 3. payer front-runs the sweep (spends it between check and submit) ────────
{
  const { pool, req, built } = await paidPool(payee);
  const frontRun = async (intent) => {
    const back = await buildPrivateSendIntent({
      secretHex: built.paymentNote.secret, amountInWei: 400n, amountPayWei: 400n, asset: STABLE,
      path: await pool.chain.pathForCommitment(built.paymentNote.commitment), prove: stubProve, poolAddress: SEALED_VAULT, chainId: NETWORK,
    });
    await pool.transfer(back.exec.args);
    return pool.transfer(transferCallArgs(intent));
  };
  const r = await settleGloamPayment({ requirements: req, payload: built.payload, receiveKey: payee, prove: stubProve, chain: pool.chain, submit: frontRun });
  assert(r.grantAccess === false && r.status === "already_spent", "a sweep that loses the race is refused");
  assert(r.sweep.hash !== null, "the reverted sweep's hash is reported");
}

// ── 3b. a smart-account bundle succeeds while the sweep inside it reverts (GHSA-p2wm-6x89-63c2) ──
{
  const { pool, req, built } = await paidPool(payee);
  let bundles = 0;
  const viaBundle = async (intent) => {
    // the payer spends the note back first, so the inner pool.transfer reverts...
    const back = await buildPrivateSendIntent({
      secretHex: built.paymentNote.secret, amountInWei: 400n, amountPayWei: 400n, asset: STABLE,
      path: await pool.chain.pathForCommitment(built.paymentNote.commitment), prove: stubProve, poolAddress: SEALED_VAULT, chainId: NETWORK,
    });
    await pool.transfer(back.exec.args);
    const inner = await pool.transfer(transferCallArgs(intent));
    assert((await pool.chain.waitForReceipt(inner)).status === "reverted", "the inner sweep transfer reverts");
    // ...while the bundle (the outer transaction) succeeds
    const outer = `0x${"b".repeat(60)}${(++bundles).toString(16).padStart(4, "0")}`;
    return outer;
  };
  const chain = { ...pool.chain, waitForReceipt: async (h) => (h.startsWith("0xbbbb") ? { status: "success" } : pool.chain.waitForReceipt(h)) };
  const r = await settleGloamPayment({ requirements: req, payload: built.payload, receiveKey: payee, prove: stubProve, chain, submit: viaBundle });
  assert(r.grantAccess === false && r.final === false, `a successful outer transaction whose sweep did not land grants nothing (${r.status})`);
  assert(r.status !== "swept", "and is never reported swept");

  // A bundle whose sweep did land is swept as before.
  const ok = await paidPool(payee);
  const landing = async (intent) => {
    await ok.pool.transfer(transferCallArgs(intent));
    return `0x${"b".repeat(60)}${(++bundles).toString(16).padStart(4, "0")}`;
  };
  const okChain = { ...ok.pool.chain, waitForReceipt: async () => ({ status: "success" }) };
  const r2 = await settleGloamPayment({ requirements: ok.req, payload: ok.built.payload, receiveKey: payee, prove: stubProve, chain: okChain, submit: landing });
  assert(r2.grantAccess === true && r2.status === "swept", "a bundle whose sweep landed settles");

  // A reader that can't say whether the fresh note is in the pool is not taken as a landed sweep.
  const blind = await paidPool(payee);
  const blindChain = {
    ...blind.pool.chain,
    isCommitmentSeen: async () => { throw new Error("rpc down"); },
  };
  const r3 = await settleGloamPayment({ requirements: blind.req, payload: blind.built.payload, receiveKey: payee, prove: stubProve, chain: blindChain, submit: submitTo(blind.pool) });
  assert(r3.grantAccess === false && r3.status === "unconfirmed" && r3.freshNote, "an unreadable fresh note is unconfirmed, and the fresh note is kept");
}

// ── 3c. the sweep's receipt logs: the pool's own Transferred event for the fresh note is final ──
{
  const TOPIC = keccak256(toBytes("Transferred(bytes32,bytes32[2])"));
  const withLogs = (pool, address) => ({
    ...pool.chain,
    // the pool can't be read at all: only the receipt can make the sweep final
    isCommitmentSeen: async () => { throw new Error("rpc down"); },
    waitForReceipt: async (h) => {
      const r = await pool.chain.waitForReceipt(h);
      const outs = pool.lastOuts;
      return r.status === "success"
        ? { ...r, logs: [{ address, topics: [TOPIC, "0x" + "11".repeat(32)], data: "0x" + outs[0].slice(2) + outs[1].slice(2) }] }
        : { ...r, logs: [] };
    },
  });
  const tap = (pool) => {
    const transfer = pool.transfer;
    pool.transfer = async (args) => {
      pool.lastOuts = args[3];
      return transfer(args);
    };
    return pool;
  };

  const a = await paidPool(payee);
  tap(a.pool);
  const r = await settleGloamPayment({ requirements: a.req, payload: a.built.payload, receiveKey: payee, prove: stubProve, chain: withLogs(a.pool, SEALED_VAULT), submit: submitTo(a.pool) });
  assert(r.grantAccess === true && r.status === "swept", `the pool's Transferred event for the fresh note in the receipt settles (${r.status})`);
  assert(receiptInsertsCommitment([{ address: SEALED_VAULT, topics: [TOPIC], data: "0x" + r.freshNote.commitment.slice(2) + "00".repeat(32) }], SEALED_VAULT, r.freshNote.commitment), "receiptInsertsCommitment finds the payment output");

  // The same event from any other contract proves nothing.
  const b = await paidPool(payee);
  tap(b.pool);
  const r2 = await settleGloamPayment({ requirements: b.req, payload: b.built.payload, receiveKey: payee, prove: stubProve, chain: withLogs(b.pool, "0x000000000000000000000000000000000000dEaD"), submit: submitTo(b.pool) });
  assert(r2.grantAccess === false && r2.status === "unconfirmed", `an event from another address is not the pool's (${r2.status})`);
  // Nor does the change output, or a malformed log.
  assert(!receiptInsertsCommitment([{ address: SEALED_VAULT, topics: [TOPIC], data: "0x" + "00".repeat(32) + r2.freshNote.commitment.slice(2) }], SEALED_VAULT, r2.freshNote.commitment), "the change slot is not the payment output");
  assert(!receiptInsertsCommitment([{ address: SEALED_VAULT, topics: [TOPIC], data: "0x" + r2.freshNote.commitment.slice(2) }], SEALED_VAULT, r2.freshNote.commitment), "a short log is ignored");
  assert(!receiptInsertsCommitment([{ address: SEALED_VAULT, topics: ["0x" + "00".repeat(32)], data: "0x" + r2.freshNote.commitment.slice(2) + "00".repeat(32) }], SEALED_VAULT, r2.freshNote.commitment), "another event is ignored");
}

// ── 4. payment never landed ───────────────────────────────────────────────────
{
  const { pool, req, built } = await paidPool(payee, { broadcast: false });
  const r = await settleGloamPayment({ requirements: req, payload: built.payload, receiveKey: payee, prove: stubProve, chain: pool.chain, submit: submitTo(pool) });
  assert(r.grantAccess === false && r.status === "not_settled", "a payment that is not in the pool is not settled");
}

// ── 5. wrong key, wrong tag, lying note ───────────────────────────────────────
{
  const { pool, req, built } = await paidPool(payee);
  const wrongKey = await settleGloamPayment({ requirements: req, payload: built.payload, receiveKey: stranger.privateJwk, prove: stubProve, chain: pool.chain, submit: submitTo(pool) });
  assert(wrongKey.status === "rejected" && /different receive tag/.test(wrongKey.reason), "another key cannot settle the payment");
  const wrongTag = await settleGloamPayment({ requirements: req, payload: built.payload, receiveKey: stranger, prove: stubProve, chain: pool.chain, submit: submitTo(pool) });
  assert(wrongTag.status === "rejected" && /different receive tag/.test(wrongTag.reason), "a key for another tag is refused up front");

  const note = await openGloamPaymentNote(built.payload.payload.paymentNote, payee);
  const lying = await sweepReceivedNote({
    note: { ...note, amountWei: "4000" }, poolAddress: SEALED_VAULT, chainId: NETWORK, prove: stubProve, chain: pool.chain, submit: submitTo(pool),
  });
  assert(lying.status === "bad_note" && !lying.final, "a note whose amount does not bind is refused");
  // amount + p hashes to the same commitment, and the sweep proof would be valid (the
  // circuit sees the reduced amount), but the fresh note would claim amount + p.
  const sent = [];
  const alias = await sweepReceivedNote({
    note: { ...note, amountWei: (BigInt(note.amountWei) + FIELD_PRIME).toString() }, poolAddress: SEALED_VAULT, chainId: NETWORK, prove: stubProve, chain: pool.chain, submit: submitTo(pool, sent),
  });
  assert(alias.status === "bad_note" && !alias.final && alias.freshNote === null, "a note claiming amount + p is refused");
  assert(sent.length === 0, "nothing is submitted for it");
}

// ── 6. submit failures ────────────────────────────────────────────────────────
{
  const { pool, req, built } = await paidPool(payee);
  const note = await openGloamPaymentNote(built.payload.payload.paymentNote, payee);
  const base = { note, poolAddress: SEALED_VAULT, chainId: NETWORK, prove: stubProve, chain: pool.chain };

  const down = await sweepReceivedNote({ ...base, submit: async () => { throw new Error("relay is down"); } });
  assert(down.status === "failed" && down.final === false && /relay is down/.test(down.reason), "a submit that fails moves nothing and says why");
  assert(down.freshNote === null, "nothing to keep when nothing was sent");

  // The relay could not tell whether it sent it: it may still land, so the fresh note is kept.
  // the connection dropped after the relay took it: no answer is not a no
  const dropped = await sweepReceivedNote({ ...base, submit: relaySubmitter({ url: "http://relay.test", fetch: async () => { throw new TypeError("fetch failed"); } }) });
  assert(dropped.status === "unconfirmed" && dropped.freshNote, "a dropped connection to the relay keeps the fresh note");
  const unsure = await sweepReceivedNote({ ...base, submit: async () => { throw new GloamRelayError("maybe sent", "maybe_sent"); } });
  assert(unsure.status === "unconfirmed" && unsure.final === false && unsure.freshNote, "a relay maybe_sent is unconfirmed and keeps the fresh note, never 'nothing moved'");
  // The relay refused it before sending: nothing moved.
  const refused = await sweepReceivedNote({ ...base, submit: async () => { throw new GloamRelayError("slow down", "rate_limited"); } });
  assert(refused.status === "failed" && refused.freshNote === null, "a relay refusal before sending moves nothing");

  // Sent and landed, but the receipt was lost: the chain says it landed.
  const lost = await sweepReceivedNote({
    ...base,
    chain: { ...pool.chain, waitForReceipt: async () => { throw new Error("timeout"); } },
    submit: submitTo(pool),
  });
  assert(lost.status === "swept" && lost.final === true, "a sweep that landed counts even if its receipt was lost");

  // Sent, not landed, not spent: unknown, keep the fresh note.
  const { pool: pool2, built: built2 } = await paidPool(payee);
  const note2 = await openGloamPaymentNote(built2.payload.payload.paymentNote, payee);
  const pending = await sweepReceivedNote({
    note: note2, poolAddress: SEALED_VAULT, chainId: NETWORK, prove: stubProve,
    chain: { ...pool2.chain, waitForReceipt: async () => { throw new Error("timeout"); } },
    submit: async () => "0x" + "ab".repeat(32),
  });
  assert(pending.status === "unconfirmed" && pending.final === false && pending.freshNote, "an unknown outcome is unconfirmed and keeps the fresh note");
  void req;
}

// ── 6b. a wallet send whose reply was lost (the node took it) ─────────────────
{
  const { pool, built } = await paidPool(payee);
  const note = await openGloamPaymentNote(built.payload.payload.paymentNote, payee);
  let held = null;
  const lostHash = "0x" + "cd".repeat(32);
  const r = await sweepReceivedNote({
    note, poolAddress: SEALED_VAULT, chainId: NETWORK, prove: stubProve, chain: pool.chain,
    submit: async (intent) => {
      held = transferCallArgs(intent); // in the mempool, not mined yet
      throw Object.assign(new Error("HTTP request failed. Status: 504"), { maybeSent: true, hash: lostHash });
    },
  });
  assert(r.status === "unconfirmed" && r.freshNote && r.hash === lostHash, "a submitter error marked maybeSent keeps the fresh note and reports its hash");
  await pool.transfer(held);
  assert(await pool.chain.isCommitmentSeen(r.freshNote.commitment), "and the kept note is the money once it lands");
}

// ── 6c. the sweep lands between the reads that follow a lost receipt ──────────
{
  const { pool, built } = await paidPool(payee);
  const note = await openGloamPaymentNote(built.payload.payload.paymentNote, payee);
  let inFlight = null;
  /** Each read answers from the chain as it is, then the sweep in flight is mined. */
  const landsAfterRead = (read) => async (x) => {
    const v = await read(x);
    if (inFlight) {
      const args = inFlight;
      inFlight = null;
      await pool.transfer(args);
    }
    return v;
  };
  const r = await sweepReceivedNote({
    note, poolAddress: SEALED_VAULT, chainId: NETWORK, prove: stubProve,
    chain: {
      ...pool.chain,
      isSpent: landsAfterRead(pool.chain.isSpent),
      isCommitmentSeen: landsAfterRead(pool.chain.isCommitmentSeen),
      waitForReceipt: async () => { throw new Error("HTTP request failed. Status: 429"); },
    },
    submit: async (intent) => {
      inFlight = transferCallArgs(intent);
      return "0x" + "ef".repeat(32);
    },
  });
  assert(r.status === "swept" && r.final === true && r.freshNote, `a sweep that lands between the two reads is the payee's (got ${r.status})`);
}

// ── 6d. reads from nodes at different heights: spent, fresh note not seen yet ─
{
  const { pool, built } = await paidPool(payee);
  const note = await openGloamPaymentNote(built.payload.payload.paymentNote, payee);
  const r = await sweepReceivedNote({
    note, poolAddress: SEALED_VAULT, chainId: NETWORK, prove: stubProve,
    chain: {
      ...pool.chain,
      waitForReceipt: async () => { throw new Error("timeout"); },
    },
    submit: async (intent) => {
      await pool.transfer(transferCallArgs(intent));
      return "0x" + "12".repeat(32);
    },
  });
  assert(r.status === "swept", "baseline: a landed sweep with a lost receipt is swept");
  const { pool: lagging, built: b2 } = await paidPool(payee);
  const n2 = await openGloamPaymentNote(b2.payload.payload.paymentNote, payee);
  let sentSweep = false;
  const r2 = await sweepReceivedNote({
    note: n2, poolAddress: SEALED_VAULT, chainId: NETWORK, prove: stubProve,
    chain: {
      ...lagging.chain,
      isSpent: async () => sentSweep, // after the send, a node that has the sweep's block
      isCommitmentSeen: async () => false, // and a node one block behind
      waitForReceipt: async () => { throw new Error("timeout"); },
    },
    submit: async () => ((sentSweep = true), "0x" + "34".repeat(32)),
  });
  assert(r2.status === "unconfirmed" && r2.freshNote, "a sent sweep is not given up on from one lagging read: the fresh note is kept");
}

// ── 6e. a sealed ticket from the payment board is not an x402 payment ────────
// A payment to the payee's receive tag made outside x402 (the app's Pay, or
// buildPrivatePaymentWithReceipt) posts its sealed ticket on the public payment
// board (GloamPayMemo). Anyone can copy that ticket into an X-PAYMENT header. It
// opens with the payee's key and names a real, unspent note, so without a binding
// only the payer and the payee can make, a seller would serve a stranger with it.
{
  const pool = mockPool();
  const secret = 9191n;
  const amount = 400n;
  const c = fieldToHex(await noteCommitmentPoseidon(secret, amount, STABLE));
  await pool.insert(c); // landed: a real leaf, unspent
  const req = buildGloamPaymentRequirements({ amountWei: amount, asset: STABLE, assetSymbol: "USD", payTo: payee.tag, resource: "r", network: NETWORK });
  // exactly what the board carries: the gloam1. package sealed to the payee's tag
  const boardTicket = await sealToReceiveTag(
    encodeNotePackage({ pool: req.poolAddress, asset: STABLE, amountWei: amount.toString(), secret: fieldToHex(secret), commitment: c, chainId: NETWORK, note: "order 1042" }),
    payee.tag
  );
  // a stranger wraps it in an x402 payload of their own
  const lifted = { x402Version: 1, scheme: req.scheme, network: NETWORK, payload: { paymentNote: boardTicket, txHash: null, exec: { fn: "transfer", poolAddress: req.poolAddress } } };
  const opened = await openGloamPaymentNote(boardTicket, payee);
  assert(verifyGloamPayment({ requirements: req, payload: lifted, note: opened }).ok, "the structural verify alone cannot tell a board ticket from a payment");
  const log = [];
  const r = await settleGloamPayment({ requirements: req, payload: lifted, receiveKey: payee, prove: stubProve, chain: pool.chain, submit: submitTo(pool, log) });
  assert(r.grantAccess === false && r.status === "rejected", `a board ticket wrapped as x402 is refused (${r.status}: ${r.reason})`);
  assert(/binding/i.test(r.reason ?? ""), "the reason names the missing binding");
  assert(log.length === 0, "nothing was swept");
  // a made-up binding is refused too
  const forged = { ...lifted, payload: { ...lifted.payload, binding: "A".repeat(43) } };
  const f = await settleGloamPayment({ requirements: req, payload: forged, receiveKey: payee, prove: stubProve, chain: pool.chain, submit: submitTo(pool, log) });
  assert(f.grantAccess === false && f.status === "rejected", "a binding not made with the note's secret is refused");
  assert(log.length === 0, "still nothing swept");
}

// ── 6f. a real x402 payment carries its binding and settles ───────────────────
{
  const { pool, req, built } = await paidPool(payee);
  assert(typeof built.payload.payload.binding === "string" && built.payload.payload.binding.length === 43, "buildGloamPayment binds the payment to its payee");
  const roundTrip = decodePaymentHeader(encodePaymentHeader(built.payload));
  assert(roundTrip.payload.binding === built.payload.payload.binding, "the binding survives the X-PAYMENT header");
  const note = await openGloamPaymentNote(built.payload.payload.paymentNote, payee);
  assert((await checkGloamPaymentBinding({ requirements: req, payload: built.payload, note })) === null, "the binding checks out");
  // bound to the payee's tag, pool, chain and the note: another tag's requirements don't match
  const other = { ...req, payTo: stranger.tag };
  assert((await checkGloamPaymentBinding({ requirements: other, payload: built.payload, note })) !== null, "a binding for one payee does not pass for another");
  assert(
    (await gloamPaymentBinding({ secret: note.secret, network: req.network, poolAddress: req.poolAddress, payTo: req.payTo, commitment: note.commitment })) === built.payload.payload.binding,
    "gloamPaymentBinding recomputes it"
  );
  const r = await settleGloamPayment({ requirements: req, payload: roundTrip, receiveKey: payee, prove: stubProve, chain: pool.chain, submit: submitTo(pool) });
  assert(r.grantAccess === true && r.status === "swept", `a bound payment settles (${r.reason})`);
}

// ── 6g. an older payer's unbound payment settles only when the seller allows it ─
{
  const { pool, req, built } = await paidPool(payee);
  const unbound = { ...built.payload, payload: { ...built.payload.payload } };
  delete unbound.payload.binding;
  const no = await settleGloamPayment({ requirements: req, payload: unbound, receiveKey: payee, prove: stubProve, chain: pool.chain, submit: submitTo(pool) });
  assert(no.grantAccess === false && no.status === "rejected", "unbound: refused by default");
  const yes = await settleGloamPayment({ requirements: req, payload: unbound, receiveKey: payee, prove: stubProve, chain: pool.chain, submit: submitTo(pool), allowUnbound: true });
  assert(yes.grantAccess === true, `unbound: settles with allowUnbound (${yes.reason})`);
  // a wrong binding is never let through, allowUnbound or not
  const { pool: pool2, req: req2, built: built2 } = await paidPool(payee);
  const wrong = { ...built2.payload, payload: { ...built2.payload.payload, binding: "B".repeat(43) } };
  const w = await settleGloamPayment({ requirements: req2, payload: wrong, receiveKey: payee, prove: stubProve, chain: pool2.chain, submit: submitTo(pool2), allowUnbound: true });
  assert(w.grantAccess === false && w.status === "rejected", "a wrong binding is refused even with allowUnbound");
}

// ── 7. the zero-change sweep is a valid transfer proof ────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const circuits = join(here, "../../../app/public/circuits");
const vkeyPath = join(here, "../../../contracts/circuits/build/transfer_v2/transfer_vkey.json");
let proved = 0;
if (existsSync(join(circuits, "transfer_final.zkey")) && existsSync(vkeyPath)) {
  const snarkjs = await import("snarkjs");
  const vkey = JSON.parse(readFileSync(vkeyPath, "utf8"));
  const { pool, req, built } = await paidPool(payee);
  let signals = null;
  const realProve = async (input) => {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, join(circuits, "transfer.wasm"), join(circuits, "transfer_final.zkey"));
    assert(await snarkjs.groth16.verify(vkey, publicSignals, proof), "sweep proof verifies against the transfer vkey");
    signals = publicSignals;
    proved++;
    return { proofBytes: packGroth16Proof(proof), publicSignals };
  };
  const r = await settleGloamPayment({ requirements: req, payload: built.payload, receiveKey: payee, prove: realProve, chain: pool.chain, submit: submitTo(pool) });
  assert(r.final === true, "settles with a real proof");
  assert(BigInt(signals[2]) === hexToField(r.freshNote.commitment), "proof's first output is the fresh payee note");
  const payNullifier = await noteNullifierPoseidon(hexToField(built.paymentNote.secret), hexToField(built.paymentNote.commitment));
  assert(BigInt(signals[1]) === payNullifier, "proof spends the received payment note");
  globalThis.curve_bn128?.terminate?.();
}

console.log(`sweep.selftest: ok (${checks} assertions${proved ? `, ${proved} real sweep proof verified` : ", transfer artifacts absent: proving skipped"})`);
process.exit(0);
