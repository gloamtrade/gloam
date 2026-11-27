/**
 * Self-test: claim links and payment requests on Solana (lib/solanaRings/
 * claimLink, claim, sentLinks, claimKeep, and the claim-link rows of payroll).
 *
 *  - The link format: round trips for every listed asset on mainnet and devnet;
 *    the fragment is letters, digits and "=" only; a link cut at any length, or
 *    with any one character changed, is refused, never read as another account;
 *    a newer version or an unknown token says so.
 *  - No collision with the EVM links, which stay as they are: the EVM claim
 *    page, the claim box, the funnel and the request reader take nothing from
 *    a Solana link, and the Solana reader takes nothing from an EVM one.
 *  - The one-time account: HKDF-SHA256 over the link's secret, per network;
 *    only the secret opens it; its address is what shows on Solana.
 *  - Claiming against a fake chain (single use, take back, two claims at once,
 *    a relay answer lost after the send, a tab closed mid-claim): the money
 *    lands once, with whoever's claim landed first, and the second is told it
 *    was claimed. Nothing in flight is ever sent again blindly.
 *  - Making a link: kept before anything is sent, dropped only when the payment
 *    surely went nowhere.
 *  - Sent links: sealed (the link never sits in storage in the clear), checked,
 *    capped, and their status words; the claim kept in this tab.
 *  - Requests: round trips, a bad address refused, the note and name cleaned
 *    and capped, a damaged request refused.
 *  - Payroll: a row with no address gets a claim link; the run pays its
 *    one-time account; the results file carries the link.
 *  - The relay pays a claim like any payment: a transact the one-time account
 *    signs, the relay as fee payer.
 *
 * No network. Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-solana-claim-links.mts
 */
import assert from "node:assert/strict";
import { hkdfSync } from "node:crypto";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  getTransactionEncoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
} from "@solana/kit";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};
const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_SOLANA_RINGS_ENABLED = "1";
env.NEXT_PUBLIC_SOLANA_RINGS_NETWORK = "mainnet";

const L = await import("../src/lib/solanaRings/claimLink");
const C = await import("../src/lib/solanaRings/claim");
const SL = await import("../src/lib/solanaRings/sentLinks");
const K = await import("../src/lib/solanaRings/claimKeep");
const P = await import("../src/lib/solanaRings/payroll");
const send = await import("../src/lib/solanaRings/send");
const { runCipher } = await import("../src/lib/solanaRings/payrollStore");
const { ringsAssets } = await import("../src/lib/solanaRings/config");
const { checkSponsoredTransaction, SHIELDED_POOL_PROGRAM } = await import("../src/lib/solanaRings/relayPolicy");
const evm = await import("../src/lib/claimLink");
const { isClaimLink } = await import("../src/lib/funnel");
const { readPaymentRequest, requestParamsFrom } = await import("../src/lib/paymentRequest");
const { vaultActionFromUrl, VAULT_ACTIONS } = await import("../src/lib/vaultHub");
const { SOLANA_VAULT_ACTIONS } = await import("../src/lib/solanaRings/vaultActions");

let n = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  n++;
};
const eq = <T,>(a: T, b: T, msg: string) => {
  assert.deepEqual(a, b, msg);
  n++;
};

const asset = (network: "mainnet" | "devnet", id: string) => ringsAssets(network).find((a) => a.id === id)!;
const USDC = asset("mainnet", "usdc");
const SOL = asset("mainnet", "sol");
let seedCounter = 1;
const fixedRandom = (k: number) => Uint8Array.from({ length: k }, (_, i) => (seedCounter * 37 + i * 11 + 1) % 256);

// ------------------------------------------------------------------ the link format

