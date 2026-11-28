/**
 * End to end, funded, devnet: payroll on Solana with the app's own code
 * (lib/solanaRings/payroll, payrollStore, client, and the /api/solana routes,
 * called in place as scripts/e2e-solana-rings.mts does). No browser.
 *
 *  1. Fund the relay and Alice's main wallet from --fund-from (a devnet key of
 *     yours, read once). Register Alice and three recipients through the relay.
 *     Alice adds SOL to her private balance.
 *  2. A list of six: three recipients, one address with no private account,
 *     one that isn't an address, and Alice's own. The three are checked as
 *     payable, the other three flagged and skipped. One run pays the three in
 *     one transaction; each recipient's private balance is checked.
 *  3. Resume, tab closed after the relay sent: the run is stored with its batch
 *     in flight and no signature, then a fresh run picks it up from storage,
 *     finds it landed by its notes and pays nobody twice.
 *  4. Resume, tab closed before the relay sent: a fresh run waits for the
 *     batch's blockhash to expire, sees its notes unspent, and sends it once.
 *
 * Keys: throwaway keys made here for the main wallets and the relay. HELIUS_API_KEY
 * from the shell environment only; it is never printed.
 *
 * Run from app/:
 *   HELIUS_API_KEY=... ../mcp/node_modules/.bin/tsx scripts/e2e-solana-payroll.mts --fund-from <PATH>
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
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== ORIGIN) return realFetch(input as never, init);
  const headers = { "x-forwarded-for": "127.0.0.1", ...Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))) };
  const req = new Request(url, { ...(input instanceof Request ? input : {}), ...init, headers } as RequestInit);
  const path = url.pathname;
  if (path === "/api/solana/rpc") return req.method === "POST" ? rpcRoute.POST(req) : rpcRoute.GET();
  if (path === "/api/solana/relay") {
    if (req.method === "POST") relayPosts++;
    return req.method === "POST" ? relayRoute.POST(req) : relayRoute.GET();
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
type PayrollDeps = import("../src/lib/solanaRings/payroll").PayrollDeps;

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

/** The engine's dependencies, as SolanaPayrollView wires them. */
function deps(s: RingsSession, store: Awaited<ReturnType<typeof rings.ringsPayrollStore>>, over: Partial<PayrollDeps> = {}): PayrollDeps {
  return {
    save: (x) => store.save(x),
    build: (payments) => rings.buildPayments(s, SOL, payments),
    send: (wire) => rings.sendPayments(wire),
    release: () => rings.releasePayments(s),
    confirm: (sig) => rings.confirmPayments(s, sig),
    resolve: (f) => rings.settlePayments(s, f),
    message: (e) => rings.ringsErrorMessage(e),
    tooBig: (e) => rings.paymentsTooBig(e),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    stopRequested: () => false,
    ...over,
  };
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
step(`1. fund from ${short(funder.address)} (${sol(await balance(funder.address))}): relay 0.3 SOL, Alice 0.2 SOL`);
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
    (m) => appendTransactionMessageInstructions([transferSol(relay.relayer as Address, 300_000_000n), transferSol(alice.address, 200_000_000n)], m)
  );
  const signed = await signTransactionMessageWithSigners(msg as never);
  const sig = await heliusRpc<string>("sendTransaction", [Buffer.from(getTransactionEncoder().encode(signed as never)).toString("base64"), { encoding: "base64" }]);
  const a0 = await rings.openRingsAccount({ wallet: alice.wallet, account: alice.account, network: "devnet" });
  await a0.client.confirmTransaction(sig as never);
  rings.closeRingsAccount(a0);
}
const a = await rings.openRingsAccount({ wallet: alice.wallet, account: alice.account, network: "devnet" });
const recipients: RingsSession[] = [];
for (const n of ["Ada", "Tunde", "Chioma"]) {
  const w = await standIn(`${n} wallet`);
  recipients.push(await rings.openRingsAccount({ wallet: w.wallet, account: w.account, network: "devnet" }));
}
const stranger = await rings.openRingsAccount({ ...(await standIn("Stranger wallet")), network: "devnet" });
console.log(`   Alice private ${short(a.address)}; recipients ${recipients.map((r) => short(r.address)).join(", ")}; unregistered ${short(stranger.address)}`);
step("   register Alice and the three recipients through the relay");
for (const s of [a, ...recipients]) await rings.ensureRegistered(s);
console.log(`   registered: ${(await Promise.all([a, ...recipients].map((s) => rings.isRegistered(s)))).join(", ")}; unregistered: ${await rings.isRegistered(stranger)}`);
step("   Alice adds 0.08 SOL privately");
console.log(`   tx ${short(await rings.addToPrivate(a, SOL, 80_000_000n))}; private ${sol(rings.ringsBalances(a).sol!)}`);
const relayStart = await balance(relay.relayer);

