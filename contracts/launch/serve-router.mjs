// Serves the router deploy page on http://127.0.0.1:4732/router so a wallet
// extension can inject into it. Run a plain `forge build` first (no --evm-version:
// the routers deploy as the repo's foundry.toml builds them), then, from contracts/:
//   node launch/serve-router.mjs
//
// /router           router.html
// /router/expected  per chain, what the page may sign and what it must read back:
//                   the factory call, the address it lands at and the runtime code,
//                   all worked out from this checkout's own compile and refused
//                   unless they match test/fixtures/router-next.json. The page takes
//                   no address, code or RPC from a person or a link.
//
// Its own port, so it runs next to the other signing pages (serve.mjs 4730, serve-guard.mjs 4731).
// Uses `cast` for keccak256 and ABI encoding. ROUTER_RPC_<chainId> points a chain at
// another RPC, for a rehearsal on a local fork; the page says so when one is set.
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

// The same constants as script/DeployVaultSwapV4c.s.sol.
const VAULT = "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194";
const TREASURY = "0xB3900ac9350903218e4c7597bAb0f008F01B30B8";
const OWNER = "0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8";
const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const SALT_TEXT = "gloam.vault-swap.v3";
const TEMPO_DEX = "0xDEc0000000000000000000000000000000000000";
const NETWORKS = {
  4663: { chainName: "Robinhood Chain", rpc: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robin.etherscan.io", symbol: "ETH", native: "Ether" },
  8453: { chainName: "Base", rpc: "https://mainnet.base.org", explorer: "https://basescan.org", symbol: "ETH", native: "Ether" },
  1: { chainName: "Ethereum", rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io", symbol: "ETH", native: "Ether" },
  4217: { chainName: "Tempo", rpc: "https://rpc.tempo.xyz", explorer: "https://explore.tempo.xyz", symbol: "USD", native: "US Dollar" },
};

const page = new URL("./router.html", import.meta.url);
const fixtureUrl = new URL("../test/fixtures/router-next.json", import.meta.url);
const artifactUrl = (name) => new URL(`../out/${name}.sol/${name}.json`, import.meta.url);
const strip = (hex) => hex.replace(/^0x/, "");
const word = (hex) => strip(hex).toLowerCase().padStart(64, "0");
const cast = (args) =>
  execFileSync(process.env.CAST ?? `${homedir()}/.foundry/bin/cast`, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" },
  }).trim();
const keccak = (hexOrText) => cast(["keccak", hexOrText]);

/** The compiled runtime code with the immutables written in, in declaration order (the AST ids ascend). */
function runtimeOf(deployedBytecode, values) {
  let code = strip(deployedBytecode.object);
  const ids = Object.keys(deployedBytecode.immutableReferences).sort((a, b) => Number(a) - Number(b));
  if (ids.length !== values.length) throw new Error(`expected ${values.length} immutables, found ${ids.length}`);
  ids.forEach((id, i) => {
    for (const { start, length } of deployedBytecode.immutableReferences[id]) {
      if (length !== 32) throw new Error("unexpected immutable size");
      code = code.slice(0, start * 2) + word(values[i]) + code.slice((start + length) * 2);
    }
  });
  return "0x" + code;
}

/** escrowFor() for a fixed sample swap, and what it must answer: proves the router hashes keys and holds SwapEscrow2 as the app does. */
function escrowSample(address, escrowInit) {
  const zero = "0x" + "00".repeat(32);
  const one = "0x" + "11".repeat(32);
  const key = `(${one},1000,${one},${TREASURY},1000,${one},990,${zero},${OWNER},1800)`;
  const data = cast(["calldata", "escrowFor(address,(bytes32,uint256,bytes32,address,uint256,bytes32,uint256,bytes32,address,uint256))", TREASURY, key]);
  const salt = keccak(cast(["abi-encode", "f((bytes32,uint256,bytes32,address,uint256,bytes32,uint256,bytes32,address,uint256))", key]));
  const codeHash = keccak("0x" + strip(escrowInit) + word(TREASURY));
  const out = keccak("0xff" + strip(address) + strip(salt) + strip(codeHash));
  return { data, answer: "0x" + out.slice(-40).toLowerCase() };
}

async function expected() {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const v4 = JSON.parse(await readFile(artifactUrl("GloamVaultSwapV4c"), "utf8"));
  const tempo = JSON.parse(await readFile(artifactUrl("GloamVaultSwapTempo2"), "utf8"));
  const escrow = JSON.parse(await readFile(artifactUrl("SwapEscrow2"), "utf8"));
  const escrowInit = escrow.bytecode.object;
  if (keccak(escrowInit).toLowerCase() !== fixture.escrowCodeHash.toLowerCase()) {
    throw new Error("SwapEscrow2 in out/ is not the pinned one. Run a plain `forge build` and reload.");
  }
  const salt = keccak(SALT_TEXT);
  const chains = {};
  for (const [id, c] of Object.entries(fixture.chains)) {
    let args, runtime;
    if (c.venue === "tempo") {
      args = cast(["abi-encode", "constructor(address,address,address)", VAULT, TREASURY, TEMPO_DEX]);
      runtime = runtimeOf(tempo.deployedBytecode, [VAULT, TREASURY, TEMPO_DEX]);
    } else {
      const list = "[" + c.pools.map((p) => `(${p.currency0},${p.currency1},${p.fee},${p.tickSpacing},${p.hooks})`).join(",") + "]";
      args = cast(["abi-encode", "constructor(address,address,address,address,address,(address,address,uint24,int24,address)[])", VAULT, TREASURY, c.poolManager, c.weth, OWNER, list]);
      runtime = runtimeOf(v4.deployedBytecode, [VAULT, TREASURY, c.poolManager, c.weth]);
    }
    const initCode = strip((c.venue === "tempo" ? tempo : v4).bytecode.object) + strip(args);
    const initHash = keccak("0x" + initCode);
    const address = "0x" + keccak("0xff" + strip(FACTORY) + strip(salt) + strip(initHash)).slice(-40);
    if (address.toLowerCase() !== c.address.toLowerCase()) {
      throw new Error(`${c.name}: this compile lands at ${address}, the fixture says ${c.address}. Run a plain \`forge build\`, and launch/router-fixture.mjs if the contracts changed, then reload.`);
    }
    const net = NETWORKS[id];
    const override = process.env[`ROUTER_RPC_${id}`];
    chains[id] = {
      ...net,
      rpc: override ?? net.rpc,
      rehearsal: Boolean(override),
      venue: c.venue,
      address: address.toLowerCase(),
      factory: FACTORY.toLowerCase(),
      data: "0x" + strip(salt) + initCode,
      initHash,
      runtime: runtime.toLowerCase(),
      poolIds: c.poolIds ?? [],
      poolManager: c.poolManager ?? null,
      weth: c.weth ?? null,
      dex: c.venue === "tempo" ? TEMPO_DEX : null,
      escrowSample: escrowSample(address, escrowInit),
    };
  }
  return { owner: OWNER.toLowerCase(), vault: VAULT.toLowerCase(), treasury: TREASURY.toLowerCase(), chains };
}

createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname.replace(/\/$/, "") || "/";
  try {
    if (path === "/router") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(await readFile(page));
    }
    if (path === "/router/expected") {
      const body = JSON.stringify(await expected());
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(body);
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found. Try /router");
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e?.message ?? e));
  }
}).listen(Number(process.env.PORT) || 4732, "127.0.0.1", () => console.log("router deploy page up: http://127.0.0.1:4732/router"));
