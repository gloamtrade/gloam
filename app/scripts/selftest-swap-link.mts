/**
 * Self-test: swap links (lib/swapLink), the link a trading app sends people to
 * so they can trade privately with Gloam:
 *
 *   /app/vault?tab=swap#from=USDG&to=TSLA&amount=100&chain=robinhood-mainnet&ref=Motion
 *
 * This holds what a link fills in (only tokens the swap router lists on that
 * chain), what it refuses and why (unknown tokens, a network without swaps, odd
 * amounts, a sender's name that isn't a plain name), what the Swap tab shows
 * (the banner, the next step, the note on a network without swaps), that the
 * link is kept for a trip to Add, that it never swaps on its own, and the copy
 * rules for its docs and Glim's line.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-swap-link.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./browser-shim.mjs";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

const {
  SWAP_REF_MAX,
  buildSwapLink,
  findSwapToken,
  readSwapLink,
  readSwapRef,
  swapLinkFromHash,
  swapLinkNetwork,
  swapLinkParams,
  swapLinkStep,
  swapLinkSummary,
  swapLinkTokensFor,
  swapNetworks,
  swapsElsewhereNote,
  swapsOn,
} = await import("../src/lib/swapLink");
const { SWAP_LINK_KEEP_MS, dropSwapLink, keepSwapLink, keptSwapLink } = await import("../src/lib/swapLinkStore");
const { SwapLinkBanner, SwapsElsewhere } = await import("../src/components/app/SwapLinkBanner");
const { VAULT_SWAP_ASSETS, swapMainnets } = await import("../src/lib/vaultSwap");
const { NETWORK_KEYS, getNetwork, networkName } = await import("../src/lib/networks");
const { readPaymentRequest, requestParamsFrom } = await import("../src/lib/paymentRequest");
type NetworkKey = (typeof NETWORK_KEYS)[number];
type SwapLink = NonNullable<ReturnType<typeof readSwapLink>>;

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

const RH: NetworkKey = "robinhood-mainnet";
const TEMPO: NetworkKey = "tempo-mainnet";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d";
const GLOAM = "0xDcD885F5c60b3aD49F6D58718696417314e8724d";
const RH_WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDCE = "0x20c000000000000000000000b9537d11c60e8b50";

const read = (fields: Record<string, string>, fallback: NetworkKey = RH) => {
  const l = readSwapLink(new URLSearchParams(fields), fallback);
  assert.ok(l, `reads as a swap link: ${JSON.stringify(fields)}`);
  return l;
};
const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

/** The banner's visible text. */
function bannerText(link: SwapLink, current: NetworkKey, step: Parameters<typeof SwapLinkBanner>[0]["step"] = null, notOpen: string[] = []) {
  const html = renderToString(
    h(SwapLinkBanner, { link, currentNetwork: current, onSwitchNetwork: () => {}, onDismiss: () => {}, step, notOpen })
  );
  return { html, text: html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim() };
}

// ---------------------------------------------------------------- good links

test("the networks with swaps are the ones with a live router and a token list", () => {
  assert.ok(swapsOn(RH) && swapsOn(TEMPO), "Robinhood Chain and Tempo mainnet have private swaps");
  for (const k of NETWORK_KEYS) {
    const chainId = getNetwork(k).chainId;
    assert.equal(swapsOn(k), Boolean(VAULT_SWAP_ASSETS[chainId]?.length), k);
    if (getNetwork(k).testnet) assert.equal(swapsOn(k), false, `${k}: the testnets have no swap router`);
  }
  assert.deepEqual(swapNetworks(), NETWORK_KEYS.filter(swapsOn));
});

test("every token the router lists has a symbol and decimals, and nothing else is offered", () => {
  for (const k of swapNetworks()) {
    const listed = VAULT_SWAP_ASSETS[getNetwork(k).chainId] ?? [];
    const tokens = swapLinkTokensFor(k);
    assert.equal(tokens.length, listed.length, `${k}: one token per listed asset`);
    tokens.forEach((t, i) => {
      assert.ok(same(t.address, listed[i]!), `${k}: ${t.symbol} in the router's order`);
      assert.ok(t.symbol && t.decimals > 0 && t.id, `${k}: ${t.address} has metadata`);
    });
  }
  for (const k of NETWORK_KEYS.filter((k) => !swapsOn(k))) assert.deepEqual(swapLinkTokensFor(k), [], k);
});

