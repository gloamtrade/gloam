/**
 * Self-test: @gloamtrade/sdk's Starknet module is the Gloam app's, byte for
 * byte, so an agent or server opens the same private account a person opens
 * in the app, and a claim link made by one claims in the other.
 *
 *  - the facts: the canonical pool and its class, USDC, the account class, the
 *    UDC, STRK, the chain ids and the devnet token, as lib/starknetPrivacy/config
 *    has them
 *  - the account layer (lib/starknetPrivacy/account): the message for several
 *    indexes; seeds from EVM (65 bytes, every v and s form) and Solana (64
 *    bytes) signatures and from a Gloam wallet's root (passkey and code); the
 *    keys and address from many seeds and indexes; the canonical viewing key;
 *    the deploy call
 *  - claim links (lib/starknetPrivacy/claimLink): bodies both ways on every
 *    network, the link URL, the fragment test and the link's seed
 *  - what the SDK sends passes the app's relay policy: its deploy call is a
 *    deploy of that account, and its approve has the shape the relay signs for
 *  - the SDK's root export carries the facts with no dependency on starknet.js
 *
 * No network. Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-starknet-sdk.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { num } from "starknet";

for (const k of Object.keys(process.env)) if (k.startsWith("NEXT_PUBLIC_STARKNET_") || k === "STARKNET_PROVER_URL") delete process.env[k];
globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-starknet-sdk: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const config = await import("../src/lib/starknetPrivacy/config");
const account = await import("../src/lib/starknetPrivacy/account");
const link = await import("../src/lib/starknetPrivacy/claimLink");
const actions = await import("../src/lib/starknetPrivacy/actions");
const policy = await import("../src/lib/starknetPrivacy/relayPolicy");
const sdk = await import("@gloamtrade/sdk/starknet");
const root = await import("@gloamtrade/sdk");

let pass = 0;
const ok = (c: unknown, msg: string) => {
  assert.ok(c, msg);
  pass++;
};
const eq = <T,>(a: T, b: T, msg: string) => {
  assert.deepEqual(a, b, msg);
  pass++;
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 17 + 5) & 0xff);

// ---------------------------------------------------------------- the facts
const main = config.starknetConfig("mainnet", {});
eq(sdk.STARKNET_MAINNET_POOL, config.STARKNET_MAINNET_POOL, "the canonical pool");
eq(sdk.STARKNET_MAINNET_POOL_CLASS_HASH, config.STARKNET_MAINNET_POOL_CLASS_HASH, "its class");
eq(sdk.STARKNET_ACCOUNT_CLASS_HASH, config.STARKNET_ACCOUNT_CLASS_HASH, "the account class");
eq([sdk.STARKNET_UDC, sdk.STARKNET_UDC_ENTRYPOINT, sdk.STARKNET_STRK], [config.STARKNET_UDC, config.STARKNET_UDC_ENTRYPOINT, config.STARKNET_STRK], "the UDC and STRK");
eq(sdk.STARKNET_CHAIN_IDS, config.STARKNET_CHAIN_IDS, "the chain ids");
eq(
  sdk.STARKNET_ASSETS.mainnet.map((a) => [a.symbol, a.address, a.decimals]),
  main.tokens.map((t) => [t.symbol, t.address, t.decimals]),
  "mainnet's listed token"
);
const dev = config.starknetConfig("devnet", {});
eq(
  sdk.STARKNET_ASSETS.devnet.map((a) => [a.symbol, a.address, a.decimals]),
  dev.tokens.map((t) => [t.symbol, t.address, t.decimals]),
  "devnet's test token"
);
eq(sdk.starknetEndpoints("https://x.test"), {
  rpc: `https://x.test${config.STARKNET_PROXY_PATHS.rpc}`,
  prove: `https://x.test${config.STARKNET_PROXY_PATHS.prove}`,
  relay: `https://x.test${config.STARKNET_PROXY_PATHS.relay}`,
  discovery: `https://x.test${config.STARKNET_PROXY_PATHS.discovery}`,
}, "the routes");
ok(main.discovery.kind === "indexer" && dev.discovery.kind === "contract", "mainnet finds notes through the hosted service, a devnet reads the pool (as the SDK wires them)");

// ---------------------------------------------------------------- the account layer
for (const i of [0, 1, 7, 1_000_000]) eq(sdk.starknetAccountMessage(i), account.starknetAccountMessage(i), `the message for account ${i}`);
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
for (let k = 0; k < 6; k++) {
  const sig = bytes(65, k);
  sig[64] = [27, 28, 0, 1, 27, 28][k]!;
  if (k >= 4) {
    // the high-s twin
    const s = BigInt("0x" + hex(sig.subarray(32, 64))) % N;
    sig.set(Buffer.from(((N - (s === 0n ? 1n : s)) % N).toString(16).padStart(64, "0"), "hex"), 32);
  }
  const h = "0x" + hex(sig);
  eq(hex(sdk.starknetEvmSignatureBytes(h)), hex(account.evmSignatureBytes(h)), `an EVM signature reads the same (${k})`);
  const norm = account.evmSignatureBytes(h);
  for (const i of [0, 3]) eq(hex(await sdk.starknetSeedFromWalletSignature(norm, i)), hex(await account.seedFromWalletSignature(norm, i)), `seed from an EVM signature, account ${i} (${k})`);
}
{
  const sol = bytes(64, 9);
  eq(hex(await sdk.starknetSeedFromWalletSignature(sol, 0)), hex(await account.seedFromWalletSignature(sol, 0)), "seed from a Solana wallet's signature");
  for (const kind of ["passkey", "code"] as const) {
    for (const i of [0, 2]) eq(hex(await sdk.starknetSeedFromGloamRoot(bytes(32, 3), kind, i)), hex(await account.seedFromGloamRoot(bytes(32, 3), kind, i)), `seed from a Gloam root (${kind}, ${i})`);
  }
}
for (let k = 0; k < 12; k++) {
  const seed = bytes(k % 2 ? 32 : 48, k);
  const i = k % 3;
  const a = await sdk.starknetAccountKeys(seed, i);
  const b = await account.keysFromSeed(seed, i);
  eq([a.accountKey, a.publicKey, a.viewingKey, a.address], [b.accountKey, b.publicKey, b.viewingKey, b.address], `keys and address from a seed (${k}, account ${i})`);
  eq(sdk.starknetDeployAccountCall(a.publicKey), account.deployAccountCall(b.publicKey), `the deploy call (${k})`);
}
for (const v of [1n, 2n, 1n << 250n, (1n << 252n) - 5n, 0n]) eq(sdk.canonicalStarknetViewingKey(v), account.canonicalViewingKey(v), `canonical viewing key ${num.toHex(v)}`);
{
  const alice = await sdk.starknetAccountKeys(new TextEncoder().encode("fake-gloam-seed-alice"), 0);
  eq(alice.address, "0x68b843b246348a56c37e5b4f485ae3cc0df3d6f6ab80f8d89406a70780ee656", "the devnet spike's address");
}

// ---------------------------------------------------------------- claim links
for (const network of ["mainnet", "sepolia", "devnet"] as const) {
  for (const amount of [0n, 1n, 1_250_000n, (1n << 64n) - 1n]) {
    const c = { network, token: 0, amount, secret: bytes(16, Number(amount % 97n)) };
    const body = sdk.starknetClaimBody(c);
    eq(body, link.claimBody(c), `a link body (${network}, ${amount})`);
    const back = link.readClaimBody(body);
    const sback = sdk.readStarknetClaimBody(body);
    ok(back && sback && back.network === sback.network && back.amount === sback.amount && hex(back.secret) === hex(sback.secret), `it reads back the same (${network}, ${amount})`);
    eq(sdk.starknetClaimLinkUrl(c), link.claimLinkUrl(c), `the link URL (${network})`);
    eq(sdk.isStarknetClaimHash(`#sn=${body}`), link.isStarknetClaimHash(`#sn=${body}`), "the fragment test");
    eq(sdk.starknetClaimFromLink(link.claimLinkUrl(c))?.amount, link.claimFromHash(new URL(link.claimLinkUrl(c)).hash)?.amount, "a pasted link reads");
  }
}
for (let k = 0; k < 4; k++) eq(hex(await sdk.starknetClaimSeed(bytes(16, k))), hex(await link.claimSeed(bytes(16, k))), `a link's seed (${k})`);
{
  // Leading zero bytes survive base58 both ways (a secret or amount can start the body with zeros).
  const z = { network: "mainnet" as const, token: 0, amount: 0n, secret: new Uint8Array(16) };
  eq(sdk.starknetClaimBody(z), link.claimBody(z), "a body of zeros");
  eq(sdk.readStarknetClaimBody("1111") === null, link.readClaimBody("1111") === null, "a short run of ones is refused by both");
}
{
  const linkKeys = await sdk.starknetAccountKeys(await sdk.starknetClaimSeed(bytes(16, 1)), 0);
  const appKeys = await account.keysFromSeed(await link.claimSeed(bytes(16, 1)), 0);
  eq(linkKeys.address, appKeys.address, "a link's one-time account is the same account in both");
}

// ---------------------------------------------------------------- what the SDK sends passes the relay's policy
{
  const cfg = { ...main, pool: config.STARKNET_MAINNET_POOL };
  const keys = await sdk.starknetAccountKeys(bytes(32, 4), 0);
  const ctx = { cfg, relay: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd", now: Math.floor(Date.now() / 1000), maxApprove: { [num.toHex(BigInt(main.tokens[0]!.address))]: 10_000_000_000n } };
  const d = policy.checkRelayCall([sdk.starknetDeployAccountCall(keys.publicKey)], ctx);
  ok(d.ok && d.kind === "deploy" && d.publicKey === keys.publicKey, "the SDK's deploy is one the relay sends");
  eq(account.accountAddress((d as { publicKey: string }).publicKey), keys.address, "and deploys the SDK's address");
  eq(sdk.starknetApproveCall(main.tokens[0]!.address, cfg.pool, 5_000_000n), actions.approveCall(main.tokens[0]!.address, cfg.pool, 5_000_000n), "the approve the add signs is the app's");
}

// ---------------------------------------------------------------- the root export needs no starknet.js
{
  ok(typeof root.starknetNetworkInfo === "function" && root.STARKNET_MAINNET_POOL === config.STARKNET_MAINNET_POOL, "the facts are in the SDK's root export");
  const src = readFileSync(new URL("../../packages/sdk/src/starknetInfo.ts", import.meta.url), "utf8");
  ok(!/from "starknet"|@starkware-libs/.test(src), "the root facts import neither starknet.js nor the privacy SDK");
  const app = readFileSync(new URL("../src/lib/starknetPrivacy/account.ts", import.meta.url), "utf8");
  for (const salt of ["gloam/starknet-account/v1", "gloam/starknet-account/root/v1"]) ok(app.includes(`"${salt}"`) && src.includes(`"${salt}"`), `both use the salt ${salt}`);
}

console.log(`selftest-starknet-sdk: ok (${pass} checks)`);
