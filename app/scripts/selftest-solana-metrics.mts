/**
 * Self-test: Solana in /admin, counted like the other networks (lib/solanaRings
 * metrics, metricsParse, metricsServer; app/api/solana/added; the admin cards).
 *
 *  - The pool's own accounts (where SOL sits, and the owner of every SPL vault)
 *    are the SDK's.
 *  - The relay's real history as read on 2026-11-23 (fixtures): four accounts
 *    opened, two bring-ins of 18.002207 and 10.622149 USDC by one private
 *    account, and the relay's own funding, which is not Gloam activity.
 *  - A transact the pool pays out of is a cash-out, with the wallet paid and
 *    the amount it got (an SPL one beside a token account the relay creates; a
 *    SOL one beside new nullifier accounts, whose rent is never taken for it);
 *    one it pays nothing out of is a private payment, never with an amount; a
 *    merge is not a payment; a failed transaction counts for nothing.
 *  - A wallet add is kept only when the chain shows it: landed in the last
 *    hour, one deposit of a listed asset, from the depositing wallet (the fee
 *    payer, or the one other signer when Gloam's relay paid the fee).
 *  - The figures: a deposit is a bring-in when a Gloam private account (one the
 *    relay registered) made it and a wallet add otherwise, whoever paid the
 *    fee; deposits are adds plus bring-ins, depositors are wallets plus private
 *    accounts, net in is in less out, fees are zero, SOL is priced at the time;
 *    an add both reported and read from the relay counts once.
 *  - withSolana: the mainnet totals with Solana in, day by day, held untouched.
 *  - Reading the relay: only new signatures are fetched, a transaction that
 *    could not be read is tried again, a long history is caught up over reads,
 *    and what was read is kept by signature.
 *  - /api/solana/added: same-origin only, a real signature only, rate limited,
 *    kept once.
 *  - The page: Solana's card sits right after Base, its figures are labelled
 *    for what they are, and the app reports an add without waiting on it.
 *
 * A fake Solana and the in-process store: nothing reaches a host.
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-solana-metrics.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { fileURLToPath } from "node:url";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_SOLANA_RINGS_ENABLED = "1";
env.NEXT_PUBLIC_SOLANA_RINGS_NETWORK = "mainnet";
env.GLOAM_PARTNERS_STORE = "memory";
env.GLOAM_RATE_LIMIT_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "HELIUS_API_KEY", "GLOAM_SOLANA_RELAYER_SECRET", "GLOAM_SOLANA_METRICS_RPC"]) delete env[k];

const { getBase58Decoder } = await import("@solana/kit");
const { getShieldedPoolCpiAuthorityAddress, getSolInterfaceAddress, getSplAssetVaultAddress } = await import("@heliuslabs/spr/addresses");
const config = await import("../src/lib/solanaRings/config");
const parse = await import("../src/lib/solanaRings/metricsParse");
const metrics = await import("../src/lib/solanaRings/metrics");
const server = await import("../src/lib/solanaRings/metricsServer");
const { resetMemoryKv, kv } = await import("../src/lib/partnersKv");
const { SHIELDED_POOL_PROGRAM, USER_REGISTRY_PROGRAM, ATA_PROGRAM } = await import("../src/lib/solanaRings/relayPolicy");
const nets = await import("../src/lib/networks");
type RpcTx = import("../src/lib/solanaRings/metricsParse").RpcTx;
type SolEvent = import("../src/lib/solanaRings/metrics").SolEvent;
type CombinedMetrics = import("../src/lib/onchainMetrics").CombinedMetrics;

let pass = 0;
const ok = (cond: unknown, what: string) => {
  assert.ok(cond, what);
  pass++;
  console.log(`  ok  ${what}`);
};

const b58 = getBase58Decoder();
const randomKey = (n = 32) => b58.decode(crypto.getRandomValues(new Uint8Array(n)));
const sig = () => randomKey(64);
const RELAY = server.MAINNET_RELAYS[0]!;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ZEC = config.ZEC_SOLANA_MINT;
const SOL = config.RINGS_SOL_MINT;
const TREE = "777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor";
const USDC_VAULT = "H4RD4XSWp8TLmrNYCLmV74a5ixude5s9gGqpCFjXkBLQ";
const NOW = 1_795_460_000;

type Tok = { acct: string; owner: string; mint: string; pre: bigint; post: bigint; d?: number };

/** A getTransaction answer: `ixs` are [program, first byte]; balances by account. */
function mkTx(o: {
  payer: string;
  signers?: string[];
  ixs: [string, number][];
  lam?: Record<string, [number, number]>;
  tok?: Tok[];
  ts?: number;
  slot?: number;
  err?: unknown;
}): RpcTx {
  const keys: string[] = [o.payer, ...(o.signers ?? [])];
  const at = (k: string) => {
    let i = keys.indexOf(k);
    if (i < 0) i = keys.push(k) - 1;
    return i;
  };
  const nSigners = keys.length;
  for (const k of Object.keys(o.lam ?? {})) at(k);
  for (const t of o.tok ?? []) at(t.acct);
  const ixs = o.ixs.map(([program, tag]) => ({ programIdIndex: at(program), accounts: [], data: b58.decode(Uint8Array.of(tag, 1, 2, 3)) }));
  const pre = keys.map((k) => o.lam?.[k]?.[0] ?? 1_000_000);
  const post = keys.map((k) => o.lam?.[k]?.[1] ?? 1_000_000);
  const bal = (t: Tok, v: bigint) => ({ accountIndex: keys.indexOf(t.acct), mint: t.mint, owner: t.owner, uiTokenAmount: { amount: String(v), decimals: t.d ?? 6 } });
  return {
    slot: o.slot ?? 1,
    blockTime: o.ts ?? NOW - 60,
    meta: {
      err: o.err ?? null,
      preBalances: pre,
      postBalances: post,
      preTokenBalances: (o.tok ?? []).map((t) => bal(t, t.pre)),
      postTokenBalances: (o.tok ?? []).map((t) => bal(t, t.post)),
      loadedAddresses: { writable: [], readonly: [] },
    },
    transaction: { message: { accountKeys: keys, header: { numRequiredSignatures: nSigners }, instructions: ixs } },
  };
}

