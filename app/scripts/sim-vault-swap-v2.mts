/**
 * Private swaps v2 (GloamVaultSwapV4b), end to end against live Robinhood Chain
 * mainnet state, with REAL Groth16 proofs (the production circuits and the
 * ceremony-final zkeys) checked by the REAL verifiers the live vault calls.
 * It runs as eth_simulateV1 on the public RPC: nothing is broadcast and no
 * key is used anywhere.
 *
 * State overrides, and only these:
 *  - v2's runtime code at an unused address: the compiled artifact with its
 *    four immutables filled in (the live vault, treasury, PoolManager and WETH),
 *    byte for byte what the constructor leaves, and the storage the constructor
 *    writes: its owner (the vault's owner, standing in for whoever Duke names)
 *    and the 41 deploy pools live from the deploy, poolLiveAt[id] = deploy time;
 *  - one vault slot: knownRoots[root] = true for a tree holding the synthetic
 *    input notes (the same single slot the v1 harness used);
 *  - ETH for a depositor account, which wraps it into WETH (an account balance).
 * Everything else runs the real way, in the order Duke would at go-live:
 *  block 1 (now): the vault owner queues the vault's deposit limits for WETH,
 *    SPY and AMZN (the values script/archive/QueueSwapAssets.s.sol proposes) through its 3-day
 *    timelock, and the router owner queues one more pool, v1's 0.0087% ETH/USDG
 *    pool; a swap through it is refused (PoolNotAllowed);
 *  block 2 (3 days and a minute later): the vault owner executes the limits, a
 *    depositor wraps ETH and shields WETH with a real shield proof (so the vault
 *    holds real, backed WETH), then the swaps go through the router as the relay
 *    sends them, with the app's own quotes and routes.
 *
 * With --listed, the cases are PONS and CASHCAT both ways against USDG: real
 * shield proofs back each note the way the WETH one is, with the tokens moved to
 * the depositor from the PoolManager (validation is off, so no key).
 *
 * Run from app/ after `forge build` in contracts/:
 *   ../mcp/node_modules/.bin/tsx scripts/sim-vault-swap-v2.mts [--listed]
 */
import "./browser-shim.mts";
import { readFileSync } from "node:fs";
import * as snarkjs from "snarkjs";
import {
  createPublicClient,
  decodeAbiParameters,
  decodeErrorResult,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  http,
  keccak256,
  pad,
  parseAbi,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  IncrementalMerkleTreePoseidon,
  buildPoseidonUnshieldWitness,
  fieldToBytes32,
  makeBoundNotePoseidon,
  packGroth16Proof,
  type Groth16Proof,
} from "@gloamtrade/sdk";

const swapLib = await import("../src/lib/vaultSwap");
const { shieldPoolAbi } = await import("../src/lib/shield");
const { planVaultSwap, escrowAddress, encodeRoute, refundAmountFor, vaultSwapAbi, routeCurrencies, swapRouterFor } = swapLib;

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const VAULT: Address = "0x39e28cde55cab798874746ac52cb4b5cc99a0194";
const TREASURY: Address = "0xB3900ac9350903218e4c7597bAb0f008F01B30B8";
const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const QUOTER: Address = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const GLOAM: Address = "0xDcD885F5c60b3aD49F6D58718696417314e8724d";
const WETH: Address = swapLib.RH_WETH;
const SPY: Address = "0x117cc2133c37b721f49de2a7a74833232b3b4c0c";
const AMZN: Address = "0x12f190a9f9d7d37a250758b26824b97ce941bf54";
const PONS: Address = "0x39dBED3a2bd333467115dE45665cC57F813C4571";
const CASHCAT: Address = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
const LISTED = process.argv.includes("--listed");
const RELAYER: Address = "0xb1E994586E62994648a0b866BF33F2EDd942512e";
const STRANGER: Address = "0x000000000000000000000000000000000000dEaD";
const DEPOSITOR: Address = "0x00000000000000000000000000000000De90517e";
/** An address with no code, no nonce and no balance on Robinhood Chain (checked below). */
const ROUTER: Address = "0x5157ab2b00000000000000000000000000000002";
const KNOWN_ROOTS_SLOT = 46n; // vault: tree at slot 4, its knownRoots mapping 42 slots in (forge inspect)
const ROUTER_OWNER_SLOT = 1n; // GloamVaultSwapV4b: _entered 0, owner 1, pendingOwner 2, poolLiveAt 3
const POOL_LIVE_AT_SLOT = 3n;
/** v1's ETH/USDG 0.0087% pool: not one of v2's deploy pools, so the router owner queues it here. */
const LATE_POOL = { currency0: "0x0000000000000000000000000000000000000000", currency1: USDG, fee: 87, tickSpacing: 1, hooks: "0x0000000000000000000000000000000000000000" } as const;
const DELAY = 3n * 24n * 3600n;

