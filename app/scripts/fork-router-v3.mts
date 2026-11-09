/**
 * Private swaps v3 (GloamVaultSwapV4c), end to end on a local anvil fork of each
 * chain, against the LIVE vault, with REAL Groth16 proofs (the production circuits
 * and the ceremony-final zkeys) checked by the REAL verifiers the vault calls.
 * Nothing is overridden in the vault: each input note is a real deposit, spent
 * against the vault's real root, on a path worked out from its own filledSubtrees.
 * The router goes in the way the deploy page sends it, through the CREATE2 factory.
 * Gas here is what a swap costs on the chain, proof checks and cold storage included.
 *
 * Everything stays on the fork: nothing is broadcast and no key exists. anvil
 * impersonates the accounts it needs (the owner, a depositor, the relayer).
 *
 * Run from app/ after a plain `forge build` in contracts/:
 *   ../mcp/node_modules/.bin/tsx --tsconfig tsconfig.json scripts/fork-router-v3.mts --chain ethereum
 *   (--chain base | ethereum | robinhood)  ETH_PRICE sets the dollar line (default 2250). ONLY=<words> picks cases.
 */
import "./browser-shim.mts";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as snarkjs from "snarkjs";
import {
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildPoseidonUnshieldWitness, fieldToBytes32, makeBoundNotePoseidon, packGroth16Proof, type Groth16Proof } from "@gloamtrade/sdk";

const { escrowAddress, exitDigest, refundAmountFor, swapChecked, swapDeadlineSeconds } = await import("../src/lib/vaultSwap");

const arg = process.argv[process.argv.indexOf("--chain") + 1] ?? "ethereum";
const ETH_PRICE = Number(process.env.ETH_PRICE ?? 2250);
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const VAULT: Address = "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194";
const OWNER: Address = "0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8";
const RELAYER: Address = "0xb1E994586E62994648a0b866BF33F2EDd942512e";
const DEPOSITOR: Address = "0x00000000000000000000000000000000de90517e";
const STRANGER: Address = "0x000000000000000000000000000000000000dEaD";
const EXIT_TO: Address = "0x00000000000000000000000000000000e4170000";
const FACTORY: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const SALT = keccak256(toHex("gloam.vault-swap.v3"));
const TREE_SLOT = 4n; // nextIndex 4, currentRoot 5, filledSubtrees 6.., zeros 26.. (forge inspect)
const fixture = JSON.parse(readFileSync(new URL("../../contracts/test/fixtures/router-next.json", import.meta.url), "utf8"));

type Case = { name: string; assetIn: Address; assetOut: Address; amountIn: bigint; pools: number[]; kind?: "swap" | "refund" | "exit" | "late" | "short" | "relayed" | "relayedExit" };
type Cfg = { id: number; fork: string; quoter: Address; port: number; bufferBps: bigint; syms: Record<string, [string, number]>; cases: Case[]; prepare?: () => Promise<void> };

const BU = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const BT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" as Address;
const BE = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" as Address;
const EU = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const ET = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address;
const EG = "0xe343167631d89B6Ffc58B88d6b7fB0228795491D" as Address;
const EE = "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c" as Address;
const RU = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const RW = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;

