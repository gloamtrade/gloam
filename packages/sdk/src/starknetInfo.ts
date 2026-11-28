/**
 * Gloam on Starknet, the facts: the network, its pool and asset, what a
 * private payment hides there, the account derivation every Gloam client
 * shares, and the claim link format. Pure, no dependencies, so it ships in the
 * SDK's root export. The client that moves money is `@gloamtrade/sdk/starknet`
 * (src/starknet.ts).
 *
 * Gloam runs on Starknet through Starknet's own privacy pool (STRK20,
 * starkware-libs/starknet-privacy), not the Gloam vault. What that hides, said
 * plainly: a payment over a channel that is already open hides who paid, who
 * was paid and how much. The first payment to someone opens a channel to them,
 * which shows their private account (never who paid or how much). Adding money
 * shows the private account and the amount; a cash out shows where the money
 * went and how much, never which private account it came from. The pool has a
 * mandatory auditor key: registering stores the account's viewing key
 * encrypted to it, so its holder can read that account's private activity for
 * authorized inspection (it cannot spend). Proofs are made by Starkscan's
 * prover, which runs each transaction to prove it, so it sees it too.
 *
 * Gloam's account layer keeps a person's main wallet out of the pool: each
 * private account is a Starknet account derived from a Gloam key (a wallet's
 * signature over a fixed text, or a Gloam wallet's passkey or backup code),
 * deployed and paid for by Gloam's relay, so it never holds STRK.
 *
 * Every value and string here is byte for byte the Gloam app's
 * (app/src/lib/starknetPrivacy/account.ts, config.ts, claimLink.ts); the SDK's
 * self-tests check it against the app.
 */
import { base58Decode, base58Encode } from "./solanaInfo.js";

export type StarknetNetworkKey = "mainnet" | "sepolia" | "devnet";

/** Where Gloam's Starknet routes live: `${base}/api/starknet/{rpc,prove,relay,discovery}`. */
export const GLOAM_STARKNET_BASE_URL = "https://www.gloam.trade";

/** Starknet chain ids, as felts (the short strings SN_MAIN, SN_SEPOLIA, SN_DEVNET). */
export const STARKNET_CHAIN_IDS: Record<StarknetNetworkKey, string> = {
  mainnet: "0x534e5f4d41494e",
  sepolia: "0x534e5f5345504f4c4941",
  devnet: "0x534e5f4445564e4554",
};

/**
 * An id for Starknet where Gloam lists networks by a number (the spending
 * limits of @gloamtrade/mcp, networkName). Starknet's own chain id is the felt
 * SN_MAIN, too large for a JavaScript number, and no bridge Gloam uses has an
 * id for it, so this is Gloam's own: "STRK" in ASCII (0x5354524b), the way
 * Aurora's chain id is "NEAR". Never sent to any chain.
 */
export const STARKNET_MAINNET_LIST_ID = 0x5354524b;

/**
 * Starknet's canonical privacy pool on mainnet (Starkscan: "Starknet: Canonical
 * Privacy Pool", read 2026-11-26). The SDK proves only into this pool on
 * mainnet, whatever a server says.
 */
export const STARKNET_MAINNET_POOL = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
/** Its class on 2026-11-26. Gloam's relay sends to the pool only while it is this one. */
export const STARKNET_MAINNET_POOL_CLASS_HASH = "0x06d163f2b27df0f53c5b0d019366261ba8034af1bef949dee920a60fe58bcf83";
/**
 * The account class every Gloam Starknet account is deployed from:
 * OpenZeppelin's account, constructor [public key]. Part of every account's
 * address: never changes.
 */
export const STARKNET_ACCOUNT_CLASS_HASH = "0x05b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564";
/** The Universal Deployer Contract (v2), the same address on every network. */
export const STARKNET_UDC = "0x02ceed65a4bd731034c01113685c831b01c15d7d432f71afb1cf1634b53a2125";
export const STARKNET_UDC_ENTRYPOINT = "deploy_contract";
/** STRK, the fee token (Gloam's relay pays it; a private account never holds it). */
export const STARKNET_STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
/** Circle's USDC on Starknet mainnet (6 decimals). */
export const STARKNET_USDC = "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
/** starknet-devnet's predeployed ETH, which stands in for USDC on a local devnet (18 decimals). */
export const STARKNET_DEVNET_TEST_TOKEN = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";

