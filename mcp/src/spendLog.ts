/**
 * The agent's spending log: a local JSON file the owner can read.
 *
 * Every spend is written as "pending" before it is signed, so the check and
 * the reservation happen together under a lock and two calls at once cannot
 * both squeeze under the daily limit. The entry is then settled: "sent",
 * "unconfirmed" (broadcast, receipt unknown), "reverted" or "failed" (nothing
 * moved). Pending, sent and unconfirmed count against the limit; refusals are
 * logged too, so the owner can see what an agent tried.
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Address } from "viem";
import { withFileLock } from "./fileLock.js";
import { DAY_MS, type CountedSpend, type SpendTool } from "./policy.js";

export type SpendStatus = "pending" | "sent" | "unconfirmed" | "reverted" | "failed" | "refused";

export const COUNTED_STATUSES: SpendStatus[] = ["pending", "sent", "unconfirmed"];

export type SpendEntry = {
  id: string;
  agent: string;
  tool: SpendTool;
  network: string;
  chainId: number;
  asset: Address;
  symbol: string;
  /** raw units */
  amountWei: string;
  /** display units */
  amount: string;
  recipient: string | null;
  /** false: logged and checked, never counted against the caps (a swap's exit pays out what its swap already counted). */
  counts?: boolean;
  status: SpendStatus;
  /** why it was refused or failed */
  reason?: string;
  hash?: string;
  at: string;
  settledAt?: string;
};

type LogFile = { version: 1; entries: SpendEntry[] };

/** Keep a month of history (and never more than this many entries). */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const KEEP_MAX = 2000;

export class SpendLog {
  constructor(readonly path: string) {}

  /** Run fn while holding an exclusive lock file next to the log (also across server processes). */
  private locked<T>(fn: () => T): T {
    return withFileLock(this.path, "spending log", fn);
  }

  read(): SpendEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LogFile>;
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      // A damaged log must not let spending through: refuse until the owner looks.
      throw new Error(`The spending log at ${this.path} cannot be read. Fix or move it before the agent spends again.`);
    }
  }

  private write(entries: SpendEntry[], now: number) {
    const cutoff = now - KEEP_MS;
    const recent = entries.filter((e) => Date.parse(e.at) > cutoff);
    // Over the cap, drop the oldest entries that no longer count. A spend that
    // still counts against today's limit is never dropped: otherwise a burst of
    // refused calls would push it out of the log and reset the daily budget.
    let drop = recent.length - KEEP_MAX;
    const counts = (e: SpendEntry) => COUNTED_STATUSES.includes(e.status) && Date.parse(e.at) > now - 2 * DAY_MS;
    const kept = drop > 0 ? recent.filter((e) => (drop > 0 && !counts(e) ? (drop--, false) : true)) : recent;
    // Owner-only, like the note store: the log lists every payee, amount and hash the agent paid.
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries: kept } satisfies LogFile, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600); // a leftover tmp file from a crash keeps its old mode otherwise
    renameSync(tmp, this.path);
  }

  /**
   * Check and reserve in one step: `decide` sees everything that counts right
   * now and returns a refusal reason, or null to reserve `entry` as pending.
   */
  reserve(
    entry: Omit<SpendEntry, "status">,
    decide: (counted: CountedSpend[]) => string | null,
    now: number = Date.now()
  ): { ok: true } | { ok: false; reason: string } {
    return this.locked(() => {
      const entries = this.read();
      const reason = decide(counted(entries, entry.agent));
      entries.push(reason ? { ...entry, status: "refused", reason } : { ...entry, status: "pending" });
      this.write(entries, now);
      return reason ? { ok: false as const, reason } : { ok: true as const };
    });
  }

  /** Record something that will not count (a refusal before any check could reserve). */
  note(entry: SpendEntry, now: number = Date.now()) {
    this.locked(() => this.write([...this.read(), entry], now));
  }

  settle(id: string, status: Exclude<SpendStatus, "pending" | "refused">, extra: { hash?: string; reason?: string } = {}) {
    const now = Date.now();
    this.locked(() => {
      const entries = this.read().map((e) =>
        e.id === id ? { ...e, status, ...extra, settledAt: new Date(now).toISOString() } : e
      );
      this.write(entries, now);
    });
  }
}

/** The entries that count against an agent's limits, in the policy's shape. */
export function counted(entries: SpendEntry[], agent: string): CountedSpend[] {
  return entries
    .filter((e) => e.agent === agent && e.counts !== false && COUNTED_STATUSES.includes(e.status))
    .map((e) => ({ chainId: e.chainId, asset: e.asset, amountWei: BigInt(e.amountWei), at: Date.parse(e.at) }));
}
