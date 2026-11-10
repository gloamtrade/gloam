/**
 * Reference wrapper: a payments bot that sends a PRIVATE payment on Gloam using
 * only @gloamtrade/sdk. It shields a note to fund itself, rebuilds the pool tree
 * from chain, then spends that note with a private transfer: no public
 * transfer, no visible amount. The recipient gets a payment note they can later
 * open or cash out; the sender keeps a change note.
 *
 *   # mainnet: shields 2 USDG, pays 1 privately, keeps 1 as change
 *   GLOAM_NETWORK=robinhood-mainnet GLOAM_PAY_KEY=0x... npx tsx examples/pay-bot/pay-bot.ts
 *
 *   # testnet (the default): 0.002 / 0.001 test ETH on Robinhood Chain testnet
 *   GLOAM_PAY_KEY=0x... npx tsx examples/pay-bot/pay-bot.ts
 *
 * GLOAM_NETWORK is robinhood-mainnet, tempo-mainnet, robinhood or tempo (the
 * last two are the testnets). Unset, it stays on Robinhood Chain testnet so
 * nothing real is spent by accident. Optional: GLOAM_ASSET (a symbol the pool
 * lists), GLOAM_RPC (your own RPC URL).
 *
 * The whole private path (shield, sync, send) is @gloamtrade/sdk; viem only
 * signs and reads. Proofs use the key set the chosen network verifies: the
 * final ceremony keys on mainnet, the dev keys on testnet.
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  erc20Abi,
  parseUnits,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  buildShieldBoundIntent,
  buildPrivateSendIntent,
  artifactProver,
  syncTree,
  assertTreeMatchesChain,
  cashOutFee,
  readCashOutFeeBps,
  circuitArtifactFiles,
  circuitArtifactUrls,
  approvalSteps,
  getGloamNetwork,
  gloamNetworks,
  networkName,
  NATIVE_ASSET,
  ELYSIUM_LOG_RANGE_DEFAULT,
  type GloamAsset,
  type GloamNetwork,
  type GloamNetworkKey,
  type PoolCircuit,
  type Prover,
} from "@gloamtrade/sdk";

const shieldBoundAbi = [
  {
    type: "function",
    name: "shieldBound",
    stateMutability: "payable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "commitment", type: "bytes32" },
      { name: "proof", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const transferAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "root", type: "bytes32" },
      { name: "nullifier", type: "bytes32" },
      { name: "newCommitments", type: "bytes32[2]" },
    ],
    outputs: [],
  },
] as const;

// ── network ──────────────────────────────────────────────────────────────────

// Base ("base-mainnet", and "base" for Base Sepolia) and Ethereum ("ethereum-mainnet") work once the SDK has their pools;
// Elysium ("elysium-mainnet") takes USDC, with gas in HYPE.
const NETWORK_KEYS: GloamNetworkKey[] = ["robinhood-mainnet", "tempo-mainnet", "base-mainnet", "ethereum-mainnet", "elysium-mainnet", "robinhood", "tempo", "base"];
const isNative = (a: GloamAsset) => a.address.toLowerCase() === NATIVE_ASSET.toLowerCase();
/** Blocks per getLogs call when reading the pool's tree: Elysium's 100 ms blocks take a wider range than the default. */
const logRange = (net: GloamNetwork) => (net.family === "elysium" ? BigInt(ELYSIUM_LOG_RANGE_DEFAULT) : undefined);

/** The network from GLOAM_NETWORK; Robinhood Chain testnet when unset. */
function pickNetwork(fallback: GloamNetworkKey = "robinhood"): GloamNetwork {
  const key = (process.env.GLOAM_NETWORK?.trim() || fallback) as GloamNetworkKey;
  if (!NETWORK_KEYS.includes(key)) throw new Error(`GLOAM_NETWORK must be one of: ${NETWORK_KEYS.join(", ")}.`);
  const net = getGloamNetwork(key);
  if (!net) {
    const testnets = gloamNetworks().filter((n) => n.testnet).map((n) => n.key);
    throw new Error(
      `This version of @gloamtrade/sdk has no ${key} pool yet. Update the SDK once the pool is published, or practice on testnet with GLOAM_NETWORK=${testnets.join(" or ")}.`
    );
  }
  if (net.testnet) {
    console.log(`${networkName(net.chainId)}. Set GLOAM_NETWORK=${net.family}-mainnet to use mainnet.`);
  } else {
    const first = net.assets[0];
    const cap = first?.depositLimit ? Number(formatUnits(first.depositLimit.perDeposit, first.decimals)).toLocaleString("en-US") : null;
    console.log(`${net.label} mainnet.${cap ? ` Deposit limit: at most ${cap} per stablecoin deposit.` : ""}`);
  }
  return net;
}

