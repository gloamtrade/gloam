/**
 * A voter's ENS name, to greet them by it. Server only, best effort: a slow
 * or failing lookup gives null and the page shows the short address. viem
 * checks the reverse record against the forward one, so a name someone set
 * on an address they don't control never shows. Offchain lookups are off, so a
 * name that needs one gives null too.
 */
import "server-only";
import { createPublicClient, fallback, http, type Address, type PublicClient } from "viem";
import { mainnet } from "viem/chains";

const TTL_MS = 30 * 60_000;
const TIMEOUT_MS = 2_500;
const cache = new Map<string, { at: number; name: string | null }>();
let client: PublicClient | null = null;

export async function ensNameOf(address: Address): Promise<string | null> {
  if (process.env.GLOAM_VOTE_NO_ENS === "1") return null;
  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.name;
  client ??= createPublicClient({
    chain: mainnet,
    ccipRead: false,
    transport: fallback([http("https://ethereum-rpc.publicnode.com", { timeout: TIMEOUT_MS }), http("https://rpc.mevblocker.io", { timeout: TIMEOUT_MS })]),
  }) as PublicClient;
  let name: string | null = null;
  try {
    name = await Promise.race([
      client.getEnsName({ address }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
    ]);
  } catch {
    name = null;
  }
  // keep names short and plain enough to print in a greeting
  if (name && (name.length > 48 || !/^[\p{L}\p{N}._-]+\.eth$/u.test(name))) name = null;
  if (cache.size > 5_000) cache.clear();
  cache.set(key, { at: Date.now(), name });
  return name;
}