// ---------------------------------------------------------------- the pool's own accounts

console.log("The pool's own accounts");
ok(parse.POOL_AUTHORITY === getShieldedPoolCpiAuthorityAddress(), "the SPL vaults' owner is the SDK's pool CPI authority");
ok(parse.POOL_SOL_VAULT === getSolInterfaceAddress(), "SOL sits in the SDK's SOL interface account");
ok((await getSplAssetVaultAddress(USDC as never)) === USDC_VAULT, "USDC's vault is the account the bring-ins paid into");

// ---------------------------------------------------------------- the relay's real history

console.log("The relay's real history (read 2026-11-23)");
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/solana-relay-2026-11-23.json", import.meta.url), "utf8")) as Record<string, RpcTx>;
const real = Object.entries(fixtures).map(([s, tx]) => parse.parseRelayTx(s, tx, RELAY));
const kinds = (list: SolEvent[]) => list.map((e) => e.k).sort().join();
ok(kinds(real) === "bring,bring,open,open,open,open,other", "four accounts opened, two bring-ins, and the relay's own funding");
const brings = real.filter((e) => e.k === "bring");
ok(brings.every((e) => e.m === USDC && e.d === 6 && e.acct === "8KtxwyZ7n62z4Mjoi7doYNuav8FyqXk5MGhn4pBJedMn"), "both bring-ins are USDC, by the one private account that signed");
ok(brings.map((e) => e.v).sort().join() === "10622149,18002207", "the amounts are what the pool's USDC vault gained: 18.002207 and 10.622149");
ok(real.filter((e) => e.k === "open").every((e) => e.acct && e.acct !== RELAY), "each account opened is the signer that is not the relay");
ok(Object.entries(fixtures).every(([s, tx]) => parse.parseRelayTx(s, tx, randomKey()).k === "other"), "read as another relay's, none of it counts");

// ---------------------------------------------------------------- cash-outs, payments, merges

console.log("Cash-outs, private payments and merges");
{
  const acct = randomKey();
  const to = randomKey();
  const toAta = randomKey();
  const nul = [randomKey(), randomKey()];
  // an SPL cash-out: the vault pays the recipient's token account, which the relay creates; nullifiers take rent from the tree
  const spl = mkTx({
    payer: RELAY,
    signers: [acct],
    ixs: [
      [ATA_PROGRAM, 1],
      [SHIELDED_POOL_PROGRAM, 16],
    ],
    lam: { [RELAY]: [500_000_000, 497_950_000], [toAta]: [0, 2_039_280], [TREE]: [9_000_000_000, 8_998_592_760], [nul[0]!]: [0, 706_120], [nul[1]!]: [0, 706_120] },
    tok: [
      { acct: toAta, owner: to, mint: USDC, pre: 0n, post: 5_000_000n },
      { acct: USDC_VAULT, owner: parse.POOL_AUTHORITY, mint: USDC, pre: 900_000_000n, post: 895_000_000n },
    ],
  });
  const e = parse.parseRelayTx("s1", spl, RELAY);
  ok(e.k === "cashout" && e.m === USDC && e.v === "5000000" && e.w === to && e.acct === acct, "an SPL cash-out: 5 USDC to the wallet that owns the receiving account");

  // a SOL cash-out of 0.0005 SOL, smaller than a nullifier's rent: the payee is still the account the pool paid
  const small = mkTx({
    payer: RELAY,
    signers: [acct],
    ixs: [[SHIELDED_POOL_PROGRAM, 16]],
    lam: { [RELAY]: [500_000_000, 499_990_000], [parse.POOL_SOL_VAULT]: [10_000_000_000, 9_999_500_000], [to]: [3_000_000, 3_500_000], [nul[0]!]: [0, 706_120], [nul[1]!]: [0, 706_120], [TREE]: [9_000_000_000, 8_998_592_760] },
  });
  const s = parse.parseRelayTx("s2", small, RELAY);
  ok(s.k === "cashout" && s.m === SOL && s.v === "500000" && s.w === to && s.d === 9, "a SOL cash-out smaller than a nullifier's rent: 0.0005 SOL to the wallet paid, not to a nullifier");

  const pay = mkTx({
    payer: RELAY,
    signers: [acct],
    ixs: [[SHIELDED_POOL_PROGRAM, 16]],
    lam: { [RELAY]: [500_000_000, 499_990_000], [nul[0]!]: [0, 706_120], [nul[1]!]: [0, 706_120], [TREE]: [9_000_000_000, 8_998_592_760] },
  });
  const p = parse.parseRelayTx("s3", pay, RELAY);
  ok(p.k === "pay" && p.acct === acct && p.v === undefined && p.m === undefined && p.w === undefined, "the pool paid nothing out: a private payment, with no amount, asset or recipient");

  const merge = parse.parseRelayTx("s4", mkTx({ payer: RELAY, signers: [acct], ixs: [[SHIELDED_POOL_PROGRAM, 17]] }), RELAY);
  ok(merge.k === "merge", "a merge is not a payment");
  const failed = parse.parseRelayTx("s5", mkTx({ payer: RELAY, signers: [acct], ixs: [[SHIELDED_POOL_PROGRAM, 16]], err: { InstructionError: [0, "Custom"] } }), RELAY);
  ok(failed.k === "failed", "a failed transaction counts for nothing");
  const empty = parse.parseRelayTx("s6", mkTx({ payer: RELAY, signers: [acct], ixs: [[SHIELDED_POOL_PROGRAM, 15]] }), RELAY);
  ok(empty.k === "other", "a deposit the pool gained nothing from is not counted");
  const reg = parse.parseRelayTx("s7", mkTx({ payer: RELAY, signers: [acct], ixs: [[USER_REGISTRY_PROGRAM, 0], [USER_REGISTRY_PROGRAM, 1]] }), RELAY);
  ok(reg.k === "open" && reg.acct === acct, "a registration opens one account");
}

