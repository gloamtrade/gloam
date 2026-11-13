/**
 * Agent commerce: the receipt leaf, the pay-and-receipt helper, the record
 * check and the signing allowlist.
 *
 * The leaf is a format other code recomputes (a Solidity verifier, a city's
 * own indexer), so its bytes are pinned against a vector that Solidity's
 * abi.encode and `cast abi-encode` both reproduce. When the receipt circuit
 * files exist (app/public/circuits/receipt*), it proves a real receipt for a
 * payment built in a local tree and runs the full record check against a mock
 * chain. The transfer proof is stubbed: only the vault checks it, and the
 * vault is not part of this test.
 *
 * Run after build:  node test/commerce.selftest.mjs
 */
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { encodeAbiParameters, encodeEventTopics, hexToString, toFunctionSelector } from "viem";
import {
  RECEIPT_LEAF_DOMAIN,
  paymentReceiptLeaf,
  verifyPaymentReceiptLeaf,
  cleanReceiptLabel,
  buildPrivatePaymentWithReceipt,
  buildPaymentReceipt,
  checkPaymentReceipt,
  paymentProofText,
  agentSigningAllowlist,
  verifyGroth16,
  GLOAM_VAULT_AGENT_ABI,
  PAY_MEMO_ABI,
  POOL_TRANSFER_ABI,
  IncrementalMerkleTreePoseidon,
  makeBoundNotePoseidon,
  generateReceiveKey,
  openSealedTicket,
  decodeNotePackage,
  proofContext,
  readReceiptSignals,
  hexToField,
  FIELD_PRIME,
  NATIVE_ASSET,
  RH_MAINNET_CHAIN_ID,
  RH_TESTNET_CHAIN_ID,
  RH_MAINNET_USDG,
  RH_MAINNET_GRIFT,
  RH_USDG,
  SEALED_VAULT,
  GLOAM_PAY_MEMO,
  networkForChainId,
  mainnetNetwork,
} from "../dist/index.js";

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  checks++;
}
async function throws(fn, msg) {
  try {
    await fn();
  } catch {
    checks++;
    return;
  }
  console.error("FAIL: expected a throw:", msg);
  process.exit(1);
}

// ── the leaf ────────────────────────────────────────────────────────────────

const VAULT = "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194";
const base = {
  chainId: 4663,
  pool: VAULT,
  txHash: "0x" + "ab".repeat(32),
  publicSignals: ["1", "2", "3", "4", "0", "0", "7"],
};

assert(RECEIPT_LEAF_DOMAIN === "gloam.receipt-leaf.v1", "the domain tag is v1");
// Pinned: keccak256(abi.encode("gloam.receipt-leaf.v1", uint256(4663), address(VAULT), bytes32(0xabab…), uint256[7]([1,2,3,4,0,0,7])))
// in Solidity 0.8 and `cast keccak $(cast abi-encode "f(string,uint256,address,bytes32,uint256[7])" …)`.
const VECTOR = "0x291b8e3fbf8cbf7df0224dccd56f8d22dbdf2ce5b2d9359de28cece4e63ba025";
const leaf = paymentReceiptLeaf(base);
assert(leaf === VECTOR, `the leaf matches the Solidity vector (got ${leaf})`);
assert(paymentReceiptLeaf(base) === leaf, "the same input gives the same leaf");
assert(paymentReceiptLeaf({ ...base, pool: VAULT.toLowerCase() }) === leaf, "the pool's letter case does not change the leaf");
assert(paymentReceiptLeaf({ ...base, txHash: base.txHash.toUpperCase().replace("0X", "0x") }) === leaf, "the hash's letter case does not change the leaf");
assert(paymentReceiptLeaf({ ...base, publicSignals: base.publicSignals.map(BigInt) }) === leaf, "bigint and string signals give the same leaf");

const changed = [
  { ...base, chainId: 46630 },
  { ...base, pool: SEALED_VAULT },
  { ...base, txHash: "0x" + "ac".repeat(32) },
  ...base.publicSignals.map((_, i) => ({
    ...base,
    publicSignals: base.publicSignals.map((s, j) => (j === i ? (i === 4 ? "1" : String(BigInt(s) + 1n)) : s)),
  })),
];
const leaves = new Set(changed.map(paymentReceiptLeaf));
assert(leaves.size === changed.length && !leaves.has(leaf), "every field (chain, pool, tx, each signal) changes the leaf");

