/**
 * Private swaps through the SDK (@gloamtrade/sdk quoteSwap, buildSwapIntent,
 * readSwapOutcome, buildSwapRefund, buildSwapExit), end to end on a local anvil fork
 * of each chain, against the LIVE vault, with REAL Groth16 proofs (the production
 * circuits and the ceremony-final zkeys) checked by the REAL verifiers the vault calls.
 * What the SDK builds is sent by the relay's own code (lib/relay/server relayVaultSwap
 * and relayVaultSwapExit), as JSON the way it crosses the wire, and once through the
 * partner relay (lib/partnerRelay), so the SDK, the relay and the partner API are held
 * to the same call.
 *
 * Robinhood Chain: router v2 as it is deployed and switched on. Base and Ethereum:
 * GloamVaultSwapV4c goes in on the fork through the CREATE2 factory at its pinned
 * address, and its switch is turned on for this process only, in the app and the SDK.
 *
 * Each input note is a real deposit into the live vault, spent against the vault's
 * real root on a path worked out from its own filledSubtrees. Nothing is broadcast:
 * anvil impersonates the accounts it needs, and the relay key is a throwaway made here.
 *
 * Run from app/ after a plain `forge build` in contracts/:
 *   ../mcp/node_modules/.bin/tsx --tsconfig tsconfig.json scripts/fork-sdk-swaps.mts --chain robinhood | base | ethereum
 *   ONLY=<words> picks cases.
 */
import "./browser-shim.mts";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as snarkjs from "snarkjs";
import { createPublicClient, encodeFunctionData, formatUnits, http, keccak256, parseAbi, parseUnits, toHex, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey } from "viem/accounts";
import * as sdk from "@gloamtrade/sdk";

const arg = process.argv[process.argv.indexOf("--chain") + 1] ?? "robinhood";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const VAULT: Address = "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194";
const OWNER: Address = "0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8";
const DEPOSITOR: Address = "0x00000000000000000000000000000000de90517e";
const STRANGER: Address = "0x000000000000000000000000000000000000dEaD";
const EXIT_TO: Address = "0x00000000000000000000000000000000e4170000";
const FACTORY: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const SALT = keccak256(toHex("gloam.vault-swap.v3"));
const TREE_SLOT = 4n; // nextIndex 4, currentRoot 5, filledSubtrees 6.., zeros 26.. (forge inspect)

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type Kind = "relay" | "partner" | "refund" | "exit" | "floor";
type Case = { name: string; assetIn: Address; assetOut: Address; amountIn: bigint; kind: Kind };
type Cfg = { id: number; key: string; fork: string; port: number; poolManager: Address; deployRouter: boolean; syms: Record<string, [string, number]>; cases: Case[] };

const RU = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const RG = "0xDcD885F5c60b3aD49F6D58718696417314e8724d" as Address;
const RW = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
const BU = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const BT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" as Address;
const EU = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const ET = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address;

