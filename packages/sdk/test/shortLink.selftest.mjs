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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

// Elysium: the values as shipped ("live"), then again in children with them blanked
// ("empty", ids 45 and 46 reserved) and with placeholder values for both networks
// ("filled"), each put in before the SDK loads (the same way test/elysium.selftest does).
const elysium = await import("../dist/elysium.js");
const SHIPPED = elysium.elysiumMainnetConfig();
const SHIPPED_TEST = elysium.elysiumTestnetConfig();
const MODE = process.env.GLOAM_SELFTEST_SHORTLINK ?? (SHIPPED ? "live" : "empty");
// Elysium mainnet as deployed (contracts/deployments/elysium-mainnet.json).
const ELY_LIVE = { chainId: 99901, pool: "0x89d3042390204f57b8b4F8949D3c2203E4002164", usdc: "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65" };
const ELY_PLACEHOLDER = { chainId: 99901, pool: "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", usdc: "0x00000000000000000000000000000000000E1a5c" };
const ELY_TEST_PLACEHOLDER = { chainId: 99801, pool: "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", usdc: "0x7D29d8047B905000459c0E80c34a26CeedcB47b2" };
if (MODE === "empty") {
  Object.assign(elysium.ELYSIUM_MAINNET, { pool: null, deployBlock: null, payMemo: null, payMemoBlock: null });
  Object.assign(elysium.ELYSIUM_TESTNET, { pool: null, deployBlock: null, payMemo: null, payMemoBlock: null });
}
if (MODE === "filled") {
  Object.assign(elysium.ELYSIUM_MAINNET, {
    chainId: ELY_PLACEHOLDER.chainId,
    rpcUrl: "https://rpc.elysium.example",
    explorerUrl: "https://explorer.elysium.example",
    usdc: ELY_PLACEHOLDER.usdc,
    usdcDecimals: 6,
    pool: ELY_PLACEHOLDER.pool,
    deployBlock: 1_234n,
  });
  Object.assign(elysium.ELYSIUM_TESTNET, { pool: ELY_TEST_PLACEHOLDER.pool, deployBlock: 5_678n });
}
// What ids 45 and 46 should hold in this run, or null while reserved.
const ELY = MODE === "live" ? ELY_LIVE : MODE === "filled" ? ELY_PLACEHOLDER : null;
const ELY_TEST =
  MODE === "filled"
    ? ELY_TEST_PLACEHOLDER
    : MODE === "live" && SHIPPED_TEST
      ? { chainId: SHIPPED_TEST.chainId, pool: SHIPPED_TEST.pool, usdc: SHIPPED_TEST.usdc }
      : null;
const {
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
} = await import("../dist/index.js");

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

// Elysium is id 45 (mainnet) and 46 (testnet), at the end of the table; each reserved until its values are in.
assert.equal(SHORT_LINK_WHERE.length, 46, "44 places, then Elysium mainnet's USDC as 45 and its testnet's as 46");
{
  const usdg = encodeShortClaim({ pool: "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", amountWei: "1000000", secret: fieldToHex(seedToSecret(new Uint8Array(16).fill(7))), seed: `0x${"07".repeat(16)}`, chainId: 4663 });
  const raw = fromBase62(usdg);
  assert.equal(raw[1], 1, "Robinhood Chain USDG is id 1");
  // The same record, naming id 45, with its check made again.
  const withId = (id) => {
    const body = raw.slice(0, -1);
    body[1] = id;
    const check = Uint8Array.from(keccak256(body).slice(2, 4).match(/../g).map((b) => parseInt(b, 16)));
    return toBase62(new Uint8Array([...body, ...check]));
  };
  const link45 = withId(45);
  const link46 = withId(46);
  const reserved = { chainId: 0, pool: "0x0000000000000000000000000000000000000000", asset: "0x0000000000000000000000000000000000000000" };
  if (ELY) {
    if (MODE === "live") {
      const cfg = elysium.elysiumMainnetConfig();
      assert.equal(cfg.chainId, ELY_LIVE.chainId, "Elysium mainnet's chain id as shipped");
      assert.equal(cfg.pool, ELY_LIVE.pool, "Elysium mainnet's vault as shipped");
      assert.equal(cfg.usdc, ELY_LIVE.usdc, "Elysium mainnet's USDC as shipped");
      n += 3;
    }
    const w = SHORT_LINK_WHERE[44];
    assert.equal(w.chainId, ELY.chainId, "id 45 is Elysium");
    assert.equal(w.pool.toLowerCase(), ELY.pool.toLowerCase(), "id 45 is Elysium's vault");
    assert.equal(w.asset.toLowerCase(), ELY.usdc.toLowerCase(), "id 45 is Elysium's USDC");
    const back = readShortClaim(link45);
    assert.equal(back.chainId, ELY.chainId);
    assert.equal(back.asset.toLowerCase(), ELY.usdc.toLowerCase(), "id 45 reads as Elysium's USDC");
    assert.ok(gloamNetworks().some((x) => x.key === "elysium-mainnet"), "Elysium was in the round trips above");
    n += 6;
  } else {
    assert.equal(elysium.elysiumMainnetConfig(), null, "Elysium's values are not in");
    assert.deepEqual({ ...SHORT_LINK_WHERE[44] }, reserved, "id 45 is reserved");
    assert.throws(() => readShortClaim(link45), /cut off or damaged/, "a reserved id is refused");
    assert.ok(!gloamNetworks().some((x) => x.key === "elysium-mainnet"), "no Elysium network");
    // A link to the reserved place's chain 0 is never given id 45.
    const zero = encodeShortClaim({ pool: "0x0000000000000000000000000000000000000000", asset: "0x0000000000000000000000000000000000000000", amountWei: "1", secret: fieldToHex(5n), chainId: 0 });
    assert.ok(zero === null || fromBase62(zero)[1] !== 45, "chain 0 never reads as id 45");
    n += 5;
  }
  if (ELY_TEST) {
    const t = SHORT_LINK_WHERE[45];
    assert.equal(t.chainId, ELY_TEST.chainId, "id 46 is Elysium testnet");
    assert.equal(t.asset.toLowerCase(), ELY_TEST.usdc.toLowerCase(), "id 46 is its test USDC");
    assert.equal(readShortClaim(link46).chainId, ELY_TEST.chainId, "id 46 reads as Elysium testnet");
    assert.ok(gloamNetworks().some((x) => x.key === "elysium"), "Elysium testnet was in the round trips above");
    n += 4;
  } else {
    assert.equal(elysium.elysiumTestnetConfig(), null, "Elysium testnet's pool is not in");
    assert.deepEqual({ ...SHORT_LINK_WHERE[45] }, reserved, "id 46 is reserved");
    assert.throws(() => readShortClaim(link46), /cut off or damaged/, "id 46 too");
    assert.ok(!gloamNetworks().some((x) => x.key === "elysium"), "no Elysium testnet network");
    n += 4;
  }
}

if (!process.env.GLOAM_SELFTEST_SHORTLINK) {
  for (const mode of ["empty", "filled"].filter((m) => m !== MODE)) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, GLOAM_SELFTEST_SHORTLINK: mode }, encoding: "utf8" });
    if (child.status !== 0) {
      console.error(child.stdout, child.stderr);
      assert.fail(`the ${mode} run failed`);
    }
    process.stdout.write(child.stdout);
    n++;
  }
}
console.log(`shortLink selftest (${MODE}): ${n} checks passed`);
