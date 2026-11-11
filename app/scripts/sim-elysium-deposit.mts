/**
 * Add privately on Elysium mainnet, checked against the live vault without
 * sending anything: a real shield proof on the ceremony's final keys (the
 * files the app serves, checked against the app's own SHA-256 list), the exact
 * call the app builds (lib/depositFlow depositCall), then eth_call and
 * eth_estimateGas of shieldBound from a real wallet on the public RPC. No key
 * is used and nothing is broadcast.
 *
 * Each asset is tried twice: as the wallet stands now, and with a state
 * override for the one thing a wallet would do first (an ERC-20's approve, or
 * holding enough HYPE), so a revert that is only the missing approval shows as
 * such and the rest of the deposit (proof check, limits, transfer, tree insert)
 * still runs.
 *
 * Run from app/:
 *   ../mcp/node_modules/.bin/tsx scripts/sim-elysium-deposit.mts
 * SIM_ASSET=usdc|hype|kntq (default usdc), SIM_AMOUNT in whole units (default
 * 0.4 USDC, 0.5 HYPE, 10 KNTQ), SIM_FROM (default the wallet that made the
 * first app deposit after the fixed gas limits, 10 Nov 2026), SIM_RPC.
 *
 * Before Thursday 12 Nov HYPE and KNTQ read 0/0 and the call reverts with
 * OverDepositLimit, which is right (the proof is checked first, so that revert
 * also says the proof passed). While a limit is still 0, or with SIM_OPEN=1, the
 * script runs it once more with the queued limit written into the vault's
 * storage for the call only, so the rest of the path is checked ahead of time.
 * After executeChange, the plain runs pass on their own.
 */
import "./browser-shim.mts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import {
  createPublicClient,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { makeBoundNotePoseidon, packGroth16Proof, type Groth16Proof } from "@gloamtrade/sdk";

const { ELYSIUM } = await import("../src/lib/elysium");
const { shieldTokensFor, limitGatedAssetsFor, openGatedFromReads, addableTokensFor, isNativeAddable } = await import("../src/lib/tokens");
const { shieldPoolAbi, gasFor, nativeGasReserve, SHIELD_BOUND_GAS_LIMIT, NATIVE_ASSET } = await import("../src/lib/shield");
const { depositCall } = await import("../src/lib/depositFlow");
const { circuitArtifactsFor } = await import("../src/lib/circuitArtifacts");

if (!ELYSIUM) throw new Error("Elysium is off in this build");
const RPC = process.env.SIM_RPC ?? ELYSIUM.rpcUrl;
const pool = ELYSIUM.pool as Address;
const FROM = (process.env.SIM_FROM ?? "0x8EA6E92ED37283C595a0bf01efE0fa99a69c15aC") as Address;
const which = (process.env.SIM_ASSET ?? "usdc").toLowerCase();
const native = which === "hype";
const token = native ? null : shieldTokensFor(ELYSIUM.chainId).find((t) => t.id === which);
if (!native && !token) throw new Error(`no ${which} on Elysium`);
const asset: Address = native ? NATIVE_ASSET : token!.address;
const decimals = native ? 18 : token!.decimals;
const symbol = native ? "HYPE" : token!.symbol;
const amount = parseUnits(process.env.SIM_AMOUNT ?? (native ? "0.5" : which === "kntq" ? "10" : "0.4"), decimals);

const client = createPublicClient({ transport: http(RPC) });
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const errors = parseAbi([
  "error OverDepositLimit()",
  "error InvalidProof()",
  "error InvalidMsgValue()",
  "error InvalidAmount()",
  "error DuplicateCommitment()",
  "error ZeroCommitment()",
  "error VerifierNotSet()",
  "error NotAContract()",
  "error FeeOnTransferNotSupported()",
  "error TransferFailed()",
  "error Reentrancy()",
  "error TreeFull()",
  "error Error(string)",
]);
const fmt = (v: bigint) => `${formatUnits(v, decimals)} ${symbol}`;
const say = (s: string) => console.log(s);

function why(e: unknown): string {
  // viem's error chain carries the revert data; decode it against the vault's errors
  let cur = e as { data?: unknown; cause?: unknown; shortMessage?: string; message?: string } | undefined;
  for (let i = 0; cur && i < 8; i++) {
    const d = cur.data as Hex | { data?: Hex } | undefined;
    const raw = typeof d === "string" ? d : d?.data;
    if (raw && raw.startsWith("0x") && raw.length >= 10) {
      try {
        const r = decodeErrorResult({ abi: errors, data: raw });
        return r.errorName + (r.args?.length ? `(${r.args.join(", ")})` : "");
      } catch {
        return `revert ${raw.slice(0, 10)}`;
      }
    }
    cur = cur.cause as typeof cur;
  }
  const m = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message;
  return m.split("\n")[0]!;
}

// ------------------------------------------------------------------ what the app reads

