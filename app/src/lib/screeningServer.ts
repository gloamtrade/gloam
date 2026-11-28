/**
 * Server-side screening for /api/screen and the relay.
 *
 * Always: the vendored OFAC snapshot (lib/screening.ts). Optionally: the
 * Chainalysis free sanctions API, only when CHAINALYSIS_API_KEY is set in the
 * server environment. If that API is slow or down, the snapshot result stands
 * (it never blocks a wallet the list does not, and never unblocks one it does).
 *
 * On Tempo, when the caller names a TIP-20 asset: the issuer's TIP-403 transfer
 * policy too (lib/tip403Server.ts), read from the chain. It fails open if the
 * RPC is down, because the token enforces the same policy on-chain regardless.
 *
 * Addresses are never logged, and the answer is only allowed or not.
 */
import type { Address } from "viem";
import { anySanctioned, normalizeAddress, type ScreenOptions, type ScreenResult } from "./screening";
import { screenTip403, tip403Applies } from "./tip403Server";
import ofacSolana from "./solanaRings/ofacSolana.json";

const OFAC_SOLANA: ReadonlySet<string> = new Set(ofacSolana.addresses);

const CHAINALYSIS_URL = "https://public.chainalysis.com/api/v1/address/";
const CACHE_MS = 60 * 60_000;
const CACHE_MAX = 5_000;
const remote = new Map<string, { at: number; hit: boolean }>();

/** True when the optional Chainalysis check is configured (never the key itself). */
export function chainalysisEnabled(): boolean {
  return Boolean(process.env.CHAINALYSIS_API_KEY?.trim());
}

async function chainalysisHit(address: string): Promise<boolean> {
  const key = process.env.CHAINALYSIS_API_KEY?.trim();
  if (!key) return false;
  const cached = remote.get(address);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.hit;
  try {
    const res = await fetch(CHAINALYSIS_URL + address, {
      headers: { "X-API-Key": key, Accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
      cache: "no-store",
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { identifications?: unknown[] };
    const hit = Array.isArray(json.identifications) && json.identifications.length > 0;
    if (remote.size >= CACHE_MAX) remote.clear();
    remote.set(address, { at: Date.now(), hit });
    return hit;
  } catch {
    return false;
  }
}

/**
 * Screen public addresses. Values that are not 0x addresses are ignored.
 * `opts` adds the TIP-403 check on Tempo (see ScreenOptions); without it, or on
 * any other chain, this is the sanctions screen alone, exactly as before.
 */
export async function screenAddresses(
  addresses: readonly unknown[],
  opts?: ScreenOptions
): Promise<ScreenResult> {
  const list = [...new Set(addresses.map(normalizeAddress).filter((a): a is string => a !== null))];
  if (anySanctioned(list)) return { allowed: false };
  if (list.length === 0) return { allowed: true };
  const tip403 = opts && tip403Applies(opts.chainId, opts.asset);
  const [hits, verdict] = await Promise.all([
    chainalysisEnabled() ? Promise.all(list.map(chainalysisHit)) : Promise.resolve([] as boolean[]),
    tip403 ? screenTip403(list as Address[], opts) : Promise.resolve({ allowed: true } as const),
  ]);
  if (hits.some(Boolean)) return { allowed: false };
  if (!verdict.allowed) return { allowed: false, message: verdict.message, scope: "asset" };
  return { allowed: true };
}

/**
 * Screen Solana addresses: OFAC's Solana entries (vendored in
 * solanaRings/ofacSolana.json, from the same source as the EVM list), then the
 * Chainalysis sanctions API when it is set up. Same caching and failure rules
 * as above. True when none is flagged.
 */
export async function screenOtherChainAddresses(addresses: readonly string[]): Promise<boolean> {
  const list = [...new Set(addresses.filter((a) => typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)))];
  if (list.some((a) => OFAC_SOLANA.has(a))) return false;
  if (!chainalysisEnabled()) return true;
  const hits = await Promise.all(list.slice(0, 16).map(chainalysisHit));
  return !hits.some(Boolean);
}
