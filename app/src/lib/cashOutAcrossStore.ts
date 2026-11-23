/**
 * Where cash outs across balances live (the runs themselves in lib/cashOutAcross).
 *
 * Sealed under the same data key as the private balance (lib/noteVault), and
 * per signed-in account (lib/accountSlot): with no account bound nothing is
 * read and a write throws. A run holds no secret (the notes do): note ids,
 * amounts, the address, nullifiers and transaction hashes. Old finished runs
 * make room; a run not finished is never dropped. Tabs take turns writing.
 */
import type { Address } from "viem";
import { scopedKey, writableKey } from "./accountSlot";
import { openJson, sealJson } from "./noteVault";
import type { CashOutAcrossRun } from "./cashOutAcross";

export const CASHOUT_RUNS_KEY = "gloam.cashout-across.v1";
const STORE_LOCK = "gloam-cashout-across-store";
const KEEP_FINISHED = 20;

async function readAll(raw?: string | null): Promise<CashOutAcrossRun[]> {
  if (typeof window === "undefined") return [];
  const key = scopedKey(CASHOUT_RUNS_KEY);
  const blob = raw !== undefined ? raw : key ? window.localStorage.getItem(key) : null;
  if (!blob) return [];
  const all = await openJson<CashOutAcrossRun[]>(blob);
  return Array.isArray(all) ? all : [];
}

function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: { request: (n: string, f: () => Promise<T>) => Promise<T> } } | undefined)?.locks;
  return locks?.request ? locks.request(STORE_LOCK, fn) : fn();
}

let writeQueue: Promise<unknown> = Promise.resolve();

function mutate(change: (all: CashOutAcrossRun[]) => CashOutAcrossRun[]): Promise<void> {
  // the bound account's runs: with none bound this throws and nothing is written
  const key = writableKey(CASHOUT_RUNS_KEY);
  const run = (writeQueue = writeQueue
    .catch(() => undefined)
    .then(() =>
      withStoreLock(async () => {
        for (let attempt = 0; ; attempt++) {
          const raw = window.localStorage.getItem(key);
          const next = change(await readAll(raw));
          let finished = 0;
          const kept = next.filter((r) => r.status !== "done" || ++finished <= KEEP_FINISHED);
          const sealed = await sealJson(kept);
          // another tab wrote meanwhile (no Web Locks): read again and change over it
          if (window.localStorage.getItem(key) !== raw && attempt < 5) continue;
          window.localStorage.setItem(key, sealed);
          return;
        }
      })
    ));
  return run as Promise<void>;
}

export async function loadCashOutRuns(chainId: number, pool: Address): Promise<CashOutAcrossRun[]> {
  await writeQueue.catch(() => undefined);
  return (await readAll())
    .filter((r) => r.chainId === chainId && r.pool.toLowerCase() === pool.toLowerCase())
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function loadCashOutRun(id: string): Promise<CashOutAcrossRun | null> {
  await writeQueue.catch(() => undefined);
  return (await readAll()).find((r) => r.id === id) ?? null;
}

export function saveCashOutRun(run: CashOutAcrossRun): Promise<void> {
  return mutate((all) => [run, ...all.filter((r) => r.id !== run.id)]);
}
