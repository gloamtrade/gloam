/**
 * x402 scheme gloam-cashout: parsing a 402, the refusals before paying, the
 * X-PAYMENT round trip, the gross math, paying with a stub prover and send, and
 * the gateway verifier against mocked receipts (pass, and each way it fails).
 *
 * Run after build:  node test/x402Cashout.selftest.mjs
 */
import { encodeEventTopics, pad, parseAbiItem, toHex } from "viem";
import {
  GLOAM_CASHOUT_ASSET,
  GLOAM_CASHOUT_NETWORK,
  GLOAM_CASHOUT_REPLAY_NOTE,
  GLOAM_CASHOUT_SCHEME,
  GLOAM_CASHOUT_VAULT,
  GLOAM_X402_SCHEME,
  IncrementalMerkleTreePoseidon,
  UNSHIELDED_EVENT,
  assertGloamCashoutPayable,
  buildGloamCashoutIntent,
  buildGloamCashoutRequirement,
  cashOutFee,
  cashoutGross,
  chooseGloamX402Scheme,
  decodeGloamCashoutHeader,
  encodeGloamCashoutHeader,
  fieldToHex,
  findGloamCashoutRequirement,
  gloamCashoutProblem,
  noteCommitmentPoseidon,
  parseGloamCashoutRequirement,
  payGloamCashout,
  quoteGross,
  verifyGloamCashout,
  x402AcceptsOf,
} from "../dist/index.js";

let checks = 0;
const assert = (c, m) => {
  if (!c) {
    console.error("FAIL:", m);
    process.exit(1);
  }
  checks++;
};
const throwsCode = async (fn, code, m) => {
  try {
    await fn();
  } catch (e) {
    assert(e.code === code || String(e.message).includes(code), `${m}: got ${e.code ?? e.message}`);
    return;
  }
  assert(false, `${m}: did not throw`);
};

const SPLITTER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const PRICE = 1_000_000n; // 1 USDG
const BPS = 50;
const G = cashoutGross(PRICE, 37, BPS);
const entry = {
  scheme: "gloam-cashout",
  network: "eip155:4663",
  asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  payTo: SPLITTER,
  amount: G.toString(),
  quoteId: "q_9f8e7d6c",
  maxTimeoutSeconds: 120,
};
const ok = (over = {}) => parseGloamCashoutRequirement({ ...entry, ...over });

// 1) Gross math: ceil(price*10000/(10000-bps)) + tag, and payTo gets at least the price.
{
  // 1_000_000 * 10000 / 9950 = 1_005_025.12... -> 1_005_026, + 37
  assert(G === 1_005_063n, `gross ${G}`);
  for (const [p, bps] of [[1n, 50], [999_999n, 50], [10_000_000n, 25], [123_456_789n, 100], [7n, 0]]) {
    for (const tag of [1, 5000, 9999]) {
      const g = cashoutGross(p, tag, bps);
      assert(g - cashOutFee(g, bps) >= p, `payTo gets the price (${p} at ${bps} bps, tag ${tag})`);
    }
  }
  await throwsCode(() => cashoutGross(PRICE, 0, BPS), "tag must be", "tag 0 is refused");
  await throwsCode(() => cashoutGross(PRICE, 10000, BPS), "tag must be", "tag 10000 is refused");
  const fake = { readContract: async ({ functionName }) => (functionName === "withdrawFeeBps" ? 50 : null) };
  const q = await quoteGross(PRICE, 37, { client: fake });
  assert(q.gross === G && q.feeBps === 50 && q.fee === cashOutFee(G, 50) && q.payeeReceives === G - q.fee && q.payeeReceives >= PRICE, "quoteGross reads the live fee");
}