const client = createPublicClient({ transport: http(RPC, { timeout: 90_000, retryCount: 3 }) });
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function totalSupply() view returns (uint256)",
]);
const wethAbi = parseAbi(["function deposit() payable"]);
const vaultGov = parseAbi([
  "function owner() view returns (address)",
  "function queueChange(bytes call) returns (bytes32 id, uint256 eta)",
  "function executeChange(bytes call)",
  "function setDepositLimit(address asset, uint128 perDeposit, uint128 total)",
  "function depositLimit(address) view returns (uint128 perDeposit, uint128 total)",
  "function deposited(address) view returns (uint256)",
  "function feesOwed(address) view returns (uint256)",
  "function withdrawFeeBps() view returns (uint16)",
  "function shieldBound(address asset, uint256 amount, bytes32 commitment, bytes proof) payable",
]);
const v2Abi = parseAbi([
  "function queuePool((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) returns (bytes32)",
  "function allowedPool(bytes32) view returns (bool)",
  "function owner() view returns (address)",
  "function vault() view returns (address)",
  "function treasury() view returns (address)",
  "function poolManager() view returns (address)",
  "function weth() view returns (address)",
  "event VaultSwap(bytes32 indexed nullifier, bytes32 indexed commitment, address indexed assetIn, address assetOut, uint256 amountIn, uint256 amountOut, uint256 leftover)",
  "event VaultSwapRefund(bytes32 indexed nullifier, bytes32 indexed commitment, address indexed asset, uint256 amount)",
  "error PoolNotAllowed(bytes32 poolId)",
]);

const label: Record<string, [string, number]> = {
  [USDG.toLowerCase()]: ["USDG", 6],
  [GLOAM.toLowerCase()]: ["GLOAM", 18],
  [WETH.toLowerCase()]: ["WETH", 18],
  [SPY.toLowerCase()]: ["SPY", 18],
  [AMZN.toLowerCase()]: ["AMZN", 18],
  [PONS.toLowerCase()]: ["PONS", 18],
  [CASHCAT.toLowerCase()]: ["CASHCAT", 18],
};
const byId = (prefix: string) => {
  const k = [...swapLib.RH_SWAP_POOLS_V2, LATE_POOL].find((x) => swapLib.poolId(x).startsWith(prefix));
  if (!k) throw new Error(`no v2 pool ${prefix}`);
  return k;
};
const fmt = (v: bigint, a: Address) => {
  const [s, d] = label[a.toLowerCase()]!;
  return `${formatUnits(v, d)} ${s}`;
};
const sym = (a: Address) => (a === "0x0000000000000000000000000000000000000000" ? "ETH" : label[a.toLowerCase()]![0]);

// ── v2's runtime code: the artifact with its immutables filled in ─────────────
const artifact = JSON.parse(
  readFileSync(new URL("../../contracts/out/GloamVaultSwapV4b.sol/GloamVaultSwapV4b.json", import.meta.url), "utf8")
) as { deployedBytecode: { object: Hex; immutableReferences: Record<string, { start: number; length: number }[]> } };
const code = Buffer.from(artifact.deployedBytecode.object.slice(2), "hex");
// AST ids in declaration order: GloamVaultSwap.vault, .treasury, then V4b.poolManager, .weth
const refIds = Object.keys(artifact.deployedBytecode.immutableReferences).sort((a, b) => Number(a) - Number(b));
if (refIds.length !== 4) throw new Error("expected four immutables");
[VAULT, TREASURY, POOL_MANAGER, WETH].forEach((value, i) => {
  const word = Buffer.from(pad(value.toLowerCase() as Hex, { size: 32 }).slice(2), "hex");
  for (const r of artifact.deployedBytecode.immutableReferences[refIds[i]!]!) word.copy(code, r.start);
});
const runtime = `0x${code.toString("hex")}` as Hex;

// ── live state checks ─────────────────────────────────────────────────────────
const [rCode, rNonce, rBal] = await Promise.all([
  client.getCode({ address: ROUTER }),
  client.getTransactionCount({ address: ROUTER }),
  client.getBalance({ address: ROUTER }),
]);
if ((rCode && rCode !== "0x") || rNonce !== 0 || rBal !== 0n) throw new Error("the router address is in use");
const slotFor = (root: bigint) => keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [root, KNOWN_ROOTS_SLOT]));
const currentRoot = BigInt((await client.getStorageAt({ address: VAULT, slot: pad("0x05") }))!);
const knownFlag = BigInt((await client.getStorageAt({ address: VAULT, slot: slotFor(currentRoot) }))!);
if (knownFlag !== 1n) throw new Error("vault storage layout does not match");
const head = await client.getBlock();
const vaultOwner = await client.readContract({ address: VAULT, abi: vaultGov, functionName: "owner" });
const feeBps = Number(await client.readContract({ address: VAULT, abi: vaultGov, functionName: "withdrawFeeBps" }));
const wethLimit = await client.readContract({ address: VAULT, abi: vaultGov, functionName: "depositLimit", args: [WETH] });
console.log(`Robinhood Chain block ${head.number}, vault owner ${vaultOwner}, cash-out fee ${feeBps} bps`);
console.log(`vault WETH limit now: ${wethLimit[0]}/${wethLimit[1]} (not taken yet), layout check ok, router address unused`);

