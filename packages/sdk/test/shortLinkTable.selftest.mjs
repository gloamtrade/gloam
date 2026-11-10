/**
 * The short link table (src/shortLink SHORT_LINK_WHERE) is pinned. Id n means
 * one chain, vault and token for good: links already sent carry only the id, so
 * reordering, removing or editing an entry would open them as another payment.
 * This test lists every id given so far and a few fixed link bodies, so any such
 * change fails the build. New entries go at the end of the table and still pass;
 * add them to PINNED here once they ship.
 *
 * Run after build:  node test/shortLinkTable.selftest.mjs
 */
import assert from "node:assert/strict";
import { SHORT_LINK_WHERE, decodeShortClaim, encodeShortClaim, readShortClaim, seedToSecret, fieldToHex } from "../dist/index.js";

let n = 0;

/** [id, chainId, vault, token]: every id given out, in order. Never change a row. */
const PINNED = [
  [1, 4663, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"],
  [2, 4663, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x0000000000000000000000000000000000000000"],
  [3, 4663, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0xDcD885F5c60b3aD49F6D58718696417314e8724d"],
  [4, 4663, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x9f4BA41F91a59A34e17eE8C9EB3A51363B11aBD5"],
  [5, 4663, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x39dBED3a2bd333467115dE45665cC57F813C4571"],
  [6, 4663, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x020bfC650A365f8BB26819deAAbF3E21291018b4"],
  [7, 4663, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18"],
  [8, 4663, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3"],
  [9, 4217, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x20c000000000000000000000b9537d11c60e8b50"],
  [10, 4217, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x20c0000000000000000000000000000000000000"],
  [11, 4217, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x20c00000000000000000000014f22ca97301eb73"],
  [12, 4217, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x20c0000000000000000000006a37da5c996874be"],
  [13, 8453, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
  [14, 8453, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42"],
  [15, 8453, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"],
  [16, 8453, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x0000000000000000000000000000000000000000"],
  [17, 8453, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x6ad12E761b438beA3EA09F6C6266556Bb24C2181"],
  [18, 1, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
  [19, 1, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0xdAC17F958D2ee523a2206206994597C13D831ec7"],
  [20, 1, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0xe343167631d89B6Ffc58B88d6b7fB0228795491D"],
  [21, 1, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8"],
  [22, 1, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c"],
  [23, 1, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x0000000000000000000000000000000000000000"],
  [24, 1, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x6ad12E761b438beA3EA09F6C6266556Bb24C2181"],
  [25, 84532, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"],
  [26, 84532, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x808456652fdb597867f38412077A9182bf77359F"],
  [27, 84532, "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", "0x0000000000000000000000000000000000000000"],
  [28, 11155111, "0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef", "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"],
  [29, 11155111, "0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef", "0xfBb2A78CceEb415b00300925e464C3E44E6e06b0"],
  [30, 11155111, "0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef", "0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9"],
  [31, 11155111, "0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef", "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4"],
  [32, 11155111, "0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef", "0x0000000000000000000000000000000000000000"],
  [33, 46630, "0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740", "0x0000000000000000000000000000000000000000"],
  [34, 46630, "0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740", "0x7E955252E15c84f5768B83c41a71F9eba181802F"],
  [35, 42431, "0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb", "0x20c0000000000000000000000000000000000000"],
  [36, 42431, "0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb", "0x20c0000000000000000000006a37da5c996874be"],
  [37, 42431, "0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb", "0x20c0000000000000000000000000000000000001"],
  [38, 42431, "0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb", "0x20c0000000000000000000000000000000000002"],
  [39, 42431, "0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb", "0x20c0000000000000000000000000000000000003"],
  [40, 46630, "0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740", "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E"],
  [41, 46630, "0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740", "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02"],
  [42, 46630, "0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740", "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0"],
  [43, 46630, "0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740", "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93"],
  [44, 46630, "0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740", "0x71178BAc73cBeb415514eB542a8995b82669778d"],
  // Elysium mainnet, from src/elysium.ts (live since 9 November 2026). 46 stays reserved for its testnet.
  [45, 99901, "0x89d3042390204f57b8b4F8949D3c2203E4002164", "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65"],
  [47, 99901, "0x89d3042390204f57b8b4F8949D3c2203E4002164", "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0"],
];

assert.ok(SHORT_LINK_WHERE.length >= PINNED.length, `the table only grows: ${SHORT_LINK_WHERE.length} < ${PINNED.length}`);
for (const [id, chainId, pool, asset] of PINNED) {
  const w = SHORT_LINK_WHERE[id - 1];
  assert.ok(w, `id ${id} is gone`);
  assert.deepEqual({ chainId: w.chainId, pool: w.pool.toLowerCase(), asset: w.asset.toLowerCase() }, { chainId, pool: pool.toLowerCase(), asset: asset.toLowerCase() }, `id ${id} changed`);
  n++;
}
// an entry appended later never repeats a place that already has an id
const key = (w) => `${w.chainId}|${w.pool.toLowerCase()}|${w.asset.toLowerCase()}`;
// (reserved ids, Elysium's before its values are in, are all chain 0 and stand for no place yet)
const placed = SHORT_LINK_WHERE.filter((w) => w.chainId !== 0);
assert.equal(new Set(placed.map(key)).size, placed.length, "no place has two ids");
n++;

// fixed bodies: a seed link on ids 1, 16 (with a note), 44 and 47, and a 32-byte secret link on id 10.
// Made once; they must read back the same forever, and the same payment must still write them.
const seedBytes = Uint8Array.from({ length: 16 }, (_, i) => i * 17 + 3);
const seed = "0x031425364758697a8b9cadbecfe0f102";
const seedSecret = "0x00571d057b436987ee6af746e62c82e20eeda4788e68df46296ede81fc623ee2";
assert.equal(fieldToHex(seedToSecret(seedBytes)), seedSecret);
n++;
const VECTORS = [
  {
    body: "2Ha7FIGBo3AjPRIwmeiQ1AWW788",
    id: 1,
    fields: { chainId: 4663, pool: "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", amountWei: "100000000", secret: seedSecret, seed },
    commitment: "0x0be87c1ed25efb67369e16bd1cec74408c65808bfafdcce5e3a40349c7006127",
  },
  {
    body: "38d1SrTTwWdnRGSHseXtIDKMRnDgr6xdNF6",
    id: 16,
    fields: { chainId: 8453, pool: "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", asset: "0x0000000000000000000000000000000000000000", amountWei: "1500000000000000", secret: seedSecret, note: "Rent", seed },
    commitment: "0x1ad0b0311eab3d429184d0064e9193432b4f32eb809ea7cabb7512c4716f0ca9",
  },
  {
    body: "2J4auweeG6uBKQXUGKiHKDLsx23",
    id: 44,
    fields: { chainId: 46630, pool: "0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740", asset: "0x71178BAc73cBeb415514eB542a8995b82669778d", amountWei: "2000000000000000000", secret: seedSecret, seed },
    commitment: "0x02868f0167aadf3952bfbd28c528da7a5db7b2cce68b89a4fd8bcf7573e2f5b2",
  },
  {
    body: "2N4ubIuQEacWWc8TX27E9psJfVuRYN6mINtt0UuYXprI1qFKZQ",
    id: 10,
    fields: { chainId: 4217, pool: "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", asset: "0x20c0000000000000000000000000000000000000", amountWei: "250000", secret: "0x0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0b" },
    commitment: "0x11c8f5cc6d8de91b6710c5cd5427db3c651b1a06021385655528d91477b4867a",
  },
  {
    body: "9XDl76TRltakYTOTGuUg0Q7skmNv",
    id: 47,
    fields: { chainId: 99901, pool: "0x89d3042390204f57b8b4F8949D3c2203E4002164", asset: "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0", amountWei: "40000000000000000000", secret: seedSecret, seed },
    commitment: "0x05cfe42323db2add42bf23f1fe13345cff507634c0eb40431675fd62d2aa68ac",
  },
];
for (const v of VECTORS) {
  assert.deepEqual(readShortClaim(v.body), v.fields, `body for id ${v.id} reads back the same`);
  assert.equal((await decodeShortClaim(v.body)).commitment, v.commitment, `id ${v.id} commitment`);
  assert.equal(encodeShortClaim(v.fields), v.body, `id ${v.id} still writes the same body`);
  n += 3;
}

console.log(`shortLink table selftest: ${n} checks passed`);
