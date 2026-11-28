/**
 * End to end, funded, devnet: claim links and payment requests on Solana
 * (lib/solanaRings/claimLink, claim, sentLinks), with the app's own code and
 * /api/solana routes called in place, as scripts/e2e-solana-send.mts does. No
 * browser.
 *
 *  1. Fund the relay and Alice's main wallet from --fund-from (a devnet key of
 *     yours, read once). Register Alice through the relay (Bob stays
 *     unregistered: a claimer needs no registry record). Alice adds SOL.
 *  2. Alice makes a claim link: it is kept (sealed) under her Sent links
 *     before it is paid, and its one-time account then holds the amount.
 *  3. Bob claims it into his private balance. The link then reads used; Bob
 *     claiming again, and Alice taking it back, both find it used.
 *  4. Alice makes a second link and takes it back: her balance is whole again
 *     less nothing (Gloam's relay pays the fees), and the link reads used.
 *  5. Two claims at once (Bob and Carol, both read before either landed):
 *     exactly one lands, the other is told it was claimed.
 *  6. A claim whose relay answer is lost after the send: settled as claimed,
 *     sent once.
 *  7. Bob asks Alice for money with a request link; Alice reads it and pays
 *     what it asks, to the address it names.
 *
 * Keys: throwaway keys made here for the main wallets and the relay. HELIUS_API_KEY
 * from the shell environment only; it is never printed.
 *
 * Run from app/:
 *   HELIUS_API_KEY=... ../mcp/node_modules/.bin/tsx scripts/e2e-solana-claim-links.mts --fund-from <PATH>
 */
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPair,
  getAddressFromPublicKey,
  getBase58Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  signTransactionMessageWithSigners,
  type Address,
} from "@solana/kit";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const env = process.env as Record<string, string | undefined>;
if (!env.HELIUS_API_KEY) throw new Error("Set HELIUS_API_KEY in the shell environment.");
const argv = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const fundFrom = argv("fund-from");
if (!fundFrom) throw new Error("--fund-from <devnet keypair path> is required: this run moves devnet SOL.");
env.NEXT_PUBLIC_SOLANA_RINGS_ENABLED = "1";
env.NEXT_PUBLIC_SOLANA_RINGS_NETWORK = "devnet";
{
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  env.GLOAM_SOLANA_RELAYER_SECRET = getBase58Decoder().decode(new Uint8Array([...seed, ...pub]));
}

const ORIGIN = "http://localhost:3999";
const mem = new Map<string, string>();
Object.assign(globalThis, {
  location: { origin: ORIGIN },
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  },
});