// The app's own planner, for v2 at the simulated address (its allowlist read
// fails there before deploy, so every listed pool counts, as on chain once live).
swapLib.VAULT_SWAP_V2_ROUTER[4663] = ROUTER;
swapLib.VAULT_SWAP_ROUTERS[4663] = ROUTER;
const r2 = swapRouterFor(4663, ROUTER)!;
if (r2.version !== 2) throw new Error("v2 config missing");
// the router as it is once the late pool is live too, for the route checks of case Q
const r2late = { ...r2, pools: [...r2.pools, LATE_POOL] };

async function prove(name: "shield" | "unshield", input: Record<string, unknown>) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input as never,
    `public/circuits/${name}.wasm`,
    `public/circuits/final/${name}_final.zkey`
  );
  const vkey = JSON.parse(readFileSync(`public/circuits/final/${name}_vkey.json`, "utf8"));
  if (!(await snarkjs.groth16.verify(vkey, publicSignals, proof))) throw new Error(`${name} proof failed locally`);
  return packGroth16Proof(proof as Groth16Proof);
}
const shieldProof = (n: { commitment: string; secret: string }, amount: bigint, asset: Address) =>
  prove("shield", {
    commitment: BigInt(n.commitment).toString(),
    amount: amount.toString(),
    asset: BigInt(asset).toString(),
    secret: BigInt(n.secret).toString(),
  });

// ── the synthetic input notes, one tree, one root ─────────────────────────────
type Case = { name: string; assetIn: Address; assetOut: Address; amountIn: bigint; forceRoute?: string[]; refund?: boolean };
const QUEUED_POOL_CASE: Case = { name: "Q. USDG -> WETH, a pool queued after deploy", assetIn: USDG, assetOut: WETH, amountIn: parseUnits("5", 6), forceRoute: ["0x3b0cbf06"] };
const LISTED_CASES: Case[] = [
  { name: "L1. USDG -> PONS", assetIn: USDG, assetOut: PONS, amountIn: parseUnits("20", 6) },
  { name: "L2. PONS -> USDG", assetIn: PONS, assetOut: USDG, amountIn: parseUnits("400", 18) },
  { name: "L3. USDG -> CASHCAT", assetIn: USDG, assetOut: CASHCAT, amountIn: parseUnits("20", 6) },
  { name: "L4. CASHCAT -> USDG", assetIn: CASHCAT, assetOut: USDG, amountIn: parseUnits("1000", 18) },
];
const CASES: Case[] = LISTED ? [QUEUED_POOL_CASE, ...LISTED_CASES] : [
  // through the pool queued in block 1: refused there, through 3 days later
  QUEUED_POOL_CASE,
  { name: "A. USDG -> WETH", assetIn: USDG, assetOut: WETH, amountIn: parseUnits("5", 6) },
  { name: "B. WETH -> USDG", assetIn: WETH, assetOut: USDG, amountIn: parseUnits("0.004", 18) },
  // the same pair forced through native ETH (the 0.05% hub), so the unwrap path runs whatever the best pool is today
  { name: "B2. WETH -> USDG, through ETH", assetIn: WETH, assetOut: USDG, amountIn: parseUnits("0.004", 18), forceRoute: ["0x387bf619"] },
  { name: "C. WETH -> GLOAM", assetIn: WETH, assetOut: GLOAM, amountIn: parseUnits("0.003", 18) },
  // three hops, forced: WETH -> USDG (WETH pool) -> ETH (0.01% pool) -> GLOAM (launch pool, Orynth hook)
  {
    name: "D. WETH -> GLOAM, 3 hops",
    assetIn: WETH,
    assetOut: GLOAM,
    amountIn: parseUnits("0.003", 18),
    forceRoute: ["0x84bd4e2d", "0x24107d15", "0xc5f37371"],
  },
  { name: "E. WETH -> USDG, griefed", assetIn: WETH, assetOut: USDG, amountIn: parseUnits("0.002", 18), refund: true },
  // a Robinhood stock token, by the app's own route
  { name: "F. USDG -> SPY", assetIn: USDG, assetOut: SPY, amountIn: parseUnits("20", 6) },
  // a stock token through a Fables pool (its hook sets the fee each swap), forced
  { name: "G. USDG -> AMZN, Fables pool", assetIn: USDG, assetOut: AMZN, amountIn: parseUnits("20", 6), forceRoute: ["0x5619cb84"] },
];
const tree = new IncrementalMerkleTreePoseidon();
await tree.init();
const notes: { note: Awaited<ReturnType<typeof makeBoundNotePoseidon>>; leaf: number }[] = [];
for (const c of CASES) {
  const note = await makeBoundNotePoseidon(c.amountIn, c.assetIn);
  const leaf = await tree.insert(note.commitmentField);
  notes.push({ note, leaf });
}

