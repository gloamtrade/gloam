/**
 * Self-test: short claim and request links (SDK shortLink, lib/claimLink, lib/paymentRequest).
 *
 *  - a payment made from a seed: seed -> secret -> commitment is the note the
 *    transfer witness puts on chain, and the short link opens to that same note
 *  - every network and token: a claim link made short opens to the very same
 *    note (secret, commitment, amount, token, vault, chain, private note) as its long link
 *  - a payment with a 32-byte secret (made before seeds) still gets a short link
 *  - links are letters and digits only after the #, and short
 *  - a link cut short or changed on the way is refused, never read as another payment
 *  - pasted messages, wrapped lines and the in-app #claim=gloam3= form all read
 *  - old links (gloam1=, gloam1-, %2E, a code with no chain) still read and keep the long form
 *  - request links: every network and token, Gloam address, 0x address, ENS
 *    name, amount, note, name and partner code read back exactly as the long link does
 *  - a link whose "#" a chat app wrote as "%23" (or "%2523") is put back on the
 *    404 page before anything else runs: the body leaves the address bar and
 *    history, and /c#<body> opens; any other path is left alone
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-short-links.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  SHORT_LINK_WHERE,
  buildShortPaymentRequestLink as sdkShortRequest,
  buildTransferWitness,
  decodeShortClaim,
  encodeShortClaim,
  fieldToHex,
  generateReceiveKey,
  gloamNetworks as sdkNetworks,
  hexToField,
  noteCommitmentPoseidon,
  openNotePoseidon,
  randomNoteSeed,
  readShortClaim,
  seedToSecret,
} from "@gloamtrade/sdk";
import type { Address, Hex } from "viem";
import { buildNotePackage, decodeNotePackage, encodeNotePackage, encodeNotePackageEncrypted, paymentCodeIn } from "../src/lib/notePackage";
import { appClaimPath, claimLinkFor, codeFromHash, longClaimLinkFor, shortCodeFor, shortCodeFromHash } from "../src/lib/claimLink";
import { isClaimLink } from "../src/lib/funnel";
import { RECOVER_SCRIPT, recoveredLink } from "../src/lib/mangledLink";
import { NETWORK_KEYS, getNetwork, type NetworkKey } from "../src/lib/networks";
import {
  buildPaymentRequestLink,
  buildShortPaymentRequestLink,
  readPaymentRequest,
  requestAssetsFor,
  requestLinkFromShort,
  requestParamsFrom,
} from "../src/lib/paymentRequest";

let n = 0;
const ORIGIN = "https://gloam.trade";
const fragOf = (link: string) => link.slice(link.indexOf("#"));
const seedHex = (i: number) => `0x${(i + 1).toString(16).padStart(2, "0").repeat(16)}` as Hex;
const seedBytes = (h: Hex) => Uint8Array.from(h.slice(2).match(/../g)!.map((b) => parseInt(b, 16)));

// ---------------------------------------------------------------- seed -> note -> commitment

{
  // The payee's note of a real transfer witness made with a seed (an empty tree: the
  // witness's own leaf check fails, which is not what this is about).
  const seed = seedHex(7);
  const asset = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
  const inSecret = fieldToHex(123456789n);
  const w = await buildTransferWitness({
    secretHex: inSecret,
    amountIn: 100_000_000n,
    amountPay: 25_000_000n,
    asset,
    path: { root: 0n, leaf: 0n, pathElements: [], pathIndices: [] } as never,
    paySeed: seed,
  });
  assert.equal(w.paymentNote.seed, seed, "the witness reports the seed");
  assert.equal(BigInt(w.paymentNote.secret), seedToSecret(seedBytes(seed)), "the payee's secret is the seed's");
  assert.equal(w.circomInput.secretPay, seedToSecret(seedBytes(seed)).toString(), "and that secret is what the circuit proves");
  assert.equal(
    w.paymentNote.commitment,
    fieldToHex(await noteCommitmentPoseidon(seedToSecret(seedBytes(seed)), 25_000_000n, asset)),
    "the commitment on chain is Poseidon(seed's secret, amount, asset)"
  );
  assert.ok(seedToSecret(seedBytes(seed)) < 1n << 248n && seedToSecret(seedBytes(seed)) > 0n, "a field element other than zero");
  n += 5;

  // The payment as the app shares it, then claimed from the short link.
  const pack = buildNotePackage({
    pool: getNetwork("robinhood-mainnet").pool!,
    asset,
    amountWei: w.paymentNote.amountWei,
    secret: w.paymentNote.secret,
    commitment: w.paymentNote.commitment,
    chainId: 4663,
    seed: w.paymentNote.seed,
  });
  assert.equal(pack.seed, seed, "the package keeps the seed");
  const code = encodeNotePackage(pack);
  assert.equal((await decodeNotePackage(code)).seed, seed, "a gloam1 code carries the seed (sd)");
  const link = claimLinkFor(code, "robinhood-mainnet", ORIGIN);
  assert.match(link, /^https:\/\/gloam\.trade\/c#[0-9A-Za-z]+$/, "a short link");
  assert.ok(link.length <= 55, `the seed link is short (${link.length}): ${link}`);
  const back = await decodeNotePackage(link);
  assert.equal(back.secret, w.paymentNote.secret, "same secret");
  assert.equal(back.commitment, w.paymentNote.commitment, "same commitment the witness put on chain");
  const opened = await openNotePoseidon(back.secret, BigInt(back.amountWei), back.asset);
  assert.equal(opened.commitment, w.paymentNote.commitment, "what the claim works out matches the leaf");
  assert.equal(back.amountWei, "25000000");
  assert.equal(back.chainId, 4663);
  n += 9;

  // A seed that does not make the secret is never kept.
  assert.equal(buildNotePackage({ ...pack, seed: seedHex(8) }).seed, undefined, "a mismatched seed is dropped");
  n += 1;
}

// ---------------------------------------------------------------- every network and token

/**
 * Tokens a network lists that have no short id yet. Their short links write the
 * vault and token out in full, so they open the same (checked below) but run
 * longer, until an id is appended to SHORT_LINK_WHERE in
 * packages/sdk/src/shortLink.ts. Elysium's KNTQ was listed (opening once its
 * queued limit lands) without one; the tests only saw it once Elysium was on by default.
 */
