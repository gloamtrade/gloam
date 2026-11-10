/**
 * Reference agent payment over x402, private end to end, using only
 * @gloamtrade/sdk. A seller prices a resource (the 402 challenge) to its receive
 * tag; a buyer agent shields a note to fund itself, builds a PRIVATE payment of
 * the required amount sealed to that tag, broadcasts it itself (self-custodial,
 * no operator holds its key), and presents the X-PAYMENT header. The seller
 * opens the payment, verifies it, and sweeps it into a fresh note only the
 * seller knows. It serves only after that sweep confirms: the buyer created the
 * payment note, so until then the buyer could spend it back.
 *
 * This is the pattern that won Colosseum (x402 + stablecoins) with the
 * settlement made private: the amount and the parties never go on the public
 * feed. This is NOT a Tempo Zone: no operator sees the payment; only the payer
 * and the payee learn the amount.
 *
 *   # mainnet: a 0.01 USDC.e payment on Tempo (or USDG on Robinhood Chain)
 *   GLOAM_NETWORK=tempo-mainnet GLOAM_PAY_KEY=0x... npx tsx examples/pay-x402/pay-x402.ts
 *
 *   # testnet (the default): test ETH on Robinhood Chain testnet
 *   GLOAM_PAY_KEY=0x... npx tsx examples/pay-x402/pay-x402.ts
 *
 * GLOAM_NETWORK is robinhood-mainnet, tempo-mainnet, robinhood or tempo (the
 * last two are the testnets). Unset, it stays on Robinhood Chain testnet so
 * nothing real is spent by accident. Optional: GLOAM_ASSET (a symbol or address
 * the pool lists), GLOAM_RPC (your own RPC URL), GLOAM_RELAY_URL (sweep through
 * the Gloam relay).
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
  buildGloamPaymentRequirements,
  buildGloamPayment,
  generateReceiveKey,
  settleGloamPayment,
  sweepChainFromClient,
  relaySubmitter,
  transferCallArgs,
  POOL_TRANSFER_ABI,
  encodePaymentHeader,
  decodePaymentHeader,
  artifactProver,
  syncTree,
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
  const show = (v: bigint) => `${formatUnits(v, asset.decimals)} ${asset.symbol}`;
  const transferProver = await proverFor("transfer", net);

  // ── Seller: a receive key, and the price (the 402 challenge) ───────────────
  // A real seller makes its key once and keeps the private half server-side.
  const seller = await generateReceiveKey();
  const price = parseUnits(isNative(asset) ? "0.0002" : "0.01", asset.decimals);
  const requirements = buildGloamPaymentRequirements({
    amountWei: price,
    asset: asset.address,
    assetSymbol: asset.symbol,
    payTo: seller.tag, // payments are sealed to this; only the seller can open them
    resource: "mcp://gloam/tool/summarize",
    description: "One private summarize call",
    poolAddress: net.pool,
    network: net.chainId,
  });
  console.log("402 Payment Required:");
  console.log(`  price ${show(price)} to ${requirements.payTo.slice(0, 24)}...`);
  console.log(`  ${requirements.privacy.oneLine}\n`);

  // ── Buyer: shield a note to fund itself ────────────────────────────────────
  // Small by default: 1 of a stablecoin, or 0.0005 test ETH.
  const fund = parseUnits(isNative(asset) ? "0.0005" : "1", asset.decimals);
  // Precheck funding so an underfunded wallet fails clearly. A native shield
  // attaches its amount as msg.value; a token shield pulls via transferFrom
  // after approve. On Robinhood Chain, Base and Ethereum the wallet also needs ETH for gas,
  // on Elysium HYPE; on Tempo, gas is paid in a stablecoin.
  if (net.family !== "tempo") {
    const eth = await pub.getBalance({ address: account.address });
    if (eth === 0n) throw new Error(`${account.address} has no ${net.chain.nativeCurrency.symbol} for gas on ${networkName(net.chainId)}.`);
    const needed = fund + parseUnits("0.0004", 18);
    if (isNative(asset) && eth < needed) {
      throw new Error(`${account.address} has ${formatUnits(eth, 18)} ETH but needs about ${formatUnits(needed, 18)} (the deposit plus gas).`);
    }
  }
  if (!isNative(asset)) {
    const tokenBal = await pub.readContract({
      address: asset.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    if (tokenBal < fund) {
      throw new Error(`${account.address} holds ${show(tokenBal)} but needs ${show(fund)}.`);
    }
  }
  console.log(`Buyer ${account.address} shielding ${show(fund)} to fund the payment`);
  const shield = await buildShieldBoundIntent({
    chainId: net.chainId,
    poolAddress: net.pool,
    asset: asset.address,
    amountWei: fund,
    prover: await proverFor("shield", net),
  });
  console.log(`  buyer note ${shield.note.commitment.slice(0, 12)}... secret ${shield.note.secret} (store it until the payment settles)`);
  // Token shields need an allowance so the pool can pull the tokens. Wait for it to land first.
  if (!isNative(asset)) {
    const allowance = await pub.readContract({
      address: asset.address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, net.pool],
    });
    // Exact amounts; USDT on Ethereum first clears a stale allowance to 0 (approvalSteps).
    for (const value of approvalSteps(net.chainId, asset.address, allowance, fund)) {
      const approveHash = await wallet.writeContract({
        address: asset.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [net.pool, value],
      });
      const approved = await pub.waitForTransactionReceipt({ hash: approveHash });
      if (approved.status !== "success") throw new Error("The approval reverted.");
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

  // ── Buyer: sync the tree and build the private x402 payment ────────────────
  const synced = await syncTree(pub, { pool: net.pool, fromBlock: net.deployBlock, chunkSize: logRange(net) });
  const path = await synced.pathForCommitment(shield.note.commitment);
  if (!path) throw new Error("Source note not in the tree yet. Retry in a moment.");

  const payment = await buildGloamPayment({
    requirements,
    senderSecretHex: shield.note.secret,
    senderNoteAmountWei: fund,
    path,
    prove: transferProver,
    issuerTag: "issuer:demo", // optional issuer-scoped compliance disclosure
  });
  // The change is the rest of the buyer's balance: keep it before anything is sent.
  const change = BigInt(payment.changeNote.amountWei);
  console.log(`  buyer keeps change note ${payment.changeNote.commitment.slice(0, 12)}... (${show(change)}) secret ${payment.changeNote.secret}`);

  // ── Buyer: settle the payment itself, then attach the tx hash ──────────────
  console.log("Settling the private payment (self-custodial)");
  const sendHash = await wallet.writeContract({
    address: payment.intent.exec.poolAddress,
    abi: POOL_TRANSFER_ABI,
    functionName: "transfer",
    args: transferCallArgs(payment.intent),
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: sendHash });
  if (receipt.status !== "success") throw new Error("Transfer reverted.");
  payment.payload.payload.txHash = sendHash;

  // ── Seller: open, verify and sweep the presented X-PAYMENT, then serve ─────
  // The agent attaches the settlement tx, then presents the header on the retry.
  const presented = decodePaymentHeader(encodePaymentHeader(payment.payload));
  // settleGloamPayment opens the sealed note with the seller's key, checks it
  // binds the price and asset in the right pool, then moves it into a fresh note
  // only the seller knows. The sweep goes through the Gloam relay when
  // GLOAM_RELAY_URL is set, else the seller's own wallet (here the same key).
  const relayUrl = process.env.GLOAM_RELAY_URL?.trim();
  const settled = await settleGloamPayment({
    requirements,
    payload: presented,
    receiveKey: seller,
    prove: transferProver,
    chain: sweepChainFromClient(pub, { pool: net.pool, fromBlock: net.deployBlock, chunkSize: logRange(net) }),
    submit: relayUrl
      ? relaySubmitter({ url: relayUrl })
      : (intent) =>
          wallet.writeContract({
            address: intent.exec.poolAddress,
            abi: POOL_TRANSFER_ABI,
            functionName: "transfer",
            args: transferCallArgs(intent),
          }),
    // Store this before the sweep is sent; its secret is now the seller's money.
    beforeSubmit: (fresh) => console.log(`  seller keeps fresh note ${fresh.commitment.slice(0, 12)}... secret ${fresh.secret} (store it)`),
  });
  console.log(`\nSeller settle: ${settled.status}${settled.reason ? ` (${settled.reason})` : ""}`);
  if (!settled.grantAccess) throw new Error("Payment is not final. Do not serve.");
  console.log(`  swept in ${settled.sweep?.hash}; the buyer can no longer spend it back`);
  console.log("\nAccess granted. The public feed shows shielded transfers, never the amount or the parties.");
  if (!net.testnet) {
    console.log("Direct deposits and private payments are free. Cashing out costs 0.5% (see cashOutFee in the SDK).");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
