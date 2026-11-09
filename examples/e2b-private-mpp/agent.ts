/**
 * An agent that buys an E2B sandbox and pays for it privately over MPP.
 *
 *   pnpm agent         (with pnpm server running)
 *
 * The agent holds a private balance (a note in the Gloam pool, made by
 * `pnpm fund`). It sends a normal E2B request; on the 402 it picks the gloam
 * offer, checks the price against its own limits, proves a private send of
 * exactly that price from its note, seals the payment to E2B's receive tag and
 * retries. In pull mode (preferred) it broadcasts nothing itself and needs no
 * gas: E2B's server submits the proven transfer through the Gloam relay, sweeps
 * the payment into a fresh note only E2B knows, and only then creates the
 * sandbox.
 *
 * Then it reads the chain the way anyone can and shows what this payment left
 * there: two pool transfers, each a nullifier and two commitments. No amount,
 * no payer, no payee.
 */
import { decodeEventLog, decodeFunctionData, erc20Abi, formatUnits, parseAbiItem, parseUnits, toEventSelector, type Hex } from "viem";
import { existsSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { Mppx } from "mppx/client";
import { gloam } from "@gloamtrade/mppx-gloam/client";
import { parsePaymentChallenges, parseReceipt } from "@gloamtrade/mppx-gloam/core";
import { createTreeSync, POOL_TRANSFER_ABI, relayIntent, type BuiltPayment } from "@gloamtrade/sdk";
import {
  agentNotes,
  ASSET,
  loadEnv,
  NET,
  Phases,
  proverFor,
  publicClient,
  sdkClient,
  SERVER_URL,
  short,
  stamp,
  treeCacheFile,
  treeParams,
  txUrl,
  type HeldNote,
} from "./common.js";

loadEnv();
const log = (s = "") => console.log(s ? `[agent ${stamp()}] ${s}` : "");
const fmt = (v: bigint) => `${formatUnits(v, ASSET.decimals)} ${ASSET.symbol}`;
const TRANSFERRED = parseAbiItem("event Transferred(bytes32 indexed nullifier, bytes32[2] newCommitments)");
const TRANSFERRED_TOPIC = toEventSelector(TRANSFERRED);
const ERC20_TRANSFER_TOPIC = toEventSelector(parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"));
const b64url = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

const URL_ = `${SERVER_URL}/sandboxes`;
const BODY = JSON.stringify({ templateID: "base", timeout: 300 });
// The agent's own limits: never more than 0.05 per request, only PathUSD, only Tempo testnet.
const POLICY = { maxAmountWei: parseUnits("0.05", ASSET.decimals), currencies: [ASSET.address], chainIds: [NET.chainId] };
const agentAddress = process.env.AGENT_TESTNET_KEY ? privateKeyToAccount(process.env.AGENT_TESTNET_KEY as Hex).address : null;

// ── the agent's private balance ─────────────────────────────────────────────
let notes = agentNotes.all();
const balance = () => notes.filter((n) => n.status === "unspent").reduce((s, n) => s + BigInt(n.amountWei), 0n);
if (balance() === 0n) throw new Error("The agent holds no private balance. Run `pnpm fund` first.");
log(`private balance ${fmt(balance())} in ${notes.filter((n) => n.status === "unspent").length} note(s) in the Gloam pool on ${NET.label} testnet`);

// ── 1. ask without paying: the same 402 E2B sends today, with a private offer added ──
const phases = new Phases();
// The pool's tree, kept in .cache/ (on the first run, Gloam's public leaf list). Each note's membership path
// comes from it with one call that asks the pool to confirm the root, side by side with the request below.
const kept = existsSync(treeCacheFile("agent"));
const tree = createTreeSync(sdkClient, treeParams("agent"));
const treeStart = Date.now();
const knownPaths = Promise.all(
  notes.filter((n) => n.status === "unspent").map(async (n) => [n.commitment.toLowerCase(), await tree.knownPath(n.commitment).catch(() => null)] as const)
).then((rows) => new Map(rows));
log(`POST ${URL_} ${BODY}`);
const first = await phases.time("402", () => fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: BODY }));
log(`${first.status} Payment Required. The offers:`);
for (const c of parsePaymentChallenges(first.headers.get("www-authenticate"))) {
  const r = (typeof c.request === "string" ? b64url(c.request) : c.request) as {
    amount: string;
    currency: string;
    recipient: string;
    methodDetails?: { chainId?: number; pool?: string };
  };
  const price = fmt(BigInt(r.amount));
  if (c.method === "gloam") {
    log(`  gloam/${c.intent}  ${price}  to receive tag ${short(r.recipient, 18)}  via pool ${short(r.methodDetails?.pool ?? "")}  (private)`);
  } else {
    log(`  ${c.method}/${c.intent}  ${price}  to wallet ${r.recipient}  (public: payer, payee and amount on chain)`);
  }
}

