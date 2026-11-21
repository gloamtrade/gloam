/**
 * Private name claims (GloamNamesRegistrar), end to end against live Robinhood Chain
 * mainnet state, with REAL Groth16 proofs (the production circuits and the
 * ceremony-final zkeys) checked by the REAL verifiers the live vault calls, the REAL
 * GloamNames registry and the REAL $GLOAM token. It runs as eth_simulateV1 on the
 * public RPC: nothing is broadcast and no key is used anywhere.
 *
 * State overrides, and only these:
 *  - one vault slot: knownRoots[root] = true for a tree holding the synthetic note
 *    (the same single slot sim-vault-swap-v2.mts overrides);
 *  - ETH for the account that deploys the registrar in the simulation.
 * Everything else runs the real way, in one simulated block: the registrar is
 * deployed (CREATE, from an unused account), $GLOAM moves to a depositor from the
 * PoolManager (validation off, so no key) and is shielded with a real shield proof,
 * so the vault really backs the note; then the relay sends claim() exactly as the
 * app builds it (lib/nameClaim). A second simulation sends the note's unshield on its
 * own first, and the same claim call puts the money back as the refund note.
 *
 * Run from app/ after `forge build` in contracts/:
 *   ../mcp/node_modules/.bin/tsx scripts/sim-name-claim.mts
 */
import "./browser-shim.mts";
import { readFileSync } from "node:fs";
import * as snarkjs from "snarkjs";
import {
  createPublicClient,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getContractAddress,
  http,
  keccak256,
  pad,
  parseAbi,
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

const { shieldPoolAbi } = await import("../src/lib/shield");
const { namesRegistrarAbi, nameEscrowAddress, noteForPrice, nameClaimRefundAmount, claimArgs, claimEscrowKey } = await import("../src/lib/nameClaim");
const { gloamNamesAbi } = await import("../src/lib/gloamNames");

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const VAULT: Address = "0x39e28cde55cab798874746ac52cb4b5cc99a0194";
const NAMES: Address = "0x62c435CE6886fa91e3b0e91500c6dC9219723457";
const GLOAM: Address = "0xDcD885F5c60b3aD49F6D58718696417314e8724d";
const TREASURY: Address = "0xB3900ac9350903218e4c7597bAb0f008F01B30B8";
const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const RELAYER: Address = "0xb1E994586E62994648a0b866BF33F2EDd942512e";
const STRANGER: Address = "0x000000000000000000000000000000000000dead";
const DEPOSITOR: Address = "0x00000000000000000000000000000000de90517e";
/** An account with no code, no nonce and no balance on Robinhood Chain (checked below): it deploys the registrar. */
const DEPLOYER: Address = "0x5157ab2b00000000000000000000000000000003";
const HOLDER: Address = "0x000000000000000000000000000000000000beef";
const KNOWN_ROOTS_SLOT = 46n; // vault: tree at slot 4, its knownRoots mapping 42 slots in (forge inspect)
const GX: Hex = "0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296";
const GY: Hex = "0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";

const client = createPublicClient({ transport: http(RPC, { timeout: 90_000, retryCount: 3 }) });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)"]);
const vaultAbi = parseAbi([
  "function withdrawFeeBps() view returns (uint16)",
  "function shieldBound(address asset, uint256 amount, bytes32 commitment, bytes proof) payable",
  "function unshield(bytes proof, bytes32 root, bytes32 nullifier, address asset, address to, uint256 amount)",
]);

// ── the registrar, as forge built it ──────────────────────────────────────────
const artifact = JSON.parse(readFileSync("../contracts/out/GloamNamesRegistrar.sol/GloamNamesRegistrar.json", "utf8"));
const initCode = ((artifact.bytecode.object as Hex) + encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [VAULT, NAMES, TREASURY]).slice(2)) as Hex;
const REGISTRAR = getContractAddress({ from: DEPLOYER, nonce: 0n });

const [dCode, dNonce, rCode] = await Promise.all([
  client.getCode({ address: DEPLOYER }),
  client.getTransactionCount({ address: DEPLOYER }),
  client.getCode({ address: REGISTRAR }),
]);
if ((dCode && dCode !== "0x") || dNonce !== 0 || (rCode && rCode !== "0x")) throw new Error("the deployer or registrar address is in use");
const slotFor = (root: bigint) => keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [root, KNOWN_ROOTS_SLOT]));
const currentRoot = BigInt((await client.getStorageAt({ address: VAULT, slot: pad("0x05") }))!);
if (BigInt((await client.getStorageAt({ address: VAULT, slot: slotFor(currentRoot) }))!) !== 1n) throw new Error("vault storage layout does not match");
const feeBps = Number(await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "withdrawFeeBps" }));