const CONFIGS: Record<string, Omit<Cfg, "prepare">> = {
  ethereum: {
    id: 1, fork: "https://gateway.tenderly.co/public/mainnet", quoter: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203", port: 8771, bufferBps: 10n,
    syms: { [NATIVE]: ["ETH", 18], [EU.toLowerCase()]: ["USDC", 6], [ET.toLowerCase()]: ["USDT", 6], [EG.toLowerCase()]: ["USDG", 6], [EE.toLowerCase()]: ["EURC", 6] },
    cases: [
      { name: "USDC -> USDT", assetIn: EU, assetOut: ET, amountIn: parseUnits("100", 6), pools: [4] },
      { name: "USDT -> USDC (Tether as input)", assetIn: ET, assetOut: EU, amountIn: parseUnits("100", 6), pools: [4] },
      { name: "USDC -> USDG", assetIn: EU, assetOut: EG, amountIn: parseUnits("100", 6), pools: [8] },
      { name: "USDC -> EURC", assetIn: EU, assetOut: EE, amountIn: parseUnits("100", 6), pools: [11] },
      { name: "ETH -> USDC (native note in)", assetIn: NATIVE, assetOut: EU, amountIn: parseUnits("0.05", 18), pools: [0] },
      { name: "USDC -> ETH (native note out)", assetIn: EU, assetOut: NATIVE, amountIn: parseUnits("100", 6), pools: [0] },
      { name: "USDT -> ETH via USDC, two hops", assetIn: ET, assetOut: NATIVE, amountIn: parseUnits("100", 6), pools: [4, 0] },
      { name: "USDT -> USDG via USDC, two hops, past the thin direct pool", assetIn: ET, assetOut: EG, amountIn: parseUnits("1000", 6), pools: [4, 8] },
      { name: "USDG -> USDC via USDT, two hops", assetIn: EG, assetOut: EU, amountIn: parseUnits("1000", 6), pools: [10, 4] },
      { name: "USDT -> EURC via USDC, two hops", assetIn: ET, assetOut: EE, amountIn: parseUnits("100", 6), pools: [4, 11] },
      { name: "USDG -> EURC via USDT and USDC, three hops", assetIn: EG, assetOut: EE, amountIn: parseUnits("100", 6), pools: [10, 4, 11] },
      { name: "USDC -> USDT at 45,000", assetIn: EU, assetOut: ET, amountIn: parseUnits("45000", 6), pools: [7] },
      { name: "EURC -> USDC", assetIn: EE, assetOut: EU, amountIn: parseUnits("100", 6), pools: [11] },
      { name: "USDT swap priced past what arrives, reverted", assetIn: ET, assetOut: EU, amountIn: parseUnits("100", 6), pools: [4], kind: "short" },
      { name: "USDT refund, unshield sent alone", assetIn: ET, assetOut: EU, amountIn: parseUnits("100", 6), pools: [4], kind: "refund" },
      { name: "USDC refund through the relay's own code", assetIn: EU, assetOut: ET, amountIn: parseUnits("100", 6), pools: [4], kind: "relayed" },
      { name: "USDC exit through the relay's own code", assetIn: EU, assetOut: ET, amountIn: parseUnits("100", 6), pools: [4], kind: "relayedExit" },
      { name: "ETH refund, unshield sent alone", assetIn: NATIVE, assetOut: EU, amountIn: parseUnits("0.05", 18), pools: [0], kind: "refund" },
      { name: "USDT exit, vault limit full", assetIn: ET, assetOut: EU, amountIn: parseUnits("100", 6), pools: [4], kind: "exit" },
      { name: "ETH swap past its deadline, then its refund", assetIn: NATIVE, assetOut: EU, amountIn: parseUnits("0.05", 18), pools: [0], kind: "late" },
    ],
  },
  base: {
    id: 8453, fork: "https://gateway.tenderly.co/public/base", quoter: "0x0d5e0f971ed27fbff6c2837bf31316121532048d", port: 8772, bufferBps: 10n,
    syms: { [NATIVE]: ["ETH", 18], [BU.toLowerCase()]: ["USDC", 6], [BT.toLowerCase()]: ["USDT", 6], [BE.toLowerCase()]: ["EURC", 6] },
    cases: [
      { name: "USDC -> USDT", assetIn: BU, assetOut: BT, amountIn: parseUnits("100", 6), pools: [2] },
      { name: "USDC -> EURC", assetIn: BU, assetOut: BE, amountIn: parseUnits("100", 6), pools: [6] },
      { name: "ETH -> USDC (native note in)", assetIn: NATIVE, assetOut: BU, amountIn: parseUnits("0.05", 18), pools: [0] },
      { name: "USDC -> ETH (native note out)", assetIn: BU, assetOut: NATIVE, amountIn: parseUnits("100", 6), pools: [0] },
      { name: "ETH -> USDT via USDC, two hops", assetIn: NATIVE, assetOut: BT, amountIn: parseUnits("0.05", 18), pools: [0, 2] },
      { name: "USDT -> USDC", assetIn: BT, assetOut: BU, amountIn: parseUnits("100", 6), pools: [2] },
      { name: "EURC -> USDC", assetIn: BE, assetOut: BU, amountIn: parseUnits("100", 6), pools: [6] },
      { name: "USDT -> EURC via USDC, two hops", assetIn: BT, assetOut: BE, amountIn: parseUnits("100", 6), pools: [2, 6] },
      { name: "USDC -> USDT at 10,000", assetIn: BU, assetOut: BT, amountIn: parseUnits("10000", 6), pools: [2] },
      { name: "USDC swap priced past what arrives, reverted", assetIn: BU, assetOut: BT, amountIn: parseUnits("100", 6), pools: [2], kind: "short" },
      { name: "USDC refund through the relay's own code", assetIn: BU, assetOut: BT, amountIn: parseUnits("100", 6), pools: [2], kind: "relayed" },
      { name: "USDC exit through the relay's own code", assetIn: BU, assetOut: BT, amountIn: parseUnits("100", 6), pools: [2], kind: "relayedExit" },
      { name: "ETH refund, unshield sent alone", assetIn: NATIVE, assetOut: BU, amountIn: parseUnits("0.05", 18), pools: [0], kind: "refund" },
      { name: "USDC exit, vault limit full", assetIn: BU, assetOut: BT, amountIn: parseUnits("100", 6), pools: [2], kind: "exit" },
      { name: "ETH swap past its deadline, then its refund", assetIn: NATIVE, assetOut: BU, amountIn: parseUnits("0.05", 18), pools: [0], kind: "late" },
    ],
  },
  robinhood: {
    id: 4663, fork: "https://rpc.mainnet.chain.robinhood.com", quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94", port: 8773, bufferBps: 50n,
    syms: { [NATIVE]: ["ETH", 18], [RU.toLowerCase()]: ["USDG", 6], [RW.toLowerCase()]: ["WETH", 18] },
    cases: [
      { name: "ETH -> USDG (native note, ETH pool)", assetIn: NATIVE, assetOut: RU, amountIn: parseUnits("0.05", 18), pools: [0] },
      { name: "ETH -> USDG (native note, WETH pool, wrapped)", assetIn: NATIVE, assetOut: RU, amountIn: parseUnits("0.05", 18), pools: [2] },
      { name: "USDG -> ETH (native note out)", assetIn: RU, assetOut: NATIVE, amountIn: parseUnits("100", 6), pools: [0] },
      { name: "USDG -> ETH (WETH pool, unwrapped)", assetIn: RU, assetOut: NATIVE, amountIn: parseUnits("100", 6), pools: [2] },
      { name: "WETH -> USDG (a WETH note still works)", assetIn: RW, assetOut: RU, amountIn: parseUnits("0.05", 18), pools: [2] },
      { name: "ETH refund, unshield sent alone", assetIn: NATIVE, assetOut: RU, amountIn: parseUnits("0.05", 18), pools: [0], kind: "refund" },
      { name: "USDG exit, vault limit full", assetIn: RU, assetOut: NATIVE, amountIn: parseUnits("100", 6), pools: [0], kind: "exit" },
      { name: "ETH swap past its deadline, then its refund", assetIn: NATIVE, assetOut: RU, amountIn: parseUnits("0.05", 18), pools: [0], kind: "late" },
    ],
  },
};
const cfg = CONFIGS[arg] as Cfg;
if (!cfg) throw new Error("--chain base | ethereum | robinhood");
const chainFx = fixture.chains[cfg.id];
const ROUTER = chainFx.address as Address;
const POOL_MANAGER = chainFx.poolManager as Address;
const WETH = chainFx.weth as Address;
const pools = chainFx.pools as { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }[];