test("Motion's link: buy TSLA with 100 USDG on Robinhood Chain", () => {
  const l = read({ from: "USDG", to: "TSLA", amount: "100", chain: RH, ref: "Motion" }, TEMPO);
  assert.equal(l.network, RH);
  assert.equal(l.on, RH, "looked up on the network the link names, not the one shown");
  assert.ok(same(l.from?.address, USDG) && l.from?.symbol === "USDG" && l.from.decimals === 6);
  assert.ok(same(l.to?.address, TSLA) && l.to?.symbol === "TSLA");
  assert.equal(l.amount, "100");
  assert.equal(l.ref, "Motion");
  assert.deepEqual(l.problems, []);
  assert.equal(swapLinkSummary(l), "Swap 100 USDG for TSLA");
});

test("tokens by address in any case, by symbol in any case, and $GLOAM", () => {
  const byAddr = read({ from: USDG.toLowerCase(), to: TSLA.toUpperCase().replace("0X", "0x"), chain: RH });
  assert.ok(same(byAddr.from?.address, USDG) && same(byAddr.to?.address, TSLA));
  assert.deepEqual(byAddr.problems, []);
  const bySym = read({ from: "usdg", to: "$gloam", chain: RH });
  assert.equal(bySym.from?.symbol, "USDG");
  assert.ok(same(bySym.to?.address, GLOAM));
  assert.equal(read({ from: " USDe ", to: "cbbtc", chain: RH }).to?.symbol, "cbBTC");
});

test("ETH is WETH where the router holds ETH as WETH, and native ETH where it swaps native notes", () => {
  const listed = VAULT_SWAP_ASSETS[4663] ?? [];
  const native = listed.some((a) => same(a, "0x0000000000000000000000000000000000000000"));
  const eth = findSwapToken(RH, "ETH");
  assert.ok(eth, "ETH is swappable on Robinhood Chain");
  if (native) assert.equal(eth.address, "0x0000000000000000000000000000000000000000");
  else assert.ok(same(eth.address, RH_WETH), "the vault holds it as WETH");
  assert.equal(findSwapToken(TEMPO, "ETH"), null, "Tempo swaps stablecoins only");
});

test("Tempo's stablecoins, and no chain falls back to the network shown", () => {
  const l = read({ from: "pathUSD", to: "USDC.e", amount: "25.50" }, TEMPO);
  assert.equal(l.network, null);
  assert.equal(l.on, TEMPO);
  assert.ok(same(l.to?.address, USDCE));
  assert.equal(l.amount, "25.5");
  assert.deepEqual(l.problems, []);
});

test("amounts are whole tokens of `from`, normalized", () => {
  assert.equal(read({ from: "USDG", to: "TSLA", amount: "1,000.50", chain: RH }).amount, "1000.5");
  assert.equal(read({ from: "USDG", to: "TSLA", amount: " 007 ", chain: RH }).amount, "7");
  assert.equal(read({ from: "USDG", to: "TSLA", amount: ".5", chain: RH }).amount, "0.5");
  assert.equal(read({ from: "USDG", to: "TSLA", amount: "0.000001", chain: RH }).amount, "0.000001", "USDG has 6 decimals");
  assert.equal(read({ from: "GLOAM", to: "USDG", amount: "0.000000000000000001", chain: RH }).amount, "0.000000000000000001");
  const none = read({ from: "USDG", to: "TSLA", chain: RH });
  assert.equal(none.amount, null, "no amount: the person types one");
  assert.deepEqual(none.problems, []);
  assert.equal(swapLinkSummary(none), "Swap USDG for TSLA");
});

test("a link built with buildSwapLink reads back the same, from the fragment", () => {
  const url = buildSwapLink({ from: "USDG", to: "TSLA", amount: "100", network: RH, ref: "Motion" });
  assert.equal(url, "https://gloam.trade/app/vault?tab=swap#from=USDG&to=TSLA&amount=100&chain=robinhood-mainnet&ref=Motion");
  const u = new URL(url);
  assert.equal(u.searchParams.get("tab"), "swap");
  assert.equal(u.searchParams.get("from"), null, "nothing about the swap in the query, which servers see");
  const l = swapLinkFromHash(u.hash, TEMPO);
  assert.ok(l && l.on === RH && l.from?.symbol === "USDG" && l.to?.symbol === "TSLA" && l.amount === "100" && l.ref === "Motion");
  assert.equal(
    buildSwapLink({ from: "USDG", to: "TSLA", network: RH, ref: "<b>x</b>" }, "http://localhost:4123/"),
    "http://localhost:4123/app/vault?tab=swap#from=USDG&to=TSLA&chain=robinhood-mainnet",
    "a name that isn't plain is left out of a built link too"
  );
});