// ------------------------------------------------------------------ 2. the list, checked, paid
step("2. a list of six, checked before anyone is paid");
const amounts = [11_000_000n, 12_000_000n, 13_000_000n];
const csv = [
  "name,address,amount",
  ...recipients.map((r, i) => `${["Ada", "Tunde", "Chioma"][i]},${r.address},${P.formatUnits(amounts[i]!, 9)}`),
  `Stranger,${stranger.address},0.01`,
  `Typo,notasolanaaddress,0.01`,
  `Alice herself,${a.address},0.01`,
].join("\n");
const parsed = P.parseSolanaPayrollCsv(csv, SOL);
const registry = await rings.registeredMany(a, P.addressesToCheck(parsed.rows, new Map()));
const rows = P.checkRecipients(parsed.rows, registry, a.address);
for (const r of rows) console.log(`   line ${r.line} ${r.name.padEnd(14)} ${r.error ? `skipped: ${r.error}` : `ok, ${sol(r.amount!)}`}`);
const sum = P.summarize(rows, await privateSol(a));
console.log(`   ${sum.ready} ready, ${sum.skipped} skipped, total ${sol(sum.total)}, short ${sol(sum.short)}`);
if (sum.ready !== 3 || sum.skipped !== 3 || sum.short !== 0n) fail("the list should check out as 3 ready, 3 skipped, covered");
if (rows[3]!.error !== P.NOT_SET_UP || rows[5]!.error !== P.OWN_ACCOUNT || !rows[4]!.error) fail("the three bad rows should say why");

const store = await rings.ringsPayrollStore(a);
const before = await Promise.all(recipients.map(privateSol));
const aliceBefore = await privateSol(a);
const run1 = P.newRun({ id: "e2e-run-1", network: "devnet", owner: a.address, asset: "sol", rows, now: Date.now() });
await store.save(run1);
const postsBefore = relayPosts;
const t0 = Date.now();
const done1 = await P.runPayroll(run1, deps(a, store, { onChange: (r) => process.stdout.write(`   ${r.rows.map((x) => x.status[0]).join("")}\r`) }));
console.log(`\n   run: ${done1.state} in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${relayPosts - postsBefore} relay transaction(s)${done1.error ? `, error: ${done1.error}` : ""}`);
if (done1.state !== "done") fail(`run 1 should finish: ${done1.error}`);
const after1 = await Promise.all(recipients.map(privateSol));
recipients.forEach((r, i) => console.log(`   ${short(r.address)}: ${sol(before[i]!)} -> ${sol(after1[i]!)} (expected +${sol(amounts[i]!)})`));
recipients.forEach((_, i) => (after1[i]! - before[i]! === amounts[i]! ? null : fail(`recipient ${i} should hold exactly +${amounts[i]}`)));
const aliceAfter1 = await privateSol(a);
console.log(`   Alice private ${sol(aliceBefore)} -> ${sol(aliceAfter1)} (paid ${sol(aliceBefore - aliceAfter1)}; the relay paid the fee)`);
if (aliceBefore - aliceAfter1 !== amounts.reduce((x, y) => x + y, 0n)) fail("Alice should have paid exactly the total");
if (relayPosts - postsBefore !== 1) fail("three people should go in one transaction");
const sigs = new Set(done1.rows.filter((r) => r.status === "paid").map((r) => r.signature));
console.log(`   one transaction for all three: ${[...sigs].map((s) => short(s!)).join(", ")}`);
console.log(`   results CSV:\n${P.resultsCsv(done1, SOL).split("\n").map((l) => `     ${l.replace(/[1-9A-HJ-NP-Za-km-z]{32,88}/g, (m) => short(m))}`).join("\n")}`);
const stored1 = (await store.load()).find((r) => r.id === "e2e-run-1");
if (!stored1 || stored1.state !== "done" || stored1.rows.filter((r) => r.status === "paid").length !== 3) fail("the stored run should be done with 3 paid");
console.log(`   stored sealed: ${[...mem.entries()].some(([k, v]) => k.startsWith("gloam:solana-payroll") && v.includes(recipients[0]!.address)) ? "NO, address in the clear" : "yes, no address in the clear"}`);

