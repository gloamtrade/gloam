/**
 * End to end: the app's own Solana code (lib/solanaRings and the /api/solana
 * routes) against Helius, in one process. No browser and no dev server: the
 * routes are called in place, through a fetch that sends /api/solana/* to them
 * and everything else to the network.
 *
 * Keys: throwaway keys made here, in memory, for the stand-in main wallets and
 * the relay. HELIUS_API_KEY comes from the shell environment only.
 *
 * Always (devnet or mainnet, no SOL needed): open private accounts (one
 * signature each, the same account again on reopen), read which assets are set
 * up, attest the Helius prover through the proxy and check its proving keys,
 * sync an empty account from the indexer through the proxy, send a real
 * registration to the relay (its policy passes it; Solana refuses it in the
 * simulation because the throwaway relay holds no SOL), and simulate a deposit
 * of SOL and of USDC from a funded public address (--from), unsigned.
 *
 * Funded (devnet, --fund-from <keypair path>, a devnet key of yours read once):
 * fund the relay and Alice, register both, Alice adds SOL, pays Bob privately,
 * Bob cashes out to a fresh address. The devnet RPC faucets are closed.
 *
 * Run from app/:
 *   HELIUS_API_KEY=... ../mcp/node_modules/.bin/tsx scripts/e2e-solana-rings.mts [--network devnet|mainnet] [--from <ADDRESS>] [--fund-from <PATH>]
 */
