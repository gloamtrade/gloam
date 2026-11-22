/**
 * Claiming a Gloam name from a private balance (contracts/src/GloamNamesRegistrar.sol).
 * One GLOAM note in the Robinhood Chain vault pays the GloamNames registry in one
 * relayed transaction: no public wallet pays, so nobody can see which wallet bought
 * the name. The holder (who may re-point or hand on the name) stays public, as on
 * any name.
 *
 * The note's unshield proof names a per-claim escrow as `to`, derived from the note,
 * the name, its key, holder and years, and a refund note, so nobody who copies the
 * proof can change any of them (the same pattern as private swaps, lib/vaultSwap).
 *
 * Shared by the app and the relay server: no browser-only imports here.
 */
import { concatHex, encodeAbiParameters, getContractAddress, keccak256, stringToBytes, type Address, type Hex, type PublicClient } from "viem";
import { SWAP_ESCROW_INIT_CODE, refundAmountFor, vaultFeeOf } from "./vaultSwap";
import { GLOAM_TOKEN } from "./buybacks";

/**
 * The registrar on Robinhood Chain mainnet (deployed 21 Nov 2026, block 119888677,
 * Sourcify exact_match). Set to null to switch private claims off.
 */
export const NAMES_REGISTRAR_ADDRESS: Address | null = "0x2B28b693EA3A880085fe582E55B7f0EEC86d3EDB";

/** The chain names live on, where the registrar spends notes. */
export const NAME_CLAIM_CHAIN_ID = 4663;

/** What a claim's escrow address is derived from (GloamNamesRegistrar.EscrowKey). */
export type NameEscrowKey = {
  nullifier: Hex;
  amount: bigint;
  nameHash: Hex;
  keyX: Hex;
  keyY: Hex;
  holder: Address;
  years: bigint;
  refundCommitment: Hex;
  refundAmount: bigint;
};

const KEY_COMPONENTS = [
  { name: "nullifier", type: "bytes32" },
  { name: "amount", type: "uint256" },
  { name: "nameHash", type: "bytes32" },
  { name: "keyX", type: "bytes32" },
  { name: "keyY", type: "bytes32" },
  { name: "holder", type: "address" },
  { name: "years_", type: "uint256" },
  { name: "refundCommitment", type: "bytes32" },
  { name: "refundAmount", type: "uint256" },
] as const;

export const nameHashOf = (name: string): Hex => keccak256(stringToBytes(name));

/**
 * The address a claim's unshield proof must name as `to`: the registrar's CREATE2
 * escrow (the same SwapEscrow code the swap routers use, holding $GLOAM).
 */
export function nameEscrowAddress(registrar: Address, key: NameEscrowKey): Address {
  const salt = keccak256(
    encodeAbiParameters(
      [{ type: "tuple", components: KEY_COMPONENTS }],
      [
        {
          nullifier: key.nullifier,
          amount: key.amount,
          nameHash: key.nameHash,
          keyX: key.keyX,
          keyY: key.keyY,
          holder: key.holder,
          years_: key.years,
          refundCommitment: key.refundCommitment,
          refundAmount: key.refundAmount,
        },
      ]
    )
  );
  const bytecode = concatHex([SWAP_ESCROW_INIT_CODE, encodeAbiParameters([{ type: "address" }], [GLOAM_TOKEN])]);
  return getContractAddress({ opcode: "CREATE2", from: registrar, salt, bytecode });
}

/**
 * The smallest note whose amount after the vault's cash-out fee covers `price`:
 * the registrar pays the registry from what arrives, and the treasury gets the
 * rounding dust.
 */
export function noteForPrice(price: bigint, feeBps: number): bigint {
  if (price <= 0n) return 0n;
  const bps = BigInt(feeBps);
  let a = (price * 10_000n + (10_000n - bps) - 1n) / (10_000n - bps);
  // the fee rounds down, so the estimate can be a little off either way
  while (a - vaultFeeOf(a, feeBps) < price) a++;
  while (a > 1n && a - 1n - vaultFeeOf(a - 1n, feeBps) >= price) a--;
  return a;
}

/** The refund note a claim makes in advance: the note less the vault's highest possible fee (1%). */
export function nameClaimRefundAmount(amount: bigint): bigint {
  return refundAmountFor(amount);
}

const SPEND = [
  { name: "proof", type: "bytes" },
  { name: "root", type: "bytes32" },
  { name: "nullifier", type: "bytes32" },
  { name: "amount", type: "uint256" },
] as const;
const CLAIM = [
  { name: "name", type: "string" },
  { name: "keyX", type: "bytes32" },
  { name: "keyY", type: "bytes32" },
  { name: "holder", type: "address" },
  { name: "years_", type: "uint256" },
] as const;
const REFUND = [
  { name: "proof", type: "bytes" },
  { name: "commitment", type: "bytes32" },
  { name: "amount", type: "uint256" },
] as const;

