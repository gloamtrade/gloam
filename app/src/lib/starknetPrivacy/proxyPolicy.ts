/**
 * What Gloam's Starknet RPC proxy (/api/starknet/rpc) passes to the node: the
 * reads the app and the SDK make, and nothing that sends. Transactions go
 * through the relay (/api/starknet/relay), never this proxy. Pure rules,
 * checked by scripts/selftest-starknet-routes.mts.
 */

/** Largest request body the proxy reads. */
export const STARKNET_RPC_MAX_BODY = 64 * 1024;
/** Most calls in one batch. */
export const STARKNET_RPC_MAX_BATCH = 20;
/** starknet_getEvents asks for at most this many events a page. */
export const STARKNET_EVENTS_MAX_CHUNK = 1_000;

/**
 * The read methods: block and chain facts (the 10-block waits, the pool's
 * nonce), contract reads (balances, the pool's views the SDK's contract
 * reader calls, an account's class), and transaction status and receipts.
 */
const READS = new Set([
  "starknet_specVersion",
  "starknet_chainId",
  "starknet_blockNumber",
  "starknet_blockHashAndNumber",
  "starknet_getBlockWithTxHashes",
  "starknet_call",
  "starknet_getStorageAt",
  "starknet_getClassHashAt",
  "starknet_getNonce",
  "starknet_getTransactionStatus",
  "starknet_getTransactionReceipt",
  "starknet_getTransactionByHash",
  "starknet_getEvents",
]);

export type StarknetRpcCall = { method?: unknown; params?: unknown };

/** Whether the proxy passes this call on. */
export function starknetRpcCallAllowed(call: StarknetRpcCall): boolean {
  if (!call || typeof call.method !== "string" || !READS.has(call.method)) return false;
  if (call.method === "starknet_getEvents") {
    // { filter: { ..., chunk_size } } or [ { ..., chunk_size } ]
    const p = call.params as { filter?: { chunk_size?: unknown } } | { chunk_size?: unknown }[] | undefined;
    const filter = Array.isArray(p) ? p[0] : p?.filter;
    const size = (filter as { chunk_size?: unknown } | undefined)?.chunk_size;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > STARKNET_EVENTS_MAX_CHUNK) return false;
  }
  return true;
}

/** The prover methods /api/starknet/prove passes on (the SDK's proving-service protocol). */
export const STARKNET_PROVE_METHODS = new Set(["starknet_proveTransaction", "starknet_specVersion"]);

/** A prove request body is capped at 1 MiB (Starkscan's own cap). */
export const STARKNET_PROVE_MAX_BODY = 1024 * 1024;