export interface StarknetAsset {
  /** "usdc" on mainnet, "test" on a devnet: the key balances come back under. */
  id: "usdc" | "test";
  symbol: string;
  name: string;
  /** The token contract. */
  address: string;
  decimals: number;
  /** A dollar stablecoin. */
  stable: boolean;
}

/**
 * What Gloam lists on Starknet. Mainnet: USDC. A devnet uses its predeployed
 * ETH as a test token. Sepolia has no prover or listed pool yet, so nothing.
 */
export const STARKNET_ASSETS: Record<StarknetNetworkKey, readonly StarknetAsset[]> = {
  mainnet: [{ id: "usdc", symbol: "USDC", name: "USD Coin", address: STARKNET_USDC, decimals: 6, stable: true }],
  sepolia: [],
  devnet: [{ id: "test", symbol: "TEST", name: "Devnet test token (ETH)", address: STARKNET_DEVNET_TEST_TOKEN, decimals: 18, stable: false }],
};

/** The plain line every Gloam surface uses for Starknet. It never claims the first payment hides the payee. */
export const STARKNET_PRIVACY_NOTE =
  "On Starknet, a payment over a channel that is already open hides who paid, who was paid and how much. The first payment to someone shows their private account. Adding money shows the account and the amount, and a cash out shows where it went and how much. The pool's auditor key can read what an account does, and Starkscan's prover sees each transaction it proves.";

/** What a chain observer and the services around Starknet's pool see, and what they do not. */
export const STARKNET_PRIVACY = {
  hidden: [
    "a payment over a channel that is already open: who paid, who was paid and the amount",
    "a first payment: who paid and the amount",
    "the private balance",
    "a cash out: which private account it came from",
  ],
  visible: [
    "the first payment to someone: their private account (it opens a channel to them); a payroll with several first payments shows those accounts together",
    "adding money: the private account it went into and the amount",
    "a cash out: the destination address and the amount",
    "registering an account: its address (Gloam opens the account's own channel in the same transaction, so its later cash outs do not name it)",
    "that a pool transaction happened, how many notes it made, and Gloam's relay as its sender and fee payer",
  ],
  auditor:
    "Starknet's pool has a mandatory auditor key. Registering an account stores its viewing key encrypted to that key, so whoever holds it can read the account's private activity for authorized inspection. It cannot spend.",
  prover:
    "Proofs are made by Starkscan's prover, through Gloam's server. The prover runs each transaction to prove it, so it sees what the transaction does.",
  discovery:
    "On mainnet, Starknet's hosted discovery service finds an account's notes with its viewing key, so it can read them too. The request is sealed to that service (OHTTP) and passes through Gloam, so Gloam can't read it and the service doesn't see who asked.",
  screening: "Starknet screens deposits: an add carries a screening check, and a deposit it refuses does not go in.",
  mainWallet:
    "Your private account is a separate Starknet account derived from your Gloam key (a wallet's signature over a fixed text, or a Gloam wallet's passkey or backup code). Gloam's relay deploys it and sends every transaction, so the main wallet never appears in the pool and the account never holds STRK.",
  pool: "Starknet's canonical privacy pool (STRK20), run by Starknet, not the Gloam vault.",
} as const;

/** The fee line: what moves pay on Starknet (the live fee comes from the relay, starknetRelayStatus). */
export const STARKNET_FEES =
  "Gloam's relay pays Starknet's fees. On mainnet each add, payment and cash out pays Gloam's relay fee (0.25 USDC; read it live from the relay) inside its proof. Opening an account is free, with a daily cap. Proofs come from Starkscan's prover, a few a day for now.";

export interface StarknetEndpoints {
  rpc: string;
  prove: string;
  relay: string;
  discovery: string;
}

/** Gloam's Starknet routes under `base` (default https://www.gloam.trade). */
export function starknetEndpoints(base: string = GLOAM_STARKNET_BASE_URL): StarknetEndpoints {
  const o = base.replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(o)) throw new Error(`Not an http(s) base URL: ${base}`);
  return { rpc: `${o}/api/starknet/rpc`, prove: `${o}/api/starknet/prove`, relay: `${o}/api/starknet/relay`, discovery: `${o}/api/starknet/discovery` };
}