const PATH_KEY = [
  { name: "intermediateCurrency", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
  { name: "hookData", type: "bytes" },
] as const;
const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "nonpayable",
    inputs: [{ name: "p", type: "tuple", components: [{ name: "exactCurrency", type: "address" }, { name: "path", type: "tuple[]", components: PATH_KEY }, { name: "exactAmount", type: "uint128" }] }],
    outputs: [{ type: "uint256" }, { type: "uint256" }],
  },
  {
    type: "function",
    name: "quoteExactOutput",
    stateMutability: "nonpayable",
    inputs: [{ name: "p", type: "tuple", components: [{ name: "exactCurrency", type: "address" }, { name: "path", type: "tuple[]", components: PATH_KEY }, { name: "exactAmount", type: "uint128" }] }],
    outputs: [{ type: "uint256" }, { type: "uint256" }],
  },
] as const;

/** A plan on a fixed route, priced the way planVaultSwap prices its best one. */
async function planForced(c: Case) {
  const route = c.forceRoute!.map(byId);
  const path = routeCurrencies(r2late, c.assetIn, c.assetOut, route);
  if (!path) throw new Error("the forced route is not one the router takes");
  const available = c.amountIn - swapLib.vaultFeeOf(c.amountIn, feeBps);
  const hop = (i: number, exactIn: boolean) => ({
    intermediateCurrency: exactIn ? path[i + 1]! : path[i]!,
    fee: route[i]!.fee,
    tickSpacing: route[i]!.tickSpacing,
    hooks: route[i]!.hooks,
    hookData: "0x" as Hex,
  });
  const { result: q } = await client.simulateContract({
    address: QUOTER,
    abi: quoterAbi,
    functionName: "quoteExactInput",
    args: [{ exactCurrency: path[0]!, path: route.map((_, i) => hop(i, true)), exactAmount: available }],
  });
  const amountOut = (q[0] * (10_000n - BigInt(swapLib.swapBufferBps(4663)))) / 10_000n;
  const { result: o } = await client.simulateContract({
    address: QUOTER,
    abi: quoterAbi,
    functionName: "quoteExactOutput",
    args: [{ exactCurrency: path[route.length]!, path: route.map((_, i) => hop(i, false)), exactAmount: amountOut }],
  });
  return { router: ROUTER, available, amountOut, cost: o[0], leftover: available - o[0], route };
}

// ── every swap's proofs, made the way the app makes them ──────────────────────
type Built = Case & {
  plan: Awaited<ReturnType<typeof planForced>>;
  escrow: Address;
  nullifier: Hex;
  root: Hex;
  data: Hex;
  unshieldAlone: Hex;
  out: Hex;
  back: Hex;
  backAmount: bigint;
};
/** Prices one case with the app's planner (or on its forced route) and makes its proofs. */
async function build(i: number): Promise<Built> {
  const c = CASES[i]!;
  const { note, leaf } = notes[i]!;
  const plan = c.forceRoute
    ? await planForced(c)
    : await planVaultSwap(client as never, 4663, { assetIn: c.assetIn, assetOut: c.assetOut, amountIn: c.amountIn, feeBps, router: ROUTER });
  const path = routeCurrencies(r2late, c.assetIn, c.assetOut, plan.route)!;
  const out = await makeBoundNotePoseidon(plan.amountOut, c.assetOut);
  const backAmount = refundAmountFor(c.amountIn);
  const back = await makeBoundNotePoseidon(backAmount, c.assetIn);
  const routeBytes = encodeRoute(plan.route);
  const key = {
    nullifier: note.nullifier as Hex,
    amountIn: c.amountIn,
    outCommitment: out.commitment as Hex,
    assetOut: c.assetOut,
    amountOut: plan.amountOut,
    refundCommitment: back.commitment as Hex,
    refundAmount: backAmount,
    routeHash: keccak256(routeBytes),
  };
  const escrow = escrowAddress(ROUTER, c.assetIn, key);
  const merkle = await tree.path(leaf);
  const w = await buildPoseidonUnshieldWitness({ secretHex: note.secret as Hex, amount: c.amountIn, asset: c.assetIn, to: escrow, path: merkle });
  if (!w.checks.commitmentMatches) throw new Error("witness does not open the note");
  const [unProof, outProof, backProof] = await Promise.all([
    prove("unshield", w.circomInput),
    shieldProof(out, plan.amountOut, c.assetOut),
    shieldProof(back, backAmount, c.assetIn),
  ]);
  const root = fieldToBytes32(w.publicInputs.root);
  const nullifier = fieldToBytes32(w.publicInputs.nullifier);
  const spend = { proof: unProof, root, nullifier, asset: c.assetIn, amount: c.amountIn };
  const deposit = { proof: outProof, commitment: out.commitment as Hex, asset: c.assetOut, amount: plan.amountOut };
  const refund = { proof: backProof, commitment: back.commitment as Hex, asset: c.assetIn, amount: backAmount };
  const b: Built = {
    ...c,
    plan,
    escrow,
    nullifier,
    root,
    out: deposit.commitment,
    back: refund.commitment,
    backAmount,
    // exactly what the relay sends: swap(spend, deposit, refund, routeBytes)
    data: encodeFunctionData({ abi: vaultSwapAbi, functionName: "swap", args: [spend, deposit, refund, routeBytes] }),
    unshieldAlone: encodeFunctionData({ abi: shieldPoolAbi, functionName: "unshield", args: [unProof, root, nullifier, c.assetIn, escrow, c.amountIn] }),
  };
  console.log(
    `${c.name}: quote ${fmt(c.amountIn, c.assetIn)} -> ${fmt(plan.amountOut, c.assetOut)} via ${path.map(sym).join(" > ")}` +
      ` (pool fees ${plan.route.map((k) => k.fee).join(", ")}), cost ${fmt(plan.cost, c.assetIn)} of ${fmt(plan.available, c.assetIn)}`
  );
  return b;
}
// every note sits in one tree: one root, the one vault slot overridden
const ROOT = fieldToBytes32(tree.currentRoot);