await throws(() => paymentReceiptLeaf({ ...base, publicSignals: base.publicSignals.slice(0, 6) }), "six signals");
await throws(() => paymentReceiptLeaf({ ...base, publicSignals: [...base.publicSignals.slice(0, 6), FIELD_PRIME.toString()] }), "a signal at the field prime");
await throws(() => paymentReceiptLeaf({ ...base, publicSignals: ["1", "2", "3", "4", "2", "0", "7"] }), "reveal 2");
await throws(() => paymentReceiptLeaf({ ...base, publicSignals: ["1", "2", "3", "4", "0", "0", "0x7"] }), "a hex signal");
await throws(() => paymentReceiptLeaf({ ...base, txHash: "0x1234" }), "a short hash");
await throws(() => paymentReceiptLeaf({ ...base, chainId: 0 }), "chain 0");

assert(verifyPaymentReceiptLeaf(VECTOR, base), "verify: the right leaf");
assert(verifyPaymentReceiptLeaf(VECTOR.toUpperCase().replace("0X", "0x"), base), "verify: letter case does not matter");
assert(!verifyPaymentReceiptLeaf(VECTOR, { ...base, chainId: 46630 }), "verify: another chain fails");
assert(!verifyPaymentReceiptLeaf(VECTOR, { ...base, publicSignals: ["1", "2", "3", "5", "0", "0", "7"] }), "verify: another minimum fails");
assert(!verifyPaymentReceiptLeaf("0x" + "00".repeat(32), base), "verify: another leaf fails");
assert(!verifyPaymentReceiptLeaf("nope", base), "verify: a malformed leaf is false, not a throw");
assert(!verifyPaymentReceiptLeaf(VECTOR, { ...base, publicSignals: ["1"] }), "verify: malformed fields are false, not a throw");

// ── labels ──────────────────────────────────────────────────────────────────

assert(cleanReceiptLabel("  nightly-root:sale:8812 ") === "nightly-root:sale:8812", "labels are trimmed");
assert(cleanReceiptLabel("a‮b   c") === "ab c", "hidden characters are dropped, spaces squeezed");
await throws(() => cleanReceiptLabel("   "), "an empty label");
await throws(() => cleanReceiptLabel("x".repeat(81)), "a label over 80 characters");

// ── the allowlist ───────────────────────────────────────────────────────────

// Selectors pinned with `cast sig`.
const SELECTORS = {
  "approve(address,uint256)": "0x095ea7b3",
  "shieldBound(address,uint256,bytes32,bytes)": "0x67e763e0",
  "transfer(bytes,bytes32,bytes32,bytes32[2])": "0xd02dddd1",
  "unshield(bytes,bytes32,bytes32,address,address,uint256)": "0x67cca6c5",
  "postMemo(bytes32,bytes)": "0x82301844",
};
const list = agentSigningAllowlist({
  chainId: RH_MAINNET_CHAIN_ID,
  assets: [
    { symbol: "USDG", address: RH_MAINNET_USDG },
    { symbol: "GRIFT", address: RH_MAINNET_GRIFT },
  ],
});
const byId = Object.fromEntries(list.map((e) => [e.id, e]));
assert(list.length === 6, `six entries: two approvals, three vault calls, one memo (got ${list.length})`);
for (const e of list) {
  assert(SELECTORS[e.signature] === e.selector, `${e.id}: ${e.signature} is ${SELECTORS[e.signature]} (got ${e.selector})`);
  assert(toFunctionSelector(e.signature) === e.selector, `${e.id}: the selector is the signature's`);
  assert(e.chainId === RH_MAINNET_CHAIN_ID && e.value === "0", `${e.id}: Robinhood Chain mainnet, no value`);
}
const abiSelectors = new Set([...GLOAM_VAULT_AGENT_ABI, ...PAY_MEMO_ABI, ...POOL_TRANSFER_ABI].map((f) => toFunctionSelector(f)));
for (const id of ["gloam.vault.shieldBound", "gloam.vault.transfer", "gloam.vault.unshield", "gloam.memo.postMemo"]) {
  assert(abiSelectors.has(byId[id].selector), `${id} matches the ABI the SDK signs with`);
}
assert(toFunctionSelector(POOL_TRANSFER_ABI[0]) === byId["gloam.vault.transfer"].selector, "the vault transfer is the sweep's transfer");
const vault = mainnetNetwork("robinhood").pool.toLowerCase();
assert(vault === VAULT.toLowerCase(), "the Robinhood Chain mainnet vault is 0x39E2…0194");
for (const id of ["gloam.vault.shieldBound", "gloam.vault.transfer", "gloam.vault.unshield"]) {
  assert(byId[id].to.toLowerCase() === vault, `${id} goes to the vault`);
}
assert(byId["erc20.usdg.approve"].to === RH_MAINNET_USDG, "the USDG approval goes to USDG");
assert(byId["erc20.grift.approve"].to === RH_MAINNET_GRIFT, "the GRIFT approval goes to GRIFT");
assert(byId["erc20.usdg.approve"].rules.some((r) => r.toLowerCase().includes(vault)), "an approval names the vault as the only spender");
assert(byId["gloam.memo.postMemo"].to === "0x01B3172d9900Cb26d57E986429b9b23854c74598", "postMemo goes to the mainnet board");
const all = agentSigningAllowlist();
const listedTokens = mainnetNetwork("robinhood").assets.filter((a) => a.address !== NATIVE_ASSET);
assert(all.filter((e) => e.signature.startsWith("approve")).length === listedTokens.length, "by default, an approval per listed token");
assert(!all.some((e) => e.id === "erc20.eth.approve") && all.every((e) => e.value === "0"), "native ETH is listed, but the allowlist stays tokens only: no approval for it and no value");
const testnet = agentSigningAllowlist({ chainId: RH_TESTNET_CHAIN_ID, assets: [{ symbol: "USDG", address: RH_USDG }] });
assert(testnet.find((e) => e.id === "gloam.vault.transfer").to === SEALED_VAULT, "testnet: the testnet vault");
assert(testnet.find((e) => e.id === "gloam.memo.postMemo").to === GLOAM_PAY_MEMO, "testnet: the testnet board");

