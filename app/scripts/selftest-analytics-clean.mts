/**
 * Self-test: what the analytics intake keeps of a path or referrer
 * (lib/analyticsClean, used by /api/collect).
 *
 * A caller can post any path. Query strings and fragments (where claim codes
 * and proofs live) are cut, full URLs are reduced to their path, and segments
 * that look like a code, an address, a hash or a long id are replaced.
 * Ordinary routes and readable slugs pass through unchanged.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-analytics-clean.mts
 */
import assert from "node:assert/strict";
import { analyticsUrl, cleanPath, cleanRef, withoutLookup } from "../src/lib/analyticsClean";

let n = 0;
const eq = (a: unknown, b: unknown, msg?: string) => {
  assert.equal(a, b, msg);
  n++;
};

// a wallet looked up on the X-ray never reaches analytics, as an address or as a name
eq(withoutLookup("/xray/0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8"), "/xray/:redacted");
eq(withoutLookup("/xray/vitalik.eth"), "/xray/:redacted");
eq(withoutLookup("https://www.gloam.trade/xray/vitalik.eth"), "https://www.gloam.trade/xray/:redacted");
eq(withoutLookup("https://www.gloam.trade/xray/vitalik.eth/"), "https://www.gloam.trade/xray/:redacted");
eq(withoutLookup("/xray"), "/xray", "the empty page is a page");
eq(withoutLookup("/docs/xray"), "/docs/xray");
eq(cleanPath("/xray"), "/xray");
eq(cleanPath("/xray/vitalik.eth"), "/xray/:redacted", "a name reads like a slug, so the intake goes by the route");
eq(cleanPath("/xray/0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8"), "/xray/:redacted");
eq(cleanRef("https://www.gloam.trade/xray/vitalik.eth"), "https://www.gloam.trade/xray/:redacted");

// ordinary routes are kept as they are
eq(cleanPath("/"), "/");
eq(cleanPath("/app/vault"), "/app/vault");
eq(cleanPath("/claim"), "/claim");
eq(cleanPath("/docs/privacy-model"), "/docs/privacy-model");
eq(cleanPath("/blog/why-public-blockchains-got-payments-wrong-for-everyone"), "/blog/why-public-blockchains-got-payments-wrong-for-everyone", "long slugs stay");

// queries and fragments never reach the store
eq(cleanPath("/claim?net=robinhood-mainnet#claim=gloam1=eyJ2IjoxLCJ0IjoiZ2xvYW0"), "/claim");
eq(cleanPath("/verify?proof=gloambal1.eyJhbGciOiJ"), "/verify");
eq(cleanPath("/app/vault#claim=gloam1.eyJ2"), "/app/vault");

// codes, addresses, hashes and ids inside the path are replaced
eq(cleanPath("/claim/gloam1=eyJ2IjoxLCJ0IjoiZ2xvYW0tcHJpdmF0ZS1ub3RlIiwicyI6InBvc2VpZG9uIn0"), "/claim/:redacted");
eq(cleanPath("/pay/gloamr1.abcdef"), "/pay/:redacted");
eq(cleanPath("/address/0x5B8810b2e9e452aB44271a20C960671c48c09Cff"), "/address/:redacted");
eq(cleanPath("/tx/0xc0a61dfa834adbc1467f8af02b3195c7d88fe0ec60233957fb8edcf90d9788d2"), "/tx/:redacted");
eq(cleanPath("/r/3f1a9b77c2d84e0f9a1b2c3d4e5f6a7b"), "/r/:redacted");
eq(cleanPath("/k/AbC123xYz789QwErTy456UiOp0LkJhGf"), "/k/:redacted", "mixed-case blobs are ids, not slugs");
eq(cleanPath("/order/12345678"), "/order/:redacted");
eq(cleanPath("/x/gloam1%2EeyJ2IjoxLCJ0"), "/x/:redacted", "percent-encoded codes are caught too");
eq(cleanPath("/x/gloam3=2Muuo9o8HGWzGgY6sVn"), "/x/:redacted", "a short code is caught too");
eq(cleanPath("/c#2Muuo9o8HGWzGgY6sVnAweQDGXr2eLqVzrTBUdjXfzxFH2qsT2"), "/c", "a short claim link keeps only its page");

