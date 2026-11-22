"use client";

/**
 * Where Sent links live (records and rules in lib/sentLinks).
 *
 * Sealed with sealJson under the same data key as the private balance
 * (lib/noteVault), so a passkey lock covers them, a localStorage dump yields
 * ciphertext, and turning the passkey on or off re-seals them with everything
 * else. Writes run one at a time. A stored list that cannot be opened is set
 * aside, never overwritten, before a fresh list starts. The recovery backup
 * carries every code whose money has not moved (lib/recovery).
 *
 * The recording demo keeps its links in this tab's memory and never reads the
 * chain: its codes are for a pretend wallet.
 */
import type { Address, Hex } from "viem";
import { scopedKey, writableKey } from "./accountSlot";
import { readDemo } from "./demoFlag";
import { openJson, sealJson } from "./noteVault";
import { getRhPublicClient } from "./rhClient";
import { shieldPoolAbi } from "./shield";
import { addSentLink, capSentLinks, needsCheck, parseSentLinks, sameScope, type SentLink } from "./sentLinks";

/** The links of the browser's first account; every other sign-in's carry a suffix (lib/accountSlot). */
export const STORE_KEY = "gloam.sentlinks.v1";
/** A list that could not be opened is copied here before a new one is written. */
const UNREADABLE_KEY = "gloam.sentlinks.unreadable.v1";

let demoList: SentLink[] = [];

const listeners = new Set<() => void>();
export function subscribeSentLinks(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function emit() {
  for (const fn of listeners) fn();
}

async function readAll(): Promise<SentLink[]> {
  if (typeof window === "undefined") return [];
  if (readDemo()) return demoList;
  const key = scopedKey(STORE_KEY);
  const raw = key ? window.localStorage.getItem(key) : null;
  if (!raw) return [];
  const value = await openJson<unknown>(raw);
  if (value === null) {
    // Another key or damaged data: keep the ciphertext aside so a write never destroys it.
    const aside = scopedKey(UNREADABLE_KEY);
    if (aside && !window.localStorage.getItem(aside)) window.localStorage.setItem(aside, raw);
    return [];
  }
  return parseSentLinks(value);
}

async function writeAll(list: SentLink[]): Promise<void> {
  const next = capSentLinks(list);
  if (readDemo()) {
    demoList = next;
    return;
  }
  const key = writableKey(STORE_KEY);
  window.localStorage.setItem(key, await sealJson(next));
}

let writeQueue: Promise<void> = Promise.resolve();
function update(fn: (list: SentLink[]) => SentLink[]): Promise<void> {
  const run = writeQueue.then(async () => {
    await writeAll(fn(await readAll()));
    emit();
  });
  writeQueue = run.catch(() => undefined);
  return run;
}

/** This network and pool's links, newest first. */
export async function loadSentLinks(chainId: number, pool: Address): Promise<SentLink[]> {
  await writeQueue;
  return (await readAll()).filter((r) => sameScope(r, chainId, pool));
}

/** Every code on any network whose money has not moved: what the recovery backup carries. */
export async function openSentLinks(): Promise<SentLink[]> {
  await writeQueue;
  return (await readAll()).filter(needsCheck);
}

/**
 * Take in records from a backup. A code already in this browser is kept as it
 * is, so a status seen here (used, taken back) is never rolled back. Returns
 * how many were added.
 */
export async function restoreSentLinks(value: unknown): Promise<number> {
  const incoming = parseSentLinks(value);
  if (typeof window === "undefined" || !incoming.length) return 0;
  let added = 0;
  await update((list) => {
    const codes = new Set(list.map((r) => r.code));
    const fresh = incoming.filter((r) => !codes.has(r.code));
    added = fresh.length;
    return [...fresh, ...list];
  });
  return added;
}

export function saveSentLink(rec: SentLink): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  return update((list) => addSentLink(list, rec));
}

export function removeSentLink(id: string): Promise<void> {
  return update((list) => list.filter((r) => r.id !== id));
}

export function markSentLinkTakenBack(id: string): Promise<void> {
  const at = Date.now();
  return update((list) => list.map((r) => (r.id === id ? { ...r, takenBackAt: at } : r)));
}

export function markSentLinksUsed(ids: string[]): Promise<void> {
  if (!ids.length) return Promise.resolve();
  const at = Date.now();
  const set = new Set(ids);
  return update((list) => list.map((r) => (set.has(r.id) && !r.usedAt ? { ...r, usedAt: at } : r)));
}

/**
 * Spent check for many nullifiers on the active network's pool, the same
 * isSpent read the balance uses (hooks/useLocalShieldNotes), sent in parallel
 * batches. Each answer is true, false, or null when that read failed.
 */
export async function checkSpent(pool: Address, nullifiers: Hex[]): Promise<(boolean | null)[]> {
  if (readDemo()) return nullifiers.map(() => false);
  const client = getRhPublicClient();
  const out: (boolean | null)[] = [];
  const BATCH = 10;
  for (let i = 0; i < nullifiers.length; i += BATCH) {
    const res = await Promise.allSettled(
      nullifiers.slice(i, i + BATCH).map((n) =>
        client.readContract({ address: pool, abi: shieldPoolAbi, functionName: "isSpent", args: [n] })
      )
    );
    for (const r of res) out.push(r.status === "fulfilled" ? Boolean(r.value) : null);
  }
  return out;
}