test("only the fragment is read, and a claim link's fragment is not a swap link", () => {
  assert.equal(swapLinkFromHash("", RH), null);
  assert.equal(swapLinkFromHash("#", RH), null);
  assert.equal(swapLinkFromHash("#claim=gloam1=abc", RH), null);
  assert.equal(swapLinkFromHash("#chain=robinhood-mainnet&ref=Motion", RH), null, "no from, to or amount: nothing to fill in");
  assert.equal(swapLinkParams("#claim=gloam1=abc").toString(), "");
  assert.ok(swapLinkFromHash("from=USDG&to=TSLA&chain=robinhood-mainnet", TEMPO)?.from, "with or without the #");
});

test("a swap link's fields never read as a payment request, and a request's never as a swap", () => {
  // the Vault keeps the query when it switches tabs, and Pay reads the query: so the swap link stays in the fragment
  const swapUrl = new URL(buildSwapLink({ from: "USDG", to: "TSLA", amount: "100", network: RH }));
  assert.equal(readPaymentRequest(requestParamsFrom(swapUrl.search, ""), RH), null, "switching to Pay drops the fragment and carries nothing");
  const requestHash = "#to=gloamr1.abc&amount=5&asset=USDG&chain=robinhood-mainnet";
  const asSwap = swapLinkFromHash(requestHash, RH);
  // a request link names tab=move, so the Swap tab never reads it; if it did, `to` is checked as a token and refused
  assert.ok(asSwap);
  assert.equal(asSwap.to, null);
  assert.equal(asSwap.amount, null, "an amount with no token to pay with is left blank");
});

// ---------------------------------------------------------------- unknown tokens

test("a token the router doesn't list is refused with a plain line, and the rest still fills in", () => {
  const l = read({ from: "USDG", to: "PEPE", amount: "100", chain: RH });
  assert.ok(l.from && l.amount === "100");
  assert.equal(l.to, null);
  assert.deepEqual(l.problems, ["The token to get is not one Gloam can swap on Robinhood Chain, so it was left out."]);
  assert.equal(swapLinkSummary(l), "Swap 100 USDG");
});

test("a real token Gloam lists but the router doesn't swap is refused (GRIFT, Add only)", () => {
  const l = read({ from: "USDG", to: "GRIFT", chain: RH });
  assert.equal(l.to, null);
  assert.equal(l.problems.length, 1);
  const byAddr = read({ from: "USDG", to: "0x9f4BA41F91a59A34e17eE8C9EB3A51363B11aBD5", chain: RH });
  assert.equal(byAddr.to, null);
});

test("another chain's token is refused: USDC.e is Tempo's, USDG is Robinhood Chain's", () => {
  assert.equal(read({ from: "USDC.e", to: "TSLA", chain: RH }).from, null);
  assert.equal(read({ from: USDCE, to: "TSLA", chain: RH }).from, null);
  const t = read({ from: "USDG", to: "pathUSD", amount: "5", chain: TEMPO });
  assert.equal(t.from, null);
  assert.equal(t.amount, null, "no amount without its token");
  assert.deepEqual(t.problems, ["The token to pay with is not one Gloam can swap on Tempo, so it was left out."]);
});

test("an unknown token to pay with also leaves the amount blank, with one reason", () => {
  const l = read({ from: "NOTATOKEN", to: "TSLA", amount: "100", chain: RH });
  assert.equal(l.from, null);
  assert.equal(l.amount, null);
  assert.equal(l.problems.length, 1, "the token's reason covers the amount");
  assert.equal(swapLinkSummary(l), "Get TSLA");
});

test("a token for itself keeps the token to pay with and drops the other", () => {
  const l = read({ from: "USDG", to: USDG.toLowerCase(), amount: "5", chain: RH });
  assert.ok(l.from && !l.to && l.amount === "5");
  assert.deepEqual(l.problems, ["This link swaps a token for itself, so the token to get was left out."]);
});

