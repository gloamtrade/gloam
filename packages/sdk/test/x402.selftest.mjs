/**
 * x402 private-payment self-test.
 *
 * Drives the full agent-payment rail locally, offline, with a stub prover and an
 * in-memory tree: a server prices a resource (402 requirements), an agent builds
 * a private payment of the required amount to the payee, and the server verifies
 * the payment binds the required amount + asset and settles through the right
 * pool. The payment note travels sealed to the payee's receive tag, so the
 * server opens it with its receive key before verifying. Also checks the
 * issuer-scoped compliance disclosure shape and the explicit Gloam-vs-Zone
 * posture. No chain, no broadcast.
 *
 * Run after build:  node test/x402.selftest.mjs
 */
import {
  IncrementalMerkleTreePoseidon,
  noteCommitmentPoseidon,
  fieldToHex,
  buildGloamPaymentRequirements,
  buildGloamPayment,
  verifyGloamPayment,
  buildComplianceDisclosure,
  isComplianceDisclosureShape,
  verifyPaymentNoteBinding,
  decodePaymentHeader,
  openGloamPaymentNote,
  generateReceiveKey,
  GLOAM_NOT_FINAL,
  encodeRequirements,
  decodeRequirements,
  GLOAM_X402_SCHEME,
  GLOAM_VS_ZONE,
  SEALED_VAULT,
  FIELD_PRIME,
} from "../dist/index.js";

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  checks++;
}

// A simple non-native testnet stable asset (non-freezing) for the rails proof.
const STABLE = "0x00000000000000000000000000000000000000ee";
const SECRET = 42424242424242424242n;
const NOTE_AMOUNT = 1_000_000_000_000_000n; // 0.001 in base units
const PRICE = 250_000_000_000_000n; // required by the resource
const NETWORK = 46630;
const STUB_PROOF = "0xdeadbeef";
const prove = async () => ({ proofBytes: STUB_PROOF });

// Fixture pool tree: the agent's note as leaf 0, two decoys.
const tree = new IncrementalMerkleTreePoseidon();
const leaf = await noteCommitmentPoseidon(SECRET, NOTE_AMOUNT, STABLE);
await tree.insert(leaf);
await tree.insert(await noteCommitmentPoseidon(111n, 5n, STABLE));
await tree.insert(await noteCommitmentPoseidon(222n, 7n, STABLE));
const path = await tree.path(0);
const senderSecretHex = fieldToHex(SECRET);
const payee = await generateReceiveKey();

// ── server: price the resource ────────────────────────────────────────────────
const req = buildGloamPaymentRequirements({
  amountWei: PRICE,
  asset: STABLE,
  assetSymbol: "USD",
  payTo: payee.tag,
  resource: "mcp://gloam/tool/summarize",
  description: "Private payment for one summarize call",
  network: NETWORK,
});
assert(req.scheme === GLOAM_X402_SCHEME, "requirements scheme");
assert(req.maxAmountRequired === PRICE.toString(), "requirements amount");
assert(req.poolAddress === SEALED_VAULT, "requirements default pool");
assert(req.privacy.oneLine.includes("not an operator-visible Zone"), "requirements carry Gloam-vs-Zone");
// requirements survive a base64 transport round-trip
assert(decodeRequirements(encodeRequirements(req)).maxAmountRequired === PRICE.toString(), "requirements encode/decode");

// ── agent: build the private payment ──────────────────────────────────────────
const built = await buildGloamPayment({
  requirements: req,
  senderSecretHex,
  senderNoteAmountWei: NOTE_AMOUNT,
  path,
  prove,
  issuerTag: "issuer:testusd",
});
assert(built.payload.scheme === GLOAM_X402_SCHEME, "payload scheme");
assert(built.payload.network === NETWORK, "payload network");
assert(built.payload.payload.exec.fn === "transfer", "payload settles via transfer");
assert(built.payload.payload.exec.poolAddress === SEALED_VAULT, "payload pool");
assert(built.payload.payload.txHash === null, "payload txHash unset before broadcast");
assert(built.changeNote && BigInt(built.changeNote.amountWei) === NOTE_AMOUNT - PRICE, "change note = note - price");