// 2) Parsing: from a v2 PAYMENT-REQUIRED header and from a JSON body, next to exact.
{
  const exact = { scheme: "exact", network: "eip155:4663", amount: "1000000", asset: entry.asset, payTo: SPLITTER, maxTimeoutSeconds: 60 };
  const v2 = { x402Version: 2, accepts: [exact, entry] };
  const headers = new Headers({ "payment-required": Buffer.from(JSON.stringify(v2)).toString("base64") });
  const r = findGloamCashoutRequirement(headers, "{}");
  assert(r && r.scheme === GLOAM_CASHOUT_SCHEME && r.amount === G.toString() && r.quoteId === "q_9f8e7d6c" && r.maxTimeoutSeconds === 120, "found in PAYMENT-REQUIRED");
  assert(x402AcceptsOf(headers, "{}").length === 2, "both accepts entries read");
  const b = findGloamCashoutRequirement(new Headers(), JSON.stringify({ x402Version: 1, accepts: [exact, entry] }));
  assert(b && b.payTo === SPLITTER, "found in the body");
  assert(findGloamCashoutRequirement({ "Payment-Required": headers.get("payment-required") }, "") !== null, "a plain header record works");
  assert(findGloamCashoutRequirement(new Headers(), JSON.stringify({ accepts: [exact] })) === null, "exact alone is not gloam-cashout");
  assert(parseGloamCashoutRequirement({ scheme: "exact" }) === null, "other schemes read as null");
  const quoted = ok({ quoteId: "  keep  me  " });
  assert(quoted.quoteId === "  keep  me  ", "quoteId is passed through untouched");
  assert(ok({ quoteId: undefined, extra: { quoteId: "from-extra" } }).quoteId === "from-extra", "quoteId from extra");
  assert(ok({ expiresAt: "2026-11-05T12:00:00Z" }).expiresAt === Date.parse("2026-11-05T12:00:00Z") / 1000, "ISO expiry");
  assert(ok({ expiresAt: 1_800_000_000_000 }).expiresAt === 1_800_000_000, "millisecond expiry");
  assert(ok({ amount: undefined, maxAmountRequired: "42" }).amount === "42", "v1 maxAmountRequired read as amount");
}

// 3) Choosing: both offered keeps gloam-private unless the caller prefers cashout; cashout alone is picked.
{
  assert(chooseGloamX402Scheme({ gloamPrivate: true, gloamCashout: true }) === GLOAM_X402_SCHEME, "both: private by default");
  assert(chooseGloamX402Scheme({ gloamPrivate: true, gloamCashout: true }, "gloam-cashout") === GLOAM_CASHOUT_SCHEME, "both: the caller can pick cashout");
  assert(chooseGloamX402Scheme({ gloamPrivate: false, gloamCashout: true }) === GLOAM_CASHOUT_SCHEME, "cashout alone (or next to exact) is picked");
  assert(chooseGloamX402Scheme({ gloamPrivate: false, gloamCashout: true }, "gloam-private") === GLOAM_CASHOUT_SCHEME, "a preference not offered falls back");
  assert(chooseGloamX402Scheme({ gloamPrivate: false, gloamCashout: false }) === null, "nothing Gloam offered");
}