export const namesRegistrarAbi = [
  {
    type: "function",
    name: "escrowFor",
    stateMutability: "view",
    inputs: [{ name: "k", type: "tuple", components: KEY_COMPONENTS }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "s", type: "tuple", components: SPEND },
      { name: "c", type: "tuple", components: CLAIM },
      { name: "r", type: "tuple", components: REFUND },
    ],
    outputs: [{ name: "paid", type: "uint256" }],
  },
  { type: "error", name: "BadRefund", inputs: [] },
  { type: "error", name: "EscrowUsed", inputs: [] },
  {
    type: "error",
    name: "ShortInput",
    inputs: [
      { name: "price", type: "uint256" },
      { name: "available", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "PaidWrong",
    inputs: [
      { name: "paid", type: "uint256" },
      { name: "price", type: "uint256" },
    ],
  },
  { type: "error", name: "Reentrancy", inputs: [] },
  { type: "error", name: "TokenCallFailed", inputs: [] },
  // the registry's own, raised through the registrar
  { type: "error", name: "NotAvailable", inputs: [] },
  { type: "error", name: "Reserved", inputs: [] },
  { type: "error", name: "BadName", inputs: [] },
  { type: "error", name: "BadKey", inputs: [] },
  { type: "error", name: "BadYears", inputs: [] },
  { type: "error", name: "PaymentFailed", inputs: [] },
] as const;

export type NameClaimSpend = { proof: Hex; root: Hex; nullifier: Hex; amount: bigint };
export type NameClaimClaim = { name: string; keyX: Hex; keyY: Hex; holder: Address; years: bigint };
export type NameClaimRefund = { proof: Hex; commitment: Hex; amount: bigint };

/** The claim call's arguments as the registrar takes them. */
export function claimArgs(s: NameClaimSpend, c: NameClaimClaim, r: NameClaimRefund) {
  return [
    s,
    { name: c.name, keyX: c.keyX, keyY: c.keyY, holder: c.holder, years_: c.years },
    r,
  ] as const;
}

/** The escrow key of a claim call. */
export function claimEscrowKey(s: NameClaimSpend, c: NameClaimClaim, r: NameClaimRefund): NameEscrowKey {
  return {
    nullifier: s.nullifier,
    amount: s.amount,
    nameHash: nameHashOf(c.name),
    keyX: c.keyX,
    keyY: c.keyY,
    holder: c.holder,
    years: c.years,
    refundCommitment: r.commitment,
    refundAmount: r.amount,
  };
}

/**
 * On a private name claim's refund note (lib/nameClaimRun): the claim it was made for.
 * The spent note's nullifier is the refund note's `sweptFrom`, and the refund is the
 * note itself, so with this a sync can work out the claim's escrow, see the money
 * waiting there if the note's unshield went out on its own, and send the same claim
 * again for the registrar's refunding branch (finishNameClaimRefund). Neither proof is
 * kept: that branch never reads the spend proof, and the refund's shield proof is made
 * again from the note's secret.
 */
export type NameClaimRefundInfo = {
  registrar: Address;
  /** The claimed note's amount, a decimal string. */
  amount: string;
  name: string;
  keyX: Hex;
  keyY: Hex;
  holder: Address;
  /** A decimal string. */
  years: string;
  /** The relay's send of this claim, once it answered: a sync reads how it ended if this tab never heard. */
  sent?: { hash: Hex; at: number };
};

/** The claim a refund note was made for, as the registrar takes it. */
export function nameRefundClaim(info: NameClaimRefundInfo): NameClaimClaim {
  return { name: info.name, keyX: info.keyX, keyY: info.keyY, holder: info.holder, years: BigInt(info.years) };
}

/** The escrow a name claim's refund note waits on. */
export function nameRefundEscrow(info: NameClaimRefundInfo, nullifier: Hex, refundCommitment: Hex, refundAmount: bigint): Address {
  const key = claimEscrowKey(
    { proof: "0x", root: "0x", nullifier, amount: BigInt(info.amount) },
    nameRefundClaim(info),
    { proof: "0x", commitment: refundCommitment, amount: refundAmount }
  );
  return nameEscrowAddress(info.registrar, key);
}

const balanceOfAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * Does a name claim's money wait at its escrow, at `blockNumber`? Only the registrar
 * opens the escrow, and only through a claim, so money there means the note's unshield
 * went out on its own and the claim can still put it back as the refund note (the
 * refunding branch needs at least the refund's amount there). Anything less is a
 * claim that already ran, or dust someone sent: nothing comes back from it.
 */
export async function nameEscrowHolds(
  client: Pick<PublicClient, "readContract">,
  info: NameClaimRefundInfo,
  nullifier: Hex,
  refundCommitment: Hex,
  refundAmount: bigint,
  blockNumber?: bigint
): Promise<boolean> {
  const escrow = nameRefundEscrow(info, nullifier, refundCommitment, refundAmount);
  const held = await client.readContract({
    address: GLOAM_TOKEN,
    abi: balanceOfAbi,
    functionName: "balanceOf",
    args: [escrow],
    ...(blockNumber !== undefined ? { blockNumber } : {}),
  });
  return held >= refundAmount;
}

/**
 * After a claim this tab never heard the end of: asks `read` every `everyMs` until
 * `name` points to `tag` (the name landed), for up to `waitMs`. False when it never did.
 */
export async function waitForNameClaim(
  read: (name: string) => Promise<{ tag: string } | null>,
  name: string,
  tag: string,
  opts: { waitMs?: number; everyMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<boolean> {
  const { waitMs = 90_000, everyMs = 5_000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = opts;
  for (let waited = 0; ; waited += everyMs) {
    const record = await read(name).catch(() => null);
    if (record && record.tag === tag) return true;
    if (waited + everyMs > waitMs) return false;
    await sleep(everyMs);
  }
}
