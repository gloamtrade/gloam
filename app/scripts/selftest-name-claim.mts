/**
 * Self-test: private name claims (lib/nameClaim). The escrow a claim's unshield names
 * is the one GloamNamesRegistrar.escrowFor gives (checked against a compiled registrar
 * on a fork: a fixed vector below), a note is the smallest that covers the price after
 * the vault's fee, and the refund note follows the swap rule.
 *
 * Run from app/:  pnpm dlx tsx scripts/selftest-name-claim.mts
 */
import assert from "node:assert/strict";
import {
  nameEscrowAddress,
  nameEscrowHolds,
  nameHashOf,
  nameRefundEscrow,
  noteForPrice,
  nameClaimRefundAmount,
  waitForNameClaim,
  type NameClaimRefundInfo,
} from "../src/lib/nameClaim";
import { GLOAM_TOKEN } from "../src/lib/buybacks";
import { vaultFeeOf } from "../src/lib/vaultSwap";

let passed = 0;
const ok = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
};

await ok("the escrow matches the compiled registrar's escrowFor", () => {
  // GloamNamesRegistrar deployed by the anvil default account (nonce 0) on a Robinhood Chain fork,
  // escrowFor read with `cast call` for this key: 0xd590CF746C3685df3f2EaBF69b10d4D4cEB59C0d
  const registrar = "0x8F9DedBD504580f9E966C006dad0E51EA8CC5A00";
  const got = nameEscrowAddress(registrar, {
    nullifier: "0x1111111111111111111111111111111111111111111111111111111111111111",
    amount: 5025125628140703518n,
    nameHash: nameHashOf("yomi"),
    keyX: "0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
    keyY: "0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
    holder: "0x000000000000000000000000000000000000bEEF",
    years: 1n,
    refundCommitment: "0x2222222222222222222222222222222222222222222222222222222222222222",
    refundAmount: 4974874371859296483n,
  });
  assert.equal(got, "0xd590CF746C3685df3f2EaBF69b10d4D4cEB59C0d");
});

await ok("a note covers the price after the fee, and is the smallest that does", () => {
  for (const [price, bps] of [[5n * 10n ** 18n, 50], [15n * 10n ** 18n, 50], [50n * 10n ** 18n, 50], [15n * 10n ** 18n, 100], [7n, 50], [10n ** 18n, 0]] as const) {
    const a = noteForPrice(price, bps);
    assert.ok(a - vaultFeeOf(a, bps) >= price, `covers ${price} at ${bps}`);
    assert.ok(a - 1n - vaultFeeOf(a - 1n, bps) < price, `smallest for ${price} at ${bps}`);
  }
});

await ok("the refund note is the note less 1%", () => {
  assert.equal(nameClaimRefundAmount(5025125628140703518n), 5025125628140703518n - 50251256281407035n);
});

// The settle decision for a claim's refund note (lib/claimSweep settlePending, with this escrow read).
const REGISTRAR = "0x8F9DedBD504580f9E966C006dad0E51EA8CC5A00" as const;
const NOTE = 5025125628140703518n;
const REFUND = 4974874371859296483n;
const NULLIFIER = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const REFUND_COMMITMENT = "0x2222222222222222222222222222222222222222222222222222222222222222" as const;
const info: NameClaimRefundInfo = {
  registrar: REGISTRAR,
  amount: NOTE.toString(),
  name: "yomi",
  keyX: "0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
  keyY: "0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
  holder: "0x000000000000000000000000000000000000bEEF",
  years: "1",
};
/** A chain whose only state is the GLOAM held at one address, read at one block. */
const chainHolding = (at: string, held: bigint, reads: unknown[] = []) => ({
  readContract: (async (p: { address: string; functionName: string; args: readonly unknown[]; blockNumber?: bigint }) => {
    reads.push(p);
    assert.equal(p.address, GLOAM_TOKEN);
    assert.equal(p.functionName, "balanceOf");
    return String(p.args[0]).toLowerCase() === at.toLowerCase() ? held : 0n;
  }) as never,
});

await ok("a refund note waits on the same escrow its claim's unshield named", () => {
  assert.equal(nameRefundEscrow(info, NULLIFIER, REFUND_COMMITMENT, REFUND), "0xd590CF746C3685df3f2EaBF69b10d4D4cEB59C0d");
});

await ok("settle: spent, refund not seen, the escrow holds the refund: send the claim again", async () => {
  const escrow = nameRefundEscrow(info, NULLIFIER, REFUND_COMMITMENT, REFUND);
  const reads: unknown[] = [];
  // what the vault paid the escrow: the note less its 0.5% cash-out fee, above the refund
  assert.equal(await nameEscrowHolds(chainHolding(escrow, NOTE - NOTE / 200n, reads), info, NULLIFIER, REFUND_COMMITMENT, REFUND, 7n), true);
  assert.equal((reads[0] as { blockNumber?: bigint }).blockNumber, 7n, "read at the block the vault was read at");
  assert.equal(await nameEscrowHolds(chainHolding(escrow, REFUND), info, NULLIFIER, REFUND_COMMITMENT, REFUND), true, "exactly the refund is enough");
});

await ok("settle: an empty escrow (the claim itself ran) or dust: nothing waits, the refund note goes", async () => {
  const escrow = nameRefundEscrow(info, NULLIFIER, REFUND_COMMITMENT, REFUND);
  assert.equal(await nameEscrowHolds(chainHolding(escrow, 0n), info, NULLIFIER, REFUND_COMMITMENT, REFUND), false);
  assert.equal(await nameEscrowHolds(chainHolding(escrow, 1n), info, NULLIFIER, REFUND_COMMITMENT, REFUND), false, "dust sent to a used escrow");
  // money at another claim's escrow is not this one's
  assert.equal(await nameEscrowHolds(chainHolding(REGISTRAR, NOTE), info, NULLIFIER, REFUND_COMMITMENT, REFUND), false);
});

await ok("settle: a failed escrow read throws, which the sync counts as unread (keep waiting)", async () => {
  const down = { readContract: (async () => Promise.reject(new Error("rpc down"))) as never };
  await assert.rejects(nameEscrowHolds(down, info, NULLIFIER, REFUND_COMMITMENT, REFUND));
});

await ok("a claim whose reply was lost: the name is found once it points to this tag", async () => {
  const slept: number[] = [];
  const sleep = async (ms: number) => void slept.push(ms);
  let calls = 0;
  const lands = async () => (++calls >= 3 ? { tag: "gloamr1.me" } : null);
  assert.equal(await waitForNameClaim(lands, "yomi", "gloamr1.me", { waitMs: 90_000, everyMs: 5_000, sleep }), true);
  assert.equal(calls, 3);
  // someone else's name, or a read that fails, is not this claim landing
  calls = 0;
  const other = async () => {
    calls++;
    if (calls === 2) throw new Error("rpc down");
    return { tag: "gloamr1.someone" };
  };
  slept.length = 0;
  assert.equal(await waitForNameClaim(other, "yomi", "gloamr1.me", { waitMs: 90_000, everyMs: 5_000, sleep }), false);
  assert.equal(calls, 19, "asked for about 90 seconds, every 5");
  assert.ok(slept.reduce((a, b) => a + b, 0) <= 90_000);
});

console.log(`\n${passed} passed`);