const CONFIGS: Record<string, Cfg> = {
  robinhood: {
    id: 4663, key: "robinhood-mainnet", fork: "https://rpc.mainnet.chain.robinhood.com", port: 8781, poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951", deployRouter: false,
    syms: { [RU.toLowerCase()]: ["USDG", 6], [RG.toLowerCase()]: ["GLOAM", 18], [RW.toLowerCase()]: ["WETH", 18] },
    cases: [
      { name: "USDG -> GLOAM, built by the SDK, sent by the relay", assetIn: RU, assetOut: RG, amountIn: parseUnits("100", 6), kind: "relay" },
      { name: "USDG -> WETH, sent through the partner relay and counted", assetIn: RU, assetOut: RW, amountIn: parseUnits("100", 6), kind: "partner" },
      { name: "USDG refund: the unshield sent alone, then the SDK's refund through the relay", assetIn: RU, assetOut: RG, amountIn: parseUnits("100", 6), kind: "refund" },
    ],
  },
  base: {
    id: 8453, key: "base-mainnet", fork: "https://gateway.tenderly.co/public/base", port: 8782, poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b", deployRouter: true,
    syms: { [NATIVE]: ["ETH", 18], [BU.toLowerCase()]: ["USDC", 6], [BT.toLowerCase()]: ["USDT", 6] },
    cases: [
      { name: "USDC -> USDT, built by the SDK, sent by the relay", assetIn: BU, assetOut: BT, amountIn: parseUnits("100", 6), kind: "relay" },
      { name: "USDC -> ETH (a native note out), through the partner relay", assetIn: BU, assetOut: NATIVE, amountIn: parseUnits("100", 6), kind: "partner" },
      { name: "USDC refund: the unshield sent alone, then the SDK's refund through the relay", assetIn: BU, assetOut: BT, amountIn: parseUnits("100", 6), kind: "refund" },
      { name: "USDC exit: the vault full for the refund, the SDK's exit through the relay", assetIn: BU, assetOut: BT, amountIn: parseUnits("100", 6), kind: "exit" },
    ],
  },
  ethereum: {
    id: 1, key: "ethereum-mainnet", fork: "https://gateway.tenderly.co/public/mainnet", port: 8783, poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90", deployRouter: true,
    syms: { [NATIVE]: ["ETH", 18], [EU.toLowerCase()]: ["USDC", 6], [ET.toLowerCase()]: ["USDT", 6] },
    cases: [
      { name: "a swap under the relay's floor is refused before any proof", assetIn: EU, assetOut: ET, amountIn: parseUnits("10", 6), kind: "floor" },
      { name: "USDC -> USDT at 5,000, over the floor, built by the SDK, sent by the relay", assetIn: EU, assetOut: ET, amountIn: parseUnits("5000", 6), kind: "relay" },
      { name: "USDT -> USDC at 5,000 (Tether as input), through the partner relay", assetIn: ET, assetOut: EU, amountIn: parseUnits("5000", 6), kind: "partner" },
      // over the floor too: the SDK builds no relayed swap under it
      { name: "USDC refund at 5,000: the unshield sent alone, then the SDK's refund through the relay", assetIn: EU, assetOut: ET, amountIn: parseUnits("5000", 6), kind: "refund" },
      { name: "USDT exit at 5,000: the vault full for the refund, the SDK's exit through the relay", assetIn: ET, assetOut: EU, amountIn: parseUnits("5000", 6), kind: "exit" },
    ],
  },
};
const cfg = CONFIGS[arg];
if (!cfg) throw new Error("--chain robinhood | base | ethereum");
// each chain's PoolManager, as the router's fixture pins it: it holds the tokens the deposits are made with
const fixture = JSON.parse(readFileSync(new URL("../../contracts/test/fixtures/router-next.json", import.meta.url), "utf8"));
const pinnedManager = fixture.chains[cfg.id]?.poolManager as Address | undefined;
if (pinnedManager && !same(pinnedManager, cfg.poolManager)) throw new Error(`PoolManager ${cfg.poolManager} is not the fixture's ${pinnedManager}`);

// The relay's code, pointed at this fork, with a throwaway key that exists only here.
process.env[`GLOAM_RPC_URL_${cfg.id}`] = `http://127.0.0.1:${cfg.port}`;
process.env.GLOAM_RELAYER_PRIVATE_KEY = generatePrivateKey();

const anvil = spawn(`${homedir()}/.foundry/bin/anvil`, ["--fork-url", cfg.fork, "--port", String(cfg.port), "--silent"], { stdio: "ignore" });
process.on("exit", () => anvil.kill("SIGTERM"));
const url = `http://127.0.0.1:${cfg.port}`;
const client = createPublicClient({ transport: http(url, { timeout: 180_000 }) }) as PublicClient;
/** The same client, typed for the SDK (it may resolve another copy of viem than the app). */
const sc = client as unknown as Parameters<typeof sdk.readSwapOutcome>[0];
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
  "function currentRoot() view returns (bytes32)",
  "function withdrawFeeBps() view returns (uint16)",
  "function deposited(address) view returns (uint256)",
  "function depositLimit(address) view returns (uint128, uint128)",
  "function lowerDepositLimit(address, uint128, uint128)",
]);
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256)", "function transfer(address,uint256)"]);

