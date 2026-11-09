// Writes test/fixtures/router-next.json from the deploy script and this checkout's
// compile: each chain's pool list and the address its router lands at. Reads only,
// no key, nothing sent. Run it after any change to the router's contracts or the
// pool lists, from contracts/:
//   forge build && node launch/router-fixture.mjs
// Uses forge and cast. test_v3_predicted_addresses_are_pinned fails until it has run.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const bin = (n) => process.env[n.toUpperCase()] ?? `${homedir()}/.foundry/bin/${n}`;
const env = { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" };
const run = (tool, args) => execFileSync(bin(tool), args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim();
const SCRIPT = "script/DeployVaultSwapV4c.s.sol:DeployVaultSwapV4c";
const call = (sig, arg) => {
  const out = run("forge", ["script", SCRIPT, "--sig", sig, String(arg), "--json"]);
  return JSON.parse(out.split("\n").filter((l) => l.startsWith("{")).pop()).returns;
};
const CHAINS = [
  [4663, "Robinhood Chain"],
  [8453, "Base"],
  [1, "Ethereum"],
  [4217, "Tempo"],
];
const parsePools = (text) =>
  [...text.matchAll(/\((0x[0-9a-fA-F]{40}), (0x[0-9a-fA-F]{40}), (\d+)[^,]*, (-?\d+)[^,]*, (0x[0-9a-fA-F]{40})\)/g)].map((m) => ({
    currency0: m[1],
    currency1: m[2],
    fee: Number(m[3]),
    tickSpacing: Number(m[4]),
    hooks: m[5],
  }));
const poolId = (k) =>
  run("cast", ["keccak", run("cast", ["abi-encode", "f(address,address,uint24,int24,address)", k.currency0, k.currency1, String(k.fee), String(k.tickSpacing), k.hooks])]);

const path = new URL("../test/fixtures/router-next.json", import.meta.url);
const old = JSON.parse(readFileSync(path, "utf8"));
const chains = {};
for (const [id, name] of CHAINS) {
  const address = Object.values(call("predicted(uint256)", id))[0].value;
  if (id === 4217) {
    chains[id] = { name, venue: "tempo", address };
    continue;
  }
  const r = call("config(uint256)", id);
  const [poolManager, weth] = [r.poolManager.value, r.weth.value];
  const pools = parsePools(r.pools.value);
  chains[id] = { name, venue: "v4", address, poolManager, weth, poolIds: pools.map(poolId), pools };
  console.log(`${name}: ${pools.length} pools, ${address}`);
}
// SwapEscrow2's creation code, as this checkout compiles it: every v3 escrow address hangs on it
const escrow = JSON.parse(readFileSync(new URL("../out/SwapEscrow2.sol/SwapEscrow2.json", import.meta.url), "utf8")).bytecode.object;
const escrowCodeHash = run("cast", ["keccak", escrow]);
if (escrowCodeHash !== old.escrowCodeHash) console.log(`SwapEscrow2 code hash: ${escrowCodeHash}`);
writeFileSync(path, JSON.stringify({ note: old.note, escrowCodeHash, chains }, null, 2) + "\n");