// ── 2. pay it with mppx + the gloam method ──────────────────────────────────
log("Finding the note's membership path in the pool's tree...");
const paths = await knownPaths;
phases.add("note path", Date.now() - Math.max(treeStart, phases.start + phases.total("402")));
const transferProver = await phases.time("load prover", () => proverFor("transfer"));
let paidAt = 0;

let spent: HeldNote | null = null;
let built: BuiltPayment | null = null;
const mppx = Mppx.create({
  polyfill: false,
  methods: [
    gloam({
      // The smallest unspent note that covers the price, with its path in the pool's tree.
      getNote: async ({ amountWei, currency }) => {
        if (currency.toLowerCase() !== ASSET.address.toLowerCase()) throw new Error(`This agent only holds ${ASSET.symbol}.`);
        const n = notes
          .filter((x) => x.status === "unspent" && BigInt(x.amountWei) >= amountWei)
          .sort((a, b) => (BigInt(a.amountWei) < BigInt(b.amountWei) ? -1 : 1))[0];
        if (!n) throw new Error("No single private note covers this charge.");
        // In the kept tree, or (a note that landed after it was kept) read the blocks since.
        let path = paths.get(n.commitment.toLowerCase()) ?? null;
        if (path) {
          log(`  path from ${kept ? "the tree kept in .cache/" : "Gloam's public leaf list (first run)"}, root confirmed by the pool, no log reads`);
        } else {
          path = await phases.time("note path", () => tree.pathForCommitment(n.commitment));
          log(`  path after reading the blocks since the kept tree (now at block ${tree.toBlock}), root confirmed by the pool`);
        }
        if (!path) throw new Error("The note is not in the pool's tree yet. Retry in a moment.");
        spent = n;
        n.status = "pending";
        log(`paying from note ${short(n.commitment)} (${fmt(BigInt(n.amountWei))})`);
        return { secret: n.secret, amountWei: BigInt(n.amountWei), path };
      },
      prove: (input) => phases.time("payment proof", () => transferProver(input)),
      mode: "auto", // pull when offered: the agent broadcasts nothing and needs no gas
      submit: (intent) => relayIntent(intent), // only used if a server accepts push only
      waitForReceipt: async (hash) => ({ status: (await publicClient.waitForTransactionReceipt({ hash })).status }),
      policy: POLICY,
      // The change note is the rest of the balance: keep it before anything is sent.
      beforeSubmit: (b, mode) => {
        built = b;
        paidAt = Date.now();
        const c = b.changeNote;
        notes.push({ secret: c.secret as Hex, commitment: c.commitment as Hex, amountWei: String(c.amountWei), status: "pending", createdAt: new Date().toISOString() });
        agentNotes.save(notes);
        log(`proved a private send of ${fmt(BigInt(b.paymentNote.amountWei))}, mode ${mode}; change note ${short(c.commitment)} kept (${fmt(BigInt(c.amountWei))})`);
      },
    }),
  ],
});

const t0 = Date.now();
const res = await mppx.fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: BODY });
const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
if (paidAt) phases.add("server: settle + sandbox", Date.now() - paidAt);
const timings = phases.summary();

// Settle the wallet: the spent note goes, the change becomes spendable (or the reservation is undone).
const change = built ? (built as BuiltPayment).changeNote : null;
const landed = change ? await publicClient.readContract({
  address: NET.pool,
  abi: [parseAbiItem("function commitmentSeen(bytes32) view returns (bool)")],
  functionName: "commitmentSeen",
  args: [change.commitment as Hex],
}) : false;
notes = notes.map((n) => {
  if (spent && n.commitment === (spent as HeldNote).commitment) return { ...n, status: landed ? "spent" : "unspent" };
  if (change && n.commitment === change.commitment) return { ...n, status: landed ? "unspent" : "spent" };
  return n;
});
agentNotes.save(notes);

