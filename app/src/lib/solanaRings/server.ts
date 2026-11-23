import "server-only";

/**
 * Server side of Gloam on Solana: the Helius endpoints (with the key, which
 * never leaves the server), the relay's fee-payer key, and the per-IP limits.
 *
 * Env:
 *  - HELIUS_API_KEY: Helius key for the RPC, the Rings indexer and the prover.
 *  - GLOAM_SOLANA_RELAYER_SECRET: the relay's fee-payer key, as a base58 64-byte
 *    secret key or a JSON array of 64 numbers (a Solana CLI keypair file's
 *    contents). Unset: the relay is off and says so.
 */
import { createKeyPairSignerFromBytes, getAddressEncoder, getBase58Encoder, type Address, type KeyPairSigner } from "@solana/kit";
import { SharedCountUnavailable, addRateCount, clientIp } from "@/lib/mcpRemote/rateLimit";
import { SOLANA_RINGS_NETWORK, type RingsNetwork } from "./config";
import { heliusHost } from "./proxyPolicy";

export function heliusKey(): string | null {
  const k = process.env.HELIUS_API_KEY?.trim();
  return k && /^[A-Za-z0-9-]{8,128}$/.test(k) ? k : null;
}

/** The Solana RPC URL, with the key. Server only: never log or return it. */
export function heliusRpcUrl(network: RingsNetwork = SOLANA_RINGS_NETWORK): string | null {
  const key = heliusKey();
  return key ? `${heliusHost(network)}/?api-key=${encodeURIComponent(key)}` : null;
}

/** A /v1/spr route URL, with the key. Server only. */
export function heliusSprUrl(route: string, query: URLSearchParams, network: RingsNetwork = SOLANA_RINGS_NETWORK): string | null {
  const key = heliusKey();
  if (!key) return null;
  const q = new URLSearchParams(query);
  q.set("api-key", key);
  return `${heliusHost(network)}/v1/spr/${route}?${q.toString()}`;
}

/** The relay's 64 secret-key bytes from the env, or null. */
export function relayerSecretBytes(raw = process.env.GLOAM_SOLANA_RELAYER_SECRET): Uint8Array | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    if (v.startsWith("[")) {
      const arr = JSON.parse(v) as unknown;
      if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null;
      return Uint8Array.from(arr as number[]);
    }
    const bytes = new Uint8Array(getBase58Encoder().encode(v));
    return bytes.length === 64 ? bytes : null;
  } catch {
    return null;
  }
}

let relayer: Promise<KeyPairSigner | null> | null = null;

/** The relay's signer, or null when GLOAM_SOLANA_RELAYER_SECRET is unset or malformed. */
export function relayerSigner(): Promise<KeyPairSigner | null> {
  return (relayer ??= (async () => {
    const bytes = relayerSecretBytes();
    if (!bytes) return null;
    try {
      return await createKeyPairSignerFromBytes(bytes);
    } catch {
      return null;
    } finally {
      bytes.fill(0);
    }
  })());
}

/** Per-minute limits for the proxy, per IP and for everyone. */
export const RINGS_PROXY_PER_IP_PER_MIN = 600;
export const RINGS_PROXY_ALL_PER_MIN = 20_000;

export async function ringsProxyRate(req: Request, calls: number, now = Date.now()): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const retryAfterSec = Math.max(1, 60 - (Math.floor(now / 1000) % 60));
  const mine = await addRateCount(clientIp(req), "sol-proxy", calls, now);
  if (mine > RINGS_PROXY_PER_IP_PER_MIN) return { allowed: false, retryAfterSec };
  const all = await addRateCount("all", "sol-proxy-all", calls, now);
  return { allowed: all <= RINGS_PROXY_ALL_PER_MIN, retryAfterSec };
}

