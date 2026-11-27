/**
 * Self-test: payment requests on Starknet (lib/starknetPrivacy/requestLink,
 * components/app/StarknetRequests, the Vault's Pay and Receive on Starknet).
 *
 *  - the link: a body round-trips (with an amount or none, a note and a name),
 *    the account is one form, a bad account or an amount of zero is refused,
 *    the note and the name are cleaned and capped (never cut mid-character),
 *    the longest body still reads from the fragment, a cut, mistyped, newer or
 *    unknown link is refused, and the fragment is letters, digits and "=" only;
 *  - no other reader takes it, and it takes no other: Starknet claim links,
 *    Solana's claim links and requests, EVM claim links, short codes and
 *    requests, the funnel and the SDK's claim reader;
 *  - Pay: a request link opens Pay on Starknet and fills in the account and
 *    the amount; another network, a damaged or newer link, or a token Gloam
 *    doesn't list is said instead; the Vault moves to Starknet for it and never
 *    sends it back to an EVM network; the banner says the name comes from the
 *    link, the note is not sent, and what a first payment shows;
 *  - Receive has "Request a payment"; docs and Glim say requests work there.
 *
 * No network. Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-starknet-requests.mts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};
const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_STARKNET_ENABLED = "1";
env.NEXT_PUBLIC_STARKNET_NETWORK = "mainnet";
env.NEXT_PUBLIC_SOLANA_RINGS_ENABLED = "1";
env.NEXT_PUBLIC_SOLANA_RINGS_NETWORK = "mainnet";

const R = await import("../src/lib/starknetPrivacy/requestLink");
const SnClaim = await import("../src/lib/starknetPrivacy/claimLink");
const Sol = await import("../src/lib/solanaRings/claimLink");
const { ringsAssets } = await import("../src/lib/solanaRings/config");
const evm = await import("../src/lib/claimLink");
const { isClaimLink } = await import("../src/lib/funnel");
const { readPaymentRequest, requestParamsFrom } = await import("../src/lib/paymentRequest");
const { readAmountText } = await import("../src/lib/amountText");
const { vaultActionFromUrl } = await import("../src/lib/vaultHub");
const { STARKNET_VAULT_ACTIONS } = await import("../src/lib/starknetPrivacy/vaultActions");
const sdk = await import("@gloamtrade/sdk");
const { starknetFacts } = await import("../src/lib/telegramBot/knowledge");

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks++;
};
const eq = <T,>(a: T, b: T, msg: string) => {
  assert.deepEqual(a, b, msg);
  checks++;
};

const ONE = 1_000_000n;
const TO = "0x68b843b246348a56c37e5b4f485ae3cc0df3d6f6ab80f8d89406a70780ee656";
const base: import("../src/lib/starknetPrivacy/requestLink").StarknetRequest = { network: "mainnet", to: TO, token: 0, amount: 25n * ONE, note: "Invoice 042", name: "Ada" };
const SITE = "https://www.gloam.trade";

/** A body changed by `edit`, its check made again (over "snreq" and the body, as the link's is), so only the change is read. */
function resealed(b58: string, edit: (head: Uint8Array) => void): string {
  const raw = SnClaim.unbase58(b58)!;
  const head = raw.slice(0, raw.length - 4);
  edit(head);
  let x = 0x811c9dc5;
  for (const b of [...new TextEncoder().encode("snreq"), ...head]) {
    x ^= b;
    x = Math.imul(x, 0x01000193) >>> 0;
  }
  return SnClaim.base58(Uint8Array.from([...head, x & 255, (x >>> 8) & 255, (x >>> 16) & 255, x >>> 24]));
}

// ------------------------------------------------------------------ the link