// ------------------------------------------------------------------ 3. tab closed after the relay sent
step("3. resume: the tab closed after the relay sent the batch (no signature stored)");
const small = [1_000_000n, 2_000_000n];
const run2 = P.newRun({
  id: "e2e-run-2",
  network: "devnet",
  owner: a.address,
  asset: "sol",
  rows: P.checkRecipients(P.parseSolanaPayrollCsv(`Ada,${recipients[0]!.address},0.001\nTunde,${recipients[1]!.address},0.002`, SOL).rows, registry, a.address),
  now: Date.now(),
});
await store.save(run2);
let sentSig = "";
void P.runPayroll(
  run2,
  deps(a, store, {
    send: async (wire) => {
      sentSig = await rings.sendPayments(wire);
      return new Promise<string>(() => {}); // the tab closes here, before the run hears back
    },
  })
);
while (!sentSig) await new Promise((r) => setTimeout(r, 500));
const left2 = (await store.load()).find((r) => r.id === "e2e-run-2")!;
console.log(`   relay sent ${short(sentSig)}; stored: inflight ${left2.inflight ? `yes, ${left2.inflight.nullifiers.length} note(s), signature ${left2.inflight.signature ? "stored" : "not stored"}` : "NO"}`);
if (!left2.inflight || left2.inflight.signature) fail("the stored run should have the batch in flight without a signature");
const b2 = await Promise.all(recipients.slice(0, 2).map(privateSol));
const a2 = await rings.openRingsAccount({ wallet: alice.wallet, account: alice.account, network: "devnet" }); // a fresh page
const store2 = await rings.ringsPayrollStore(a2);
const posts2 = relayPosts;
const done2 = await P.runPayroll((await store2.load()).find((r) => r.id === "e2e-run-2")!, deps(a2, store2));
console.log(`   resumed: ${done2.state}; relay transactions sent on resume: ${relayPosts - posts2}; found signature ${done2.rows[0]!.signature ? short(done2.rows[0]!.signature) : "none"} (relay said ${short(sentSig)})`);
const af2 = await Promise.all(recipients.slice(0, 2).map(privateSol));
af2.forEach((v, i) => console.log(`   ${short(recipients[i]!.address)}: +${sol(v - b2[i]!)} (expected +${sol(small[i]!)})`));
if (done2.state !== "done" || relayPosts - posts2 !== 0) fail("resume should settle the landed batch without sending");
af2.forEach((v, i) => (v - b2[i]! === small[i]! ? null : fail("paid exactly once")));
if (done2.rows[0]!.signature && done2.rows[0]!.signature !== sentSig) fail("the signature found by its notes should be the one the relay sent");

// ------------------------------------------------------------------ 4. tab closed before the relay sent
step("4. resume: the tab closed before the batch reached the relay (waits for its blockhash to expire)");
const run3 = P.newRun({
  id: "e2e-run-3",
  network: "devnet",
  owner: a2.address,
  asset: "sol",
  rows: P.checkRecipients(P.parseSolanaPayrollCsv(`Chioma,${recipients[2]!.address},0.003`, SOL).rows, registry, a2.address),
  now: Date.now(),
});
await store2.save(run3);
let reached = false;
void P.runPayroll(
  run3,
  deps(a2, store2, {
    send: () => {
      reached = true;
      return new Promise<string>(() => {}); // closed before the relay got it
    },
  })
);
while (!reached) await new Promise((r) => setTimeout(r, 500));
const c0 = await privateSol(recipients[2]!);
const a3 = await rings.openRingsAccount({ wallet: alice.wallet, account: alice.account, network: "devnet" });
const store3 = await rings.ringsPayrollStore(a3);
const posts3 = relayPosts;
const t3 = Date.now();
let checksSeen = 0;
const done3 = await P.runPayroll(
  (await store3.load()).find((r) => r.id === "e2e-run-3")!,
  deps(a3, store3, {
    resolve: async (f) => {
      const r = await rings.settlePayments(a3, f);
      checksSeen++;
      if (r.state !== "pending") console.log(`   after ${((Date.now() - t3) / 1000).toFixed(0)}s and ${checksSeen} check(s): ${r.state}`);
      return r;
    },
  })
);
const c1 = await privateSol(recipients[2]!);
console.log(`   resumed: ${done3.state}; relay transactions on resume: ${relayPosts - posts3}; ${short(recipients[2]!.address)} +${sol(c1 - c0)} (expected +0.003 SOL)`);
if (done3.state !== "done" || relayPosts - posts3 !== 1 || c1 - c0 !== 3_000_000n) fail("an unsent batch should be sent once, after its blockhash expired");

console.log(`\nrelay spent ${sol(relayStart - (await balance(relay.relayer)))} on payroll fees (${relayPosts} relay posts in all, registrations included)`);
for (const s of [a, a2, a3, stranger, ...recipients]) rings.closeRingsAccount(s);
console.log("e2e payroll devnet: ok");
process.exit(0);
