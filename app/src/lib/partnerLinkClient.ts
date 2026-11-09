"use client";

/**
 * Partner links, browser side. A pay or swap link from a partner carries their
 * link code as `p=` (lib/partnerCode). This module:
 *  - asks the server for the name a live code's partner shows, once Gloam has
 *    approved it ("From Motion"); a name typed into a link is never shown as a
 *    partner (usePartnerName);
 *  - before a wallet sends a payment or cash out from such a link, registers the
 *    spend under the code with a value only this send has (its new note
 *    commitment, or its proof), so it can only ever count for that link
 *    (registerLinkSpend); a send through the relay carries the code to the relay
 *    instead, which ties it to the transaction it sends;
 *  - once the payment, cash out or swap lands, asks the server to count it
 *    (settlePartnerTx). The server reads the chain; the partner comes from the
 *    registration, not from this call;
 *  - for a cash out the relay sends later, keeps the relay's job id in this
 *    browser until the job has gone out, then asks for it to be counted
 *    (queuePartnerJobs, processPartnerQueue). The relay counts it as it sends too;
 *    this is a second chance. Only job ids are kept, for at most seven days.
 *
 * None of this ever holds up a payment or a swap: every call is fire and forget,
 * and a failure is silent. What is sent is the code, the chain, a hash of the
 * spend's nullifier or the transaction hash, and the flow: never an amount, an
 * address or a note.
 */
import type { Hex } from "viem";
import { useEffect, useState } from "react";
import { isLinkCodeShape, linkBindHash, linkNullifierHash, proofBindValue, PUBLIC_MEMPOOL_CHAINS } from "./partnerCode";
import { readDemo } from "./demoFlag";

export type LinkFlow = "pay" | "swap";

const names = new Map<string, Promise<string | null>>();

/** The approved partner name for a live code, null otherwise; cached per page. A POST, so the code stays out of request logs. */
export function lookupPartnerName(code: string): Promise<string | null> {
  const hit = names.get(code);
  if (hit) return hit;
  const p = fetch("/api/partners/link-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    cache: "no-store",
    credentials: "same-origin",
  })
    .then(async (res) => {
      if (!res.ok) return null;
      const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: { name?: unknown } } | null;
      return json?.ok && typeof json.data?.name === "string" && json.data.name.trim() ? json.data.name : null;
    })
    .catch(() => {
      // a network blip: ask again next time rather than remember "nobody"
      names.delete(code);
      return null;
    });
  names.set(code, p);
  return p;
}

/** The partner a link's code is from, once the server says the code is live and Gloam approved the name; null otherwise. */
export function usePartnerName(code: string | null | undefined): string | null {
  const [found, setFound] = useState<{ code: string; name: string | null } | null>(null);
  useEffect(() => {
    if (!code || !isLinkCodeShape(code) || readDemo()) return;
    let live = true;
    void lookupPartnerName(code).then((name) => {
      if (live) setFound({ code, name });
    });
    return () => {
      live = false;
    };
  }, [code]);
  return code && found?.code === code ? found.name : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function postQuietly(path: string, body: unknown): Promise<Response | null> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
    keepalive: true,
  }).catch(() => null);
}

/**
 * Registers a wallet-sent payment or cash out under a partner's code, before the
 * wallet is asked, bound to a value only this send has: `bind` is a private
 * payment's new note commitment, or `proof` a cash out's proof. Fire and forget.
 * Not on chains with a public mempool (Ethereum): there only relay-sent link
 * payments count.
 */
export function registerLinkSpend(r: { code: string | null | undefined; chainId: number; nullifier: Hex } & ({ bind: Hex } | { proof: Hex })): void {
  if (typeof window === "undefined" || readDemo() || !isLinkCodeShape(r.code) || !/^0x[0-9a-fA-F]{64}$/.test(r.nullifier)) return;
  if (PUBLIC_MEMPOOL_CHAINS.includes(r.chainId)) return;
  const value = "bind" in r ? r.bind : proofBindValue(r.proof);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) return;
  void postQuietly("/api/partners/register", {
    chainId: r.chainId,
    nullifierHash: linkNullifierHash(r.nullifier),
    bindHash: linkBindHash(value),
    code: r.code,
    flow: "pay",
  });
}

