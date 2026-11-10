/**
 * Product config: keccak Phase-1 pool vs Poseidon Phase-2 pool.
 * Default product path = sealed Poseidon vault on RH testnet.
 *
 * Stale Vercel envs that still point at pre-sealed pool 0xA488… are ignored, * that vault has no sealedSwap and breaks Private trade.
 */

import type { Address } from "viem";
import { PRODUCT_CHAIN_ID } from "./chain";

export type HashScheme = "keccak" | "poseidon";

/** Legacy Phase-1 pool (no sealed swap) */
export const KECCAK_POOL =
  "0x2BD98196D90AB45D58843B4c8B8809aa34343d35" as const satisfies Address;

/** No-middlemen Poseidon pool, live RH testnet. Redeployed 2026-09-29: no
 *  emergencyWithdraw, and after endSetup() every verifier / rate / oracle change
 *  needs a public 3-day timelock. Reuses the existing verifiers + Poseidon2.
 *  Superseded: 0xAc25…aF1c (block 120_461_692), 0xaEbB…1834 (block 110_840_714).
 *  Verifiers are pot16 dev-ceremony keys (regenerate for mainnet). */
export const TESTNET_POSEIDON_POOL =
  "0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740" as const satisfies Address;

export const TESTNET_POSEIDON_DEPLOY_BLOCK = 126_185_021n;

/**
 * Earlier product pools: a stale env pointing at one is remapped to the current pool.
 * 0x4F38…12D8F is the pre-C1 pool, drainable (audit H-P1): it must never be used.
 */
const SUPERSEDED_POOLS = [
  "0xAc25c3C4A880194324d1fC78722694e0F315aF1c",
  "0xaEbB8E3b5C4648Aa7Cc4E41d3Cec008Db4bb1834",
  "0xA488809a089F003A2B6E69daa65B0db79823c93B",
  "0x4F38a4d80e5ca516A2e5549404C7be0E91c12D8F",
];
const SUPERSEDED_BLOCKS = [120_461_692n, 110_840_714n, 90_260_331n, 90_436_718n];

function isSupersededPool(a: string): boolean {
  return SUPERSEDED_POOLS.some((p) => sameAddr(a, p));
}

/** Prior Poseidon pool (pre-sealedSwap), history only, never product default */
export const LEGACY_POSEIDON_POOL =
  "0xA488809a089F003A2B6E69daa65B0db79823c93B" as const satisfies Address;

export const LEGACY_POSEIDON_DEPLOY_BLOCK = 90_260_331n;

function isAddressLike(e: string | undefined): e is Address {
  return Boolean(e && e.startsWith("0x") && e.length === 42);
}

function sameAddr(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Resolve Poseidon product pool.
 * Env may override, but never with a superseded vault (pre-sealed A488, drainable 4F38).
 */
export const POSEIDON_POOL: Address | null = (() => {
  const e = process.env.NEXT_PUBLIC_POSEIDON_SHIELD_POOL;
  if (isAddressLike(e)) {
    if (isSupersededPool(e)) {
      // Stale Vercel env from before a redeploy
      return TESTNET_POSEIDON_POOL;
    }
    return e;
  }
  if (PRODUCT_CHAIN_ID === 46630) return TESTNET_POSEIDON_POOL;
  return null;
})();

/**
 * Which pool the product uses.
 * Default poseidon on RH testnet; set NEXT_PUBLIC_HASH_SCHEME=keccak only for legacy.
 */
export function activeHashScheme(): HashScheme {
  const forced = process.env.NEXT_PUBLIC_HASH_SCHEME as HashScheme | undefined;
  if (forced === "keccak") return "keccak";
  if (forced === "poseidon") return "poseidon";
  if (POSEIDON_POOL) return "poseidon";
  return "keccak";
}

export function activePoolAddress(): Address | null {
  if (activeHashScheme() === "poseidon" && POSEIDON_POOL) {
    return POSEIDON_POOL;
  }
  if (PRODUCT_CHAIN_ID === 46630) {
    const e = process.env.NEXT_PUBLIC_SHIELD_POOL_ADDRESS;
    if (isAddressLike(e)) {
      // Don't silently land on pre-sealed poseidon via wrong env either
      if (isSupersededPool(e)) return TESTNET_POSEIDON_POOL;
      return e;
    }
    return KECCAK_POOL;
  }
  return null;
}

/** Deploy block for getLogs / tree rebuild for the active product pool */
export function activeShieldDeployBlock(): bigint {
  const raw = process.env.NEXT_PUBLIC_SHIELD_DEPLOY_BLOCK?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const n = BigInt(raw);
    // A superseded vault's deploy block must not scan the wrong history for the current vault
    if (
      POSEIDON_POOL &&
      sameAddr(POSEIDON_POOL, TESTNET_POSEIDON_POOL) &&
      SUPERSEDED_BLOCKS.includes(n)
    ) {
      return TESTNET_POSEIDON_DEPLOY_BLOCK;
    }
    return n;
  }
  if (activeHashScheme() === "poseidon") return TESTNET_POSEIDON_DEPLOY_BLOCK;
  return 90_232_912n;
}

export const UNSHIELD_ENABLED =
  process.env.NEXT_PUBLIC_UNSHIELD_ENABLED === "true" ||
  activeHashScheme() === "poseidon";

/**
 * Client diagnostics for Settings / deploy hygiene.
 * Surfaces stale envs (any superseded vault or its deploy block) that were remapped to the current vault.
 */
export function vaultEnvDiagnostics(): {
  productPool: Address;
  activePool: Address | null;
  deployBlock: bigint;
  hashScheme: HashScheme;
  envPoolRaw: string | null;
  remappedFromLegacy: boolean;
  deployBlockRemapped: boolean;
} {
  const envPoolRaw = process.env.NEXT_PUBLIC_POSEIDON_SHIELD_POOL?.trim() || null;
  const remappedFromLegacy = Boolean(envPoolRaw && isSupersededPool(envPoolRaw));
  const rawBlock = process.env.NEXT_PUBLIC_SHIELD_DEPLOY_BLOCK?.trim();
  const deployBlockRemapped = Boolean(
    rawBlock &&
      /^\d+$/.test(rawBlock) &&
      SUPERSEDED_BLOCKS.includes(BigInt(rawBlock)) &&
      POSEIDON_POOL &&
      sameAddr(POSEIDON_POOL, TESTNET_POSEIDON_POOL)
  );
  return {
    productPool: TESTNET_POSEIDON_POOL,
    activePool: activePoolAddress(),
    deployBlock: activeShieldDeployBlock(),
    hashScheme: activeHashScheme(),
    envPoolRaw,
    remappedFromLegacy,
    deployBlockRemapped,
  };
}
