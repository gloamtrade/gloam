/**
 * What Gloam's Solana proxy (/api/solana/rpc and /api/solana/spr) lets through
 * to Helius, so the Helius API key stays on the server and the proxy is no free
 * public RPC. Pure rules, checked by scripts/selftest-solana-rings.mts.
 *
 * /api/solana/rpc: Solana JSON-RPC, the reads and sends the app and the SDK
 * make. getProgramAccounts passes in one shape only: the SDK's listing of the
 * pool's SPL asset registrations (the pool program, 48-byte accounts, the
 * registry tag), which a sync needs to name an asset it has not seen. Any other
 * program scan is refused.
 *
 * /api/solana/spr/<path>: Helius's /v1/spr namespace, which serves the Rings
 * indexer (POST /<method>) and the prover (/prove/<key>, its /status and
 * /indexed routes, /attestation, /proving-keys, /health). The SDK encrypts every prover
 * request to the attested enclave (Spr-Tee headers), so the proxy only ever
 * carries ciphertext there; it forwards those headers untouched.
 */
import type { RingsNetwork } from "./config";

/** Solana RPC methods the proxy forwards. */
const RPC_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getLatestBlockhash",
  "getSlot",
  "getBlockHeight",
  "getEpochInfo",
  "getSignatureStatuses",
  "getTransaction",
  "getMinimumBalanceForRentExemption",
  "getFeeForMessage",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "simulateTransaction",
  "sendTransaction",
  "isBlockhashValid",
  "getGenesisHash",
  "getHealth",
  "getVersion",
]);

/** Devnet only: SOL from the faucet for testing. */
const DEVNET_ONLY: ReadonlySet<string> = new Set(["requestAirdrop"]);

export function ringsRpcMethodAllowed(method: unknown, network: RingsNetwork): boolean {
  if (typeof method !== "string") return false;
  return RPC_METHODS.has(method) || (network === "devnet" && DEVNET_ONLY.has(method));
}

const SHIELDED_POOL = "ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW";
/** The pool's account tag for an SPL asset registration, base64 of one byte (SDK StateDiscriminator.splAssetRegistry). */
export const SPL_ASSET_REGISTRY_TAG_B64 = "BQ==";

/** getProgramAccounts as the SDK lists SPL asset registrations, and nothing wider. */
function assetRegistryScan(params: unknown): boolean {
  if (!Array.isArray(params) || params[0] !== SHIELDED_POOL) return false;
  const opts = params[1] as { filters?: unknown } | undefined;
  const filters = opts?.filters;
  if (!Array.isArray(filters) || filters.length !== 2) return false;
  const size = filters.find((f) => f && typeof f === "object" && "dataSize" in f) as { dataSize?: unknown } | undefined;
  const memcmp = filters.find((f) => f && typeof f === "object" && "memcmp" in f) as
    | { memcmp?: { offset?: unknown; bytes?: unknown; encoding?: unknown } }
    | undefined;
  return (
    Number(size?.dataSize) === 48 &&
    Number(memcmp?.memcmp?.offset) === 0 &&
    memcmp?.memcmp?.encoding === "base64" &&
    memcmp?.memcmp?.bytes === SPL_ASSET_REGISTRY_TAG_B64
  );
}

/** Whether one JSON-RPC call may go to Helius. */
export function ringsRpcCallAllowed(call: { method?: unknown; params?: unknown }, network: RingsNetwork): boolean {
  if (call.method === "getProgramAccounts") return assetRegistryScan(call.params);
  return ringsRpcMethodAllowed(call.method, network);
}

/** Most calls in one JSON-RPC batch, and the largest body, in bytes. */
export const RINGS_RPC_MAX_BATCH = 20;
export const RINGS_RPC_MAX_BODY = 256 * 1024;
/** Largest body to the indexer or prover: a proof request carries the encrypted witness. */
export const RINGS_SPR_MAX_BODY = 4 * 1024 * 1024;

/** The Rings indexer's methods (SDK indexer/names). */
export const SPR_INDEXER_METHODS: readonly string[] = [
  "getEncryptedUtxosByTags",
  "getShieldedTransactionsByTags",
  "getShieldedTransactionsByNullifiers",
  "getShieldedTransactionsBySignature",
  "getMerkleProofs",
  "getNonInclusionProofs",
  "getUserRecords",
];

const PROVING_KEY = /^[A-Za-z0-9_.-]{1,96}$/;

/**
 * The path below /v1/spr that `method` may reach, normalised, or null. No dot
 * segments, no empty segments, nothing outside the list.
 */
export function sprRoute(segments: readonly string[], method: string): string | null {
  if (segments.length === 0 || segments.length > 3) return null;
  if (segments.some((s) => !s || s === "." || s === ".." || /[^A-Za-z0-9_.-]/.test(s))) return null;
  const [a, b, c] = segments;
  if (segments.length === 1 && method === "POST" && SPR_INDEXER_METHODS.includes(a!)) return a!;
  if (segments.length === 1 && method === "GET" && (a === "attestation" || a === "proving-keys" || a === "health")) return a!;
  if (a === "prove" && b && PROVING_KEY.test(b)) {
    if (segments.length === 2 && method === "POST") return `prove/${b}`;
    if (segments.length === 3 && c === "indexed" && method === "POST") return `prove/${b}/indexed`;
    if (segments.length === 3 && c === "status" && method === "GET") return `prove/${b}/status`;
  }
  return null;
}

/** Query parameters a route may carry upstream (never api-key: the proxy sets that). */
export function sprQuery(route: string, query: URLSearchParams): URLSearchParams | null {
  const out = new URLSearchParams();
  for (const [k, v] of query) {
    if (route === "attestation" && k === "nonce" && /^[0-9a-f]{16,128}$/i.test(v)) out.set(k, v);
    else if (route.endsWith("/status") && k === "jobId" && /^[A-Za-z0-9_-]{1,256}$/.test(v)) out.set(k, v);
    else return null;
  }
  return out;
}

/** Request headers the proxy passes on: content type and the SDK's TEE and delivery headers. */
export const SPR_REQUEST_HEADERS: readonly string[] = ["content-type", "accept", "spr-tee", "spr-tee-enc", "spr-tee-ciphertext", "x-sync", "x-async"];

/** Response headers the proxy passes back. */
export const SPR_RESPONSE_HEADERS: readonly string[] = ["content-type", "spr-tee", "spr-tee-ciphertext", "retry-after"];

/** The Helius host for a network. */
export function heliusHost(network: RingsNetwork): string {
  return network === "devnet" ? "https://devnet.helius-rpc.com" : "https://mainnet.helius-rpc.com";
}
