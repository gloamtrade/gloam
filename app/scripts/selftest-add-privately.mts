/**
 * Self-test: the decisions in an Add privately (lib/depositFlow) and how the
 * view (components/app/ShieldView) wires them.
 *
 *  - The deposit is built from the note alone: an asset picked again while the
 *    approval was mined, or another network by then, never sends this note's
 *    proof with something else (the vault reverted it, 265k gas on a fork).
 *  - An approval whose receipt wait gave up goes on to the deposit only when
 *    the allowance read now covers it, and then with its own hash: the lost
 *    approval's hash never counts as a lost deposit.
 *  - "Checking…" holds from the click until the approvals are worked out, and
 *    the asset can't be changed while a deposit is under way.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-add-privately.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";

globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-add-privately: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const { depositCall, depositAfterLostApproval, createTxLog, networkMovedMessage } = await import("../src/lib/depositFlow");
const { getNetwork } = await import("../src/lib/networks");
const { shieldTokensFor } = await import("../src/lib/tokens");
const { NATIVE_ASSET } = await import("../src/lib/shield");

let n = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    n++;
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

const sepolia = getNetwork("ethereum");
const rh = getNetwork("robinhood-mainnet");
const usdc = shieldTokensFor(11155111).find((t) => t.symbol === "USDC")!;
const COMMITMENT = `0x${"12".repeat(32)}` as Hex;
const PROOF = `0x${"ab".repeat(256)}` as Hex;
const note = (asset: Address, amountWei: string, chainId = sepolia.chainId, pool = sepolia.pool!) => ({
  chainId,
  pool,
  asset,
  amountWei,
  commitment: COMMITMENT,
});

check("a USDC note deposits USDC, its own amount and commitment, nothing sent with it", () => {
  const call = depositCall(note(usdc.address, "20000000"), sepolia, PROOF)!;
  assert.equal(call.functionName, "shieldBound");
  assert.equal(call.address, sepolia.pool);
  assert.deepEqual(call.args, [usdc.address, 20_000_000n, COMMITMENT, PROOF]);
  assert.equal(call.value, undefined);
});

check("an asset picked again mid-flow changes nothing: the call is the note's (L-1)", () => {
  // The form now shows ETH; the note, its proof and its approval are USDC's.
  const call = depositCall(note(usdc.address, "20000000"), sepolia, PROOF)!;
  assert.equal(call.args[0], usdc.address);
  assert.equal(call.value, undefined, "no ETH sent with a USDC deposit");
});

check("an ETH note sends its amount as value", () => {
  const call = depositCall(note(NATIVE_ASSET, "1000000000000000"), sepolia, PROOF)!;
  assert.equal(call.args[0], NATIVE_ASSET);
  assert.equal(call.value, 1_000_000_000_000_000n);
});

check("another network or vault by the time it goes out: nothing is sent", () => {
  assert.equal(depositCall(note(usdc.address, "20000000"), rh, PROOF), null, "the page moved to Robinhood Chain");
  assert.equal(depositCall(note(usdc.address, "20000000", sepolia.chainId, "0x00000000000000000000000000000000000000aa"), sepolia, PROOF), null, "another vault");
  assert.equal(depositCall(note(usdc.address, "20000000"), { chainId: sepolia.chainId, pool: null }, PROOF), null, "no vault");
});

check("a pool without the shield proof gets plain shield() from the same note", () => {
  const call = depositCall(note(usdc.address, "20000000"), sepolia, null)!;
  assert.equal(call.functionName, "shield");
  assert.deepEqual(call.args, [usdc.address, 20_000_000n, COMMITMENT]);
});

check("a lost approval receipt: on to the deposit only when the allowance read now covers it", () => {
  const base = { depositWanted: true, amount: 20_000_000n, approvalsLeft: 0, allowance: 20_000_000n };
  assert.equal(depositAfterLostApproval(base), true, "landed: deposit");
  assert.equal(depositAfterLostApproval({ ...base, allowance: 0n }), false, "not landed yet: stop, never approve again on a stale read");
  assert.equal(depositAfterLostApproval({ ...base, allowance: undefined }), false, "unread: stop");
  assert.equal(depositAfterLostApproval({ ...base, approvalsLeft: 1 }), false, "USDT's reset landed but the approval is still to send: stop");
  assert.equal(depositAfterLostApproval({ ...base, depositWanted: false }), false);
  assert.equal(depositAfterLostApproval({ ...base, amount: null }), false);
});

check("a lost approval's hash is never the deposit's, even once the deposit is being written (M-2)", () => {
  const log = createTxLog();
  log.writing("approve");
  log.handed("0xa1"); // the approval's hash
  assert.equal(log.isDeposit("0xa1"), false);
  // the approval's wait gave up and the allowance covers it: the view resets the
  // write (hash back to undefined), then writes the deposit
  log.writing("shield");
  assert.equal(log.isDeposit("0xa1"), false, "the lost approval does not read as a lost deposit");
  log.handed(undefined);
  log.handed("0xd1");
  assert.equal(log.isDeposit("0xd1"), true, "the deposit's own hash");
  log.clear();
  assert.equal(log.isDeposit("0xd1"), false, "a new click starts over");
});

const view = readFileSync(new URL("../src/components/app/ShieldView.tsx", import.meta.url), "utf8");
const body = (name: string) => {
  const start = view.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const next = view.indexOf("\n  }\n", start);
  return view.slice(start, next);
};

check("the view sends what depositCall builds, never the picked asset", () => {
  const exec = body("executeShield");
  assert.ok(!exec.includes("selectedToken"), "executeShield does not read the form's asset");
  assert.ok(!/depositCall\(note, network,/.test(exec), "never against the network of the render it started in");
  assert.ok(view.includes("proveDeposit(value, note, commitment, note.asset)"), "the proof is for the note's asset");
});

check("a network switch mid-deposit: the message names the deposit's network, the one to go back to", () => {
  const tempo = getNetwork("tempo-mainnet");
  assert.equal(
    networkMovedMessage(4663, tempo),
    "The page moved to Tempo before your deposit went out, so nothing was deposited. Switch back to Robinhood Chain and try again."
  );
  assert.equal(
    networkMovedMessage(11155111, getNetwork("base")),
    "The page moved to Base testnet before your deposit went out, so nothing was deposited. Switch back to Ethereum Sepolia and try again."
  );
  assert.match(networkMovedMessage(4663, rh), /vault changed/, "same chain, another vault");
  assert.doesNotMatch(networkMovedMessage(4663, tempo), /—|real money|play money/);
});

check("the deposit is checked against the page's network right before the wallet is asked", () => {
  const exec = body("executeShield");
  const check = body("callForNote");
  assert.ok(check.includes("getActiveNetwork()") && check.includes("networkNow.current"), "the network the page shows now, not the click's");
  assert.ok(view.includes("networkNow.current = network;"), "kept current on every network change");
  // after the proof (nothing saved yet), and again after the note is saved, right before writeContract
  const afterProof = exec.indexOf("await proveDeposit(");
  const saved = exec.indexOf("await keepUntilLanded();", afterProof);
  const write = exec.indexOf("writeContract(", saved);
  const between = (a: number, b: number) => exec.slice(a, b);
  assert.ok(/if \(!callForNote\(note, proofBytes\)\) return stopDeposit\(null\);/.test(between(afterProof, saved)), "checked after the proof");
  assert.ok(/const call = callForNote\(note, proofBytes\);\s*\n\s*if \(!call\) return stopDeposit\(note\);/.test(between(saved, write)), "checked after saving; a stop drops the saved note");
  assert.ok(/chainId: networkNow\.current\.chainId/.test(exec), "the write names the page's chain, which is the note's");
  assert.ok(body("stopDeposit").includes("dropUnsentNote(saved.id)"), "no note left waiting for a deposit that never went out");
  // a second approval (USDT's reset) after the page moved is not sent either
  assert.ok(/if \(pending\.note\.chainId !== network\.chainId\) \{[\s\S]{0,400}networkMovedMessage\(pending\.note\.chainId, network\)/.test(view));
});

check("every write is logged before it goes to the wallet, and the deposit-lost notice is the deposit's", () => {
  assert.equal((view.match(/writeContract\(\{/g) ?? []).length, (view.match(/txLog\.writing\("(approve|shield)"\);\s*\n\s*writeContract\(/g) ?? []).length);
  assert.ok(view.includes("txLog.handed(hash);"));
  assert.ok(/!receiptLost \|\| !txLog\.isDeposit\(hash\) \|\| pendingKind !== "shield"/.test(view), "keyed on the deposit's own hash");
  assert.ok(/reset\(\);\s*\n\s*setApproved\(true\);\s*\n\s*void executeShield\(pending\.value/.test(view), "the approval's hash and error are dropped before the deposit");
  assert.ok(view.includes("depositAfterLostApproval({"));
});

check("Checking… holds until the approvals are worked out, and the asset is fixed while a deposit is under way (L-2)", () => {
  assert.ok(/if \(submitting\.current\) return;\s*\n\s*submitting\.current = true;\s*\n\s*setChecking\(true\);/.test(view));
  assert.ok(/ready = await prepareDeposit\([^)]*\);\s*\n\s*\}(?: catch \{[^}]{0,200}\})? finally \{\s*\n\s*submitting\.current = false;\s*\n\s*setChecking\(false\);/.test(view));
  // a failure while preparing (the Poseidon load, say) is said in the form, not dropped
  assert.ok(/ready = await prepareDeposit\([^)]*\);\s*\n\s*\} catch \{[^}]*setFormError\(/.test(view));
  assert.ok(!/screenWallets\([^)]*\)[\s\S]{0,120}\.finally\(\(\) => setChecking\(false\)\)/.test(view), "screening no longer ends Checking… early");
  assert.ok(/label="Asset to add"[\s\S]{0,200}disabled=\{working \|\| pendingKind !== null\}/.test(view));
});

const { solanaDeclined, solanaSurelyNotSent, surelyNotSent } = await import("../src/lib/walletErrors");

check("a Solana wallet's error drops a deposit's note only when it can't follow a send", () => {
  for (const m of ["User rejected the request.", "Transaction cancelled", "Approval Denied", "Plugin Closed", "Popup closed"]) {
    assert.equal(solanaDeclined(m), true, m);
    assert.equal(solanaSurelyNotSent(m), true, m);
  }
  for (const m of ["Transaction simulation failed: Blockhash not found", "insufficient lamports"]) {
    assert.equal(solanaDeclined(m), false, m);
    assert.equal(solanaSurelyNotSent(m), true, m);
  }
  // the extension's worker can stop after the transaction went out
  for (const m of [
    "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received",
    "WebSocket connection closed",
    "The transaction was not confirmed in 30.00 seconds. It is unknown if it succeeded or failed.",
    "Signature 5x has expired: block height exceeded.",
    "",
  ]) {
    assert.equal(solanaSurelyNotSent(m), false, m);
  }
});

check("a wallet error after the deposit may have gone out keeps its note; only a sure no drops it", () => {
  // sure: the person said no, or it failed before anything reached the network
  assert.equal(surelyNotSent({ name: "UserRejectedRequestError" }), true);
  assert.equal(surelyNotSent({ code: 4001, message: "User rejected the request." }), true);
  assert.equal(surelyNotSent({ name: "ContractFunctionExecutionError", cause: { name: "ChainMismatchError" } }), true);
  // not sure: a timeout or a lost reply can come after the wallet sent it
  assert.equal(surelyNotSent({ name: "TimeoutError", message: "The request took too long to respond." }), false);
  assert.equal(surelyNotSent({ name: "Error", message: "Request expired. Please try again." }), false);
  assert.equal(surelyNotSent({ name: "HttpRequestError", message: "HTTP request failed. Status: 502" }), false);
  // viem wraps a wallet's -32603 internal error as a revert: that can follow a send, so not sure
  assert.equal(surelyNotSent({ name: "ContractFunctionExecutionError", cause: { name: "ContractFunctionRevertedError", cause: { name: "InternalRpcError", code: -32603 } } }), false);
  assert.equal(surelyNotSent({ name: "ContractFunctionExecutionError", cause: { name: "ContractFunctionRevertedError" } }), true);
  // the app's own chain-switch errors (lib/demo) are named so a declined switch still drops the note
  const demoSrc = readFileSync(new URL("../src/lib/demo.ts", import.meta.url), "utf8");
  assert.equal((demoSrc.match(/name: "ChainMismatchError"/g) ?? []).length, 2);
  assert.equal(surelyNotSent(Object.assign(new Error("Switch your wallet to Base and try again."), { name: "ChainMismatchError" })), true);
  // the view drops the deposit's note only under that sure no, and says so otherwise
  const effect = view.slice(view.indexOf("if (!writeError) return;"), view.indexOf("// The receipt wait gave up"));
  assert.ok(effect.length > 0);
  assert.ok(/if \(surelyNotSent\(writeError\)\) dropUnsentNote\(pendingNote\.id\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*else setFormError\(DEPOSIT_MAYBE_SENT\);/.test(effect), "note dropped only on a sure no");
  assert.equal((effect.match(/dropUnsentNote\(/g) ?? []).length, 1, "no other drop in the write-error effect");
});

console.log(`add-privately: ${n} passed`);
