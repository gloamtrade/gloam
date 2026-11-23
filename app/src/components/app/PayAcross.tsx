"use client";

/**
 * Pay, sent in parts (lib/payAcross): the hook that runs a payment's parts on
 * payroll's engine through the relay, and the panel that shows "2 of 3 sent",
 * finishes a payment a refresh cut short, and stops the parts not sent yet.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { Spinner } from "@/components/ui/Spinner";
import { isPayRun, payRunPaid, payRunProgress, payRunTotal, startPayRun, stopPayRest } from "@/lib/payAcross";
import { isPayMemoLive } from "@/lib/payMemo";
import { runNetwork, runPayroll, type PayrollBatch } from "@/lib/payroll";
import { loadBatches } from "@/lib/payrollStore";
import { relayMemo, relayTransfer, relayTransferBatch, waitForTx } from "@/lib/relay/client";
import { batchesOn } from "@/lib/relay/batch";
import { splitMaybeSent } from "@/lib/cashOutSplit";
import { publicClientFor } from "@/lib/rhClient";
import { formatAssetLabel } from "@/lib/shield";
import { walletErrorForPeople } from "@/lib/walletErrors";
import type { GloamNetwork } from "@/lib/networks";

export type PayAcross = {
  /** The run shown: going now, just finished, or one a refresh cut short. */
  run: PayrollBatch | null;
  running: boolean;
  error: string | null;
  start: (run: PayrollBatch) => Promise<void>;
  resume: () => Promise<void>;
  cancel: () => Promise<void>;
  close: () => void;
};

/** A run not finished: still to send, or a part the chain hasn't settled. */
function unfinished(run: PayrollBatch): boolean {
  return run.status !== "done";
}

