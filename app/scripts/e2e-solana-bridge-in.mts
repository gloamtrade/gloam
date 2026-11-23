/**
 * End to end, read only: the deposit a private account makes of money that
 * arrived at its own address (lib/solanaRings/arrivals buildRelayedDeposit),
 * simulated on Solana mainnet against the real Privacy Rings program, with
 * Gloam's relay policy (relayPolicy) judging the exact bytes first.
 *
 * Nothing is signed by a real key and nothing is sent: simulateTransaction
 * with sigVerify off, so any public address can stand in for the private
 * account and the relay. It shows, on the live program:
 *  - a USDC deposit from an account that holds USDC and no SOL at all (a token
 *    account owner with no lamports): it goes through, and the stand-in relay
 *    is charged nothing but the fee;
 *  - a SOL deposit of an account's whole balance: it goes through and leaves
 *    the account at zero, so all that arrived goes private;
 *  - the relay policy passes both, as "deposit".
 *
 * Run from app/ (a public RPC works; no key is read or needed):
 *   ../mcp/node_modules/.bin/tsx scripts/e2e-solana-bridge-in.mts [--rpc <URL>]
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { getBase64Decoder, getBase64Encoder, getTransactionEncoder, type Address, type Transaction } from "@solana/kit";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_SOLANA_RINGS_ENABLED = "1";
env.NEXT_PUBLIC_SOLANA_RINGS_NETWORK = "mainnet";
const argv = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const RPC = argv("rpc") ?? "https://api.mainnet-beta.solana.com";

const { buildRelayedDeposit } = await import("../src/lib/solanaRings/arrivals");
const policy = await import("../src/lib/solanaRings/relayPolicy");
const { ringsAssets } = await import("../src/lib/solanaRings/config");
const spr = await import("@heliuslabs/spr");
const { getTreeAddress } = await import("@heliuslabs/spr/addresses");

let id = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const busy = res.status === 429;
    if (busy && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error && /too many/i.test(json.error.message ?? "") && attempt < 5) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (json.error || json.result === undefined) throw new Error(`${method}: ${json.error?.message ?? res.status}`);
    return json.result;
  }
}

const SYSTEM = "11111111111111111111111111111111";
const usdc = ringsAssets("mainnet").find((a) => a.id === "usdc")!;
const sol = ringsAssets("mainnet").find((a) => a.id === "sol")!;
const client = {
  tree: getTreeAddress(0),
  treeId: 0,
  async getLatestBlockhash() {
    const r = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
    return { blockhash: r.value.blockhash as never, lastValidBlockHeight: BigInt(r.value.lastValidBlockHeight) };
  },
  async getAccount() {
    return undefined;
  },
};

// A recipient: a fresh private account's shielded address (nothing is ever sent to it).
await spr.initializePoseidon();
const recipient = spr.ShieldedKeypair.fromKeypair(spr.SigningKey.fromEd25519Bytes(crypto.getRandomValues(new Uint8Array(32)) as never)).shieldedAddress();

// Stand-ins from recent USDC transfers: system accounts with SOL to pay fees, and a
// token account whose owner holds no lamports at all (as a private account does).
type Info = { lamports: number; owner: string; data: unknown } | null;
let payer: string | null = argv("payer") ?? null;
let solHolder: { address: string; lamports: number } | null = null;
let noSol: { owner: string; tokenAccount: string } | null = null;
const seen = new Set<string>();
const sigs = await rpc<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [usdc.mint, { limit: 100, commitment: "confirmed" }]);
for (const { signature, err } of sigs) {
  if (err || (payer && solHolder && noSol)) continue;
  await new Promise((r) => setTimeout(r, 150));
  const tx = await rpc<{ transaction: { message: { accountKeys: { pubkey: string }[] } }; meta: { postTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[] } } | null>(
    "getTransaction",
    [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]
  ).catch(() => null);
  for (const b of tx?.meta?.postTokenBalances ?? []) {
    if (b.mint !== usdc.mint || !b.owner || seen.has(b.owner) || BigInt(b.uiTokenAmount.amount) < 2_000_000n) continue;
    seen.add(b.owner);
    const info = (await rpc<{ value: Info }>("getAccountInfo", [b.owner, { encoding: "base64" }])).value;
    const account = tx!.transaction.message.accountKeys[b.accountIndex]!.pubkey;
    if (!info && !noSol) noSol = { owner: b.owner, tokenAccount: account };
    else if (info && info.owner === SYSTEM && info.lamports > 50_000_000 && Array.isArray(info.data) && info.data[0] === "") {
      if (!payer) payer = b.owner;
      else if (!solHolder && b.owner !== payer) solHolder = { address: b.owner, lamports: info.lamports };
    }
  }
}
assert.ok(payer && solHolder && noSol, `found stand-ins among recent USDC holders (${[payer, solHolder?.address, noSol?.owner].join(", ")})`);
console.log(`stand-ins: relay ${payer}, SOL holder ${solHolder.address}, USDC owner with no SOL ${noSol.owner}`);

const encode = (tx: Transaction) => new Uint8Array(getTransactionEncoder().encode(tx));
/** The depositor's signature slot filled with stand-in bytes, the relay's left empty: what the relay receives. */
function asReceived(tx: Transaction, depositor: string): Uint8Array {
  return encode({ ...tx, signatures: { ...tx.signatures, [depositor]: new Uint8Array(64).fill(1) } } as Transaction);
}