const rpcRoute = await import("../src/app/api/solana/rpc/route");
const sprRoute = await import("../src/app/api/solana/spr/[...path]/route");
const relayRoute = await import("../src/app/api/solana/relay/route");
const realFetch = globalThis.fetch;
let relayPosts = 0;
/** What the relay route does with the next POST. */
let relayMode: "normal" | "lost-after-send" | "lost-before-send" | "hang-after-send" = "normal";
let lastRelayed = "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== ORIGIN) return realFetch(input as never, init);
  const headers = { "x-forwarded-for": "127.0.0.1", ...Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))) };
  const req = new Request(url, { ...(input instanceof Request ? input : {}), ...init, headers } as RequestInit);
  const path = url.pathname;
  if (path === "/api/solana/rpc") return req.method === "POST" ? rpcRoute.POST(req) : rpcRoute.GET();
  if (path === "/api/solana/relay") {
    if (req.method !== "POST") return relayRoute.GET();
    relayPosts++;
    const mode = relayMode;
    relayMode = "normal";
    if (mode === "lost-before-send") throw new TypeError("fetch failed"); // never reached the relay
    const res = await relayRoute.POST(req);
    if (mode === "normal") return res;
    const body = (await res.json()) as { ok?: boolean; signature?: string };
    if (body.ok && body.signature) lastRelayed = body.signature;
    if (mode === "hang-after-send") return new Promise<Response>(() => {}); // the tab closes here
    // the relay sent it, then its answer was lost on the way back
    return new Response(JSON.stringify({ ok: false, error: { code: "upstream_unavailable", message: "Solana is slow to answer. Try again." } }), { status: 502 });
  }
  if (path.startsWith("/api/solana/spr/")) {
    const ctx = { params: Promise.resolve({ path: path.slice("/api/solana/spr/".length).split("/") }) };
    return req.method === "POST" ? sprRoute.POST(req, ctx) : sprRoute.GET(req, ctx);
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const rings = await import("../src/lib/solanaRings/client");
const P = await import("../src/lib/solanaRings/payroll");
const { ringsAssets } = await import("../src/lib/solanaRings/config");
type RingsSession = import("../src/lib/solanaRings/client").RingsSession;

const SOL = ringsAssets("devnet").find((a) => a.id === "sol")!;
const sol = (n: bigint) => `${P.formatUnits(n, 9)} SOL`;
const step = (s: string) => console.log(`\n${s}`);
const short = (a: string) => `${a.slice(0, 4)}...${a.slice(-4)}`;
const fail = (msg: string): never => {
  throw new Error(msg);
};

async function heliusRpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await realFetch(`https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(env.HELIUS_API_KEY!)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}
const balance = async (a: string) => BigInt((await heliusRpc<{ value: number }>("getBalance", [a, { commitment: "confirmed" }])).value);

/** A stand-in Wallet Standard wallet over a throwaway key. */
async function standIn(name: string) {
  const keys = await generateKeyPair();
  const address = await getAddressFromPublicKey(keys.publicKey);
  const account = { address, chains: ["solana:devnet"] };
  const wallet = {
    name,
    icon: "",
    chains: account.chains,
    accounts: [account],
    features: {
      "standard:connect": { connect: async () => ({ accounts: [account] }) },
      "solana:signMessage": {
        signMessage: async ({ message }: { message: Uint8Array }) => [{ signedMessage: message, signature: new Uint8Array(await signBytes(keys.privateKey, message)) }],
      },
      "solana:signTransaction": {
        signTransaction: async ({ transaction }: { transaction: Uint8Array }) => {
          const tx = getTransactionDecoder().decode(transaction);
          const signed = await partiallySignTransaction([keys], tx as never);
          return [{ signedTransaction: new Uint8Array(getTransactionEncoder().encode(signed as never)) }];
        },
      },
    },
  };
  return { wallet: { name, icon: "", wallet: wallet as never }, account: { address, account }, address };
}

async function privateSol(s: RingsSession): Promise<bigint> {
  await rings.syncRings(s);
  return rings.ringsBalances(s).sol ?? 0n;
}

const relay = await rings.relayStatus();
if (!relay.on || !relay.relayer || relay.network !== "devnet") throw new Error("relay should be on, on devnet");

// ------------------------------------------------------------------ 1. set up
const raw = Uint8Array.from(JSON.parse(readFileSync(fundFrom.replace(/^~(?=\/)/, homedir()), "utf8")) as number[]);
const funder = await createKeyPairSignerFromBytes(raw);
raw.fill(0);
const alice = await standIn("Alice wallet");
step(`1. fund from ${short(funder.address)} (${sol(await balance(funder.address))}): relay 0.2 SOL, Alice 0.15 SOL`);
{
  const transferSol = (destination: Address, lamports: bigint) => {
    const data = new Uint8Array(12);
    const view = new DataView(data.buffer);
    view.setUint32(0, 2, true);
    view.setBigUint64(4, lamports, true);
    return {
      programAddress: "11111111111111111111111111111111" as Address,
      accounts: [
        { address: funder.address, role: AccountRole.WRITABLE_SIGNER, signer: funder },
        { address: destination, role: AccountRole.WRITABLE },
      ],
      data,
    };
  };
  const { value: bh } = await heliusRpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(funder, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.blockhash as never, lastValidBlockHeight: BigInt(bh.lastValidBlockHeight) }, m),
    (m) => appendTransactionMessageInstructions([transferSol(relay.relayer as Address, 200_000_000n), transferSol(alice.address, 150_000_000n)], m)
  );
  const signed = await signTransactionMessageWithSigners(msg as never);
  const sig = await heliusRpc<string>("sendTransaction", [Buffer.from(getTransactionEncoder().encode(signed as never)).toString("base64"), { encoding: "base64" }]);
  const a0 = await rings.openRingsAccount({ wallet: alice.wallet, account: alice.account, network: "devnet" });
  await a0.client.confirmTransaction(sig as never);
  rings.closeRingsAccount(a0);
}
const a = await rings.openRingsAccount({ wallet: alice.wallet, account: alice.account, network: "devnet" });
const bobWallet = await standIn("Bob wallet");
const b = await rings.openRingsAccount({ wallet: bobWallet.wallet, account: bobWallet.account, network: "devnet" });
await rings.ensureRegistered(a);
console.log(`   Alice private ${short(a.address)} (registered: ${await rings.isRegistered(a)}), Bob private ${short(b.address)} (registered: ${await rings.isRegistered(b)}: a claimer needs no record)`);
console.log(`   Alice adds 0.06 SOL: ${short(await rings.addToPrivate(a, SOL, 60_000_000n))}; private ${sol(rings.ringsBalances(a).sol!)}`);


const L = await import("../src/lib/solanaRings/claimLink");
const { linkState } = await import("../src/lib/solanaRings/claim");
const { makeSolanaSentLink } = await import("../src/lib/solanaRings/sentLinks");
const { payNewLink } = await import("../src/lib/solanaRings/claim");

/** Make a claim link from `s` for `amount` lamports, as the app does: kept, then paid. */
async function makeLink(s: RingsSession, amount: bigint): Promise<string> {
  const body = L.encodeClaim(L.newClaim("devnet", SOL, amount));
  const store = await rings.ringsSentLinksStore(s);
  const rec = makeSolanaSentLink({ body });
  await payNewLink({
    keep: () => store.add(rec),
    forget: () => store.remove(rec.id),
    pay: (handed) => rings.fundClaim(s, body, SOL, amount, { onHanded: handed }),
    surelyNotSent: rings.surelyNotSent,
  });
  if (!(await store.load()).some((r) => r.body === body)) fail("the link should be kept under Sent links");
  return body;
}

async function linkHolds(by: RingsSession, body: string) {
  const read = L.decodeClaim(body);
  if (!read.ok) return fail("link should decode");
  const e = await rings.openClaimAccount(read.claim, by);
  try {
    const h = await rings.readClaimAccount(e);
    return { state: linkState(h), sol: h.unspent.sol ?? 0n, account: e.address };
  } finally {
    rings.closeClaimAccount(e);
  }
}

async function claim(into: RingsSession, body: string) {
  const read = L.decodeClaim(body);
  if (!read.ok) return fail("link should decode");
  const e = await rings.openClaimAccount(read.claim, into);
  try {
    return await rings.claimInto(into, e);
  } finally {
    rings.closeClaimAccount(e);
  }
}

// ------------------------------------------------------------------ 2. a claim link
step("2. Alice makes a claim link for 0.01 SOL");
const alice0 = await privateSol(a);
const link1 = await makeLink(a, 10_000_000n);
{
  const h = await linkHolds(a, link1);
  console.log(`   ${L.claimLinkUrl(link1).replace(/sol=.*/, "sol=<hidden>")}; one-time account ${short(h.account)} holds ${sol(h.sol)}, state ${h.state}`);
  console.log(`   Alice ${sol(alice0)} -> ${sol(await privateSol(a))} (expected -0.01: the relay pays the fee)`);
  if (h.state !== "unused" || h.sol !== 10_000_000n) fail("the link should hold 0.01 SOL, unused");
}

// ------------------------------------------------------------------ 3. Bob claims it
step("3. Bob (no registry record) claims it");
{
  const bob0 = await privateSol(b);
  const r = await claim(b, link1);
  const bob1 = await privateSol(b);
  console.log(`   ${r.state}; Bob ${sol(bob0)} -> ${sol(bob1)} (expected +0.01)`);
  if (r.state !== "claimed" || bob1 - bob0 !== 10_000_000n) fail("Bob should get 0.01 SOL");
  const again = await claim(b, link1);
  const back = await claim(a, link1);
  const h = await linkHolds(a, link1);
  console.log(`   Bob again: ${again.state}; Alice's take back: ${back.state}; the link reads ${h.state}`);
  if (again.state !== "used" || back.state !== "used" || h.state !== "used") fail("a claimed link reads used for everyone");
}

// ------------------------------------------------------------------ 4. take back
step("4. Alice makes a second link and takes it back");
{
  const before = await privateSol(a);
  const link2 = await makeLink(a, 7_000_000n);
  const mid = await privateSol(a);
  const r = await claim(a, link2);
  const after = await privateSol(a);
  console.log(`   Alice ${sol(before)} -> ${sol(mid)} -> ${sol(after)}; take back: ${r.state}; the link reads ${(await linkHolds(a, link2)).state}`);
  if (r.state !== "claimed" || after !== before) fail("a take back returns the whole amount");
  const bob0 = await privateSol(b);
  const late = await claim(b, link2);
  if (late.state !== "used" || (await privateSol(b)) !== bob0) fail("a link taken back no longer works");
}

// ------------------------------------------------------------------ 5. two claims at once
step("5. Bob and Carol claim the same link at once");
{
  const carolWallet = await standIn("Carol wallet");
  const c = await rings.openRingsAccount({ wallet: carolWallet.wallet, account: carolWallet.account, network: "devnet" });
  const link3 = await makeLink(a, 5_000_000n);
  const [b0, c0] = [await privateSol(b), await privateSol(c)];
  const outs = await Promise.allSettled([claim(b, link3), claim(c, link3)]);
  const [b1, c1] = [await privateSol(b), await privateSol(c)];
  console.log(`   Bob: ${outs[0].status === "fulfilled" ? outs[0].value.state : outs[0].reason}; Carol: ${outs[1].status === "fulfilled" ? outs[1].value.state : outs[1].reason}`);
  console.log(`   Bob +${sol(b1 - b0)}, Carol +${sol(c1 - c0)} (expected 0.005 in all, to one of them)`);
  if (b1 - b0 + (c1 - c0) !== 5_000_000n || (b1 > b0 && c1 > c0)) fail("the link pays out once");
  rings.closeRingsAccount(c);
}

// ------------------------------------------------------------------ 6. relay answer lost
step("6. A claim whose relay answer is lost after the send");
{
  const link4 = await makeLink(a, 4_000_000n);
  const bob0 = await privateSol(b);
  const posts = relayPosts;
  relayMode = "lost-after-send";
  const r = await claim(b, link4);
  const bob1 = await privateSol(b);
  console.log(`   ${r.state} (the relay sent ${short(lastRelayed)}); relay posts ${relayPosts - posts}; Bob +${sol(bob1 - bob0)} (expected +0.004, once)`);
  if (r.state !== "claimed" || bob1 - bob0 !== 4_000_000n || relayPosts - posts !== 1) fail("a lost answer settles as claimed, sent once");
}

// ------------------------------------------------------------------ 7. a payment request
step("7. Bob asks Alice for 0.003 SOL with a request link; Alice pays it");
{
  const body = L.encodeRequest({ network: "devnet", to: b.address, asset: SOL, amount: 3_000_000n, note: "Lunch", name: "Bob" });
  const url = L.requestLinkUrl(body, ORIGIN);
  const read = L.decodeRequest(L.requestBodyFromHash(new URL(url).hash)!);
  if (!read.ok || read.request.to !== b.address || read.request.amount !== 3_000_000n) fail("the request should read back");
  const bob0 = await privateSol(b);
  if (!read.ok) process.exit(1);
  const sig = await rings.payPrivately(a, read.request.to, read.request.asset, read.request.amount!);
  const bob1 = await privateSol(b);
  console.log(`   paid ${short(sig)}; Bob +${sol(bob1 - bob0)} (expected +0.003)`);
  if (bob1 - bob0 !== 3_000_000n) fail("the request should be paid as asked");
}

console.log(`\n${relayPosts} relay posts in all, registrations included`);
for (const s of [a, b]) rings.closeRingsAccount(s);
console.log("e2e claim links devnet: ok");
process.exit(0);
