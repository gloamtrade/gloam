/**
 * Fork test: pay for a Gloam name with ETH, end to end, against a local fork of
 * Robinhood Chain mainnet (never the live chain). It quotes, buys exactly enough
 * $GLOAM through the Universal Router, approves, registers on the live registry's
 * forked state, and checks resolve() gives back the key.
 *
 *   ~/.foundry/bin/anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8547 --chain-id 4663
 *   pnpm dlx tsx scripts/fork-pay-with-eth.mts [rpc] [name]
 */
import { generateKeyPairSync } from "node:crypto";
import { createPublicClient, createWalletClient, defineChain, erc20Abi, formatEther, formatUnits, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RH_GLOAM, buildEthToGloamSwap, ethWithBuffer, quoteCall } from "../src/lib/ethForGloam";
import { GLOAM_NAMES_ADDRESS, gloamNamesAbi } from "../src/lib/gloamNames";
import { receiveTagFromPoint } from "../src/lib/receiveTag";

const rpc = process.argv[2] ?? "http://127.0.0.1:8547";
const name = process.argv[3] ?? "fkpy";
// anvil's first funded account: a fork test only, never a real key
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const chain = defineChain({ id: 4663, name: "Robinhood Chain (fork)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ chain, transport: http(rpc), account });
const registry = GLOAM_NAMES_ADDRESS!;

if ((await pub.getChainId()) !== 4663) throw new Error("not a Robinhood Chain fork");
const gloam = (v: bigint) => formatUnits(v, 18);

// a fresh P-256 key, the way a Gloam address carries one
const spki = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" });
const x = `0x${spki.subarray(27, 59).toString("hex")}` as Hex;
const y = `0x${spki.subarray(59, 91).toString("hex")}` as Hex;
const tag = receiveTagFromPoint(x, y);
if (!tag) throw new Error("bad test key");

const price = await pub.readContract({ address: registry, abi: gloamNamesAbi, functionName: "priceOf", args: [name, 1n] });
const before = await pub.readContract({ address: RH_GLOAM, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const need = price > before ? price - before : 0n;
console.log(`@${name} costs ${gloam(price)} GLOAM; wallet has ${gloam(before)}; needs ${gloam(need)} more`);

const { result } = await pub.simulateContract({ ...quoteCall(need), account: account.address });
const quoted = result[0];
const ethIn = ethWithBuffer(quoted);
console.log(`quote: ${formatEther(quoted)} ETH for ${gloam(need)} GLOAM; sending ${formatEther(ethIn)} ETH (2% buffer)`);

const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200) + 10_000_000n; // the fork's clock can lag; deadline is generous on a fork only

// an underpaid buy must revert rather than land short
const low = buildEthToGloamSwap(quoted / 2n, need, deadline);
const reverted = await pub.call({ account: account.address, to: low.to, data: low.data, value: low.value }).then(
  () => false,
  () => true
);
console.log(`half the ETH for the full amount: ${reverted ? "reverts, as it should" : "DID NOT revert"}`);
if (!reverted) throw new Error("an underpaid swap went through");
const tx = buildEthToGloamSwap(ethIn, need, deadline);
const ethBefore = await pub.getBalance({ address: account.address });
const h1 = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, account, chain });
const r1 = await pub.waitForTransactionReceipt({ hash: h1 });
const after = await pub.readContract({ address: RH_GLOAM, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const ethAfter = await pub.getBalance({ address: account.address });
console.log(`swap ${r1.status} (gas ${r1.gasUsed}): GLOAM ${gloam(before)} -> ${gloam(after)}, ETH spent ${formatEther(ethBefore - ethAfter)} incl. gas`);
if (r1.status !== "success" || after < price) throw new Error("swap did not deliver enough GLOAM");

// nothing left behind in the router
const routerEth = await pub.getBalance({ address: tx.to });
console.log(`router holds ${formatEther(routerEth)} ETH after the swap`);

const h2 = await wallet.writeContract({ address: RH_GLOAM, abi: erc20Abi, functionName: "approve", args: [registry, price], account, chain });
console.log(`approve ${(await pub.waitForTransactionReceipt({ hash: h2 })).status}`);
const h3 = await wallet.writeContract({ address: registry, abi: gloamNamesAbi, functionName: "register", args: [name, x, y, account.address, 1n], account, chain });
const r3 = await pub.waitForTransactionReceipt({ hash: h3 });
console.log(`register ${r3.status}`);
const [holder, rx, ry] = await pub.readContract({ address: registry, abi: gloamNamesAbi, functionName: "resolve", args: [name] });
const ok = holder.toLowerCase() === account.address.toLowerCase() && receiveTagFromPoint(rx, ry) === tag;
console.log(`resolve(@${name}) -> holder ${holder}, key ${ok ? "matches" : "DOES NOT match"}`);
const left = await pub.readContract({ address: RH_GLOAM, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`GLOAM left in the wallet after paying: ${gloam(left)}`);
if (!ok || r3.status !== "success") process.exit(1);
console.log("fork test passed");