const fmt = (v: bigint, a: Address) => {
  const [s, d] = cfg.syms[a.toLowerCase()] ?? cfg.syms[a] ?? ["?", 18];
  return `${formatUnits(v, d)} ${s}`;
};
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
  return ok ? "ok" : "FAILED";
};
/** A transaction from an impersonated account, mined at once. */
async function tx(from: Address, to: Address | null, data: Hex, value = 0n) {
  const hash = (await raw("eth_sendTransaction", [{ from, ...(to ? { to } : {}), data, value: toHex(value), gas: toHex(12_000_000n) }])) as Hex;
  await raw("evm_mine").catch(() => {});
  return client.waitForTransactionReceipt({ hash });
}
const balance = (asset: Address, who: Address) =>
  same(asset, NATIVE) ? client.getBalance({ address: who }) : client.readContract({ address: asset, abi: tokenAbi, functionName: "balanceOf", args: [who] });
const readVault = <T,>(functionName: string, args: unknown[] = []) => client.readContract({ address: VAULT, abi: vaultAbi, functionName: functionName as never, args: args as never }) as Promise<T>;

/** The SDK's own prover (proveGroth16), on the production circuits and the ceremony-final keys, each proof checked here too. */
let proofs = 0;
function prover(name: "shield" | "unshield"): sdk.Prover {
  const vkey = JSON.parse(readFileSync(`public/circuits/final/${name}_vkey.json`, "utf8"));
  return async (input) => {
    const out = await sdk.proveGroth16(input, `public/circuits/${name}.wasm`, `public/circuits/final/${name}_final.zkey`);
    if (!(await snarkjs.groth16.verify(vkey, out.publicSignals, out.proof))) throw new Error(`${name} proof failed locally`);
    proofs++;
    return { proofBytes: out.proofBytes };
  };
}
const shieldProver = prover("shield");
const unshieldProver = prover("unshield");

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
  const note = await sdk.makeBoundNotePoseidon(amount, asset);
  const { proofBytes } = await shieldProver({ commitment: note.commitmentField.toString(), amount: amount.toString(), asset: BigInt(asset).toString(), secret: note.secretField.toString() });
  const at = await nextLeafPath();
  const data = encodeFunctionData({ abi: vaultAbi, functionName: "shieldBound", args: [asset, amount, note.commitment, proofBytes] });
  if (same(asset, NATIVE)) {
    await raw("anvil_setBalance", [DEPOSITOR, toHex(amount + parseUnits("1", 18))]);
    if ((await tx(DEPOSITOR, VAULT, data, amount)).status !== "success") throw new Error("native deposit reverted");
  } else {
    await tx(cfg.poolManager, asset, encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [DEPOSITOR, amount] }));
    await tx(DEPOSITOR, asset, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [VAULT, 0n] }));
    await tx(DEPOSITOR, asset, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [VAULT, amount] }));
    if ((await tx(DEPOSITOR, VAULT, data)).status !== "success") throw new Error(`deposit reverted: ${fmt(amount, asset)}`);
  }
  const root = await readVault<Hex>("currentRoot");
  const path: sdk.PoseidonMerklePath = { leafIndex: Number(at.index), leaf: note.commitmentField, pathElements: at.elements, pathIndices: at.indices, root: BigInt(root) };
  return { note: { secretHex: note.secret, amountWei: amount, asset }, path };
}

