/**
 * Gloam's account layer on Solana: each person's private account is not their
 * main wallet.
 *
 * Private account `index` of a main wallet is a fresh Ed25519 key whose 32-byte
 * seed is HKDF-SHA256 over the main wallet's signature of accountMessage(index).
 * Ed25519 signatures are deterministic (RFC 8032), so the same wallet always
 * reopens the same account on any device: the wallet is the backup, and nothing
 * is stored. The account's shielded nullifier and viewing keys then come from
 * the account key itself (the SDK's own derivation), never from the main wallet.
 *
 * Gloam's relay pays every fee (app/api/solana/relay), so a private account
 * never holds SOL and never needs any from the main wallet: a payment shows the
 * two private accounts, not anyone's main wallet. Adding money still shows the
 * main wallet funding its private account, and on the Default Ring every
 * payment shows both private accounts, so moving to account `index + 1` links
 * the two. It is not a way to unlink.
 *
 * Changing ACCOUNT_MESSAGE or the HKDF salt changes every person's account.
 */

/** HKDF salt; part of every account's identity. */
const HKDF_SALT = new TextEncoder().encode("gloam/solana-account/v1");

/** The text a main wallet signs to open private account `index`. Never change it. */
export function accountMessage(index: number): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0 || index > 1_000_000) throw new Error("Invalid account index.");
  return new TextEncoder().encode(
    `Gloam private account on Solana\n\nSign to open your private account. This signature is its key: only sign it on gloam.trade.\n\nVersion: 1\nAccount: ${index}`
  );
}

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("This browser can't open a private Solana account (no Web Crypto).");
  return s;
};

const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** The 32-byte Ed25519 seed of private account `index`, from the main wallet's signature. */
export async function accountSeed(walletSignature: Uint8Array, index: number): Promise<Uint8Array> {
  if (walletSignature.length !== 64) throw new Error("A Solana wallet signature is 64 bytes.");
  accountMessage(index); // validates the index
  const key = await subtle().importKey("raw", buf(walletSignature), "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: buf(HKDF_SALT), info: buf(new TextEncoder().encode(`account/${index}`)) },
    key,
    256
  );
  return new Uint8Array(bits);
}

/**
 * True when `signature` is the wallet's plain Ed25519 signature over `message`.
 * A wallet that signs some other envelope (a prefix, a hash) gives an account
 * no other wallet holding the same key would reopen, so it is refused.
 */
export async function isPlainSignature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await subtle().importKey("raw", buf(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await subtle().verify({ name: "Ed25519" }, key, buf(signature), buf(message));
  } catch {
    return false;
  }
}

/** The private account's keys (an SDK ShieldedKeypair). Destroy it when done. */
export async function deriveAccount(walletSignature: Uint8Array, index: number, onSeed?: (seed: Uint8Array) => void) {
  const seed = await accountSeed(walletSignature, index);
  try {
    onSeed?.(seed);
    return await accountFromSeed(seed);
  } finally {
    seed.fill(0);
  }
}

/** The account a seed from accountSeed makes (a kept seed reopens it with no signature: lib/solanaRings/keep). */
export async function accountFromSeed(seed: Uint8Array) {
  if (seed.length !== 32) throw new Error("An account seed is 32 bytes.");
  const { ShieldedKeypair, SigningKey, initializePoseidon } = await import("@heliuslabs/spr");
  await initializePoseidon(); // the account's shielded address hashes with it
  return ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as never));
}