// ---------------------------------------------------------------- wallet adds

console.log("Wallet adds");
{
  const wallet = randomKey();
  const walletAta = randomKey();
  const opts = { relays: [RELAY], nowSec: NOW };
  const solAdd = mkTx({
    payer: wallet,
    ixs: [
      ["ComputeBudget111111111111111111111111111111", 2],
      ["ComputeBudget111111111111111111111111111111", 3],
      [SHIELDED_POOL_PROGRAM, 15],
    ],
    lam: { [wallet]: [2_000_000_000, 1_499_990_000], [parse.POOL_SOL_VAULT]: [10_000_000_000, 10_500_000_000] },
  });
  const a = parse.parseAddTx("a1", solAdd, opts);
  ok(a.ok && a.event.k === "add" && a.event.w === wallet && a.event.m === SOL && a.event.v === "500000000", "a SOL add: 0.5 SOL from the wallet that paid for it");
  const usdcAdd = mkTx({
    payer: wallet,
    ixs: [[SHIELDED_POOL_PROGRAM, 15]],
    tok: [
      { acct: walletAta, owner: wallet, mint: USDC, pre: 40_000_000n, post: 15_000_000n },
      { acct: USDC_VAULT, owner: parse.POOL_AUTHORITY, mint: USDC, pre: 900_000_000n, post: 925_000_000n },
    ],
  });
  const u = parse.parseAddTx("a2", usdcAdd, opts);
  ok(u.ok && u.event.m === USDC && u.event.v === "25000000" && u.event.d === 6, "a USDC add: 25 USDC, from the wallet's own token account");

  const reason = (tx: RpcTx | null) => {
    const v = parse.parseAddTx("ax", tx, opts);
    return v.ok ? "ok" : v.reason;
  };
  ok(reason(null) === "not found", "a transaction Solana doesn't have is not kept");
  {
    // Gloam's relay paid the fee for a wallet with no SOL: the depositor is the other signer
    const relayPaid = parse.parseAddTx(
      "a3",
      mkTx({ payer: RELAY, signers: [wallet], ixs: [[SHIELDED_POOL_PROGRAM, 15]], lam: { [RELAY]: [500_000_000, 499_990_000], [wallet]: [700_000_000, 200_000_000], [parse.POOL_SOL_VAULT]: [1, 500_000_001] } }),
      opts
    );
    ok(relayPaid.ok && relayPaid.event.w === wallet && relayPaid.event.v === "500000000", "an add the relay paid the fee for: the depositor is the wallet that signed, never the relay");
  }
  ok(
    reason(mkTx({ payer: RELAY, signers: [wallet], ixs: [[SHIELDED_POOL_PROGRAM, 15]], lam: { [RELAY]: [1_000_000_000, 499_990_000], [parse.POOL_SOL_VAULT]: [1, 500_000_001] } })) === "not from the depositor",
    "money the relay put in is never a wallet's add"
  );
  ok(reason(mkTx({ payer: RELAY, signers: [wallet, randomKey()], ixs: [[SHIELDED_POOL_PROGRAM, 15]], lam: { [parse.POOL_SOL_VAULT]: [1, 500_000_001] } })) === "no depositor", "with the relay paying, there must be exactly one depositor");
  ok(reason(mkTx({ payer: wallet, ixs: [[SHIELDED_POOL_PROGRAM, 15]], lam: { [wallet]: [2_000_000_000, 1_499_990_000], [parse.POOL_SOL_VAULT]: [1, 500_000_001] }, ts: NOW - 2 * 3_600 })) === "not recent", "an add older than an hour is not kept: the page reports it as it lands");
  ok(reason(mkTx({ payer: wallet, ixs: [[SHIELDED_POOL_PROGRAM, 15]], err: { InstructionError: [0, "Custom"] } })) === "failed", "a failed add is not kept");
  ok(reason(mkTx({ payer: wallet, ixs: [[SHIELDED_POOL_PROGRAM, 16]], lam: { [parse.POOL_SOL_VAULT]: [500_000_001, 1] } })) === "not one deposit", "a transact is not an add");
  ok(
    reason(mkTx({ payer: wallet, ixs: [[SHIELDED_POOL_PROGRAM, 15], [SHIELDED_POOL_PROGRAM, 15]], lam: { [wallet]: [2_000_000_000, 1_499_990_000], [parse.POOL_SOL_VAULT]: [1, 500_000_001] } })) === "not one deposit",
    "two deposits in one transaction is not Gloam's add"
  );
  const other = randomKey();
  ok(
    reason(mkTx({ payer: wallet, ixs: [[SHIELDED_POOL_PROGRAM, 15]], tok: [{ acct: randomKey(), owner: wallet, mint: other, pre: 9n, post: 0n }, { acct: randomKey(), owner: parse.POOL_AUTHORITY, mint: other, pre: 0n, post: 9n }] })) === "not listed",
    "an asset Gloam doesn't list is not kept"
  );
  ok(
    reason(mkTx({ payer: wallet, ixs: [[SHIELDED_POOL_PROGRAM, 15]], tok: [{ acct: walletAta, owner: randomKey(), mint: USDC, pre: 9_000_000n, post: 0n }, { acct: USDC_VAULT, owner: parse.POOL_AUTHORITY, mint: USDC, pre: 0n, post: 9_000_000n }] })) === "not from the depositor",
    "money that did not come from the depositing wallet is not kept"
  );
  ok(parse.isSignature(Object.keys(fixtures)[0]) && !parse.isSignature("abc") && !parse.isSignature(randomKey()) && !parse.isSignature(42), "only a 64-byte base58 signature is taken");
}