import { generateKeyPairSync } from "node:crypto";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import {
  generateKeyPair,
  getAddressFromPublicKey,
  getBase58Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  signBytes,
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
env.NEXT_PUBLIC_SOLANA_RINGS_ENABLED = "1";
const argv = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const NETWORK = (argv("network") ?? "devnet") as "devnet" | "mainnet";
if (NETWORK !== "devnet" && NETWORK !== "mainnet") throw new Error("--network is devnet or mainnet");
env.NEXT_PUBLIC_SOLANA_RINGS_NETWORK = NETWORK;

// The relay's key: a throwaway devnet key, in this process only
{
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  env.GLOAM_SOLANA_RELAYER_SECRET = getBase58Decoder().decode(new Uint8Array([...seed, ...pub]));
}

const ORIGIN = "http://localhost:3999";
const store = new Map<string, string>();
Object.assign(globalThis, {
  location: { origin: ORIGIN },
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

const rpcRoute = await import("../src/app/api/solana/rpc/route");
const sprRoute = await import("../src/app/api/solana/spr/[...path]/route");
const relayRoute = await import("../src/app/api/solana/relay/route");
const realFetch = globalThis.fetch;
const counts: Record<string, number> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== ORIGIN) return realFetch(input as never, init);
  const req = new Request(url, { ...(input instanceof Request ? input : {}), ...init, headers: { "x-forwarded-for": "127.0.0.1", ...Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))) } } as RequestInit);
  const path = url.pathname;
  counts[path.split("/").slice(0, 4).join("/")] = (counts[path.split("/").slice(0, 4).join("/")] ?? 0) + 1;
  if (path === "/api/solana/rpc") return req.method === "POST" ? rpcRoute.POST(req) : rpcRoute.GET();
  if (path === "/api/solana/relay") return req.method === "POST" ? relayRoute.POST(req) : relayRoute.GET();
  if (path.startsWith("/api/solana/spr/")) {
    const ctx = { params: Promise.resolve({ path: path.slice("/api/solana/spr/".length).split("/") }) };
    return req.method === "POST" ? sprRoute.POST(req, ctx) : sprRoute.GET(req, ctx);
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const rings = await import("../src/lib/solanaRings/client");
const { ringsAssets } = await import("../src/lib/solanaRings/config");
type SolanaWallet = import("../src/lib/solanaWallet").SolanaWallet;
type SolanaAccount = import("../src/lib/solanaWallet").SolanaAccount;

/** A stand-in Wallet Standard wallet over a throwaway key. */
async function standInWallet(name: string): Promise<{ wallet: SolanaWallet; account: SolanaAccount; address: Address }> {
  const keys = await generateKeyPair();
  const address = await getAddressFromPublicKey(keys.publicKey);
  const account = { address, chains: ["solana:devnet", "solana:mainnet"] };
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

async function heliusRpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await realFetch(`https://${NETWORK}.helius-rpc.com/?api-key=${encodeURIComponent(env.HELIUS_API_KEY!)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}
const balance = async (a: string) => BigInt((await heliusRpc<{ value: number }>("getBalance", [a, { commitment: "confirmed" }])).value);

const SOL = ringsAssets(NETWORK).find((a) => a.id === "sol")!;
const USDC = ringsAssets(NETWORK).find((a) => a.id === "usdc")!;
const sol = (n: bigint) => `${(Number(n) / 1e9).toFixed(4)} SOL`;
const step = (s: string) => console.log(`\n${s}`);
const proxyRpc = async <T,>(method: string, params: unknown[]) => {
  const res = await globalThis.fetch(`${ORIGIN}/api/solana/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()) as { result?: T; error?: { message?: string } };
};

const relay = await rings.relayStatus();
console.log(`network ${relay.network}; relay on: ${relay.on}, funded: ${relay.funded}, fee payer ${relay.relayer}`);
if (!relay.on || !relay.relayer || relay.network !== NETWORK) throw new Error("relay should be on, on this network");

const alice = await standInWallet("Alice wallet");
const bob = await standInWallet("Bob wallet");

step("1. open private accounts (one signature each)");
const a = await rings.openRingsAccount({ wallet: alice.wallet, account: alice.account, network: NETWORK });
const b = await rings.openRingsAccount({ wallet: bob.wallet, account: bob.account, network: NETWORK });
const again = await rings.openRingsAccount({ wallet: alice.wallet, account: alice.account, network: NETWORK });
const other = await rings.openRingsAccount({ wallet: alice.wallet, account: alice.account, index: 1, network: NETWORK });
console.log(`   Alice main ${alice.address}`);
console.log(`   Alice private #0 ${a.address} (reopened: ${again.address === a.address ? "same" : "DIFFERENT"})`);
console.log(`   Alice private #1 ${other.address}`);
console.log(`   Bob private #0   ${b.address}`);
if (again.address !== a.address || other.address === a.address) throw new Error("derivation is wrong");
rings.closeRingsAccount(again);
rings.closeRingsAccount(other);

step("2. assets set up on chain");
const ready = await rings.assetsReady(NETWORK);
console.log(`   ${Object.entries(ready).map(([k, v]) => `${k} ${v ? "set up" : "not set up yet"}`).join(", ")}`);

step("3. the Helius prover, through Gloam's proxy (TEE policy, attestation, proving keys)");
const attested = await a.client.attestProver();
console.log(`   attested: image ${Buffer.from((attested as { imageId: Uint8Array }).imageId).toString("hex").slice(0, 16)}...`);
const keyReport = await a.client.checkProverProvingKeys();
console.log(`   proving keys: ${JSON.stringify(keyReport, (_k, v) => (typeof v === "bigint" ? String(v) : v)).slice(0, 160)}`);

step("4. sync an empty private account from the indexer, through the proxy");
await rings.syncRings(a);
console.log(`   Alice private balances: ${JSON.stringify(rings.ringsBalances(a), (_k, v) => (typeof v === "bigint" ? String(v) : v))}`);
console.log(`   registered: ${await rings.isRegistered(a)}`);

step("5. a real registration through the relay");
const regWire = await rings.buildRegistration(a, relay.relayer as Address);
const regRes = await globalThis.fetch(`${ORIGIN}/api/solana/relay`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ tx: Buffer.from(regWire!).toString("base64") }),
});
const regJson = (await regRes.json()) as { ok?: boolean; signature?: string; error?: { code?: string; message?: string } };
console.log(`   relay answered ${regRes.status}: ${regJson.ok ? `sent ${regJson.signature}` : `${regJson.error?.code}: ${regJson.error?.message}`}`);
const relayFunded = (await balance(relay.relayer)) > 0n;
if (!relayFunded && regJson.error?.code !== "relay_empty") throw new Error("an unfunded relay should pass the policy and report itself empty");
const badRes = await globalThis.fetch(`${ORIGIN}/api/solana/relay`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ tx: Buffer.from(await rings.buildAddTransaction(a, SOL, 1_000_000n)).toString("base64") }),
});
console.log(`   a deposit sent to the relay: ${badRes.status} ${((await badRes.json()) as { error?: { message?: string } }).error?.message}`);
if (badRes.status !== 422) throw new Error("the relay must refuse a deposit");

