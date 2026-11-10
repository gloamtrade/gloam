import { ELYSIUM, ELYSIUM_LIVE_SINCE } from "./elysium";

/**
 * Mainnet: the pools, the launch time, and whether mainnet is live.
 *
 * MAINNET_POOLS is FILLED IN ON DEPLOY DAY: paste each pool address and the
 * block its deploy transaction landed in (the deploy script prints both). Until
 * a chain has both, that mainnet is hidden everywhere: the app, the API, the
 * relay, the MCP server, Glim and proofs all act as if it does not exist.
 *
 * BASE_SEPOLIA_POOL is the same for Base Sepolia, Base's testnet: it
 * runs the mainnet pool (ShieldPoolPayments, final keys, deposit limits) with test
 * funds, so it is filled in the same way after its deploy (DEPLOY-BASE.md) and
 * hidden until then.
 *
 * ETHEREUM_SEPOLIA_POOL is the same for Ethereum Sepolia, Ethereum's testnet,
 * with its payment-message board next to it (DEPLOY-ETHEREUM-SEPOLIA.md).
 *
 * The block number can be written plain (12345678) or as a bigint (12345678n).
 *
 * Elysium mainnet is not in MAINNET_POOLS: its chain id was not public when it
 * was added, so its values (pool included) live in lib/elysium.ts, behind
 * NEXT_PUBLIC_ELYSIUM_ENABLED. It joins MAINNET_CHAINS below once it is on.
 */

export const MAINNET_POOLS: Record<MainnetChainId, MainnetPoolInput> = {
  // Robinhood Chain mainnet (4663)
  4663: { pool: "0x39e28cde55cab798874746ac52cb4b5cc99a0194", deployBlock: 94_194_599 },
  // Tempo mainnet (4217): USDC.e, pathUSD, USDT0, OUSD
  4217: { pool: "0x39e28cde55cab798874746ac52cb4b5cc99a0194", deployBlock: 45_172_561 },
  // Base mainnet (8453): USDC, EURC, USDT, ETH. Deployed 26 Oct 2026 (DEPLOY-BASE.md).
  8453: { pool: "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", deployBlock: 53109632 },
  // Ethereum mainnet (1): USDC, USDT, USDG, PYUSD, EURC, ETH. Deployed 26 Oct 2026 (DEPLOY-ETHEREUM.md).
  1: { pool: "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", deployBlock: 26276183 },
};

/** Base Sepolia (84532): USDC, EURC, ETH, test funds. Deployed 24 Oct 2026 (DEPLOY-BASE.md). */
export const BASE_SEPOLIA_POOL: MainnetPoolInput = { pool: "0x39e28cde55cab798874746ac52cb4b5cc99a0194", deployBlock: 49_802_958 };

/**
 * Ethereum Sepolia (11155111), a testnet: USDC, USDG, PYUSD, EURC, ETH. The
 * vault and its deploy block, and the memo board and its block, from its
 * deploy (DEPLOY-ETHEREUM-SEPOLIA.md; contracts/ethereum-sepolia-after-deploy.sh
 * fills this line in, here and in the SDK). Empty, Ethereum Sepolia is off in
 * the app, the API, the relay, the remote MCP, Glim and proofs.
 */
export const ETHEREUM_SEPOLIA_POOL: TestnetPoolInput = { pool: "0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef", deployBlock: 11992914, payMemo: "0x8699D015087dE6D25d55d5ceB63b34b9d773f135", payMemoBlock: 11992942 };

export type MainnetChainId = 4663 | 4217 | 8453 | 1;

type MainnetPoolInput = { pool: string | null; deployBlock: number | bigint | null };

/** A testnet pool and its payment-message board (null where the board is not deployed). */
type TestnetPoolInput = MainnetPoolInput & { payMemo: string | null; payMemoBlock: number | bigint | null };

export type MainnetPool = { pool: `0x${string}`; deployBlock: bigint };

/**
 * A chain's mainnet pool, or null while it is not filled in. A pool address
 * that is not an address fails the build instead of quietly hiding the chain.
 */
export function mainnetPool(chainId: MainnetChainId): MainnetPool | null {
  return checkedPool(MAINNET_POOLS[chainId], `MAINNET_POOLS[${chainId}]`);
}

/** Base Sepolia's pool, or null while BASE_SEPOLIA_POOL is not filled in. Checked like a mainnet pool. */
export function baseSepoliaPool(): MainnetPool | null {
  return checkedPool(BASE_SEPOLIA_POOL, "BASE_SEPOLIA_POOL");
}

/** Ethereum Sepolia's pool, or null while ETHEREUM_SEPOLIA_POOL is not filled in. Checked like a mainnet pool. */
export function ethereumSepoliaPool(): MainnetPool | null {
  return checkedPool(ETHEREUM_SEPOLIA_POOL, "ETHEREUM_SEPOLIA_POOL");
}

/** Ethereum Sepolia's payment-message board, or null until it is filled in next to the pool. */
export function ethereumSepoliaPayMemo(): MainnetPool | null {
  const { payMemo, payMemoBlock } = ETHEREUM_SEPOLIA_POOL;
  return checkedPool({ pool: payMemo, deployBlock: payMemoBlock }, "ETHEREUM_SEPOLIA_POOL.payMemo");
}

function checkedPool({ pool, deployBlock }: MainnetPoolInput, name: string): MainnetPool | null {
  if (pool === null || deployBlock === null) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(pool) || /^0x0{40}$/.test(pool)) {
    throw new Error(`${name}.pool is not a pool address: ${pool}`);
  }
  const block = BigInt(deployBlock);
  if (block <= 0n) throw new Error(`${name}.deployBlock must be the deploy block, got ${deployBlock}`);
  return { pool: pool as `0x${string}`, deployBlock: block };
}

