/**
 * Self-test: what a person reads when a wallet send fails (lib/walletErrors
 * walletErrorForPeople). A decline reads as a decline, and viem's long message
 * (account, contract, calldata) never reaches the screen.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-wallet-error-text.mts
 */
import assert from "node:assert/strict";
import { UserRejectedRequestError, ContractFunctionExecutionError, ContractFunctionRevertedError, parseAbi } from "viem";

const { walletErrorForPeople, lacksGasFunds, NO_GAS_FUNDS_TEXT } = await import("../src/lib/walletErrors");

let n = 0;
function check(name: string, fn: () => void) {
  fn();
  n++;
  console.log(`  ok  ${name}`);
}

check("a declined prompt reads as a decline", () => {
  const e = new UserRejectedRequestError(new Error("User rejected the request."));
  assert.equal(walletErrorForPeople(e), "You declined it in your wallet, so it wasn't sent.");
  assert.equal(walletErrorForPeople({ code: 4001, message: "MetaMask Tx Signature: User denied transaction signature." }), "You declined it in your wallet, so it wasn't sent.");
});

check("a plain one-line message (the relay's, say) is kept whole", () => {
  const m = "Not enough in the shared vault to cash out right now (12 USDG available, 40 USDG needed). It opens up once more of this asset is added.";
  assert.equal(walletErrorForPeople(new Error(m)), m);
});

check("viem's long message is cut to its short first line", () => {
  const abi = parseAbi(["function deposit(uint256 a)"]);
  const e = new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi, functionName: "deposit", message: "OverDepositLimit" }),
    { abi, functionName: "deposit", args: [1n], contractAddress: "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", sender: "0x0000000000000000000000000000000000000001" }
  );
  const shown = walletErrorForPeople(e);
  assert.ok(!shown.includes("\n"), "one line");
  assert.ok(!/Contract Call|Request Arguments|Version: viem|0x39E28/i.test(shown), shown);
  assert.match(shown, /OverDepositLimit/, "the reason, not just the call's name");
});

check("a revert's reason, cut onto viem's second line, is shown (not the empty first line)", () => {
  const abi = parseAbi(["function approve(address s, uint256 v)"]);
  const e = new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi, functionName: "approve", message: "Internal JSON-RPC error." }),
    { abi, functionName: "approve", args: ["0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", 1n], contractAddress: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", sender: "0x0000000000000000000000000000000000000001" }
  );
  const shown = walletErrorForPeople(e);
  assert.equal(shown, "It wouldn't go through: Internal JSON-RPC error.");
  assert.ok(!lacksGasFunds(e));
});

check("no gas coin for the fee reads as that, however the wallet words it", () => {
  const abi = parseAbi(["function approve(address s, uint256 v)"]);
  for (const words of [
    "insufficient funds for gas * price + value: balance 0, tx cost 2400000000000, overshot 2400000000000",
    "gas required exceeds allowance (0)",
    "Insufficient balance for transaction fee",
  ]) {
    const e = new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi, functionName: "approve", message: words }),
      { abi, functionName: "approve", args: ["0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", 1n], contractAddress: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", sender: "0x0000000000000000000000000000000000000001" }
    );
    assert.ok(lacksGasFunds(e), words);
    assert.equal(walletErrorForPeople(e), NO_GAS_FUNDS_TEXT, words);
  }
  // a token's own "exceeds balance" is about the token, not the fee
  assert.ok(!lacksGasFunds(new Error("ERC20: transfer amount exceeds balance")));
});

check("a revert with no reason keeps viem's one line", () => {
  const abi = parseAbi(["function approve(address s, uint256 v)"]);
  const e = new ContractFunctionRevertedError({ abi, functionName: "approve" });
  assert.equal(walletErrorForPeople(e), 'The contract function "approve" reverted.');
});

check("a long single-line message is shortened", () => {
  const shown = walletErrorForPeople(new Error("x".repeat(400)));
  assert.ok(shown.length <= 280, String(shown.length));
  assert.ok(shown.endsWith("…"));
});

check("nothing to read falls back to plain words", () => {
  assert.equal(walletErrorForPeople({}), "It didn't go through. Try again.");
  assert.equal(walletErrorForPeople(undefined, "Couldn't send."), "Couldn't send.");
});

console.log(`selftest-wallet-error-text: ${n} checks passed`);