/**
 * The relay's limits. "rent" is a registration (about 0.0016 SOL of rent) or a
 * cash out that creates the recipient's token account (about 0.002 SOL), so it
 * is held tighter than a payment. Worst case at these limits the relay spends
 * about 0.3 SOL a day on fees (each transaction at most 10,000 lamports of
 * base fee and the 50,000 lamport priority fee cap; rebroadcasts cost nothing
 * more, a transaction pays once) and 1.1 SOL on rent.
 *
 * A deposit (money at a private account's own address made private, or a
 * wallet with no SOL adding a token) counts as a payment, and also by its
 * depositor (ringsDepositorRate): one wallet moving between IPs still gets the
 * relay's fee paid only so many times a day.
 *
 * On mainnet the daily counts fail closed: without the shared count (Redis)
 * the relay pays nothing and says it is unavailable, never "too many". On
 * devnet, where the SOL is free, they fall back to this instance's own count,
 * so a preview deployment without Redis can still be tested.
 */
export const RINGS_RELAY_LIMITS = {
  rent: { perIpPerDay: 5, allPerDay: 300 },
  transact: { perIpPerMin: 10, perIpPerDay: 200, allPerMin: 120, allPerDay: 5_000 },
  deposit: { perDepositorPerDay: 20 },
} as const;

const DAY = 86_400;

/**
 * The clock the relay's limits count by: the wall clock. The counts are kept
 * per clock minute and day, so a burst that crosses a minute is split across
 * two windows. Self-tests hold this still for a burst; nothing else sets it.
 */
export const ringsRelayClock = { now: (): number => Date.now() };

export type RelayRate = "ok" | "limited" | "unavailable";

export async function ringsRelayRate(
  req: Request,
  kind: "rent" | "transact",
  now = ringsRelayClock.now(),
  network: RingsNetwork = SOLANA_RINGS_NETWORK
): Promise<RelayRate> {
  const ip = clientIp(req);
  const strict = { failClosed: network === "mainnet" };
  try {
    if (kind === "rent") {
      const mine = await addRateCount(ip, "sol-relay-rent", 1, now, DAY, strict);
      if (mine > RINGS_RELAY_LIMITS.rent.perIpPerDay) return "limited";
      const all = await addRateCount("all", "sol-relay-rent-all", 1, now, DAY, strict);
      return all <= RINGS_RELAY_LIMITS.rent.allPerDay ? "ok" : "limited";
    }
    const t = RINGS_RELAY_LIMITS.transact;
    if ((await addRateCount(ip, "sol-relay-tx", 1, now)) > t.perIpPerMin) return "limited";
    if ((await addRateCount(ip, "sol-relay-tx-day", 1, now, DAY, strict)) > t.perIpPerDay) return "limited";
    if ((await addRateCount("all", "sol-relay-tx-all", 1, now)) > t.allPerMin) return "limited";
    return (await addRateCount("all", "sol-relay-tx-all-day", 1, now, DAY, strict)) <= t.allPerDay ? "ok" : "limited";
  } catch (e) {
    return e instanceof SharedCountUnavailable ? "unavailable" : "limited";
  }
}

/**
 * One more relayed deposit by `depositor` today, and whether the relay pays
 * for it: RINGS_RELAY_LIMITS.deposit a day per depositor, on top of the
 * per-IP and overall limits. Counted by the address's 32 bytes in hex (the
 * rate keys lower-case their subject, and base58 is case-sensitive). Fails
 * closed on mainnet like the other daily counts.
 */
export async function ringsDepositorRate(
  depositor: string,
  now = ringsRelayClock.now(),
  network: RingsNetwork = SOLANA_RINGS_NETWORK
): Promise<RelayRate> {
  let subject: string;
  try {
    subject = Buffer.from(getAddressEncoder().encode(depositor as Address)).toString("hex");
  } catch {
    return "limited";
  }
  try {
    const n = await addRateCount(subject, "sol-relay-depositor-day", 1, now, DAY, { failClosed: network === "mainnet" });
    return n <= RINGS_RELAY_LIMITS.deposit.perDepositorPerDay ? "ok" : "limited";
  } catch (e) {
    return e instanceof SharedCountUnavailable ? "unavailable" : "limited";
  }
}