// The relay's code, for the cases that run it: pointed at this fork, with a throwaway key that exists only here.
process.env[`GLOAM_RPC_URL_${cfg.id}`] = `http://127.0.0.1:${cfg.port}`;
process.env.GLOAM_RELAYER_PRIVATE_KEY = generatePrivateKey();

const anvil = spawn(`${homedir()}/.foundry/bin/anvil`, ["--fork-url", cfg.fork, "--port", String(cfg.port), "--silent"], { stdio: "ignore" });
process.on("exit", () => anvil.kill("SIGTERM"));
const url = `http://127.0.0.1:${cfg.port}`;
const client = createPublicClient({ transport: http(url, { timeout: 120_000 }) });
const raw = (method: string, params: unknown[] = []) => client.request({ method: method as never, params: params as never }) as Promise<unknown>;
for (let i = 0; ; i++) {
  try {
    await client.getChainId();
    break;
  } catch (e) {
    if (i > 90) throw e;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const vaultAbi = parseAbi([
  "function shieldBound(address asset, uint256 amount, bytes32 commitment, bytes proof) payable",
  "function unshield(bytes proof, bytes32 root, bytes32 nullifier, address asset, address to, uint256 amount)",
  "function commitmentSeen(bytes32) view returns (bool)",
  "function isSpent(bytes32) view returns (bool)",
  "function currentRoot() view returns (bytes32)",
  "function isKnownRoot(bytes32) view returns (bool)",
  "function withdrawFeeBps() view returns (uint16)",
  "function deposited(address) view returns (uint256)",
  "function feesOwed(address) view returns (uint256)",
  "function depositLimit(address) view returns (uint128, uint128)",
  "function lowerDepositLimit(address, uint128, uint128)",
  "function executeChange(bytes)",
  "function setDepositLimit(address, uint128, uint128)",
  "function changeEta(bytes32) view returns (uint256)",
  "function changeId(bytes) view returns (bytes32)",
]);
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256)", "function transfer(address,uint256)"]);
const KEY = [
  { name: "nullifier", type: "bytes32" },
  { name: "amountIn", type: "uint256" },
  { name: "outCommitment", type: "bytes32" },
  { name: "assetOut", type: "address" },
  { name: "amountOut", type: "uint256" },
  { name: "refundCommitment", type: "bytes32" },
  { name: "refundAmount", type: "uint256" },
  { name: "routeHash", type: "bytes32" },
  { name: "exitKey", type: "address" },
  { name: "deadline", type: "uint256" },
] as const;
const DEP = [
  { name: "proof", type: "bytes" },
  { name: "commitment", type: "bytes32" },
  { name: "asset", type: "address" },
  { name: "amount", type: "uint256" },
] as const;
const routerAbi = [
  {
    type: "function", name: "swap", stateMutability: "nonpayable",
    inputs: [
      { name: "s", type: "tuple", components: [{ name: "proof", type: "bytes" }, { name: "root", type: "bytes32" }, { name: "nullifier", type: "bytes32" }, { name: "asset", type: "address" }, { name: "amount", type: "uint256" }] },
      { name: "d", type: "tuple", components: DEP },
      { name: "r", type: "tuple", components: DEP },
      { name: "route", type: "bytes" },
      { name: "exitKey", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "escrowFor", stateMutability: "view", inputs: [{ type: "address" }, { type: "tuple", components: KEY }], outputs: [{ type: "address" }] },
  { type: "function", name: "exitDigest", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "exit", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "tuple", components: KEY }, { type: "address" }, { type: "bytes" }], outputs: [{ type: "uint256" }] },
  ...parseAbi([
    "event VaultSwap(bytes32 indexed nullifier, bytes32 indexed commitment, address indexed assetIn, address assetOut, uint256 amountIn, uint256 amountOut, uint256 leftover)",
    "event VaultSwapRefund(bytes32 indexed nullifier, bytes32 indexed commitment, address indexed asset, uint256 amount)",
    "event VaultSwapExit(bytes32 indexed nullifier, address indexed asset, address indexed to, uint256 amount)",
  ]),
] as const;
const PATH_KEY = [
  { name: "intermediateCurrency", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
  { name: "hookData", type: "bytes" },
] as const;
const quoterAbi = (["quoteExactInput", "quoteExactOutput"] as const).map((name) => ({
  type: "function", name, stateMutability: "nonpayable",
  inputs: [{ name: "p", type: "tuple", components: [{ name: "exactCurrency", type: "address" }, { name: "path", type: "tuple[]", components: PATH_KEY }, { name: "exactAmount", type: "uint128" }] }],
  outputs: [{ type: "uint256" }, { type: "uint256" }],
})) as never;
const POOL_KEY = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const fmt = (v: bigint, a: Address) => {
  const [s, d] = cfg.syms[a.toLowerCase()] ?? cfg.syms[a] ?? ["?", 18];
  return `${formatUnits(v, d)} ${s}`;
};
/** A transaction from an impersonated account, mined at once. Returns the receipt, reverted or not. */
async function tx(from: Address, to: Address | null, data: Hex, value = 0n) {
  const hash = (await raw("eth_sendTransaction", [{ from, ...(to ? { to } : {}), data, value: toHex(value), gas: toHex(12_000_000n) }])) as Hex;
  await raw("evm_mine").catch(() => {});
  return client.waitForTransactionReceipt({ hash });
}
const balance = (asset: Address, who: Address) =>
  same(asset, NATIVE) ? client.getBalance({ address: who }) : client.readContract({ address: asset, abi: tokenAbi, functionName: "balanceOf", args: [who] });
const readVault = (functionName: string, args: unknown[] = []) => client.readContract({ address: VAULT, abi: vaultAbi, functionName: functionName as never, args: args as never }) as Promise<never>;

async function prove(name: "shield" | "unshield", input: Record<string, unknown>) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input as never, `public/circuits/${name}.wasm`, `public/circuits/final/${name}_final.zkey`);
  const vkey = JSON.parse(readFileSync(`public/circuits/final/${name}_vkey.json`, "utf8"));
  if (!(await snarkjs.groth16.verify(vkey, publicSignals, proof))) throw new Error(`${name} proof failed locally`);
  return packGroth16Proof(proof as Groth16Proof);
}
const shieldProof = (n: { commitment: string; secret: string }, amount: bigint, asset: Address) =>
  prove("shield", { commitment: BigInt(n.commitment).toString(), amount: amount.toString(), asset: BigInt(asset).toString(), secret: BigInt(n.secret).toString() });