assert(built.sealed === true && built.payload.payload.paymentNote.startsWith("gloam2t."), "payment note is sealed to payTo");
const payNote = await openGloamPaymentNote(built.payload.payload.paymentNote, payee);
assert(payNote.secret === built.paymentNote.secret, "payee's receive key opens the sealed note");
assert(BigInt(payNote.amountWei) === PRICE, "payment note carries the required amount");
assert(payNote.asset.toLowerCase() === STABLE.toLowerCase(), "payment note asset = stable");
assert(payNote.chainId === req.network, "the sealed note names the chain the payment is on");

// X-PAYMENT header round-trips
const roundTrip = decodePaymentHeader(built.header);
assert(roundTrip.payload.paymentNote === built.payload.payload.paymentNote, "header encode/decode");

// ── server: verify the payment ────────────────────────────────────────────────
// A sealed note cannot be read without the payee's key.
const vSealed = verifyGloamPayment({ requirements: req, payload: built.payload });
assert(vSealed.ok === false && /sealed/.test(vSealed.reason), "verify asks for the opened note when the note is sealed");
const v = verifyGloamPayment({ requirements: req, payload: built.payload, note: payNote });
assert(v.ok === true, `verify ok (got: ${v.reason})`);
// the same note claimed for a charge on another chain (the vault and assets can share an address)
const vOtherChain = verifyGloamPayment({ requirements: req, payload: built.payload, note: { ...payNote, chainId: req.network + 1 } });
assert(vOtherChain.ok === false && /another chain/.test(vOtherChain.reason), "verify refuses a note that names another chain");
assert(v.sealed === true, "verify reports the note arrived sealed");
assert(v.final === false && v.finality === GLOAM_NOT_FINAL, "verify without a sweep says plainly it is not final");
assert(/spend the money back/.test(v.finality) && /settleGloamPayment/.test(v.finality), "not-final notice names the risk and the fix");
assert(v.amountWei === PRICE.toString(), "verify surfaces amount");
assert(v.commitment === payNote.commitment, "verify surfaces the commitment to check on-chain");
assert(v.onchainChecksRequired.length === 6, "verify lists 6 checks");
assert(v.onchainChecksRequired.some((c) => c.includes("checkGloamPaymentBinding")), "verify lists the payment binding check");
assert(v.onchainChecksRequired.some((c) => /sweep/i.test(c)), "verify lists the sweep as a required step");
assert(v.onchainChecksRequired.some((c) => /binding/i.test(c)), "verify flags the note-binding check");
assert(v.onchainChecksRequired.some((c) => c.includes("not yet attached")), "verify flags missing settlement tx");

// the payment note binds its claimed amount to its commitment
assert((await verifyPaymentNoteBinding(payNote)) === true, "honest payment note binds amount to commitment");
// a payer who lies about the amount (claims more than the commitment was minted for) fails the binding check
const lyingNote = { ...payNote, amountWei: (PRICE * 4n).toString() };
assert((await verifyPaymentNoteBinding(lyingNote)) === false, "lied-up payment note fails the binding check");
// Poseidon reads its inputs mod p: a note claiming amount + p (or secret + p) has the
// same commitment as the honest one, so only canonical fields may bind.
const aliasAmount = { ...payNote, amountWei: (PRICE + FIELD_PRIME).toString() };
assert(fieldToHex(await noteCommitmentPoseidon(BigInt(payNote.secret), PRICE + FIELD_PRIME, STABLE)) === payNote.commitment, "amount + p hashes to the same commitment");
assert((await verifyPaymentNoteBinding(aliasAmount)) === false, "a note claiming amount + p does not bind");
const vAlias = verifyGloamPayment({ requirements: req, payload: built.payload, note: aliasAmount });
assert(vAlias.ok === false && /canonical/.test(vAlias.reason), "verify refuses a note claiming amount + p");
const aliasSecret = { ...payNote, secret: fieldToHex(BigInt(payNote.secret) + FIELD_PRIME) };
assert((await verifyPaymentNoteBinding(aliasSecret)) === false, "a note with secret + p does not bind");
const aliasAsset = { ...payNote, asset: fieldToHex(BigInt(STABLE) + FIELD_PRIME) };
assert((await verifyPaymentNoteBinding(aliasAsset)) === false, "a note with asset + p does not bind");
const zeroNote = { ...payNote, amountWei: "0", commitment: fieldToHex(await noteCommitmentPoseidon(BigInt(payNote.secret), 0n, STABLE)) };
assert((await verifyPaymentNoteBinding(zeroNote)) === false, "a zero-value note does not count as a payment");

