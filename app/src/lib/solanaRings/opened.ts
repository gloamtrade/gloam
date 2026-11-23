/**
 * Which Solana wallets have opened a Gloam private account in this browser
 * before, so a returning wallet is asked to open its account, not to set one
 * up. Kept in localStorage as the main wallet's address and its account index
 * per network: public facts, never the account's key or the signature that
 * derives it (lib/solanaRings/account).
 *
 * A browser that opened an account before this record existed still holds that
 * account's sealed balance snapshot (lib/solanaRings/client, under
 * SNAPSHOT_PREFIX). While nothing is recorded for a network yet, such a
 * snapshot counts as seen, so a wallet that set up before is not greeted as new.
 */
import type { RingsNetwork } from "./config";

/** The localStorage key: { [network]: { [main wallet address]: account index } }. */
export const OPENED_KEY = "gloam:solana-opened:v1";

/** Where the client keeps each account's sealed balance snapshot: `${SNAPSHOT_PREFIX}${network}:${account}`. */
export const SNAPSHOT_PREFIX = "gloam:solana-rings:v1:";

/** The part of Storage this reads and writes (localStorage, or a stand-in in tests). */
export type OpenedStorage = Pick<Storage, "getItem" | "setItem" | "key" | "length"> & Partial<Pick<Storage, "removeItem">>;

type Record_ = Partial<Record<RingsNetwork, Record<string, number>>>;

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const validIndex = (i: unknown): i is number => typeof i === "number" && Number.isSafeInteger(i) && i >= 0 && i <= 1_000_000;

function read(storage: OpenedStorage | null): Record_ {
  try {
    const raw = storage?.getItem(OPENED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record_) : {};
  } catch {
    return {};
  }
}

/** The network's recorded wallets, with anything malformed left out. */
function recorded(storage: OpenedStorage | null, network: RingsNetwork): Record<string, number> {
  const list = read(storage)[network];
  if (!list || typeof list !== "object") return {};
  return Object.fromEntries(Object.entries(list).filter(([owner, i]) => SOLANA_ADDRESS.test(owner) && validIndex(i)));
}

/** True when this browser holds a sealed balance snapshot of any private account on `network`. */
function hasSnapshot(storage: OpenedStorage | null, network: RingsNetwork): boolean {
  if (!storage) return false;
  const prefix = `${SNAPSHOT_PREFIX}${network}:`;
  try {
    for (let i = 0; i < storage.length; i++) {
      if (storage.key(i)?.startsWith(prefix)) return true;
    }
  } catch {
    /* blocked storage */
  }
  return false;
}

/**
 * Whether `owner` (a main wallet's address) opened a private account on
 * `network` in this browser before, and which one: the index it opened, else 0.
 */
export function openedBefore(storage: OpenedStorage | null, network: RingsNetwork, owner: string): { seen: boolean; index: number } {
  const list = recorded(storage, network);
  const index = list[owner];
  if (index !== undefined) return { seen: true, index };
  // Nothing recorded on this network yet: an account opened here before the record existed still counts.
  if (Object.keys(list).length === 0 && hasSnapshot(storage, network)) return { seen: true, index: 0 };
  return { seen: false, index: 0 };
}

/** Note that `owner` opened private account `index` on `network`. Quietly does nothing where storage refuses. */
export function rememberOpened(storage: OpenedStorage | null, network: RingsNetwork, owner: string, index: number): void {
  if (!storage || !SOLANA_ADDRESS.test(owner) || !validIndex(index)) return;
  const all = read(storage);
  all[network] = { ...recorded(storage, network), [owner]: index };
  try {
    storage.setItem(OPENED_KEY, JSON.stringify(all));
  } catch {
    /* private mode or full storage: the next visit asks as if new, and opens the same account */
  }
}

/** localStorage, or null where the browser blocks it (or on the server). */
export function browserStorage(): OpenedStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