/** The path of the leaf about to go in, from the vault's own storage: no log scan, nothing overridden. */
async function nextLeafPath() {
  const slot = (i: bigint) => client.getStorageAt({ address: VAULT, slot: toHex(i, { size: 32 }) }).then((v) => BigInt(v ?? 0));
  const index = await slot(TREE_SLOT);
  const elements: bigint[] = [];
  const indices: number[] = [];
  let at = index;
  for (let i = 0n; i < 20n; i++) {
    const odd = at % 2n === 1n;
    indices.push(odd ? 1 : 0);
    elements.push(await slot(odd ? TREE_SLOT + 2n + i : TREE_SLOT + 22n + i));
    at /= 2n;
  }
  return { index, elements, indices };
}

/** A real note: the asset moved to the depositor, a real shield proof, a real deposit into the live vault. */
async function realNote(asset: Address, amount: bigint) {
  const note = await makeBoundNotePoseidon(amount, asset);
  const proof = await shieldProof(note, amount, asset);
  const at = await nextLeafPath();
  const data = encodeFunctionData({ abi: vaultAbi, functionName: "shieldBound", args: [asset, amount, note.commitment as Hex, proof] });
  if (same(asset, NATIVE)) {
    await raw("anvil_setBalance", [DEPOSITOR, toHex(amount + parseUnits("1", 18))]);
    const r = await tx(DEPOSITOR, VAULT, data, amount);
    if (r.status !== "success") throw new Error("native deposit reverted");
  } else {
    await tx(POOL_MANAGER, asset, encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [DEPOSITOR, amount] }));
    await tx(DEPOSITOR, asset, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [VAULT, 0n] }));
    await tx(DEPOSITOR, asset, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [VAULT, amount] }));
    const r = await tx(DEPOSITOR, VAULT, data);
    if (r.status !== "success") throw new Error(`deposit reverted: ${fmt(amount, asset)}`);
  }
  const root = await readVault("currentRoot");
  return { note, path: { leafIndex: Number(at.index), leaf: note.commitmentField, pathElements: at.elements, pathIndices: at.indices, root: BigInt(root) } };
}