test("the zero address is only native ETH where the router swaps native notes", () => {
  const native = (VAULT_SWAP_ASSETS[4663] ?? []).some((a) => same(a, "0x0000000000000000000000000000000000000000"));
  const l = read({ from: "USDG", to: "0x0000000000000000000000000000000000000000", chain: RH });
  assert.equal(Boolean(l.to), native);
});

// ---------------------------------------------------------------- wrong chain

test("a network without private swaps fills in nothing, and says so", () => {
  for (const k of NETWORK_KEYS.filter((k) => !swapsOn(k))) {
    const l = read({ from: "USDG", to: "TSLA", amount: "100", chain: k });
    assert.equal(l.network, k);
    assert.equal(l.on, null, `${k}: a token is never guessed on another chain`);
    assert.ok(!l.from && !l.to && !l.amount);
    assert.deepEqual(l.problems, [`Private swaps are not open on ${networkName(getNetwork(k))}, so nothing was filled in.`]);
  }
  const testnet = read({ from: "USDG", to: "TSLA", chain: "robinhood" });
  assert.match(testnet.problems[0]!, /Robinhood Chain testnet/);
});

test("a network Gloam does not run on fills in nothing", () => {
  for (const chain of ["solana", "Robinhood-Mainnet", "robinhood-mainnet ", "4663", "polygon", "__proto__", "constructor"]) {
    const l = read({ from: "USDG", to: "TSLA", amount: "1", chain }, RH);
    assert.equal(l.network, null, chain);
    assert.equal(l.on, null, `${chain}: not the network shown either`);
    assert.ok(!l.from && !l.to && !l.amount, chain);
    assert.deepEqual(l.problems, ["This link names a network Gloam does not run on, so nothing was filled in."]);
  }
});

test("no network, opened on one without swaps: nothing filled in, and where swaps run", () => {
  const l = read({ from: "USDG", to: "TSLA" }, "base-mainnet");
  assert.equal(l.on, null);
  assert.deepEqual(l.problems, [`This link names no network, and private swaps run on ${swapMainnets()}. Switch to one of them.`]);
});

test("the Vault moves to the link's network only when it has swaps", () => {
  assert.equal(swapLinkNetwork("#from=USDG&to=TSLA&chain=robinhood-mainnet"), RH);
  assert.equal(swapLinkNetwork("#from=pathUSD&chain=tempo-mainnet"), TEMPO);
  assert.equal(swapLinkNetwork("#from=USDG&to=TSLA&chain=base-mainnet"), swapsOn("base-mainnet") ? "base-mainnet" : null);
  assert.equal(swapLinkNetwork("#from=USDG&to=TSLA&chain=robinhood"), null, "a testnet has no swaps");
  assert.equal(swapLinkNetwork("#from=USDG&to=TSLA&chain=solana"), null);
  assert.equal(swapLinkNetwork("#from=USDG&to=TSLA"), null, "no network named: stay");
  assert.equal(swapLinkNetwork("#chain=robinhood-mainnet"), null, "not a swap link");
  assert.equal(swapLinkNetwork("#claim=gloam1=abc"), null);
});

test("Swap asked for on a network without it: where swaps run, with a switch to each", () => {
  assert.equal(swapsElsewhereNote(RH, ""), null);
  assert.equal(swapsElsewhereNote(RH, "#from=USDG&chain=base-mainnet"), null, "this network has swaps: the Swap tab says the rest");
  const off = NETWORK_KEYS.find((k) => !swapsOn(k))!;
  assert.equal(swapsElsewhereNote(off, ""), `Private swaps run on ${swapMainnets()}. Switch to one of them to swap.`);
  assert.equal(
    swapsElsewhereNote(off, "#from=USDG&chain=solana"),
    "This swap link names a network Gloam does not run on. Check it with whoever sent it."
  );
  assert.equal(
    swapsElsewhereNote(off, `#from=USDG&chain=${off}`),
    `This swap link is for ${networkName(getNetwork(off))}, where private swaps are not open. They run on ${swapMainnets()}.`
  );
  const html = renderToString(h(SwapsElsewhere, { note: "x", onSwitch: () => {} })).replace(/<!-- -->/g, "");
  for (const k of swapNetworks()) assert.ok(html.includes(`Switch to ${networkName(getNetwork(k))}`), k);
});

// ---------------------------------------------------------------- odd amounts

