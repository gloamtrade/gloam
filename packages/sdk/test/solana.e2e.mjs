/**
 * Solana end to end, READ ONLY, on mainnet through Gloam's public endpoints.
 * Not part of `pnpm test` (it needs the network). Moves no funds and sends
 * nothing:
 *
 *  - a throwaway main wallet (a fresh key, never funded) opens its private account
 *  - the private balance syncs from the Rings indexer and reads 0
 *  - the account is not registered yet
 *  - the registration is built against the live relay's address, passes the
 *    relay's own policy (app/src/lib/solanaRings/relayPolicy.ts) as a
 *    registration, and a simulation with the relay as fee payer succeeds:
 *    exactly what the relay checks before it signs. It is never sent.
 *  - the relay's request body is { tx: base64 }, and a payment's status reads
 *    a dropped transaction as dropped, not pending forever.
 *
 * Run after build (Node 22.18+, which loads the app's TypeScript):
 *   node test/solana.e2e.mjs
 * GLOAM_SOLANA_BASE_URL points it at another deployment.
 */
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const base = process.env.GLOAM_SOLANA_BASE_URL || "https://www.gloam.trade";
const sol = await import("../dist/solana.js");
const t0 = Date.now();
const step = (s) => console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${s}`);

const relay = await sol.solanaRelayStatus({ baseUrl: base });
assert.ok(relay.on && relay.relayer, "the relay is on and names its address");
assert.equal(relay.network, "mainnet");
step(`relay ${relay.relayer} on=${relay.on} funded=${relay.funded}`);

const seed = webcrypto.getRandomValues(new Uint8Array(32));
const wallet = await sol.solanaKeypairWallet(seed);
const account = await sol.openSolanaAccount({ wallet, baseUrl: base });
assert.notEqual(account.address, wallet.address, "the private account is not the main wallet");
step(`opened private account ${account.address} for throwaway wallet ${wallet.address}`);

const balances = await sol.solanaBalances(account);
assert.deepEqual(balances, { sol: 0n, usdc: 0n, usdt: 0n }, "a new account holds nothing");
step(`balances ${JSON.stringify(Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, String(v)])))}`);

assert.equal(await sol.isSolanaAccountRegistered(account), false, "a new account is not registered");
step("not registered");

const wire = await sol.buildSolanaRegistration(account, relay.relayer);
assert.ok(wire instanceof Uint8Array && wire.length > 0, "a registration was built");
const body = sol.solanaRelayRequest(wire);
assert.deepEqual(Object.keys(body), ["tx"]);
assert.equal(Buffer.from(body.tx, "base64").length, wire.length, "the relay gets the exact bytes, base64");

// The relay's own policy, from the app's source (pure, no network).
const appPolicy = join(dirname(fileURLToPath(import.meta.url)), "../../../app/src/lib/solanaRings/relayPolicy.ts");
process.removeAllListeners("warning");
const { checkSponsoredTransaction } = await import(pathToFileURL(appPolicy).href);
const verdict = checkSponsoredTransaction(wire, relay.relayer);
assert.equal(verdict.ok, true, `the relay's policy accepts it: ${verdict.reason ?? ""}`);
assert.equal(verdict.kind, "register");
step("the relay's policy accepts the registration (kind register)");

// What the relay runs before it signs: a simulation, here without its signature.
const rpc = async (method, params) => {
  const res = await fetch(sol.solanaEndpoints(base).rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
};
const sim = await rpc("simulateTransaction", [body.tx, { encoding: "base64", sigVerify: false, commitment: "processed" }]);
assert.equal(sim.value.err, null, `the registration would succeed on chain: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}`);
step(`simulation with the relay as fee payer: ok (${sim.value.unitsConsumed} compute units). Not sent.`);

// A signature Solana never saw, with an expired blockhash, reads dropped (not pending forever).
const fakeSig = sol.base58Encode(webcrypto.getRandomValues(new Uint8Array(64)));
const oldHash = "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn"; // any blockhash older than about 2 minutes
const st = await sol.waitForSolanaTx({ signature: fakeSig, blockhash: oldHash, timeoutMs: 20_000 }, { baseUrl: base });
assert.equal(st.state, "dropped", "an unseen transaction with an expired blockhash is dropped");
const pending = await sol.waitForSolanaTx({ signature: fakeSig, timeoutMs: 3_000 }, { baseUrl: base });
assert.equal(pending.state, "pending", "without a blockhash it stays pending, and the wait still ends at its deadline");
step("status: dropped and pending, each within its deadline");

sol.closeSolanaAccount(account);
console.log(`solana.e2e: ok (mainnet, read only, ${((Date.now() - t0) / 1000).toFixed(1)}s, nothing sent)`);
process.exit(0);