/** Quotes a route on the real pools: the most it fills, less the buffer, then what that costs exactly. */
async function plan(c: Case, available: bigint) {
  const route = c.pools.map((i) => pools[i]!);
  const path: Address[] = [];
  let cur: Address = c.assetIn;
  const holds = (k: (typeof route)[number], a: Address) => same(k.currency0, a) || same(k.currency1, a);
  if (!holds(route[0]!, cur)) cur = same(cur, NATIVE) ? WETH : NATIVE;
  path.push(cur);
  for (const k of route) {
    cur = same(k.currency0, cur) ? k.currency1 : k.currency0;
    path.push(cur);
  }
  const hop = (i: number, exactIn: boolean) => ({ intermediateCurrency: exactIn ? path[i + 1]! : path[i]!, fee: route[i]!.fee, tickSpacing: route[i]!.tickSpacing, hooks: route[i]!.hooks, hookData: "0x" as Hex });
  const q = (await client.simulateContract({ address: cfg.quoter, abi: quoterAbi, functionName: "quoteExactInput" as never, args: [{ exactCurrency: path[0], path: route.map((_, i) => hop(i, true)), exactAmount: available }] as never })).result as unknown as [bigint];
  const amountOut = (q[0] * (10_000n - cfg.bufferBps)) / 10_000n;
  const o = (await client.simulateContract({ address: cfg.quoter, abi: quoterAbi, functionName: "quoteExactOutput" as never, args: [{ exactCurrency: path[route.length], path: route.map((_, i) => hop(i, false)), exactAmount: amountOut }] as never })).result as unknown as [bigint];
  return { route, amountOut, cost: o[0] };
}

const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
  return ok ? "ok" : "FAILED";
};
const failures: string[] = [];
const gasRows: { name: string; gas: bigint; calldata: number }[] = [];