test("odd amounts are left blank with one plain reason, and the tokens still fill in", () => {
  const odd = [
    "0", "0.0", "-1", "-0", "1e5", "1E5", "1,25", "1.2.3", "Infinity", "NaN", "0x10", "1_000", "١٠٠",
    "100 USDG", "$100", "1,0000", "12345678901234567", "0.0000001", "+5", "5%", "1/2", "   ",
  ];
  for (const amount of odd) {
    const l = read({ from: "USDG", to: "TSLA", amount, chain: RH });
    assert.ok(l.from && l.to, `${JSON.stringify(amount)}: the tokens still fill in`);
    assert.equal(l.amount, null, `${JSON.stringify(amount)} is left blank`);
    if (amount.trim()) {
      assert.deepEqual(l.problems, ["The amount in this link is not a valid number, so it was left blank."], JSON.stringify(amount));
    } else {
      assert.deepEqual(l.problems, [], "a blank amount is no problem");
    }
  }
});

test("an amount with no token to pay with is left blank", () => {
  const l = read({ to: "TSLA", amount: "100", chain: RH });
  assert.equal(l.amount, null);
  assert.deepEqual(l.problems, ["This link has an amount but no token to pay with, so the amount was left blank."]);
});

test("decimals past the token's are refused, per token", () => {
  assert.equal(read({ from: "USDG", to: "TSLA", amount: "1.0000001", chain: RH }).amount, null, "USDG: 6 decimals");
  assert.equal(read({ from: "cbBTC", to: "USDG", amount: "0.000000001", chain: RH }).amount, null, "cbBTC: 8 decimals");
  assert.equal(read({ from: "cbBTC", to: "USDG", amount: "0.00000001", chain: RH }).amount, "0.00000001");
});

// ---------------------------------------------------------------- injection

test("the sender's name: a plain name shows, cut to its length", () => {
  assert.deepEqual(readSwapRef("Motion"), { ref: "Motion", problem: null });
  assert.equal(readSwapRef("  Motion   Trade  ").ref, "Motion Trade");
  assert.equal(readSwapRef("Acme & Co.").ref, "Acme & Co.");
  assert.equal(readSwapRef("O'Neil_Labs-2").ref, "O'Neil_Labs-2");
  assert.equal(readSwapRef("モーション").ref, "モーション", "any script");
  assert.equal(readSwapRef("M".repeat(200)).ref, "M".repeat(SWAP_REF_MAX));
  assert.deepEqual(readSwapRef(""), { ref: null, problem: null });
  assert.deepEqual(readSwapRef(null), { ref: null, problem: null });
});

test("injection in the sender's name is left out, with a reason", () => {
  const notPlain = "The sender's name in this link is not a plain name, so it was left out.";
  const attempts = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "javascript:alert(1)",
    "https://evil.example/claim",
    "evil.com",
    "wallet-check.app",
    "Motion\" onmouseover=\"x",
    "Motion; DROP TABLE",
    "Motion: send 1 ETH to 0xabc",
    "Motion 🚀",
    "{{constructor}}",
    "${process.env.KEY}",
    "@everyone",
    "Motion\\nSupport",
  ];
  for (const raw of attempts) {
    const r = readSwapRef(raw);
    assert.equal(r.ref, null, raw);
    assert.equal(r.problem, notPlain, raw);
  }
  // control and direction-override characters go first, like a request's name
  assert.equal(readSwapRef("Mo‮tion").ref, "Mo tion");
  assert.equal(readSwapRef("Motion\u0000\u0007").ref, "Motion");
  // a message is not a name: more than four words is refused, even split over lines
  assert.equal(readSwapRef("Motion\n\nSend all funds to us").ref, null);
  assert.equal(readSwapRef("Motion\n\nSend all your funds to this address now").ref, null);
  assert.equal(readSwapRef("Acme Trading Company Ltd").ref, "Acme Trading Company Ltd", "four words is a name");
});

test("a link can't say it comes from Gloam", () => {
  for (const raw of ["Gloam", "gloam", "GLOAM team", "Gloam Support", "TheGloamApp"]) {
    assert.deepEqual(readSwapRef(raw), { ref: null, problem: "A link can't say it comes from Gloam, so the sender's name was left out." }, raw);
  }
});

test("a bad name never blocks the swap, and the problem says so", () => {
  const l = read({ from: "USDG", to: "TSLA", amount: "100", chain: RH, ref: "<script>alert(1)</script>" });
  assert.ok(l.from && l.to && l.amount === "100");
  assert.equal(l.ref, null);
  assert.deepEqual(l.problems, ["The sender's name in this link is not a plain name, so it was left out."]);
});