// 4) Refusals before paying.
{
  const max = 2_000_000n;
  const code = (req, opts = { maxAmount: max }) => gloamCashoutProblem(req, opts)?.code ?? null;
  assert(code(ok()) === null, "a good quote passes");
  assert(code(ok({ network: 4663 })) === null, "bare chain id passes");
  assert(code(ok({ network: "eip155:8453" })) === "wrong_network", "wrong network");
  assert(code(ok({ network: "eip155:46630" })) === "wrong_network", "testnet refused");
  assert(code(ok({ asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" })) === "wrong_asset", "wrong asset");
  assert(code(ok({ vault: OTHER })) === "wrong_vault", "wrong vault");
  assert(code(ok({ vault: GLOAM_CASHOUT_VAULT.toLowerCase() })) === null, "the Gloam vault, any case");
  assert(code(ok({ payTo: "splitter.eth" })) === "bad_payee", "payTo not an address");
  assert(code(ok({ payTo: GLOAM_CASHOUT_VAULT })) === "bad_payee", "payTo the vault is refused");
  assert(code(ok({ payTo: GLOAM_CASHOUT_ASSET })) === "bad_payee", "payTo the token is refused");
  assert(code(ok({ amount: "0" })) === "bad_amount", "zero amount");
  assert(code(ok({ amount: "1.5" })) === "bad_amount", "fractional amount");
  assert(code(ok({ amount: "-5" })) === "bad_amount", "negative amount");
  assert(code(ok({ quoteId: undefined })) === "no_quote_id", "missing quoteId");
  assert(code(ok({ quoteId: "" })) === "no_quote_id", "empty quoteId");
  assert(code(ok({ quoteId: 12345 })) === "no_quote_id", "non-string quoteId");
  assert(code(ok(), { maxAmount: undefined }) === "no_max_amount", "no maxAmount, no payment");
  assert(code(ok(), { maxAmount: G - 1n }) === "over_max_amount", "over maxAmount");
  assert(code(ok(), { maxAmount: G }) === null, "exactly maxAmount passes");
  assert(code(ok({ expiresAt: 1_000 }), { maxAmount: max, now: 2_000 }) === "expired", "expired");
  assert(code(ok({ expiresAt: 3_000 }), { maxAmount: max, now: 2_000 }) === null, "not yet expired");
  await throwsCode(() => assertGloamCashoutPayable(ok({ network: "eip155:1" }), { maxAmount: max }), "wrong_network", "assert throws the refusal");
  const built = buildGloamCashoutRequirement({ payTo: SPLITTER, gross: G, quoteId: "q1", maxTimeoutSeconds: 90 });
  assert(built.network === GLOAM_CASHOUT_NETWORK && built.asset === GLOAM_CASHOUT_ASSET && gloamCashoutProblem(built, { maxAmount: G }) === null, "the gateway builder makes a payable entry");
}

// 5) The X-PAYMENT header round trip: base64 JSON {scheme, txHash, quoteId}.
{
  const txHash = `0x${"ab".repeat(32)}`;
  const h = encodeGloamCashoutHeader({ txHash, quoteId: "q_9f8e7d6c" });
  const raw = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  assert(JSON.stringify(Object.keys(raw)) === JSON.stringify(["scheme", "txHash", "quoteId"]), "exactly three fields");
  assert(raw.scheme === "gloam-cashout" && raw.txHash === txHash && raw.quoteId === "q_9f8e7d6c", "plain base64 JSON");
  const back = decodeGloamCashoutHeader(h);
  assert(back.txHash === txHash && back.quoteId === "q_9f8e7d6c", "round trip");
  const odd = encodeGloamCashoutHeader({ txHash, quoteId: "ключ ✓" });
  assert(decodeGloamCashoutHeader(odd).quoteId === "ключ ✓", "non-ASCII quoteId survives");
  await throwsCode(() => decodeGloamCashoutHeader("not base64 json"), "base64", "garbage refused");
  await throwsCode(() => decodeGloamCashoutHeader(Buffer.from(JSON.stringify({ scheme: "gloam-private" })).toString("base64")), "not a gloam-cashout", "other scheme refused");
  await throwsCode(() => encodeGloamCashoutHeader({ txHash: "0x12", quoteId: "q" }), "not a transaction hash", "bad hash refused");
}

// 6) Paying: the note must be exactly G; the cash out goes to payTo and the header carries its hash.
const NULL_SECRET = 77n;
async function pathFor(secret, amount, asset) {
  const tree = new IncrementalMerkleTreePoseidon();
  await tree.insert(await noteCommitmentPoseidon(secret, amount, asset));
  await tree.insert(await noteCommitmentPoseidon(9n, 1n, asset));
  return tree.path(0);
}
const unshieldLog = ({ address = GLOAM_CASHOUT_VAULT, nullifier = `0x${"0c".repeat(32)}`, asset = GLOAM_CASHOUT_ASSET, to = SPLITTER, amount = G } = {}) => ({
  address,
  topics: encodeEventTopics({ abi: [UNSHIELDED_EVENT], eventName: "Unshielded", args: { nullifier, asset, to } }),
  data: toHex(amount, { size: 32 }),
});
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const transferLog = ({ token = GLOAM_CASHOUT_ASSET, from = GLOAM_CASHOUT_VAULT, to = SPLITTER, value = G - cashOutFee(G, BPS) } = {}) => ({
  address: token,
  topics: encodeEventTopics({ abi: [TRANSFER], eventName: "Transfer", args: { from, to } }),
  data: toHex(value, { size: 32 }),
});
{
  const req = ok();
  const path = await pathFor(NULL_SECRET, G, GLOAM_CASHOUT_ASSET);
  const prove = async () => ({ proofBytes: "0xdeadbeef" });
  await throwsCode(
    () => buildGloamCashoutIntent({ requirement: req, maxAmount: G, note: { secretHex: fieldToHex(NULL_SECRET), amountWei: G + 1n, path }, prove }),
    "spends a whole note",
    "a note that is not exactly G is refused"
  );
  await throwsCode(
    () => buildGloamCashoutIntent({ requirement: req, maxAmount: undefined, note: { secretHex: fieldToHex(NULL_SECRET), amountWei: G, path }, prove }),
    "no_max_amount",
    "the builder needs maxAmount"
  );
  const intent = await buildGloamCashoutIntent({ requirement: req, maxAmount: G, note: { secretHex: fieldToHex(NULL_SECRET), amountWei: G, path }, prove });
  const [, , nullifier, asset, to, amount] = intent.exec.args;
  assert(intent.chainId === 4663 && intent.exec.fn === "unshield" && intent.exec.poolAddress === GLOAM_CASHOUT_VAULT, "an unshield from the RH vault");
  assert(asset === GLOAM_CASHOUT_ASSET && to.toLowerCase() === SPLITTER && amount === G, "exactly G of USDG to payTo");

  const sent = [];
  const txHash = `0x${"cd".repeat(32)}`;
  const client = {
    waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 500n, logs: [unshieldLog({ nullifier }), transferLog()] }),
  };
  const paid = await payGloamCashout({
    requirement: req,
    maxAmount: G,
    note: { secretHex: fieldToHex(NULL_SECRET), amountWei: G, path },
    prove,
    client,
    submit: async (i) => (sent.push(i), txHash),
  });
  assert(sent.length === 1 && paid.txHash === txHash && paid.gross === G, "sent once, mined");
  const h = decodeGloamCashoutHeader(paid.header);
  assert(h.txHash === txHash && h.quoteId === req.quoteId, "the header carries the hash and the quoteId");
  const headerText = Buffer.from(paid.header, "base64").toString("utf8");
  assert(!headerText.includes(fieldToHex(NULL_SECRET).slice(2)) && !/secret|note|commitment/i.test(headerText), "nothing private in the header");

  const silent = { waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 500n, logs: [] }) };
  await throwsCode(
    () => payGloamCashout({ requirement: req, maxAmount: G, note: { secretHex: fieldToHex(NULL_SECRET), amountWei: G, path }, prove, client: silent, submit: async () => txHash }),
    "did not happen",
    "a mined tx with no cash out in it is not a payment"
  );
}

