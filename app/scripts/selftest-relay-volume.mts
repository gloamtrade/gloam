/**
 * Self-test: /admin's Bridge and swaps figures (lib/relayVolume, lib/relayLedger).
 *
 * The fake Relay below follows Relay's documented rule for GET /requests/v3: a
 * referrer filter with no apiKeyId sees public keyless requests only, and every
 * request Gloam tags is a keyed one. So this reproduces the panel's "0 bridges",
 * with a 200 and no error, and shows what fixes it. It also shows both response
 * shapes read the same, a deposit filled under a new request id is counted, once,
 * and no wallet reaches the panel or the store. The fake pages and limits as Relay
 * does, so it also shows a refresh stays within this key's 2 reads a minute, reads
 * in order, survives a 429 at each step, walks a history longer than a page over
 * several refreshes with nothing lost or counted twice, and open quotes take turns.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-relay-volume.mts
 */
import assert from "node:assert/strict";

process.env.GLOAM_PARTNERS_STORE = "memory";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.RELAY_API_KEY_ID;

const { resetMemoryKv, kv } = await import("../src/lib/partnersKv");
const { READS_PER_REFRESH, fetchRelayVolume, readRelayVolume, summarizeRelayRows } = await import("../src/lib/relayVolume");
const { noteRelayQuote, dueRelayQuotes, readRelayRows, OPEN_MS } = await import("../src/lib/relayLedger");

const KEY = "relay-secret-key-value";
const KEY_ID = "11111111-2222-4333-8444-555555555555";
const WALLET = "0xE7a2052a00000000000000000000000000000001";
const RECIPIENT = "0x0708293300000000000000000000000000000002";
const DEPOSIT_ADDRESS = "0xe42445f3a8f05e3311beba77c260b51527b1c141";

