/**
 * Sanctions screening: the matcher and the vendored list (browser and server).
 *
 * Gloam screens public addresses only: the wallet that deposits into the vault
 * and the public address a cash out pays. Never a note, a receive tag, an
 * amount, or anything else private.
 *
 * The list is a snapshot of the OFAC SDN sanctioned digital currency addresses
 * (EVM format), vendored in screeningList.json with its source commit and date.
 * Refresh it with `node scripts/refresh-ofac-list.mjs`.
 */
import snapshot from "./screeningList.json";

/** The only thing a blocked user is told. No reason, no list, no address. */
export const SCREEN_BLOCKED_MESSAGE = "This wallet can't use Gloam.";

/**
 * Optional context for a screen. On Tempo, with a TIP-20 `asset`, the issuer's
 * TIP-403 transfer policy is checked alongside the sanctions list (lib/tip403.ts):
 * on deposit the wallet must be allowed to send and the vault to receive, on
 * cash out the vault to send and the address to receive. Elsewhere it is ignored.
 */
export type ScreenOptions = {
  chainId?: number;
  asset?: string | null;
  flow?: "deposit" | "cashout";
  /** Who pays a cash out: the vault unless set. A swap's exit pays from its escrow. */
  sender?: `0x${string}`;
};

/**
 * `message` and `scope` come only with a block. scope "asset" means the block is
 * about this stablecoin on this network (its issuer's policy), not the wallet
 * everywhere; the message is then the line to show (the neutral one when the
 * wallet itself is not allowed, a plain notice when the vault is not).
 */
export type ScreenResult = {
  allowed: boolean;
  message?: string;
  scope?: "asset";
};

export type SanctionsSnapshot = {
  name: string;
  source: string;
  sourceCommit: string;
  sourceUpdatedAt: string | null;
  snapshotDate: string;
  lists: Record<string, number>;
  count: number;
  addresses: string[];
};

const EVM = /^0x[0-9a-fA-F]{40}$/;

/** Lowercase form of a 0x address (checksummed or not), or null if it is not one. */
export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return EVM.test(v) ? v.toLowerCase() : null;
}

/** Validate a snapshot and build the lookup set. Throws on a malformed list. */
export function loadSanctionsList(data: unknown): Set<string> {
  const s = data as Partial<SanctionsSnapshot> | null;
  if (!s || !Array.isArray(s.addresses) || s.addresses.length === 0) {
    throw new Error("Sanctions list is missing or empty.");
  }
  const set = new Set<string>();
  for (const a of s.addresses) {
    const n = normalizeAddress(a);
    if (!n) throw new Error("Sanctions list holds a value that is not an address.");
    set.add(n);
  }
  if (typeof s.count === "number" && s.count !== set.size) {
    throw new Error("Sanctions list count does not match its addresses.");
  }
  return set;
}

let defaultSet: Set<string> | null = null;
function listSet(): Set<string> {
  return (defaultSet ??= loadSanctionsList(snapshot));
}

/** True if `address` is on `list` (defaults to the vendored snapshot). */
export function isSanctioned(address: string, list: Set<string> = listSet()): boolean {
  const n = normalizeAddress(address);
  return n !== null && list.has(n);
}

/** True if any of the addresses is on the list. Values that are not addresses are ignored. */
export function anySanctioned(addresses: readonly unknown[], list: Set<string> = listSet()): boolean {
  return addresses.some((a) => {
    const n = normalizeAddress(a);
    return n !== null && list.has(n);
  });
}

/** What the docs and API say about the list in use. */
export const SCREEN_LIST_INFO = {
  name: snapshot.name,
  source: snapshot.source,
  sourceCommit: snapshot.sourceCommit,
  sourceUpdatedAt: snapshot.sourceUpdatedAt,
  snapshotDate: snapshot.snapshotDate,
  count: snapshot.count,
} as const;