// the depositor's WETH, with a real shield proof
const depositAmount = parseUnits("0.02", 18);
const depNote = await makeBoundNotePoseidon(depositAmount, WETH);
const depProof = await shieldProof(depNote, depositAmount, WETH);
// and with --listed, the PONS and CASHCAT that back the notes those cases spend
const backing = LISTED
  ? await Promise.all(
      ([[PONS, parseUnits("1000", 18)], [CASHCAT, parseUnits("2000", 18)]] as const).map(async ([asset, amount]) => {
        const note = await makeBoundNotePoseidon(amount, asset);
        return { asset, amount, note, proof: await shieldProof(note, amount, asset) };
      })
    )
  : [];

// ── the simulation ─────────────────────────────────────────────────────────────
type Call = { from: Address; to: Address; data: Hex; value?: Hex };
type SimCall = { status: string; returnData: Hex; gasUsed: string; logs?: { address: Address; topics: Hex[]; data: Hex }[]; error?: { message?: string; data?: Hex } };
const read = (to: Address, data: Hex): Call => ({ from: STRANGER, to, data });
const bal = (token: Address, who: Address) => read(token, encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [who] }));
const seen = (c: Hex) => read(VAULT, encodeFunctionData({ abi: shieldPoolAbi, functionName: "commitmentSeen", args: [c] }));
const dep = (a: Address) => read(VAULT, encodeFunctionData({ abi: vaultGov, functionName: "deposited", args: [a] }));
const owed = (a: Address) => read(VAULT, encodeFunctionData({ abi: vaultGov, functionName: "feesOwed", args: [a] }));
// the deposit limits PR #13 (script/archive/QueueSwapAssets.s.sol) proposes for these three
const limitCalls = (
  [
    [WETH, 420000000000000000n, 10000000000000000000n],
    [SPY, 1300000000000000000n, 33000000000000000000n],
    [AMZN, 4000000000000000000n, 100000000000000000000n],
  ] as const
).map(([a, per, total]) => encodeFunctionData({ abi: vaultGov, functionName: "setDepositLimit", args: [a, per, total] }));

const ASSETS = [USDG, GLOAM, WETH, SPY, AMZN, ...(LISTED ? [PONS, CASHCAT] : [])];
console.log("\nQuotes, each made just before its own simulation, as the app prices a swap again just before it goes:");
const first = await build(0);
if (first.root.toLowerCase() !== ROOT.toLowerCase()) throw new Error("expected one root");
const block1: Call[] = [
  ...limitCalls.map((c) => ({ from: vaultOwner, to: VAULT, data: encodeFunctionData({ abi: vaultGov, functionName: "queueChange", args: [c] }) })),
  { from: vaultOwner, to: ROUTER, data: encodeFunctionData({ abi: v2Abi, functionName: "queuePool", args: [LATE_POOL] }) },
  read(ROUTER, encodeFunctionData({ abi: v2Abi, functionName: "allowedPool", args: [swapLib.poolId(LATE_POOL)] })),
  { from: RELAYER, to: ROUTER, data: first.data }, // through the queued pool, not live yet: refused
  read(ROUTER, encodeFunctionData({ abi: v2Abi, functionName: "allowedPool", args: [swapLib.poolId(byId("0x387bf619"))] })),
  read(ROUTER, encodeFunctionData({ abi: v2Abi, functionName: "vault" })),
  read(ROUTER, encodeFunctionData({ abi: v2Abi, functionName: "treasury" })),
  read(ROUTER, encodeFunctionData({ abi: v2Abi, functionName: "poolManager" })),
  read(ROUTER, encodeFunctionData({ abi: v2Abi, functionName: "weth" })),
  read(ROUTER, encodeFunctionData({ abi: v2Abi, functionName: "owner" })),
];
// Reads between the swaps go out as one Multicall3 call each, so the request stays small.
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const mc3 = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const readAll = (calls: Call[]): Call =>
  read(MULTICALL3, encodeFunctionData({ abi: mc3, functionName: "aggregate3", args: [calls.map((c) => ({ target: c.to, allowFailure: false, callData: c.data }))] }));