// ── pay privately, then the receipt ─────────────────────────────────────────

const chainId = RH_TESTNET_CHAIN_ID;
const asset = RH_USDG;
const tree = new IncrementalMerkleTreePoseidon();
for (let i = 1; i <= 3; i++) await tree.insert(BigInt(1000 + i)); // other people's notes
const funding = await makeBoundNotePoseidon(100_000_000n, asset);
const fundingIndex = await tree.insert(funding.commitmentField);
const payee = await generateReceiveKey();
const stubTransfer = async () => ({ proofBytes: "0x" });
const expiresAt = Math.floor(Date.now() / 1000) + 3600;

const pay = await buildPrivatePaymentWithReceipt({
  payTo: payee.tag,
  chainId,
  asset,
  amountWei: 25_000_000n,
  from: { secretHex: funding.secret, amountWei: 100_000_000n, path: await tree.path(fundingIndex) },
  prove: stubTransfer,
  note: "order 8812",
  receipt: { verifier: " nightly-root:sale:8812 ", expiresAt },
});
assert(pay.intent.exec.fn === "transfer" && pay.intent.exec.poolAddress === SEALED_VAULT, "the payment is a vault transfer on the testnet vault");
assert(pay.intent.exec.args[3][0] === pay.paymentNote.commitment, "the payment note is the transfer's first commitment");
assert(pay.paymentNote.amountWei === "25000000" && pay.changeNote.amountWei === "75000000", "25 paid, 75 change");
const opened = decodeNotePackage(await openSealedTicket(pay.sealedTicket, payee));
assert(opened.secret === pay.paymentNote.secret && opened.chainId === chainId && opened.note === "order 8812", "the payee opens the ticket: secret, chain and note");
await throws(async () => openSealedTicket(pay.sealedTicket, await generateReceiveKey()), "another key cannot open the ticket");
assert(pay.memo && pay.memo.address === GLOAM_PAY_MEMO && pay.memo.args[0] === pay.paymentNote.commitment, "the memo posts to the board, keyed by the payment");
assert(hexToString(pay.memo.args[1]) === pay.sealedTicket, "the memo carries the sealed ticket");
const plan = pay.receiptPlan;
assert(plan.verifier === "nightly-root:sale:8812" && plan.expiresAt === expiresAt, "the label is cleaned into the plan");
assert(plan.context === proofContext({ kind: "payment", chainId, pool: SEALED_VAULT, verifier: plan.verifier, expiresAt }), "the plan's context is the payment context");
assert(!plan.reveal && plan.minAmountWei === 25_000_000n, "by default the receipt shows a minimum of the whole amount, not the amount");

