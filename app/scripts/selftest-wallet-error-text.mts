/**
 * Self-test: what a person reads when a wallet send fails (lib/walletErrors
 * walletErrorForPeople). A decline reads as a decline, and viem's long message
 * (account, contract, calldata) never reaches the screen.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-wallet-error-text.mts
 */
import assert from "node:assert/strict";
import { UserRejectedRequestError, ContractFunctionExecutionError, ContractFunctionRevertedError, parseAbi } from "viem";

const { walletErrorForPeople } = await import("../src/lib/walletErrors");

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
  assert.match(shown, /deposit/);
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
