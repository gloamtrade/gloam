/**
 * Gloam's account layer on Starknet: each person's private account is a
 * Starknet account derived from their Gloam key, not their main wallet.
 *
 * Where the 32-byte account seed comes from, the same two ways a private
 * account on Solana opens (lib/solanaRings/account, lib/solanaRings/gloamRoot),
 * each with its own Starknet salt so no Solana account and no Starknet account
 * ever share a key:
 *  - a browser wallet's signature of starknetAccountMessage(index)
 *    (seedFromWalletSignature). The wallet is the backup: the same wallet
 *    signs the same message the same way, so it reopens the same account.
 *  - a Gloam wallet's root, the passkey PRF output or the backup code
 *    (seedFromGloamRoot), because Turnkey can read a Gloam wallet's signatures.
 *
 * From the seed, HKDF-SHA256 gives two keys (keysFromSeed):
 *  - the account key (info gloam/starknet/account/<i>), a Stark curve private
 *    key that signs for the account. Its OpenZeppelin account (constructor
 *    [public key]) is deployed by Gloam's relay through the UDC with salt =
 *    public key and not unique, so its address depends on the key alone
 *    (accountAddress) and the person never needs STRK to deploy it.
 *  - the viewing key (info gloam/starknet/viewing/<i>): what the pool
 *    encrypts the account's notes to. The pool accepts only a canonical key,
 *    below half the curve order. It is registered on chain sealed to the pool's
 *    auditor key (lib/starknetPrivacy/config says what that means).
 *
 * Changing a message, a salt or an info string changes every person's account.
 */
import { CallData, ec, hash, num, type Call } from "starknet";
import { STARKNET_ACCOUNT_CLASS_HASH, STARKNET_UDC, STARKNET_UDC_ENTRYPOINT } from "./config";

const enc = new TextEncoder();
const CURVE_ORDER: bigint = ec.starkCurve.CURVE.n;
const HALF_ORDER = CURVE_ORDER >> 1n;

/** HKDF salts; part of every account's identity. */
const WALLET_SALT = "gloam/starknet-account/v1";
const ROOT_SALT = "gloam/starknet-account/root/v1";

export type StarknetRootKind = "passkey" | "code";

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("This browser can't open a private Starknet account (no Web Crypto).");
  return s;
};

const ab = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function checkIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index > 1_000_000) throw new Error("Invalid account index.");
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, bits: number): Promise<Uint8Array> {
  const key = await subtle().importKey("raw", ab(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: ab(salt), info: ab(enc.encode(info)) }, key, bits));
}

const toBig = (b: Uint8Array): bigint => BigInt("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));

/** The text a main wallet signs to open private account `index` on Starknet. Never change it. */
export function starknetAccountMessage(index: number): string {
  checkIndex(index);
  return `Gloam private account on Starknet\n\nSign to open your private account. This signature is its key: only sign it on gloam.trade.\n\nVersion: 1\nAccount: ${index}`;
}

/**
 * The 32-byte seed of private account `index` from a main wallet's signature of
 * starknetAccountMessage(index): 65 bytes from an EVM wallet (personal_sign),
 * 64 from a Solana wallet.
 */
export async function seedFromWalletSignature(signature: Uint8Array, index: number): Promise<Uint8Array> {
  checkIndex(index);
  if (signature.length !== 64 && signature.length !== 65) throw new Error("A wallet signature is 64 or 65 bytes.");
  return hkdf(signature, enc.encode(WALLET_SALT), `account/${index}`, 256);
}

/** The 32-byte seed of private account `index` from a Gloam wallet's root (passkey PRF output or backup code). */
export async function seedFromGloamRoot(root: Uint8Array, kind: StarknetRootKind, index: number): Promise<Uint8Array> {
  checkIndex(index);
  if (root.length < 16) throw new Error("That key is too short to open a private account.");
  return hkdf(root, enc.encode(ROOT_SALT), `${kind}/account/${index}`, 256);
}

export type StarknetAccountKeys = {
  /** Stark curve private key of the account (never leaves the browser). */
  accountKey: bigint;
  /** Its public key (x coordinate), the account's constructor argument and UDC salt. */
  publicKey: string;
  /** The pool viewing key, canonical (0 < key < n/2). */
  viewingKey: bigint;
  /** The account's address once the relay deploys it (accountAddress). */
  address: string;
};

/** Reduce 512 HKDF bits mod the curve order (bias about 2^-260) to a non-zero scalar. */
function scalar(b: Uint8Array): bigint {
  const k = toBig(b) % CURVE_ORDER;
  return k === 0n ? 1n : k;
}

/** The pool's canonical form: below half the order, non-zero (privacy::utils::is_canonical_key). */
export function canonicalViewingKey(k: bigint): bigint {
  let s = k % CURVE_ORDER;
  if (s >= HALF_ORDER) s = CURVE_ORDER - s;
  return s === 0n || s >= HALF_ORDER ? 1n : s;
}

/** The account's keys and address from its seed. `index` is bound in again for each key. */
export async function keysFromSeed(seed: Uint8Array, index = 0, classHash = STARKNET_ACCOUNT_CLASS_HASH): Promise<StarknetAccountKeys> {
  checkIndex(index);
  if (seed.length < 16) throw new Error("An account seed is at least 16 bytes.");
  const empty = new Uint8Array(0);
  const accountKey = scalar(await hkdf(seed, empty, `gloam/starknet/account/${index}`, 512));
  const viewingKey = canonicalViewingKey(toBig(await hkdf(seed, empty, `gloam/starknet/viewing/${index}`, 512)));
  const publicKey = ec.starkCurve.getStarkKey(num.toHex(accountKey));
  return { accountKey, publicKey, viewingKey, address: accountAddress(publicKey, classHash) };
}

/** Where the relay's UDC deploy (salt = public key, not unique) puts the account for `publicKey`. */
export function accountAddress(publicKey: string, classHash = STARKNET_ACCOUNT_CLASS_HASH): string {
  const calldata = CallData.compile([publicKey]);
  return num.toHex(hash.calculateContractAddressFromHash(publicKey, classHash, calldata, 0));
}

/** The one call that deploys the account for `publicKey` (sent by Gloam's relay, checked by relayPolicy). */
export function deployAccountCall(publicKey: string, classHash = STARKNET_ACCOUNT_CLASS_HASH): Call {
  return {
    contractAddress: STARKNET_UDC,
    entrypoint: STARKNET_UDC_ENTRYPOINT,
    // class_hash, salt, unique (false: the address does not depend on who deploys), calldata
    calldata: [classHash, publicKey, "0x0", "0x1", publicKey],
  };
}