await throws(
  () => buildPrivatePaymentWithReceipt({ ...{ payTo: "0x" + "11".repeat(20), chainId, asset, amountWei: 1n, prove: stubTransfer }, from: { secretHex: funding.secret, amountWei: 100_000_000n, path: { leaf: 0n } }, receipt: { verifier: "x" } }),
  "payTo must be a receive tag"
);
await throws(
  () => buildPrivatePaymentWithReceipt({ payTo: payee.tag, chainId, asset, amountWei: 200_000_000n, prove: stubTransfer, from: { secretHex: funding.secret, amountWei: 100_000_000n, path: { leaf: 0n } }, receipt: { verifier: "x" } }),
  "a payment larger than the funding note"
);
await throws(
  () => buildPrivatePaymentWithReceipt({ payTo: payee.tag, chainId, asset, amountWei: 1n, prove: stubTransfer, from: { secretHex: funding.secret, amountWei: 100_000_000n, path: { leaf: 0n } }, receipt: { verifier: "x", expiresAt: 1 } }),
  "an expiry in the past"
);

// The transfer lands: both new notes enter the tree.
const paymentIndex = await tree.insert(hexToField(pay.paymentNote.commitment));
await tree.insert(hexToField(pay.changeNote.commitment));
const txHash = "0x" + "5a".repeat(32);

// Testnet records are test value. These run without the circuit files: the vault check
// and the network fields come before any proof or chain read.
{
  const skel = (chainId, pool) => ({
    v: 1, kind: "payment", chainId, pool, verifier: "x", expiresAt: 4102444800, asset: NATIVE_ASSET,
    commitment: "0x" + "00".repeat(32), amount: null, minAmount: "1", txHash: "0x" + "ab".repeat(32),
    proof: null, publicSignals: [], leaf: "0x" + "00".repeat(32),
  });
  const vaultOf = (r) => r.checks.find((c) => c.id === "vault");
  const baseSepolia = await checkPaymentReceipt(skel(84532, VAULT));
  assert(!baseSepolia.ok && vaultOf(baseSepolia).state === "fail" && /84532 is a Gloam testnet/.test(vaultOf(baseSepolia).detail), "Base Sepolia (mainnet vault address, final keys): refused by default");
  assert(baseSepolia.testnet === true && baseSepolia.network === "base", "Base Sepolia: the result says testnet and names it");
  const baseSepoliaOk = await checkPaymentReceipt(skel(84532, VAULT), { allowTestnet: true });
  assert(vaultOf(baseSepoliaOk).state === "pass" && /testnet/.test(vaultOf(baseSepoliaOk).detail) && baseSepoliaOk.testnet === true, "Base Sepolia with allowTestnet: the vault check passes, still marked testnet");
  const ethSepolia = networkForChainId(11155111);
  const sep = await checkPaymentReceipt(skel(11155111, ethSepolia.pool));
  assert(vaultOf(sep).state === "fail" && sep.testnet === true && sep.network === "ethereum", "Ethereum Sepolia: refused by default");
  const devKeys = await checkPaymentReceipt(skel(RH_TESTNET_CHAIN_ID, SEALED_VAULT));
  assert(vaultOf(devKeys).state === "fail" && devKeys.testnet === true && devKeys.network === "robinhood", "Robinhood Chain testnet (dev keys): refused by default");
  const baseMain = await checkPaymentReceipt(skel(8453, VAULT));
  assert(vaultOf(baseMain).state === "pass" && baseMain.testnet === false && baseMain.network === "base-mainnet", "Base mainnet: the vault check passes, not a testnet");
  const baseMainOpt = await checkPaymentReceipt(skel(8453, VAULT), { allowTestnet: true });
  assert(vaultOf(baseMainOpt).state === "pass" && !/testnet/.test(vaultOf(baseMainOpt).detail), "allowTestnet changes nothing for a mainnet record");
  const unknown = await checkPaymentReceipt(skel(999, VAULT));
  assert(vaultOf(unknown).state === "fail" && unknown.network === null && unknown.testnet === null, "an unknown chain: no network, testnet null");
}