export interface StarknetNetworkInfo {
  key: "starknet-mainnet" | "starknet-sepolia" | "starknet-devnet";
  name: string;
  network: StarknetNetworkKey;
  /** Starknet's chain id, a felt. */
  chainId: string;
  /** See STARKNET_MAINNET_LIST_ID. null off mainnet. */
  listId: number | null;
  /** The pool Gloam uses (mainnet: Starknet's canonical pool). null where it is set per server. */
  pool: string | null;
  assets: readonly StarknetAsset[];
  privacy: string;
  hidden: readonly string[];
  visible: readonly string[];
  auditor: string;
  prover: string;
  fees: string;
  explorer: string | null;
  endpoints: StarknetEndpoints;
  /**
   * Gloam's Starknet routes are behind a switch until Starknet opens on Gloam.
   * Until then they refuse, and the client says so (StarknetOffError).
   */
  status: string;
}

const NETWORK_NAMES: Record<StarknetNetworkKey, string> = { mainnet: "Starknet", sepolia: "Starknet Sepolia", devnet: "Starknet devnet" };

/** Gloam on Starknet, for a network list. */
export function starknetNetworkInfo(network: StarknetNetworkKey = "mainnet", base: string = GLOAM_STARKNET_BASE_URL): StarknetNetworkInfo {
  return {
    key: `starknet-${network}`,
    name: NETWORK_NAMES[network],
    network,
    chainId: STARKNET_CHAIN_IDS[network],
    listId: network === "mainnet" ? STARKNET_MAINNET_LIST_ID : null,
    pool: network === "mainnet" ? STARKNET_MAINNET_POOL : null,
    assets: STARKNET_ASSETS[network],
    privacy: STARKNET_PRIVACY_NOTE,
    hidden: STARKNET_PRIVACY.hidden,
    visible: STARKNET_PRIVACY.visible,
    auditor: STARKNET_PRIVACY.auditor,
    prover: STARKNET_PRIVACY.prover,
    fees: STARKNET_FEES,
    explorer: network === "mainnet" ? "https://voyager.online" : network === "sepolia" ? "https://sepolia.voyager.online" : null,
    endpoints: starknetEndpoints(base),
    status: "Not open yet: Gloam's Starknet routes refuse until Starknet opens on Gloam (the client throws StarknetOffError).",
  };
}

/** A Starknet transaction on an explorer (Voyager), or null on a local devnet. */
export function starknetExplorerTx(hash: string, network: StarknetNetworkKey = "mainnet"): string | null {
  if (network === "devnet") return null;
  return `https://${network === "sepolia" ? "sepolia." : ""}voyager.online/tx/${encodeURIComponent(hash)}`;
}

/** The listed asset named by `id`, symbol or address, or null. */
export function starknetAsset(idOrSymbolOrAddress: string, network: StarknetNetworkKey = "mainnet"): StarknetAsset | null {
  const k = idOrSymbolOrAddress.trim();
  return (
    STARKNET_ASSETS[network].find((a) => a.id === k.toLowerCase() || a.symbol.toLowerCase() === k.toLowerCase() || (isStarknetAddress(k) && sameStarknetAddress(a.address, k))) ??
    null
  );
}

/** A Starknet address is a felt below 2^251, written 0x and up to 64 hex digits. */
const ADDRESS_MAX = 1n << 251n;

/** A Starknet address by shape: 0x, 1 to 64 hex digits, below 2^251, not zero. */
export function isStarknetAddress(v: unknown): v is string {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) return false;
  const n = BigInt(v);
  return n > 0n && n < ADDRESS_MAX;
}

/** Same address, any case or zero padding. */
export function sameStarknetAddress(a: string | bigint, b: string | bigint): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

/** An address in one form: 0x and 64 lowercase hex digits. */
export function starknetAddressHex(v: string | bigint): string {
  return `0x${BigInt(v).toString(16).padStart(64, "0")}`;
}

// ------------------------------------------------------------------ account layer (same as app/src/lib/starknetPrivacy/account.ts)

/** HKDF salts; part of every account's identity. Never change them. */
const WALLET_SALT = "gloam/starknet-account/v1";
const ROOT_SALT = "gloam/starknet-account/root/v1";
/** Highest account index Gloam opens. */
export const STARKNET_MAX_ACCOUNT_INDEX = 1_000_000;