// ---------------------------------------------------------------- the figures

console.log("The figures");
const DAY = 86_400;
const today = new Date(NOW * 1000).toISOString().slice(0, 10);
const daysBack = (n: number) => [...Array(n).keys()].map((i) => new Date((NOW - (n - 1 - i) * DAY) * 1000).toISOString().slice(0, 10));
const days = daysBack(14);
const revenueDays = daysBack(30);
const launchDays = daysBack(34);
const acctA = "8KtxwyZ7n62z4Mjoi7doYNuav8FyqXk5MGhn4pBJedMn";
const walletB = randomKey();
const payee = randomKey();
const events: SolEvent[] = [
  ...real,
  { sig: "p1", k: "pay", ts: NOW - 300, slot: 10, acct: acctA },
  { sig: "c1", k: "cashout", ts: NOW - 200, slot: 11, acct: acctA, w: payee, m: USDC, v: "5000000", d: 6 },
  { sig: "m1", k: "merge", ts: NOW - 100, slot: 12, acct: acctA },
  { sig: "f1", k: "failed", ts: NOW - 50, slot: 13 },
];
const walletC = randomKey();
// a wallet with no SOL, its add paid for by the relay: read from the relay's history and reported too
events.push({ sig: "r1", k: "bring", ts: NOW - 2 * DAY, slot: 4, acct: walletC, m: USDC, v: "2000000", d: 6 });
const adds: SolEvent[] = [
  { sig: "a1", k: "add", ts: NOW - 3 * DAY, slot: 5, w: walletB, m: SOL, v: "1500000000", d: 9 },
  { sig: "r1", k: "add", ts: NOW - 2 * DAY, slot: 4, w: walletC, m: USDC, v: "2000000", d: 6 },
  // the same signature the relay read: counted once
  { sig: "p1", k: "add", ts: NOW - 300, slot: 10, w: walletB, m: USDC, v: "1", d: 6 },
];
const price: import("../src/lib/solanaRings/metrics").SolUnitPrice = (mint, ts) => (mint === SOL && ts === NOW - 3 * DAY ? { usd: 200, atToday: false } : { usd: null, atToday: false });
const sol = metrics.solanaFigures({ relays: [RELAY], pool: SHIELDED_POOL_PROGRAM, events, adds, price, days, revenueDays, launchDays, addsSince: NOW - 10 * DAY, lastSlot: 13, readMs: 5, error: null, nowSec: NOW });
ok(sol.accountsOpened === 4 && sol.merges === 1, "four accounts opened; the merge is kept apart");
ok(sol.deposits === 4 && sol.adds === 2 && sol.bringIns === 2, "deposits: two wallet adds (one the relay paid for) and two bring-ins");
ok(
  sol.recent.find((r) => r.tx === "r1")?.title === "Added from a wallet" && sol.recent.find((r) => r.tx === "r1")?.wallet === walletC,
  "a relayed deposit by a wallet that is not a Gloam private account is an add, counted once though reported too"
);
ok(sol.recent.filter((r) => r.title === "Brought in").every((r) => r.wallet === acctA), "a relayed deposit by a private account the relay registered is a bring-in");
ok(sol.transfers === 1 && sol.cashouts === 1, "one private payment, one cash-out; the relay's funding and the failed one count for nothing");
ok(sol.depositors === 3 && sol.cashoutWallets === 1 && sol.activeWallets === 4, "depositors: the two wallets that added and the private account that brought money in");
const moneyIn = 28.624356 + 300 + 2;
ok(Math.abs(sol.revenue.depositVolume.all - moneyIn) < 1e-9 && Math.abs(sol.revenue.cashoutVolume.all - 5) < 1e-9, "money in at the time (1.5 SOL at $200) and out (5 USDC)");
ok(Math.abs(sol.netInUsd - (moneyIn - 5)) < 1e-9, "net in is in less out");
ok(sol.revenue.fees.all === 0 && sol.revenue.feeBps === 0 && sol.revenue.feeRows.length === 0, "no fees: Gloam charges none on Solana yet");
ok(sol.revenue.depositVolume.d1 === 28.624356 && Math.abs(sol.revenue.depositVolume.d7 - moneyIn) < 1e-9, "the windows: the adds are two and three days old");
ok(sol.assets.map((a) => `${a.symbol}:${a.added}/${a.broughtIn}/${a.cashedOut}`).join() === "SOL:1.5/0/0,USDC:2/28.624356/5", "per asset, SOL first as listed, in whole units");
{
  // reported first, before the relay's read has the registration or the deposit: still one, and a bring-in once the registration is read
  const reportedOnly = metrics.solanaFigures({
    relays: [RELAY],
    pool: "",
    events: real.filter((e) => e.k === "open"),
    adds: [{ sig: "b9", k: "add", ts: NOW, slot: 1, w: acctA, m: USDC, v: "1000000", d: 6 }],
    price,
    days,
    revenueDays,
    launchDays,
    addsSince: null,
    lastSlot: null,
    readMs: 0,
    error: null,
    nowSec: NOW,
  });
  ok(reportedOnly.bringIns === 1 && reportedOnly.adds === 0, "a reported deposit by a registered private account is a bring-in, not an add");
}
{
  const row = sol.daily.find((d) => d.day === today)!;
  ok(row.deposits === 2 && row.transfers === 1 && row.cashouts === 1 && row.activeWallets === 2, "today's row: two bring-ins, the payment and the cash-out");
  ok(sol.daily.length === 14 && sol.sinceLaunch.length === 34 && sol.revenue.daily.length === 30, "rows line up with the EVM side's days");
}
ok(sol.recent.every((r) => r.network === "solana") && !sol.recent.some((r) => r.tx === "m1" || r.tx === "f1"), "the feed has no merges, failures or the relay's funding");
ok(sol.recent.find((r) => r.tx === "p1")?.detail === "Private payment" && sol.recent.find((r) => r.tx === "c1")?.detail === "5 USDC", "a payment shows no amount; a cash-out shows its own");
{
  const unpriced = metrics.solanaFigures({ relays: [RELAY], pool: "", events: [], adds: [{ sig: "z", k: "add", ts: NOW, slot: 1, w: walletB, m: ZEC, v: "100000000", d: 8 }], price: () => ({ usd: null, atToday: false }), days, revenueDays, launchDays, addsSince: null, lastSlot: null, readMs: 0, error: null, nowSec: NOW });
  ok(unpriced.revenue.unpriced?.join() === "ZEC" && unpriced.revenue.depositVolume.all === 0 && unpriced.deposits === 1, "ZEC with no price is named, left out of the dollars, still counted");
  const late = metrics.solanaFigures({ relays: [RELAY], pool: "", events: [], adds: [{ sig: "z", k: "add", ts: NOW, slot: 1, w: walletB, m: SOL, v: "1000000000", d: 9 }], price: () => ({ usd: 150, atToday: true }), days, revenueDays, launchDays, addsSince: null, lastSlot: null, readMs: 0, error: null, nowSec: NOW });
  ok(late.revenue.atToday?.join() === "SOL" && late.revenue.depositVolume.all === 150, "a price not read for the time yet is today's, and said so");
  ok(metrics.solTokensMoved(sol, (x) => x) === "1.5 SOL in", "the card's token line names SOL, not the stablecoins");
}