/**
 * Every mainnet Gloam knows, in the order it names them, with or without a pool,
 * and the day its vault went live (written the way the copy writes dates).
 * Elysium is last, and only while it is on (lib/elysium.ts).
 */
export const MAINNET_CHAINS: readonly { chainId: number; name: string; liveSince: string }[] = [
  { chainId: 4663, name: "Robinhood Chain", liveSince: "21 October 2026" },
  { chainId: 4217, name: "Tempo", liveSince: "21 October 2026" },
  { chainId: 8453, name: "Base", liveSince: "26 October 2026" },
  { chainId: 1, name: "Ethereum", liveSince: "26 October 2026" },
  ...(ELYSIUM ? [{ chainId: ELYSIUM.chainId, name: "Elysium", liveSince: ELYSIUM_LIVE_SINCE }] : []),
];

/** A MAINNET_CHAINS entry's pool: MAINNET_POOLS, or Elysium's from lib/elysium.ts. */
export function mainnetChainPool(chainId: number): MainnetPool | null {
  return chainPool(chainId);
}

function chainPool(chainId: number): MainnetPool | null {
  if (ELYSIUM && chainId === ELYSIUM.chainId) return { pool: ELYSIUM.pool, deployBlock: ELYSIUM.deployBlock };
  return chainId in MAINNET_POOLS ? mainnetPool(chainId as MainnetChainId) : null;
}

/** At least one mainnet pool is filled in. */
export const MAINNET_CONFIGURED = MAINNET_CHAINS.some((c) => chainPool(c.chainId) !== null);

/**
 * Mainnet is live once the launch time has passed and at least one pool is in.
 * Before that every page, banner and Glim answer counts down exactly as before.
 */
export function isMainnetLive(now: number = Date.now()): boolean {
  return MAINNET_CONFIGURED && now >= MAINNET_LAUNCH_MS;
}

/**
 * The chains whose mainnet pool is in, as words: "Robinhood Chain and Tempo",
 * "Robinhood Chain, Tempo, Base and Ethereum" once those are in, or one of
 * them. Robinhood Chain and Tempo, as announced, when none is in (only a test
 * asks then).
 */
export function liveMainnetNames(): string {
  const names = MAINNET_CHAINS.filter((c) => chainPool(c.chainId)).map((c) => c.name);
  if (!names.length) return "Robinhood Chain and Tempo";
  return joinNames(names);
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** How many mainnets have a pool in: 4. Two, as announced, when none is in (only a test asks then). */
export function liveMainnetCount(): number {
  return MAINNET_CHAINS.filter((c) => chainPool(c.chainId)).length || 2;
}

/** The same count as a word for copy: "four mainnets", "one mainnet". */
export function liveMainnetCountWords(): string {
  const n = liveMainnetCount();
  return `${COUNT_WORDS[n] ?? String(n)} ${n === 1 ? "mainnet" : "mainnets"}`;
}

/**
 * The live mainnets grouped by the day each went live, oldest first:
 * [{ names: "Robinhood Chain and Tempo", since: "21 October 2026" }, { names: "Base and Ethereum", since: "26 October 2026" }].
 */
export function liveMainnetsByDay(): { names: string; since: string }[] {
  const days: { names: string[]; since: string }[] = [];
  for (const c of MAINNET_CHAINS) {
    if (!chainPool(c.chainId)) continue;
    const day = days.find((d) => d.since === c.liveSince);
    if (day) day.names.push(c.name);
    else days.push({ names: [c.name], since: c.liveSince });
  }
  return days.map((d) => ({ names: joinNames(d.names), since: d.since }));
}

/**
 * The live mainnets by the day each went live, as words: "Robinhood Chain and
 * Tempo since 21 October 2026, Base and Ethereum since 26 October 2026", with
 * Elysium after them while it is on.
 */
export function liveMainnetsSinceText(): string {
  return liveMainnetsByDay()
    .map((d) => `${d.names} since ${d.since}`)
    .join(", ");
}

/**
 * Launch time, shared by the countdown page, the site banner, the homepage
 * link and Glim. Wednesday 21 October 2026, 13:00 UTC (14:00 WAT).
 */
export const MAINNET_LAUNCH_ISO = "2026-10-21T13:00:00Z";
export const MAINNET_LAUNCH_MS = Date.parse(MAINNET_LAUNCH_ISO);

/** How the launch time is written everywhere: in UTC. */
export const MAINNET_LAUNCH_LABEL = "Wednesday 21 October, 13:00 UTC";

export type Remaining = { days: number; hours: number; minutes: number; seconds: number; done: boolean };

export function remainingUntil(now: number, target = MAINNET_LAUNCH_MS): Remaining {
  const left = Math.max(0, Math.floor((target - now) / 1000));
  return {
    days: Math.floor(left / 86_400),
    hours: Math.floor((left % 86_400) / 3_600),
    minutes: Math.floor((left % 3_600) / 60),
    seconds: left % 60,
    done: left === 0,
  };
}

/** A Google Calendar link for the launch (one hour, in UTC). */
export function calendarUrl(): string {
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: "Gloam mainnet goes live",
    dates: `${stamp(MAINNET_LAUNCH_MS)}/${stamp(MAINNET_LAUNCH_MS + 3_600_000)}`,
    details: "Private payments go live on Robinhood Chain and Tempo mainnet. https://gloam.trade/mainnet",
    location: "https://gloam.trade/mainnet",
  });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}