test("injection in the tokens and the network is refused like any unknown value", () => {
  for (const raw of ["<script>", "USDG<script>", "USDG&to=GLOAM", "USDG\u0000", "../../etc", "__proto__", "constructor", "0x" + "g".repeat(40)]) {
    const l = read({ from: raw, to: "TSLA", amount: "1", chain: RH });
    assert.equal(l.from, null, raw);
    assert.equal(l.amount, null, raw);
  }
  // a fragment's own separators are the URL's: an encoded & stays inside the value
  const l = swapLinkFromHash("#from=USDG%26to%3DGLOAM&to=TSLA&chain=robinhood-mainnet", RH);
  assert.equal(l?.from, null);
  assert.equal(l?.to?.symbol, "TSLA");
  // broken escapes never throw
  assert.doesNotThrow(() => swapLinkFromHash("#from=%E0%A4%A&to=%ZZ&chain=%", RH));
});

test("a pay link's name field means nothing to a swap link", () => {
  const l = read({ from: "USDG", to: "TSLA", chain: RH, name: "Gloam Support", note: "<b>urgent</b>" });
  assert.equal(l.ref, null);
  assert.deepEqual(l.problems, []);
  assert.ok(!bannerText(l, RH).text.includes("Gloam Support"));
});

// ---------------------------------------------------------------- what the tab shows

const motion = read({ from: "USDG", to: "TSLA", amount: "100", chain: RH, ref: "Motion" });

test("the banner names the sender and the swap, and says nothing swaps on its own", () => {
  const { text } = bannerText(motion, RH);
  assert.ok(text.includes("Swap link"));
  assert.ok(text.includes("From Motion"));
  assert.ok(text.includes("Swap 100 USDG for TSLA"));
  assert.ok(text.includes("Nothing swaps until you check the price below and tap Swap privately."));
  assert.ok(text.includes("The name comes from the link too."));
  assert.ok(!text.includes("Switch to"), "on its own network: no switch");
  assert.ok(!/anonymous|untraceable|invisible|—/i.test(text));
});

test("with no sender's name, no From line", () => {
  const l = read({ from: "USDG", to: "TSLA", amount: "1250", chain: RH });
  const { text } = bannerText(l, RH);
  assert.ok(!text.includes("From "));
  assert.ok(text.includes("Swap 1,250 USDG for TSLA"));
  assert.ok(!text.includes("The name comes from the link"));
});

test("an injected name never reaches the page, and its reason does", () => {
  const l = read({ from: "USDG", to: "TSLA", chain: RH, ref: "<img src=x onerror=alert(1)>" });
  const { html, text } = bannerText(l, RH);
  assert.ok(!html.includes("<img"), "no markup from the link");
  assert.ok(!html.includes("onerror"));
  assert.ok(text.includes("not a plain name"));
});

test("opened on another network: the swap's network, with a switch", () => {
  const { text } = bannerText(motion, TEMPO);
  assert.ok(text.includes("This swap is for Robinhood Chain."));
  assert.ok(text.includes("Switch to Robinhood Chain"));
});

test("refused fields are listed; nothing filled in says so", () => {
  const l = read({ from: "PEPE", to: "DOGE", amount: "1", chain: RH });
  const { text } = bannerText(l, RH);
  assert.ok(text.includes("Nothing from this link could be filled in. You can still pick a swap yourself."));
  assert.ok(text.includes("The token to pay with is not one Gloam can swap on Robinhood Chain"));
  assert.ok(text.includes("The token to get is not one Gloam can swap on Robinhood Chain"));
  const wrong = read({ from: "USDG", to: "TSLA", chain: "robinhood" });
  assert.ok(bannerText(wrong, RH).text.includes("Private swaps are not open on Robinhood Chain testnet"));
  const closed = bannerText(motion, RH, null, ["TSLA is not open for private swaps yet, so it was left out."]).text;
  assert.ok(closed.includes("TSLA is not open for private swaps yet"));
});

const usdg = motion.from!;
const need = BigInt(100_000_000);
const base = { signedIn: true, network: RH, known: true, held: BigInt(0), need, addable: true, bridge: true };