/** GLOAM_ASSET (a symbol or address the pool lists) if set, else the pool's first asset: native ETH on Robinhood Chain testnet, else its first stablecoin (USDC on Base). */
function pickAsset(net: GloamNetwork): GloamAsset {
  const want = process.env.GLOAM_ASSET?.trim();
  const asset = want
    ? net.assets.find((a) => [a.symbol, a.address].some((s) => s.toLowerCase() === want.toLowerCase()))
    : net.assets[0]; // native ETH on Robinhood Chain testnet, else the pool's first stablecoin
  if (!asset) {
    throw new Error(`${networkName(net.chainId)} does not take ${want}. Pick one of: ${net.assets.map((a) => a.symbol).join(", ")}.`);
  }
  return asset;
}

// ── circuit files ────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
/** The repo's copy of the circuits: dev keys at the root, the final keys under final/. */
const REPO_CIRCUITS = resolve(here, "../../app/public/circuits");
/** Downloads land here with the same layout, so the dev and final keys never mix. */
const CACHE = process.env.GLOAM_CIRCUITS_CACHE?.trim() || join(homedir(), ".cache", "gloam", "circuits");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * A prover for `circuit` with the keys `net` verifies against (final keys on
 * mainnet, dev keys on testnet). snarkjs proves from local files in node, so
 * each file comes from the repo or the cache, or is downloaded from
 * gloam.trade, and is checked against its SHA-256 before it is used.
 */
async function proverFor(circuit: PoolCircuit, net: GloamNetwork): Promise<Prover> {
  const files = circuitArtifactFiles(circuit, net.ceremony);
  const urls = circuitArtifactUrls(circuit, net.chainId);
  const wasm = await artifact(files.wasm, urls.wasm, files.sha256.wasm);
  const zkey = await artifact(files.zkey, urls.zkey, files.sha256.zkey);
  return artifactProver({ wasm, zkey });
}