// a short link whose "#" a chat app wrote as "%23": the body is in the path, and is cut there like a fragment
const BODY = "2Muuo9o8HGWzGgY6sVnAweQDGXr2eLqVz";
eq(cleanPath(`/c%23${BODY}`), "/c");
eq(cleanPath(`/c%2523${BODY}`), "/c", "escaped twice");
eq(cleanPath(`/c%252523${BODY}`), "/c", "and again");
eq(cleanPath(`/r%23${BODY}`), "/r");
eq(cleanPath(`https://gloam.trade/c%23${BODY}`), "/c");
eq(cleanRef(`https://gloam.trade/c%23${BODY}`), "https://gloam.trade/c");
// what the browser sends to Vercel Analytics and the first-party intake (VercelAnalytics beforeSend, lib/track)
eq(analyticsUrl(`https://gloam.trade/c%23${BODY}`), "https://gloam.trade/c");
eq(analyticsUrl(`https://gloam.trade/c%2523${BODY}`), "https://gloam.trade/c");
eq(analyticsUrl(`https://www.gloam.trade/C%23${BODY}`), "https://www.gloam.trade/C");
eq(analyticsUrl(`/c%23${BODY}`), "/c");
eq(analyticsUrl(`https://www.gloam.trade/c#${BODY}`), "https://www.gloam.trade/c");
eq(analyticsUrl("https://www.gloam.trade/claim?net=robinhood-mainnet#claim=gloam1=eyJ2"), "https://www.gloam.trade/claim");
eq(analyticsUrl("https://www.gloam.trade/xray/vitalik.eth?x=1"), "https://www.gloam.trade/xray/:redacted");
eq(analyticsUrl("https://www.gloam.trade/app/vault"), "https://www.gloam.trade/app/vault");
eq(analyticsUrl("https://www.gloam.trade/docs/100%25-private"), "https://www.gloam.trade/docs/100%25-private", "a plain %25 is not a cut");

// full URLs keep only their path; anything else is refused
eq(cleanPath("https://www.gloam.trade/app/vault?tab=swap#x"), "/app/vault");
eq(cleanPath("javascript:alert(1)"), null);
eq(cleanPath("//evil.example/path"), null);
eq(cleanPath("no-leading-slash"), null);
eq(cleanPath(42), null);
eq(cleanPath(""), null);
eq(cleanPath("/%E0%A4%A"), null, "a broken escape is refused");

// odd characters are dropped and long paths are capped
eq(cleanPath("/app/<script>alert(1)</script>"), "/app/scriptalert1/script");
assert.ok(cleanPath("/" + "a/".repeat(50))!.split("/").length <= 9);
n++;
assert.ok(cleanPath("/" + "abc-".repeat(80))!.length <= 120);
n++;

// referrers: origin plus a cleaned path
eq(cleanRef("https://x.com/gloamtrade/status/2113178545514246260?s=20"), "https://x.com/gloamtrade/status/:redacted");
eq(cleanRef("https://www.gloam.trade/claim?net=robinhood-mainnet#claim=gloam1=eyJ2"), "https://www.gloam.trade/claim");
eq(cleanRef("https://t.me/gloamtrade"), "https://t.me/gloamtrade");
eq(cleanRef("data:text/html,hi"), null);
eq(cleanRef("not a url"), null);

// the intake takes only the events the app sends
{
  const { TRACK_EVENTS, isTrackEvent } = await import("../src/lib/trackEvents");
  const { POST } = await import("../src/app/api/collect/route");
  const post = (t: unknown) =>
    POST(new Request("http://localhost/api/collect", { method: "POST", headers: { "x-forwarded-for": "198.51.100.9" }, body: JSON.stringify({ t, path: "/" }) }));
  for (const t of ["junk_event", "total", "pageview_", "PAGEVIEW", "", 42, null, `shield_success${"x".repeat(40)}`]) {
    eq(isTrackEvent(t), false, String(t));
    eq((await post(t)).status, 400, `refused: ${String(t)}`);
  }
  const names: readonly string[] = TRACK_EVENTS;
  eq(names.every((t) => /^[a-z][a-z0-9_]{0,47}$/.test(t) && t !== "total" && isTrackEvent(t)), true, "every event the app sends is a plain name");
  eq(isTrackEvent("pageview") && isTrackEvent("shield_success") && isTrackEvent("bridge_private_sent"), true);
}

console.log(`analytics clean: ${n} passed`);
