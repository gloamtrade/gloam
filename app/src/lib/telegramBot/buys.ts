/**
 * $GLOAM buy alerts in the group's Buys topic. The helper reads $GLOAM leaving
 * the Uniswap v4 PoolManager on Robinhood Chain, adds it up per transaction,
 * and posts each buy with its rough dollar value from DEX Screener. A buy is a
 * transaction that swapped through the PoolManager and changed no liquidity:
 * $GLOAM taken out of a position is not a buy, and is never posted. No model
 * call, no price talk beyond the value of the buy.
 *
 * It runs after Telegram updates (at most every BUY_CHECK_SEC) and from the
 * once-a-minute cron at /api/telegram/buys. The first run starts at the
 * current block, so it never posts old buys. Every buy is posted, whatever its
 * size (TELEGRAM_BUY_MIN_USD sets a floor). TELEGRAM_BUY_ALERTS=0 turns it
 * off; TELEGRAM_BUYS_TOPIC overrides the Buys topic.
 *
 * Each buy goes out as the $GLOAM token image (the one on CoinGecko) with the
 * text as its caption. If Telegram refuses the photo, the same text goes out
 * as a plain post; after a timeout it does not, since the photo may be up.
 * Each transaction is claimed before it is posted, so two checks never post
 * the same buy. A post that fails stops the check there, and the next one
 * starts at that buy; when Telegram says to slow down, checks wait as long
 * as it asks.
 */
import { GLOAM_TOKEN } from "./knowledge";
import { TOPIC } from "./rules";
import { buysLastBlock, buysPaused, claimBuy, pauseBuys, releaseBuy, setBuysLastBlock, spaceBuysSlot, takeBuysSlot } from "./store";
import { CAPTION_MAX, sendPhoto, trySendMessage } from "./telegram";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** PoolManager Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24). */
const SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
/** PoolManager ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32): liquidity added or taken out. */
const MODIFY_LIQUIDITY = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";
const EXPLORER = "robin.etherscan.io";
/** Checks at least this far apart; with MAX_POSTS that stays well under Telegram's 20 posts a minute in a group. */
export const BUY_CHECK_SEC = 30;
/** A check holds its slot this long at most: longer than the webhook or the cron may run (60 seconds). */
const BUY_HOLD_SEC = 75;
/** Time a check may spend before it leaves the rest to the next one, inside those 60 seconds. */
const BUY_BUDGET_MS = 40_000;
/** Blocks read per check; Robinhood Chain makes about 10 a second. */
const MAX_RANGE = 20_000;
/** Further behind than this (the bot was off), it skips ahead instead of posting old buys. */
const MAX_LAG = 60_000;
/** Posts per check. Any more wait for the next check, so every buy gets its own post. */
const MAX_POSTS = 6;

type Log = { transactionHash: string; blockNumber: string; data: string; topics: string[] };
type Receipt = { from?: string; status?: string; logs?: { address?: string; topics?: string[] }[] };

/**
 * A transaction is a buy when it swapped through the PoolManager and changed
 * no liquidity there: $GLOAM taken out of a position, alone or with a swap
 * beside it, is not a buy.
 */
export function isSwapBuy(r: Receipt): boolean {
  if (r.status !== undefined && r.status !== "0x1") return false;
  const events = (r.logs ?? []).filter((l) => l.address?.toLowerCase() === POOL_MANAGER).map((l) => l.topics?.[0]?.toLowerCase());
  return events.includes(SWAP) && !events.includes(MODIFY_LIQUIDITY);
}

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    const j = (await res.json()) as { result?: T; error?: unknown };
    return j.error ? null : (j.result ?? null);
  } catch {
    return null;
  }
}

type Market = { price: number; marketCap: number | null };