// 7) The gateway verifier against mocked receipts.
{
  const txHash = `0x${"ef".repeat(32)}`;
  const issuedAt = 1_800_000_000;
  const quote = { payTo: SPLITTER, gross: G, price: PRICE, issuedAt, windowSec: 300 };
  const mock = ({ logs = [unshieldLog(), transferLog()], status = "success", time = issuedAt + 30, chainId = 4663, missing = false } = {}) => ({
    getChainId: async () => chainId,
    getTransactionReceipt: async () => {
      if (missing) throw new Error("TransactionReceiptNotFoundError");
      return { status, blockNumber: 900n, logs };
    },
    getBlock: async () => ({ timestamp: BigInt(time) }),
  });
  const v = (m, q = quote) => verifyGloamCashout({ txHash, quote: q, client: m });

  const pass = await v(mock());
  assert(pass.ok && pass.code === null && pass.received === G - cashOutFee(G, BPS) && pass.blockTime === issuedAt + 30, `passes: ${JSON.stringify(pass, (_k, x) => (typeof x === "bigint" ? x.toString() : x))}`);
  assert(pass.replay === GLOAM_CASHOUT_REPLAY_NOTE, "says the replay store is the gateway's");
  assert((await v(mock(), { ...quote, payTo: SPLITTER.toUpperCase().replace("0X", "0x") })).ok, "payTo matched in any case");

  const failCode = async (m, q) => (await v(m, q)).code;
  assert((await failCode(mock({ logs: [unshieldLog({ amount: G - 1n }), transferLog()] }))) === "wrong_amount", "wrong amount");
  assert((await failCode(mock({ logs: [unshieldLog({ amount: G + 1n }), transferLog()] }))) === "wrong_amount", "more than G is still the wrong amount");
  assert((await failCode(mock({ logs: [unshieldLog({ to: OTHER }), transferLog({ to: OTHER })] }))) === "wrong_payee", "wrong payTo");
  assert((await failCode(mock(), { ...quote, payTo: OTHER })) === "wrong_payee", "quote for another payTo");
  assert((await failCode(mock({ logs: [unshieldLog(), transferLog({ value: PRICE - 1n })] }))) === "short_transfer", "transfer below the price");
  assert((await failCode(mock({ logs: [unshieldLog()] }))) === "short_transfer", "no transfer at all");
  assert((await failCode(mock({ logs: [unshieldLog(), transferLog({ from: OTHER })] }))) === "short_transfer", "a transfer not from the vault does not count");
  assert((await failCode(mock({ logs: [unshieldLog(), transferLog({ token: OTHER })] }))) === "short_transfer", "a transfer of another token does not count");
  assert((await failCode(mock({ time: issuedAt + 301 }))) === "outside_window", "after the window");
  assert((await failCode(mock({ time: issuedAt - 1 }))) === "outside_window", "before the quote");
  assert((await failCode(mock({ time: issuedAt + 300 }))) === null, "the window's last second passes");
  assert((await failCode(mock({ logs: [unshieldLog({ address: OTHER }), transferLog()] }))) === "not_vault", "an Unshielded log from a non-vault address");
  assert((await failCode(mock({ logs: [unshieldLog({ address: OTHER }), unshieldLog({ amount: G - 5n }), transferLog()] }))) === "wrong_amount", "a fake log next to the vault's does not make the amount right");
  assert((await failCode(mock({ logs: [unshieldLog({ asset: OTHER }), transferLog()] }))) === "no_unshield", "an unshield of another asset");
  assert((await failCode(mock({ logs: [] }))) === "no_unshield", "no logs");
  assert((await failCode(mock({ status: "reverted" }))) === "reverted", "reverted");
  assert((await failCode(mock({ missing: true }))) === "not_found", "no receipt yet");
  assert((await failCode(mock({ chainId: 8453 }))) === "wrong_chain", "an RPC on another chain");
  assert((await verifyGloamCashout({ txHash: "0x1234", quote, client: mock() })).code === "bad_tx_hash", "bad hash");
  assert((await failCode(mock(), { ...quote, price: G + 1n })) === "bad_quote", "price above gross");
  assert((await failCode(mock(), { ...quote, windowSec: 0 })) === "bad_quote", "no window");
}

console.log(`x402 gloam-cashout selftest: ${checks} checks passed.`);