// a name free on mainnet now
let NAME = "privyclaim";
for (let i = 0; ; i++) {
  const [holder] = await client.readContract({ address: NAMES, abi: gloamNamesAbi, functionName: "resolve", args: [NAME] });
  if (BigInt(holder) === 0n) break;
  NAME = `privyclaim${i}`;
}
const price = await client.readContract({ address: NAMES, abi: gloamNamesAbi, functionName: "priceOf", args: [NAME, 1n] });
const amount = noteForPrice(price, feeBps);
const head = await client.getBlock();
console.log(`Robinhood Chain block ${head.number}: @${NAME} costs ${formatUnits(price, 18)} GLOAM a year, cash-out fee ${feeBps} bps, note ${formatUnits(amount, 18)} GLOAM`);

async function prove(name: "shield" | "unshield", input: Record<string, unknown>) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input as never, `public/circuits/${name}.wasm`, `public/circuits/final/${name}_final.zkey`);
  const vkey = JSON.parse(readFileSync(`public/circuits/final/${name}_vkey.json`, "utf8"));
  if (!(await snarkjs.groth16.verify(vkey, publicSignals, proof))) throw new Error(`${name} proof failed locally`);
  return packGroth16Proof(proof as Groth16Proof);
}
const shieldProof = (n: { commitment: string; secret: string }, amt: bigint) =>
  prove("shield", { commitment: BigInt(n.commitment).toString(), amount: amt.toString(), asset: BigInt(GLOAM).toString(), secret: BigInt(n.secret).toString() });

// ── the note, its tree, the claim, exactly as the app builds them ──────────────
const tree = new IncrementalMerkleTreePoseidon();
await tree.init();
const note = await makeBoundNotePoseidon(amount, GLOAM);
const leaf = await tree.insert(note.commitmentField);
const ROOT = fieldToBytes32(tree.currentRoot);
const backAmount = nameClaimRefundAmount(amount);
const back = await makeBoundNotePoseidon(backAmount, GLOAM);
const claim = { name: NAME, keyX: GX, keyY: GY, holder: HOLDER, years: 1n };
const refundDraft = { proof: "0x" as Hex, commitment: back.commitment as Hex, amount: backAmount };
const key = claimEscrowKey({ proof: "0x", root: "0x", nullifier: note.nullifier as Hex, amount }, claim, refundDraft);
const escrow = nameEscrowAddress(REGISTRAR, key);
const w = await buildPoseidonUnshieldWitness({ secretHex: note.secret as Hex, amount, asset: GLOAM, to: escrow, path: await tree.path(leaf) });
if (!w.checks.commitmentMatches) throw new Error("witness does not open the note");
const depNote = await makeBoundNotePoseidon(amount, GLOAM);
const [unProof, backProof, depProof] = await Promise.all([prove("unshield", w.circomInput), shieldProof(back, backAmount), shieldProof(depNote, amount)]);
const nullifier = fieldToBytes32(w.publicInputs.nullifier);
const spend = { proof: unProof, root: ROOT, nullifier, amount };
const refund = { ...refundDraft, proof: backProof };
const claimData = encodeFunctionData({ abi: namesRegistrarAbi, functionName: "claim", args: claimArgs(spend, claim, refund) });
console.log(`real proofs made: unshield to escrow ${escrow}, the refund note's shield, the backing deposit's shield`);

// ── the simulation ─────────────────────────────────────────────────────────────
type Call = { from: Address; to?: Address; data: Hex };
type SimCall = { status: string; returnData: Hex; gasUsed: string; error?: { message?: string; data?: Hex } };
const read = (to: Address, data: Hex): Call => ({ from: STRANGER, to, data });
const setup: Call[] = [
  { from: DEPLOYER, data: initCode },
  read(REGISTRAR, encodeFunctionData({ abi: namesRegistrarAbi, functionName: "escrowFor", args: [{ ...key, years_: key.years }] })),
  { from: POOL_MANAGER, to: GLOAM, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [DEPOSITOR, amount] }) },
  { from: DEPOSITOR, to: GLOAM, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [VAULT, amount] }) },
  { from: DEPOSITOR, to: VAULT, data: encodeFunctionData({ abi: vaultAbi, functionName: "shieldBound", args: [GLOAM, amount, depNote.commitment as Hex, depProof] }) },
  read(GLOAM, encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [TREASURY] })),
];
const after: Call[] = [
  read(NAMES, encodeFunctionData({ abi: gloamNamesAbi, functionName: "resolve", args: [NAME] })),
  read(GLOAM, encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [TREASURY] })),
  read(GLOAM, encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [REGISTRAR] })),
  read(VAULT, encodeFunctionData({ abi: shieldPoolAbi, functionName: "isSpent", args: [nullifier] })),
  read(VAULT, encodeFunctionData({ abi: shieldPoolAbi, functionName: "commitmentSeen", args: [back.commitment as Hex] })),
];