const from = argv("from");
if (from) {
  step(`6. simulate deposits from ${from} (unsigned, nothing sent)`);
  for (const [asset, amount] of [
    [SOL, 1_000_000n],
    [USDC, 1_000_000n],
  ] as const) {
    if (!ready[asset.id]) {
      console.log(`   ${asset.symbol}: not set up yet`);
      continue;
    }
    const wire = await rings.buildAddTransaction(a, asset, amount, from as Address);
    const sim = await proxyRpc<{ value: { err: unknown; logs?: string[]; unitsConsumed?: number } }>("simulateTransaction", [
      Buffer.from(wire).toString("base64"),
      { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
    ]);
    const v = sim.result?.value;
    console.log(
      `   ${asset.symbol} ${amount}: ${v ? (v.err ? `FAILED ${JSON.stringify(v.err)}` : `ok, ${v.unitsConsumed} compute units, version 0`) : `rpc error ${sim.error?.message}`}`
    );
    if (v?.err) for (const l of (v.logs ?? []).slice(-6)) console.log(`     ${l}`);
  }
}

if (from) {
  step(`6b. simulate Alice's registration with ${from} as the payer (what the relay sends, its fee payer swapped)`);
  const reg = await rings.buildRegistration(a, from as Address);
  const sim = await proxyRpc<{ value: { err: unknown; logs?: string[]; unitsConsumed?: number } }>("simulateTransaction", [
    Buffer.from(reg!).toString("base64"),
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
  ]);
  const v = sim.result?.value;
  console.log(`   register + merge encryption: ${v ? (v.err ? `FAILED ${JSON.stringify(v.err)}` : `ok, ${v.unitsConsumed} compute units, version 1`) : `rpc error ${sim.error?.message}`}`);
  if (v?.err) for (const l of (v.logs ?? []).slice(-6)) console.log(`     ${l}`);
}

const fundFrom = argv("fund-from");
if (fundFrom && NETWORK === "devnet") {
  const { readFileSync } = await import("node:fs");
  const { createKeyPairSignerFromBytes, pipe: p, createTransactionMessage: ctm, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash: life, appendTransactionMessageInstructions: app, signTransactionMessageWithSigners } = await import("@solana/kit");
  const { AccountRole } = await import("@solana/kit");
  const transferSol = (source: typeof funder, destination: Address, lamports: bigint) => {
    const data = new Uint8Array(12);
    const view = new DataView(data.buffer);
    view.setUint32(0, 2, true);
    view.setBigUint64(4, lamports, true);
    return {
      programAddress: "11111111111111111111111111111111" as Address,
      accounts: [
        { address: source.address, role: AccountRole.WRITABLE_SIGNER, signer: source },
        { address: destination, role: AccountRole.WRITABLE },
      ],
      data,
    };
  };
  const raw = Uint8Array.from(JSON.parse(readFileSync(fundFrom.replace(/^~(?=\/)/, (await import("node:os")).homedir()), "utf8")) as number[]);
  const funder = await createKeyPairSignerFromBytes(raw);
  raw.fill(0);
  step(`7. fund from ${funder.address}: relay and Alice 0.2 SOL each`);
  const { value: bh } = await heliusRpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const msg = p(
    ctm({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(funder, m),
    (m) => life({ blockhash: bh.blockhash as never, lastValidBlockHeight: BigInt(bh.lastValidBlockHeight) }, m),
    (m) =>
      app(
        [
          transferSol(funder, relay.relayer as Address, 200_000_000n),
          transferSol(funder, alice.address, 200_000_000n),
        ],
        m
      )
  );
  const signed = await signTransactionMessageWithSigners(msg as never);
  const sig = await heliusRpc<string>("sendTransaction", [Buffer.from(getTransactionEncoder().encode(signed as never)).toString("base64"), { encoding: "base64" }]);
  await a.client.confirmTransaction(sig as never);
  const relayStart = await balance(relay.relayer);
  const cashOutTo = await getAddressFromPublicKey((await generateKeyPair()).publicKey);

  step("8. register both through the relay");
  await rings.ensureRegistered(a);
  await rings.ensureRegistered(b);
  await rings.ensureRegistered(a); // already registered: nothing sent
  console.log(`   registered: Alice ${await rings.isRegistered(a)}, Bob ${await rings.isRegistered(b)}; private accounts hold ${sol(await balance(a.address))} / ${sol(await balance(b.address))} public SOL`);

  step("9. Alice adds 0.05 SOL from her main wallet");
  console.log(`   tx ${await rings.addToPrivate(a, SOL, 50_000_000n)}`);
  console.log(`   Alice private balance (decrypted here): ${sol(rings.ringsBalances(a).sol!)}`);

  step("10. Alice pays Bob 0.02 SOL privately (the relay pays the fee)");
  console.log(`   tx ${await rings.payPrivately(a, b.address, SOL, 20_000_000n)}`);
  await rings.syncRings(b);
  console.log(`   Alice ${sol(rings.ringsBalances(a).sol!)}, Bob ${sol(rings.ringsBalances(b).sol!)}`);

  step("11. Bob cashes out 0.01 SOL to a fresh address");
  console.log(`   tx ${await rings.cashOut(b, cashOutTo, SOL, 10_000_000n)}`);
  console.log(`   Bob ${sol(rings.ringsBalances(b).sol!)}, fresh address holds ${sol(await balance(cashOutTo))}`);
  console.log(`   relay spent ${sol(relayStart - (await balance(relay.relayer)))} (fees and two registrations' rent)`);
}

console.log(`\nproxy calls: ${JSON.stringify(counts)}`);
rings.closeRingsAccount(a);
rings.closeRingsAccount(b);
console.log(`e2e ${NETWORK}: ok`);
process.exit(0);
