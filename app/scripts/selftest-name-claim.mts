/**
 * Self-test: private name claims (lib/nameClaim). The escrow a claim's unshield names
 * is the one GloamNamesRegistrar.escrowFor gives (checked against a compiled registrar
 * on a fork: a fixed vector below), a note is the smallest that covers the price after
 * the vault's fee, and the refund note follows the swap rule.
 *
 * Run from app/:  pnpm dlx tsx scripts/selftest-name-claim.mts
 */
import assert from "node:assert/strict";
import { nameEscrowAddress, nameHashOf, noteForPrice, nameClaimRefundAmount } from "../src/lib/nameClaim";
import { vaultFeeOf } from "../src/lib/vaultSwap";

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`ok  ${name}`);
};

ok("the escrow matches the compiled registrar's escrowFor", () => {
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

ok("a note covers the price after the fee, and is the smallest that does", () => {
  for (const [price, bps] of [[5n * 10n ** 18n, 50], [15n * 10n ** 18n, 50], [50n * 10n ** 18n, 50], [15n * 10n ** 18n, 100], [7n, 50], [10n ** 18n, 0]] as const) {
    const a = noteForPrice(price, bps);
    assert.ok(a - vaultFeeOf(a, bps) >= price, `covers ${price} at ${bps}`);
    assert.ok(a - 1n - vaultFeeOf(a - 1n, bps) < price, `smallest for ${price} at ${bps}`);
  }
});

ok("the refund note is the note less 1%", () => {
  assert.equal(nameClaimRefundAmount(5025125628140703518n), 5025125628140703518n - 50251256281407035n);
});

console.log(`\n${passed} passed`);
