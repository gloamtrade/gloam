"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { assetDecimals } from "@/lib/shield";
import { useShownAccount } from "../AccountScope";
import { useWalletState } from "@/hooks/useWalletState";
import {
  deleteSchedule,
  demoSchedule,
  isoDay,
  loadSchedules,
  markSchedulePaid,
  onSchedulesChangedElsewhere,
  saveSchedule,
  withPaid,
  type PayrollSchedule,
} from "@/lib/payrollSchedule";

/**
 * Today (isoDay), moving on at local midnight. A timer can be late in a tab
 * left in the background or a laptop asleep overnight, so coming back to the
 * tab checks the date again: paydays never count from yesterday.
 */
function useToday(): string {
  const [today, setToday] = useState(() => isoDay());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    function arm() {
      clearTimeout(timer);
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(roll, midnight.getTime() - now.getTime() + 1_000);
    }
    function roll() {
      setToday(isoDay());
      arm();
    }
    function onVisible() {
      if (document.visibilityState === "visible") roll();
    }
    arm();
    window.addEventListener("focus", roll);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", roll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return today;
}

/**
 * The saved payroll schedules for this network and vault. In the recording
 * demo they live in memory only, seeded with one example that is due.
 */
const NO_SCHEDULES: PayrollSchedule[] = [];

export function useSchedules({
  chainId,
  pool,
  demo,
  demoAsset,
}: {
  chainId: number;
  pool: Address | null | undefined;
  demo: boolean;
  /** The currency the demo's example schedule pays in. */
  demoAsset: Address | undefined;
}) {
  // The signed-in account's own schedules (lib/accountScope): read once its account is bound, gone on sign out.
  const shownAccount = useShownAccount();
  const [schedules, setSchedules] = useWalletState<PayrollSchedule[]>(demo ? "demo" : shownAccount, NO_SCHEDULES);
  const today = useToday();
  // The demo's example is seeded for the day the page opened, so a new day
  // does not reset what was done with it.
  const [demoDay] = useState(() => isoDay());
  /** Why the last delete or pause did not stick, shown under the list. */
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pool || (!demo && !shownAccount)) return;
    let live = true;
    let reads = 0;
    const read = () => {
      const n = ++reads;
      const load =
        demo && demoAsset
          ? Promise.resolve([demoSchedule({ chainId, pool, asset: demoAsset, decimals: assetDecimals(demoAsset), today: demoDay })])
          : loadSchedules(chainId, pool);
      // only the newest read lands, so a slow one cannot put back an older list
      void load.then((list) => {
        if (live && n === reads) setSchedules(list);
      });
    };
    read();
    // a schedule saved, run or deleted in another tab shows here too
    const stop = demo ? undefined : onSchedulesChangedElsewhere(read);
    return () => {
      live = false;
      stop?.();
    };
  }, [chainId, pool, demo, demoAsset, demoDay, shownAccount, setSchedules]);

  // Saved first, shown after: a write refused because the stored schedules
  // cannot be opened must not look like it worked.
  const save = useCallback(
    async (edit: PayrollSchedule) => {
      const s = { ...edit, updatedAt: Date.now() };
      if (!demo) await saveSchedule(s);
      setSchedules((prev) => [s, ...prev.filter((x) => x.id !== s.id)]);
    },
    [demo, setSchedules]
  );

  // Deleted only once it is gone from storage: a refused delete keeps the
  // schedule in the list (it would be back on the next visit) and says why.
  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      setError(null);
      try {
        if (!demo) await deleteSchedule(id);
      } catch (e) {
        setError(e instanceof Error ? e.message : "The schedule could not be deleted. Try again.");
        return false;
      }
      setSchedules((prev) => prev.filter((x) => x.id !== id));
      return true;
    },
    [demo, setSchedules]
  );

  const togglePause = useCallback(
    async (s: PayrollSchedule) => {
      setError(null);
      await save({ ...s, paused: !s.paused }).catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "The schedule could not be changed. Try again.");
      });
    },
    [save]
  );

  /** A run for this schedule finished: it covered `payday`. */
  const markPaid = useCallback(
    async (id: string, payday: string, batchId: string) => {
      setSchedules((prev) => prev.map((s) => (s.id === id ? withPaid(s, payday, batchId) : s)));
      // A run that finished settles its payday from its own record too (see PayrollView), so a refused write here only costs the reminder.
      if (!demo) await markSchedulePaid(id, payday, batchId).catch(() => undefined);
    },
    [demo, setSchedules]
  );

  return { schedules, today, error, save, remove, togglePause, markPaid };
}
