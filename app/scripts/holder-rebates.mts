/**
 * $GLOAM holder rebates: who gets what back this week (lib/holderRebates).
 *
 * Reads every mainnet vault's cash-outs since the last plan (Unshielded with
 * the WithdrawFee beside it), keeps those that went to a wallet holding at
 * least 1,000 $GLOAM on Robinhood Chain now, and works out 0.5% - 0.2% = 0.3%
 * back on each, summed per wallet, chain and coin.
 *
 * It only reads public chain data and writes files. It never signs or sends:
 * the treasury sends the payouts.
 *
 * Run from app/:
 *   pnpm dlx tsx scripts/holder-rebates.mts            # look only, writes nothing
 *   pnpm dlx tsx scripts/holder-rebates.mts --write    # save the plan and payouts CSV
 *
 * Options:
 *   --since 2026-11-21   start (UTC). Default: per network, where the saved plans
 *                        last covered it, or REBATE_START on the first run.
 *   --until 2026-11-28   end (UTC, not included). Default: now.
 *   --out <dir>          where plans live. Default: ~/Desktop/Gloam-Rebates
 *   --min-usd 0.10       skip stablecoin payouts smaller than this.
 *   --only base-mainnet  one network (repeatable).
 *
 * The plan files are the ledger: a cash-out in any saved plan is never
 * rebated again, and each plan records how far it read every network. A
 * network that cannot be read (BNB Chain's public RPCs keep about a day of
 * logs: set NEXT_PUBLIC_BNB_ARCHIVE_RPC_URL) is left out of that plan and
 * read from where it stopped next time. If a plan is not sent, delete its two
 * files and run again.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// BNB Chain is on in production through Vercel's env; on here too unless set.
process.env.NEXT_PUBLIC_BNB_ENABLED ??= "1";
process.env.NEXT_PUBLIC_BNB_LIVE_SINCE ??= "19 November 2026";

const { createPublicClient, erc20Abi, formatUnits, getAddress, parseAbi, parseEventLogs } = await import("viem");
const { getNetwork } = await import("../src/lib/networks");
const { readTransport } = await import("../src/lib/readTransport");
const { getLogsSafe } = await import("../src/lib/logRange");
const { shieldTokensFor, isDollarStable } = await import("../src/lib/tokens");
const { EVERY_SWAP_ROUTER } = await import("../src/lib/vaultSwap");
const { GLOAM_TOKEN, TREASURY_ADDRESS, BURN_ADDRESS } = await import("../src/lib/buybacks");
const { HOLDER_FEE_BPS, HOLDER_MIN_GLOAM, REBATE_START, planRebates } = await import(
  "../src/lib/holderRebates"
);
type CashOut = import("../src/lib/holderRebates").CashOut;
type GloamNetwork = import("../src/lib/networks").GloamNetwork;
type NetworkKey = import("../src/lib/networks").NetworkKey;

const MAINNETS: NetworkKey[] = [
  "robinhood-mainnet",
  "tempo-mainnet",
  "base-mainnet",
  "ethereum-mainnet",
  "elysium-mainnet",
  "bnb-mainnet",
];

/** Relay's router: a private bridge's cash-out leg, never a person's wallet. */
const RELAY_ROUTER = "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f";

const POOL_ABI = parseAbi([
  "event Unshielded(bytes32 indexed nullifier, address indexed asset, address indexed to, uint256 amount)",
  "event WithdrawFee(bytes32 indexed nullifier, address indexed asset, uint256 fee)",
]);

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const opts = (name: string): string[] =>
  argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]!] : []));

const outDir = opt("out") ?? join(homedir(), "Desktop", "Gloam-Rebates");
const write = flag("write");
const minUsd = Number(opt("min-usd") ?? "0.10");
const only = opts("only") as NetworkKey[];

function parseDay(s: string, what: string): number {
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (!Number.isFinite(ms)) throw new Error(`--${what} is not a date: ${s}`);
  return Math.floor(ms / 1000);
}

// ---------------------------------------------------------------- ledger

type SavedPlan = { since: string; until: string; covered?: Record<string, string>; rebated: { key: string }[] };

function savedPlans(): SavedPlan[] {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((f) => /^plan-.*\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(outDir, f), "utf8")) as SavedPlan);
}

const plans = savedPlans();
const alreadyPaid = new Set(plans.flatMap((p) => p.rebated.map((r) => r.key)));
/** Per network, the furthest any saved plan read it. */
const lastCovered = new Map<string, number>();
for (const p of plans) {
  for (const [k, v] of Object.entries(p.covered ?? {})) {
    const t = parseDay(v, "until");
    if (t > (lastCovered.get(k) ?? 0)) lastCovered.set(k, t);
  }
}

const rebateStart = parseDay(REBATE_START, "since");
const until = opt("until") ? parseDay(opt("until")!, "until") : Math.floor(Date.now() / 1000);
const sinceFor = (k: string) => (opt("since") ? parseDay(opt("since")!, "since") : (lastCovered.get(k) ?? rebateStart));

// ---------------------------------------------------------------- chain reads