// ---------------------------------------------------------------- withSolana

console.log("The mainnet totals with Solana in");
{
  const W = (v: number) => ({ d1: v, d7: v, d30: v, all: v });
  const dayRow = (d: string, v: number) => ({ day: d, deposits: v, transfers: v, cashouts: v, trades: v, activeWallets: v });
  const agg: CombinedMetrics = {
    deposits: 10,
    transfers: 20,
    cashouts: 5,
    trades: 2,
    memos: 3,
    depositors: 7,
    activeWallets: 9,
    heldUsd: 1_000,
    unpriced: [],
    firstActivity: NOW - 30 * DAY,
    lastActivity: NOW - 3_600,
    daily: days.map((d) => dayRow(d, 1)),
    sinceLaunch: launchDays.map((d) => dayRow(d, 1)),
    revenue: {
      fees: W(4),
      owedUsd: 1,
      depositVolume: W(100),
      cashoutVolume: W(50),
      txs: W(37),
      users: W(9),
      daily: revenueDays.map((d) => ({ day: d, feesUsd: 1, depositUsd: 10, cashoutUsd: 5, txs: 2, wallets: 1 })),
      unpriced: ["EURC"],
      atToday: [],
    },
  };
  const both = metrics.withSolana(agg, sol);
  ok(both.deposits === 14 && both.transfers === 21 && both.cashouts === 6 && both.trades === 2 && both.memos === 3, "counts add up; Solana has no swaps or payment messages");
  ok(both.depositors === 10 && both.activeWallets === 13, "wallets add up: Solana and 0x addresses never overlap");
  ok(both.heldUsd === 1_000, "held is left as it was: Gloam's share of Solana's pool can't be read");
  ok(both.lastActivity === sol.lastActivity && both.firstActivity === agg.firstActivity, "first and last activity across both");
  const r = both.revenue!;
  ok(Math.abs(r.depositVolume.all - (100 + moneyIn)) < 1e-9 && r.cashoutVolume.all === 55 && r.fees.all === 4, "money in and out add Solana's; fees stay the EVM vaults'");
  ok(r.users.all === 9 + sol.users.all && r.unpriced?.join() === "EURC", "users add up; unpriced stays named");
  const t = r.daily.find((d) => d.day === today)!;
  ok(Math.abs(t.depositUsd - (10 + 28.624356)) < 1e-9 && t.cashoutUsd === 10 && t.txs === 2 + 4, "today's money row has Solana's in it");
  ok(both.daily.find((d) => d.day === today)!.deposits === 3 && both.sinceLaunch!.find((d) => d.day === today)!.transfers === 2, "today's count rows too, 14 days and since launch");
  ok(agg.deposits === 10 && agg.revenue!.depositVolume.all === 100, "the EVM totals themselves are untouched");
}

