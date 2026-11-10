/**
 * Gloam API client self-test (GloamApiClient, relayBodyFor).
 *
 * Runs against a mocked fetch: checks the URL, method, bearer header and body
 * the client sends for each call, that it unwraps the v1 envelope, and that
 * error envelopes become GloamApiError with the code, status and request id.
 *
 * Run after build:  node test/api.selftest.mjs
 */
import { GloamApiClient, GloamApiError, relayBodyFor } from "../dist/index.js";

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  checks++;
}
async function rejects(p, code, msg) {
  try {
    await p;
  } catch (e) {
    assert(e instanceof GloamApiError, `${msg}: GloamApiError`);
    assert(e.code === code, `${msg}: code ${e.code} !== ${code}`);
    return e;
  }
  assert(false, `${msg}: should throw`);
}

const KEY = "gloam_test_" + "a".repeat(43);
const H = (n) => "0x" + n.toString(16).padStart(64, "0");
const transfer = {
  intent: "private_send",
  chainId: 46630,
  exec: { poolAddress: "0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740", fn: "transfer", valueWei: 0n, args: ["0xdead", H(1), H(2), [H(3), H(4)]] },
};
const unshield = {
  intent: "unshield",
  chainId: 42431,
  exec: {
    poolAddress: "0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb",
    fn: "unshield",
    valueWei: 0n,
    args: ["0xbeef", H(5), H(6), "0x20c0000000000000000000000000000000000000", "0x1111111111111111111111111111111111111111", 250000000n],
  },
};

// ── keys ──
for (const bad of [undefined, "", "sk_live_x", "gloam_test_short", "gloam_prod_" + "a".repeat(43)]) {
  let threw = false;
  try {
    new GloamApiClient({ apiKey: bad });
  } catch (e) {
    threw = e instanceof GloamApiError && e.code === "invalid_key";
  }
  assert(threw, `bad key refused: ${bad}`);
}
assert(new GloamApiClient({ apiKey: KEY }).env === "test", "test env");
assert(new GloamApiClient({ apiKey: "gloam_live_" + "b".repeat(43) }).env === "live", "live env");
assert(new GloamApiClient({ apiKey: KEY }).baseUrl === "https://www.gloam.trade", "default base url (www: the bare host redirects and fetch drops the key)");

// ── relay bodies ──
const tb = relayBodyFor(transfer);
assert(tb.action === "transfer" && tb.chainId === 46630 && tb.commitments.length === 2 && tb.nullifier === H(2), "transfer body");
const ub = relayBodyFor(unshield);
assert(ub.action === "unshield" && ub.amount === "250000000" && ub.to === "0x1111111111111111111111111111111111111111", "unshield body");
for (const fn of ["shieldBound", "sealedSwap"]) {
  let code = null;
  try {
    relayBodyFor({ ...transfer, exec: { ...transfer.exec, fn } });
  } catch (e) {
    code = e.code;
  }
  assert(code === "unsupported", `${fn} is not relayed`);
}
let noExec = null;
try {
  relayBodyFor({ intent: "private_send", chainId: 46630 });
} catch (e) {
  noExec = e.code;
}
assert(noExec === "no_exec", "intent without exec");