function clientFor(n: GloamNetwork) {
  return createPublicClient({ chain: n.chain, transport: readTransport(n, { timeout: 25_000, retryCount: 3 }) });
}

/** The first block at or after `ts` (unix seconds), between `lo` and `hi`. */
async function blockAtOrAfter(c: ReturnType<typeof clientFor>, ts: number, lo: bigint, hi: bigint): Promise<bigint> {
  const at = async (b: bigint) => Number((await c.getBlock({ blockNumber: b })).timestamp);
  if ((await at(hi)) < ts) return hi + 1n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if ((await at(mid)) < ts) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

async function readCashOuts(key: NetworkKey, since: number): Promise<{ cashOuts: CashOut[]; note?: string }> {
  const n = getNetwork(key);
  if (!n.pool || n.deployBlock == null) return { cashOuts: [], note: "no vault configured, skipped" };
  if (since >= until) return { cashOuts: [], note: "already covered" };
  const c = clientFor(n);
  const latest = await c.getBlockNumber();
  const from = await blockAtOrAfter(c, since, n.deployBlock, latest);
  const to = (await blockAtOrAfter(c, until, from > latest ? latest : from, latest)) - 1n;
  if (from > to) return { cashOuts: [] };

  const logs = [];
  for (let a = from; a <= to; a += n.logRange) {
    const b = a + n.logRange - 1n > to ? to : a + n.logRange - 1n;
    logs.push(...(await getLogsSafe((x, y) => c.getLogs({ address: n.pool!, fromBlock: x, toBlock: y }), a, b)));
  }
  const parsed = parseEventLogs({ abi: POOL_ABI, logs });
  const feeOf = new Map<string, bigint>();
  for (const l of parsed) {
    if (l.eventName === "WithdrawFee") feeOf.set(`${l.transactionHash}:${l.args.nullifier}`, l.args.fee);
  }
  const unshields = parsed.filter((l) => l.eventName === "Unshielded");
  const blocks = [...new Set(unshields.map((l) => l.blockNumber!))];
  const times = new Map<bigint, number>();
  for (let i = 0; i < blocks.length; i += 8) {
    await Promise.all(
      blocks.slice(i, i + 8).map(async (b) => times.set(b, Number((await c.getBlock({ blockNumber: b })).timestamp)))
    );
  }
  const out: CashOut[] = [];
  for (const l of unshields) {
    if (l.eventName !== "Unshielded") continue;
    const block = l.blockNumber!;
    const asset = l.args.asset.toLowerCase() === "0x0000000000000000000000000000000000000000" ? "native" : l.args.asset.toLowerCase();
    out.push({
      chainId: n.chainId,
      network: n.label,
      txHash: l.transactionHash!,
      nullifier: l.args.nullifier,
      asset,
      to: l.args.to.toLowerCase(),
      amount: l.args.amount,
      fee: feeOf.get(`${l.transactionHash}:${l.args.nullifier}`) ?? 0n,
      block,
      time: times.get(block)!,
    });
  }
  return { cashOuts: out };
}

/** Wallets holding at least HOLDER_MIN_GLOAM $GLOAM on Robinhood Chain now. */
async function readHolders(wallets: string[]): Promise<Map<string, bigint>> {
  const c = clientFor(getNetwork("robinhood-mainnet"));
  const out = new Map<string, bigint>();
  for (const w of wallets) {
    const bal = await c.readContract({
      address: GLOAM_TOKEN,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(w)],
    });
    out.set(w, bal);
  }
  return out;
}

function assetMeta(n: GloamNetwork, asset: string): { symbol: string; decimals: number; stable: boolean; address: string } {
  if (asset === "native") {
    const cur = n.chain.nativeCurrency;
    return { symbol: cur.symbol, decimals: cur.decimals, stable: false, address: "native" };
  }
  const t = shieldTokensFor(n.chainId).find((x) => x.address.toLowerCase() === asset);
  if (t) return { symbol: t.symbol, decimals: t.decimals, stable: isDollarStable(t), address: t.address };
  return { symbol: asset.slice(0, 10), decimals: 18, stable: false, address: asset };
}

// ---------------------------------------------------------------- run

const keys = only.length ? only : MAINNETS;
const iso = (s: number) => new Date(s * 1000).toISOString().replace(".000Z", "Z");
const since = Math.min(...keys.map(sinceFor));
console.log(`Holder rebates up to ${iso(until)}`);
console.log(`Holders: at least ${HOLDER_MIN_GLOAM} $GLOAM on Robinhood Chain. Holder fee ${Number(HOLDER_FEE_BPS) / 100}%.\n`);

const all: CashOut[] = [];
/** Networks read in full this run, and up to when. */
const covered: Record<string, string> = {};
const missed: string[] = [];
await Promise.all(
  keys.map(async (k) => {
    const from = sinceFor(k);
    const label = getNetwork(k).label;
    try {
      const { cashOuts, note } = await readCashOuts(k, from);
      console.log(`${label}, from ${iso(from)}: ${note ?? `${cashOuts.length} cash-outs`}`);
      all.push(...cashOuts);
      covered[k] = iso(Math.max(until, from));
    } catch (e) {
      missed.push(label);
      console.error(`${label}: could not read, left for next time (${e instanceof Error ? e.message.split("\n")[0] : e})`);
    }
  })
);