const words = (c: SimCall): bigint[] => {
  const [out] = decodeAbiParameters([{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }], c.returnData) as unknown as [[boolean, Hex][]];
  return out.map(([, data]) => BigInt(data));
};
/** treasury, router, vault deposited, vault balance and owed fees, for each asset. */
const snapshot = (): Call =>
  readAll([
    ...ASSETS.map((a) => bal(a, TREASURY)),
    ...ASSETS.map((a) => bal(a, ROUTER)),
    ...ASSETS.map((a) => dep(a)),
    ...ASSETS.map((a) => bal(a, VAULT)),
    ...ASSETS.map((a) => owed(a)),
  ]);
const block2Head: Call[] = [
  ...limitCalls.map((c) => ({ from: vaultOwner, to: VAULT, data: encodeFunctionData({ abi: vaultGov, functionName: "executeChange", args: [c] }) })),
  { from: DEPOSITOR, to: WETH, data: encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), value: toHex(depositAmount) },
  { from: DEPOSITOR, to: WETH, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [VAULT, depositAmount] }) },
  { from: DEPOSITOR, to: VAULT, data: encodeFunctionData({ abi: vaultGov, functionName: "shieldBound", args: [WETH, depositAmount, depNote.commitment as Hex, depProof] }) },
  ...backing.flatMap((b): Call[] => [
    { from: POOL_MANAGER, to: b.asset, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [DEPOSITOR.toLowerCase() as Address, b.amount] }) },
    { from: DEPOSITOR, to: b.asset, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [VAULT, b.amount] }) },
    { from: DEPOSITOR, to: VAULT, data: encodeFunctionData({ abi: vaultGov, functionName: "shieldBound", args: [b.asset, b.amount, b.note.commitment as Hex, b.proof] }) },
  ]),
];

let lastBase = 0n;
// what the constructor writes: the owner, and each deploy pool live from the deploy
const deployedAt = head.timestamp - 60n;
const routerStorage: Record<Hex, Hex> = { [pad(toHex(ROUTER_OWNER_SLOT))]: pad(vaultOwner) };
for (const k of swapLib.RH_SWAP_POOLS_V2) {
  const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [swapLib.poolId(k), POOL_LIVE_AT_SLOT]));
  routerStorage[slot] = pad(toHex(deployedAt));
}

/** The public RPC turns away bursts and heavy requests with a 429: wait, then try again. */
async function patiently<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= 8 || !String((e as Error)?.message ?? e).includes("Too Many Requests")) throw e;
      await new Promise((r) => setTimeout(r, Math.min(15_000 * 2 ** i, 120_000)));
    }
  }
}

/**
 * One simulation per swap, each from live state: block 1 (governance), then
 * block 2 (the limit executed, the WETH deposit, the swap). The RPC turns a
 * single request with every swap in it away as too heavy.
 */
async function simulate(block1: Call[], block2: Call[]): Promise<[SimCall[], SimCall[]]> {
  // on top of one fixed recent block, so the simulated blocks' times follow it
  const base = await patiently(() => client.getBlock());
  const time1 = base.timestamp + 1n;
  lastBase = base.number;
  const res = (await patiently(() =>
    client.request({
      method: "eth_simulateV1" as never,
      params: [
        {
          blockStateCalls: [
            {
              blockOverrides: { time: toHex(time1) },
              stateOverrides: {
                [ROUTER]: { code: runtime, stateDiff: routerStorage },
                [VAULT]: { stateDiff: { [slotFor(BigInt(ROOT))]: pad("0x01") } },
                [DEPOSITOR]: { balance: toHex(parseUnits("1", 18)) },
              },
              calls: block1,
            },
            { blockOverrides: { time: toHex(time1 + DELAY + 60n) }, calls: block2 },
          ],
          traceTransfers: true,
          validation: false,
        },
        toHex(base.number),
      ] as never,
    })
  )) as { calls: SimCall[] }[];
  return [res[0]!.calls, res[1]!.calls];
}