/** Waits before each try: the chain's node may be a block or two behind the app. */
const RETRY_WAITS_MS = [0, 4_000, 10_000, 25_000, 60_000];
const settled = new Set<string>();

/**
 * Asks the server to count one landed transaction from a partner's link. Never
 * throws, never waits: it retries in the background while the node catches up,
 * and gives up quietly on any refusal.
 */
export function settlePartnerTx(r: { chainId: number; txHash: Hex | string }): void {
  if (typeof window === "undefined" || readDemo()) return;
  if (!Number.isSafeInteger(r.chainId) || !/^0x[0-9a-fA-F]{64}$/.test(r.txHash)) return;
  const key = `${r.chainId}:${r.txHash.toLowerCase()}`;
  if (settled.has(key)) return;
  settled.add(key);
  void (async () => {
    for (const wait of RETRY_WAITS_MS) {
      if (wait) await sleep(wait);
      const res = await postQuietly("/api/partners/attribute", { chainId: r.chainId, txHash: r.txHash });
      if (!res) continue; // offline for a moment
      if (res.ok) return;
      const json = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      // not on the node yet, busy, or down: try again; anything else is a final answer
      if (res.status === 404 && json?.error?.code === "tx_not_found") continue;
      if (res.status === 429 || res.status >= 500) continue;
      return;
    }
  })();
}

// ---------------------------------------------------------------- cash outs sent later

const QUEUE_KEY = "gloam.partner-pending.v2";
const QUEUE_MAX_AGE_MS = 7 * 86_400_000;
const QUEUE_MAX = 50;

type Pending = { job: string; chainId: number; at: number };

function readQueue(): Pending[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(QUEUE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is Pending => Boolean(e) && typeof e.job === "string" && e.job.length <= 80 && typeof e.chainId === "number" && typeof e.at === "number"
    );
  } catch {
    return [];
  }
}

function writeQueue(q: Pending[]) {
  try {
    if (q.length) window.localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-QUEUE_MAX)));
    else window.localStorage.removeItem(QUEUE_KEY);
    // the earlier version kept the code too: gone
    window.localStorage.removeItem("gloam.partner-pending.v1");
  } catch {
    /* storage off: the relay and the on-chain match still count them */
  }
}

/** Keeps relay job ids of cash outs sent later from a partner's link, to ask for them to be counted once they go out. */
export function queuePartnerJobs(chainId: number, jobIds: string[]): void {
  if (typeof window === "undefined" || readDemo() || jobIds.length === 0) return;
  const now = Date.now();
  const q = readQueue().filter((e) => !jobIds.includes(e.job));
  for (const job of jobIds) q.push({ job, chainId, at: now });
  writeQueue(q);
}

let processing = false;

/** Asks for every queued job that has gone out to be counted; drops the ended and the old. Quiet on any failure. */
export async function processPartnerQueue(): Promise<void> {
  if (typeof window === "undefined" || processing || readDemo()) return;
  const queue = readQueue();
  if (queue.length === 0) return;
  processing = true;
  try {
    const { cashOutJobStatus } = await import("./cashOutLater");
    const keep: Pending[] = [];
    const now = Date.now();
    for (const e of queue) {
      if (now - e.at > QUEUE_MAX_AGE_MS) continue;
      const view = await cashOutJobStatus(e.job).catch(() => null);
      if (view === null) {
        keep.push(e); // the relay couldn't be asked: next time
        continue;
      }
      if (view === "gone" || ["cancelled", "failed", "expired", "spent"].includes(view.status)) continue;
      if (view.status === "sent" && view.hash) {
        settlePartnerTx({ chainId: e.chainId, txHash: view.hash });
        continue;
      }
      keep.push(e);
    }
    // entries queued while this ran are kept too
    const added = readQueue().filter((e) => !queue.some((x) => x.job === e.job));
    writeQueue([...keep, ...added]);
  } finally {
    processing = false;
  }
}