/** What Solana charges the fee payer for this message: the signatures' base fee and the priority fee. */
async function feeFor(tx: Transaction): Promise<number> {
  const r = await rpc<{ value: number | null }>("getFeeForMessage", [getBase64Decoder().decode(new Uint8Array(tx.messageBytes)), { commitment: "confirmed" }]);
  return r.value ?? -1;
}

async function simulate(tx: Transaction, watch: string[]) {
  const r = await rpc<{ value: { err: unknown; logs?: string[]; accounts?: ({ lamports: number } | null)[]; fee?: number } }>("simulateTransaction", [
    getBase64Decoder().decode(encode(tx)),
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: watch } },
  ]);
  return r.value;
}
const lamportsOf = async (a: string) => (await rpc<{ value: number }>("getBalance", [a, { commitment: "confirmed" }])).value;

let n = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  n++;
  console.log(`ok - ${msg}`);
};

// 1. USDC from an account with no SOL, the relay paying
{
  const tx = await buildRelayedDeposit({
    client: client as never,
    feePayer: payer as Address,
    depositor: noSol.owner as Address,
    recipient,
    asset: usdc,
    amount: 1_000_000n,
    tokenAccount: noSol.tokenAccount as Address,
  });
  const verdict = policy.checkSponsoredTransaction(asReceived(tx, noSol.owner), payer);
  ok(verdict.ok && verdict.kind === "deposit", `relay policy passes the USDC deposit${verdict.ok ? "" : ` (${verdict.reason})`}`);
  const before = await lamportsOf(payer);
  const sim = await simulate(tx, [noSol.owner, payer]);
  if (sim.err) console.log(sim.logs?.slice(-12).join("\n"));
  ok(sim.err === null, "the live program takes a USDC deposit from an account holding no SOL");
  ok((sim.accounts?.[0]?.lamports ?? 0) === 0, "the depositor still holds no SOL: it paid nothing");
  const spent = before - (sim.accounts?.[1]?.lamports ?? 0);
  const fee = await feeFor(tx);
  console.log(`  fee for this message: ${fee} lamports; the stand-in relay's balance moved by ${spent}`);
  ok(fee > 0 && fee <= 2 * 5_000 + Number(policy.RELAY_LIMITS.maxPriorityFeeLamports), `the fee is within what the relay ever pays (${fee} lamports)`);
  ok(spent === fee || Math.abs(spent - fee) < 1_000_000, "the relay's balance moves by the fee and nothing else (live account, so read loosely)");
}

// 2. SOL: the whole balance, so nothing is left behind
{
  const all = BigInt(await lamportsOf(solHolder.address));
  const tx = await buildRelayedDeposit({
    client: client as never,
    feePayer: payer as Address,
    depositor: solHolder.address as Address,
    recipient,
    asset: sol,
    amount: all,
    tokenAccount: null,
  });
  const verdict = policy.checkSponsoredTransaction(asReceived(tx, solHolder.address), payer);
  ok(verdict.ok && verdict.kind === "deposit", `relay policy passes the SOL deposit${verdict.ok ? "" : ` (${verdict.reason})`}`);
  const before = await lamportsOf(payer);
  const sim = await simulate(tx, [solHolder.address, payer]);
  if (sim.err) console.log(sim.logs?.slice(-12).join("\n"));
  ok(sim.err === null, "the live program takes a SOL deposit of an account's whole balance");
  ok((sim.accounts?.[0]?.lamports ?? -1) === 0, "the account is left at zero: all of it went in");
  const spent = before - (sim.accounts?.[1]?.lamports ?? 0);
  const fee = await feeFor(tx);
  console.log(`  fee for this message: ${fee} lamports; the stand-in relay's balance moved by ${spent}`);
  ok(fee > 0 && fee <= 2 * 5_000 + Number(policy.RELAY_LIMITS.maxPriorityFeeLamports), `the fee is within what the relay ever pays (${fee} lamports)`);
}

// 3. The same deposit with the relay as depositor: refused before anything is simulated
{
  const tx = await buildRelayedDeposit({
    client: client as never,
    feePayer: payer as Address,
    depositor: payer as Address,
    recipient,
    asset: sol,
    amount: 5_000_000n,
    tokenAccount: null,
  });
  const v = policy.checkSponsoredTransaction(encode(tx), payer);
  ok(!v.ok, `the relay as depositor is refused${v.ok ? "" : ` (${v.reason})`}`);
}

void getBase64Encoder;
console.log(`e2e-solana-bridge-in: ${n} checks passed (simulated on mainnet, nothing sent)`);