const excluded = new Set(
  [TREASURY_ADDRESS, BURN_ADDRESS, RELAY_ROUTER, ...EVERY_SWAP_ROUTER, ...keys.map((k) => getNetwork(k).pool ?? "")]
    .filter(Boolean)
    .map((a) => a.toLowerCase())
);
const wallets = [...new Set(all.map((c) => c.to))].filter((w) => !excluded.has(w));
const balances = await readHolders(wallets);
const min = HOLDER_MIN_GLOAM * 10n ** 18n;
console.log(
  `\n${wallets.length} wallets cashed out; ${wallets.filter((w) => (balances.get(w) ?? 0n) >= min).length} hold at least ${HOLDER_MIN_GLOAM} $GLOAM.`
);
const holding = (gloam: bigint) => wallets.filter((w) => (balances.get(w) ?? 0n) >= gloam * 10n ** 18n).length;
console.log(
  `  hold any: ${wallets.filter((w) => (balances.get(w) ?? 0n) > 0n).length}, 10+: ${holding(10n)}, 100+: ${holding(100n)}, 500+: ${holding(500n)}`
);
const plan = planRebates(all, {
  isHolder: (w) => (balances.get(w) ?? 0n) >= min,
  alreadyPaid,
  excluded,
  startTime: rebateStart,
});

type Row = { network: string; chainId: number; symbol: string; token: string; decimals: number; to: string; amount: string; raw: bigint; cashOuts: number; keys: string[]; dust: boolean };
const rows: Row[] = plan.payouts.map((p) => {
  const n = keys.map((k) => getNetwork(k)).find((x) => x.chainId === p.chainId)!;
  const m = assetMeta(n, p.asset);
  const amount = formatUnits(p.amount, m.decimals);
  return {
    network: p.network,
    chainId: p.chainId,
    symbol: m.symbol,
    token: m.address,
    decimals: m.decimals,
    to: getAddress(p.to),
    amount,
    raw: p.amount,
    cashOuts: p.cashOuts.length,
    keys: p.cashOuts,
    dust: m.stable && Number(amount) < minUsd,
  };
});
const sendRows = rows.filter((r) => !r.dust);
const dustRows = rows.filter((r) => r.dust);

console.log(`\n${all.length} cash-outs read, ${plan.rebated.length} rebated.`);
for (const [why, count] of Object.entries(plan.skipped)) if (count) console.log(`  not rebated, ${why}: ${count}`);
if (dustRows.length) console.log(`  under $${minUsd}, skipped: ${dustRows.length} payout(s)`);
if (missed.length) console.log(`  not read this time: ${missed.join(", ")}`);

if (!sendRows.length) {
  console.log("\nNothing to send.");
} else {
  console.log("\nTo send from the treasury:");
  for (const r of sendRows) {
    console.log(`  ${r.network.padEnd(16)} ${`${r.amount} ${r.symbol}`.padEnd(24)} -> ${r.to}  (${r.cashOuts} cash-out${r.cashOuts === 1 ? "" : "s"})`);
  }
  const totals = new Map<string, number>();
  for (const r of sendRows) totals.set(`${r.network} ${r.symbol}`, (totals.get(`${r.network} ${r.symbol}`) ?? 0) + Number(r.amount));
  console.log("\nTotals:");
  for (const [k, v] of totals) console.log(`  ${k}: ${v}`);
}

if (!write) {
  console.log("\nLooked only. Add --write to save the plan and the payouts CSV.");
} else {
  mkdirSync(outDir, { recursive: true });
  const name = `${iso(since).slice(0, 10)}_to_${iso(until).slice(0, 10)}`;
  const sent = new Set(sendRows.flatMap((r) => r.keys));
  const planFile = join(outDir, `plan-${name}.json`);
  writeFileSync(
    planFile,
    JSON.stringify(
      {
        since: iso(since),
        until: iso(until),
        covered,
        madeAt: new Date().toISOString(),
        holderFeeBps: Number(HOLDER_FEE_BPS),
        holderMinGloam: Number(HOLDER_MIN_GLOAM),
        // every cash-out this plan settles, dust included, so none is counted twice
        rebated: plan.rebated.map((r) => ({ key: r.key, rebate: r.rebate.toString(), sent: sent.has(r.key) })),
        payouts: sendRows.map(({ keys, ...r }) => ({ ...r, raw: r.raw.toString(), cashOutKeys: keys })),
        skipped: plan.skipped,
      },
      null,
      2
    )
  );
  const csvFile = join(outDir, `payouts-${name}.csv`);
  writeFileSync(
    csvFile,
    ["network,chainId,token,symbol,decimals,to,amount,amountRaw,cashOuts", ...sendRows.map((r) => [r.network, r.chainId, r.token, r.symbol, r.decimals, r.to, r.amount, r.raw, r.cashOuts].join(","))].join("\n") + "\n"
  );
  console.log(`\nSaved:\n  ${planFile}\n  ${csvFile}`);
}