async function artifact(rel: string, url: string, expected: string): Promise<string> {
  for (const dir of [REPO_CIRCUITS, CACHE]) {
    const p = join(dir, rel);
    if (existsSync(p) && sha256(readFileSync(p)) === expected) return p;
  }
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${url} (HTTP ${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${url} does not match its published SHA-256. Not proving with it.`);
  const p = join(CACHE, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, bytes);
  return p;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const net = pickNetwork();
  const asset = pickAsset(net);
  const pk = process.env.GLOAM_PAY_KEY;
  if (!pk) throw new Error(`Set GLOAM_PAY_KEY (a key funded on ${networkName(net.chainId)}).`);
  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);
  const rpc = process.env.GLOAM_RPC?.trim() || net.rpcUrl;
  const wallet = createWalletClient({ account, chain: net.chain, transport: http(rpc) });
  const pub = createPublicClient({ chain: net.chain, transport: http(rpc) });

  // Small by default: shield 2 of a stablecoin (0.002 test ETH), pay half, keep the rest as change.
  const fundWei = parseUnits(isNative(asset) ? "0.002" : "2", asset.decimals);
  const payWei = parseUnits(isNative(asset) ? "0.001" : "1", asset.decimals);
  const show = (v: bigint) => `${formatUnits(v, asset.decimals)} ${asset.symbol}`;

  // Fail clearly before proving if the wallet cannot pay.
  if (net.family !== "tempo" && (await pub.getBalance({ address: account.address })) === 0n) {
    throw new Error(`${account.address} has no ${net.chain.nativeCurrency.symbol} for gas on ${networkName(net.chainId)}.`);
  }
  const balance = isNative(asset)
    ? await pub.getBalance({ address: account.address })
    : await pub.readContract({ address: asset.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  if (balance < fundWei) {
    throw new Error(`${account.address} holds ${show(balance)} but needs ${show(fundWei)}.`);
  }

  // ── 1. Shield a note to fund the bot ───────────────────────────────────────
  console.log(`Bot ${account.address} shielding ${show(fundWei)} to fund itself`);
  const shield = await buildShieldBoundIntent({
    chainId: net.chainId,
    poolAddress: net.pool,
    asset: asset.address,
    amountWei: fundWei,
    prover: await proverFor("shield", net),
  });
  console.log("Source note (keep it until the payment settles):");
  console.log("  secret:    ", shield.note.secret);
  console.log("  commitment:", shield.note.commitment);

  // Tokens: let the pool pull the amount, and wait for that to land first.
  if (!isNative(asset)) {
    const allowance = await pub.readContract({
      address: asset.address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, net.pool],
    });
    // Exact amounts; USDT on Ethereum first clears a stale allowance to 0 (approvalSteps).
    for (const value of approvalSteps(net.chainId, asset.address, allowance, fundWei)) {
      const approveHash = await wallet.writeContract({
        address: asset.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [net.pool, value],
      });
      const approved = await pub.waitForTransactionReceipt({ hash: approveHash });
      if (approved.status !== "success") throw new Error("The approval reverted.");
      console.log(`Approved the pool to pull ${show(fundWei)}.`);
    }
  }

  const shieldHash = await wallet.writeContract({
    address: shield.exec.poolAddress,
    abi: shieldBoundAbi,
    functionName: "shieldBound",
    args: shield.exec.args as readonly [`0x${string}`, bigint, `0x${string}`, `0x${string}`],
    value: shield.exec.valueWei,
  });
  const shielded = await pub.waitForTransactionReceipt({ hash: shieldHash });
  if (shielded.status !== "success") {
    throw new Error("The deposit reverted. Check the balance, the approval and the pool's deposit limits.");
  }
  console.log(`Funded: ${net.explorerUrl}/tx/${shieldHash}`);

  // ── 2. Rebuild the tree from chain, get this note's membership path ─────────
  console.log("Syncing the pool tree from chain");
  const synced = await syncTree(pub, { pool: net.pool, fromBlock: net.deployBlock, chunkSize: logRange(net) });
  const matches = await assertTreeMatchesChain(pub, net.pool, synced);
  console.log(`  ${synced.leafCount} leaves, root ${matches ? "matches the chain" : "does not match the chain (a newer deposit may have landed)"}`);
  const path = await synced.pathForCommitment(shield.note.commitment);
  if (!path) throw new Error("Source note not found in the tree yet. Retry in a moment.");

  // ── 3. Build + broadcast the private send ──────────────────────────────────
  console.log(`Sending ${show(payWei)} privately`);
  const send = await buildPrivateSendIntent({
    chainId: net.chainId,
    poolAddress: net.pool,
    secretHex: shield.note.secret,
    amountInWei: fundWei,
    amountPayWei: payWei,
    asset: asset.address,
    path,
    prove: await proverFor("transfer", net),
  });
  const sendHash = await wallet.writeContract({
    address: send.exec.poolAddress,
    abi: transferAbi,
    functionName: "transfer",
    args: send.exec.args as readonly [
      `0x${string}`,
      `0x${string}`,
      `0x${string}`,
      readonly [`0x${string}`, `0x${string}`],
    ],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: sendHash });
  if (receipt.status !== "success") {
    throw new Error("The private send reverted. The source note is unspent; retry with its secret.");
  }

  // ── 4. Hand the payment note to the recipient; keep the change note ─────────
  const paid = BigInt(send.paymentNote.amountWei);
  console.log("\nPrivate payment settled. Nothing about the amount is on the public feed.");
  console.log("Give this PAYMENT NOTE to the recipient (they open or cash it out):");
  console.log("  secret:    ", send.paymentNote.secret);
  console.log("  commitment:", send.paymentNote.commitment);
  console.log("  amount:    ", show(paid));
  if (!net.testnet) {
    const bps = await readCashOutFeeBps(pub, net.pool);
    console.log(`  cashing it out costs ${bps / 100}%: the pool keeps ${show(cashOutFee(paid, bps))} today`);
  }
  console.log("\nKeep this CHANGE NOTE (stays with you):");
  console.log("  secret:    ", send.changeNote.secret);
  console.log("  amount:    ", show(BigInt(send.changeNote.amountWei)));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