export type StarknetRootKind = "passkey" | "code";

const enc = new TextEncoder();

function subtle(): typeof crypto.subtle {
  const s = (globalThis as { crypto?: { subtle?: typeof crypto.subtle } }).crypto?.subtle;
  if (!s) throw new Error("No Web Crypto here, so a private Starknet account can't be opened (Node 20+ or a modern browser).");
  return s;
}

const ab = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function checkIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index > STARKNET_MAX_ACCOUNT_INDEX) throw new Error("Invalid account index.");
}

/** HKDF-SHA256 with Web Crypto. */
export async function starknetHkdf(ikm: Uint8Array, salt: Uint8Array, info: string, bits: number): Promise<Uint8Array> {
  const key = await subtle().importKey("raw", ab(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: ab(salt), info: ab(enc.encode(info)) }, key, bits));
}

/**
 * The text a main wallet signs to open private account `index` on Starknet.
 * Byte for byte the Gloam app's: changing it would change every person's account.
 */
export function starknetAccountMessage(index: number): string {
  checkIndex(index);
  return `Gloam private account on Starknet\n\nSign to open your private account. This signature is its key: only sign it on gloam.trade.\n\nVersion: 1\nAccount: ${index}`;
}

/**
 * The 32-byte seed of private account `index` from a main wallet's signature
 * of starknetAccountMessage(index): 65 bytes from an EVM wallet (personal_sign,
 * in one form: starknetEvmSignatureBytes), 64 from a Solana wallet.
 * HKDF-SHA256(signature, salt "gloam/starknet-account/v1", info "account/<index>").
 */
export async function starknetSeedFromWalletSignature(signature: Uint8Array, index: number): Promise<Uint8Array> {
  checkIndex(index);
  if (signature.length !== 64 && signature.length !== 65) throw new Error("A wallet signature is 64 or 65 bytes.");
  return starknetHkdf(signature, enc.encode(WALLET_SALT), `account/${index}`, 256);
}

