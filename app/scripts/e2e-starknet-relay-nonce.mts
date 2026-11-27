/**
 * End to end on a local starknet-devnet: Gloam's relay sending for several
 * people at the same moment. The relay is one Starknet account, so every send
 * takes the next nonce; on Vercel each request can run on its own instance, so
 * two sends at once used to read the same nonce and the second was refused
 * (a wasted proof when it carried one). lib/starknetPrivacy/server's relaySend
 * now sends one at a time under a shared lock, and waits until the node counts
 * each send before the next one reads the nonce.
 *
 * Runs the server's own relaySend and relayChain (no route, no prover): six
 * account deploys fired at once, each from a fresh key. Every one must be sent,
 * land, and get its own nonce.
 *
 * Local only (not in CI). Needs starknet-devnet 0.10.1 on PATH (or
 * STARKNET_DEVNET_BIN). Run from app/:
 *   ../mcp/node_modules/.bin/tsx scripts/e2e-starknet-relay-nonce.mts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { ec, num } from "starknet";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const PORT = Number(process.env.STARKNET_DEVNET_PORT ?? 5111);
const URL_ = `http://127.0.0.1:${PORT}`;
const N = Number(process.env.SENDS ?? 6);
const env = process.env as Record<string, string | undefined>;
delete env.UPSTASH_REDIS_REST_URL;
delete env.UPSTASH_REDIS_REST_TOKEN;

const log = (...a: unknown[]) => console.log("[e2e-starknet-relay-nonce]", ...a);
const rpc = (method: string, params: unknown = []) =>
  fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json() as Promise<{ result: unknown }>);

const devnet = spawn(
  process.env.STARKNET_DEVNET_BIN ?? "starknet-devnet",
  ["--lite-mode", "--seed", "42", "--block-generation-on", "transaction", "--chain-id", "SN_DEVNET", "--proof-mode", "none", "--port", String(PORT)],
  { stdio: ["ignore", "ignore", "inherit"] }
);
const stop = () => {
  if (devnet.exitCode === null) devnet.kill("SIGINT");
};
process.on("exit", stop);

async function main() {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${URL_}/is_alive`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 100) throw new Error("starknet-devnet did not start.");
    await new Promise((r) => setTimeout(r, 100));
  }
  const { starknetConfig } = await import("../src/lib/starknetPrivacy/config");
  const server = await import("../src/lib/starknetPrivacy/server");
  const { deployAccountCall, accountAddress } = await import("../src/lib/starknetPrivacy/account");
  const pre = (await rpc("devnet_getPredeployedAccounts")).result as { address: string; private_key: string }[];
  // devnet's own throwaway account (seed 42) stands in for the relay.
  const keys = { address: num.toHex(BigInt(pre[2]!.address)), secret: pre[2]!.private_key };
  const cfg = starknetConfig("devnet", { NEXT_PUBLIC_STARKNET_DEVNET_RPC: URL_, NEXT_PUBLIC_STARKNET_POOL: "0x1" });
  const nonce = async () => BigInt((await rpc("starknet_getNonce", ["latest", keys.address])).result as string);
  const before = await nonce();

  const pubs = Array.from({ length: N }, (_, i) => ec.starkCurve.getStarkKey(num.toHex(BigInt(Date.now()) * 1000n + BigInt(i + 1))));
  // Each request makes its own chain, as each route call does.
  const results = await Promise.all(
    pubs.map((p) =>
      server.relaySend({ calls: [deployAccountCall(p, cfg.accountClassHash)], cfg, relay: keys.address, chain: server.relayChain(URL_, keys), env, rate: async () => "ok" })
    )
  );
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) log("refused:", r.ok ? "" : `${r.code} ${r.message}`);
  assert.equal(failed.length, 0, `${failed.length} of ${N} sends at once were refused`);
  for (const p of pubs) assert.ok(await rpc("starknet_getClassHashAt", ["latest", accountAddress(p, cfg.accountClassHash)]).then((r) => typeof r.result === "string"), "each account landed");
  assert.equal(await nonce(), before + BigInt(N), "the relay used one nonce per send, none twice");
  log(`PASS: ${N} sends at once, ${N} landed`);
}

main()
  .then(() => {
    stop();
    process.exit(0);
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    stop();
    process.exit(1);
  });