const ok = (c: SimCall) => c.status === "0x1";
const num = (c: SimCall) => BigInt(c.returnData);
/** A revert in plain words: the router's, the vault's or the escrow's error, decoded. */
const why = (c: SimCall) => {
  const data = (c.error?.data ?? c.returnData) as Hex | undefined;
  if (data && data.length >= 10) {
    for (const abi of [v2Abi, vaultSwapAbi, shieldPoolAbi] as const) {
      try {
        const e = decodeErrorResult({ abi: abi as never, data });
        return `${e.errorName}(${((e.args as unknown[]) ?? []).join(", ")})`;
      } catch {
        /* another abi */
      }
    }
  }
  return c.error?.message ?? "reverted";
};

const NL = limitCalls.length;
const govCalls = block1.slice(0, NL + 1);
const [b1, head2] = await simulate(block1, block2Head);

console.log(`\nBlock 1 (now)`);
const limitsQueued = b1.slice(0, NL);
console.log(`  vault queueChange(setDepositLimit) for WETH, SPY, AMZN: ${limitsQueued.map((c) => (ok(c) ? "ok" : why(c))).join(", ")}`);
const queued = b1.slice(NL, NL + 1);
console.log(`  router queuePool(v1's 0.0087% ETH/USDG pool): ${queued.every(ok) ? "ok" : why(queued[0]!)}`);
const iq = NL + 1;
console.log(`  allowedPool(that pool) right after queueing: ${num(b1[iq]!) === 1n}`);
const early = b1[iq + 1]!;
console.log(`  swap Q through it, before the delay: ${ok(early) ? "WENT THROUGH (wrong)" : `refused, ${why(early)}`}`);
console.log(`  allowedPool(0.05% ETH/USDG hub, a deploy pool): ${num(b1[iq + 2]!) === 1n}`);
const addr = (c: SimCall) => `0x${c.returnData.slice(-40)}`.toLowerCase();
console.log(
  `  injected router reads vault ${addr(b1[iq + 3]!) === VAULT.toLowerCase()}, treasury ${addr(b1[iq + 4]!) === TREASURY.toLowerCase()}, ` +
    `poolManager ${addr(b1[iq + 5]!) === POOL_MANAGER.toLowerCase()}, weth ${addr(b1[iq + 6]!) === WETH.toLowerCase()}, owner ${addr(b1[iq + 7]!) === vaultOwner.toLowerCase()}`
);

console.log(`\nBlock 2 (3 days and a minute later)`);
const executed = head2.slice(0, NL);
console.log(`  vault executeChange for the three limits: ${executed.map((c) => (ok(c) ? "ok" : why(c))).join(", ")}`);
const [wrap, approve, shield] = head2.slice(NL, NL + 3);
console.log(`  depositor wraps 0.02 ETH: ${ok(wrap!) ? "ok" : why(wrap!)}, approve ${ok(approve!) ? "ok" : why(approve!)}, shieldBound(WETH, real proof): ${ok(shield!) ? "ok" : why(shield!)}`);

let allGood =
  limitsQueued.every(ok) && queued.every(ok) && num(b1[iq]!) === 0n && !ok(early) && why(early).startsWith("PoolNotAllowed") && num(b1[iq + 2]!) === 1n;
