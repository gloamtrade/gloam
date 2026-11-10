#!/usr/bin/env node
/**
 * Deploy TransferVerifier + TransferIVerifier + DualProofVerifier,
 * then setVerifier on the Poseidon pool (owner only).
 *
 *   export DEPLOYER_PK=0x...
 *   export RPC_URL=https://rpc.testnet.chain.robinhood.com
 *   # defaults from poseidon-testnet.json if present
 *   export POOL=0xA488...
 *   export UNSHIELD_I_VERIFIER=0xa40e...
 *   node scripts/deploy-transfer.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");

const RPC = process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const pkRaw = process.env.DEPLOYER_PK;
if (!pkRaw) {
  console.error("Set DEPLOYER_PK");
  process.exit(1);
}
const pkHex = pkRaw.trim().replace(/^0x/i, "");
if (pkHex.length !== 64) {
  console.error(`DEPLOYER_PK must be 64 hex chars (got ${pkHex.length})`);
  process.exit(1);
}
const pk = `0x${pkHex}`;

// Testnet only. This script deploys the dev-key Poseidon stack and writes
// deployments/poseidon-testnet.json; mainnet vaults go through the forge scripts
// (DEPLOY*.md). It checks the chain id the RPC reports before anything is sent.
const TESTNET_CHAINS = new Map([
  [46630, "Robinhood Chain Testnet"],
  [42431, "Tempo Testnet (Moderato)"],
]);

async function testnetOrExit(provider) {
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  if (!TESTNET_CHAINS.has(chainId)) {
    console.error(
      `RPC_URL is on chain ${chainId}, which is not a testnet this script deploys to ` +
        `(${[...TESTNET_CHAINS].map(([id, name]) => `${id} ${name}`).join(", ")}). Nothing was sent.`
    );
    process.exit(1);
  }
  return { chainId, name: TESTNET_CHAINS.get(chainId) };
}

function loadEthers() {
  const ethers = require("ethers");
  return ethers.ethers ?? ethers;
}

async function main() {
  const ethers = loadEthers();
  const v6 = typeof ethers.JsonRpcProvider === "function";
  const provider = v6
    ? new ethers.JsonRpcProvider(RPC)
    : new ethers.providers.JsonRpcProvider(RPC);
  const target = await testnetOrExit(provider);
  const wallet = new ethers.Wallet(pk, provider);
  console.log("network", target.chainId, target.name);
  console.log("deployer", wallet.address);

  let pool = process.env.POOL;
  let unshieldI = process.env.UNSHIELD_I_VERIFIER;
  const depPath = join(root, "deployments/poseidon-testnet.json");
  if (existsSync(depPath)) {
    const dep = JSON.parse(readFileSync(depPath, "utf8"));
    pool = pool || dep.contracts.ShieldPoolPoseidon;
    unshieldI = unshieldI || dep.contracts.UnshieldIVerifier;
  }
  if (!pool || !unshieldI) {
    console.error("Set POOL and UNSHIELD_I_VERIFIER (or poseidon-testnet.json)");
    process.exit(1);
  }

  function loadArtifact(name) {
    const candidates = [
      join(root, "out", `${name}.sol`, `${name}.json`),
      join(root, "out", name, `${name}.json`),
    ];
    const p = candidates.find((c) => existsSync(c));
    if (!p) throw new Error(`Missing artifact ${name} — forge build`);
    return JSON.parse(readFileSync(p, "utf8"));
  }

  async function waitDeployed(c) {
    if (v6) {
      await c.waitForDeployment();
      return await c.getAddress();
    }
    await c.deployed();
    return c.address;
  }

  async function deploy(name, args = []) {
    const art = loadArtifact(name);
    const bytecode =
      typeof art.bytecode === "string" ? art.bytecode : art.bytecode.object;
    const factory = new ethers.ContractFactory(art.abi, bytecode, wallet);
    console.log("deploying", name, args);
    const c = await factory.deploy(...args);
    const addr = await waitDeployed(c);
    console.log(name, addr);
    return addr;
  }

  const transferVerifier = await deploy("TransferVerifier");
  const transferI = await deploy("TransferIVerifier", [transferVerifier]);
  const dual = await deploy("DualProofVerifier", [unshieldI, transferI]);

  // setVerifier on pool. Pools past endSetup() only accept it through the
  // timelock: queue now, executeChange(<same bytes>) after the 3-day delay.
  // Pre-timelock pool bytecode has no setupMode(); treat that as direct-set.
  const poolArt = loadArtifact("ShieldPoolPoseidon");
  const poolC = new ethers.Contract(pool, poolArt.abi, wallet);
  let inSetup = true;
  try {
    inSetup = await poolC.setupMode();
  } catch {
    inSetup = true;
  }
  if (inSetup) {
    console.log("setVerifier", dual, "on", pool);
    const tx = await poolC.setVerifier(dual);
    await tx.wait();
    console.log("setVerifier tx", tx.hash);
  } else {
    const iface = v6
      ? new ethers.Interface(poolArt.abi)
      : new ethers.utils.Interface(poolArt.abi);
    const call = iface.encodeFunctionData("setVerifier", [dual]);
    console.log("pool setup has ended: queueing setVerifier", dual, "on", pool);
    const tx = await poolC.queueChange(call);
    await tx.wait();
    console.log("queueChange tx", tx.hash);
    console.log("After 3 days (and within 14 more), run:");
    console.log(`  cast send ${pool} "executeChange(bytes)" ${call} --rpc-url $RPC_URL --private-key $DEPLOYER_PK`);
  }

  // update deployment json
  const dep = existsSync(depPath)
    ? JSON.parse(readFileSync(depPath, "utf8"))
    : { contracts: {} };
  dep.contracts.TransferVerifier = transferVerifier;
  dep.contracts.TransferIVerifier = transferI;
  dep.contracts.DualProofVerifier = dual;
  dep.contracts.ShieldPoolPoseidon = pool;
  dep.privateSend = true;
  dep.updatedAt = new Date().toISOString();
  writeFileSync(depPath, JSON.stringify(dep, null, 2));
  console.log("updated", depPath);
  console.log(JSON.stringify(dep.contracts, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