test("signed out: sign in first, and the swap stays filled in", () => {
  const s = swapLinkStep(motion, { ...base, signedIn: false });
  assert.deepEqual(s, { kind: "signin", text: "Sign in with the wallet you use with Gloam to swap. This swap stays filled in." });
});

test("no private balance in the token to pay with: add it, or bring money over, and the swap stays ready", () => {
  const s = swapLinkStep(motion, base);
  assert.ok(s && s.kind === "add");
  assert.equal(
    s.text,
    "You have no private USDG on Robinhood Chain yet. Add USDG privately, or bring money over from another chain. This swap stays ready."
  );
  const { html, text } = bannerText(motion, RH, s);
  assert.ok(text.includes("Add USDG privately"));
  assert.ok(text.includes("Bring money over"));
  assert.ok(html.includes('href="/app/vault?tab=shield&amp;asset=usdg"'), "Add opens on USDG");
  assert.ok(html.includes('href="/app/vault?tab=shield"'));
});

test("less than the swap needs: say what there is, and add more", () => {
  const s = swapLinkStep(motion, { ...base, held: BigInt(40_000_000), heldLabel: "40 USDG" });
  assert.ok(s && s.kind === "add");
  assert.equal(s.text, "Your private USDG on Robinhood Chain is 40 USDG. Add USDG privately, or bring money over from another chain. This swap stays ready.");
});

test("enough, still reading, or on another network: no step", () => {
  assert.equal(swapLinkStep(motion, { ...base, held: need }), null);
  assert.equal(swapLinkStep(motion, { ...base, held: need * BigInt(2) }), null);
  assert.equal(swapLinkStep(motion, { ...base, known: false }), null, "no flash of 'no balance' while it loads");
  assert.equal(swapLinkStep(motion, { ...base, network: TEMPO }), null, "the banner offers the switch first");
  const anyAmount = read({ from: "USDG", to: "TSLA", chain: RH });
  assert.equal(swapLinkStep(anyAmount, { ...base, need: null, held: BigInt(1) }), null, "no amount: any balance will do");
  assert.equal(swapLinkStep(anyAmount, { ...base, need: null })?.kind, "add");
  const noFrom = read({ to: "TSLA", chain: RH });
  assert.equal(swapLinkStep(noFrom, base), null, "no token to pay with named: the tab's own hints apply");
  // on another network, the switch shows and the add step does not
  const s = swapLinkStep(motion, base)!;
  assert.ok(!bannerText(motion, TEMPO, s).text.includes("Add USDG privately"));
});

test("a token Add doesn't take: swap into it first; no bridge where it doesn't land", () => {
  const weth = read({ from: "WETH", to: "USDG", amount: "1", chain: RH });
  const s = swapLinkStep(weth, { ...base, need: BigInt(10) ** BigInt(18), addable: false, bridge: false });
  assert.ok(s && s.kind === "add");
  assert.equal(s.text, "You have no private WETH on Robinhood Chain yet. Swap into WETH from something you hold first. This swap stays ready.");
  const { text } = bannerText(weth, RH, s);
  assert.ok(!text.includes("Add WETH privately") && !text.includes("Bring money over"));
  const gloam = read({ from: "GLOAM", to: "USDG", chain: RH });
  const g = swapLinkStep(gloam, { ...base, need: null, bridge: false });
  assert.equal(g?.text, "You have no private GLOAM on Robinhood Chain yet. Add GLOAM privately first. This swap stays ready.");
  assert.ok(!bannerText(gloam, RH, g).text.includes("Bring money over"));
  void usdg;
});

// ---------------------------------------------------------------- kept for a trip to Add

test("an opened link is kept in this tab for half an hour, then dropped", () => {
  dropSwapLink();
  assert.equal(keptSwapLink(), null);
  keepSwapLink("from=USDG&to=TSLA&amount=100&chain=robinhood-mainnet&ref=Motion", RH, 1_000);
  assert.deepEqual(keptSwapLink(1_000 + SWAP_LINK_KEEP_MS - 1), {
    frag: "from=USDG&to=TSLA&amount=100&chain=robinhood-mainnet&ref=Motion",
    on: RH,
  });
  const back = swapLinkFromHash(keptSwapLink(2_000)!.frag, keptSwapLink(2_000)!.on);
  assert.ok(back && back.from?.symbol === "USDG" && back.amount === "100", "back from Add, the swap is ready");
  assert.equal(keptSwapLink(1_000 + SWAP_LINK_KEEP_MS), null, "too old");
  assert.equal(keptSwapLink(1_000), null, "and gone once too old");
  keepSwapLink("from=USDG", RH, 5_000);
  assert.equal(keptSwapLink(4_000), null, "a time in the future is not trusted");
  keepSwapLink("from=USDG", RH, 5_000);
  dropSwapLink();
  assert.equal(keptSwapLink(5_001), null, "closed or swapped: gone");
  window.sessionStorage.setItem("gloam.swapLink", "{not json");
  assert.equal(keptSwapLink(), null);
  window.sessionStorage.setItem("gloam.swapLink", JSON.stringify({ frag: "from=USDG", on: "nowhere", at: Date.now() }));
  assert.equal(keptSwapLink(), null, "an unknown network is dropped");
  dropSwapLink();
});