// ---------------------------------------------------------------- reading the relay

console.log("Reading the relay");
type Call = { method: string; params: unknown[] };
function fakeChain(sigs: { signature: string; slot: number; err: unknown; blockTime: number }[], txs: Map<string, RpcTx>) {
  const calls: Call[] = [];
  const failOnce = new Set<string>();
  const rpc = (async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    if (method === "getSignaturesForAddress") {
      const o = params[1] as { limit: number; before?: string; until?: string };
      let list = [...sigs].sort((a, b) => b.slot - a.slot);
      if (o.before) list = list.slice(list.findIndex((x) => x.signature === o.before) + 1);
      if (o.until) {
        const i = list.findIndex((x) => x.signature === o.until);
        if (i >= 0) list = list.slice(0, i);
      }
      return list.slice(0, o.limit);
    }
    if (method === "getTransaction") {
      const s = params[0] as string;
      if (failOnce.has(s)) {
        failOnce.delete(s);
        throw new Error("getTransaction: HTTP 429");
      }
      return txs.get(s) ?? null;
    }
    throw new Error(`unexpected ${method}`);
  }) as import("../src/lib/solanaRings/metricsServer").SolRpc;
  return { rpc, calls, failOnce };
}
{
  resetMemoryKv();
  server.resetSolanaMetrics();
  const relay = randomKey();
  const sigs: { signature: string; slot: number; err: unknown; blockTime: number }[] = [];
  const txs = new Map<string, RpcTx>();
  const addTx = (slot: number, err: unknown = null) => {
    const s = sig();
    sigs.push({ signature: s, slot, err, blockTime: NOW - 1_000 + slot });
    txs.set(s, mkTx({ payer: relay, signers: [randomKey()], ixs: [[USER_REGISTRY_PROGRAM, 0]], slot, ts: NOW - 1_000 + slot, err }));
    return s;
  };
  for (let i = 1; i <= 5; i++) addTx(i);
  const failedSig = addTx(6, { InstructionError: [0, "Custom"] });
  const chain = fakeChain(sigs, txs);
  chain.failOnce.add(sigs[0]!.signature);
  const s1 = await server.scanRelay(chain.rpc, relay);
  const fetched1 = chain.calls.filter((c) => c.method === "getTransaction").length;
  ok(fetched1 === 5, "the first read fetches each transaction once, but not the failed one");
  ok(s1.txs.get(failedSig)?.k === "failed" && s1.pending.length === 1 && s1.pending[0] === sigs[0]!.signature, "one that could not be read waits for the next read");
  chain.calls.length = 0;
  const newer = addTx(7);
  const s2 = await server.scanRelay(chain.rpc, relay);
  const gotTx = chain.calls.filter((c) => c.method === "getTransaction").map((c) => c.params[0]);
  const list = chain.calls.find((c) => c.method === "getSignaturesForAddress")!.params[1] as { until?: string };
  ok(list.until === failedSig, "the next read lists only signatures newer than the last one listed");
  ok(gotTx.length === 2 && gotTx.includes(newer) && gotTx.includes(sigs[0]!.signature), "and fetches only the new one and the one that waited");
  ok([...s2.txs.values()].filter((e) => e.k === "open").length === 6 && s2.pending.length === 0, "six accounts opened, nothing waiting");

  // kept by signature: a new instance reads the store, and fetches nothing it has
  server.resetSolanaMetrics();
  chain.calls.length = 0;
  const s3 = await server.scanRelay(chain.rpc, relay);
  ok(s3.txs.size === 7 && chain.calls.filter((c) => c.method === "getTransaction").length === 0, "a fresh instance starts from what was kept, fetching nothing again");
  const [h] = await kv([["HGETALL", `gloam:solana:relay:v1:${relay}:tx`]]);
  ok(Array.isArray(h) && h.length === 14, "every transaction read is kept once, by signature");
}
{
  // a long history: 5,000 signatures a read, caught up over reads, newer ones picked up after
  resetMemoryKv();
  server.resetSolanaMetrics();
  const relay = randomKey();
  const sigs = [...Array(5_050).keys()].map((i) => ({ signature: sig(), slot: i + 1, err: { InstructionError: [0, "x"] }, blockTime: NOW }));
  const chain = fakeChain(sigs, new Map());
  const a = await server.scanRelay(chain.rpc, relay);
  ok(a.txs.size === 5_000 && a.gap !== null && a.newest === null, "the first read lists 5,000 and leaves the rest for later");
  sigs.push({ signature: sig(), slot: 9_999, err: { InstructionError: [0, "x"] }, blockTime: NOW });
  const b = await server.scanRelay(chain.rpc, relay);
  ok(b.txs.size === 5_050 && b.gap === null && b.newest === sigs[5_049]!.signature, "the next finishes the older ones");
  const c = await server.scanRelay(chain.rpc, relay);
  ok(c.txs.size === 5_051 && c.newest === sigs[5_050]!.signature, "and the one after picks up what came in meanwhile");
}