const body = R.encodeStarknetRequest(base);
const url = R.starknetRequestLinkUrl(body, SITE);
const hash = `#snreq=${body}`;
{
  ok(/^[1-9A-HJ-NP-Za-km-z]+$/.test(body), "the body is base58");
  eq(R.decodeStarknetRequest(body), { ok: true, request: base }, "a request round trips");
  eq(url, `${SITE}/app/vault?tab=move&mode=pay#snreq=${body}`, "the link opens Pay, the body in the fragment");
  ok(!new URL(url).searchParams.has("net"), "with no ?net= (an EVM network's)");
  ok(/^#[A-Za-z0-9=]+$/.test(new URL(url).hash), "its fragment is letters, digits and = only");
  eq(R.starknetRequestBodyFromHash(hash), body, "read back from the fragment");
  eq(R.starknetRequestBodyFromHash(`${hash}&x=1`), null, "a fragment with more in it is not taken");
  eq(R.starknetRequestLinkUrl(body, `${SITE}/`), url, "an origin's trailing slash is dropped");

  const any = { ...base, amount: null, note: "", name: "" };
  eq(R.decodeStarknetRequest(R.encodeStarknetRequest(any)), { ok: true, request: any }, "no amount lets the payer choose");
  for (const network of ["mainnet", "sepolia", "devnet"] as const) {
    const r = R.decodeStarknetRequest(R.encodeStarknetRequest({ ...base, network }));
    ok(r.ok && r.request.network === network, `the network rides in it: ${network}`);
  }
  const padded = R.decodeStarknetRequest(R.encodeStarknetRequest({ ...base, to: "0x000000ABCdef" }));
  ok(padded.ok && padded.request.to === "0xabcdef", "the account reads back in one form (lower case, no leading zeros)");
  const big = R.decodeStarknetRequest(R.encodeStarknetRequest({ ...base, amount: (1n << 64n) - 1n }));
  ok(big.ok && big.request.amount === (1n << 64n) - 1n, "the largest amount a link holds reads back");
  for (const bad of ["not-an-address", "0x", "0x0", `0x${(1n << 251n).toString(16)}`, `0x${"1".repeat(65)}`, "gloamr1.abc"]) {
    assert.throws(() => R.encodeStarknetRequest({ ...base, to: bad }), /Starknet address/, bad);
    checks++;
  }
  assert.throws(() => R.encodeStarknetRequest({ ...base, amount: 0n }), /above zero/);
  assert.throws(() => R.encodeStarknetRequest({ ...base, amount: 1n << 64n }), /above zero/);
  checks += 2;

  const wide = R.decodeStarknetRequest(R.encodeStarknetRequest({ ...base, note: "🏠".repeat(80) }));
  ok(wide.ok && new TextEncoder().encode(wide.request.note).length <= 255 && /^(🏠)+$/u.test(wide.request.note), "a note of wide characters is cut to fit, never mid-character");
  const dirty = R.decodeStarknetRequest(R.encodeStarknetRequest({ ...base, note: "  Pay\u0000 me‮ now  " + "x".repeat(200), name: "N".repeat(80) }));
  ok(dirty.ok && !/[\u0000‮]/.test(dirty.request.note) && dirty.request.note.length === R.STARKNET_REQUEST_NOTE_MAX, "the note is cleaned and capped at 80");
  ok(dirty.ok && dirty.request.name.length === R.STARKNET_REQUEST_NAME_MAX, "the name is capped at 40");
  const lang = R.decodeStarknetRequest(R.encodeStarknetRequest({ ...base, note: "Rent, März 🏠", name: "Ọlá" }));
  ok(lang.ok && lang.request.note === "Rent, März 🏠" && lang.request.name === "Ọlá", "any language reads back");
  const longest = R.encodeStarknetRequest({ ...base, amount: (1n << 64n) - 1n, note: "🏠".repeat(80), name: "🏠".repeat(40) });
  eq(R.starknetRequestBodyFromHash(`#snreq=${longest}`), longest, `the longest request still reads from the fragment (${longest.length} letters)`);
  ok(longest.length <= 700, "and fits the fragment's bound");

  let cut = true;
  for (let i = 1; i < body.length; i++) if (R.decodeStarknetRequest(body.slice(0, i)).ok) cut = false;
  ok(cut, "a request cut at any length is refused");
  let typo = true;
  for (let i = 0; i < body.length; i++) {
    const c = body[i] === "2" ? "3" : "2";
    if (R.decodeStarknetRequest(body.slice(0, i) + c + body.slice(i + 1)).ok) typo = false;
  }
  ok(typo, "a request with any one letter changed is refused");
  eq(R.decodeStarknetRequest("0OIl"), { ok: false, why: "damaged" }, "letters base58 doesn't use are refused");

  // A whole link this app can't read: a newer version, an unknown network or flag.
  const reseal = (edit: (b: Uint8Array) => void) => resealed(body, edit);
  eq(R.decodeStarknetRequest(reseal((b) => (b[0] = 2))), { ok: false, why: "unknown" }, "a newer version reads as newer");
  eq(R.decodeStarknetRequest(reseal((b) => (b[0] = 0))), { ok: false, why: "damaged" }, "version 0 reads as damaged");
  eq(R.decodeStarknetRequest(reseal((b) => (b[1] = 9))), { ok: false, why: "unknown" }, "an unknown network reads as newer");
  eq(R.decodeStarknetRequest(reseal((b) => (b[3] = 3))), { ok: false, why: "unknown" }, "an unknown flag reads as newer");
}

// ------------------------------------------------------------------ no other reader takes it, it takes no other

const usdcSol = ringsAssets("mainnet").find((a) => a.id === "usdc")!;
const snClaimBody = SnClaim.claimBody({ network: "mainnet", token: 0, amount: 5n * ONE, secret: Uint8Array.from({ length: 16 }, (_, i) => i + 1) });
const solClaimBody = Sol.encodeClaim(Sol.newClaim("mainnet", usdcSol, 5n * ONE, (n) => Uint8Array.from({ length: n }, (_, i) => i + 7)));
const solReqBody = Sol.encodeRequest({ network: "mainnet", to: "9wPkC6bZ3mWtq8FxVhN2sRj4LdYa7GuE5oTcKpB1iHzX", asset: usdcSol, amount: 5n * ONE, note: "Invoice 7", name: "Ada" });
{
  // Starknet's claim reader
  eq(SnClaim.claimFromHash(hash), null, "the Starknet claim reader takes no request");
  eq(SnClaim.claimFromHash(`Pay me: ${url}`), null, "nor one pasted in a message");
  ok(!SnClaim.isStarknetClaimHash(hash), "a request is no Starknet claim link");
  eq(SnClaim.readClaimBody(body), null, "its body is no claim body");
  eq(sdk.starknetClaimFromLink(url), null, "the SDK's claim reader takes none of it");
  // Solana's readers
  eq([Sol.solanaLinkKind(hash), Sol.claimBodyFromHash(hash), Sol.claimBodyIn(url), Sol.requestBodyFromHash(hash)], [null, null, null, null], "no Solana reader takes it");
  ok(!Sol.decodeRequest(body).ok && !Sol.decodeClaim(body).ok, "its body is no Solana request or claim");
  // EVM readers
  eq(evm.codeFromHash(hash), null, "the EVM claim box reads no code from it");
  eq(evm.shortCodeFromHash(hash), null, "the EVM claim page reads no short code from it");
  ok(!isClaimLink(url) && !isClaimLink(`snreq=${body}`), "the funnel counts no EVM claim link in it");
  eq(readPaymentRequest(requestParamsFrom("?tab=move&mode=pay", hash), "robinhood-mainnet"), null, "the EVM request reader reads no request from it");

  // and the other way round
  const evmShort = "#3kY7pQ2mZr8xVb4NcT6wHj9LdFs5Ga1EoUi";
  const evmLong = "#claim=gloam1=eyJ2IjoxLCJwb29sIjoiMHgzOWUyOGNkZTU1Y2FiNzk4ODc0NzQ2YWM1MmNiNGI1Y2M5OWEwMTk0In0";
  const evmReq = "#to=gloamr1.AbC&amount=5&asset=USDG&chain=robinhood-mainnet";
  const others = [`#sn=${snClaimBody}`, `#sol=${solClaimBody}`, `#solreq=${solReqBody}`, evmShort, evmLong, evmReq, "#", "", `#snreqx=${body}`, `#snre=${body}`, `#SNREQ=${body}`, hash.slice(0, 20)];
  for (const o of others) {
    eq(R.starknetRequestBodyFromHash(o), null, `the request reader takes no other link (${o.slice(0, 18) || "empty"})`);
    eq(R.starknetRequestForPay(o, "mainnet", 1), null, `and Pay reads no request from it (${o.slice(0, 18) || "empty"})`);
  }
  for (const b of [snClaimBody, solClaimBody, solReqBody]) ok(!R.decodeStarknetRequest(b).ok, "no other link's body decodes as a Starknet request");
  // Solana's request body is laid out the same way: only the tag in the check keeps them apart.
  const sameShape = Sol.encodeRequest({ network: "mainnet", to: "9wPkC6bZ3mWtq8FxVhN2sRj4LdYa7GuE5oTcKpB1iHzX", asset: ringsAssets("mainnet").find((a) => a.id === "sol")!, amount: 5n * ONE, note: "", name: "" });
  ok(Sol.decodeRequest(sameShape).ok && !R.decodeStarknetRequest(sameShape).ok, "a Solana request whose bytes would fit a Starknet one is still refused");
  eq(R.starknetLinkKind(`#sn=${snClaimBody}`), "claim", "a Starknet claim link");
  eq(R.starknetLinkKind(hash), "request", "a Starknet request");
  for (const o of [`#sol=${solClaimBody}`, `#solreq=${solReqBody}`, evmShort, evmLong, evmReq, "#", ""]) eq(R.starknetLinkKind(o), null, `no Starknet link (${o.slice(0, 18) || "empty"})`);
  eq(Sol.solanaLinkKind(`#sn=${snClaimBody}`), null, "and Solana takes no Starknet claim link either");
}

// ------------------------------------------------------------------ Pay

{
  const onPay = R.starknetRequestForPay(hash, "mainnet", 1);
  eq(onPay, { body, request: base, problem: null }, "Pay reads the request on its network");
  eq(vaultActionFromUrl("move", "pay", hash, STARKNET_VAULT_ACTIONS), "pay", "the link opens Pay on Starknet");
  // what Pay's fields get
  eq([R.requestAmountText(25n * ONE, 6), R.requestAmountText(12_500_000n, 6), R.requestAmountText(1n, 6), R.requestAmountText(1_000_000_000_000n, 6)], ["25", "12.5", "0.000001", "1000000"], "the amount as the field takes it: every decimal kept, none added");
  for (const v of [1n, 7n, 25n * ONE, 12_345_678n, (1n << 64n) - 1n]) {
    const t = R.requestAmountText(v, 6);
    const read = readAmountText(t, 6);
    const [w, f = ""] = t.split(".");
    ok(read.ok && read.text === t && BigInt(w!) * ONE + BigInt((f + "000000").slice(0, 6)) === v, `the field's text reads back to the amount (${t})`);
  }

  const elsewhere = R.starknetRequestForPay(`#snreq=${R.encodeStarknetRequest({ ...base, network: "sepolia" })}`, "mainnet", 1);
  eq(elsewhere?.problem, "This request is for Starknet Sepolia, and this is Gloam on Starknet.", "a request for another network says so, and fills nothing");
  eq(elsewhere?.request, null, "nothing is filled from it");
  const damaged = R.starknetRequestForPay(`#snreq=${body.slice(0, -2)}`, "mainnet", 1);
  eq(damaged?.problem, "This request link is cut off or damaged. Ask them to send it again.", "a damaged link says so");
  const tooNew = resealed(body, (b) => (b[0] = 2));
  eq(R.starknetRequestForPay(`#snreq=${tooNew}`, "mainnet", 1)?.problem, "This request is from a newer Gloam. Reload the page and try again.", "a newer link says to reload");
  const otherToken = R.starknetRequestForPay(`#snreq=${R.encodeStarknetRequest({ ...base, token: 1 })}`, "mainnet", 1);
  eq(otherToken?.problem, "This request asks for a token Gloam doesn't list on Starknet.", "a token Gloam doesn't list is said, not paid in USDC");

  // The banner and the lead, drawn as Pay draws them (no account open: the first-payment line says it may).
  const { StarknetRequestBanner, StarknetRequestLead } = await import("../src/components/app/StarknetRequests");
  const token = { symbol: "USDC", name: "USD Coin", address: "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb", decimals: 6 };
  const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  const banner = text(renderToString(h(StarknetRequestBanner, { request: { ...base, amount: 12_345_678n }, token, onDismiss: () => {} })));
  ok(banner.includes("Ada asked for 12.34 USDC"), `the banner names who and how much, two places cut down (${banner})`);
  ok(banner.includes("Invoice 042"), "and the note");
  ok(banner.includes("To 0x68b8...e656"), "and the account it pays");
  ok(banner.includes("The note stays with you: a payment on Starknet carries none."), "the note is said not to be sent");
  ok(banner.includes("If this is your first payment to them, it shows their private account on Starknet. It never shows who paid or how much."), "what a first payment shows, while it can't be read");
  ok(banner.includes("The name comes from the link. Check the account with them before you pay."), "the name is what the link says");
  const nameless = text(renderToString(h(StarknetRequestBanner, { request: { ...base, name: "", amount: null }, token, onDismiss: () => {} })));
  ok(nameless.includes("Someone asked to be paid in USDC") && !nameless.includes("The name comes from the link"), "no name: no warning about it, and no amount: the token");
  const lead = text(renderToString(h(StarknetRequestLead, { request: base, token })));
  ok(lead.includes("Ada asked for 25.00 USDC") && lead.includes("Open your private account on Starknet below."), "before the account is open, the lead says what is asked");
}

// ------------------------------------------------------------------ the screens, read from their source

const src = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8");
{
  const hub = src("components/app/VaultHub.tsx");
  ok(/const snLink = STARKNET_ENABLED \? starknetLinkKind\(hash\) : null;/.test(hub), "the Vault reads Starknet links, only while Starknet is on");
  ok(/if \(!starknet\) selectStarknet\(\);/.test(hub), "and moves to Starknet for one");
  ok(/const evmLink = \(solana \|\| starknet\) && !solLink && !snLink && /.test(hub), "a Starknet request (mode=pay) is never sent back to an EVM network");
  ok(/toSolana \|\| toStarknet\)/.test(hub), "the placeholder shows while it moves");

  const vault = src("components/app/StarknetVault.tsx");
  const spend = vault.slice(vault.indexOf("function StarknetSpendView"), vault.indexOf("// ---------------------------------------------------------------- Receive"));
  ok(spend.includes("setTo(fromUrl.request.to)") && spend.includes("requestAmountText(fromUrl.request.amount, token.decimals)"), "Pay fills in the account and the amount");
  ok(spend.includes("<StarknetRequestBanner") && spend.includes("fromUrl.problem"), "and shows the request, or why it can't");
  ok((spend.match(/\{asked\}/g) ?? []).length === 2, "with an empty balance too");
  ok(spend.includes("history.replaceState(null"), "a paid request leaves the address bar, so a reload doesn't fill it in again");
  const panel = vault.slice(vault.indexOf("export function StarknetVaultPanel"), vault.indexOf("type Shown"));
  ok(panel.includes("useStarknetRequestInHash(STARKNET_NETWORK, 1)") && panel.includes("<StarknetRequestLead"), "the panel reads it once, and leads with it before the account is open");
  const receive = vault.slice(vault.indexOf("function StarknetReceiveView"));
  ok(receive.includes("Request a payment") && receive.includes("<StarknetRequestCard"), "Receive has Request a payment");

  const card = src("components/app/StarknetRequests.tsx");
  for (const [i, line] of card.split("\n").entries()) ok(!/—|happy to/i.test(line), `StarknetRequests.tsx:${i + 1}: no em dash or banned phrase`);
  ok(!/hides? who (paid|was paid)/i.test(card.replace(/never shows who paid/g, "")), "the request screens never say a payment hides the payee");
  ok(card.includes("Nothing about the request goes on chain"), "Receive says nothing goes on chain");
}

// ------------------------------------------------------------------ docs and Glim

{
  const facts = starknetFacts() ?? "";
  ok(facts.includes("claim links, payment requests and cash out work there"), "Glim: requests work on Starknet");
  ok(facts.includes("A Starknet payment request is a link that fills in Pay") && facts.includes("its note is only shown to the payer"), "Glim: what a request is, and that its note is not sent");
  ok(facts.includes("a first payment shows the payee's private account"), "Glim: paying it shows what any first payment shows");
  const docs = src("app/docs/starknet/page.tsx");
  ok(docs.includes('id="requests"') && docs.includes("Nothing about a request goes on chain"), "the Starknet docs say what a request is");
  ok(src("app/docs/chain/page.tsx").includes("<strong>Payment requests</strong>, a link that fills in Pay with your\n          private account"), "the networks page lists requests on Starknet");
}

console.log(`selftest-starknet-requests: ${checks} checks passed`);