async function simulate(calls: Call[]): Promise<SimCall[]> {
  const base = await client.getBlock();
  const res = (await client.request({
    method: "eth_simulateV1" as never,
    params: [
      {
        blockStateCalls: [
          {
            blockOverrides: { time: toHex(base.timestamp + 1n) },
            stateOverrides: {
              [VAULT]: { stateDiff: { [slotFor(BigInt(ROOT))]: pad("0x01") } },
              [DEPLOYER]: { balance: toHex(10n ** 18n) },
            },
            calls,
          },
        ],
        validation: false,
      },
      toHex(base.number),
    ] as never,
  })) as { calls: SimCall[] }[];
  return res[0]!.calls;
}
const why = (c: SimCall) => {
  const data = (c.error?.data ?? c.returnData) as Hex | undefined;
  if (data && data.length >= 10) {
    for (const abi of [namesRegistrarAbi, shieldPoolAbi] as const) {
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
let allGood = true;
const check = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!cond) allGood = false;
};
const word = (c: SimCall) => BigInt(c.returnData.slice(0, 66));

// 1. the claim
{
  const out = await simulate([...setup, { from: RELAYER, to: REGISTRAR, data: claimData }, ...after]);
  const [dep, esc, , , shield, tBefore, claimCall, resolved, tAfter, regBal, spent, refundSeen] = out;
  check("the registrar deploys", dep!.status === "0x1", dep!.status === "0x1" ? "" : why(dep!));
  check("the app's escrow is the registrar's escrowFor", `0x${esc!.returnData.slice(26, 66)}`.toLowerCase() === escrow.toLowerCase());
  check("real $GLOAM shielded with a real proof backs the note", shield!.status === "0x1", shield!.status === "0x1" ? "" : why(shield!));
  check("claim() with a real unshield proof, through the live vault's verifier", claimCall!.status === "0x1", claimCall!.status === "0x1" ? `gas ${BigInt(claimCall!.gasUsed)}` : why(claimCall!));
  if (claimCall!.status === "0x1") {
    check("it paid the live price", word(claimCall!) === price, formatUnits(word(claimCall!), 18));
    const holder = `0x${resolved!.returnData.slice(26, 66)}`;
    check(`@${NAME} resolves on the live registry to the holder`, holder.toLowerCase() === HOLDER.toLowerCase());
    check("and to the key the claim named", resolved!.returnData.slice(66, 130) === GX.slice(2) && resolved!.returnData.slice(130, 194) === GY.slice(2));
    const got = word(tAfter!) - word(tBefore!);
    check("the treasury got the price (and the dust)", got >= price && got - price < 10n ** 15n, `${formatUnits(got, 18)} GLOAM`);
    check("the registrar ends empty", word(regBal!) === 0n);
    check("the note is spent", word(spent!) === 1n);
    check("the refund note was not used", word(refundSeen!) === 0n);
  }
}

// 2. the unshield sent on its own first: the same call puts the money back as the refund note
{
  const alone = encodeFunctionData({ abi: vaultAbi, functionName: "unshield", args: [unProof, ROOT, nullifier, GLOAM, escrow, amount] });
  const out = await simulate([...setup, { from: STRANGER, to: VAULT, data: alone }, { from: RELAYER, to: REGISTRAR, data: claimData }, ...after]);
  const unshieldAlone = out[6]!;
  const claimCall = out[7]!;
  const resolved = out[8]!;
  const refundSeen = out[12]!;
  check("someone sends the unshield alone (the proof is public)", unshieldAlone.status === "0x1", unshieldAlone.status === "0x1" ? "" : why(unshieldAlone));
  check("the claim call then refunds instead", claimCall.status === "0x1" && word(claimCall) === 0n, claimCall.status === "0x1" ? "" : why(claimCall));
  check("with a real shield proof: the refund note is in the vault", word(refundSeen) === 1n);
  check("and no name was registered", BigInt(`0x${resolved.returnData.slice(26, 66)}`) === 0n);
}

console.log(`\n${allGood ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"} (eth_simulateV1 on top of block ${head.number}; nothing broadcast, no key used)`);
process.exit(allGood ? 0 : 1);