// ---------------------------------------------------------------- wallet adds kept

console.log("Wallet adds, kept once");
{
  resetMemoryKv();
  const wallet = randomKey();
  const s = sig();
  const tx = mkTx({ payer: wallet, ixs: [[SHIELDED_POOL_PROGRAM, 15]], lam: { [wallet]: [2_000_000_000, 1_499_990_000], [parse.POOL_SOL_VAULT]: [1, 500_000_001] }, ts: NOW - 10 });
  let reads = 0;
  const rpc = (async () => {
    reads++;
    return reads === 1 ? null : tx;
  }) as import("../src/lib/solanaRings/metricsServer").SolRpc;
  const deps = { rpc, relays: [RELAY], nowSec: () => NOW, wait: async () => {} };
  const r1 = await server.recordSolanaAdd(s, deps);
  ok(r1.recorded && reads === 2, "an add not readable the moment it lands is asked for again, then kept");
  const r2 = await server.recordSolanaAdd(s, deps);
  ok(!r2.recorded && r2.reason === "already recorded" && reads === 2, "reported again, it is not read or kept twice");
  const r3 = await server.recordSolanaAdd(sig(), { ...deps, rpc: (async () => null) as never });
  ok(!r3.recorded && r3.reason === "not found", "one Solana never shows is not kept");
  const got = await server.readSolanaAdds(NOW + 100);
  ok(got.adds.length === 1 && got.adds[0]!.sig === s && got.adds[0]!.w === wallet && got.since === NOW - 10, "the record has the one add, counted since the first one landed");
}

// ---------------------------------------------------------------- the route