{
  for (const network of ["mainnet", "devnet"] as const) {
    for (const a of ringsAssets(network)) {
      seedCounter++;
      const c = L.newClaim(network, a, 1_234_567n, fixedRandom);
      const body = L.encodeClaim(c);
      const back = L.decodeClaim(body);
      ok(back.ok, `a ${a.symbol} link on ${network} reads back`);
      if (back.ok) {
        eq([back.claim.network, back.claim.asset.id, back.claim.amount], [network, a.id, 1_234_567n], `its network, token and amount (${a.symbol}, ${network})`);
        eq([...back.claim.secret], [...c.secret], `its secret (${a.symbol}, ${network})`);
      }
      ok(/^[1-9A-HJ-NP-Za-km-z]+$/.test(body), "the body is base58: letters and digits only");
      const url = L.claimLinkUrl(body, "https://www.gloam.trade");
      ok(url.startsWith("https://www.gloam.trade/c#sol="), "the link opens the claim page");
      ok(/^[A-Za-z0-9=]+$/.test(url.split("#")[1]!), "the fragment is letters, digits and = only");
    }
  }

  seedCounter++;
  const c = L.newClaim("mainnet", USDC, 12_500_000n, fixedRandom);
  const body = L.encodeClaim(c);
  ok(body.length <= 44, `a claim link stays short (${body.length} characters after "sol=")`);

  // cut at any length, or one character changed: refused
  let cutOk = true;
  let cutWhy = true;
  for (let i = 1; i < body.length; i++) {
    const r = L.decodeClaim(body.slice(0, i));
    if (r.ok) cutOk = false;
    else if (r.why !== "damaged") cutWhy = false;
  }
  ok(cutOk, "a link cut at any length is refused");
  ok(cutWhy, "and said to be cut or damaged, never from a newer Gloam");
  let typoOk = true;
  for (let i = 0; i < body.length; i++) {
    for (const ch of ["1", "z", "A"]) {
      if (body[i] === ch) continue;
      const bad = body.slice(0, i) + ch + body.slice(i + 1);
      const r = L.decodeClaim(bad);
      if (r.ok) typoOk = false;
    }
  }
  ok(typoOk, "a link with any one character changed is refused, never read as another account");
  ok(!L.decodeClaim(body + "x").ok, "a longer body is refused");
  ok(!L.decodeClaim("").ok && !L.decodeClaim("0OIl").ok, "nothing and non-base58 are refused");

  // a newer version, another network, an unknown token
  const raw = (b: string) => new Uint8Array(getBase58Encoder().encode(b));
  const fnv = (bytes: Uint8Array) => {
    let h = 0x811c9dc5;
    for (const x of bytes) {
      h ^= x;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return [h & 255, (h >>> 8) & 255, (h >>> 16) & 255, h >>> 24];
  };
  const reseal = (bytes: Uint8Array) => {
    const head = bytes.slice(0, bytes.length - 4);
    return getBase58Decoder().decode(Uint8Array.from([...head, ...fnv(head)]));
  };
  const bytes = raw(body);
  eq(bytes.length, 31, "a claim body is 31 bytes");
  eq(fnv(bytes.slice(0, 27)), [...bytes.slice(27)], "its last four bytes are FNV-1a over the rest");
  const v2 = bytes.slice();
  v2[0] = 2;
  eq(L.decodeClaim(reseal(v2)), { ok: false, why: "unknown" }, "a newer version says so");
  const v2long = Uint8Array.from([2, ...bytes.slice(1, 27), 9, 9, 9, 0, 0, 0, 0]);
  eq(L.decodeClaim(reseal(v2long)), { ok: false, why: "unknown" }, "a newer, longer link that is whole says so too");
  const net9 = bytes.slice();
  net9[1] = 9;
  eq(L.decodeClaim(reseal(net9)), { ok: false, why: "unknown" }, "an unknown network says so");
  const usdtDevnet = bytes.slice();
  usdtDevnet[1] = 1;
  usdtDevnet[2] = L.ASSET_CODES.usdt!;
  eq(L.decodeClaim(reseal(usdtDevnet)), { ok: false, why: "unknown" }, "a token Gloam doesn't list on that network says so");
  const zero = bytes.slice();
  zero.fill(0, 3, 11);
  ok(!L.decodeClaim(reseal(zero)).ok, "a zero amount is refused");

  // the asset codes never move
  eq(L.ASSET_CODES, { sol: 0, usdc: 1, usdt: 2, zec: 3 }, "asset codes are fixed");
  assert.throws(() => L.newClaim("mainnet", USDC, 0n), /above zero/);
  n++;
  assert.throws(() => L.newClaim("mainnet", USDC, 1n, (k) => new Uint8Array(k)), /randomness/);
  n++;
  const secrets = new Set<string>();
  for (let i = 0; i < 500; i++) secrets.add(Buffer.from(L.newClaim("mainnet", USDC, 1n).secret).toString("hex"));
  eq(secrets.size, 500, "each new link has its own secret");
  eq(L.newClaim("mainnet", USDC, 1n).secret.length, 16, "16 random bytes");

  // found in anything pasted
  const link = L.claimLinkUrl(body);
  eq(L.claimBodyIn(link), body, "the whole link");
  eq(L.claimBodyIn(`I sent you a private payment on Gloam (12.50 USDC). Tap to claim it:\n\n${link}`), body, "the message it came in");
  eq(L.claimBodyIn(`sol=${body}`), body, "sol=<body>");
  eq(L.claimBodyIn(body), body, "the bare body");
  eq(L.claimBodyIn("hello there"), null, "words are not a link");
  eq(L.claimBodyFromHash(`#sol=${body}`), body, "the fragment");
  eq(L.claimBodyFromHash(`#sol=${body}&x=1`), null, "a fragment with more in it is not taken");
  eq(L.appClaimPath(body), `/app/vault?tab=move&mode=receive#sol=${body}`, "the claim page sends people to Receive on Solana");
}

// ------------------------------------------------------------------ no collision with the EVM links

{
  seedCounter++;
  const body = L.encodeClaim(L.newClaim("mainnet", USDC, 5_000_000n, fixedRandom));
  const solHash = `#sol=${body}`;
  const reqBody = L.encodeRequest({ network: "mainnet", to: "9wPkC6bZ3mWtq8FxVhN2sRj4LdYa7GuE5oTcKpB1iHzX", asset: USDC, amount: 5_000_000n, note: "Invoice 7", name: "Ada" });
  const reqHash = `#solreq=${reqBody}`;
  eq(evm.codeFromHash(solHash), null, "the EVM claim box reads no code from a Solana link");
  eq(evm.shortCodeFromHash(solHash), null, "the EVM claim page reads no short code from a Solana link");
  eq(evm.shortCodeFromHash(reqHash), null, "nor from a Solana request");
  ok(!isClaimLink(L.claimLinkUrl(body)) && !isClaimLink(`sol=${body}`), "the funnel does not count a Solana link as an EVM one");
  eq(readPaymentRequest(requestParamsFrom("?tab=move&mode=pay", reqHash), "robinhood-mainnet"), null, "the EVM request reader reads no request from a Solana one");
  eq(readPaymentRequest(requestParamsFrom("?tab=move&mode=receive", solHash), "robinhood-mainnet"), null, "nor from a Solana claim link");

  // and the other way round
  const evmShort = "#3kY7pQ2mZr8xVb4NcT6wHj9LdFs5Ga1EoUi";
  const evmLong = "#claim=gloam1=eyJ2IjoxLCJwb29sIjoiMHgzOWUyOGNkZTU1Y2FiNzk4ODc0NzQ2YWM1MmNiNGI1Y2M5OWEwMTk0In0";
  const evmReq = "#to=gloamr1.AbC&amount=5&asset=USDG&chain=robinhood-mainnet";
  for (const h of [evmShort, evmLong, evmReq, "#", "", "#solx=abc", `#solreq=${body}`.slice(0, 20)]) {
    eq(L.solanaLinkKind(h), null, `an EVM or broken fragment is no Solana link (${h.slice(0, 16)})`);
  }
  eq(L.solanaLinkKind(solHash), "claim", "a Solana claim link");
  eq(L.solanaLinkKind(reqHash), "request", "a Solana request");
  eq(L.claimBodyIn(`https://gloam.trade/app/vault?tab=move&mode=pay#solreq=${reqBody}`), null, "a request is never read as a claim link");

  // the Vault opens the right action for each
  eq(vaultActionFromUrl("move", "receive", solHash, SOLANA_VAULT_ACTIONS), "receive", "a claim link opens Receive on Solana");
  eq(vaultActionFromUrl("move", "pay", reqHash, SOLANA_VAULT_ACTIONS), "pay", "a request opens Pay on Solana");
  eq(vaultActionFromUrl("move", "receive", evmLong, VAULT_ACTIONS), "receive", "an EVM claim link still opens Receive");
}

// ------------------------------------------------------------------ the one-time account

const spr = await import("@heliuslabs/spr");
await spr.initializePoseidon();
{
  seedCounter++;
  const c = L.newClaim("mainnet", USDC, 1_000_000n, fixedRandom);
  const seed = await L.claimSeed(c.secret, "mainnet");
  const want = new Uint8Array(hkdfSync("sha256", c.secret, "gloam/solana-claim/v1", "claim/mainnet", 32));
  eq([...seed], [...want], "the seed is HKDF-SHA256(secret, gloam/solana-claim/v1, claim/<network>)");
  const again = await L.claimSeed(c.secret, "mainnet");
  eq([...again], [...seed], "the same link always opens the same account");
  const dev = await L.claimSeed(c.secret, "devnet");
  ok(Buffer.compare(Buffer.from(dev), Buffer.from(seed)) !== 0, "the same bytes on devnet are another account");
  const other = await L.claimSeed(L.newClaim("mainnet", USDC, 1n).secret, "mainnet");
  ok(Buffer.compare(Buffer.from(other), Buffer.from(seed)) !== 0, "another link, another account");
  await assert.rejects(() => L.claimSeed(new Uint8Array(15), "mainnet"));
  n++;

  const kp = spr.ShieldedKeypair.fromKeypair(spr.SigningKey.fromEd25519Bytes(seed as never));
  const signer = kp.toSolanaSigner();
  const shielded = kp.shieldedAddress();
  eq(shielded.solanaAddress(), signer.address, "its shielded address is its Solana address");
  // what Solana shows: a payment's output names its owner by this tag, which is the account's own address
  eq([...shielded.confidentialViewTag()], [...getAddressEncoder().encode(signer.address)], "a payment to it names its address on chain (the one-time account shows)");
  const kp2 = spr.ShieldedKeypair.fromKeypair(spr.SigningKey.fromEd25519Bytes((await L.claimSeed(c.secret, "mainnet")) as never));
  eq(kp2.toSolanaSigner().address, signer.address, "rebuilt from the link alone, it is the same account");
  kp.destroy();
  kp2.destroy();
}

// ------------------------------------------------------------------ claiming on a fake chain

type Note = { id: number; asset: string; amount: bigint; spent: boolean };
type Tx = { id: number; note: number; dest: string; blockhash: string; sig: string; landed: boolean };

/** One claim link's one-time account on a fake chain, and who got paid from it. */
function linkWorld(held: { asset: string; amount: bigint }[]) {
  const notes: Note[] = held.map((h, id) => ({ id, ...h, spent: false }));
  const txs: Tx[] = [];
  const credited = new Map<string, bigint>();
  const storage = new Map<string, string>();
  const land = (tx: Tx) => {
    const note = notes.find((x) => x.id === tx.note)!;
    if (note.spent || tx.landed) return false;
    note.spent = true;
    tx.landed = true;
    credited.set(tx.dest, (credited.get(tx.dest) ?? 0n) + note.amount);
    return true;
  };
  return { notes, txs, credited, storage, land, sends: 0 };
}
type World = ReturnType<typeof linkWorld>;

type Mode = "ok" | "lost-landed" | "hang-landed" | "relay-off";

/**
 * A claimer's tab: claimAll with each move through the real guarded send
 * (lib/solanaRings/send), as client claimInto wires it. Each tab reserves only
 * its own notes, so two tabs can build on the same note; the relay's check run
 * refuses the one that comes second.
 */
function claimerTab(w: World, dest: string, modes: Mode[]) {
  const reserved = new Set<number>();
  let clock = 0;
  const read = async (): Promise<import("../src/lib/solanaRings/claim").ClaimHolding> => {
    const unspent: Record<string, bigint> = {};
    for (const x of w.notes) if (!x.spent) unspent[x.asset] = (unspent[x.asset] ?? 0n) + x.amount;
    return { notes: w.notes.length, unspent };
  };
  const pendingKey = `pending:${dest}`;
  const pending = send.pendingStore({
    key: pendingKey,
    cipher: { seal: async (x) => `s:${x}`, open: async (x) => x.slice(2) },
    storage: { getItem: (k) => w.storage.get(k) ?? null, setItem: (k, v) => void w.storage.set(k, v), removeItem: (k) => void w.storage.delete(k) },
  });
  let mode: Mode = "ok";
  const deps = (assetId: string): import("../src/lib/solanaRings/send").SendDeps => ({
    async build() {
      mode = modes.shift() ?? "ok";
      const note = w.notes.find((x) => x.asset === assetId && !x.spent && !reserved.has(x.id));
      if (!note) throw new Error("Your private balance is too low for that.");
      reserved.add(note.id);
      const tx: Tx = { id: w.txs.length, note: note.id, dest, blockhash: `bh${w.txs.length}`, sig: `sig${w.txs.length}`, landed: false };
      w.txs.push(tx);
      return { wire: Uint8Array.of(tx.id), nullifiers: [note.id.toString(16).padStart(64, "0")], blockhash: tx.blockhash };
    },
    async send(wire) {
      const tx = w.txs[wire[0]!]!;
      const stored = await pending.load();
      assert.ok(stored && stored !== "unreadable" && stored.blockhash === tx.blockhash, "a claim is stored as pending before it is sent");
      w.sends++;
      const refuse = (status: number, code: string, maybeSent: boolean) => ({ status, code, message: `relay ${code}`, maybeSent });
      if (mode === "relay-off") throw refuse(503, "relay_off", false);
      // the relay's check run: a note already spent can't be spent again, so it is refused before the send
      if (w.notes.find((x) => x.id === tx.note)!.spent) throw refuse(422, "would_fail", false);
      w.land(tx);
      if (mode === "lost-landed") throw refuse(502, "upstream_unavailable", true);
      if (mode === "hang-landed") return new Promise<string>(() => {});
      return tx.sig;
    },
    async release() {
      reserved.clear();
    },
    async confirm(sig) {
      if (!w.txs.find((t) => t.sig === sig)?.landed) throw new Error("not confirmed");
    },
    async resolve(p) {
      const tx = w.txs.find((t) => t.blockhash === p.blockhash)!;
      if (tx.landed) return { state: "landed", signature: tx.sig };
      reserved.clear();
      return { state: "dropped" };
    },
    pending,
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
  });
  return {
    claim: () => C.claimAll({ read, move: (assetId) => send.sendGuarded(deps(assetId)) }),
    read,
    pending,
  };
}

{
  // nothing arrived yet
  const empty = linkWorld([]);
  eq(await claimerTab(empty, "bob", []).claim(), { state: "empty" }, "a link nothing arrived in says so");
  eq(C.linkState({ notes: 0, unspent: {} }), "empty", "no notes: empty");
  eq(C.linkState({ notes: 1, unspent: { usdc: 0n } }), "used", "notes, none unspent: used");
  eq(C.linkState({ notes: 1, unspent: { usdc: 5n } }), "unused", "money waiting: unused");

  // claimed once, then used
  const w = linkWorld([{ asset: "usdc", amount: 12_500_000n }]);
  const bob = claimerTab(w, "bob", []);
  const r1 = await bob.claim();
  ok(r1.state === "claimed" && r1.moved.length === 1 && r1.moved[0]!.amount === 12_500_000n, "a claim moves everything the link holds");
  eq(w.credited.get("bob"), 12_500_000n, "into the claimer's balance, once");
  eq(await bob.claim(), { state: "used" }, "claimed again: used");
  eq(await claimerTab(w, "carol", []).claim(), { state: "used" }, "anyone else afterwards: used");
  eq(await claimerTab(w, "alice", []).claim(), { state: "used" }, "the sender's take back afterwards: used, nothing to take back");
  eq([...w.credited.entries()], [["bob", 12_500_000n]], "nobody else got anything");
  eq(w.sends, 1, "one payment out of the link in all");

  // take back while nobody has claimed it
  const t = linkWorld([{ asset: "sol", amount: 50_000_000n }]);
  ok((await claimerTab(t, "alice", []).claim()).state === "claimed", "the sender takes back an unused link");
  eq(t.credited.get("alice"), 50_000_000n, "back in the sender's balance");
  eq(await claimerTab(t, "bob", []).claim(), { state: "used" }, "a link taken back no longer works");

  // two claims at once: both read the account before either landed
  const race = linkWorld([{ asset: "usdc", amount: 9_000_000n }]);
  const b = claimerTab(race, "bob", []);
  const c = claimerTab(race, "carol", []);
  const [rb, rc] = await Promise.all([b.claim(), c.claim()]);
  ok(rb.state === "claimed" && rc.state === "used", "two claims at once: the first lands, the second is told it was claimed");
  eq([...race.credited.entries()], [["bob", 9_000_000n]], "the money lands once");
  eq(race.sends, 2, "both claims reached the relay: the second was refused by its check run");
  eq(await c.pending.load(), null, "the refused claim left nothing in flight");

  // the sender takes it back while someone claims it: one of them, never both
  const tb = linkWorld([{ asset: "usdc", amount: 3_000_000n }]);
  const claimer = claimerTab(tb, "bob", []);
  const sender = claimerTab(tb, "alice", []);
  const outs = await Promise.all([claimer.claim(), sender.claim()]);
  eq(outs.map((o) => o.state), ["claimed", "used"], "claim and take back at once: one wins");
  eq([...tb.credited.values()].reduce((s, v) => s + v, 0n), 3_000_000n, "paid out once in all");
  eq(tb.sends, 2, "both were sent for, one was refused");

  // the relay's answer lost after it sent the claim: settled as claimed, never sent twice
  const lost = linkWorld([{ asset: "usdc", amount: 4_000_000n }]);
  const lr = await claimerTab(lost, "bob", ["lost-landed"]).claim();
  ok(lr.state === "claimed", "a claim whose answer was lost after the send is settled as claimed");
  eq([lost.sends, lost.credited.get("bob")], [1, 4_000_000n], "sent once, landed once");

  // a tab closed mid-claim, opened again: the money already left, and the claim is not sent again
  const hang = linkWorld([{ asset: "usdc", amount: 6_000_000n }]);
  const tab1 = claimerTab(hang, "bob", ["hang-landed"]);
  void tab1.claim(); // never answers: the tab closes
  await new Promise((r) => setTimeout(r, 5));
  const tab2 = claimerTab(hang, "bob", []);
  eq(await tab2.claim(), { state: "used" }, "the claim that landed while the tab was closed: nothing left to claim");
  eq([hang.sends, hang.credited.get("bob")], [1, 6_000_000n], "it landed once, and nothing was sent again");

  // a relay that is off: nothing moved, the money still waits, and it says why
  const off = linkWorld([{ asset: "usdc", amount: 1_000_000n }]);
  await assert.rejects(() => claimerTab(off, "bob", ["relay-off"]).claim(), (e: unknown) => (e as { code?: string }).code === "relay_off");
  n++;
  eq(await claimerTab(off, "bob", []).read().then(C.linkState), "unused", "a refused claim leaves the money in the link");
  ok((await claimerTab(off, "bob", []).claim()).state === "claimed", "and the next try claims it");

  // two tokens in one link: both move
  const two = linkWorld([
    { asset: "usdc", amount: 1_000_000n },
    { asset: "sol", amount: 2_000_000n },
  ]);
  const r2 = await claimerTab(two, "bob", []).claim();
  ok(r2.state === "claimed" && r2.moved.length === 2, "every token in the link is claimed");

  // an earlier claim from this browser that went through after all
  const landed = await C.claimAll({
    read: async () => ({ notes: 1, unspent: { usdc: 1n } }),
    move: async () => {
      throw new Error(send.LAST_PAYMENT_LANDED);
    },
  });
  ok(landed.state === "claimed", "an earlier claim that went through after all is reported as claimed");
  eq(C.CLAIMED_ALREADY, "This link was already claimed.", "the used words name nobody");
}

// ------------------------------------------------------------------ making a link: kept before it is paid

{
  const log: string[] = [];
  const run = (pay: (handed: () => void) => Promise<string>, opts: { keepFails?: boolean; surely?: boolean } = {}) =>
    C.payNewLink({
      keep: async () => {
        if (opts.keepFails) throw new Error("QuotaExceededError");
        log.push("keep");
      },
      forget: async () => void log.push("forget"),
      pay: async (handed) => {
        log.push("pay");
        return pay(handed);
      },
      surelyNotSent: () => Boolean(opts.surely),
    });
  eq(await run(async (h) => (h(), "sig1")), "sig1", "a link that pays returns its signature");
  eq(log.splice(0), ["keep", "pay"], "kept before it is paid, and kept after");
  await assert.rejects(() => run(async () => "x", { keepFails: true }), (e: Error) => e.message === C.LINK_NOT_KEPT);
  eq(log.splice(0), [], "a link that can't be kept is never paid");
  await assert.rejects(() => run(async () => Promise.reject(new Error("Your private balance is too low for that."))));
  eq(log.splice(0), ["keep", "pay", "forget"], "never handed to the relay: dropped again");
  await assert.rejects(() => run(async (h) => (h(), Promise.reject(new Error(send.NOT_SENT))), { surely: true }));
  eq(log.splice(0), ["keep", "pay", "forget"], "handed, but surely not sent: dropped again");
  await assert.rejects(() => run(async (h) => (h(), Promise.reject(new Error(send.STILL_CHECKING)))));
  eq(log.splice(0), ["keep", "pay"], "handed, and it may have landed: the link stays");
  n += 3;
}

// ------------------------------------------------------------------ sent links

{
  seedCounter++;
  const body = L.encodeClaim(L.newClaim("mainnet", USDC, 7_250_000n, fixedRandom));
  const rec = SL.makeSolanaSentLink({ body, now: 1_000_000, random: () => "abc" });
  eq([rec.network, rec.asset, rec.amount, rec.createdAt], ["mainnet", "usdc", "7250000", 1_000_000], "a record follows its link");
  assert.throws(() => SL.makeSolanaSentLink({ body: "nope" }));
  n++;

  const parsed = SL.parseSolanaSentLinks([
    rec,
    { ...rec, id: "", body },
    { ...rec, id: "x2", body: "damaged" },
    { ...rec, id: "x3", createdAt: -1 },
    { ...rec, id: "x4", asset: "sol", amount: "999999999", network: "devnet" },
    null,
    "junk",
  ]);
  eq(parsed.length, 2, "only whole records are read back");
  eq([parsed[1]!.asset, parsed[1]!.amount, parsed[1]!.network], ["usdc", "7250000", "mainnet"], "the token, amount and network always follow the link, never what was stored");
  eq(SL.parseSolanaSentLinks("nope"), [], "not a list: nothing");

  // status words
  const now = 2_000_000;
  const base = { createdAt: now - 1_000 };
  eq(SL.solanaSentLinkStatus(base, undefined, now), "checking", "no read yet: checking");
  eq(SL.solanaSentLinkStatus(base, "unused", now), "unused", "money waiting");
  eq(SL.solanaSentLinkStatus(base, "used", now), "used", "claimed");
  eq(SL.solanaSentLinkStatus({ ...base, usedAt: 5 }, undefined, now), "used", "seen claimed before: used, no read needed");
  eq(SL.solanaSentLinkStatus({ ...base, takenBackAt: 5 }, "unused", now), "taken-back", "taken back");
  eq(SL.solanaSentLinkStatus(base, "empty", now), "arriving", "just made and empty: on its way");
  eq(SL.solanaSentLinkStatus({ createdAt: now - SL.EMPTY_AFTER_MS - 1 }, "empty", now), "empty", "empty long after: nothing in it");
  eq(SL.solanaSentLinkStatus(base, null, now), "unknown", "a failed read never guesses");
  ok(SL.canTakeBack("unused") && !SL.canTakeBack("used") && !SL.canTakeBack("arriving") && !SL.canTakeBack("unknown"), "only an unused link can be taken back");
  ok(SL.canRemove("used") && SL.canRemove("taken-back") && SL.canRemove("empty"), "used, taken back or never paid can leave the list");
  ok(!SL.canRemove("unused") && !SL.canRemove("arriving") && !SL.canRemove("unknown") && !SL.canRemove("checking"), "a link that may hold money never leaves the list");
  eq(SL.SOLANA_SENT_LINK_LABEL.unused, "Not used yet", "the words EVM uses");

  // cap: settled ones make room, open ones never go
  const many: import("../src/lib/solanaRings/sentLinks").SolanaSentLink[] = [];
  for (let i = 0; i < 130; i++) {
    seedCounter++;
    const b = L.encodeClaim(L.newClaim("mainnet", USDC, BigInt(i + 1), fixedRandom));
    many.push({ ...SL.makeSolanaSentLink({ body: b, now: 10_000 + i, random: () => `r${i}` }), ...(i < 120 ? { usedAt: 1 } : {}) });
  }
  const capped = SL.capSolanaSentLinks(many, 100);
  eq(capped.filter((r) => !r.usedAt).length, 10, "every link that may hold money stays");
  eq(capped.length, 110, "settled ones are capped");
  ok(capped[0]!.createdAt > capped[capped.length - 1]!.createdAt, "newest first");

  // the sealed store
  const viewing = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const owner = "4nQe8RtV2yJxW7aLmK3sPdF9cHbU6gZoN1iTqEvA5wYr";
  const cipher = await runCipher(viewing, owner, SL.SENT_LINKS_DOMAIN);
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const key = SL.sentLinksKey("mainnet", owner);
  eq(key, `gloam:solana-sent-links:v1:mainnet:${owner}`, "one list per network and private account");
  const store = SL.solanaSentLinksStore({ key, cipher, storage });
  eq(await store.load(), [], "an empty list to start");
  await store.add(rec);
  await store.add({ ...rec, id: "again" });
  const loaded = await store.load();
  eq(loaded.length, 1, "the same link kept twice is one record");
  ok(!mem.get(key)!.includes(body), "the link never sits in storage in the clear");
  ok(mem.get(key)!.startsWith("gsp1."), "sealed with AES-GCM");
  await store.markUsed([loaded[0]!.id], 77);
  eq((await store.load())[0]!.usedAt, 77, "marked used");
  await store.markTakenBack(loaded[0]!.id, 88);
  eq((await store.load())[0]!.takenBackAt, 88, "marked taken back");
  await store.remove(loaded[0]!.id);
  eq(await store.load(), [], "removed");

  // another account's key opens nothing, and never writes over the list
  await store.add(rec);
  const sealed = mem.get(key)!;
  const otherCipher = await runCipher(globalThis.crypto.getRandomValues(new Uint8Array(32)), owner, SL.SENT_LINKS_DOMAIN);
  const other = SL.solanaSentLinksStore({ key, cipher: otherCipher, storage });
  eq(await other.load(), [], "another key reads nothing");
  eq(mem.get(`${key}:unreadable`), sealed, "and sets the list aside first");
  const payrollCipher = await runCipher(viewing, owner);
  ok(!(await payrollCipher.open(sealed).then(() => true, () => false)), "the payroll key of the same account can't open it (a domain of its own)");

  // a write that doesn't read back is an error, not a silent loss
  const lossy = SL.solanaSentLinksStore({ key: "k", cipher, storage: { getItem: () => null, setItem: () => undefined } });
  await assert.rejects(() => lossy.add(rec), /didn't save/);
  n++;
}

// ------------------------------------------------------------------ the claim kept in this tab

{
  seedCounter++;
  const body = L.encodeClaim(L.newClaim("mainnet", SOL, 1n, fixedRandom));
  const mem = new Map<string, string>();
  const s = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  K.keepSolanaClaim(body, s, 1000);
  eq(K.keptSolanaClaim(s, 1000 + 60_000), body, "kept for the tab");
  eq(K.keptSolanaClaim(s, 1000 + K.SOLANA_CLAIM_KEEP_MS + 1), null, "too old: dropped");
  eq(mem.size, 0, "and gone from storage");
  K.keepSolanaClaim("not a link", s, 1000);
  eq(mem.size, 0, "anything that isn't a whole link is never kept");
  K.keepSolanaClaim(body, s, 1000);
  K.dropSolanaClaim(s);
  eq(K.keptSolanaClaim(s, 1001), null, "dropped on claim or sign out");
  mem.set(K.SOLANA_CLAIM_KEY, "{bad json");
  eq(K.keptSolanaClaim(s, 1001), null, "unreadable: dropped");
  eq(K.SOLANA_CLAIM_KEY, "gloam.solanaClaim", "the key WelcomeModal's first paint reads");
}

// ------------------------------------------------------------------ requests

{
  const to = "9wPkC6bZ3mWtq8FxVhN2sRj4LdYa7GuE5oTcKpB1iHzX";
  const r = { network: "mainnet" as const, to, asset: USDC, amount: 1_250_500_000n, note: "Invoice 042", name: "Robin" };
  const body = L.encodeRequest(r);
  eq(L.decodeRequest(body), { ok: true, request: r }, "a request round trips");
  const url = L.requestLinkUrl(body, "https://www.gloam.trade");
  ok(url.startsWith("https://www.gloam.trade/app/vault?tab=move&mode=pay#solreq="), "it opens Pay");
  ok(/^[A-Za-z0-9=]+$/.test(url.split("#")[1]!), "its fragment is letters, digits and = only");
  eq(L.requestBodyFromHash(`#solreq=${body}`), body, "read back from the fragment");
  const any = L.encodeRequest({ ...r, amount: null, note: "", name: "" });
  eq(L.decodeRequest(any), { ok: true, request: { ...r, amount: null, note: "", name: "" } }, "no amount lets the payer choose");
  const sol = L.encodeRequest({ ...r, asset: SOL, amount: 1n });
  ok(L.decodeRequest(sol).ok && (L.decodeRequest(sol) as { request: { asset: { id: string } } }).request.asset.id === "sol", "a SOL request");
  assert.throws(() => L.encodeRequest({ ...r, to: "not-an-address" }), /Solana address/);
  assert.throws(() => L.encodeRequest({ ...r, amount: 0n }), /above zero/);
  n += 2;
  const wide = L.decodeRequest(L.encodeRequest({ ...r, note: "🏠".repeat(80) }));
  ok(wide.ok && new TextEncoder().encode(wide.request.note).length <= 255 && wide.request.note.length > 0, "a note of wide characters is cut to fit, never cut mid-character");
  const dirty = L.decodeRequest(L.encodeRequest({ ...r, note: "  Pay\u0000 me‮ now  " + "x".repeat(200), name: "N".repeat(80) }));
  ok(dirty.ok && !/[\u0000‮]/.test(dirty.request.note) && dirty.request.note.length === L.SOLANA_REQUEST_NOTE_MAX, "the note is cleaned and capped");
  ok(dirty.ok && dirty.request.name.length === L.SOLANA_REQUEST_NAME_MAX, "the name is capped");
  const emoji = L.decodeRequest(L.encodeRequest({ ...r, note: "Rent, März 🏠" }));
  ok(emoji.ok && emoji.request.note === "Rent, März 🏠", "any language reads back");
  let cut = true;
  for (let i = 1; i < body.length; i++) if (L.decodeRequest(body.slice(0, i)).ok) cut = false;
  ok(cut, "a request cut at any length is refused");
  ok(!L.decodeRequest(body.slice(0, -1) + (body.endsWith("2") ? "3" : "2")).ok, "a changed request is refused");
  ok(!L.decodeRequest(L.encodeClaim(L.newClaim("mainnet", USDC, 1n))).ok, "a claim link is no request");
  ok(!L.decodeClaim(body).ok, "and a request is no claim link");
}

// ------------------------------------------------------------------ payroll: a claim link for a row with no address

{
  const a1 = getBase58Decoder().decode(Uint8Array.from({ length: 32 }, (_, j) => (j * 7 + 3) % 256));
  const parsed = P.parseSolanaPayrollCsv(`name,address,amount\nAda,${a1},10\nTunde,,5\nBad,,0`, USDC);
  const [ada, tunde, bad] = parsed.rows;
  ok(!ada!.link && !tunde!.error && tunde!.link === true, "no address: a claim link");
  ok(Boolean(bad!.error) && !bad!.link, "a link row still needs a good amount");
  eq(P.addressesToCheck(parsed.rows, new Map()), [a1], "a link row needs no registry read");
  const checked = P.checkRecipients(parsed.rows, new Map([[a1, true]]), "owner");
  eq(checked[1]!.error, null, "and passes the registry check");
  assert.throws(() => P.newRun({ id: "r", network: "mainnet", owner: "o", asset: "usdc", rows: checked, now: 1 }), /claim links first/);
  n++;

  seedCounter++;
  const linkBody = L.encodeClaim(L.newClaim("mainnet", USDC, 5_000_000n, fixedRandom));
  const oneTime = "Ea1jcfQ2yYqM4b9iWvXk7Pd3NtLs8RhGu5oZcBn6TmJw";
  const rows = checked.map((r) => (r.link && !r.error ? { ...r, address: oneTime, linkBody } : r));
  const run = P.newRun({ id: "r", network: "mainnet", owner: "o", asset: "usdc", rows, now: 1 });
  eq(run.rows[1]!.link, linkBody, "the run keeps the link (sealed with the run)");
  eq(run.rows[1]!.address, oneTime, "and pays its one-time account");
  ok(P.isRun(run), "a run with a link row is a run");
  ok(!P.isRun({ ...run, rows: [{ ...run.rows[0]!, link: 5 }] }), "a link that isn't text is refused");

  const built: { address: string; amount: bigint; link?: string }[][] = [];
  const done = await P.runPayroll(run, {
    save: async () => undefined,
    build: async (payments) => {
      built.push(payments);
      return { wire: Uint8Array.of(1), nullifiers: ["00".repeat(32)], blockhash: "bh" };
    },
    send: async () => "sig",
    release: async () => undefined,
    confirm: async () => undefined,
    resolve: async () => ({ state: "landed" }),
    message: (e) => String(e),
    tooBig: () => false,
    sleep: async () => undefined,
    now: () => 1_000_000,
    stopRequested: () => false,
  });
  eq(built[0], [{ address: a1, amount: 10_000_000n }, { address: oneTime, amount: 5_000_000n, link: linkBody }], "the build gets the link with its row");
  eq(done.rows.map((r) => r.status), ["paid", "paid", "skipped"], "both paid, the bad row skipped");
  const csv = P.resultsCsv(done, USDC, (b) => L.claimLinkUrl(b, "https://www.gloam.trade"));
  const lines = csv.split("\n");
  ok(lines[0]!.endsWith(",claim_link"), "the results file has a claim link column when the run has links");
  ok(lines[2]!.includes("claim link,") && lines[2]!.endsWith(L.claimLinkUrl(linkBody, "https://www.gloam.trade")), "the link row carries its link");
  ok(!lines[1]!.includes("/c#sol="), "a row paid by address carries none");
  const plain = P.resultsCsv({ ...done, rows: done.rows.map((r) => ({ ...r, link: undefined })) }, USDC);
  ok(!plain.split("\n")[0]!.includes("claim_link"), "a run without links reads as it always did");
}

// ------------------------------------------------------------------ the relay pays a claim like any payment

{
  const relayer = await generateKeyPairSigner();
  seedCounter++;
  const c = L.newClaim("mainnet", USDC, 1_000_000n, fixedRandom);
  const kp = spr.ShieldedKeypair.fromKeypair(spr.SigningKey.fromEd25519Bytes((await L.claimSeed(c.secret, "mainnet")) as never));
  const oneTime = kp.toSolanaSigner();
  const transact: Instruction = {
    programAddress: address(SHIELDED_POOL_PROGRAM),
    data: Uint8Array.from([16, 1, 2, 3]),
    accounts: [{ address: oneTime.address, role: AccountRole.WRITABLE_SIGNER, signer: oneTime } as never],
  } as Instruction;
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayer(relayer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(9)) as never, lastValidBlockHeight: 1n }, m),
    (m) => setTransactionMessageConfig({ computeUnitLimit: 450_000, priorityFeeLamports: 10_000n }, m as never),
    (m) => appendTransactionMessageInstructions([transact], m as never)
  );
  const wire = new Uint8Array(getTransactionEncoder().encode((await partiallySignTransactionMessageWithSigners(message as never)) as never));
  const v = checkSponsoredTransaction(wire, relayer.address);
  ok(v.ok && v.kind === "transact", "a claim (the one-time account's transact, the relay as fee payer) is a payment the relay pays for");
  ok(v.ok && v.accounts.includes(oneTime.address), "the relay screens the one-time account like any other");
  kp.destroy();
}

