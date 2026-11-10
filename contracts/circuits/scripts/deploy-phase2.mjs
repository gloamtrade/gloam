#!/usr/bin/env node
/**
 * Deploy Phase-2 Poseidon stack to Robinhood testnet:
 *   Poseidon2, Poseidon3, UnshieldVerifier, UnshieldIVerifier, ShieldPoolPoseidon
 *
 * Supports ethers v5 (pulled by circomlibjs) and v6.
 *
 *   export DEPLOYER_PK=0x...
 *   export RPC_URL=https://rpc.testnet.chain.robinhood.com
 *   node scripts/deploy-phase2.mjs
 *
 * Writes ../../deployments/poseidon-testnet.json
 *
 * Sealed swap is SKIPPED by default (audit L-2 / ZK-1, 2026-10-11): the sealed
 * swap verifier is neither deployed nor wired, so the pool keeps
 * sealedSwapVerifier = 0. It must stay off until H1 (solvency accounting) and
 * ZK-1 (rate product wraps the field: amount bits + rate bits must be <= 252,
 * e.g. 96-bit rates in circuit and contract, and one side of the oracle rate
 * fixed to a constant scale) are fixed and a new circuit + ceremony is done.
 * Only then set GLOAM_ACK_SEALED_SWAP_H1_ZK1=1. See script/SealedSwapGuard.sol.
 *
 * NEVER commit DEPLOYER_PK. If you pasted a key in chat, rotate it.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
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
// strip whitespace / newlines (common when pasting)
const pkHex = pkRaw.trim().replace(/^0x/i, "");
if (!/^[0-9a-fA-F]+$/.test(pkHex)) {
  console.error("DEPLOYER_PK must be hex (0-9, a-f).");
  process.exit(1);
}
if (pkHex.length !== 64) {
  console.error(
    `DEPLOYER_PK must be 32 bytes = 64 hex chars (got ${pkHex.length}).\n` +
      "Often the last character got cut off when exporting. Re-set:\n" +
      "  export DEPLOYER_PK=0x + 64 hex characters"
  );
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

// Audit L-2 / ZK-1 guard. Same flag as script/SealedSwapGuard.sol.
const SEALED_SWAP_ACK = process.env.GLOAM_ACK_SEALED_SWAP_H1_ZK1 === "1";

function loadEthers() {
  // Prefer CJS require — works for both v5 and v6 package layouts
  const ethers = require("ethers");
  return ethers.ethers ?? ethers;
}

function isV6(ethers) {
  return typeof ethers.JsonRpcProvider === "function";
}

async function main() {
  const { poseidonContract } = await import("circomlibjs");
  const ethers = loadEthers();
  const v6 = isV6(ethers);

  const provider = v6
    ? new ethers.JsonRpcProvider(RPC)
    : new ethers.providers.JsonRpcProvider(RPC);

  const target = await testnetOrExit(provider);
  const wallet = new ethers.Wallet(pk, provider);
  console.log("network", target.chainId, target.name);
  console.log("ethers", ethers.version || (v6 ? "v6" : "v5"));
  console.log("deployer", wallet.address);

  const bal = await provider.getBalance(wallet.address);
  const balEth = v6
    ? ethers.formatEther(bal)
    : ethers.utils.formatEther(bal);
  console.log("balance", balEth, "ETH");

  // RH testnet reports ~0.01 gwei. ethers v5 otherwise defaults to a ~1.5 gwei
  // priority fee, which (a) overpays ~100x and (b) makes the node cap
  // eth_estimateGas at balance/maxFeePerGas (~2.1M gas here) -> "code storage out
  // of gas" on the Poseidon CREATE. Pin a low legacy gasPrice so estimateGas gets
  // a sane cap and the deploy stays cheap.
  async function computeGasPrice() {
    if (v6) {
      const fd = await provider.getFeeData();
      const gp = (fd.gasPrice ?? fd.maxFeePerGas ?? 0n) * 3n;
      const floor = 20000000n; // 0.02 gwei
      return gp > floor ? gp : floor;
    }
    const gp = (await provider.getGasPrice()).mul(3);
    const floor = ethers.BigNumber.from("20000000"); // 0.02 gwei
    return gp.gt(floor) ? gp : floor;
  }
  const gasPrice = await computeGasPrice();
  const ov = { gasPrice };
  console.log(
    "gasPrice",
    Number(gasPrice.toString()) / 1e9,
    "gwei (legacy, pinned)"
  );

  async function waitDeployed(contract) {
    if (v6) {
      await contract.waitForDeployment();
      return await contract.getAddress();
    }
    await contract.deployed();
    return contract.address;
  }

  async function deployPoseidon(n) {
    const abi = poseidonContract.generateABI(n);
    let bytecode = poseidonContract.createCode(n);
    if (!bytecode.startsWith("0x")) bytecode = `0x${bytecode}`;
    const factory = new ethers.ContractFactory(abi, bytecode, wallet);
    console.log(`deploying Poseidon${n}...`);
    const c = await factory.deploy(ov);
    const addr = await waitDeployed(c);
    console.log(`Poseidon${n}`, addr);
    return addr;
  }

  function loadArtifact(name) {
    // Foundry: out/Contract.sol/Contract.json (preferred) or out/Contract/Contract.json
    const candidates = [
      join(root, "out", `${name}.sol`, `${name}.json`),
      join(root, "out", name, `${name}.json`),
    ];
    const p = candidates.find((c) => existsSync(c));
    if (!p) {
      throw new Error(
        `Missing artifact for ${name}. Tried:\n  ${candidates.join("\n  ")}\nRun: cd contracts && forge build`
      );
    }
    return JSON.parse(readFileSync(p, "utf8"));
  }

  async function deployArtifact(name, args = []) {
    const art = loadArtifact(name);
    const bytecode =
      typeof art.bytecode === "string"
        ? art.bytecode
        : art.bytecode.object;
    const factory = new ethers.ContractFactory(art.abi, bytecode, wallet);
    console.log(`deploying ${name}...`, args);
    const c = await factory.deploy(...args, ov);
    const addr = await waitDeployed(c);
    console.log(name, addr);
    return addr;
  }

  // Resume: reuse already-deployed Poseidon hashers if set
  //   export POSEIDON2=0xcc2d... POSEIDON3=0x3242...
  const poseidon2 =
    process.env.POSEIDON2 || (await deployPoseidon(2));
  const poseidon3 =
    process.env.POSEIDON3 || (await deployPoseidon(3));
  if (process.env.POSEIDON2) console.log("reuse Poseidon2", poseidon2);
  if (process.env.POSEIDON3) console.log("reuse Poseidon3", poseidon3);

  // --- Groth16 verifiers (regenerated on the pot16 dev ceremony, C1/C2 hardening) ---
  const unshieldVerifier = await deployArtifact("UnshieldVerifier");
  const unshieldIVerifier = await deployArtifact("UnshieldIVerifier", [
    unshieldVerifier,
  ]);
  const transferVerifier = await deployArtifact("TransferVerifier");
  const transferIVerifier = await deployArtifact("TransferIVerifier", [
    transferVerifier,
  ]);
  // DualProof routes by public-input length: 5 -> unshield, 4 -> transfer.
  const dualProofVerifier = await deployArtifact("DualProofVerifier", [
    unshieldIVerifier,
    transferIVerifier,
  ]);
  // Sealed swap only with the explicit ack (see header). The SealedSwapVerifier
  // in src is stale vs the circuit (ZK review I-1); regenerate it first.
  let sealedSwapVerifier = null;
  let sealedSwapIVerifier = null;
  if (SEALED_SWAP_ACK) {
    sealedSwapVerifier = await deployArtifact("SealedSwapVerifier");
    sealedSwapIVerifier = await deployArtifact("SealedSwapIVerifier", [
      sealedSwapVerifier,
    ]);
  }
  // Shield verifier (C1 fix): binds commitment <-> (amount, asset) at deposit.
  const shieldVerifier = await deployArtifact("ShieldVerifier");
  const shieldIVerifier = await deployArtifact("ShieldIVerifier", [
    shieldVerifier,
  ]);

  // Pool's main `verifier` = dual-proof router (handles unshield + transfer).
  const pool = await deployArtifact("ShieldPoolPoseidon", [
    poseidon2,
    dualProofVerifier,
  ]);

  // --- Wire the remaining verifiers (onlyOwner; deployer is owner) ---
  const poolAbi = loadArtifact("ShieldPoolPoseidon").abi;
  const poolContract = new ethers.Contract(pool, poolAbi, wallet);

  async function sendTx(promise, label) {
    const tx = await promise;
    console.log(`  ${label} tx`, tx.hash);
    await tx.wait();
  }

  if (SEALED_SWAP_ACK) {
    console.log("wiring sealed-swap verifier (GLOAM_ACK_SEALED_SWAP_H1_ZK1=1)...");
    await sendTx(
      poolContract.setSealedSwapVerifier(sealedSwapIVerifier, ov),
      "setSealedSwapVerifier"
    );
  } else {
    console.log(
      "sealed swap NOT deployed or wired (sealedSwapVerifier stays 0).\n" +
        "  It stays off until H1 and ZK-1 are fixed and a new circuit + ceremony is done."
    );
  }

  // HARDEN_SHIELD gates C1 enforcement. Once set, plain shield() reverts and the
  // app MUST call shieldBound() with a proof. Only flip this on once the app's
  // shieldBound flow is live and pointed at THIS pool. Default: staged (off).
  const hardenShield = process.env.HARDEN_SHIELD === "1";
  if (hardenShield) {
    console.log("hardening shield (C1): setShieldVerifier...");
    await sendTx(
      poolContract.setShieldVerifier(shieldIVerifier, ov),
      "setShieldVerifier"
    );
  } else {
    console.log(
      "shield verifier deployed but NOT wired (staged). To enforce C1 later:\n" +
        `  cast send ${pool} "setShieldVerifier(address)" ${shieldIVerifier} --rpc-url $RPC_URL --private-key $DEPLOYER_PK\n` +
        "  (or re-run with HARDEN_SHIELD=1 once the app's shieldBound flow is live)"
    );
  }

  // FINAL STEP: end setup mode (irreversible). After this the owner has no instant
  // power over proofs, pricing or asset flows: every verifier / rate / oracle
  // setter must be announced with queueChange() and can only run via
  // executeChange() after the 3-day CHANGE_DELAY. There is no emergencyWithdraw.
  // Only done once the shield verifier is wired: ending setup with C1 still open
  // would leave the unbound shield() path live for at least 3 days.
  // Set any swap rates (setSwapRate) BEFORE this if the pool should launch with them.
  let setupEnded = false;
  if (hardenShield) {
    console.log("ending setup mode (timelock all future rule changes)...");
    await sendTx(poolContract.endSetup(ov), "endSetup");
    setupEnded = true;
  } else {
    console.log(
      "WARNING: setup mode still OPEN (owner can change verifiers/rates instantly).\n" +
        "  After wiring the shield verifier, end it (irreversible):\n" +
        `  cast send ${pool} "endSetup()" --rpc-url $RPC_URL --private-key $DEPLOYER_PK`
    );
  }

  const chainId = target.chainId;

  // best-effort deploy block
  let deployBlock = null;
  try {
    deployBlock = await provider.getBlockNumber();
  } catch {
    /* ignore */
  }

  const out = {
    chainId,
    network: target.name,
    rpc: RPC,
    hashScheme: "poseidon",
    proofLayout: 2,
    deployBlock,
    shieldHardened: hardenShield,
    setupEnded,
    contracts: {
      Poseidon2: poseidon2,
      Poseidon3: poseidon3,
      UnshieldVerifier: unshieldVerifier,
      UnshieldIVerifier: unshieldIVerifier,
      TransferVerifier: transferVerifier,
      TransferIVerifier: transferIVerifier,
      DualProofVerifier: dualProofVerifier,
      SealedSwapVerifier: sealedSwapVerifier,
      SealedSwapIVerifier: sealedSwapIVerifier,
      ShieldVerifier: shieldVerifier,
      ShieldIVerifier: shieldIVerifier,
      ShieldPoolPoseidon: pool,
    },
    deployer: wallet.address,
    deployedAt: new Date().toISOString(),
    notes:
      "Hardened Phase-2 Poseidon pool (C1/C2/C3). Verifiers regenerated on the pot16 " +
      "dev ceremony — regenerate with a production multi-party ceremony before mainnet. " +
      "Keccak pool 0x2BD9… is separate.",
  };

  const depDir = join(root, "deployments");
  mkdirSync(depDir, { recursive: true });
  const outPath = join(depDir, "poseidon-testnet.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("wrote", outPath);
  console.log(JSON.stringify(out, null, 2));
  console.log("\nApp env:");
  console.log(`NEXT_PUBLIC_POSEIDON_SHIELD_POOL=${pool}`);
  console.log("NEXT_PUBLIC_HASH_SCHEME=poseidon");
  if (deployBlock != null) {
    console.log(`NEXT_PUBLIC_SHIELD_DEPLOY_BLOCK=${deployBlock}`);
  }
  console.log("\nNext: copy new circuit artifacts into app/public/circuits/,");
  console.log("update app/src/lib/config.ts pool address, then verify shield→prove→unshield.");
  if (SEALED_SWAP_ACK) {
    console.log(
      setupEnded
        ? "Sealed-swap needs at least one rate. Setup is over, so queue it:\n" +
            "  pool.queueChange(abi.encodeCall(setSwapRate,(assetIn, assetOut, rateIn, rateOut, true)))\n" +
            "  then pool.executeChange(<same bytes>) after 3 days."
        : "Sealed-swap needs at least one rate: pool.setSwapRate(assetIn, assetOut, rateIn, rateOut, true) (setup mode only)."
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
