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

/** secp256k1's group order: an EVM signature's s is canonical below half of it (EIP-2). */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * An EVM wallet's 65-byte signature (r, s, v) in one form, so the same key
 * opens the same account whatever wallet app signs with it: wallets disagree
 * on how they write v (27/28, or 0/1 from some hardware and mobile wallets,
 * never on r and s), and a few return the high-s twin of the same signature.
 * v becomes 27/28 and s the low one (its v flipped with it). A signature
 * already in that form, as MetaMask, Rabby and Coinbase Wallet write it, is
 * returned unchanged, so no account opened with one moves. Any other length
 * or v is returned as it came.
 */
export function evmSignatureBytes(signature: string): Uint8Array {
  const h = signature.startsWith("0x") ? signature.slice(2) : signature;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("That isn't a wallet signature.");
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  if (b.length !== 65) return b;
  let v = b[64]!;
  if (v === 0 || v === 1) v += 27;
  if (v !== 27 && v !== 28) return b;
  let s = toBig(b.subarray(32, 64));
  if (s > SECP256K1_N >> 1n) {
    s = SECP256K1_N - s;
    v = v === 27 ? 28 : 27;
  }
  const out = new Uint8Array(65);
  out.set(b.subarray(0, 32), 0);
  out.set(Uint8Array.from(s.toString(16).padStart(64, "0").match(/../g)!, (x) => parseInt(x, 16)), 32);
  out[64] = v;
  b.fill(0);
  return out;
}

export class StarknetWalletError extends Error {
  override readonly name = "StarknetWalletError";
}

/**
 * The seed of private account `index` from a browser wallet (EVM): its
 * signature of starknetAccountMessage(index), in one form (evmSignatureBytes).
 * When `isNew` says no account is there yet, the wallet signs a second time and
 * must sign the same way: a wallet that signs differently each time (some MPC
 * and smart wallets) would open an account no later signature reopens, on
 * another device or once this one forgets it. An account already there needs
 * one signature: it reopened, so the wallet is steady.
 */
export async function seedFromWallet(
  sign: (message: string) => Promise<string>,
  index: number,
  isNew: (seed: Uint8Array) => Promise<boolean>,
  beforeSecond?: () => void
): Promise<Uint8Array> {
  const message = starknetAccountMessage(index);
  const once = async () => {
    const bytes = evmSignatureBytes(await sign(message));
    try {
      return await seedFromWalletSignature(bytes, index);
    } finally {
      bytes.fill(0);
    }
  };
  const first = await once();
  try {
    if (!(await isNew(first))) return first;
    beforeSecond?.();
    const second = await once();
    const same = second.length === first.length && second.every((x, i) => x === first[i]);
    second.fill(0);
    if (!same) {
      throw new StarknetWalletError("This wallet signs differently each time, so it can't hold a private account here. Use another wallet, or sign in with email or a passkey.");
    }
    return first;
  } catch (e) {
    first.fill(0);
    throw e;
  }
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