async function runCase(c: Case, feeBps: bigint) {
  const kind = c.kind ?? "swap";
  console.log(`\n${c.name}`);
  const { note, path } = await realNote(c.assetIn, c.amountIn);
  const fee = (c.amountIn / 10_000n) * feeBps + ((c.amountIn % 10_000n) * feeBps) / 10_000n;
  const available = c.amountIn - fee;
  const p = await plan(c, available);
  if (p.cost > available) failures.push(`${c.name}: the quote costs more than arrives`);
  // a price past the buffer, as if the pool moved after the quote: the new note asks for more than arrives can buy
  if (kind === "short") p.amountOut = (p.amountOut * 102n) / 100n;
  const backAmount = refundAmountFor(c.amountIn, swapChecked(cfg.id) ? Number(feeBps) : undefined);
  const out = await makeBoundNotePoseidon(p.amountOut, c.assetOut);
  const back = await makeBoundNotePoseidon(backAmount, c.assetIn);
  // the exit key is a throwaway, held only here, like the one the app makes for each swap
  const exitPk = generatePrivateKey();
  const exitAccount = privateKeyToAccount(exitPk);
  const routeBytes = encodeAbiParameters([{ type: "tuple[]", components: POOL_KEY }], [p.route.map((k) => ({ ...k }))]);
  // from the chain's clock, as the app does it
  const deadline = (await client.getBlock()).timestamp + BigInt(swapDeadlineSeconds(cfg.id));
  const key = {
    nullifier: note.nullifier as Hex,
    amountIn: c.amountIn,
    outCommitment: out.commitment as Hex,
    assetOut: c.assetOut,
    amountOut: p.amountOut,
    refundCommitment: back.commitment as Hex,
    refundAmount: backAmount,
    routeHash: keccak256(routeBytes),
    exitKey: exitAccount.address,
    deadline,
  };
  const escrow = (await client.readContract({ address: ROUTER, abi: routerAbi, functionName: "escrowFor", args: [c.assetIn, key] })) as Address;
  check(same(escrowAddress(ROUTER, c.assetIn, key), escrow), "the app works out the router's escrow");
  const w = await buildPoseidonUnshieldWitness({ secretHex: note.secret as Hex, amount: c.amountIn, asset: c.assetIn, to: escrow, path });
  if (!w.checks.commitmentMatches) throw new Error("the witness does not open the note");
  const [unProof, outProof, backProof] = await Promise.all([prove("unshield", w.circomInput), shieldProof(out, p.amountOut, c.assetOut), shieldProof(back, backAmount, c.assetIn)]);
  const root = fieldToBytes32(w.publicInputs.root);
  const nullifier = fieldToBytes32(w.publicInputs.nullifier);
  const data = encodeFunctionData({
    abi: routerAbi,
    functionName: "swap",
    args: [
      { proof: unProof, root, nullifier, asset: c.assetIn, amount: c.amountIn },
      { proof: outProof, commitment: out.commitment as Hex, asset: c.assetOut, amount: p.amountOut },
      { proof: backProof, commitment: back.commitment as Hex, asset: c.assetIn, amount: backAmount },
      routeBytes,
      exitAccount.address,
      deadline,
    ],
  });
  const seen = (cm: string) => readVault("commitmentSeen", [cm]) as Promise<boolean>;

  if (kind === "late") {
    await raw("evm_setNextBlockTimestamp", [Number(deadline) + 1]);
    const late = await tx(RELAYER, ROUTER, data);
    console.log(`  one second past its deadline: ${check(late.status === "reverted", "a swap past its deadline reverts")} (reverted), note unspent: ${check(!(await readVault("isSpent", [nullifier])), "the note stays unspent")}`);
  }

  let unshieldTx: Hex | undefined;
  if (kind !== "swap" && kind !== "short") {
    const alone = await tx(STRANGER, VAULT, encodeFunctionData({ abi: vaultAbi, functionName: "unshield", args: [unProof, root, nullifier, c.assetIn, escrow, c.amountIn] }));
    console.log(`  unshield sent alone by a stranger: ${check(alone.status === "success", "unshield alone")}, gas ${alone.gasUsed}`);
    unshieldTx = alone.transactionHash;
    console.log(`  waiting at the escrow: ${fmt(await balance(c.assetIn, escrow), c.assetIn)}: ${check((await balance(c.assetIn, escrow)) === available, "escrow holds what arrived")}`);
  }

  if (kind === "relayed" || kind === "relayedExit") {
    const { RelayError, relayVaultSwap, relayVaultSwapExit, relayerAccount } = await import("../src/lib/relay/server");
    const { VAULT_SWAP_ROUTERS, VAULT_SWAP_V3_LIVE } = await import("../src/lib/vaultSwap");
    const { getNetwork } = await import("../src/lib/networks");
    VAULT_SWAP_V3_LIVE[cfg.id] = ROUTER;
    VAULT_SWAP_ROUTERS[cfg.id] = ROUTER;
    const net = getNetwork(cfg.id === 1 ? "ethereum-mainnet" : "base-mainnet");
    await raw("anvil_setBalance", [relayerAccount()!.address, toHex(parseUnits("10", 18))]);
    const code = (p: Promise<unknown>) => p.then(() => "sent", (e) => (e instanceof RelayError ? e.code : String(e)));
    const route = p.route.map((k) => ({ ...k }));
    const body = {
      router: ROUTER,
      spend: { proof: unProof, root, nullifier, asset: c.assetIn, amount: c.amountIn.toString() },
      deposit: { proof: outProof, commitment: out.commitment, asset: c.assetOut, amount: p.amountOut.toString() },
      refund: { proof: backProof, commitment: back.commitment, asset: c.assetIn, amount: backAmount.toString() },
      route,
      exitKey: exitAccount.address,
      deadline: deadline.toString(),
    };
    const wire = { ...key, amountIn: c.amountIn.toString(), amountOut: p.amountOut.toString(), refundAmount: backAmount.toString(), deadline: deadline.toString() };
    const exitBody = { router: ROUTER, asset: c.assetIn, key: wire, to: EXIT_TO, signature: await exitAccount.sign({ hash: exitDigest(cfg.id, ROUTER, escrow, EXIT_TO) }) };
    const send = (over: Record<string, unknown>) => (kind === "relayed" ? relayVaultSwap(net, { ...body, ...over }) : relayVaultSwapExit(net, { ...exitBody, ...over }));
    const noHash = await code(send({}));
    console.log(`  the relay with no transaction named: ${check(noHash === "unshield_tx", "refused with no transaction named")} (${noHash})`);
    const wrong = await code(send({ unshieldTx: deployHash }));
    console.log(`  the relay with another transaction: ${check(wrong === "unshield_tx", "refused with another transaction")} (${wrong})`);
    // money at an escrow this note's unshield never paid, under the same spent nullifier
    const made = { ...key, outCommitment: back.commitment as Hex, refundAmount: 1n };
    const madeEscrow = escrowAddress(ROUTER, c.assetIn, made);
    await tx(POOL_MANAGER, c.assetIn, encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [madeEscrow, 1n] }));
    const unpaid = await code(
      kind === "relayed"
        ? relayVaultSwap(net, { ...body, deposit: { ...body.deposit, commitment: back.commitment }, refund: { ...body.refund, amount: "1" }, unshieldTx })
        : relayVaultSwapExit(net, { ...exitBody, key: { ...wire, outCommitment: back.commitment, refundAmount: "1" }, unshieldTx })
    );
    console.log(`  the relay for an escrow the vault didn't pay: ${check(unpaid === "unshield_tx", "refused for an escrow the vault didn't pay")} (${unpaid})`);
    const before = await balance(c.assetIn, EXIT_TO);
    const hash = (await send({ unshieldTx })) as Hex;
    const r = await client.waitForTransactionReceipt({ hash });
    console.log(`  the relay with the unshield's transaction: ${check(r.status === "success", "the relay's send lands")}, gas ${r.gasUsed}`);
    gasRows.push({ name: c.name, gas: r.gasUsed, calldata: 0 });
    if (kind === "relayed") console.log(`  refund note landed: ${check(await seen(back.commitment), "refund landed")}`);
    else console.log(`  paid ${fmt((await balance(c.assetIn, EXIT_TO)) - before, c.assetIn)}: ${check((await balance(c.assetIn, EXIT_TO)) - before === available, "exit pays all that arrived")}`);
    return;
  }

  if (kind === "exit") {
    const dep = (await readVault("deposited", [c.assetIn])) as bigint;
    const [per] = (await readVault("depositLimit", [c.assetIn])) as unknown as [bigint, bigint];
    await tx(OWNER, VAULT, encodeFunctionData({ abi: vaultAbi, functionName: "lowerDepositLimit", args: [c.assetIn, per, dep] }));
    const stuck = await tx(RELAYER, ROUTER, data);
    console.log(`  vault limit full, the refund call: ${check(stuck.status === "reverted", "a full limit holds the refund back")} (reverted)`);
    console.log(`  still waiting at the escrow: ${check((await balance(c.assetIn, escrow)) === available, "the money waits")}`);
    // signed on the app's own digest, with no help from the chain, as the app does it
    const digest = exitDigest(cfg.id, ROUTER, escrow, EXIT_TO);
    check(digest === (await client.readContract({ address: ROUTER, abi: routerAbi, functionName: "exitDigest", args: [escrow, EXIT_TO] })), "the app works out the router's digest");
    const signature = await exitAccount.sign({ hash: digest });
    const wrongTo = await tx(STRANGER, ROUTER, encodeFunctionData({ abi: routerAbi, functionName: "exit", args: [c.assetIn, key, STRANGER, signature] }));
    console.log(`  a stranger points the signature at themselves: ${check(wrongTo.status === "reverted", "the signature names the address")} (reverted)`);
    const before = await balance(c.assetIn, EXIT_TO);
    const r = await tx(RELAYER, ROUTER, encodeFunctionData({ abi: routerAbi, functionName: "exit", args: [c.assetIn, key, EXIT_TO, signature] }));
    const paid = (await balance(c.assetIn, EXIT_TO)) - before;
    console.log(`  exit: ${check(r.status === "success", "exit lands")}, paid ${fmt(paid, c.assetIn)}: ${check(paid === available, "exit pays all that arrived")}, gas ${r.gasUsed}`);
    gasRows.push({ name: c.name, gas: r.gasUsed, calldata: 0 });
    console.log(`  escrow empty ${check((await balance(c.assetIn, escrow)) === 0n, "escrow empty")}, router empty ${check((await balance(c.assetIn, ROUTER)) === 0n, "router empty")}`);
    const again = await tx(RELAYER, ROUTER, data);
    console.log(`  the refund after that: ${check(again.status === "reverted", "no second way out")} (reverted)`);
    await tx(OWNER, VAULT, encodeFunctionData({ abi: vaultAbi, functionName: "lowerDepositLimit", args: [c.assetIn, per, dep] })).catch(() => {});
    return;
  }

  const r = await tx(RELAYER, ROUTER, data);
  const size = (data.length - 2) / 2;
  if (kind === "short") {
    console.log(`  swap: ${check(r.status === "reverted", `${c.name} reverts`)} (reverted), gas ${r.gasUsed}, note unspent: ${check(!(await readVault("isSpent", [nullifier])), "the note stays unspent")}`);
    gasRows.push({ name: c.name, gas: r.gasUsed, calldata: size });
    check((await balance(c.assetIn, escrow)) === 0n, "nothing at the escrow");
    return;
  }
  console.log(`  swap: ${check(r.status === "success", `${c.name} lands`)}, gas ${r.gasUsed}, calldata ${size} bytes`);
  if (r.status !== "success") return;
  gasRows.push({ name: c.name, gas: r.gasUsed, calldata: size });
  for (const l of r.logs) {
    if (!same(l.address, ROUTER)) continue;
    const ev = decodeEventLog({ abi: routerAbi, data: l.data, topics: l.topics }) as unknown as { eventName: string; args: Record<string, bigint> };
    if (ev.eventName === "VaultSwap") {
      console.log(`  spent ${fmt(ev.args.amountIn!, c.assetIn)}, new note ${fmt(ev.args.amountOut!, c.assetOut)}, leftover ${fmt(ev.args.leftover!, c.assetIn)}`);
      check(ev.args.amountOut === p.amountOut, "the new note is exactly what was proved");
      check(ev.args.amountIn! + ev.args.leftover! === available, "spent plus leftover is what arrived");
    }
  }
  if (kind === "refund" || kind === "late") console.log(`  refund note landed: ${check(await seen(back.commitment), "refund landed")}, new note not made: ${check(!(await seen(out.commitment)), "no new note")}`);
  else console.log(`  new note landed: ${check(await seen(out.commitment), "new note landed")}, refund note unused: ${check(!(await seen(back.commitment)), "refund unused")}`);
  const ethLeft = await client.getBalance({ address: ROUTER });
  console.log(`  router holds ${formatUnits(ethLeft, 18)} ETH, ${fmt(await balance(c.assetIn, ROUTER), c.assetIn)}, ${fmt(await balance(c.assetOut, ROUTER), c.assetOut)}; escrow ${fmt(await balance(c.assetIn, escrow), c.assetIn)}`);
  check(ethLeft === 0n && (await balance(c.assetIn, ROUTER)) === 0n && (await balance(c.assetOut, ROUTER)) === 0n, "router ends empty");
  check((await balance(c.assetIn, escrow)) === 0n, "escrow ends empty");
}