const head = await client.getBlockNumber();
const [limitsOn, limit, deposited, verifier] = await Promise.all([
  client.readContract({ address: pool, abi: shieldPoolAbi, functionName: "depositLimitsOn" }),
  client.readContract({ address: pool, abi: shieldPoolAbi, functionName: "depositLimit", args: [asset] }) as Promise<readonly [bigint, bigint]>,
  client.readContract({ address: pool, abi: shieldPoolAbi, functionName: "deposited", args: [asset] }) as Promise<bigint>,
  client.readContract({ address: pool, abi: shieldPoolAbi, functionName: "shieldVerifier" }),
]);
say(`Elysium ${ELYSIUM.chainId} block ${head}, vault ${pool}, shieldVerifier ${verifier}`);
say(`${symbol}: limit ${fmt(limit[0])} per deposit / ${fmt(limit[1])} total, deposited ${fmt(deposited)}, limits on ${limitsOn}`);

// What Add offers right now, through the same functions useOpenGatedTokens and ShieldView use.
const gated = limitGatedAssetsFor(ELYSIUM.chainId);
const gatedReads = await Promise.all(
  gated.map((t) => client.readContract({ address: pool, abi: shieldPoolAbi, functionName: "depositLimit", args: [t.address as Address] }) as Promise<readonly [bigint, bigint]>)
);
const open = openGatedFromReads(gated, limitsOn as boolean, gatedReads);
const offered = [...(isNativeAddable(ELYSIUM.chainId, open) ? ["HYPE"] : []), ...addableTokensFor(ELYSIUM.chainId, open).map((t) => t.symbol)];
say(`Add offers on Elysium now: ${offered.join(", ")}`);

const [balance, allowance, hype, gasPrice] = await Promise.all([
  native ? client.getBalance({ address: FROM }) : (client.readContract({ address: asset, abi: erc20, functionName: "balanceOf", args: [FROM] }) as Promise<bigint>),
  native ? Promise.resolve(BigInt(0)) : (client.readContract({ address: asset, abi: erc20, functionName: "allowance", args: [FROM, pool] }) as Promise<bigint>),
  client.getBalance({ address: FROM }),
  client.getGasPrice(),
]);
say(`wallet ${FROM}: ${fmt(balance)}${native ? "" : `, allowance to the vault ${fmt(allowance)}`}, ${formatEther(hype)} HYPE for gas, gas price ${formatUnits(gasPrice, 9)} gwei`);

// ------------------------------------------------------------------ the proof

const files = circuitArtifactsFor("production");
const local = (p: string) => fileURLToPath(new URL(`../public${p}`, import.meta.url));
for (const k of ["shieldWasm", "shieldZkey"] as const) {
  const got = createHash("sha256").update(readFileSync(local(files[k].path))).digest("hex");
  if (got !== files[k].sha256) throw new Error(`${files[k].path}: sha256 ${got}, the app expects ${files[k].sha256}`);
}
const t0 = performance.now();
const note = await makeBoundNotePoseidon(amount, asset);
const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  { commitment: BigInt(note.commitment).toString(), amount: amount.toString(), asset: BigInt(asset).toString(), secret: BigInt(note.secret).toString() },
  local(files.shieldWasm.path),
  local(files.shieldZkey.path)
);
const vkey = JSON.parse(readFileSync(local("/circuits/final/shield_vkey.json"), "utf8"));
const localOk = await snarkjs.groth16.verify(vkey, publicSignals, proof);
const proofBytes = packGroth16Proof(proof as Groth16Proof);
say(`proof on the final keys (sha256 checked) in ${((performance.now() - t0) / 1000).toFixed(1)} s, verifies locally: ${localOk}`);

// ------------------------------------------------------------------ the app's call

const call = depositCall(
  { chainId: ELYSIUM.chainId, pool, asset, amountWei: amount.toString(), commitment: note.commitment as Hex },
  { chainId: ELYSIUM.chainId, pool },
  proofBytes
);
if (!call) throw new Error("depositCall refused the note");
const data = encodeFunctionData({ abi: shieldPoolAbi, functionName: call.functionName, args: call.args as never });
const gas = gasFor(ELYSIUM.chainId, SHIELD_BOUND_GAS_LIMIT);
say(`app call: ${call.functionName}(${symbol}, ${fmt(amount)}), value ${call.value ?? 0n}, fixed gas ${gas}`);

/** OpenZeppelin ERC20Upgradeable keeps _allowances at slot 52 (StandardArbERC20, Elysium's bridged tokens). */
function allowanceSlot(owner: Address, spender: Address, base: bigint): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, base]));
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, inner]));
}

async function findAllowanceSlot(): Promise<number | null> {
  for (const base of [52, 51, 1, 2, 10, 3, 4, 5]) {
    const slot = allowanceSlot(FROM, pool, BigInt(base));
    try {
      const r = await client.readContract({
        address: asset,
        abi: erc20,
        functionName: "allowance",
        args: [FROM, pool],
        stateOverride: [{ address: asset, stateDiff: [{ slot, value: toHex(amount, { size: 32 }) }] }],
      });
      if (r === amount) return base;
    } catch {
      // try the next layout
    }
  }
  return null;
}

