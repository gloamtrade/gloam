/**
 * Short claim and request links (src/shortLink): a seed makes the secret the
 * transfer witness proves, every network and token round-trips to the same note,
 * the commitment worked out again is the one on chain, a payment with a 32-byte
 * secret still gets a short link, request links read back exactly, and a link
 * cut or changed on the way is refused. The app's own cross-checks run in
 * app/scripts/selftest-short-links.
 *
 * Run after build:  node test/shortLink.selftest.mjs
 */
import assert from "node:assert/strict";
import {
  SHORT_LINK_WHERE,
  buildPaymentRequestLink,
  buildShortPaymentRequestLink,
  buildTransferWitness,
  decodeNotePackage,
  decodeShortClaim,
  encodeNotePackage,
  encodeShortClaim,
  fieldToHex,
  fromBase62,
  generateReceiveKey,
  gloamNetworks,
  noteCommitmentPoseidon,
  parsePaymentRequestLink,
  randomNoteSeed,
  readShortClaim,
  seedToSecret,
  shortClaimLink,
  toBase62,
} from "../dist/index.js";

let n = 0;
const bytesOf = (h) => Uint8Array.from(h.slice(2).match(/../g).map((b) => parseInt(b, 16)));

// base62 round trip
for (const b of [Uint8Array.of(1), Uint8Array.of(0x1f, 0, 0, 7), crypto.getRandomValues(new Uint8Array(40)).map((x, i) => (i ? x : x | 1))]) {
  assert.deepEqual(fromBase62(toBase62(b)), b);
  assert.match(toBase62(b), /^[0-9A-Za-z]+$/);
  n += 2;
}

// a fixed vector, so app and SDK (and any later version) agree on the seed -> secret map
assert.equal(
  fieldToHex(seedToSecret(new Uint8Array(16))),
  fieldToHex(BigInt(`0x${"0".repeat(64)}`) | (BigInt((await import("viem")).keccak256(new Uint8Array([...new TextEncoder().encode("gloam/note-seed/v1"), ...new Uint8Array(16)]))) & ((1n << 248n) - 1n)))
);
n++;

// seed -> witness -> commitment -> short link -> same note
const { seed } = randomNoteSeed();
const w = await buildTransferWitness({
  secretHex: fieldToHex(42n),
  amountIn: 10_000_000n,
  amountPay: 2_500_000n,
  asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  path: { root: 0n, leaf: 0n, pathElements: [], pathIndices: [] },
  paySeed: seed,
});
assert.equal(BigInt(w.paymentNote.secret), seedToSecret(bytesOf(seed)));
const body = encodeShortClaim({ ...w.paymentNote, pool: "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", chainId: 4663 });
const back = await decodeShortClaim(body);
assert.equal(back.commitment, w.paymentNote.commitment, "the commitment worked out is the one on chain");
assert.equal(back.secret, w.paymentNote.secret);
assert.equal(back.seed, seed);
assert.ok(shortClaimLink(body).length <= 55, shortClaimLink(body));
// the gloam1 package keeps the seed both ways
assert.equal(decodeNotePackage(encodeNotePackage({ ...w.paymentNote, pool: "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", chainId: 4663 })).seed, seed);
n += 6;

// every network and token, seed and 32-byte secret forms
for (const net of gloamNetworks()) {
  for (const [i, asset] of net.assets.entries()) {
    assert.ok(SHORT_LINK_WHERE.some((x) => x.chainId === net.chainId && x.pool.toLowerCase() === net.pool.toLowerCase() && x.asset.toLowerCase() === asset.address.toLowerCase()), `${net.key} ${asset.symbol} has an id`);
    for (const useSeed of [true, false]) {
      const s = useSeed ? randomNoteSeed() : { seed: undefined, secret: BigInt(`0x${(i + 1).toString(16).repeat(62)}`) };
      const amount = (10n ** BigInt(asset.decimals) * BigInt(i + 3)).toString();
      const commitment = fieldToHex(await noteCommitmentPoseidon(s.secret, BigInt(amount), asset.address));
      const p = { pool: net.pool, asset: asset.address, amountWei: amount, secret: fieldToHex(s.secret), chainId: net.chainId, seed: s.seed, note: i ? "agent-42" : undefined };
      const d = await decodeShortClaim(encodeShortClaim(p));
      assert.equal(d.commitment, commitment, `${net.key} ${asset.symbol}`);
      assert.equal(d.amountWei, amount);
      assert.equal(d.chainId, net.chainId);
      assert.equal(d.note, p.note);
      n += 4;
    }
    n++;
  }
}

// damage is refused
assert.throws(() => readShortClaim(body.slice(0, -1)), /cut off or damaged/);
assert.throws(() => readShortClaim(body.slice(1)), /cut off or damaged/);
n += 2;

// requests: the short link reads back as the long one does
const { tag } = await generateReceiveKey();
for (const net of gloamNetworks()) {
  for (const asset of net.assets) {
    const params = { payTo: tag, network: net, asset: asset.address, amount: asset.decimals >= 2 ? "12.5" : "7", note: "Invoice 042", name: "Robin" };
    const short = buildShortPaymentRequestLink(params);
    assert.match(short, /^https:\/\/gloam\.trade\/r#[0-9A-Za-z]+$/);
    assert.deepEqual(parsePaymentRequestLink(short), parsePaymentRequestLink(buildPaymentRequestLink(params)), `${net.key} ${asset.symbol}`);
    n += 2;
  }
}

console.log(`shortLink selftest: ${n} checks passed`);
