/**
 * One-time setup on Tempo testnet (Moderato, 42431). Nothing here touches a
 * mainnet or a real key.
 *
 *   pnpm fund
 *
 * 1. Makes a THROWAWAY testnet key for the agent, a receive key for the seller
 *    (E2B's side) and an MPP secret, and writes them to .env (gitignored). None
 *    of them is printed.
 * 2. Funds the agent's address from Tempo's public testnet faucet
 *    (the tempo_fundAddress RPC method).
 * 3. Deposits 1 PathUSD into the Gloam pool. That note is the agent's private
 *    balance; its secret goes to .wallet/agent-notes.json (gitignored).
 *
 * The deposit is the one public step: it shows this address put 1 PathUSD into
 * the pool. Every payment after it is private.
 */
import { randomBytes } from "node:crypto";
import { createWalletClient, erc20Abi, formatUnits, http, parseUnits, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { approvalSteps, buildShieldBoundIntent, generateReceiveKey } from "@gloamtrade/sdk";
import { agentNotes, appendEnv, ASSET, CHAIN, loadEnv, NET, proverFor, publicClient, RPC, short, txUrl } from "./common.js";

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

const fmt = (v: bigint) => `${formatUnits(v, ASSET.decimals)} ${ASSET.symbol}`;

loadEnv();
console.log(`Setup on ${NET.label} testnet (chain ${NET.chainId}), Gloam pool ${NET.pool}\n`);

// 1. Keys, kept in .env and never printed.
if (!process.env.AGENT_TESTNET_KEY) {
  appendEnv("AGENT_TESTNET_KEY", generatePrivateKey());
  console.log("Made a throwaway testnet key for the agent (in .env, not printed).");
}
if (!process.env.SELLER_RECEIVE_KEY) {
  const key = await generateReceiveKey();
  appendEnv("SELLER_RECEIVE_KEY", Buffer.from(JSON.stringify(key)).toString("base64url"));
  console.log("Made the seller's receive key (in .env, not printed).");
}
if (!process.env.MPP_SECRET_KEY) {
  appendEnv("MPP_SECRET_KEY", randomBytes(32).toString("base64"));
  console.log("Made the MPP secret that binds challenge ids (in .env, not printed).");
}
const account = privateKeyToAccount(process.env.AGENT_TESTNET_KEY as Hex);
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
console.log(`Agent address (testnet only): ${account.address}\n`);

// 2. Testnet faucet.
const DEPOSIT = parseUnits(process.env.DEPOSIT ?? "1", ASSET.decimals);
const balanceOf = () =>
  publicClient.readContract({ address: ASSET.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
let bal = await balanceOf();
if (bal < DEPOSIT + parseUnits("0.5", ASSET.decimals)) {
  console.log("Asking the Tempo testnet faucet (tempo_fundAddress) for test stablecoins...");
  await publicClient.request({ method: "tempo_fundAddress" as never, params: [account.address] as never });
  for (let i = 0; i < 30 && bal < DEPOSIT; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    bal = await balanceOf();
  }
}
console.log(`Agent holds ${fmt(bal)} on testnet (gas on Tempo is paid in a stablecoin).`);
if (bal < DEPOSIT) throw new Error("The faucet did not fund the agent. Try again in a minute.");

// 3. Deposit into the pool: the agent's private balance.
const held = agentNotes.all().filter((n) => n.status === "unspent");
if (held.length > 0 && process.env.FORCE_DEPOSIT !== "1") {
  const total = held.reduce((s, n) => s + BigInt(n.amountWei), 0n);
  console.log(`\nThe agent already holds ${fmt(total)} privately in ${held.length} note(s). Set FORCE_DEPOSIT=1 to add more.`);
  process.exit(0);
}
console.log(`\nDepositing ${fmt(DEPOSIT)} into the Gloam pool (proving the deposit)...`);
const shield = await buildShieldBoundIntent({
  chainId: NET.chainId,
  poolAddress: NET.pool,
  asset: ASSET.address,
  amountWei: DEPOSIT,
  prover: await proverFor("shield"),
});
const allowance = await publicClient.readContract({
  address: ASSET.address,
  abi: erc20Abi,
  functionName: "allowance",
  args: [account.address, NET.pool],
});
for (const value of approvalSteps(NET.chainId, ASSET.address, allowance, DEPOSIT)) {
  const h = await wallet.writeContract({ address: ASSET.address, abi: erc20Abi, functionName: "approve", args: [NET.pool, value] });
  if ((await publicClient.waitForTransactionReceipt({ hash: h })).status !== "success") throw new Error("The approval reverted.");
}
const hash = await wallet.writeContract({
  address: shield.exec.poolAddress,
  abi: shieldBoundAbi,
  functionName: "shieldBound",
  args: shield.exec.args as readonly [Hex, bigint, Hex, Hex],
  value: shield.exec.valueWei,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`The deposit reverted: ${txUrl(hash)}`);
agentNotes.save([
  ...agentNotes.all(),
  {
    secret: shield.note.secret as Hex,
    commitment: shield.note.commitment as Hex,
    amountWei: DEPOSIT.toString(),
    status: "unspent",
    createdAt: new Date().toISOString(),
  },
]);
console.log(`Deposited. Note ${short(shield.note.commitment)} saved to .wallet/agent-notes.json (secret not printed).`);
console.log(`  deposit tx  ${txUrl(hash)}`);
console.log("  This deposit is public (this address put 1 PathUSD into the pool). The payments that follow are not.");

process.exit(0); // snarkjs keeps worker threads alive
