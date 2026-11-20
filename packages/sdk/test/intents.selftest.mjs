/**
 * Intent-builder assembly self-test.
 *
 * Verifies buildUnshieldIntent / buildPrivateSendIntent / buildPrivateTradeIntent
 * assemble exec.args in the EXACT order the ShieldPoolPoseidon ABI expects
 * (matched against the app's real call sites). A stub prover stands in for
 * snarkjs, so this tests the assembly logic, not the proof itself.
 *
 * Run after build:  node test/intents.selftest.mjs
 */
import {
  IncrementalMerkleTreePoseidon,
  buildUnshieldIntent,
  buildPrivateSendIntent,
  buildPrivateTradeIntent,
  poseidon3,
  fieldToHex,
  NATIVE_ASSET,
  SEALED_VAULT,
  randomNoteSeed,
  seedMakesSecret,
  encodeShortClaim,
  decodeShortClaim,
} from "../dist/index.js";

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  checks++;
}

const SECRET = 12345678901234567890n;
const AMOUNT = 1000000000000000n;
const RECIPIENT = "0xe1b0ddf821f1faa9402b0b8c4e66b213f877e828";
const ASSET_OUT = "0x00000000000000000000000000000000000000ee";
const STUB_PROOF = "0xdeadbeef";
const prove = async () => ({ proofBytes: STUB_PROOF });
const isBytes32 = (x) => typeof x === "string" && /^0x[0-9a-f]{64}$/.test(x);

// Fixture tree: same three leaves as the witness test, spend leaf 0.
const tree = new IncrementalMerkleTreePoseidon();
await tree.insert(await poseidon3(SECRET, AMOUNT, 0n));
await tree.insert(await poseidon3(999n, 1n, 0n));
await tree.insert(await poseidon3(888n, 2n, 0n));
const path = await tree.path(0);
const secretHex = fieldToHex(SECRET);

// unshield(proof, root, nullifier, asset, to, amount)
const u = await buildUnshieldIntent({ secretHex, amountWei: AMOUNT, asset: NATIVE_ASSET, to: RECIPIENT, path, prove });
assert(u.intent === "unshield" && u.exec.fn === "unshield", "unshield kind/fn");
assert(u.exec.poolAddress === SEALED_VAULT, "unshield pool");
assert(u.exec.args.length === 6, "unshield arg count");
assert(u.exec.args[0] === STUB_PROOF, "unshield arg0 = proof");
assert(isBytes32(u.exec.args[1]) && isBytes32(u.exec.args[2]), "unshield root+nullifier bytes32");
assert(u.exec.args[3] === NATIVE_ASSET && u.exec.args[4] === RECIPIENT, "unshield asset+to");
assert(u.exec.args[5] === AMOUNT, "unshield amount");

// GHSA-rvhx-3m36-4g8h: a cash out naming the vault itself is refused before proving, in any letter case
for (const to of [SEALED_VAULT, SEALED_VAULT.toLowerCase(), SEALED_VAULT.toUpperCase().replace("0X", "0x")]) {
  let proved = false;
  const err = await buildUnshieldIntent({
    secretHex, amountWei: AMOUNT, asset: NATIVE_ASSET, to, path,
    prove: async (i) => { proved = true; return prove(i); },
  }).then(() => null, (e) => e);
  assert(err && /vault itself/.test(err.message) && !proved, `unshield to the vault (${to}) is refused before proving`);
}

// transfer(proof, root, nullifier, [c0, c1])
const s = await buildPrivateSendIntent({ secretHex, amountInWei: AMOUNT, amountPayWei: 400000000000000n, asset: NATIVE_ASSET, path, prove });
assert(s.intent === "private_send" && s.exec.fn === "transfer", "send kind/fn");
assert(s.exec.args.length === 4, "transfer arg count");
assert(s.exec.args[0] === STUB_PROOF, "transfer arg0 = proof");
assert(isBytes32(s.exec.args[1]) && isBytes32(s.exec.args[2]), "transfer root+nullifier");
assert(Array.isArray(s.exec.args[3]) && s.exec.args[3].length === 2 && s.exec.args[3].every(isBytes32), "transfer [c0,c1]");
assert(s.paymentNote && s.changeNote, "send returns payment+change notes");

// paySeed forwards through buildPrivateSendIntent -> compact short claim link
const { seed: paySeed } = randomNoteSeed();
const seeded = await buildPrivateSendIntent({
  secretHex,
  amountInWei: AMOUNT,
  amountPayWei: 400000000000000n,
  asset: NATIVE_ASSET,
  path,
  prove,
  paySeed,
});
assert(seeded.paymentNote.seed === paySeed, "send forwards paySeed onto paymentNote");
assert(seedMakesSecret(paySeed, seeded.paymentNote.secret), "paySeed derives paymentNote.secret");
const shortBody = encodeShortClaim({ ...seeded.paymentNote, pool: SEALED_VAULT, chainId: seeded.chainId });
assert(shortBody !== null, "seeded paymentNote encodes as short claim");
const decodedShort = await decodeShortClaim(shortBody);
assert(decodedShort.commitment === seeded.paymentNote.commitment && decodedShort.seed === paySeed, "short claim decodes back to same commitment and seed");

// sealedSwap(proof, root, nullifier, cOut, cChange, assetIn, assetOut, amountOutMin, rateIn, rateOut)
const t = await buildPrivateTradeIntent({
  secretHex, amountInWei: AMOUNT, amountSwapWei: AMOUNT,
  assetIn: NATIVE_ASSET, assetOut: ASSET_OUT, amountOutMinWei: 1n, rateIn: 1n, rateOut: 1n,
  market: "TSLA", side: "buy", path, prove,
});
assert(t.intent === "private_trade" && t.exec.fn === "sealedSwap", "trade kind/fn");
assert(t.exec.args.length === 10, "sealedSwap arg count");
assert(t.exec.args[0] === STUB_PROOF, "sealedSwap arg0 = proof");
assert(isBytes32(t.exec.args[1]) && isBytes32(t.exec.args[2]) && isBytes32(t.exec.args[3]) && isBytes32(t.exec.args[4]), "sealedSwap root/nullifier/cOut/cChange bytes32");
assert(t.exec.args[5] === NATIVE_ASSET && t.exec.args[6] === ASSET_OUT, "sealedSwap assetIn/assetOut");
assert(t.exec.args[7] === 1n && t.exec.args[8] === 1n && t.exec.args[9] === 1n, "sealedSwap amountOutMin/rateIn/rateOut");
assert(t.outNote && t.changeNote, "trade returns out+change notes");

console.log(`intents.selftest: ok (${checks} assertions)`);