// after the agent broadcasts, it attaches the tx hash
built.payload.payload.txHash = "0xabc123";
const v2 = verifyGloamPayment({ requirements: req, payload: built.payload, note: payNote });
assert(v2.ok === true, "verify ok with tx hash");
assert(v2.onchainChecksRequired.some((c) => c.includes("0xabc123")), "verify references the settlement tx");

// ── compliance disclosure (issuer-scoped) ─────────────────────────────────────
assert(built.payload.payload.disclosure, "disclosure attached when issuerTag given");
assert(built.payload.payload.disclosure.stub === true, "disclosure is a stub without a proof");
assert(isComplianceDisclosureShape(built.payload.payload.disclosure), "disclosure shape valid");
assert(built.payload.payload.disclosure.commitment === payNote.commitment, "disclosure binds the payment note");
const injected = await buildComplianceDisclosure({ issuerTag: "issuer:testusd", note: payNote, proof: { pi_a: [] } });
assert(injected.stub === false, "injecting a proof leaves stub mode");
// generating via a shield prover produces a real (non-stub) disclosure carrying the proof
const proven = await buildComplianceDisclosure({ issuerTag: "issuer:testusd", note: payNote, prove: async () => ({ proofBytes: "0xfeed" }) });
assert(proven.stub === false && proven.proof === "0xfeed", "prover-generated disclosure is real");
// a payment built with a disclosureProver carries a real disclosure
const builtProven = await buildGloamPayment({
  requirements: req, senderSecretHex, senderNoteAmountWei: NOTE_AMOUNT, path, prove,
  issuerTag: "issuer:testusd", disclosureProver: async () => ({ proofBytes: "0xfeed" }),
});
assert(builtProven.payload.payload.disclosure.stub === false, "payment with disclosureProver carries a real disclosure");

// ── negative cases ────────────────────────────────────────────────────────────
// asset mismatch: a requirement for native ETH must reject a stable-asset note
const reqEth = buildGloamPaymentRequirements({ amountWei: PRICE, payTo: payee.tag, resource: "r", network: NETWORK });
assert(verifyGloamPayment({ requirements: reqEth, payload: built.payload, note: payNote }).ok === false, "reject asset mismatch");
// amount too low: tamper the requirement upward
const reqHigh = { ...req, maxAmountRequired: (PRICE * 2n).toString() };
assert(verifyGloamPayment({ requirements: reqHigh, payload: built.payload, note: payNote }).ok === false, "reject underpayment");
// wrong pool
const reqPool = { ...req, poolAddress: "0x0000000000000000000000000000000000000001" };
assert(verifyGloamPayment({ requirements: reqPool, payload: built.payload, note: payNote }).ok === false, "reject wrong pool");
// scheme mismatch
const badScheme = { ...built.payload, scheme: "exact" };
assert(verifyGloamPayment({ requirements: req, payload: badScheme, note: payNote }).ok === false, "reject non-gloam scheme");
// a note that is not this transfer's payment output (e.g. replayed from an older payment)
const otherNote = { ...payNote, commitment: fieldToHex(123n) };
const vOther = verifyGloamPayment({ requirements: req, payload: built.payload, note: otherNote });
assert(vOther.ok === false && /payment output/.test(vOther.reason), "reject a note that is not the transfer's payment output");
// underfunded sender note
let threw = false;
try {
  await buildGloamPayment({ requirements: { ...req, maxAmountRequired: (NOTE_AMOUNT * 2n).toString() }, senderSecretHex, senderNoteAmountWei: NOTE_AMOUNT, path, prove });
} catch {
  threw = true;
}
assert(threw, "reject building a payment the note cannot cover");

// ── Gloam vs Zone posture (explicit, not marketing-only) ──────────────────────
assert(GLOAM_VS_ZONE.gloam.some((s) => s.toLowerCase().includes("self-custodial") || s.toLowerCase().includes("settles its own")), "posture: self-custodial");
assert(GLOAM_VS_ZONE.zone.some((s) => s.toLowerCase().includes("operator sees")), "posture: zone operator sees all");

console.log(`x402.selftest: ok (${checks} assertions)`);