// ── the fork ──────────────────────────────────────────────────────────────────
// Robinhood Chain's blocks carry no blob fields, which anvil wants on the head: one local block has them.
await raw("evm_mine");
for (const a of [OWNER, RELAYER, DEPOSITOR, STRANGER, POOL_MANAGER]) {
  await raw("anvil_impersonateAccount", [a]);
  await raw("anvil_setBalance", [a, toHex(parseUnits("100", 18))]);
}
const feeBps = BigInt(await readVault("withdrawFeeBps"));
const head = await client.getBlock();
// anvil keeps its own gas price: the dollar line below uses the chain's, read upstream
const upstream = createPublicClient({ transport: http(cfg.fork, { timeout: 30_000 }) });
const liveGasPrice = await upstream.getGasPrice();
console.log(`${chainFx.name} fork at block ${head.number}, live vault ${VAULT}, cash-out fee ${feeBps} bps, chain gas price ${formatUnits(liveGasPrice, 9)} gwei`);

// The router, as the deploy page sends it: the same factory call, from the owner.
const script = execFileSync(
  `${homedir()}/.foundry/bin/forge`,
  ["script", "script/DeployVaultSwapV4c.s.sol:DeployVaultSwapV4c", "--sig", "initCode(uint256)", String(cfg.id), "--json"],
  { cwd: new URL("../../contracts", import.meta.url).pathname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" } }
);
const initCode = (Object.values(JSON.parse(script.split("\n").filter((l) => l.startsWith("{")).pop()!).returns)[0] as { value: Hex }).value;
const deploy = await tx(OWNER, FACTORY, `${SALT}${initCode.slice(2)}` as Hex);
const deployHash = deploy.transactionHash;
const code = await client.getCode({ address: ROUTER });
console.log(`router through the factory: ${check(deploy.status === "success" && Boolean(code && code.length > 2), "router deployed at the pinned address")} at ${ROUTER}, gas ${deploy.gasUsed}`);
if (!code || code.length <= 2) throw new Error("no router at the pinned address: was the last `forge build` a plain one?");

// Robinhood Chain's native ETH limit is queued: run it the real way, past its timelock.
if (cfg.id === 4663) {
  const call = encodeFunctionData({ abi: vaultAbi, functionName: "setDepositLimit", args: [NATIVE, 11n * 10n ** 18n, 110n * 10n ** 18n] });
  const eta = BigInt(await readVault("changeEta", [await readVault("changeId", [call])]));
  await raw("evm_setNextBlockTimestamp", [Number(eta) + 60]);
  const r = await tx(OWNER, VAULT, encodeFunctionData({ abi: vaultAbi, functionName: "executeChange", args: [call] }));
  console.log(`vault: the queued native ETH limit, past its timelock: ${check(r.status === "success", "ETH limit executed")}`);
}

// ONLY=<words> runs just the cases whose name has them.
const cases = cfg.cases.filter((x) => x.name.includes(process.env.ONLY ?? ""));
for (const c of cases) {
  try {
    await runCase(c, feeBps);
  } catch (e) {
    failures.push(`${c.name}: ${(e as Error).message}`);
    console.log(`  FAILED: ${(e as Error).message}`);
  }
}

console.log(`\nGas on ${chainFx.name} (real proofs, live vault):`);
const rows = gasRows.map((g) => ({ ...g, usd: (Number(g.gas) * Number(liveGasPrice) * ETH_PRICE) / 1e18 }));
for (const r of rows) console.log(`  ${String(r.gas).padStart(8)} gas  $${r.usd.toFixed(4)} at ${(Number(liveGasPrice) / 1e9).toFixed(3)} gwei, ETH $${ETH_PRICE}, ${r.calldata} bytes  ${r.name}`);
console.log(failures.length ? `\nFAILED:\n  ${failures.join("\n  ")}` : `\nALL CHECKS PASSED (${cases.length} cases, a local fork, nothing broadcast, no key used)`);
process.exit(failures.length ? 1 : 0);