const id = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}`;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

const cur = (chainId: number, symbol: string, amountFormatted: string, amountUsd: string) => ({
  currency: { chainId, symbol, address: "0x00", decimals: 18 },
  amount: "1",
  amountFormatted,
  amountUsd,
});

/** A real v2 row's shape: same-chain rows carry no data.feesUsd. */
function v2Row(n: number, status = "success") {
  return {
    id: id(n),
    status,
    user: WALLET,
    recipient: RECIPIENT,
    depositAddress: null,
    referrer: "gloam.trade",
    createdAt: ago(1),
    data: {
      inTxs: [{ hash: "0xv2in", chainId: 4663 }],
      outTxs: [{ hash: "0xv2out", chainId: 8453 }],
      expandedPriceImpact: {
        quoted: { swap: { usd: "-9" }, execution: { usd: "-9" }, relay: { usd: "-9" }, app: { usd: "0" }, sponsored: { usd: "0" } },
        actual: { swap: { usd: "-0.7" }, execution: { usd: "-0.1" }, relay: { usd: "-0.2" }, app: { usd: "-5" }, sponsored: { usd: "0" } },
      },
      metadata: {
        sender: WALLET,
        recipient: RECIPIENT,
        currencyIn: cur(4663, "ETH", "0.2145", "501"),
        currencyOut: cur(8453, "USDC", "500.0", "500"),
      },
    },
  };
}

/** The shape in Relay's v3 migration guide: a bridge. */
function v3Bridge(n: number, status = "success") {
  return {
    id: id(n),
    status,
    user: WALLET,
    sender: WALLET,
    recipient: RECIPIENT,
    refundTo: WALLET,
    depositAddress: null,
    requestType: "Bridge",
    createdAt: ago(2),
    data: {
      inTxs: [{ txHash: "0xv3in", chainId: 137 }],
      outTxs: [{ txHash: "0xv3out", chainId: 8453 }],
      fees: {
        quoted: { swap: { usd: "-9" }, execution: { usd: "-9" }, platform: { usd: "-9" }, app: { usd: "0" }, sponsored: { usd: "0" } },
        actual: { swap: { usd: "-1.5" }, execution: { usd: "-0.25" }, platform: { usd: "-0.25" }, app: { usd: "-4" }, sponsored: { usd: "0" } },
      },
      route: {
        quoted: { origin: { inputCurrency: cur(137, "USDC.e", "10000.0", "9999") } },
        actual: {
          origin: { inputCurrency: cur(137, "USDC.e", "10000.0", "9997") },
          destination: { outputCurrency: cur(8453, "USDC", "9995.0", "9995") },
        },
      },
    },
  };
}

/** A same-chain swap on v3 has no destination side. */
function v3Swap(n: number) {
  return {
    id: id(n),
    status: "success",
    user: WALLET,
    recipient: RECIPIENT,
    createdAt: ago(3),
    data: {
      inTxs: [{ txHash: "0xswapin", chainId: 4663 }],
      outTxs: [],
      fees: { actual: { swap: { usd: "0.5" }, execution: { usd: "0" }, platform: { usd: "-0.1" } } },
      route: { actual: { origin: { inputCurrency: cur(4663, "ETH", "0.05", "120"), outputCurrency: cur(4663, "USDG", "118.0", "118") }, destination: null } },
    },
  };
}

/** `count` finished bridges, newest first, a minute apart, starting `minutesAgo` back. */
function bridges(from: number, count: number, minutesAgo = 0) {
  return Array.from({ length: count }, (_, i) => ({
    ...v3Bridge(1),
    id: `0x${(from + i).toString(16).padStart(64, "0")}`,
    createdAt: new Date(Date.now() - (minutesAgo + i) * 60_000).toISOString(),
  }));
}

type Call = { url: URL; apiKey: string | null };
let calls: Call[] = [];
/** The most calls in the air at once. */
let mostAtOnce = 0;
let inAir = 0;
/** A status for Relay to answer a call with instead. */
let refuse: (url: URL) => number | null = () => null;
/** Requests Relay holds for Gloam's key. Gloam only tags keyed quotes, so these are all keyed. */
let keyed: unknown[] = [];
let byDeposit: Record<string, unknown[]> = {};
let byId: Record<string, unknown[]> = {};
let v2Down = false;
let lookupsDown = false;

/** One page, newest first, and a cursor while the page is full. The cursor is a position, the worst kind: new requests push rows across it. */
function page(rows: unknown[], url: URL, cursorMark: string) {
  const at = Number(url.searchParams.get("continuation")?.replace(cursorMark, "") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 20);
  const requests = rows.slice(at, at + limit);
  return { requests, continuation: requests.length === limit ? `${cursorMark}${at + limit}` : undefined };
}

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  calls.push({ url, apiKey: headers.get("x-api-key") });
  mostAtOnce = Math.max(mostAtOnce, ++inAir);
  await new Promise((done) => setTimeout(done, 1));
  inAir--;
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const refused = refuse(url);
  if (refused) return answer({ message: `refused with ${refused}` }, refused);
  if (url.pathname === "/requests/v2") {
    if (v2Down) return answer({ message: "Relay retired GET /requests/v2." }, 410);
    return answer(page(keyed.filter((r) => "referrer" in (r as object)), url, "v2-"));
  }
  if (url.pathname === "/requests/v3") {
    if (!headers.get("x-api-key")) return answer({ message: "headers must have required property 'x-api-key'" }, 400);
    const dep = url.searchParams.get("depositAddress");
    const one = url.searchParams.get("id");
    if (dep || one) {
      if (lookupsDown) return answer({ message: "busy" }, 503);
      return answer({ requests: (dep ? byDeposit[dep] : byId[one!]) ?? [] });
    }
    // The documented rule: a referrer filter with no apiKeyId sees public keyless requests only.
    if (url.searchParams.get("apiKeyId") !== KEY_ID) return answer({ requests: [] });
    return answer(page(keyed, url, "v3-"));
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

function reset() {
  resetMemoryKv();
  calls = [];
  mostAtOnce = 0;
  refuse = () => null;
  keyed = [];
  byDeposit = {};
  byId = {};
  v2Down = false;
  lookupsDown = false;
  delete process.env.RELAY_API_KEY_ID;
}

/** One refresh, with the calls it made on their own. */
async function refresh() {
  calls = [];
  const v = await readRelayVolume(KEY);
  assert.ok(calls.length <= READS_PER_REFRESH, `a refresh stays within the budget, made ${calls.length}`);
  return v;
}

const isHistory = (c: Call) => c.url.searchParams.has("referrer");
const isLookup = (c: Call) => !isHistory(c);

// ---- Off with no key.
delete process.env.RELAY_API_KEY;
const off = await fetchRelayVolume();
assert.equal(off.enabled, false, "no key, no panel");
assert.equal(calls.length, 0);

// ---- The bug: this is the request the panel made, against Relay's rule.
reset();
keyed = [v3Bridge(1)];
{
  const res = await fetch("https://api.relay.link/requests/v3?referrer=gloam.trade&limit=50", { headers: { "x-api-key": KEY } });
  const json = (await res.json()) as { requests: unknown[] };
  assert.equal(res.status, 200, "no error for the panel to show");
  assert.equal(json.requests.length, 0, "the old read: tagged, keyed requests come back as nothing");
}

// ---- The lasting fix: v3 with the key's id, and the key never in a URL.
reset();
process.env.RELAY_API_KEY_ID = KEY_ID;
keyed = [v3Bridge(1), v3Swap(2)];
{
  const v = await readRelayVolume(KEY);
  const c = calls.find((x) => x.url.pathname === "/requests/v3")!;
  assert.equal(c.url.searchParams.get("referrer"), "gloam.trade");
  assert.equal(c.url.searchParams.get("apiKeyId"), KEY_ID);
  assert.equal(c.apiKey, KEY, "the key goes in the header");
  for (const x of calls) assert.ok(!x.url.toString().includes(KEY), "the key never goes in a URL");

  assert.equal(v.history, "v3");
  assert.equal(v.historyError, null);
  assert.equal(v.all.bridge.count, 1, "the bridge is counted");
  assert.equal(v.all.bridge.inUsd, 9997, "dollars from the route as it ran, not $0");
  assert.equal(v.all.bridge.outUsd, 9995);
  assert.equal(v.all.bridge.feeUsd, 2, "swap, gas and Relay's fee as run; the app fee is not Relay's");
  assert.equal(v.all.swap.count, 1, "same chain is a swap");
  assert.equal(v.all.swap.inUsd, 120);
  assert.equal(v.all.swap.feeUsd, 0, "a swap that beat its quote is no charge, not a negative one");

  const bridge = v.recent.find((r) => r.kind === "bridge")!;
  assert.deepEqual(
    [bridge.fromChainId, bridge.toChainId, bridge.inSymbol, bridge.inAmount, bridge.outSymbol, bridge.outAmount, bridge.tx],
    [137, 8453, "USDC.e", "10000.0", "USDC", "9995.0", "0xv3out"],
    "every field the panel shows is there on v3"
  );
  const swap = v.recent.find((r) => r.kind === "swap")!;
  assert.deepEqual([swap.outSymbol, swap.outAmount, swap.tx], ["USDG", "118.0", "0xswapin"], "a same-chain swap reads its origin side");
}

// ---- No key id yet: v2 still answers, with the same figures, and the page asks for the id.
reset();
keyed = [v2Row(3)];
{
  const v = await readRelayVolume(KEY);
  const c = calls.find((x) => x.url.pathname === "/requests/v2")!;
  assert.equal(c.url.searchParams.get("referrer"), "gloam.trade");
  assert.equal(c.apiKey, KEY);
  assert.equal(v.history, "v2");
  assert.equal(v.all.bridge.count, 1);
  assert.equal(v.all.bridge.inUsd, 501);
  assert.ok(Math.abs(v.all.bridge.feeUsd - 1) < 1e-9, "fees read on a row with no feesUsd; actual over quoted; app fee left out");
  assert.equal(v.recent[0]!.tx, "0xv2out");
}

// ---- A finished row outlives v2: read once, it survives the retirement with no key id.
reset();
keyed = [v2Row(4)];
await readRelayVolume(KEY);
v2Down = true;
{
  const v = await readRelayVolume(KEY);
  assert.equal(v.all.bridge.count, 1, "kept in Gloam's own record");
  assert.match(v.historyError ?? "", /retired/, "and the page says the history read failed");
}

// ---- A deposit filled under a new request id: the quoted id never reports it.
reset();
{
  const quoted = id(10);
  await noteRelayQuote(quoted, DEPOSIT_ADDRESS);
  const filled = { ...v3Bridge(11), depositAddress: { address: DEPOSIT_ADDRESS, type: "open", depositor: WALLET, depositTxHash: "0xdep" } };
  byDeposit[DEPOSIT_ADDRESS] = [filled];
  byId[quoted] = []; // Relay's docs: the quoted id is not returned after a regeneration
  const v = await readRelayVolume(KEY);
  const lookup = calls.find((c) => c.url.searchParams.has("depositAddress"))!;
  assert.equal(lookup.url.searchParams.get("depositAddress"), DEPOSIT_ADDRESS, "looked up by address, not by the quoted id");
  assert.ok(!calls.some((c) => c.url.searchParams.get("id") === quoted));
  assert.equal(v.all.bridge.count, 1, "counted with no tag and no key id");
  assert.equal((await dueRelayQuotes(10)).length, 0, "the quote closes, so the one-time address is gone");

  // The same request also turns up in Relay's history: once only.
  process.env.RELAY_API_KEY_ID = KEY_ID;
  keyed = [filled];
  const again = await readRelayVolume(KEY);
  assert.equal(again.all.bridge.count, 1, "merged by Relay's id, never counted twice");
}

// ---- A private order fills under the quoted id, and is looked up by it.
reset();
{
  await noteRelayQuote(id(12));
  byId[id(12)] = [v3Bridge(12)];
  const v = await readRelayVolume(KEY);
  assert.equal(v.all.bridge.count, 1);
  assert.ok(calls.some((c) => c.url.searchParams.get("id") === id(12)));
}

// ---- A quote nobody pays stays open, moves back in the queue, and goes when its window ends.
reset();
{
  const stale = Date.now() - OPEN_MS - 60_000;
  await noteRelayQuote(id(13), DEPOSIT_ADDRESS, stale);
  await noteRelayQuote(id(14), DEPOSIT_ADDRESS);
  const v = await readRelayVolume(KEY);
  assert.equal(v.all.bridge.count + v.pending, 0, "an unpaid quote is not a bridge");
  const left = await dueRelayQuotes(10);
  assert.deepEqual(left.map((q) => q.requestId), [id(14)], "only the expired one was dropped");

  // Relay not answering is not "nobody paid": an expired quote waits for a real answer.
  await noteRelayQuote(id(15), DEPOSIT_ADDRESS, stale);
  lookupsDown = true;
  await readRelayVolume(KEY);
  assert.equal((await dueRelayQuotes(10)).length, 2, "kept while Relay can't answer");
}

// ---- A flood of quotes is capped, oldest first; each round checks what the budget leaves.
reset();
{
  const base = Date.now();
  await Promise.all(Array.from({ length: 2_005 }, (_, i) => noteRelayQuote(`0x${i.toString(16).padStart(64, "0")}`, DEPOSIT_ADDRESS, base + i)));
  const [raw] = await kv([["ZRANGE", "gloam:relay:own:open:v1", 0, -1]]);
  assert.equal((raw as string[]).length, 2_000, "the open list has a hard cap");
  assert.ok(!(raw as string[]).some((m) => m.startsWith(`0x${"0".repeat(64)}|`)), "the oldest went first");
  const first = (await dueRelayQuotes(1))[0]!;
  await refresh();
  assert.equal(calls.filter(isLookup).length, READS_PER_REFRESH - 1, "history takes a page, a lookup gets the rest");
  assert.equal(mostAtOnce, 1, "one call at a time, however long the list");
  const next = await dueRelayQuotes(1);
  assert.notEqual(next[0]!.raw, first.raw, "the one just asked about goes to the back");
  assert.equal(next[0]!.at, first.at + 1, "and the next in line is up");
}

// ---- The budget, and the order: history, then what's left on open quotes, one call at a time.
reset();
process.env.RELAY_API_KEY_ID = KEY_ID;
keyed = bridges(100, 5);
{
  assert.equal(READS_PER_REFRESH, 2, "Relay's dashboard: 2 a minute on /requests/* for this key");
  for (const n of [40, 41, 42]) await noteRelayQuote(id(n));
  const v = await refresh();
  assert.equal(calls.length, 2, "the whole budget, and no more with three quotes open");
  assert.ok(isHistory(calls[0]!), "history goes first");
  assert.ok(isLookup(calls[1]!), "a lookup gets what's left");
  assert.equal(mostAtOnce, 1, "never two at once");
  assert.equal(calls[0]!.url.searchParams.get("sortBy"), "createdAt", "newest first is asked for, not assumed");
  assert.equal(calls[0]!.url.searchParams.get("sortDirection"), "desc");
  assert.equal(v.all.bridge.count, 5);
  assert.equal(v.truncated, false);
}

// ---- A 429 on a lookup: the quote stays open, the refresh is fine, and no more are tried.
reset();
process.env.RELAY_API_KEY_ID = KEY_ID;
keyed = bridges(110, 3);
{
  await noteRelayQuote(id(43), null, Date.now() - 3_000);
  await noteRelayQuote(id(44), null, Date.now() - 2_000);
  refuse = (url) => (url.searchParams.has("id") ? 429 : null);
  const v = await refresh();
  assert.equal(v.all.bridge.count, 3, "history still counts");
  assert.equal(v.historyError, null, "and nothing is shown as wrong with it");
  assert.equal(calls.filter(isLookup).length, 1);
  assert.deepEqual((await dueRelayQuotes(10)).map((q) => q.requestId), [id(44), id(43)], "open still, and the next quote is up");
}

// ---- A 429 on the newest page: nothing else is sent, and no quote loses its turn.
reset();
process.env.RELAY_API_KEY_ID = KEY_ID;
keyed = bridges(120, 3);
{
  await refresh();
  await noteRelayQuote(id(45));
  keyed = [...bridges(125, 1), ...keyed];
  refuse = () => 429;
  const before = await dueRelayQuotes(1);
  const v = await refresh();
  assert.equal(calls.length, 1, "the limit is spent, so a lookup would only be refused too");
  assert.match(v.historyError ?? "", /429/, "the page says the history read failed");
  assert.equal(v.all.bridge.count, 3, "what's on record still counts");
  assert.equal(v.truncated, false);
  assert.deepEqual(await dueRelayQuotes(1), before);
  refuse = () => null;
  const after = await refresh();
  assert.equal(after.all.bridge.count, 4, "the next refresh is whole again");
  assert.equal(after.historyError, null);
}

// ---- A history longer than a refresh reads: newest first every time, older pages over several refreshes.
reset();
process.env.RELAY_API_KEY_ID = KEY_ID;
keyed = bridges(1_000, 170, 5);
{
  await noteRelayQuote(id(46));
  const one = await refresh();
  assert.equal(one.all.bridge.count, 100, "two pages read");
  assert.equal(one.truncated, true, "the page says there's more");
  assert.equal(calls.filter(isLookup).length, 0, "history took the budget, and a budget of none asks about none");
  assert.equal((await dueRelayQuotes(10)).length, 1);

  // Something new turns up while the walk is on: it counts now, not at the end.
  keyed = [...bridges(2_000, 2), ...keyed];
  const two = await refresh();
  assert.equal(calls[0]!.url.searchParams.get("continuation"), null, "every refresh starts at the newest page");
  assert.equal(calls[1]!.url.searchParams.get("continuation"), "v3-100", "then picks up where the last one stopped");
  assert.equal(two.all.bridge.count, 150, "the 2 new ones are in, and the 2 rows they pushed across the page line count once, not twice");
  assert.equal(two.recent[0]!.ts, Math.floor(Date.parse((keyed[0] as { createdAt: string }).createdAt) / 1000), "newest first");
  assert.equal(two.truncated, true);

  const three = await refresh();
  assert.equal(three.all.bridge.count, 172, "every row, once");
  assert.equal(three.truncated, false, "the walk is done");
  assert.equal(calls.length, 2, "the last page, nothing left for a lookup yet");

  const four = await refresh();
  assert.equal(four.all.bridge.count, 172);
  assert.equal(calls.filter(isHistory).length, 1, "with the walk done, history is one page again");
  assert.equal(calls.filter(isLookup).length, 1, "and open quotes get their turn back");
  assert.equal(((await readRelayRows()) as Map<string, unknown>).size, 172, "each kept once");
}

// ---- A burst between refreshes bigger than a page: the walk runs just far enough to close the gap.
reset();
process.env.RELAY_API_KEY_ID = KEY_ID;
keyed = bridges(3_000, 200, 100);
{
  for (let i = 0; i < 4; i++) await refresh();
  assert.equal((await refresh()).truncated, false);
  keyed = [...bridges(4_000, 70), ...keyed];
  const v = await refresh();
  assert.equal(v.truncated, false, "one older page reaches what was already read");
  assert.equal(v.all.bridge.count, 270, "nothing left in the gap");
  await refresh();
  assert.equal(calls.filter(isHistory).length, 1, "and no walk after it");

  // A burst while a walk is under way: the walk finishes, then a second one closes the new gap.
  reset();
  process.env.RELAY_API_KEY_ID = KEY_ID;
  keyed = bridges(5_000, 200, 300);
  await refresh();
  keyed = [...bridges(6_000, 120, 100), ...keyed];
  for (let i = 0; i < 6; i++) await refresh();
  const closed = await refresh();
  assert.equal(closed.all.bridge.count, 320, "every row of both, once");
  assert.equal(closed.truncated, false);
}

// ---- A 429 on page 2 keeps page 1, and the next refresh carries on from page 2.
reset();
process.env.RELAY_API_KEY_ID = KEY_ID;
keyed = bridges(7_000, 120);
{
  refuse = (url) => (url.searchParams.has("continuation") ? 429 : null);
  const v = await refresh();
  assert.equal(calls.length, 2);
  assert.equal(v.all.bridge.count, 50, "the rows already read are kept");
  assert.equal(v.truncated, true, "and the page says there's more");
  assert.equal(v.historyError, null, "the newest rows did arrive, so no error");
  assert.equal(((await readRelayRows()) as Map<string, unknown>).size, 50, "saved for good");

  refuse = () => null;
  const next = await refresh();
  assert.equal(calls[1]!.url.searchParams.get("continuation"), "v3-50", "the refused page is asked for again");
  assert.equal(next.all.bridge.count, 100);
  assert.equal(next.truncated, true);
  const last = await refresh();
  assert.equal(last.all.bridge.count, 120, "all of it, once");
  assert.equal(last.truncated, false);
}

// ---- A cursor Relay turns down doesn't block the walk: it starts over and nothing is lost.
reset();
process.env.RELAY_API_KEY_ID = KEY_ID;
keyed = bridges(8_000, 120);
{
  await refresh();
  refuse = (url) => (url.searchParams.get("continuation") === "v3-100" ? 400 : null);
  await noteRelayQuote(id(47));
  const v = await refresh();
  assert.equal(v.truncated, true, "the rest is still unread");
  assert.equal(v.historyError, null);
  refuse = () => null;
  await refresh();
  assert.equal(calls[1]!.url.searchParams.get("continuation"), "v3-50", "the dead cursor isn't asked for again");
  for (let i = 0; i < 2; i++) await refresh();
  const done = await refresh();
  assert.equal(done.all.bridge.count, 120);
  assert.equal(done.truncated, false);
  assert.equal(calls.filter(isLookup).length, 1, "and the lookups aren't starved");
}

// ---- The walk moves on only once the rows it read are safe: it won't read them again.
reset();
process.env.RELAY_API_KEY_ID = KEY_ID;
keyed = bridges(9_000, 120);
{
  await refresh();
  await kv([["SET", "gloam:relay:own:rows:v1", "not a hash"]]); // the next write of rows fails
  await refresh();
  assert.equal(calls[1]!.url.searchParams.get("continuation"), "v3-100");
  await kv([["DEL", "gloam:relay:own:rows:v1"]]);
  await refresh();
  assert.equal(calls[1]!.url.searchParams.get("continuation"), "v3-100", "the page that couldn't be saved is read again");
}

// ---- A v2 cursor is never handed to v3: the key id arriving mid-walk starts v3's own.
reset();
keyed = Array.from({ length: 120 }, (_, i) => ({ ...v2Row(1), id: `0x${(10_000 + i).toString(16).padStart(64, "0")}`, createdAt: new Date(Date.now() - i * 60_000).toISOString() }));
{
  assert.equal((await refresh()).history, "v2");
  assert.equal(calls[1]!.url.searchParams.get("continuation"), "v2-50");
  process.env.RELAY_API_KEY_ID = KEY_ID;
  const v = await refresh();
  assert.equal(v.history, "v3");
  assert.equal(calls[1]!.url.searchParams.get("continuation"), "v3-50");
}

// ---- Open quotes take turns: a stuck one can't hold the others back, whatever makes it stuck.
reset();
process.env.RELAY_API_KEY_ID = KEY_ID;
{
  const base = Date.now() - 60_000;
  const [stuck, unpaid, paid] = [id(50), id(51), id(52)];
  await noteRelayQuote(stuck, null, base);
  await noteRelayQuote(unpaid, null, base + 1);
  await noteRelayQuote(paid, null, base + 2);
  byId[paid] = [v3Bridge(52)];
  refuse = (url) => (url.searchParams.get("id") === stuck ? 503 : null);
  const asked: (string | null)[] = [];
  let last = await refresh();
  asked.push(calls.find(isLookup)!.url.searchParams.get("id"));
  for (let i = 0; i < 4; i++) {
    last = await refresh();
    asked.push(calls.find(isLookup)!.url.searchParams.get("id"));
  }
  assert.deepEqual(asked, [stuck, unpaid, paid, stuck, unpaid], "each in turn, and the one that always fails only gets its own");
  assert.equal(last.all.bridge.count, 1, "the paid quote behind the stuck one got counted");
  assert.deepEqual((await dueRelayQuotes(10)).map((q) => q.requestId).sort(), [stuck, unpaid].sort(), "the two left stay open");
}

// ---- Same with a 429 every time: a refused quote goes to the back too, so the queue still moves.
reset();
process.env.RELAY_API_KEY_ID = KEY_ID;
{
  const base = Date.now() - 60_000;
  await noteRelayQuote(id(53), null, base);
  await noteRelayQuote(id(54), null, base + 1);
  refuse = (url) => (url.searchParams.has("id") ? 429 : null);
  await refresh();
  const a = calls.find(isLookup)!.url.searchParams.get("id");
  await refresh();
  const b = calls.find(isLookup)!.url.searchParams.get("id");
  assert.deepEqual([a, b], [id(53), id(54)]);
}

// ---- An entry that can't be read would never be asked about and never move: it is cleared out.
reset();
process.env.RELAY_API_KEY_ID = KEY_ID;
{
  await kv([["ZADD", "gloam:relay:own:open:v1", 0, "not a quote"]]);
  await noteRelayQuote(id(55));
  byId[id(55)] = [v3Bridge(55)];
  await refresh();
  const v = await refresh();
  assert.equal(calls.find(isLookup)!.url.searchParams.get("id"), id(55), "the real quote behind it gets its turn");
  assert.equal(v.all.bridge.count, 1);
  const [raw] = await kv([["ZRANGE", "gloam:relay:own:open:v1", 0, -1]]);
  assert.deepEqual(raw, []);
}

// ---- Asking for no quotes means none, not the whole list (ZRANGE 0 -1).
reset();
{
  await noteRelayQuote(id(56));
  assert.deepEqual(await dueRelayQuotes(0), []);
}

// ---- A quote nobody paid, and one in flight.
reset();
process.env.RELAY_API_KEY_ID = KEY_ID;
keyed = [v3Bridge(20, "waiting"), v3Bridge(21, "depositing"), v3Bridge(22, "submitted"), v3Bridge(23, "refund"), v3Bridge(24, "failure")];
{
  const v = await readRelayVolume(KEY);
  assert.equal(v.all.bridge.count, 0, "nothing finished");
  assert.equal(v.pending, 2, "v3's new in-flight statuses are in flight; `waiting` is a quote nobody paid");
  assert.equal(v.refunded, 1);
  assert.equal(v.failed, 1);
  assert.ok(calls.some((c) => c.url.searchParams.get("includePendingRequests") === "true"), "v3 leaves these out unless asked");
  const kept = await readRelayRows<{ stage: string }>();
  assert.deepEqual([...kept.values()].map((r) => r.stage).sort(), ["failed", "refunded"], "only finished rows are kept");
}

// ---- Privacy: no wallet reaches the panel or the store, and no request id reaches the page.
reset();
process.env.RELAY_API_KEY_ID = KEY_ID;
keyed = [v3Bridge(30), v3Swap(31)];
await noteRelayQuote(id(32), DEPOSIT_ADDRESS);
byDeposit[DEPOSIT_ADDRESS] = [{ ...v3Bridge(32), depositAddress: { address: DEPOSIT_ADDRESS, type: "open", depositor: WALLET, depositTxHash: "0xdep" } }];
{
  const v = await readRelayVolume(KEY);
  const page = JSON.stringify(v).toLowerCase();
  const kept = JSON.stringify([...(await readRelayRows()).values()]).toLowerCase();
  for (const secret of [WALLET, RECIPIENT, DEPOSIT_ADDRESS]) {
    assert.ok(!page.includes(secret.toLowerCase()), "no wallet on the page");
    assert.ok(!kept.includes(secret.toLowerCase()), "no wallet in the store");
  }
  assert.ok(!page.includes(id(30)), "no request id on the page");
  assert.ok(!page.includes(KEY.toLowerCase()), "no key on the page");
  const [open] = await kv([["ZRANGE", "gloam:relay:own:open:v1", 0, -1]]);
  assert.deepEqual(open, [], "the address left with the closed quote");
}

// ---- The figures themselves.
{
  const now = Date.now();
  const row = (over: Partial<Parameters<typeof summarizeRelayRows>[0][number]>) => ({
    kind: "bridge" as const,
    stage: "done" as const,
    fromChainId: 1,
    toChainId: 4663,
    inSymbol: "ETH",
    inAmount: "1",
    inUsd: 10,
    outSymbol: "USDG",
    outAmount: "9",
    outUsd: 9,
    feeUsd: 1,
    tx: null,
    ts: Math.floor(now / 1000),
    ...over,
  });
  const s = summarizeRelayRows([row({}), row({ ts: Math.floor(now / 1000) - 40 * 86_400 }), row({ stage: "pending", inUsd: 99 })], now);
  assert.equal(s.all.bridge.count, 2);
  assert.equal(s.last30.bridge.count, 1, "the 30-day figure leaves out what's older");
  assert.equal(s.pending, 1);
  assert.equal(s.all.bridge.inUsd, 20, "in-flight money isn't finished volume");
}

console.log("selftest-relay-volume: all checks passed");
process.exit(0);