const circuits = join(dirname(fileURLToPath(import.meta.url)), "../../../app/public/circuits");
let proved = 0;
if (existsSync(join(circuits, "receipt_final.zkey")) && existsSync(join(circuits, "receipt.wasm"))) {
  const snarkjs = await import("snarkjs");
  const vkey = JSON.parse(readFileSync(join(circuits, "receipt_vkey.json"), "utf8"));
  const prove = (input) => snarkjs.groth16.fullProve(input, join(circuits, "receipt.wasm"), join(circuits, "receipt_final.zkey"));
  const record = await buildPaymentReceipt({ plan, path: await tree.path(paymentIndex), txHash, prove });
  proved++;
  const s = readReceiptSignals(record.publicSignals);
  assert(s.root === tree.currentRoot && hexToField(record.commitment) === s.commitment, "the receipt is against the tree root, for the payment note");
  assert(record.amount === null && record.minAmount === "25000000" && s.shownAmount === 0n, "the amount stays hidden, the minimum shows");
  assert(record.leaf === paymentReceiptLeaf(record), "the record carries its own leaf");
  assert(verifyPaymentReceiptLeaf(record.leaf, { chainId, pool: SEALED_VAULT, txHash, publicSignals: record.publicSignals }), "the leaf recomputes from chain, pool, tx and signals");

  const verifySnark = (signals, proof) => verifyGroth16(vkey, signals, proof);
  assert(await verifyGroth16(vkey, record.publicSignals, record.proof), "verifyGroth16: the receipt verifies");
  assert(!(await verifyGroth16(vkey, record.publicSignals, null)), "verifyGroth16: no proof is false");
  assert(!(await verifyGroth16(vkey, ["0x1"], record.proof)), "verifyGroth16: hex signals are false, not a throw");
  const transferredLog = (commitments) => ({
    address: SEALED_VAULT.toLowerCase(),
    topics: encodeEventTopics({
      abi: [{ type: "event", name: "Transferred", inputs: [{ name: "nullifier", type: "bytes32", indexed: true }, { name: "newCommitments", type: "bytes32[2]", indexed: false }] }],
      eventName: "Transferred",
      args: { nullifier: "0x" + "0e".repeat(32) },
    }),
    data: encodeAbiParameters([{ type: "bytes32[2]" }], [commitments]),
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: txHash,
    transactionIndex: 0,
    blockHash: "0x" + "00".repeat(32),
    removed: false,
  });
  const chain = (over = {}) => ({
    getChainId: async () => over.chainId ?? chainId,
    readContract: async ({ functionName, args }) => {
      if (functionName !== "isKnownRoot") throw new Error("unexpected read");
      return over.rootKnown ?? hexToField(args[0]) === tree.currentRoot;
    },
    getTransactionReceipt: async ({ hash }) => {
      if (hash !== txHash) throw new Error(`Transaction receipt with hash "${hash}" could not be found.`);
      return { status: over.status ?? "success", logs: [transferredLog(over.commitments ?? pay.intent.exec.args[3])] };
    },
  });
  const state = (r, id) => r.checks.find((c) => c.id === id).state;

  const full = await checkPaymentReceipt(record, { verifySnark, client: chain(), allowTestnet: true });
  assert(full.ok && full.checks.length === 8 && !full.expired, `a good record passes every check (${JSON.stringify(full.checks.filter((c) => c.state !== "pass"))})`);
  assert(full.testnet === true && full.network === "robinhood", "allowTestnet: the result still says the record is from a testnet");
  // A testnet record is test value: never ok unless the caller opts in.
  const testDefault = await checkPaymentReceipt(record, { verifySnark, client: chain() });
  assert(!testDefault.ok && state(testDefault, "vault") === "fail" && /testnet/.test(testDefault.checks.find((c) => c.id === "vault").detail), "a testnet record fails the vault check by default");
  assert(state(testDefault, "root") === "skipped" && testDefault.testnet === true && testDefault.network === "robinhood", "and is not read on chain, and the result names its testnet");
  const offline = await checkPaymentReceipt(record, { verifySnark, allowTestnet: true });
  assert(!offline.ok && state(offline, "snark") === "pass" && state(offline, "root") === "skipped", "offline: the proof checks, the chain checks are skipped, so not ok");
  const bare = await checkPaymentReceipt(record, { allowTestnet: true });
  assert(!bare.ok && state(bare, "leaf") === "pass" && state(bare, "snark") === "skipped", "no snark check given: never ok");
  const later = await checkPaymentReceipt(record, { verifySnark, client: chain(), now: expiresAt + 1, allowTestnet: true });
  assert(later.ok && later.expired, "past its expiry the record still checks, and says it is expired");

  const otherLeaf = await checkPaymentReceipt(record, { verifySnark, client: chain(), leaf: VECTOR, allowTestnet: true });
  assert(!otherLeaf.ok && state(otherLeaf, "leaf") === "fail", "a leaf from another record fails");
  const edited = await checkPaymentReceipt({ ...record, minAmount: "1" }, { verifySnark, client: chain(), allowTestnet: true });
  // The leaf binds the signals; the plain fields are checked against them.
  assert(!edited.ok && state(edited, "fields") === "fail" && state(edited, "leaf") === "pass", "an edited plain minimum fails the fields check");
  const relabeled = { ...record, verifier: "someone else" };
  const relabel = await checkPaymentReceipt({ ...relabeled, leaf: paymentReceiptLeaf(relabeled) }, { verifySnark, client: chain(), allowTestnet: true });
  assert(!relabel.ok && state(relabel, "context") === "fail", "a new label fails the context check");
  const forged = record.publicSignals.slice();
  forged[3] = "1";
  const forgedRec = { ...record, minAmount: "1", publicSignals: forged };
  const forge = await checkPaymentReceipt({ ...forgedRec, leaf: paymentReceiptLeaf(forgedRec) }, { verifySnark, client: chain(), allowTestnet: true });
  assert(!forge.ok && state(forge, "snark") === "fail", "edited signals with a fresh leaf fail the proof");
  const wrongChain = await checkPaymentReceipt(record, { verifySnark, client: chain({ chainId: 4663 }), allowTestnet: true });
  assert(!wrongChain.ok && state(wrongChain, "chain") === "fail", "a client on another chain fails");
  const noRoot = await checkPaymentReceipt(record, { verifySnark, client: chain({ rootKnown: false }), allowTestnet: true });
  assert(!noRoot.ok && state(noRoot, "root") === "fail", "a root the vault never had fails");
  const asChange = await checkPaymentReceipt(record, { verifySnark, client: chain({ commitments: [pay.changeNote.commitment, pay.paymentNote.commitment] }), allowTestnet: true });
  assert(!asChange.ok && state(asChange, "payment") === "fail" && /change/.test(asChange.checks.find((c) => c.id === "payment").detail), "the change side of a transfer is not a payment");
  const reverted = await checkPaymentReceipt(record, { verifySnark, client: chain({ status: "reverted" }), allowTestnet: true });
  assert(!reverted.ok && state(reverted, "payment") === "fail", "a reverted transaction fails");
  const otherTx = { ...record, txHash: "0x" + "77".repeat(32) };
  const missing = await checkPaymentReceipt({ ...otherTx, leaf: paymentReceiptLeaf(otherTx) }, { verifySnark, client: chain(), allowTestnet: true });
  assert(!missing.ok && state(missing, "payment") === "fail", "a transaction the chain does not have fails");
  const offVault = { ...record, pool: VAULT };
  const off = await checkPaymentReceipt({ ...offVault, leaf: paymentReceiptLeaf(offVault) }, { verifySnark, client: chain(), allowTestnet: true });
  assert(!off.ok && state(off, "vault") === "fail" && state(off, "root") === "skipped", "a record naming another vault fails before any chain read");

  const text = paymentProofText(record);
  assert(text.startsWith("gloampay1:"), "the record reads as a gloampay1 proof");
  const json = JSON.parse(Buffer.from(text.slice("gloampay1:".length), "base64").toString("utf8"));
  assert(json.kind === "payment" && json.txHash === txHash && !("leaf" in json) && json.verifier === plan.verifier, "gloampay1 carries the proof fields, not the leaf");

  const otherPath = await tree.path(0);
  await throws(() => buildPaymentReceipt({ plan, path: otherPath, txHash, prove }), "a path to another note is refused before proving");
  // snarkjs keeps curve worker threads alive.
  globalThis.curve_bn128?.terminate?.();
}

console.log(`commerce.selftest: ok (${checks} assertions${proved ? `, ${proved} receipt proved and checked` : ", artifacts absent: proving skipped"})`);
process.exit(0);