allGood &&= executed.every(ok) && ok(shield!);
if (LISTED) {
  const backed = head2.slice(NL + 3, NL + 3 + 3 * backing.length);
  console.log(`  PONS and CASHCAT moved, approved and shielded with real proofs: ${backed.map((c) => (ok(c) ? "ok" : why(c))).join(", ")}`);
  allGood &&= backed.length === 3 * backing.length && backed.every(ok);
}
allGood &&= [VAULT, TREASURY, POOL_MANAGER, WETH, vaultOwner].every((a, i) => addr(b1[iq + 3 + i]!) === a.toLowerCase());
const S = ASSETS.length;
for (let i = 0; i < CASES.length; i++) {
  // a pause between the heavy requests keeps the public RPC's limiter calm; it
  // comes before the quote, so each swap goes out seconds after it is priced
  await new Promise((r) => setTimeout(r, 15_000));
  const b = i === 0 ? first : await build(i);
  // this swap alone after the same go-live steps, from live state
  const block2 = [...block2Head, snapshot()];
  const m = { name: b.name, before: block2.length - 1, alone: undefined as number | undefined, at: 0, after: 0 };
  if (b.refund) {
    m.alone = block2.length;
    block2.push({ from: STRANGER, to: VAULT, data: b.unshieldAlone });
  }
  m.at = block2.length;
  block2.push({ from: RELAYER, to: ROUTER, data: b.data });
  m.after = block2.length;
  block2.push(snapshot(), readAll([seen(b.out), seen(b.back), bal(b.assetIn, b.escrow)]));
  const [, b2] = await simulate(govCalls, block2);
  const call = b2[m.at]!;
  const pre = words(b2[m.before]!);
  const post = words(b2[m.after]!);
  const [outSeen, backSeen, escrowLeft] = words(b2[m.after + 1]!);
  const ai = ASSETS.findIndex((a) => a.toLowerCase() === b.assetIn.toLowerCase());
  const oi = ASSETS.findIndex((a) => a.toLowerCase() === b.assetOut.toLowerCase());
  console.log(`\n  ${m.name}: ${ok(call) ? "SUCCESS" : "REVERTED " + why(call)} (gas ${BigInt(call.gasUsed)})`);
  if (m.alone !== undefined) console.log(`    someone sent the unshield alone first: ${ok(b2[m.alone]!) ? "ok" : why(b2[m.alone]!)}`);
  if (!ok(call)) {
    allGood = false;
    continue;
  }
  let ev = null as { eventName: string; args: Record<string, bigint> } | null;
  for (const l of call.logs ?? []) {
    if (l.address.toLowerCase() !== ROUTER.toLowerCase()) continue;
    try {
      ev = decodeEventLog({ abi: v2Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as never;
    } catch {
      /* not ours */
    }
  }
  // traceTransfers: every ETH move as a Transfer log from 0xEeee…EEeE
  const ethLogs = (call.logs ?? []).filter((l) => l.address.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  const party = (l: { topics: Hex[] }, i: number) => `0x${l.topics[i]!.slice(26)}`.toLowerCase();
  const ethIn = ethLogs.filter((l) => party(l, 2) === ROUTER.toLowerCase()).reduce((t, l) => t + BigInt(l.data), 0n);
  const ethOut = ethLogs.filter((l) => party(l, 1) === ROUTER.toLowerCase()).reduce((t, l) => t + BigInt(l.data), 0n);
  const routerEth = ethLogs.filter((l) => party(l, 1) === ROUTER.toLowerCase() || party(l, 2) === ROUTER.toLowerCase());
  const routerEnds = post.slice(S, 2 * S);
  const backed = ASSETS.every((_, i) => post[3 * S + i]! >= post[2 * S + i]! + post[4 * S + i]!);
  const treasuryIn = post[ai]! - pre[ai]!;
  if (b.refund) {
    console.log(`    router ${ev?.eventName}: refund note ${fmt(b.backAmount, b.assetIn)} landed ${backSeen === 1n}, new note not made ${outSeen === 0n}`);
    const net = pre[2 * S + ai]! - post[2 * S + ai]!;
    console.log(
      `    vault ${sym(b.assetIn)} deposited -${fmt(net, b.assetIn)} net (the note's ${fmt(b.amountIn, b.assetIn)} out, the refund's ${fmt(b.backAmount, b.assetIn)} back in), ` +
        `treasury +${fmt(treasuryIn, b.assetIn)} (what arrived less the refund)`
    );
    allGood &&= backSeen === 1n && outSeen === 0n && net === b.amountIn - b.backAmount;
    allGood &&= treasuryIn === b.amountIn - swapLib.vaultFeeOf(b.amountIn, feeBps) - b.backAmount;
  } else {
    const spent = ev?.args.amountIn ?? 0n;
    console.log(`    router ${ev?.eventName}: spent ${fmt(spent, b.assetIn)}, delivered ${fmt(ev?.args.amountOut ?? 0n, b.assetOut)} (== quote: ${ev?.args.amountOut === b.plan.amountOut}), leftover ${fmt(ev?.args.leftover ?? 0n, b.assetIn)}`);
    console.log(`    new note in the vault ${outSeen === 1n}, refund note unused ${backSeen === 0n}; vault ${sym(b.assetOut)} deposited +${fmt(post[2 * S + oi]! - pre[2 * S + oi]!, b.assetOut)}, ${sym(b.assetIn)} -${fmt(pre[2 * S + ai]! - post[2 * S + ai]!, b.assetIn)}`);
    console.log(
      `    treasury +${fmt(treasuryIn, b.assetIn)} (event leftover ${fmt(ev?.args.leftover ?? 0n, b.assetIn)}); ` +
        `ETH through the router: ${routerEth.length} legs, in ${formatUnits(ethIn, 18)}, out ${formatUnits(ethOut, 18)}`
    );
    allGood &&= ethIn === ethOut;
    allGood &&= outSeen === 1n && backSeen === 0n && ev?.args.amountOut === b.plan.amountOut && treasuryIn === ev?.args.leftover;
    allGood &&= post[2 * S + oi]! - pre[2 * S + oi]! === b.plan.amountOut && pre[2 * S + ai]! - post[2 * S + ai]! === b.amountIn;
  }
  console.log(`    router ends with ${routerEnds.map((v, i) => fmt(v, ASSETS[i]!)).join(", ")}; escrow ends with ${fmt(escrowLeft!, b.assetIn)}; vault backs every note: ${backed}`);
  allGood &&= routerEnds.every((v) => v === 0n) && escrowLeft === 0n && backed;
}
console.log(`\n${allGood ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"} (eth_simulateV1 on blocks ${head.number} to ${lastBase}; nothing broadcast, no key used)`);
process.exit(allGood ? 0 : 1);
