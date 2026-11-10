/**
 * Reference wrapper: an autonomous agent that shields money PRIVATELY on Gloam,
 * using only @gloamtrade/sdk for the private path. It mints a note, generates
 * the zero-knowledge shield proof, and deposits via shieldBound(). This is the
 * smallest end-to-end example of an app or agent plugging into Gloam.
 *
 *   # mainnet: 1 USDG on Robinhood Chain (or 1 USDC.e on Tempo)
 *   GLOAM_NETWORK=robinhood-mainnet GLOAM_AGENT_PRIVATE_KEY=0x... \
 *     npx tsx examples/agent-shield/agent-shield.ts
 *
 *   # testnet (the default): 0.001 test ETH on Robinhood Chain testnet
 *   GLOAM_AGENT_PRIVATE_KEY=0x... npx tsx examples/agent-shield/agent-shield.ts
 *
 * GLOAM_NETWORK is robinhood-mainnet, tempo-mainnet, robinhood or tempo (the
 * last two are the testnets). Unset, it stays on Robinhood Chain testnet so
 * nothing real is spent by accident. Optional: GLOAM_ASSET (a symbol the pool
 * lists, e.g. GLOAM), GLOAM_RPC (your own RPC URL).
 *
 * Proofs use the key set the chosen network verifies: the final ceremony keys
 * on mainnet, the dev keys on testnet. Persist note.secret from the output: it
 * is the only way to spend the balance later.
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
  artifactProver,
  circuitArtifactFiles,
  circuitArtifactUrls,
  approvalSteps,
  getGloamNetwork,
  gloamNetworks,
  networkName,
  NATIVE_ASSET,
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

// ── network ──────────────────────────────────────────────────────────────────

// Base ("base-mainnet", and "base" for Base Sepolia) and Ethereum ("ethereum-mainnet") work once the SDK has their pools;
// Elysium ("elysium-mainnet") takes USDC, with gas in HYPE.
const NETWORK_KEYS: GloamNetworkKey[] = ["robinhood-mainnet", "tempo-mainnet", "base-mainnet", "ethereum-mainnet", "elysium-mainnet", "robinhood", "tempo", "base"];
const isNative = (a: GloamAsset) => a.address.toLowerCase() === NATIVE_ASSET.toLowerCase();

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
  const pk = process.env.GLOAM_AGENT_PRIVATE_KEY;
  if (!pk) throw new Error(`Set GLOAM_AGENT_PRIVATE_KEY (a key funded on ${networkName(net.chainId)}).`);
  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);
  const rpc = process.env.GLOAM_RPC?.trim() || net.rpcUrl;
  const wallet = createWalletClient({ account, chain: net.chain, transport: http(rpc) });
  const pub = createPublicClient({ chain: net.chain, transport: http(rpc) });

  // Small by default: 1 of a stablecoin (or 1 GLOAM), 0.001 test ETH.
  const amountWei = parseUnits(isNative(asset) ? "0.001" : "1", asset.decimals);
  const show = (v: bigint) => `${formatUnits(v, asset.decimals)} ${asset.symbol}`;

  // Fail clearly before proving if the wallet cannot pay.
  if (net.family !== "tempo" && (await pub.getBalance({ address: account.address })) === 0n) {
    throw new Error(`${account.address} has no ${net.chain.nativeCurrency.symbol} for gas on ${networkName(net.chainId)}.`);
  }
  const balance = isNative(asset)
    ? await pub.getBalance({ address: account.address })
    : await pub.readContract({ address: asset.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  if (balance < amountWei) {
    throw new Error(`${account.address} holds ${show(balance)} but needs ${show(amountWei)}.`);
  }

  console.log(`Agent ${account.address} shielding ${show(amountWei)} into pool ${net.pool}`);

  // 1) Build the shield intent. The SDK checks the asset and the deposit limit,
  //    mints a Poseidon note, and proves it binds (amount, asset).
  const intent = await buildShieldBoundIntent({
    chainId: net.chainId,
    poolAddress: net.pool,
    asset: asset.address,
    amountWei,
    prover: await proverFor("shield", net),
  });

  console.log("Minted note. PERSIST THIS SECRET, it is the only way to spend this money:");
  console.log("  secret:    ", intent.note.secret);
  console.log("  commitment:", intent.note.commitment);

  // 2) Tokens: let the pool pull the amount, and wait for that to land first.
  if (!isNative(asset)) {
    const allowance = await pub.readContract({
      address: asset.address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, net.pool],
    });
    // Exact amounts; USDT on Ethereum first clears a stale allowance to 0 (approvalSteps).
    for (const value of approvalSteps(net.chainId, asset.address, allowance, amountWei)) {
      const approveHash = await wallet.writeContract({
        address: asset.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [net.pool, value],
      });
      const approved = await pub.waitForTransactionReceipt({ hash: approveHash });
      if (approved.status !== "success") throw new Error("The approval reverted.");
      console.log(`Approved the pool to pull ${show(amountWei)}.`);
    }
  }

  // 3) Sign + broadcast the resolved shieldBound call the SDK gave us.
  const hash = await wallet.writeContract({
    address: intent.exec.poolAddress,
    abi: shieldBoundAbi,
    functionName: "shieldBound",
    args: intent.exec.args as readonly [`0x${string}`, bigint, `0x${string}`, `0x${string}`],
    value: intent.exec.valueWei,
  });
  console.log(`Submitted: ${net.explorerUrl}/tx/${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error("The deposit reverted. Check the balance, the approval and the pool's deposit limits.");
  }
  console.log("Shielded privately. Who can spend this balance is now off the public feed.");
  if (!net.testnet) {
    console.log("Direct deposits and private payments are free. Cashing out costs 0.5% (see cashOutFee in the SDK).");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