type Override = NonNullable<Parameters<typeof client.call>[0]["stateOverride"]>;

async function attempt(label: string, stateOverride?: Override) {
  const base = { account: FROM, to: pool, data, value: call!.value, gas, stateOverride };
  try {
    await client.call(base);
    const used = await client.estimateGas({ ...base, gas: undefined });
    say(`  ${label}: eth_call OK, eth_estimateGas ${used} (${((Number(used) / Number(gas)) * 100).toFixed(0)}% of the fixed ${gas})`);
    return used;
  } catch (e) {
    say(`  ${label}: reverts: ${why(e)}`);
    return null;
  }
}

say(`simulating from ${FROM}:`);
await attempt("as the wallet stands");

/** The vault keeps depositLimit at slot 53 (forge inspect ShieldPoolPayments storage-layout), packed total << 128 | perDeposit. */
const LIMIT_SLOT_BASE = 53n;
/** OpenZeppelin ERC20Upgradeable keeps _balances at slot 51 (StandardArbERC20). */
const BALANCE_SLOT_BASE = 51n;
const mapSlot = (key: Address, base: bigint) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, base]));
/** The limits queued for 12 Nov 2026, as the vault will hold them once Duke runs executeChange. */
const QUEUED: Record<string, readonly [bigint, bigint]> = {
  hype: [parseUnits("12", 18), parseUnits("600", 18)],
  kntq: [parseUnits("1400", 18), parseUnits("70000", 18)],
};
const queued = QUEUED[which];
const openNow = limit[0] > BigInt(0) && limit[1] > BigInt(0);
/** With SIM_OPEN=1 (or no live limit yet), also run it as if the queued limit had landed. */
const openOverride: Override =
  queued && (process.env.SIM_OPEN === "1" || !openNow)
    ? [{ address: pool, stateDiff: [{ slot: mapSlot(asset, LIMIT_SLOT_BASE), value: toHex((queued[1] << BigInt(128)) | queued[0], { size: 32 }) }] }]
    : [];
const withLimit = (o: Override): Override => {
  // merged per address: one entry for the vault, one for the token or the wallet
  const byAddr = new Map<string, { address: Address; balance?: bigint; stateDiff: { slot: Hex; value: Hex }[] }>();
  for (const e of [...o, ...openOverride]) {
    const key = e.address.toLowerCase();
    const cur = byAddr.get(key) ?? { address: e.address, stateDiff: [] };
    if (e.balance !== undefined) cur.balance = e.balance;
    cur.stateDiff.push(...((e.stateDiff ?? []) as { slot: Hex; value: Hex }[]));
    byAddr.set(key, cur);
  }
  return [...byAddr.values()].map((e) => ({
    address: e.address,
    ...(e.balance !== undefined ? { balance: e.balance } : {}),
    ...(e.stateDiff.length ? { stateDiff: e.stateDiff } : {}),
  }));
};

let used: bigint | null = null;
if (native) {
  const need = amount + (gas ?? BigInt(0)) * gasPrice * BigInt(2);
  const funded: Override = hype >= need ? [] : [{ address: FROM, balance: need }];
  used = await attempt(`with ${formatEther(need)} HYPE in the wallet`, funded.length ? funded : undefined);
  if (openOverride.length) used = await attempt(`and the queued ${fmt(queued![0])} / ${fmt(queued![1])} limit in place`, withLimit(funded));
  const reserve = nativeGasReserve(ELYSIUM.chainId, gasPrice);
  say(`  Max keeps ${formatEther(reserve)} HYPE back for gas; the wallet needs at most ${formatEther((gas ?? BigInt(0)) * gasPrice * BigInt(2))} HYPE at 2x today's gas price for the fixed limit`);
} else {
  const base = await findAllowanceSlot();
  if (base === null) say("  could not place the allowance in storage, so no approved run");
  else {
    const slot = allowanceSlot(FROM, pool, BigInt(base));
    const approved: Override = [{ address: asset, stateDiff: [{ slot, value: toHex(amount, { size: 32 }) }] }];
    if (balance < amount) say(`  (the wallet holds ${fmt(balance)}, less than the deposit: the approved run fails on the transfer)`);
    used = await attempt(`after approve(${fmt(amount)}) (allowance slot base ${base})`, approved);
    if (openOverride.length) {
      // the wallet holding the amount too, when it holds less
      const funded: Override =
        balance >= amount ? approved : [{ address: asset, stateDiff: [...approved[0]!.stateDiff!, { slot: mapSlot(FROM, BALANCE_SLOT_BASE), value: toHex(amount, { size: 32 }) }] }];
      used = await attempt(`and the queued ${fmt(queued![0])} / ${fmt(queued![1])} limit in place${balance >= amount ? "" : `, holding ${fmt(amount)}`}`, withLimit(funded));
    }
  }
}
if (used !== null && gas !== undefined && used > gas) {
  say(`FAIL: the deposit needs ${used} gas, over the fixed ${gas}`);
  process.exit(1);
}
// snarkjs keeps its worker threads alive: leave once the report is out
process.exit(0);