if (!res.ok) {
  log(`${res.status} ${JSON.stringify(json)}`);
  process.exit(1);
}
const receipt = parseReceipt(res.headers.get("payment-receipt") ?? "");
log(`${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
log(`timings          ${timings}`);
log(`Payment-Receipt  method=${receipt.method} status=${receipt.status} chainId=${receipt.chainId} reference=${receipt.reference}`);
log(`sandbox          ${JSON.stringify(json)}`);
log(`sandboxID        ${json.sandboxID}${json.mock ? "  (MOCK: the server has no E2B_API_KEY)" : ""}`);
log(`private balance  ${fmt(balance())}`);

// ── 3. what the chain shows for this payment ────────────────────────────────
log();
log("What the chain shows for this payment (read from the public RPC, no keys):");
if (!built) throw new Error("No payment was built.");
const nullifier = ((built as BuiltPayment).intent.exec.args as readonly unknown[])[2] as Hex;
const latest = await publicClient.getBlockNumber();
const paymentLogs = await publicClient.getLogs({ address: NET.pool, event: TRANSFERRED, args: { nullifier }, fromBlock: latest - 5_000n, toBlock: latest });
const txs: { label: string; hash: Hex }[] = [];
if (paymentLogs[0]) txs.push({ label: "1. the agent's payment (pull: submitted by E2B's server through the Gloam relay)", hash: paymentLogs[0].transactionHash });
if (receipt.reference && /^0x[0-9a-fA-F]{64}$/.test(receipt.reference)) txs.push({ label: "2. E2B's sweep into a fresh note only E2B knows", hash: receipt.reference as Hex });

const amountWei = BigInt((built as BuiltPayment).paymentNote.amountWei);
for (const { label, hash } of txs) {
  const [tx, rcpt] = await Promise.all([publicClient.getTransaction({ hash }), publicClient.getTransactionReceipt({ hash })]);
  log();
  log(label);
  log(`  tx        ${txUrl(hash)}`);
  log(`  from      ${tx.from}  (the Gloam relay's account)`);
  log(`  to        ${tx.to}  (the Gloam pool)`);
  const call = decodeFunctionData({ abi: POOL_TRANSFER_ABI, data: tx.input });
  const [proof, root, nf, outs] = call.args as readonly [Hex, Hex, Hex, readonly [Hex, Hex]];
  log(`  call      ${call.functionName}(proof, root, nullifier, newCommitments)  <- the whole calldata`);
  log(`    proof           ${(proof.length - 2) / 2} bytes (Groth16)`);
  log(`    root            ${root}`);
  log(`    nullifier       ${nf}`);
  log(`    newCommitments  ${outs[0]}`);
  log(`                    ${outs[1]}`);
  for (const l of rcpt.logs) {
    if (l.address.toLowerCase() === NET.pool.toLowerCase() && l.topics[0] === TRANSFERRED_TOPIC) {
      const ev = decodeEventLog({ abi: [TRANSFERRED], data: l.data, topics: l.topics });
      log(`  event     Transferred(nullifier ${short(ev.args.nullifier)}, commitments ${short(ev.args.newCommitments[0])}, ${short(ev.args.newCommitments[1])})`);
    } else if (l.topics[0] === ERC20_TRANSFER_TOPIC) {
      const ev = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", data: l.data, topics: l.topics });
      log(`  event     token Transfer ${short(ev.args.from)} -> ${short(ev.args.to)} ${formatUnits(ev.args.value, 6)} at ${short(l.address)}  (gas fee, paid by the relay)`);
    } else {
      log(`  event     ${short(l.address)} topic ${short(l.topics[0] ?? "")}`);
    }
  }
  const blob = (tx.input + rcpt.logs.map((l) => l.data + l.topics.join("")).join("")).toLowerCase();
  const tokenMoves = rcpt.logs.filter((l) => l.topics[0] === ERC20_TRANSFER_TOPIC && l.address.toLowerCase() === ASSET.address.toLowerCase());
  const pricePaid = tokenMoves.some((l) => BigInt(l.data) === amountWei);
  log(`  agent's wallet in calldata or logs     ${agentAddress && blob.includes(agentAddress.slice(2).toLowerCase()) ? "YES" : "no"}`);
  log(`  a token transfer of the price (${fmt(amountWei)})  ${pricePaid ? "YES" : "no"}`);
  log(`  E2B's address                          none exists: E2B is paid to a receive tag, which never goes on chain`);
}
// Keep the tree with this purchase's change note in it, so the next run pays without reading logs.
await tree.sync().catch(() => undefined);

log();
log("On chain: two pool transfers, each a nullifier and two commitments, sent by the relay.");
log(`No amount, no asset, no payer, no payee. Only the agent and E2B know this was a ${fmt(amountWei)} sandbox purchase.`);

process.exit(0); // snarkjs keeps worker threads alive