// ------------------------------------------------------------------ the words (source)

{
  const { readFileSync } = await import("node:fs");
  const files = [
    "src/components/app/SolanaLinks.tsx",
    "src/components/app/SolanaVault.tsx",
    "src/components/app/SolanaClaimLanding.tsx",
    "src/components/app/SolanaPayrollView.tsx",
    "src/lib/solanaRings/claim.ts",
    "src/lib/solanaRings/sentLinks.ts",
  ];
  /** A sentence that says who, the sender, the recipient or the payee is hidden or private. */
  const HIDES_WHO = /\b(hide|hides|hidden|hiding|private|unlinkab\w*|anonymous|untraceable)\b[^.]*\b(who paid|whom|sender|recipient|payee|counterpart\w*)\b|\b(who paid|whom|sender|recipient|payee|counterpart\w*)\b[^.]*\b(hidden|private|unlinkab\w*)\b/i;
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    // the words people read: string literals and JSX text, not comments
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    ok(!code.includes("\u2014") && !/happy to/i.test(code), `${f}: no em dash, never "happy to"`);
    for (const sentence of code.split(/(?<=[.!?])\s+/)) ok(!HIDES_WHO.test(sentence), `${f}: never says who is hidden: ${sentence.trim().slice(0, 80)}`);
  }
  const vault = readFileSync(new URL("../src/components/app/SolanaVault.tsx", import.meta.url), "utf8");
  ok(vault.includes("Your private account, the link's one-time account and the account that claims it show on Solana."), "making a link says plainly which accounts show");
  ok(!/<select\b/.test(readFileSync(new URL("../src/components/app/SolanaLinks.tsx", import.meta.url), "utf8")), "no native select");
}

console.log(`selftest-solana-claim-links: ${n} checks passed`);