/** secp256k1's group order: an EVM signature's s is canonical below half of it (EIP-2). */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const toBig = (b: Uint8Array): bigint => (b.length ? BigInt("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) : 0n);

/**
 * An EVM wallet's 65-byte signature (r, s, v) in one form, so the same key
 * opens the same account whatever wallet app signs with it: v becomes 27/28
 * and s the low one (v flipped with it). A signature already in that form, as
 * MetaMask and viem write it, comes back unchanged. Any other length or v is
 * returned as it came.
 */
export function starknetEvmSignatureBytes(signature: string): Uint8Array {
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

/** The 32-byte seed of private account `index` from a Gloam wallet's root (its passkey PRF output or backup code). */
export async function starknetSeedFromGloamRoot(root: Uint8Array, kind: StarknetRootKind, index: number): Promise<Uint8Array> {
  checkIndex(index);
  if (root.length < 16) throw new Error("That key is too short to open a private account.");
  return starknetHkdf(root, enc.encode(ROOT_SALT), `${kind}/account/${index}`, 256);
}

// ------------------------------------------------------------------ claim links (same as app/src/lib/starknetPrivacy/claimLink.ts)

/**
 * A Starknet claim link is a one-time private account on the pool. The link
 * carries the 16 random bytes its key comes from, so whoever opens it holds
 * that account and can move what it holds into their own; the sender, who
 * kept the link, can take back one nobody used.
 *
 *   https://www.gloam.trade/c#sn=<base58 body>
 *
 * Body, 31 bytes: version 1, network (0 mainnet, 1 sepolia, 2 devnet), token
 * index (0: the network's first listed token), amount (u64 little-endian, base
 * units, for display), the secret (16 bytes), and an FNV-1a 32 check over the
 * first 27 bytes. It rides in the fragment, which browsers never send to a server.
 */
export const STARKNET_CLAIM_KEY = "sn";
export const STARKNET_CLAIM_SECRET_BYTES = 16;
const CLAIM_VERSION = 1;
const CLAIM_BODY_BYTES = 3 + 8 + STARKNET_CLAIM_SECRET_BYTES + 4;
const CLAIM_NETWORK_CODES: Readonly<Record<StarknetNetworkKey, number>> = { mainnet: 0, sepolia: 1, devnet: 2 };
const U64_MAX = (1n << 64n) - 1n;

export interface StarknetClaim {
  network: StarknetNetworkKey;
  /** Index into the network's listed tokens (0: USDC on mainnet). */
  token: number;
  /** Base units, what was sent (for display: a claim moves whatever the link's account holds). */
  amount: bigint;
  secret: Uint8Array;
}

function fnv1a(bytes: Uint8Array): Uint8Array {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return Uint8Array.of(h & 255, (h >>> 8) & 255, (h >>> 16) & 255, h >>> 24);
}

/** A claim link's body (base58). */
export function starknetClaimBody(c: StarknetClaim): string {
  if (c.secret.length !== STARKNET_CLAIM_SECRET_BYTES) throw new Error("A claim secret is 16 bytes.");
  if (c.amount < 0n || c.amount > U64_MAX) throw new Error("That amount is too large for a link.");
  if (!Number.isInteger(c.token) || c.token < 0 || c.token > 255) throw new Error("Invalid token.");
  const b = new Uint8Array(CLAIM_BODY_BYTES);
  b[0] = CLAIM_VERSION;
  b[1] = CLAIM_NETWORK_CODES[c.network];
  b[2] = c.token;
  new DataView(b.buffer).setBigUint64(3, c.amount, true);
  b.set(c.secret, 11);
  b.set(fnv1a(b.subarray(0, 27)), 27);
  return base58Encode(b);
}

/** The link itself: https://www.gloam.trade/c#sn=<body>. */
export function starknetClaimLinkUrl(c: StarknetClaim, origin: string = GLOAM_STARKNET_BASE_URL): string {
  return `${origin.replace(/\/+$/, "")}/c#${STARKNET_CLAIM_KEY}=${starknetClaimBody(c)}`;
}

/** A body back to its claim, or null when it isn't one (cut short, mistyped, another version). */
export function readStarknetClaimBody(body: string): StarknetClaim | null {
  const t = body.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(t)) return null;
  let b: Uint8Array;
  try {
    b = base58Decode(t);
  } catch {
    return null;
  }
  if (b.length !== CLAIM_BODY_BYTES || b[0] !== CLAIM_VERSION) return null;
  const sum = fnv1a(b.subarray(0, 27));
  if (!sum.every((x, i) => x === b[27 + i])) return null;
  const network = (Object.keys(CLAIM_NETWORK_CODES) as StarknetNetworkKey[]).find((k) => CLAIM_NETWORK_CODES[k] === b[1]);
  if (!network) return null;
  return { network, token: b[2]!, amount: new DataView(b.buffer, b.byteOffset).getBigUint64(3, true), secret: b.slice(11, 27) };
}

/** The claim in a "#sn=" fragment, or in a pasted link that has one; null otherwise. A bare body is read too. */
export function starknetClaimFromLink(linkOrHashOrBody: string): StarknetClaim | null {
  const m = linkOrHashOrBody.match(/#sn=([1-9A-HJ-NP-Za-km-z]+)/);
  return m ? readStarknetClaimBody(m[1]!) : readStarknetClaimBody(linkOrHashOrBody);
}

/** Whether a fragment is a Starknet claim link's. */
export function isStarknetClaimHash(hash: string): boolean {
  return /^#sn=[1-9A-HJ-NP-Za-km-z]+$/.test(hash.trim());
}

/**
 * The one-time account's 32-byte seed from a link's secret: HKDF-SHA256
 * (salt "gloam/starknet-claim/v1", info "account"). Its keys and address come
 * from it as any private account's do (starknetAccountKeys, index 0).
 */
export async function starknetClaimSeed(secret: Uint8Array): Promise<Uint8Array> {
  if (secret.length !== STARKNET_CLAIM_SECRET_BYTES) throw new Error("A claim secret is 16 bytes.");
  return starknetHkdf(secret, enc.encode("gloam/starknet-claim/v1"), "account", 256);
}

/** A fresh secret for a new link. */
export function newStarknetClaimSecret(): Uint8Array {
  const c = (globalThis as { crypto?: typeof crypto }).crypto;
  if (!c?.getRandomValues) throw new Error("No secure random source here.");
  return c.getRandomValues(new Uint8Array(STARKNET_CLAIM_SECRET_BYTES));
}
