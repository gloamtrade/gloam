/**
 * Gloam on Solana, the facts: the network, its assets, what a private payment
 * hides there, and the account derivation every Gloam client shares. Pure, no
 * dependencies, so it ships in the SDK's root export. The client that moves
 * money is `@gloamtrade/sdk/solana` (src/solana.ts).
 *
 * Gloam runs on Solana through Helius Solana Privacy Rings (the permissionless
 * Default Ring). What that hides, said plainly: the asset and the amount of a
 * private payment. The two private accounts a payment moves between are
 * public, adding money shows the wallet it came from, and a cash out shows its
 * destination, asset and amount. Proofs are made by Helius's prover (an
 * attested enclave), which sees a payment's details while it proves.
 *
 * Gloam's account layer: each main wallet's private account is a separate
 * Ed25519 key, derived from the wallet's signature over a fixed text (below),
 * so the same wallet reopens the same private account in the Gloam app and in
 * this SDK, on any device, with nothing stored. Gloam's relay pays every fee
 * after an add, so a private account never needs SOL from the main wallet.
 */

export type SolanaNetworkKey = "mainnet" | "devnet";

/** Where Gloam's Solana endpoints live: `${base}/api/solana/{rpc,spr,relay}`. */
export const GLOAM_SOLANA_BASE_URL = "https://www.gloam.trade";

/**
 * An id for Solana where Gloam lists networks by a number (the spending limits
 * of @gloamtrade/mcp, cross-chain routes). Solana has no EVM chain id; this is
 * the one Relay (relay.link) uses for Solana mainnet, which the Gloam app's
 * bridge already uses.
 */
export const SOLANA_MAINNET_CHAIN_ID = 792703809;

export interface SolanaAsset {
  /** "sol", "usdc", "usdt": the key balances come back under. */
  id: "sol" | "usdc" | "usdt";
  symbol: string;
  name: string;
  /** The SPL mint, or null for SOL itself. */
  mint: string | null;
  decimals: number;
}

const SOL: SolanaAsset = { id: "sol", symbol: "SOL", name: "Solana", mint: null, decimals: 9 };

/** What Gloam lists on Solana. Read on chain 2026-11-22: USDC and USDT are set up in the mainnet pool. */
export const SOLANA_ASSETS: Record<SolanaNetworkKey, readonly SolanaAsset[]> = {
  mainnet: [
    SOL,
    { id: "usdc", symbol: "USDC", name: "USD Coin", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
    { id: "usdt", symbol: "USDT", name: "Tether USD", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
  ],
  devnet: [
    SOL,
    // Circle's devnet USDC (faucet.circle.com)
    { id: "usdc", symbol: "USDC", name: "USD Coin", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6 },
  ],
};

/**
 * How the Rings SDK names SOL in a private balance: the system program's
 * address, not the wrapped SOL mint.
 */
export const SOLANA_RINGS_SOL_MINT = "11111111111111111111111111111111";

/** The plain line every Gloam surface uses for Solana. Never claims the sender or the recipient is hidden. */
export const SOLANA_PRIVACY_NOTE =
  "On Solana, a private payment hides the asset and the amount. The two private accounts it moves between are visible, and adding money shows the wallet it came from. Proofs are made by Helius's prover.";

/** What a chain observer sees on Solana, and what it does not. */
export const SOLANA_PRIVACY = {
  hidden: ["the asset of a private payment", "the amount of a private payment", "the private balance"],
  visible: [
    "the two private accounts a private payment moves between (sender and recipient are not hidden)",
    "adding money: the main wallet it came from, the asset and the amount",
    "a cash out: the private account, the destination address, the asset and the amount",
    "that a Privacy Rings transaction happened, and Gloam's relay as its fee payer",
  ],
  mainWallet:
    "Your private account is a separate key derived from your main wallet's signature, and Gloam's relay pays its fees, so private payments name the private account, not the main wallet. Adding money links the main wallet to its private account.",
  prover:
    "Proofs are made by Helius's prover, which runs in an attested enclave. The SDK encrypts each proof request to that enclave, so Gloam's proxy carries ciphertext, but the enclave sees the payment's details while it proves.",
  ring: "Helius Solana Privacy Rings, the permissionless Default Ring.",
} as const;

export interface SolanaNetworkInfo {
  key: "solana-mainnet" | "solana-devnet";
  name: string;
  network: SolanaNetworkKey;
  /** See SOLANA_MAINNET_CHAIN_ID. null on devnet. */
  chainId: number | null;
  assets: readonly SolanaAsset[];
  privacy: string;
  hidden: readonly string[];
  visible: readonly string[];
  fees: string;
  explorer: string;
  endpoints: { rpc: string; spr: string; relay: string };
}

/** Gloam's Solana endpoints under `base` (default https://www.gloam.trade). */
export function solanaEndpoints(base: string = GLOAM_SOLANA_BASE_URL): { rpc: string; spr: string; relay: string } {
  const o = base.replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(o)) throw new Error(`Not an http(s) base URL: ${base}`);
  return { rpc: `${o}/api/solana/rpc`, spr: `${o}/api/solana/spr`, relay: `${o}/api/solana/relay` };
}

/** Gloam on Solana, for a network list. */
export function solanaNetworkInfo(network: SolanaNetworkKey = "mainnet", base: string = GLOAM_SOLANA_BASE_URL): SolanaNetworkInfo {
  return {
    key: network === "devnet" ? "solana-devnet" : "solana-mainnet",
    name: network === "devnet" ? "Solana devnet" : "Solana",
    network,
    chainId: network === "devnet" ? null : SOLANA_MAINNET_CHAIN_ID,
    assets: SOLANA_ASSETS[network],
    privacy: SOLANA_PRIVACY_NOTE,
    hidden: SOLANA_PRIVACY.hidden,
    visible: SOLANA_PRIVACY.visible,
    fees: "Adding money: the main wallet pays Solana's fee. Registering, paying privately and cashing out: Gloam's relay pays the fees.",
    explorer: network === "devnet" ? "https://solscan.io/?cluster=devnet" : "https://solscan.io",
    endpoints: solanaEndpoints(base),
  };
}

/** A Solana transaction on an explorer. */
export function solanaExplorerTx(signature: string, network: SolanaNetworkKey = "mainnet"): string {
  return `https://solscan.io/tx/${encodeURIComponent(signature)}${network === "devnet" ? "?cluster=devnet" : ""}`;
}

/** The listed asset named by `id`, symbol or mint, or null. */
export function solanaAsset(idOrSymbolOrMint: string, network: SolanaNetworkKey = "mainnet"): SolanaAsset | null {
  const k = idOrSymbolOrMint.trim();
  return (
    SOLANA_ASSETS[network].find(
      (a) => a.id === k.toLowerCase() || a.symbol.toLowerCase() === k.toLowerCase() || (a.mint !== null && a.mint === k)
    ) ?? null
  );
}

// ------------------------------------------------------------------ base58

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin alphabet), as Solana writes addresses and signatures. */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + out;
}

