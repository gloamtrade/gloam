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
import { concatHex, encodeAbiParameters, getContractAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
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