// ---------------------------------------------------------------- never on its own

test("the Swap tab only swaps from the button, and a link fills in, never sends", () => {
  const src = readFileSync(new URL("../src/components/app/VaultSwapView.tsx", import.meta.url), "utf8");
  const calls = [...src.matchAll(/onSwap\(\)/g)].length;
  assert.equal(calls, 2, "defined once, called once");
  assert.ok(/onClick=\{\(\) => void onSwap\(\)\}/.test(src), "the one call is the button's click");
  assert.equal([...src.matchAll(/runVaultSwap\(/g)].length, 1, "one place sends a swap: onSwap");
  // every stop the tab had stays, in the same order
  const stops = ["addfirst", "empty", "bad", "over", "note", "inclosed", "quoting", "noprice", "closed", "room", "relay", "gas", "floor", "market", "swap"];
  let at = 0;
  for (const key of stops) {
    const i = src.indexOf(`key: "${key}"`, at);
    assert.ok(i > at, `the "${key}" stop is still there, in order`);
    at = i;
  }
  for (const warn of ["IMPACT_WARN_BPS", "PEG_WARN_BPS", "VALUE_WARN_BPS", "VALUE_STOP_BPS", "quoteFresh", "QUOTE_TTL_MS"]) {
    assert.ok(src.includes(warn), `${warn} is still checked`);
  }
  // the link is read from the fragment, not the query
  assert.ok(!/searchParams\.get\("(from|to|amount|ref)"\)/.test(src));
});

// ---------------------------------------------------------------- docs and Glim

test("the docs show Motion's link, and say what a swap hides and what it doesn't", () => {
  const docs = readFileSync(new URL("../src/app/docs/partners/page.tsx", import.meta.url), "utf8");
  const start = docs.indexOf('id="swap-link"');
  assert.ok(start > 0, "a Trade privately with one link section");
  const section = docs.slice(start, docs.indexOf("<h2", start + 10));
  assert.ok(section.includes("Trade privately with one link"));
  assert.ok(section.includes("tab=swap#from=USDG&amp;to=") || section.includes("tab=swap#from=USDG&to="), "Motion's example: USDG on Robinhood Chain");
  assert.ok(section.includes("robinhood-mainnet"));
  // Motion's link carries its partner code; a name alone (ref) counts for nothing
  assert.ok(section.includes("&p=<Motion's link code>"));
  assert.ok(/ref<\/code>: optional[\s\S]*counts for nothing/.test(section));
  assert.ok(/hides who swapped, not the tokens or the amounts/.test(section.replace(/\s+/g, " ")));
  assert.ok(/[Oo]nly tokens the (swap )?router lists/.test(section.replace(/\s+/g, " ")));
  assert.ok(!/anonymous|untraceable|invisible|—/i.test(section), "copy rules");
  const swapsDocs = readFileSync(new URL("../src/app/docs/private-swaps/page.tsx", import.meta.url), "utf8");
  assert.ok(swapsDocs.includes("/docs/partners#swap-link"), "the swaps guide points to it");
});

test("Glim knows the swap link exists, in one line", () => {
  const k = readFileSync(new URL("../src/lib/telegramBot/knowledge.ts", import.meta.url), "utf8");
  const lines = k.split("\n").filter((l) => l.includes("tab=swap#"));
  assert.equal(lines.length, 1);
  assert.ok(!/anonymous|untraceable|invisible|—/i.test(lines[0]!));
  assert.ok(/not the tokens or the amounts/.test(lines[0]!));
});

console.log(`\nswap link: ${passed} passed`);