/** Base58 to bytes; throws on a character outside the alphabet. */
export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  let n = 0n;
  for (const ch of text) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("Not base58.");
    n = n * 58n + BigInt(i);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}

/** A Solana address by shape: base58 of 32 bytes. */
export function isSolanaAddress(v: unknown): boolean {
  if (typeof v !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return false;
  try {
    return base58Decode(v).length === 32;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ account layer (same as app/src/lib/solanaRings/account.ts)

/** HKDF salt; part of every account's identity. Never change it. */
const HKDF_SALT = "gloam/solana-account/v1";
/** Highest account index Gloam opens. */
export const SOLANA_MAX_ACCOUNT_INDEX = 1_000_000;

/**
 * The text a main wallet signs to open private account `index`. Byte for byte
 * the Gloam app's: changing it would change every person's account.
 */
export function solanaAccountMessage(index: number): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0 || index > SOLANA_MAX_ACCOUNT_INDEX) throw new Error("Invalid account index.");
  return new TextEncoder().encode(
    `Gloam private account on Solana\n\nSign to open your private account. This signature is its key: only sign it on gloam.trade.\n\nVersion: 1\nAccount: ${index}`
  );
}

function subtle(): typeof crypto.subtle {
  const s = (globalThis as { crypto?: { subtle?: typeof crypto.subtle } }).crypto?.subtle;
  if (!s) throw new Error("No Web Crypto here, so a private Solana account can't be opened (Node 20+ or a modern browser).");
  return s;
}

const ab = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/**
 * The 32-byte Ed25519 seed of private account `index`:
 * HKDF-SHA256(walletSignature, salt "gloam/solana-account/v1", info "account/<index>").
 * Ed25519 signatures are deterministic, so the same wallet always gets the same seed.
 */
export async function solanaAccountSeed(walletSignature: Uint8Array, index: number): Promise<Uint8Array> {
  if (walletSignature.length !== 64) throw new Error("A Solana wallet signature is 64 bytes.");
  solanaAccountMessage(index); // validates the index
  const key = await subtle().importKey("raw", ab(walletSignature), "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: ab(new TextEncoder().encode(HKDF_SALT)), info: ab(new TextEncoder().encode(`account/${index}`)) },
    key,
    256
  );
  return new Uint8Array(bits);
}

/**
 * True when `signature` is the plain Ed25519 signature of `publicKey` over
 * `message`. A wallet that signs some other envelope (a prefix, a hash) would
 * open an account no other wallet holding the same key reopens, so Gloam
 * refuses it.
 */
export async function isPlainSolanaSignature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await subtle().importKey("raw", ab(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await subtle().verify({ name: "Ed25519" }, key, ab(signature), ab(message));
  } catch {
    return false;
  }
}