const NO_SHORT_ID_YET = new Set(["elysium-mainnet KNTQ"]);

const lengths: { kind: string; long: number; short: number }[] = [];
for (const key of NETWORK_KEYS) {
  const net = getNetwork(key);
  for (const [i, asset] of requestAssetsFor(key).entries()) {
    const where = `${key} ${asset.symbol}`;
    const inTable = SHORT_LINK_WHERE.some(
      (w) => w.chainId === net.chainId && w.pool.toLowerCase() === net.pool!.toLowerCase() && w.asset.toLowerCase() === asset.address.toLowerCase()
    );
    // Written out only until the SDK release that gives it an id (SDK 0.7.0 gives KNTQ id 47);
    // from then on it is checked like every other token.
    const writtenOut = NO_SHORT_ID_YET.has(where) && !inTable;
    // Every token a network takes has a short id (a new one fails here until it is added).
    if (!writtenOut) assert.ok(inTable, `${where} has a short id`);
    n++;
    for (const withSeed of [true, false]) {
      const { seed, secret } = withSeed ? { seed: seedHex(i), secret: seedToSecret(seedBytes(seedHex(i))) } : { seed: undefined, secret: hexToField(`0x${(i + 3).toString(16).repeat(62)}`) };
      const amount = 10n ** BigInt(asset.decimals) * BigInt(i + 1) + (withSeed ? 0n : 123n);
      const commitment = fieldToHex(await noteCommitmentPoseidon(secret, amount, asset.address));
      const note = i % 2 ? "Invoice 042" : undefined;
      const pack = buildNotePackage({ pool: net.pool!, asset: asset.address, amountWei: amount.toString(), secret: fieldToHex(secret), commitment, chainId: net.chainId, note, seed });
      const code = encodeNotePackage(pack);
      const long = longClaimLinkFor(code, key, ORIGIN);
      const short = claimLinkFor(code, key, ORIGIN);
      const tag = `${where} ${withSeed ? "seed" : "secret"}`;
      assert.ok(short.startsWith(`${ORIGIN}/c#`), `${tag}: short`);
      assert.match(fragOf(short), /^#[0-9A-Za-z]+$/, `${tag}: letters and digits only`);
      const a = await decodeNotePackage(long);
      const b = await decodeNotePackage(short);
      for (const f of ["secret", "commitment", "amountWei", "chainId", "note", "seed"] as const) assert.equal(b[f], a[f], `${tag}: ${f}`);
      assert.equal(b.pool.toLowerCase(), a.pool.toLowerCase(), `${tag}: vault`);
      assert.equal(b.asset.toLowerCase(), a.asset.toLowerCase(), `${tag}: token`);
      // The code the /c page reads, and the one it hands the claim screen.
      const c = shortCodeFromHash(fragOf(short))!;
      assert.ok(isClaimLink(c), `${tag}: counts as a claim link`);
      const inApp = codeFromHash(fragOf(appClaimPath(c, key)));
      assert.equal((await decodeNotePackage(inApp!)).commitment, a.commitment, `${tag}: the in-app claim path opens it`);
      assert.equal(readShortClaim(c.slice("gloam3.".length)).amountWei, a.amountWei, `${tag}: the landing page reads it without Poseidon`);
      n += 15;
      // the lengths below are for links with a short id
      if (!note && !writtenOut) lengths.push({ kind: `${key} ${asset.symbol} ${withSeed ? "seed" : "secret"}`, long: long.length, short: short.length });
    }
  }
}
const seedMax = Math.max(...lengths.filter((l) => l.kind.endsWith("seed")).map((l) => l.short));
const secretMax = Math.max(...lengths.filter((l) => l.kind.endsWith("secret")).map((l) => l.short));
const longMin = Math.min(...lengths.map((l) => l.long));
assert.ok(seedMax <= 70, `seed links stay short (${seedMax})`);
assert.ok(secretMax <= 110, `secret links stay well under 120 (${secretMax})`);
n += 2;
console.log(`claim links: long ${longMin}+ chars; short ${Math.min(...lengths.map((l) => l.short))}-${seedMax} with a seed, up to ${secretMax} with a 32-byte secret`);

// ---------------------------------------------------------------- damage, pastes, old links

{
  const seed = seedHex(40);
  const secret = seedToSecret(seedBytes(seed));
  const asset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
  const commitment = fieldToHex(await noteCommitmentPoseidon(secret, 5_000_000n, asset));
  const code = encodeNotePackage(buildNotePackage({ pool: getNetwork("base-mainnet").pool!, asset, amountWei: "5000000", secret: fieldToHex(secret), commitment, chainId: 8453, seed }));
  const link = claimLinkFor(code, "base-mainnet", ORIGIN);
  const body = fragOf(link).slice(1);

  // cut short, or one character changed: refused
  for (let cut = 1; cut <= 6; cut++) assert.throws(() => readShortClaim(body.slice(0, -cut)), /cut off or damaged/, `cut ${cut}`);
  const swap = (s: string, i: number) => s.slice(0, i) + (s[i] === "a" ? "b" : "a") + s.slice(i + 1);
  let refused = 0;
  for (let i = 0; i < body.length; i++) {
    try {
      readShortClaim(swap(body, i));
    } catch {
      refused++;
    }
  }
  assert.ok(refused >= body.length - 1, `changed links refused (${refused}/${body.length})`);
  await assert.rejects(decodeNotePackage(`${ORIGIN}/c#${body.slice(0, -2)}`), /cut off or damaged/);
  n += 8;

  // pasted inside a message, wrapped over lines, or with %23
  const msg = `Here you go: ${link} . Enjoy`;
  assert.equal(paymentCodeIn(msg), `gloam3.${body}`, "a short link in a message");
  assert.equal((await decodeNotePackage(msg)).commitment, commitment);
  const wrapped = `${link.slice(0, link.length - 9)}\n${link.slice(link.length - 9)}`;
  assert.equal((await decodeNotePackage(wrapped)).commitment, commitment, "a link broken over a line");
  assert.equal((await decodeNotePackage(link.replace("/c#", "/c%23"))).commitment, commitment, "with %23");
  assert.equal(shortCodeFromHash("#claim=gloam1=abc"), null, "a long fragment is not a short one");
  n += 5;

  // a locked code and an older code with no chain keep the long form, and still read
  const locked = await encodeNotePackageEncrypted(buildNotePackage({ pool: getNetwork("base-mainnet").pool!, asset, amountWei: "5000000", secret: fieldToHex(secret), commitment, chainId: 8453 }), "blue horse");
  assert.ok(claimLinkFor(locked, "base-mainnet", ORIGIN).includes("/claim?net=base-mainnet#claim=gloam1e="), "a locked code stays long");
  const noChain = encodeNotePackage(buildNotePackage({ pool: getNetwork("base-mainnet").pool!, asset, amountWei: "5000000", secret: fieldToHex(secret), commitment }));
  const old = claimLinkFor(noChain, "base-mainnet", ORIGIN);
  assert.ok(old.includes("/claim?net=base-mainnet#claim=gloam1="), "a code with no chain stays long");
  assert.equal(claimLinkFor(code, "robinhood-mainnet", ORIGIN).includes("/claim?"), true, "a link for another network than the code's stays long");
  for (const form of [old, old.replace("#claim=gloam1=", "#claim=gloam1-"), `${ORIGIN}/claim?net=base-mainnet#claim=${noChain.replace(".", "%2E")}`]) {
    assert.equal((await decodeNotePackage(form)).commitment, commitment, `old form reads: ${form.slice(0, 60)}`);
  }
  n += 6;

  // a plain code from before seeds (random 32-byte secret) gets the secret form, same note
  const old32 = { pool: getNetwork("tempo-mainnet").pool!, asset: "0x20c000000000000000000000b9537d11c60e8b50", amountWei: "1250000", secret: fieldToHex(hexToField(`0x${"ab".repeat(31)}`)), chainId: 4217 };
  const c32 = fieldToHex(await noteCommitmentPoseidon(BigInt(old32.secret), 1_250_000n, old32.asset as Address));
  const body32 = encodeShortClaim(old32)!;
  assert.equal((await decodeShortClaim(body32)).commitment, c32, "secret form: same commitment");
  n += 1;
}

// ---------------------------------------------------------------- short codes in the app

{
  // What the app shows and copies as "the code": gloam3.<the short link's body> when the payment
  // has a short link, else the full code. Pasted back anywhere, it opens to the same note.
  const asset = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
  const { seed, secret } = randomNoteSeed();
  const pack = buildNotePackage({
    pool: getNetwork("robinhood-mainnet").pool!,
    asset,
    amountWei: "100000000",
    secret: fieldToHex(secret),
    commitment: fieldToHex(await noteCommitmentPoseidon(secret, 100_000_000n, asset)),
    chainId: 4663,
    seed,
    note: "Rent",
  });
  const long = encodeNotePackage(pack);
  const short = shortCodeFor(long, "robinhood-mainnet");
  const link = claimLinkFor(long, "robinhood-mainnet", ORIGIN);
  assert.match(short, /^gloam3\.[0-9A-Za-z]+$/, "a gloam3 code");
  assert.equal(short.slice("gloam3.".length), link.slice(link.indexOf("#") + 1), "the same body as the short link");
  assert.equal(shortCodeFor(long), short, "with no network, the code's own chain");
  assert.equal(shortCodeFor(short, "robinhood-mainnet"), short, "a short code stays as it is");
  assert.ok(short.length * 5 < long.length, `much shorter (${short.length} vs ${long.length})`);
  console.log(`codes: long ${long.length} chars, short ${short.length}`);
  n += 5;
  // every way it can be pasted reads back to the very same note
  for (const pasted of [short, short.replace(".", "="), `  ${short}\n`, `here you go: ${short} thanks`, link, `${ORIGIN}/claim#claim=${short.replace(".", "=")}`]) {
    const code = paymentCodeIn(pasted);
    const back = await decodeNotePackage(code);
    assert.equal(back.secret, pack.secret, pasted);
    assert.equal(back.commitment, pack.commitment, pasted);
    assert.equal(back.amountWei, pack.amountWei, pasted);
    assert.equal(back.asset.toLowerCase(), pack.asset.toLowerCase(), pasted);
    assert.equal(back.pool.toLowerCase(), pack.pool.toLowerCase(), pasted);
    assert.equal(back.chainId, 4663, pasted);
    assert.equal(back.note, "Rent", pasted);
    assert.equal(back.seed, seed, pasted);
    n += 8;
  }
  // the long code still pastes too
  assert.equal((await decodeNotePackage(paymentCodeIn(long))).commitment, pack.commitment);
  assert.ok(isClaimLink(short), "the funnel counts a short code as a claim code");
  n += 2;

  // what can't be short keeps its full code: another network, no chain named, locked, sealed, an address
  assert.equal(shortCodeFor(long, "tempo"), long, "a code shown on another network stays long, as its link does");
  const { chainId: _c, ...noChain } = pack;
  void _c;
  const old = encodeNotePackage(noChain as typeof pack);
  assert.equal(shortCodeFor(old, "robinhood-mainnet"), old, "a code that names no chain");
  assert.equal(shortCodeFor(old), old);
  const locked = await encodeNotePackageEncrypted(pack, "correct horse");
  assert.equal(shortCodeFor(locked, "robinhood-mainnet"), locked, "a locked code");
  for (const other of [`gloam2t.${"A".repeat(80)}`, `gloamr1.${"B".repeat(80)}`, "not a code"]) {
    assert.equal(shortCodeFor(other, "robinhood-mainnet"), other, other);
  }
  n += 7;
}

// ---------------------------------------------------------------- request links

{
  const { tag } = await generateReceiveKey();
  const targets = [tag, "0x52908400098527886E0F7030069857D2E4169EE7", "robinhood.eth"];
  const reqLengths: number[] = [];
  let longReq = 0;
  for (const key of NETWORK_KEYS) {
    for (const [i, asset] of requestAssetsFor(key).entries()) {
      for (const [j, to] of targets.entries()) {
        const amount = j === 2 ? "" : asset.decimals >= 2 ? ["25", "12.5", "0.01"][i % 3]! : "7";
        const draft = {
          to,
          network: key as NetworkKey,
          asset,
          amount,
          note: i % 2 ? "Invoice 042 · October" : undefined,
          name: j === 0 && i === 0 ? "Robin" : undefined,
          partnerCode: j === 1 && i === 0 ? "AbC123xY" : undefined,
        };
        const long = buildPaymentRequestLink(draft, ORIGIN);
        const short = buildShortPaymentRequestLink(draft, ORIGIN);
        const where = `${key} ${asset.symbol} to#${j}`;
        assert.ok(short.startsWith(`${ORIGIN}/r#`), `${where}: short`);
        assert.match(fragOf(short), /^#[0-9A-Za-z]+$/, `${where}: letters and digits only`);
        // (the SDK knows the tokens each vault lists, not the testnet faucet stocks)
        if (j === 0 && sdkNetworks().some((x) => x.key === key && x.assets.some((y) => y.address.toLowerCase() === asset.address.toLowerCase()))) {
          const sdk = sdkShortRequest({ payTo: to, network: key, asset: asset.address, amount: amount || undefined, note: draft.note, name: draft.name });
          assert.equal(sdk, short, `${where}: the SDK builds the app's exact short link`);
          n++;
        }
        const opened = requestLinkFromShort(fragOf(short).slice(1), ORIGIN)!;
        assert.equal(opened, long, `${where}: /r opens the very same long link`);
        const u = new URL(opened);
        const got = readPaymentRequest(requestParamsFrom(u.search, u.hash), "robinhood-mainnet")!;
        assert.deepEqual(got.problems, [], `${where}: nothing wrong`);
        n += 5;
        if (j === 0 && !draft.note && !draft.name) {
          reqLengths.push(short.length);
          longReq = Math.max(longReq, long.length);
        }
      }
    }
  }
  console.log(`request links: long up to ${longReq} chars; short ${Math.min(...reqLengths)}-${Math.max(...reqLengths)}`);
  assert.ok(Math.max(...reqLengths) <= 90, "request links to a Gloam address stay short");
  // cut or changed: refused (it says where money goes, so it is checked harder)
  const short = buildShortPaymentRequestLink({ to: tag, network: "robinhood-mainnet", asset: requestAssetsFor("robinhood-mainnet")[0]!, amount: "25" }, ORIGIN);
  const body = fragOf(short).slice(1);
  for (let cut = 1; cut <= 4; cut++) assert.equal(requestLinkFromShort(body.slice(0, -cut), ORIGIN), null, `cut ${cut}`);
  let refused = 0;
  for (let i = 0; i < body.length; i++) if (requestLinkFromShort(body.slice(0, i) + (body[i] === "Z" ? "Y" : "Z") + body.slice(i + 1), ORIGIN) === null) refused++;
  assert.equal(refused, body.length, "every one-character change is refused");
  n += 6;
}

// The seeds the app draws are 16 random bytes that make a non-zero secret.
for (let i = 0; i < 20; i++) {
  const s = randomNoteSeed();
  assert.match(s.seed, /^0x[0-9a-f]{32}$/);
  assert.ok(s.secret > 0n && s.secret === seedToSecret(seedBytes(s.seed)));
  n += 2;
}

// A "#" written "%23": the body is in the path. The 404 page puts the link back before anything else runs.
{
  const claim = claimLinkFor(
    encodeNotePackage(buildNotePackage({ pool: getNetwork("robinhood-mainnet").pool as Address, asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", amountWei: "1000000", secret: fieldToHex(randomNoteSeed().secret), commitment: fieldToHex(1n), chainId: 4663 })),
    "robinhood-mainnet",
    ORIGIN,
  );
  const body = fragOf(claim).slice(1);
  const reqBody = fragOf(buildShortPaymentRequestLink({ to: (await generateReceiveKey()).tag, network: "robinhood-mainnet", asset: requestAssetsFor("robinhood-mainnet")[0]!, amount: "5" }, ORIGIN)).slice(1);
  const mangled = (page: string, b: string, hash = "%23") => new URL(`${ORIGIN}/${page}${hash}${b}`).pathname;
  for (const [path, want] of [
    [mangled("c", body), `/c#${body}`],
    [mangled("c", body, "%2523"), `/c#${body}`],
    [mangled("c", body, "/%23"), `/c#${body}`],
    [mangled("c", body, "%23%23"), `/c#${body}`],
    [`${mangled("c", body)}/`, `/c#${body}`],
    [mangled("r", reqBody), `/r#${reqBody}`],
  ] as const) {
    assert.equal(recoveredLink(path), want, path);
    n++;
  }
  for (const path of ["/c", "/c/", "/r", "/claim", "/c%23", "/c%23short", `/c%23${body}/x`, `/x/c%23${body}`, `/cc%23${body}`, `/c%23${body}!`, "/docs/privacy-model", "/hunt/c%23abcdefghij"]) {
    assert.equal(recoveredLink(path), null, path);
    n++;
  }

  // the script, run as the browser runs it: body out of the address bar and history first, then /c#<body> opens
  const run = (pathname: string) => {
    const did: string[] = [];
    const location = { pathname, replace: (u: string) => did.push(`replace ${u}`) };
    const history = { replaceState: (_s: unknown, _t: string, u: string) => did.push(`replaceState ${u}`) };
    vm.runInNewContext(RECOVER_SCRIPT, { location, history });
    return did;
  };
  assert.deepEqual(run(mangled("c", body)), ["replaceState /", `replace /c#${body}`], "via / so /c#... is a new page load, not a fragment change");
  assert.deepEqual(run(mangled("r", reqBody, "%2523")), ["replaceState /", `replace /r#${reqBody}`]);
  assert.deepEqual(run("/no-such-page"), [], "any other 404 stays a 404");
  assert.deepEqual(run(`/c%23${body}/x`), []);
  // a browser that refuses replaceState is not stuck: nothing throws out of the script
  vm.runInNewContext(RECOVER_SCRIPT, { location: { pathname: mangled("c", body), replace() {} }, history: { replaceState() { throw new Error("no"); } } });
  // and what the /c page then reads is the same claim
  assert.equal(shortCodeFromHash(`#${run(mangled("c", body))[1]!.split("#")[1]}`), shortCodeFromHash(`#${body}`));
  // the 404 page runs it first
  const notFound = readFileSync(new URL("../src/app/not-found.tsx", import.meta.url), "utf8");
  assert.ok(/<div[^>]*>\s*\{\/\*[^]*?\*\/\}\s*<script dangerouslySetInnerHTML=\{\{ __html: RECOVER_SCRIPT \}\} \/>\s*<Header \/>/.test(notFound), "the 404 page's first element");
  n += 7;
}

console.log(`selftest-short-links: ${n} checks passed`);