/** A relay call as it crosses the wire: JSON, bigints as decimal strings. */
const wire = (call: sdk.SwapRelayCall) => JSON.parse(JSON.stringify({ ...call.body, action: call.action }, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) as Record<string, unknown>;

const relay = await import("../src/lib/relay/server");
const { relayForPartner, partnerRelayDeps } = await import("../src/lib/partnerRelay");
const { getNetwork } = await import("../src/lib/networks");
const appSwap = await import("../src/lib/vaultSwap");
const net = getNetwork(cfg.key as never);
const code = (p: Promise<unknown>) => p.then(() => "sent", (e) => (e instanceof relay.RelayError || e instanceof sdk.SwapRefusedError ? (e as { code: string }).code : String(e)));

async function runCase(c: Case) {
  console.log(`\n${c.name}`);
  const { note, path } = await realNote(c.assetIn, c.amountIn);

  if (c.kind === "floor") {
    const q = await sdk.quoteSwap({ client: sc, chainId: cfg.id, assetIn: c.assetIn, assetOut: c.assetOut, amountIn: c.amountIn });
    console.log(`  the SDK's quote: stop ${q.stop?.code}, floor $${q.floorUsd?.toFixed(2)}: ${check(q.stop?.code === "swap_small", "a swap under the floor is stopped in the quote")}`);
    const before = proofs;
    const got = await code(sdk.buildSwapIntent({ client: sc, chainId: cfg.id, note, path, assetOut: c.assetOut, shieldProver, unshieldProver }));
    console.log(`  the SDK's build: ${check(got === "swap_small", "the build is refused the same way")} (${got}), proofs made: ${check(proofs === before, "no proof was made")} (${proofs - before})`);
    // the relay agrees: from a wallet the SDK would build it, and the relay would refuse that body under its floor
    const walletIntent = await sdk.buildSwapIntent({ client: sc, chainId: cfg.id, note, path, assetOut: c.assetOut, shieldProver, unshieldProver, via: "wallet" });
    const relayed = await code(relay.relayVaultSwap(net, wire(walletIntent.relay)));
    console.log(`  the relay, sent it anyway: ${check(relayed === "swap_small", "the relay refuses it under its floor")} (${relayed})`);
    return;
  }

  const q = await sdk.quoteSwap({ client: sc, chainId: cfg.id, assetIn: c.assetIn, assetOut: c.assetOut, amountIn: c.amountIn });
  console.log(`  quote: ${fmt(q.plan.amountOut, c.assetOut)} for ${fmt(c.amountIn, c.assetIn)}, ${q.plan.route.length} hop(s), fee ${q.feeBps} bps, stop ${q.stop?.code ?? "none"}: ${check(q.stop === null, "the quote has no stop")}`);
  const intent = await sdk.buildSwapIntent({ client: sc, chainId: cfg.id, note, path, assetOut: c.assetOut, quote: q, shieldProver, unshieldProver });
  // stored and read back, as an integrator would
  const rec = sdk.parseSwapRecovery(JSON.stringify(sdk.swapJson(intent.recovery)));
  const v3 = intent.plan.routerVersion === 3;
  console.log(`  built for router v${intent.plan.routerVersion} ${intent.plan.router}${v3 ? `, deadline in ${Number(intent.plan.deadline! - (await client.getBlock()).timestamp)} s` : ""}`);
  check(same(rec.escrow, appSwap.escrowAddress(rec.router, rec.info.assetIn, appSwap.refundEscrowKey(rec.info, rec.spent.nullifier, rec.refund.commitment, BigInt(rec.refund.amountWei)))), "the app works out the SDK's escrow");

  if (c.kind === "relay" || c.kind === "partner") {
    let hash: Hex;
    if (c.kind === "partner") {
      const counted: { kind?: string } = {};
      const partner = { id: "ptr_forktest", owner: OWNER, name: "fork", website: null, payout: {}, fees: { privatePaymentCents: 0, cashoutBps: 0, depositBps: 0 }, createdAt: 0, updatedAt: 0 };
      const out = await relayForPartner(
        { net, body: wire(intent.relay), partner, keyId: "key_fork" },
        { ...partnerRelayDeps, record: async (a) => ((counted.kind = a.kind), { recorded: true, record: { id: "act_fork", kind: a.kind } as never }) }
      );
      hash = out.hash;
      console.log(`  partner relay: counted as ${counted.kind}: ${check(counted.kind === "private_swap" && out.attribution.recorded, "the swap is counted to the partner")}`);
    } else {
      hash = await relay.relayVaultSwap(net, wire(intent.relay));
    }
    const r = await client.waitForTransactionReceipt({ hash });
    console.log(`  sent: ${check(r.status === "success", "the swap lands")}, gas ${r.gasUsed}`);
    const o = await sdk.readSwapOutcome(sc, rec);
    console.log(`  outcome: ${o.state}: ${check(o.state === "swapped", "the SDK reads it as swapped")}`);
    const outAmount = BigInt(rec.out.amountWei);
    check(outAmount === intent.plan.amountOut, "the new note is exactly what was proved");
    console.log(`  new note ${fmt(outAmount, c.assetOut)}; router empty ${check((await balance(c.assetIn, rec.router)) === 0n && (await balance(c.assetOut, rec.router)) === 0n, "router ends empty")}, escrow empty ${check((await balance(c.assetIn, rec.escrow)) === 0n, "escrow ends empty")}`);
    // the same proofs again: refused before anything is sent
    const again = await code(relay.relayVaultSwap(net, wire(intent.relay)));
    console.log(`  sent again: ${check(again !== "sent", "a landed swap can't be sent again")} (${again})`);
    return;
  }

  // the note's unshield, sent alone by a stranger: the money waits at the escrow
  const s = intent.relay.body.spend as { proof: Hex; root: Hex; nullifier: Hex; asset: Address; amount: bigint };
  const alone = await tx(STRANGER, VAULT, encodeFunctionData({ abi: vaultAbi, functionName: "unshield", args: [s.proof, s.root, s.nullifier, s.asset, rec.escrow, s.amount] }));
  const fee = BigInt(await readVault<number>("withdrawFeeBps"));
  const arrived = c.amountIn - ((c.amountIn / 10_000n) * fee + ((c.amountIn % 10_000n) * fee) / 10_000n);
  console.log(`  unshield sent alone: ${check(alone.status === "success", "unshield alone")}, waiting ${fmt(await balance(c.assetIn, rec.escrow), c.assetIn)}: ${check((await balance(c.assetIn, rec.escrow)) === arrived, "escrow holds what arrived")}`);
  const o1 = await sdk.readSwapOutcome(sc, rec);
  console.log(`  outcome: ${o1.state}: ${check(o1.state === "refund_ready", "the SDK reads it as refund ready")}`);
  // the swap itself can't go now
  const swapAgain = await code(relay.relayVaultSwap(net, wire(intent.relay)));
  console.log(`  the swap after that: ${check(swapAgain !== "sent", "the swap call without the payment named is refused")} (${swapAgain})`);

  if (c.kind === "refund") {
    const refund = await sdk.buildSwapRefund(rec, { client: sc, shieldProver });
    check(refund.relay.body.unshieldTx === alone.transactionHash, "the SDK finds the vault's payment to the escrow");
    const hash = await relay.relayVaultSwap(net, wire(refund.relay));
    const r = await client.waitForTransactionReceipt({ hash });
    const o2 = await sdk.readSwapOutcome(sc, rec);
    console.log(`  the SDK's refund through the relay: ${check(r.status === "success", "the refund lands")}, outcome ${o2.state}: ${check(o2.state === "refunded", "refunded")}, gas ${r.gasUsed}`);
    console.log(`  escrow empty: ${check((await balance(c.assetIn, rec.escrow)) === 0n, "escrow ends empty")}`);
    return;
  }

  // exit: the vault has no room for the refund note
  const dep = await readVault<bigint>("deposited", [c.assetIn]);
  const [per] = await readVault<readonly [bigint, bigint]>("depositLimit", [c.assetIn]);
  await tx(OWNER, VAULT, encodeFunctionData({ abi: vaultAbi, functionName: "lowerDepositLimit", args: [c.assetIn, per, dep] }));
  const noRefund = await code(sdk.buildSwapRefund(rec, { client: sc, shieldProver }));
  console.log(`  the SDK's refund with the vault full: ${check(noRefund === "refund_wont_fit", "the refund is refused before any proof")} (${noRefund})`);
  const exit = await sdk.buildSwapExit(rec, { client: sc, to: EXIT_TO });
  const before = await balance(c.assetIn, EXIT_TO);
  const hash = await relay.relayVaultSwapExit(net, wire(exit.relay));
  const r = await client.waitForTransactionReceipt({ hash });
  const paid = (await balance(c.assetIn, EXIT_TO)) - before;
  console.log(`  the SDK's exit through the relay: ${check(r.status === "success", "the exit lands")}, paid ${fmt(paid, c.assetIn)}: ${check(paid === arrived, "the exit pays all that arrived")}, gas ${r.gasUsed}`);
  const o3 = await sdk.readSwapOutcome(sc, rec);
  console.log(`  outcome: ${o3.state}: ${check(o3.state === "closed", "closed once it left by its exit")}`);
  await tx(OWNER, VAULT, encodeFunctionData({ abi: vaultAbi, functionName: "lowerDepositLimit", args: [c.assetIn, per, dep] })).catch(() => {});
}

// ── the fork ──────────────────────────────────────────────────────────────────
// Robinhood Chain's blocks carry no blob fields, which anvil wants on the head: one local block has them.
await raw("evm_mine");
// Ethereum: gas on the fork as it is on a quiet day, so a swap clears the relay's floor and gas ceiling
if (cfg.id === 1) {
  await raw("anvil_setNextBlockBaseFeePerGas", [toHex(200_000_000n)]);
  await raw("evm_mine");
}
const relayer = relay.relayerAccount()!.address;
for (const a of [OWNER, DEPOSITOR, STRANGER, cfg.poolManager, relayer]) {
  await raw("anvil_impersonateAccount", [a]);
  await raw("anvil_setBalance", [a, toHex(parseUnits("100", 18))]);
}
console.log(`${net.label} fork at block ${(await client.getBlock()).number}, live vault ${VAULT}, fee ${await readVault<number>("withdrawFeeBps")} bps`);

if (cfg.deployRouter) {
  const script = execFileSync(
    `${homedir()}/.foundry/bin/forge`,
    ["script", "script/DeployVaultSwapV4c.s.sol:DeployVaultSwapV4c", "--sig", "initCode(uint256)", String(cfg.id), "--json"],
    { cwd: new URL("../../contracts", import.meta.url).pathname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" } }
  );
  const initCode = (Object.values(JSON.parse(script.split("\n").filter((l) => l.startsWith("{")).pop()!).returns)[0] as { value: Hex }).value;
  const deploy = await tx(OWNER, FACTORY, `${SALT}${initCode.slice(2)}` as Hex);
  const router = sdk.VAULT_SWAP_V3_ADDRESS[cfg.id]!;
  const deployed = Boolean((await client.getCode({ address: router }))?.length);
  console.log(`router v3 through the factory: ${check(deploy.status === "success" && deployed, "router deployed at the pinned address")} at ${router}`);
  if (!deployed) throw new Error("no router at the pinned address: was the last `forge build` a plain one?");
  // before the switch: the SDK refuses this chain cleanly
  const off = await code(sdk.quoteSwap({ client: sc, chainId: cfg.id, assetIn: cfg.cases[0]!.assetIn, assetOut: cfg.cases[0]!.assetOut, amountIn: 1_000_000n }));
  console.log(`the SDK with the switch off: ${check(off === "no_swap", "refused while the switch is off")} (${off})`);
  // the switch, on this fork only: the SDK's and the app's (the relay's)
  sdk.VAULT_SWAP_V3_LIVE[cfg.id] = router;
  appSwap.VAULT_SWAP_V3_LIVE[cfg.id] = router;
  appSwap.VAULT_SWAP_ROUTERS[cfg.id] = router;
}

const cases = cfg.cases.filter((x) => x.name.includes(process.env.ONLY ?? ""));
for (const c of cases) {
  try {
    await runCase(c);
  } catch (e) {
    failures.push(`${c.name}: ${(e as Error).message}`);
    console.log(`  FAILED: ${(e as Error).stack}`);
  }
}

console.log(failures.length ? `\nFAILED:\n  ${failures.join("\n  ")}` : `\nALL CHECKS PASSED (${cases.length} cases, ${proofs} real proofs, a local fork, nothing broadcast, no key used)`);
process.exit(failures.length ? 1 : 0);
