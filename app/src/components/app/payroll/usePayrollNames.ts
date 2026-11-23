"use client";

/**
 * "@ada" in a payroll list's address column, looked up on the names registry
 * (Robinhood Chain), each name once. Shared by Payroll and the schedule editor,
 * so both read a list the same way.
 *
 *  - `rows`: the list with each name swapped for the Gloam address it holds;
 *    a row still being looked up keeps NAME_PENDING, and can't be paid or saved
 *  - `pending`: some name is still being looked up
 *  - `failed`: some name has no holder or couldn't be read
 *  - `retry`: look the failed ones up again
 *  - `confirm`: read every name in `rows` again right before paying; returns the
 *    names whose address changed (or that can't be read now), and takes the new
 *    answers, so the page shows what changed and nothing stale is paid
 */
import { useEffect, useMemo, useState } from "react";
import { lookupGloamName } from "@/hooks/useGloamName";
import {
  applyPayrollNames,
  NAME_PENDING,
  payrollNameChanges,
  payrollNamesToLookUp,
  type DraftRow,
  type PayrollNameAnswer,
  type PayrollNameChange,
} from "@/lib/payroll";

export { payrollNameChangeMessage as nameChangeMessage } from "@/lib/payroll";

function answerOf(record: Awaited<ReturnType<typeof lookupGloamName>>): PayrollNameAnswer {
  return record === "failed" ? "failed" : record ? { tag: record.tag } : "none";
}

export function usePayrollNames(raw: DraftRow[]) {
  const [answers, setAnswers] = useState<ReadonlyMap<string, PayrollNameAnswer>>(() => new Map());
  const toLookUp = useMemo(() => payrollNamesToLookUp(raw, answers).join(","), [raw, answers]);

  useEffect(() => {
    if (!toLookUp) return;
    let stale = false;
    const names = toLookUp.split(",");
    void Promise.all(names.map(async (n): Promise<[string, PayrollNameAnswer]> => [n, answerOf(await lookupGloamName(n))])).then((found) => {
      if (stale) return;
      setAnswers((prev) => {
        const next = new Map(prev);
        for (const [n, a] of found) next.set(n, a);
        return next;
      });
    });
    return () => {
      stale = true;
    };
  }, [toLookUp]);

  const rows = useMemo(() => applyPayrollNames(raw, answers), [raw, answers]);
  const pending = rows.some((r) => r.error === NAME_PENDING);
  const failed = rows.some((r) => r.payName && r.error && r.error !== NAME_PENDING);

  const retry = () =>
    setAnswers((prev) => {
      const next = new Map(prev);
      for (const [n, a] of prev) if (a === "failed" || a === "none") next.delete(n);
      return next;
    });

  async function confirm(paying: DraftRow[]): Promise<PayrollNameChange[]> {
    const named = [...new Set(paying.filter((r) => r.payName && !r.error).map((r) => r.payName!))];
    if (named.length === 0) return [];
    const fresh = await Promise.all(named.map(async (n) => [n, answerOf(await lookupGloamName(n))] as const));
    const changes = payrollNameChanges(fresh, answers);
    if (changes.length) {
      setAnswers((prev) => {
        const next = new Map(prev);
        for (const [n, a] of fresh) next.set(n, a);
        return next;
      });
    }
    return changes;
  }

  return { rows, pending, failed, retry, confirm };
}
