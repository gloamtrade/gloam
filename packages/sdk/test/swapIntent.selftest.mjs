/**
 * Private swap builder self-test (swapIntent.ts): quoteSwap's stops, buildSwapIntent's
 * checks and output, the recovery record, sendSwap saving before it sends, how a
 * swap's outcome is read, and its refund and exit, against a fake chain that answers
 * the way the vault, the routers and the quoters do. Real proofs are the fork test's
 * (app/scripts/fork-sdk-swaps.mts); here a prover stub stands in.
 *
 * Run after build:  node test/swapIntent.selftest.mjs
 */
import { decodeFunctionData, keccak256, zeroAddress } from "viem";
import {
  GloamApiClient,
  IncrementalMerkleTreePoseidon,
  SwapRefusedError,
  VAULT_SWAP_V3_ADDRESS,
  VAULT_SWAP_V3_LIVE,
  assertSwapSendable,
  buildSwapExit,
  buildSwapIntent,
  buildSwapRefund,
  encodeRoute,
  escrowAddress,
  exitAccount,
  exitDigest,
  fieldToHex,
  hexToField,
  makeBoundNotePoseidon,
  noteCommitmentPoseidon,
  parseSwapRecovery,
  quoteSwap,
  readCashOutFeeBps,
  readSwapOutcome,
  refundAmountFor,
  refundEscrowKey,
  relaySwapCall,
  sendSwap,
  swapJson,
  swapRouterFor,
  vaultFeeOf,
  vaultSwapAbi,
  vaultSwapV3Abi,
  buildUnshieldIntent,
} from "../dist/index.js";
import { recoverAddress } from "viem";

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  checks++;
}
async function refused(p, code, msg) {
  try {
    await p;
  } catch (e) {
    assert(e instanceof SwapRefusedError, `${msg}: SwapRefusedError (got ${e?.name}: ${e?.message})`);
    assert(e.code === code, `${msg}: code ${e.code} !== ${code} (${e.message})`);
    return e;
  }
  assert(false, `${msg}: should be refused`);
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

const VAULT = "0x39e28cde55cab798874746ac52cb4b5cc99a0194";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const GLOAM = "0xDcD885F5c60b3aD49F6D58718696417314e8724d";
const ETH_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETH_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ETH_EURC = "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c";
const PROOF = "0x" + "ab".repeat(256);
const stubProver = async () => ({ proofBytes: PROOF });
const BIG = 10n ** 30n;

/** A chain that answers like the vault, the routers and the quoters. Each knob is a field. */
function fakeChain(chainId, over = {}) {
  const s = {
    chainId,
    fee: 25,
    limitsOn: true,
    limits: {}, // asset (lowercase) -> [perDeposit, total, deposited]
    spent: new Set(),
    seen: new Set(),
    roots: new Set(),
    balances: {}, // `${asset}:${who}` lowercase -> bigint
    rate: (a) => a, // out per in, by amount
    small: null,
    cost: null, // exact-output cost (null: available - 1)
    escrowLies: false,
    gasPrice: 1_000_000_000n,
    ethUsd: 3000_00000000n,
    feedAge: 60,
    block: { number: 1000n, timestamp: 1_800_000_000n },
    receipts: {},
    logs: [],
    calls: [],
    ...over,
  };
  const lim = (a) => s.limits[a.toLowerCase()] ?? [50_000_000_000n, 2_500_000_000_000n, 0n];
  const client = {
    state: s,
    getChainId: async () => s.chainId,
    getBlock: async () => s.block,
    getBlockNumber: async () => s.block.number,
    getGasPrice: async () => s.gasPrice,
    getBalance: async ({ address }) => s.balances[`${zeroAddress}:${address.toLowerCase()}`] ?? 0n,
    getTransactionReceipt: async ({ hash }) => {
      const r = s.receipts[hash];
      if (!r) throw new Error("no receipt");
      return r;
    },
    waitForTransactionReceipt: async ({ hash }) => s.receipts[hash] ?? { status: "success", logs: [] },
    getLogs: async ({ args }) => s.logs.filter((l) => same(l.args.nullifier, args.nullifier) && same(l.args.to, args.to)),
    readContract: async ({ address, functionName, args }) => {
      s.calls.push(functionName);
      switch (functionName) {
        case "withdrawFeeBps":
          return s.fee;
        case "depositLimitsOn":
          return s.limitsOn;
        case "depositLimit":
          return lim(args[0]).slice(0, 2);
        case "deposited":
          return lim(args[0])[2];
        case "isSpent":
          return s.spent.has(args[0].toLowerCase());
        case "isKnownRoot":
          return s.roots.has(args[0].toLowerCase());
        case "commitmentSeen":
          return s.seen.has(args[0].toLowerCase());
        case "balanceOf":
          return s.balances[`${address.toLowerCase()}:${args[0].toLowerCase()}`] ?? 0n;
        case "escrowFor": {
          const real = escrowAddress(address, args[0], args[1]);
          return s.escrowLies ? "0x000000000000000000000000000000000000dEaD" : real;
        }
        case "latestRoundData":
          return [1n, s.ethUsd, 0n, BigInt(Math.floor(Date.now() / 1000) - s.feedAge), 1n];
        case "quoteSwapExactAmountIn":
        case "quoteSwapExactAmountOut":
          return args[2];
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
    multicall: async ({ contracts }) =>
      contracts.map((c) => {
        if (c.functionName === "allowedPool") return true;
        const amt = c.args[0].exactAmount;
        return { status: "success", result: [s.rate(amt), 0n] };
      }),
    simulateContract: async () => ({ result: [s.cost ?? 1n, 0n] }),
  };
  return client;
}

/** A real note in a one-leaf tree, and its path. */
async function noteWithPath(amount, asset, chain) {
  const n = await makeBoundNotePoseidon(amount, asset);
  const tree = new IncrementalMerkleTreePoseidon();
  await tree.insert(n.commitmentField);
  const path = await tree.path(0);
  chain.state.roots.add(fieldToHex(path.root).toLowerCase());
  return { note: { secretHex: n.secret, amountWei: amount, asset }, path, nullifier: n.nullifier };
}

// ── the live fee ──
{
  const c = fakeChain(4663);
  assert((await readCashOutFeeBps(c, VAULT)) === 25, "fee read live");
  c.state.fee = 70_000;
  let threw = false;
  try {
    await readCashOutFeeBps(c, VAULT);
  } catch {
    threw = true;
  }
  assert(threw, "a fee outside 0 to 10,000 is refused");
}

// ── quoteSwap: what stops a swap ──
{
  const c = fakeChain(4663);
  const ask = { client: c, chainId: 4663, assetIn: USDG, assetOut: GLOAM, amountIn: 100_000_000n };
  const q = await quoteSwap(ask);
  assert(q.stop === null && q.routerVersion === 2 && q.feeBps === 25, "a plain quote on Robinhood Chain");
  assert(q.plan.available === 100_000_000n - vaultFeeOf(100_000_000n, 25), "priced with the fee read live");
  assert(q.public.includes("hides who swapped") && q.public.includes("amounts are public"), "says what is public");
  await refused(quoteSwap({ ...ask, client: fakeChain(1) }), "wrong_chain", "a client on another chain");
  await refused(quoteSwap({ ...ask, pool: "0x0000000000000000000000000000000000000001" }), "wrong_vault", "a vault that isn't Gloam's");
  await refused(quoteSwap({ ...ask, chainId: 8453, client: fakeChain(8453), assetIn: zeroAddress, assetOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }), "no_swap", "Base while its switch is off");
  await refused(quoteSwap({ ...ask, assetOut: USDG }), "same_asset", "the same asset both ways");
  await refused(quoteSwap({ ...ask, assetOut: "0x0000000000000000000000000000000000000abc" }), "swap_asset", "an asset the router doesn't swap");
  await refused(quoteSwap({ ...ask, amountIn: 0n }), "bad_amount", "zero");
  // the refund note must fit the input asset's limit
  const tight = fakeChain(4663, { limits: { [USDG.toLowerCase()]: [10_000_000n, 2_500_000_000_000n, 0n] } });
  const q2 = await quoteSwap({ ...ask, client: tight });
  assert(q2.stop?.code === "refund_wont_fit" && q2.limits.maxIn > 0n && q2.stop.maxIn === q2.limits.maxIn, "refund_wont_fit, with the most one swap may spend");
  // the vault doesn't take the output
  const closed = fakeChain(4663, { limits: { [GLOAM.toLowerCase()]: [0n, 0n, 0n] } });
  assert((await quoteSwap({ ...ask, client: closed })).stop?.code === "vault_closed", "vault_closed");
  // the output over the room left
  const full = fakeChain(4663, { rate: (a) => a * 10n ** 12n, limits: { [GLOAM.toLowerCase()]: [10n ** 30n, 10n ** 20n, 10n ** 20n - 10n ** 18n] } });
  const q3 = await quoteSwap({ ...ask, client: full });
  assert(q3.stop?.code === "over_room" && q3.stop.fitsIn > 0n && q3.stop.fitsIn < ask.amountIn, "over_room, with about the most that fits");
  // limits off: nothing to fit
  const off = fakeChain(4663, { limitsOn: false, limits: { [USDG.toLowerCase()]: [0n, 0n, 0n] } });
  assert((await quoteSwap({ ...ask, client: off })).stop === null, "vault limits off: no limit applies");
  // the relay's own state
  assert((await quoteSwap({ ...ask, relayStatus: { chainId: 4663, enabled: false } })).stop?.code === "relay_off", "relay off");
  assert((await quoteSwap({ ...ask, relayStatus: { chainId: 4663, enabled: true, gasHigh: true } })).stop?.code === "gas_high", "gas over the relay's ceiling");
  assert((await quoteSwap({ ...ask, via: "wallet", relayStatus: { chainId: 4663, enabled: false } })).stop === null, "from a wallet, the relay's state doesn't matter");
}

// ── the impact, peg and value stops hold on every chain, unless the caller says otherwise ──
{
  const TEMPO_USDCE = "0x20c000000000000000000000b9537d11c60e8b50";
  const TEMPO_PATHUSD = "0x20c0000000000000000000000000000000000000";
  // a pool that pays a fair rate on a hundredth of the size and 1% of it at the full size
  const thin = fakeChain(4663, { rate: (a) => (a > 10_000_000n ? a / 100n : a) });
  const ask = { client: thin, chainId: 4663, assetIn: USDG, assetOut: GLOAM, amountIn: 1_000_000_000n };
  const q = await quoteSwap(ask);
  assert(q.stop?.code === "too_thin" && q.plan.impactBps >= 9_800, `Robinhood Chain: 99% price impact is stopped by default (${q.stop?.code}, ${q.plan.impactBps})`);
  assert(q.stops.maxImpactBps === 200 && q.stops.maxPegGapBps === 200 && q.stops.maxValueGapBps === 400, "the default stops");
  const loose = await quoteSwap({ ...ask, stops: { maxImpactBps: 10_000 } });
  assert(loose.stop === null && loose.warnings.some((w) => w.includes("moves the price")), "the app's behavior on Robinhood Chain when the caller asks for it: a warning, no stop");
  const tighter = await quoteSwap({ ...ask, client: fakeChain(4663, { rate: (a) => (a > 10_000_000n ? (a * 985n) / 1000n : a) }), stops: { maxImpactBps: 100 } });
  assert(tighter.stop?.code === "too_thin", "a tighter stop than the default is held to");
  // the build refuses a stopped quote before any proof
  const { note, path } = await noteWithPath(1_000_000_000n, USDG, thin);
  let proved = 0;
  const counting = async () => (proved++, { proofBytes: PROOF });
  await refused(buildSwapIntent({ client: thin, chainId: 4663, note, path, assetOut: GLOAM, shieldProver: counting, unshieldProver: counting }), "too_thin", "the build is refused at 99% impact");
  assert(proved === 0, "nothing proved");
  // a size too small to measure has nothing to lose; one that can't be measured otherwise is stopped
  const blind = fakeChain(4663, { rate: (a) => (a >= 10_000_000n ? a : 0n) });
  assert((await quoteSwap({ ...ask, client: blind })).stop?.code === "impact_unknown", "an impact that can't be measured is stopped");
  // Tempo: its exchange names no peg, so the plan's own rate is held to one
  const tempo = fakeChain(4217);
  const tq = await quoteSwap({ client: tempo, chainId: 4217, assetIn: TEMPO_USDCE, assetOut: TEMPO_PATHUSD, amountIn: 100_000_000n });
  assert(tq.stop === null && tq.plan.pegBps <= 40, `Tempo at the peg goes (${tq.plan.pegBps})`);
  tempo.readContract = ((orig) => async (a) => (a.functionName === "quoteSwapExactAmountIn" ? (a.args[2] * 95n) / 100n : orig(a)))(tempo.readContract);
  const off = await quoteSwap({ client: tempo, chainId: 4217, assetIn: TEMPO_USDCE, assetOut: TEMPO_PATHUSD, amountIn: 100_000_000n });
  assert(off.stop?.code === "off_peg", "Tempo 5% off the peg is stopped");
  // value against market, with marks, on Robinhood Chain too
  const rh = fakeChain(4663);
  const far = await quoteSwap({ client: rh, chainId: 4663, assetIn: USDG, assetOut: GLOAM, amountIn: 100_000_000n, decimals: { [GLOAM.toLowerCase()]: 6 }, marks: { [USDG.toLowerCase()]: 1, [GLOAM.toLowerCase()]: 0.5 } });
  assert(far.stop?.code === "far_from_market", "far below market with marks, on Robinhood Chain");
  await refused(quoteSwap({ ...ask, stops: { maxImpactBps: 20_000 } }), "bad_amount", "a stop outside 0 to 10,000");
}

// Ethereum, switched on: value below market, and the relay's floor
VAULT_SWAP_V3_LIVE[1] = VAULT_SWAP_V3_ADDRESS[1];
{
  const c = fakeChain(1);
  const ask = { client: c, chainId: 1, assetIn: ETH_USDC, assetOut: ETH_EURC, amountIn: 5_000_000_000n };
  const q = await quoteSwap(ask);
  assert(q.stop === null && q.routerVersion === 3 && q.floorUsd > 0, "a quote on Ethereum, with the floor read");
  const far = await quoteSwap({ ...ask, marks: { [ETH_USDC.toLowerCase()]: 1, [ETH_EURC.toLowerCase()]: 0.8 } });
  assert(far.stop?.code === "far_from_market" && far.valueGapBps >= 1600, "far below the market price is stopped where quotes are checked");
  const fair = await quoteSwap({ ...ask, marks: { [ETH_USDC.toLowerCase()]: 1, [ETH_EURC.toLowerCase()]: 1 } });
  assert(fair.stop === null && fair.valueGapBps < 100, "fair at market");
  // $5 at 1 gwei and $3,000 ETH is under the floor (about $2,244 with the app's margin)
  const small = await quoteSwap({ ...ask, amountIn: 5_000_000n });
  assert(small.stop?.code === "swap_small" && small.stop.floorUsd > 2000, "under the relay's floor");
  assert((await quoteSwap({ ...ask, amountIn: 5_000_000n, via: "wallet" })).stop === null, "a wallet send has no floor");
  const stale = fakeChain(1, { feedAge: 3 * 3600 });
  assert((await quoteSwap({ ...ask, client: stale })).stop?.code === "floor_unread", "a stale price feed can't price the floor");
}

// ── buildSwapIntent: Robinhood Chain (router v2, no exit) ──
{
  const c = fakeChain(4663);
  const { note, path, nullifier } = await noteWithPath(100_000_000n, USDG, c);
  const p = { client: c, chainId: 4663, note, path, assetOut: GLOAM, shieldProver: stubProver, unshieldProver: stubProver };
  const intent = await buildSwapIntent(p);
  const r = swapRouterFor(4663);
  assert(intent.intent === "private_swap" && same(intent.plan.router, r.address) && intent.plan.deadline === null, "an intent for router v2, no deadline");
  const b = intent.relay.body;
  assert(intent.relay.action === "swap" && b.chainId === 4663 && same(b.router, r.address), "relay call");
  assert(same(b.spend.nullifier, nullifier) && b.spend.amount === note.amountWei && b.spend.proof === PROOF, "spend: the whole note");
  assert(b.refund.amount === refundAmountFor(note.amountWei) && same(b.refund.asset, USDG), "v2's refund note: the amount less 1%");
  assert(b.deposit.amount === intent.plan.amountOut && same(b.deposit.asset, GLOAM), "the new note is exactly the planned amount");
  assert(!("exitKey" in b) && !("deadline" in b), "no exit key or deadline before v3");
  const key = { nullifier: b.spend.nullifier, amountIn: b.spend.amount, outCommitment: b.deposit.commitment, assetOut: GLOAM, amountOut: b.deposit.amount, refundCommitment: b.refund.commitment, refundAmount: b.refund.amount, routeHash: keccak256(encodeRoute(b.route)) };
  assert(same(intent.recovery.escrow, escrowAddress(r.address, USDG, key)), "the recovery names the swap's escrow");
  const call = decodeFunctionData({ abi: vaultSwapAbi, data: intent.wallet.data });
  assert(call.functionName === "swap" && same(intent.wallet.to, r.address) && call.args[0].amount === note.amountWei, "the wallet call is the same swap");
  // the recovery round-trips through storage
  const stored = JSON.stringify(swapJson(intent.recovery));
  const back = parseSwapRecovery(stored);
  assert(back.out.secret === intent.recovery.out.secret && back.refund.secret === intent.recovery.refund.secret, "the recovery keeps both new notes' secrets");
  assert((await noteCommitmentPoseidon(hexToField(back.out.secret), BigInt(back.out.amountWei), back.out.asset)) === hexToField(back.out.commitment), "the new note opens with its secret");
  let bad = false;
  try {
    parseSwapRecovery({ ...back, escrow: "nope" });
  } catch {
    bad = true;
  }
  assert(bad, "a record that isn't one is refused");

  // what stops a build before any proof
  let proved = 0;
  const counting = async () => (proved++, { proofBytes: PROOF });
  await refused(buildSwapIntent({ ...p, note: { ...note, amountWei: note.amountWei + 1n }, shieldProver: counting, unshieldProver: counting }), "bad_note", "a note that doesn't open the leaf");
  c.state.spent.add(nullifier.toLowerCase());
  await refused(buildSwapIntent({ ...p, shieldProver: counting, unshieldProver: counting }), "note_spent", "a spent note");
  c.state.spent.clear();
  c.state.roots.clear();
  await refused(buildSwapIntent({ ...p, shieldProver: counting, unshieldProver: counting }), "unknown_root", "a root the vault doesn't know");
  c.state.roots.add(fieldToHex(path.root).toLowerCase());
  c.state.escrowLies = true;
  await refused(buildSwapIntent({ ...p, shieldProver: counting, unshieldProver: counting }), "router_mismatch", "an escrow the router disagrees with");
  c.state.escrowLies = false;
  await refused(buildSwapIntent({ ...p, pool: "0x0000000000000000000000000000000000000001", shieldProver: counting, unshieldProver: counting }), "wrong_vault", "another vault");
  await refused(buildSwapIntent({ ...p, client: fakeChain(1), shieldProver: counting, unshieldProver: counting }), "wrong_chain", "another chain");
  const stopped = fakeChain(4663, { limits: { [GLOAM.toLowerCase()]: [0n, 0n, 0n] } });
  stopped.state.roots = c.state.roots;
  await refused(buildSwapIntent({ ...p, client: stopped, shieldProver: counting, unshieldProver: counting }), "vault_closed", "a stopped quote");
  assert(proved === 0, "nothing was proved for any refused build");

  // a quote the user saw: the better plan goes, and a quote for another router is refused
  const q = await quoteSwap({ client: c, chainId: 4663, assetIn: USDG, assetOut: GLOAM, amountIn: note.amountWei });
  const better = { ...q, plan: { ...q.plan, amountOut: q.plan.amountOut + 5n } };
  const kept = await buildSwapIntent({ ...p, quote: better });
  assert(kept.plan.amountOut === q.plan.amountOut + 5n, "a quote that gave more than the fresh price is kept, as the app does");
  const worse = { ...q, plan: { ...q.plan, amountOut: q.plan.amountOut - 5n } };
  assert((await buildSwapIntent({ ...p, quote: worse })).plan.amountOut === q.plan.amountOut, "a fresher price that gives more is used");
  await refused(buildSwapIntent({ ...p, quote: { ...q, router: "0x34AB06208586A737Bf1607fa996Bc9162271c52d" } }), "router_mismatch", "a quote for an earlier router");
  const old = { ...better, quotedAt: Date.now() - 60_000 };
  assert((await buildSwapIntent({ ...p, quote: old })).plan.amountOut === q.plan.amountOut, "a quote too old to show is ignored");

  // sendSwap: saved before it is sent, and nothing sent when the save fails
  const order = [];
  const res = await sendSwap({
    intent,
    client: c,
    save: async (rec) => void order.push(rec.info.sent ? "save-hash" : "save"),
    submit: async (callIn) => (order.push(`send:${callIn.action}`), "0x" + "11".repeat(32)),
  });
  assert(order.join(",") === "save,send:swap,save-hash", `saved, sent, saved with its hash (${order})`);
  assert(res.recovery.info.sent?.hash === "0x" + "11".repeat(32) && res.outcome?.state === "pending", "the hash is on the record; nothing landed on the fake chain yet");
  let sent = false;
  await sendSwap({ intent, client: c, save: async () => { throw new Error("disk full"); }, submit: async () => ((sent = true), "0x") }).catch(() => {});
  assert(!sent, "a swap whose record could not be saved is never sent");

  // the outcome, read from the chain
  const rec = intent.recovery;
  assert((await readSwapOutcome(c, rec)).state === "pending", "unspent: pending");
  c.state.receipts[rec.info.sent.hash] = { status: "reverted", logs: [] };
  assert((await readSwapOutcome(c, rec)).state === "reverted", "a reverted send: move the note");
  c.state.seen.add(rec.out.commitment.toLowerCase());
  c.state.spent.add(rec.spent.nullifier.toLowerCase());
  const o = await readSwapOutcome(c, rec);
  assert(o.state === "swapped" && o.note.secret === rec.out.secret, "swapped: the new note is yours");
  c.state.seen.clear();
  assert((await readSwapOutcome(c, rec)).state === "closed", "spent, nothing landed, nothing waiting: closed");
  c.state.balances[`${USDG.toLowerCase()}:${rec.escrow.toLowerCase()}`] = BigInt(rec.info.amountIn) - vaultFeeOf(BigInt(rec.info.amountIn), 25);
  assert((await readSwapOutcome(c, rec)).state === "refund_ready", "money at the escrow: refund ready");

  // the refund: only with the vault's payment to the escrow on record
  await refused(buildSwapRefund(rec, { client: c, shieldProver: stubProver }), "unshield_tx", "no payment found yet");
  const tx = "0x" + "22".repeat(32);
  const word = (a) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");
  c.state.logs.push({ args: { nullifier: rec.spent.nullifier, asset: USDG, to: rec.escrow }, transactionHash: tx });
  c.state.receipts[tx] = {
    status: "success",
    logs: [{
      address: VAULT,
      topics: [keccak256(new TextEncoder().encode("Unshielded(bytes32,address,address,uint256)")), rec.spent.nullifier, word(USDG), word(rec.escrow)],
      data: "0x" + BigInt(rec.info.amountIn).toString(16).padStart(64, "0"),
    }],
  };
  const refund = await buildSwapRefund(rec, { client: c, shieldProver: stubProver });
  const rb = refund.relay.body;
  assert(refund.relay.action === "swap" && rb.unshieldTx === tx && rb.refund.proof === PROOF && /^0x0+$/.test(rb.spend.proof), "refund: the swap call again, with only the refund note's proof");
  assert(same(rb.router, rec.router) && rb.refund.amount === BigInt(rec.refund.amountWei), "through the swap's own router, for the refund note's amount");
  assertSwapSendable(refund.relay, Date.now() + 10 ** 12);
  checks++;
  await refused(buildSwapExit(rec, { client: c, to: "0x00000000000000000000000000000000000000aa" }), "no_exit", "router v2 has no exit");
  // a record changed after it was made no longer names its escrow
  await refused(buildSwapRefund({ ...rec, refund: { ...rec.refund, amountWei: "1" } }, { client: c, shieldProver: stubProver }), "bad_note", "a changed record");
}

// ── buildSwapIntent: Ethereum (v3, with an exit) ──
{
  const c = fakeChain(1);
  const { note, path } = await noteWithPath(5_000_000_000n, ETH_USDC, c);
  const intent = await buildSwapIntent({ client: c, chainId: 1, note, path, assetOut: ETH_USDT, shieldProver: stubProver, unshieldProver: stubProver });
  const b = intent.relay.body;
  assert(same(b.router, VAULT_SWAP_V3_ADDRESS[1]) && intent.plan.routerVersion === 3, "v3 on Ethereum");
  assert(b.deadline === c.state.block.timestamp + 600n, "the deadline: the chain's clock plus 10 minutes");
  assert(b.refund.amount === refundAmountFor(note.amountWei, 25), "the refund note: less the fee now and 0.1%");
  assert(same(b.exitKey, exitAccount(intent.recovery.refund.secret).address), "the exit key comes from the refund note's secret");
  const call = decodeFunctionData({ abi: vaultSwapV3Abi, data: intent.wallet.data });
  assert(call.args[4] === b.exitKey && call.args[5] === b.deadline, "the wallet call carries the exit key and deadline");
  // sending: the relay wants a minute left
  assertSwapSendable(intent.relay, Number(b.deadline - 120n) * 1000);
  checks++;
  await refused(Promise.resolve().then(() => assertSwapSendable(intent.relay, Number(b.deadline - 30n) * 1000)), "expired", "under a minute left");
  const late = { ...intent.relay, body: { ...intent.relay.body, deadline: 1n } };
  await refused(relaySwapCall(late, { fetch: async () => { throw new Error("must not send"); }, url: "http://x" }).then(() => {}), "expired", "relaySwapCall refuses a swap past its deadline");
  // the relay body over the wire
  let posted;
  const hash = await relaySwapCall(intent.relay, {
    url: "https://relay.test/api/relay",
    fetch: async (url, init) => ((posted = { url, body: JSON.parse(init.body) }), new Response(JSON.stringify({ ok: true, hash: "0x" + "33".repeat(32) }))),
  }).catch((e) => e);
  // the fake chain's clock is in 2027; the real one isn't there yet, so this one is sendable
  assert(hash === "0x" + "33".repeat(32) && posted.body.action === "swap" && posted.body.deadline === b.deadline.toString() && posted.body.spend.amount === note.amountWei.toString(), "posted as the relay reads it");

  // the exit: signed for one address, sent anywhere
  const rec = intent.recovery;
  c.state.spent.add(rec.spent.nullifier.toLowerCase());
  // the vault's fee rose to its highest (1%) before the unshield went alone: short of the refund note
  const arrived = BigInt(rec.info.amountIn) - vaultFeeOf(BigInt(rec.info.amountIn), 100);
  c.state.balances[`${ETH_USDC.toLowerCase()}:${rec.escrow.toLowerCase()}`] = arrived;
  assert((await readSwapOutcome(c, rec)).state === "exit_ready", "short of the refund note: exit ready");
  await refused(buildSwapRefund(rec, { client: c, shieldProver: stubProver }), "refund_wont_fit", "the refund can't take it");
  const tx = "0x" + "44".repeat(32);
  const word = (a) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");
  c.state.receipts[tx] = {
    status: "success",
    logs: [{
      address: VAULT,
      topics: [keccak256(new TextEncoder().encode("Unshielded(bytes32,address,address,uint256)")), rec.spent.nullifier, word(ETH_USDC), word(rec.escrow)],
      data: "0x" + BigInt(rec.info.amountIn).toString(16).padStart(64, "0"),
    }],
  };
  const TO = "0x00000000000000000000000000000000000000aa";
  await refused(buildSwapExit(rec, { client: c, to: VAULT, unshieldTx: tx }), "bad_recipient", "never to the vault");
  await refused(buildSwapExit(rec, { client: c, to: rec.router, unshieldTx: tx }), "bad_recipient", "never to the router");
  await refused(buildSwapExit(rec, { client: c, to: ETH_USDC, unshieldTx: tx }), "bad_recipient", "never to a token contract");
  const exit = await buildSwapExit(rec, { client: c, to: TO, unshieldTx: tx });
  const eb = exit.relay.body;
  assert(exit.relay.action === "swapExit" && same(eb.to, TO) && eb.unshieldTx === tx && same(eb.asset, ETH_USDC), "exit call");
  const signer = await recoverAddress({ hash: exitDigest(1, rec.router, rec.escrow, TO), signature: eb.signature });
  assert(same(signer, rec.info.exitKey), "signed by the swap's exit key, for this address");
  assert(same(escrowAddress(rec.router, ETH_USDC, eb.key), rec.escrow), "the exit names the swap's escrow");
  const wrongTx = "0x" + "55".repeat(32);
  c.state.receipts[wrongTx] = { status: "success", logs: [] };
  await refused(buildSwapExit(rec, { client: c, to: TO, unshieldTx: wrongTx }), "unshield_tx", "a transaction that didn't pay the escrow");
  c.state.balances[`${ETH_USDC.toLowerCase()}:${rec.escrow.toLowerCase()}`] = 0n;
  await refused(buildSwapExit(rec, { client: c, to: TO, unshieldTx: tx }), "not_waiting", "nothing waiting");
  void refundEscrowKey;
}
VAULT_SWAP_V3_LIVE[1] = null;
{
  // Ethereum off again: a swap there is refused cleanly
  const c = fakeChain(1);
  const { note, path } = await noteWithPath(5_000_000_000n, ETH_USDC, c);
  await refused(buildSwapIntent({ client: c, chainId: 1, note, path, assetOut: ETH_USDT, shieldProver: stubProver, unshieldProver: stubProver }), "no_swap", "Ethereum while its switch is off");
}

// ── the partner API client ──
{
  const KEY = "gloam_live_" + "a".repeat(43);
  let req;
  const api = new GloamApiClient({
    apiKey: KEY,
    baseUrl: "https://api.test",
    fetch: async (url, init) => {
      req = { url, method: init.method, body: init.body ? JSON.parse(init.body) : null };
      return new Response(JSON.stringify({ v: 1, ok: true, data: { hash: "0x" + "66".repeat(32), action: "swap", charged: false }, requestId: "r1" }));
    },
  });
  const r = await api.relaySwap({ action: "swapExit", body: { chainId: 1, router: VAULT_SWAP_V3_ADDRESS[1], to: "0x00000000000000000000000000000000000000aa" } });
  assert(req.url === "https://api.test/api/v1/relay" && req.body.action === "swapExit" && r.charged === false, "relaySwap posts to the partner relay");
  await api.swapQuote({ chainId: 4663, assetIn: USDG, assetOut: GLOAM, amountIn: 100n });
  assert(req.url === "https://api.test/api/v1/swaps/quote" && req.body.amountIn === "100", "swapQuote posts base units as a string");
  await api.swapNetworks();
  assert(req.url === "https://api.test/api/v1/swaps" && req.method === "GET", "swapNetworks");
}

// ── the cash-out builder reads the fee live too ──
{
  const c = fakeChain(4663, { fee: 40 });
  const { note, path } = await noteWithPath(1_000_000n, USDG, c);
  const u = await buildUnshieldIntent({ secretHex: note.secretHex, amountWei: note.amountWei, asset: USDG, to: "0x00000000000000000000000000000000000000aa", path, prove: stubProver, chainId: 4663, client: c });
  assert(u.plan.feeBps === 40 && u.plan.feeWei === 4_000n && u.plan.receivesWei === 996_000n, "the cash out's plan has the fee read live");
  assert(u.execution.includes("0.4% now"), "and says it");
}

console.log(`swapIntent selftest: ${checks} checks passed`);