/** $GLOAM's price and market cap, from the deepest pool on DEX Screener. */
async function market(): Promise<Market | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${GLOAM_TOKEN.address}`, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
    const j = (await res.json()) as { pairs?: { priceUsd?: string; marketCap?: number; fdv?: number; liquidity?: { usd?: number } }[] };
    const best = [...(j.pairs ?? [])].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const price = Number(best?.priceUsd);
    if (!Number.isFinite(price) || price <= 0) return null;
    const cap = Number(best?.marketCap ?? best?.fdv);
    return { price, marketCap: Number.isFinite(cap) && cap > 0 ? cap : null };
  } catch {
    return null;
  }
}

export function buyAlertsOn(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env.TELEGRAM_BUY_ALERTS?.trim() ?? "");
}

function minUsd(): number {
  const n = Number(process.env.TELEGRAM_BUY_MIN_USD ?? "");
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });

const compact = (n: number) => (n >= 1e6 ? `${fmt(n / 1e6, 2)}M` : n >= 1e3 ? `${fmt(n / 1e3, 1)}K` : fmt(n));

type Buy = { amount: number; usd: number | null; buyer: string; tx: string; price?: number | null; marketCap?: number | null };

/** One buy, spaced like the helper's other posts. */
export function buyText(b: Buy): string {
  const value = b.usd !== null ? `, about $${fmt(b.usd, b.usd < 100 ? 2 : 0)}` : "";
  const stats = [b.price ? `Price $${b.price.toFixed(b.price < 1 ? 4 : 2)}` : "", b.marketCap ? `Market cap $${compact(b.marketCap)}` : ""].filter(Boolean).join("\n");
  return [`New $GLOAM buy`, `${fmt(b.amount)} GLOAM${value}\nBuyer ${short(b.buyer)}`, stats, `Tx: ${EXPLORER}/tx/${b.tx}\nChart: ${GLOAM_TOKEN.chart}`]
    .filter(Boolean)
    .join("\n\n");
}

/** The $GLOAM token image, as CoinGecko shows it: the mark in ink on paper. */
export const BUY_IMAGE = "https://www.gloam.trade/brand/kit/gloam-avatar-paper.png";

/** The image once Telegram holds it, so later buys don't make it fetch the URL again. Per server instance. */
let buyImageId: string | null = null;

/** What became of one buy post. A timeout counts as out: the post may well be up, and a second one would show the buy twice. */
export type BuyPost = { ok: true } | { ok: false; retryAfter?: number };

/**
 * Posts one buy: the token image with the text as its caption, or the text on
 * its own if Telegram refuses the photo.
 */
export async function postBuy(groupId: number, topic: number, text: string): Promise<BuyPost> {
  if (text.length <= CAPTION_MAX) {
    let sent = await sendPhoto(groupId, buyImageId ?? BUY_IMAGE, text, { threadId: topic });
    // a stale file_id (another bot token, a cleared file): try the URL once
    if (!sent.ok && sent.refused && !sent.retryAfter && buyImageId) {
      buyImageId = null;
      sent = await sendPhoto(groupId, BUY_IMAGE, text, { threadId: topic });
    }
    if (sent.ok) {
      if (sent.fileId) buyImageId = sent.fileId;
      return { ok: true };
    }
    if (!sent.refused) return { ok: true };
    if (sent.retryAfter) return { ok: false, retryAfter: sent.retryAfter };
  }
  const plain = await trySendMessage(groupId, text, { threadId: topic });
  if (plain.ok || !plain.refused) return { ok: true };
  return plain.retryAfter ? { ok: false, retryAfter: plain.retryAfter } : { ok: false };
}

/** The group's Buys topic, unless the env names another. */
function buysTopic(): number {
  const fromEnv = Number(process.env.TELEGRAM_BUYS_TOPIC ?? "");
  return Number.isSafeInteger(fromEnv) && fromEnv > 0 ? fromEnv : TOPIC.buys;
}

/**
 * The buys to post now, oldest first: up to `max`, but never splitting a block,
 * so the next check can start at the following block without posting one twice.
 * `until` is the last block taken when some are left over, else null.
 */
export function pickBuys<T extends { block: number }>(buys: T[], max: number): { take: T[]; until: number | null } {
  if (buys.length <= max) return { take: buys, until: null };
  let n = max;
  while (n < buys.length && buys[n]!.block === buys[n - 1]!.block) n++;
  return n < buys.length ? { take: buys.slice(0, n), until: buys[n - 1]!.block } : { take: buys, until: null };
}

/** Checks for new buys and posts them, within `budgetMs`. Returns how many it posted. Never throws. */
export async function pollBuys(groupId: number, force = false, budgetMs = BUY_BUDGET_MS): Promise<number> {
  if (!buyAlertsOn()) return 0;
  const deadline = Date.now() + budgetMs;
  try {
    if (await buysPaused()) return 0;
    if (!force && !(await takeBuysSlot(BUY_HOLD_SEC))) return 0;
    try {
      return await checkBuys(groupId, deadline);
    } finally {
      if (!force) await spaceBuysSlot(BUY_CHECK_SEC);
    }
  } catch (e) {
    console.error("telegram: buy check failed", e instanceof Error ? e.message : "unknown");
    return 0;
  }
}

async function checkBuys(groupId: number, deadline: number): Promise<number> {
  const headHex = await rpc<string>("eth_blockNumber", []);
  if (!headHex) return 0;
  const head = parseInt(headHex, 16);
  const last = await buysLastBlock();
  if (last === null || head - last > MAX_LAG) {
    await setBuysLastBlock(head);
    return 0;
  }
  if (head <= last) return 0;
  const from = last + 1;
  const to = Math.min(head, from + MAX_RANGE - 1);
  const pm = `0x${POOL_MANAGER.slice(2).padStart(64, "0")}`;
  const range = { address: GLOAM_TOKEN.address, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` };
  const [outs, ins] = await Promise.all([
    rpc<Log[]>("eth_getLogs", [{ ...range, topics: [TRANSFER, pm] }]),
    rpc<Log[]>("eth_getLogs", [{ ...range, topics: [TRANSFER, null, pm] }]),
  ]);
  if (!outs || !ins) return 0;
  // net per transaction: an arbitrage moves $GLOAM in and out of the pools at once and is not a buy
  const net = new Map<string, { amount: number; block: number }>();
  for (const l of outs) {
    const cur = net.get(l.transactionHash);
    net.set(l.transactionHash, { amount: (cur?.amount ?? 0) + Number(BigInt(l.data)) / 1e18, block: parseInt(l.blockNumber, 16) });
  }
  for (const l of ins) {
    const cur = net.get(l.transactionHash);
    if (cur) cur.amount -= Number(BigInt(l.data)) / 1e18;
  }
  const found = pickBuys([...net].filter(([, v]) => v.amount > 0.01).map(([tx, v]) => ({ tx, ...v })), MAX_POSTS);
  let posted = 0;
  if (found.take.length) {
    const topic = buysTopic();
    const m = await market();
    const price = m?.price ?? null;
    const floor = minUsd();
    for (const { tx, amount, block } of found.take) {
      const usd = price !== null ? amount * price : null;
      if (usd !== null && usd < floor) continue;
      // out of time, or the post failed: the next check starts at this buy (the ones posted stay claimed)
      if (Date.now() > deadline) {
        await setBuysLastBlock(block - 1);
        return posted;
      }
      if (!(await claimBuy(tx))) continue;
      const r = await rpc<Receipt>("eth_getTransactionReceipt", [tx]);
      if (!r) {
        // can't tell yet whether it was a buy: the next check starts at it
        await releaseBuy(tx);
        await setBuysLastBlock(block - 1);
        return posted;
      }
      // not a swap (liquidity taken out, say): stays claimed, never posted
      if (!isSwapBuy(r)) continue;
      const b: Buy = { amount, usd, buyer: r.from ?? "0x0000000000000000000000000000000000000000", tx, price, marketCap: m?.marketCap ?? null };
      const sent = await postBuy(groupId, topic, buyText(b));
      if (sent.ok) {
        posted++;
        continue;
      }
      await releaseBuy(tx);
      if (sent.retryAfter) await pauseBuys(sent.retryAfter);
      await setBuysLastBlock(block - 1);
      return posted;
    }
  }
  // with buys left over, the next check starts right after the last block posted
  if (found.until !== null) {
    await setBuysLastBlock(found.until);
    return posted;
  }
  await setBuysLastBlock(to);
  return posted;
}
