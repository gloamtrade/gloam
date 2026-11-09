/**
 * Proof checking for POST /api/v1/proofs/verify. The checks live in
 * lib/proofsServer (shared with the hosted MCP server); this maps a malformed
 * proof to the API's error envelope and counts each key's proof checks.
 */
import { SharedCountUnavailable, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { ApiError } from "@/lib/partnersApi";
import { ProofInputError, verifyProofText as verifyOnServer, type ApiVerifyResult } from "@/lib/proofsServer";

export { groth16Verify, SNARK_CHECK, type ApiVerifyResult, type ProofFormat } from "@/lib/proofsServer";

/** Checks any Gloam proof text. Malformed input is a 400 ApiError. */
export async function verifyProofText(raw: unknown): Promise<ApiVerifyResult> {
  try {
    return await verifyOnServer(raw);
  } catch (e) {
    if (e instanceof ProofInputError) throw new ApiError(e.status, e.code, e.message);
    throw e;
  }
}

/** Proof checks per key per minute, on top of the key's own request limit: a check can read the chain. */
export const VERIFY_PER_KEY_PER_MIN = 60;

/**
 * Counts one proof check for this key, in Redis across every instance. When
 * that count can't be kept the check is refused (503), as the relay's are.
 */
export async function countProofCheck(keyId: string): Promise<void> {
  let rl: Awaited<ReturnType<typeof hitRateLimit>>;
  try {
    rl = await hitRateLimit(`apikey-${keyId}`, "verify-key", VERIFY_PER_KEY_PER_MIN, Date.now(), 60, { failClosed: true });
  } catch (e) {
    if (e instanceof SharedCountUnavailable) throw new ApiError(503, "unavailable", "Proof checks are paused for a moment. Try again shortly.");
    throw e;
  }
  if (!rl.allowed) {
    throw new ApiError(429, "rate_limited", `This key can check ${VERIFY_PER_KEY_PER_MIN} proofs a minute. Try again in ${rl.retryAfterSec} seconds.`);
  }
}
