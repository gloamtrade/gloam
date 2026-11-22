/**
 * End to end, funded, devnet: Pay and Cash out when Gloam's relay answer is
 * lost (lib/solanaRings/send), with the app's own code and /api/solana routes
 * called in place, as scripts/e2e-solana-rings.mts does. No browser.
 *
 *  1. Fund the relay and Alice's main wallet from --fund-from (a devnet key of
 *     yours, read once). Register Alice and Bob through the relay. Alice adds SOL.
 *  2. The relay sends Alice's payment, then its answer is lost (a 502): Pay
 *     settles it on chain and reports it paid. Bob is paid once.
 *  3. The request never reaches the relay (a network error): Pay waits until the
 *     payment's blockhash has expired, sees its notes unspent, says nothing
 *     moved. Bob is not paid; trying again pays him once.
 *  4. The relay sends it and the tab closes before the answer: in a fresh tab,
 *     the next Pay from Alice is held and told the last one went through. Bob
 *     was paid once.
 *  5. Cash out, answer lost after the send: settled, the address gets it once.
 *
 * Keys: throwaway keys made here for the main wallets and the relay. HELIUS_API_KEY
 * from the shell environment only; it is never printed.
 *
 * Run from app/:
 *   HELIUS_API_KEY=... ../mcp/node_modules/.bin/tsx scripts/e2e-solana-send.mts --fund-from <PATH>
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
const send = await import("../src/lib/solanaRings/send");
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
for (const s of [a, b]) await rings.ensureRegistered(s);
console.log(`   Alice private ${short(a.address)}, Bob private ${short(b.address)}, registered: ${await rings.isRegistered(a)}, ${await rings.isRegistered(b)}`);
console.log(`   Alice adds 0.06 SOL: ${short(await rings.addToPrivate(a, SOL, 60_000_000n))}; private ${sol(rings.ringsBalances(a).sol!)}`);

const expectThrows = async (p: Promise<unknown>, message: string, label: string) => {
  try {
    await p;
  } catch (e) {
    if ((e as Error).message === message) return;
    fail(`${label}: expected "${message}", got "${(e as Error).message}"`);
  }
  fail(`${label}: expected "${message}", but it went through`);
};

// ------------------------------------------------------------------ 2. answer lost after the send
step("2. Pay: the relay sends it, then its answer is lost (502)");
{
  const bob0 = await privateSol(b);
  const alice0 = await privateSol(a);
  const posts = relayPosts;
  let checking = 0;
  relayMode = "lost-after-send";
  const t0 = Date.now();
  const sig = await rings.payPrivately(a, b.address, SOL, 11_000_000n, { onChecking: () => void checking++ });
  const bob1 = await privateSol(b);
  console.log(`   Pay returned ${short(sig)} after ${((Date.now() - t0) / 1000).toFixed(1)}s (relay sent ${short(lastRelayed)}); relay posts ${relayPosts - posts}; told it was checking: ${checking > 0}`);
  console.log(`   Bob ${sol(bob0)} -> ${sol(bob1)} (expected +0.011); Alice ${sol(alice0)} -> ${sol(await privateSol(a))}`);
  if (sig !== lastRelayed || relayPosts - posts !== 1 || bob1 - bob0 !== 11_000_000n) fail("a lost answer after the send should settle as paid, once");
}

// ------------------------------------------------------------------ 3. never reached the relay
step("3. Pay: the request never reaches the relay (network error)");
{
  const bob0 = await privateSol(b);
  const posts = relayPosts;
  relayMode = "lost-before-send";
  const t0 = Date.now();
  await expectThrows(rings.payPrivately(a, b.address, SOL, 12_000_000n), send.NOT_SENT, "never sent");
  const bob1 = await privateSol(b);
  console.log(`   Pay said "${send.NOT_SENT}" after ${((Date.now() - t0) / 1000).toFixed(0)}s (its blockhash had to expire); Bob +${sol(bob1 - bob0)} (expected +0)`);
  if (bob1 !== bob0) fail("nothing should move");
  const sig = await rings.payPrivately(a, b.address, SOL, 12_000_000n);
  const bob2 = await privateSol(b);
  console.log(`   tried again: ${short(sig)}; Bob +${sol(bob2 - bob0)} (expected +0.012); relay posts ${relayPosts - posts} (one lost, one sent)`);
  if (bob2 - bob0 !== 12_000_000n) fail("the retry should pay once");
}

// ------------------------------------------------------------------ 4. tab closed after the relay sent
step("4. Pay: the relay sends it, the tab closes before the answer; the next Pay in a fresh tab");
{
  const bob0 = await privateSol(b);
  relayMode = "hang-after-send";
  lastRelayed = "";
  void rings.payPrivately(a, b.address, SOL, 13_000_000n);
  while (!lastRelayed) await new Promise((r) => setTimeout(r, 500));
  const a2 = await rings.openRingsAccount({ wallet: alice.wallet, account: alice.account, network: "devnet" }); // a fresh tab
  const posts = relayPosts;
  await expectThrows(rings.payPrivately(a2, b.address, SOL, 13_000_000n), send.LAST_PAYMENT_LANDED, "closed tab");
  const bob1 = await privateSol(b);
  console.log(`   relay sent ${short(lastRelayed)}; the fresh tab's Pay said "${send.LAST_PAYMENT_LANDED}"; relay posts from it: ${relayPosts - posts}`);
  console.log(`   Bob +${sol(bob1 - bob0)} (expected +0.013, once)`);
  if (bob1 - bob0 !== 13_000_000n || relayPosts - posts !== 0) fail("the payment should have gone once, and the fresh tab sent nothing");
  const sig = await rings.payPrivately(a2, b.address, SOL, 1_000_000n);
  const bob2 = await privateSol(b);
  console.log(`   a new payment after that: ${short(sig)}; Bob +${sol(bob2 - bob1)} (expected +0.001)`);
  if (bob2 - bob1 !== 1_000_000n) fail("a payment after the notice should go through");
  rings.closeRingsAccount(a2);
}

// ------------------------------------------------------------------ 5. Cash out, answer lost after the send
step("5. Cash out: the relay sends it, then its answer is lost (502)");
{
  const to = await getAddressFromPublicKey((await generateKeyPair()).publicKey);
  const a3 = await rings.openRingsAccount({ wallet: alice.wallet, account: alice.account, network: "devnet" });
  relayMode = "lost-after-send";
  const posts = relayPosts;
  const sig = await rings.cashOut(a3, to, SOL, 5_000_000n);
  const got = await balance(to);
  console.log(`   Cash out returned ${short(sig)} (relay sent ${short(lastRelayed)}); ${short(to)} holds ${sol(got)} (expected 0.005); relay posts ${relayPosts - posts}`);
  if (sig !== lastRelayed || got !== 5_000_000n || relayPosts - posts !== 1) fail("a lost answer on a cash out should settle as sent, once");
  rings.closeRingsAccount(a3);
}

console.log(`\n${relayPosts} relay posts in all, registrations included`);
for (const s of [a, b]) rings.closeRingsAccount(s);
console.log("e2e send devnet: ok");
process.exit(0);