console.log("/api/solana/added");
{
  resetMemoryKv();
  env.GLOAM_SOLANA_METRICS_RPC = "https://solana.example.test";
  const wallet = randomKey();
  const good = sig();
  const tx = mkTx({ payer: wallet, ixs: [[SHIELDED_POOL_PROGRAM, 15]], lam: { [wallet]: [2_000_000_000, 1_499_990_000], [parse.POOL_SOL_VAULT]: [1, 500_000_001] }, ts: Math.floor(Date.now() / 1000) - 5 });
  const realFetch = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    assert.equal(String(url), "https://solana.example.test", "it reads Solana where it was told, nowhere else");
    asked++;
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    assert.equal(body.method, "getTransaction");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: tx }), { status: 200 });
  }) as typeof fetch;
  try {
    const route = await import("../src/app/api/solana/added/route");
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      route.POST(new Request("http://localhost/api/solana/added", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", ...headers }, body: JSON.stringify(body) }));
    ok((await post({ signature: good }, { "sec-fetch-site": "cross-site" })).status === 403, "another site can't report one");
    ok((await post({ signature: "nope" })).status === 400 && asked === 0, "a malformed signature is refused before Solana is asked");
    const r = await post({ signature: good });
    const j = (await r.json()) as { ok: boolean; recorded: boolean };
    ok(r.status === 200 && j.ok && j.recorded, "a real add is checked on chain and kept");
    const again = (await (await post({ signature: good })).json()) as { recorded: boolean };
    ok(again.recorded === false, "the same add reported twice is kept once");
    // the limit counts per clock minute: start the burst well inside one
    if (new Date().getSeconds() > 50) await new Promise((r) => setTimeout(r, (61 - new Date().getSeconds()) * 1000));
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await post({ signature: sig() }, { "x-forwarded-for": "203.0.113.77" })).status);
    ok(statuses.slice(0, 10).every((x) => x === 200) && (await post({ signature: sig() }, { "x-forwarded-for": "203.0.113.77" })).status === 429, "ten a minute from one address, then it waits");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------- the read

console.log("The whole read");
{
  resetMemoryKv();
  server.resetSolanaMetrics();
  delete env.GLOAM_SOLANA_METRICS_RPC;
  const off = await server.readSolanaMetrics(days, revenueDays, launchDays);
  ok(off && off.error?.includes("HELIUS_API_KEY") && off.deposits === 0 && off.relays[0] === RELAY, "with no RPC it says so and still answers, never throws");
  env.GLOAM_SOLANA_METRICS_RPC = "https://solana.example.test";
  const realFetch = globalThis.fetch;
  const list = Object.entries(fixtures).map(([signature, tx]) => ({ signature, slot: tx.slot, err: null, blockTime: tx.blockTime }));
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const result = body.method === "getSignaturesForAddress" ? ((body.params[1] as { until?: string }).until ? [] : list.sort((a, b) => b.slot - a.slot)) : fixtures[body.params[0] as string] ?? null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  }) as typeof fetch;
  try {
    const got = (await server.readSolanaMetrics(days, revenueDays, launchDays))!;
    ok(got.error === null && got.accountsOpened === 4 && got.bringIns === 2 && got.transfers === 0 && got.cashouts === 0, "the real history: four accounts opened, two bring-ins, nothing paid or cashed out");
    ok(Math.abs(got.netInUsd - 28.624356) < 1e-9 && got.depositors === 1 && got.revenue.fees.all === 0, "net in 28.62 USDC, one depositor, no fees");
    ok(got.lastSlot === 473009416, "read to the relay's newest slot");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------- the page

console.log("The page");
{
  const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  const charts = src("components/admin/AdminCharts.tsx");
  const overview = src("components/admin/tabs/Overview.tsx");
  const side = src("components/admin/side.ts");
  const streams = src("components/admin/streams.tsx");
  const client = src("lib/solanaRings/client.ts");
  const report = src("lib/solanaRings/addReport.ts");
  ok(/const at = solana \? solanaSlot\(nets\.map\(\(m\) => m\.key\)\) : nets\.length;/.test(charts), "Solana's card goes where the network menu puts it");
  ok(nets.solanaSlot(["robinhood-mainnet", "base-mainnet", "bnb-mainnet", "tempo-mainnet"]) === 2, "right after Robinhood Chain and Base, before BNB Chain");
  ok(/\["Net in", money\(sol\.netInUsd\)/.test(charts) && !/\["In the vault", money\(sol/.test(charts), "the card says Net in, never In the vault");
  ok(/\["Fees earned", money\(0\)/.test(charts), "fees earned shows $0.00, not hidden");
  ok(/Relay \{shortAddress\(relay, 4\)\}/.test(charts) && /solscan\.io\/account\//.test(src("lib/solanaRings/metrics.ts")), "the link is the relay, labelled as one");
  ok(/solCell/.test(overview) && /"Accounts opened"/.test(overview) && /Net in \$\{fmtUsd\(x\.netInUsd\)\}/.test(overview), "the by-network table has a Solana column, accounts opened and net in");
  ok(
    /adds a wallet paid for itself are counted \$\{since \? `since \$\{since\}` : "from the day this shipped"\}, nothing before/.test(overview) && /Adds a wallet paid for itself counted since/.test(charts),
    "the page says adds a wallet paid for itself count from the day this shipped"
  );
  ok(/withSolana\(evmAgg, solana\)/.test(side) && /solana\?\.recent/.test(side), "the mainnet totals and the feed have Solana in");
  ok(/SolanaTicks/.test(streams), "the vault activity card has a Solana row");
  const add = client.slice(client.indexOf("export async function addToPrivate"), client.indexOf("export type SendOptions"));
  ok(/if \(r\.state === "landed"\) \{\n\s*noteWalletAdd\(signature\);/.test(add) && (add.match(/noteWalletAdd/g) ?? []).length === 1, "addToPrivate reports an add once it lands, wallet-paid or relay-paid, and only then");
  ok(/void fetch\([\s\S]{0,300}keepalive: true[\s\S]{0,40}\.catch\(\(\) => \{\}\)/.test(report) && !/await/.test(report), "without waiting on it, and a failure changes nothing");
  const build = client.slice(client.indexOf("export async function buildAddTransaction"), client.indexOf("export const ADD_FAILED"));
  ok(!/memo|Memo|noteWalletAdd/.test(build), "nothing is added to the add itself: no memo, no marker");
  const files = [
    "lib/solanaRings/metrics.ts",
    "lib/solanaRings/metricsParse.ts",
    "lib/solanaRings/metricsServer.ts",
    "app/api/solana/added/route.ts",
    "components/admin/AdminCharts.tsx",
    "components/admin/tabs/Overview.tsx",
    "components/admin/streams.tsx",
  ];
  ok(files.every((f) => !src(f).includes("—")), "no em dashes in what this added");
  ok(!/sender is hidden|recipient is hidden|hides who/i.test(charts + overview + src("lib/solanaRings/metrics.ts")), "never says Solana hides the sender or the recipient");
}

console.log(`\nselftest-solana-metrics: ${pass} checks passed`);