// ── calls over a mocked fetch ──
const seen = [];
function mockFetch(reply) {
  return async (url, init) => {
    seen.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const { status = 200, json } = reply(url, init);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
}
const ok = (data) => ({ json: { v: 1, ok: true, data, requestId: "req_0123456789abcdef" } });

const client = new GloamApiClient({
  apiKey: KEY,
  baseUrl: "http://localhost:3121/",
  fetch: mockFetch((url) => {
    if (url.endsWith("/relay")) {
      return ok({ hash: H(9), chainId: 46630, network: "robinhood", action: "transfer", attribution: { recorded: true, kind: "private_payment" }, charged: false });
    }
    if (url.endsWith("/proofs/verify")) return ok({ format: "gloamfunds1", ok: true, checks: [] });
    if (url.includes("/activity")) return ok({ totals: {} });
    return ok({ fine: true });
  }),
});

const r = await client.relay(transfer);
assert(r.hash === H(9) && r.attribution.recorded === true, "relay result unwrapped");
let last = seen.at(-1);
assert(last.url === "http://localhost:3121/api/v1/relay", `relay url ${last.url}`);
assert(last.init.method === "POST", "relay is POST");
assert(last.init.headers.Authorization === `Bearer ${KEY}`, "bearer key sent");
assert(last.init.headers["Content-Type"] === "application/json", "json body");
assert(last.body.action === "transfer" && last.body.root === H(1), "relay body sent");

await client.relay(unshield);
assert(seen.at(-1).body.amount === "250000000", "bigint amount sent as a string");

const submit = client.submitter();
assert((await submit(transfer)) === H(9), "submitter returns the hash");

await client.verifyProof("gloamfunds1:abc");
last = seen.at(-1);
assert(last.url.endsWith("/api/v1/proofs/verify") && last.body.proof === "gloamfunds1:abc", "verify body");

await client.attributeDeposit({ chainId: 46630, txHash: H(7) });
assert(seen.at(-1).url.endsWith("/api/v1/deposits") && seen.at(-1).body.txHash === H(7), "deposit attribution");

await client.activity(999);
assert(seen.at(-1).url.endsWith("/api/v1/activity?limit=200"), "activity limit capped");
await client.leaves("tempo");
assert(seen.at(-1).url.endsWith("/api/v1/vaults/tempo/leaves") && seen.at(-1).init.method === "GET", "leaves GET");
assert(seen.at(-1).init.body === undefined && seen.at(-1).init.headers["Content-Type"] === undefined, "GET has no body");
await client.me();
await client.vaults();
await client.vault("robinhood");
await client.stats();
await client.relayStatus();
await client.paymentRequest({ to: "gloamr1.x", asset: "USDG", amount: "5" });
assert(seen.at(-1).url.endsWith("/api/v1/payment-requests") && seen.at(-1).body.amount === "5", "payment request");

// ── errors ──
const failing = new GloamApiClient({
  apiKey: KEY,
  fetch: mockFetch(() => ({
    status: 429,
    json: { v: 1, ok: false, error: { code: "rate_limited", message: "Slow down." }, requestId: "req_ffffffffffffffff" },
  })),
});
const e = await rejects(failing.me(), "rate_limited", "error envelope");
assert(e.status === 429 && e.requestId === "req_ffffffffffffffff" && e.message === "Slow down.", "error details kept");

const broken = new GloamApiClient({ apiKey: KEY, fetch: async () => new Response("<html>", { status: 502 }) });
const e2 = await rejects(broken.me(), "error", "non-JSON answer");
assert(e2.status === 502, "status kept for non-JSON");

const offline = new GloamApiClient({ apiKey: KEY, fetch: async () => { throw new Error("ECONNREFUSED"); } });
await rejects(offline.me(), "network", "unreachable");

const okFalse = new GloamApiClient({ apiKey: KEY, fetch: mockFetch(() => ({ json: { v: 1, ok: false, error: { code: "x", message: "y" } } })) });
await rejects(okFalse.me(), "x", "ok:false with a 200 is still an error");

// A sweep's submitter says when a failure leaves the send unknown, so its fresh note is kept.
const hash32 = `0x${"11".repeat(32)}`;
const intent = { chainId: 46630, exec: { fn: "transfer", args: ["0x", hash32, hash32, [hash32, hash32]] } };
const answering = (code) => new GloamApiClient({ apiKey: KEY, fetch: mockFetch(() => ({ status: 502, json: { v: 1, ok: false, error: { code, message: "no" } } })) });
for (const code of ["maybe_sent", "rpc", "internal"]) {
  const e = await rejects(answering(code).submitter()(intent), code, `submitter on ${code}`);
  assert(e.maybeSent === true, `${code} leaves the send unknown`);
}
const clear = await rejects(answering("rate_limit").submitter()(intent), "rate_limit", "submitter on a refusal");
assert(clear.maybeSent !== true, "a clear refusal says nothing went out");
const cut = await rejects(offline.submitter()(intent), "network", "submitter with no answer");
assert(cut.maybeSent === true, "no answer leaves the send unknown");

console.log(`api selftest: ${checks} checks passed`);