export function usePayAcross(address: Address | undefined, network: GloamNetwork, opts: { signedIn: boolean; onSettled: () => void }): PayAcross {
  const [run, setRun] = useState<PayrollBatch | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);
  const settled = useRef(opts.onSettled);
  useEffect(() => {
    settled.current = opts.onSettled;
  }, [opts.onSettled]);

  const runningNow = useRef(false);

  // A payment a refresh or a closed tab cut short shows again, to finish.
  useEffect(() => {
    if (!address || !network.pool || !opts.signedIn) return;
    let live = true;
    void loadBatches(network.chainId, network.pool)
      .then((runs) => {
        if (!live) return;
        const left = runs.find((r) => isPayRun(r) && unfinished(r) && r.employer.toLowerCase() === address.toLowerCase());
        // the run going now stays; otherwise the one left to finish, if any
        setRun((now) => (runningNow.current && now ? now : (left ?? null)));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [address, network.chainId, network.pool, opts.signedIn]);

  const go = useCallback(async (r: PayrollBatch) => {
    stop.current = false;
    runningNow.current = true;
    setRunning(true);
    setError(null);
    setRun(r);
    const net = runNetwork(r);
    const client = publicClientFor(net ?? network);
    try {
      const done = await runPayroll(r, {
        client,
        // always through the relay: one tap, never a wallet prompt per part
        submitTransfer: (a) => relayTransfer({ chainId: r.chainId, ...a }),
        submitMemo: isPayMemoLive() ? (m) => relayMemo({ chainId: r.chainId, ...m }) : null,
        // every part in one transaction where the network has Multicall3 (lib/relay/batch);
        // a batch the relay surely didn't send leaves the parts to go one by one
        ...(batchesOn(r.chainId)
          ? {
              submitTransferBatch: (parts) => relayTransferBatch({ chainId: r.chainId, parts }),
              batchRefused: (e: unknown) => !splitMaybeSent(e, true),
            }
          : {}),
        waitForTx: (h: Hex) => waitForTx(h, undefined, client),
        onUpdate: (b) => setRun(b),
        shouldStop: () => stop.current,
      });
      setRun({ ...done });
      if (done.status !== "done") {
        const held = done.rows.find((x) => x.error && x.status !== "paid");
        setError(held?.error ?? "The payment stopped before every part went. Your money is safe: resume to finish it.");
      }
    } catch (e) {
      setError(walletErrorForPeople(e, "The payment stopped. Your money is safe: resume to finish it."));
    } finally {
      runningNow.current = false;
      setRunning(false);
      settled.current();
    }
  }, [network]);

  const start = useCallback(async (r: PayrollBatch) => {
    if (runningNow.current) return;
    // Saved before anything is sent, so a refresh finds it and finishes it. One at a time:
    // a payment of this account's not finished here comes back instead of a second one.
    let begun: { run: PayrollBatch; started: boolean };
    try {
      begun = await startPayRun(r);
    } catch (e) {
      setError(walletErrorForPeople(e, "Couldn't start the payment. Try again."));
      return;
    }
    if (!begun.started) {
      setRun(begun.run);
      setError("A payment of yours isn't finished yet. Resume it, or stop the rest, before a new one.");
      return;
    }
    await go(begun.run);
  }, [go]);

  const resume = useCallback(async () => {
    if (run && !running) await go(run);
  }, [run, running, go]);

  const cancel = useCallback(async () => {
    if (!run || running) return;
    // under the run's lock and from the stored run: never while another tab is paying it
    let stopped: PayrollBatch | null;
    try {
      stopped = await stopPayRest(run);
    } catch (e) {
      setError(walletErrorForPeople(e, "Couldn't stop it just now. Try again."));
      return;
    }
    if (!stopped) {
      setError("A part is still on its way. Resume to let the chain settle it first.");
      return;
    }
    setRun(stopped);
    setError(null);
  }, [run, running]);

  const close = useCallback(() => {
    if (running) return;
    if (run && unfinished(run)) return;
    setRun(null);
    setError(null);
  }, [run, running]);

  // only this account's run, on the network shown: a switch hides it until it is back
  const shown =
    run && address && opts.signedIn && network.pool &&
    run.chainId === network.chainId &&
    run.pool.toLowerCase() === network.pool.toLowerCase() &&
    run.employer.toLowerCase() === address.toLowerCase()
      ? run
      : null;
  return { run: shown, running, error: shown ? error : null, start, resume, cancel, close };
}

/** The payment's parts as they go: "2 of 3 sent", then paid, or what stopped it and Resume. */
export function PayAcrossPanel({ across }: { across: PayAcross }) {
  const { run, running, error } = across;
  if (!run) return null;
  const p = payRunProgress(run);
  const total = formatAssetLabel(payRunTotal(run), run.asset);
  const paid = formatAssetLabel(payRunPaid(run), run.asset);
  const to = run.rows[0]?.name ?? "them";
  const cancelled = p.done && run.rows.some((r) => r.error === "Cancelled");

  return (
    <div role="status" aria-live="polite" className="rounded-[16px] border border-line bg-surface px-4 py-3.5 text-[13.5px] leading-relaxed">
      {p.done && !cancelled && p.failed === 0 ? (
        <>
          <p className="text-foreground">
            Paid {total} to {to} privately, as {p.parts} payments.
          </p>
          <p className="mt-0.5 text-mute">Each lands in their private balance on its own.</p>
          <button type="button" className="btn btn-ghost btn-sm mt-3" onClick={across.close}>
            Done
          </button>
        </>
      ) : p.done ? (
        <>
          <p className="text-foreground">
            Paid {paid} of {total} to {to}. {cancelled ? "The rest was stopped." : `${p.failed} ${p.failed === 1 ? "part" : "parts"} didn't go.`}
          </p>
          <p className="mt-0.5 text-mute">Nothing else left your balance.</p>
          <button type="button" className="btn btn-ghost btn-sm mt-3" onClick={across.close}>
            Done
          </button>
        </>
      ) : (
        <>
          <p className="flex items-center gap-2 text-foreground">
            {running && <Spinner />}
            {running ? `Paying ${total} to ${to}` : `Your payment of ${total} to ${to} isn't finished`}
          </p>
          <p className="tnum mt-0.5 text-mute">
            {p.sent} of {p.parts} sent
            {p.unconfirmed ? ". One is waiting for the network to confirm it." : "."}
          </p>
          {error && !running && <p className="mt-1 text-warn">{error}</p>}
          {!running && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn btn-ink btn-sm" onClick={() => void across.resume()}>
                Resume
              </button>
              {!p.unconfirmed && (
                <button type="button" className="btn btn-quiet btn-sm text-mute" onClick={() => void across.cancel()}>
                  Stop the rest
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
