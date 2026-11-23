"use client";

/**
 * Cash out in parts (lib/cashOutAcross): the hook that runs a cash out across
 * balances, and the panel that shows "2 of 3 cashed out", finishes one a
 * refresh cut short, stops the parts not sent yet, and lists each part's
 * receipt once it's done.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseAbiItem, type Address, type Hex } from "viem";
import { Spinner } from "@/components/ui/Spinner";
import {
  CASHOUT_CANCELLED,
  cashOutPaid,
  cashOutProgress,
  cashOutTotal,
  runCashOutAcross,
  startCashOutRun,
  stopCashOutRest,
  type CashOutAcrossRun,
} from "@/lib/cashOutAcross";
import { loadCashOutRun, loadCashOutRuns, saveCashOutRun } from "@/lib/cashOutAcrossStore";
import { proveCashOut, type CashOutCall } from "@/lib/cashOutProof";
import { cashOutTogetherRefused, freshPath, splitForCashOut, splitMaybeSent, type TransferArgs } from "@/lib/cashOutSplit";
import { getLogsSafe } from "@/lib/logRange";
import { getAllNotes } from "@/lib/noteVault";
import { relayUnshield, relayUnshieldBatch, waitForTx } from "@/lib/relay/client";
import { batchesOn } from "@/lib/relay/batch";
import { publicClientFor } from "@/lib/rhClient";
import { formatAssetLabel, shieldPoolAbi, updateLocalNote } from "@/lib/shield";
import { walletErrorForPeople } from "@/lib/walletErrors";
import type { GloamNetwork } from "@/lib/networks";

const UNSHIELDED = parseAbiItem("event Unshielded(bytes32 indexed nullifier, address indexed asset, address indexed to, uint256 amount)");

export type CashOutAcross = {
  run: CashOutAcrossRun | null;
  running: boolean;
  status: string | null;
  error: string | null;
  start: (run: CashOutAcrossRun) => Promise<void>;
  resume: () => Promise<void>;
  cancel: () => Promise<void>;
  close: () => void;
};

const STORE = { loadAll: loadCashOutRuns, load: loadCashOutRun, save: saveCashOutRun };

export function useCashOutAcross(
  address: Address | undefined,
  network: GloamNetwork,
  opts: {
    signedIn: boolean;
    onSettled: () => void;
    /** The wallet sends, when Hide my wallet is off: the cash out and the set-aside step. */
    walletUnshield: (call: CashOutCall) => Promise<Hex>;
    walletTransfer: (t: TransferArgs) => Promise<Hex>;
  }
): CashOutAcross {
  const [run, setRun] = useState<CashOutAcrossRun | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);
  const runningNow = useRef(false);
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });

  // One a refresh or a closed tab cut short shows again, to finish.
  useEffect(() => {
    if (!address || !network.pool || !opts.signedIn) return;
    let live = true;
    void loadCashOutRuns(network.chainId, network.pool)
      .then((runs) => {
        if (!live) return;
        const left = runs.find((r) => r.status !== "done" && r.owner.toLowerCase() === address.toLowerCase());
        setRun((now) => (runningNow.current && now ? now : (left ?? null)));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [address, network.chainId, network.pool, opts.signedIn]);

  const go = useCallback(
    async (r: CashOutAcrossRun) => {
      stop.current = false;
      runningNow.current = true;
      setRunning(true);
      setError(null);
      setRun(r);
      const client = publicClientFor(network);
      try {
        const done = await runCashOutAcross(r, {
          load: loadCashOutRun,
          save: saveCashOutRun,
          getNote: (id) => getAllNotes().find((n) => n.id === id),
          findSplitPart: (noteId, amount, skip) =>
            getAllNotes()
              .filter((n) => n.sweptFrom?.id === noteId && BigInt(n.amountWei) === amount && n.status === "open" && !skip.includes(n.id))
              // one that landed first
              .sort((a, b) => Number(!!a.sweepPending) - Number(!!b.sweepPending))[0],
          split: (note, amount) =>
            (async () => {
              const at = await freshPath(note.commitment, network);
              if (!at) throw new Error("Could not read your private balance. Refresh and try again.");
              return splitForCashOut({
                note,
                amount,
                path: at.path,
                owner: r.owner,
                relayOn: r.relay,
                sendWithWallet: (t) => latest.current.walletTransfer(t),
                onStatus: setStatus,
              });
            })(),
          prove: async (note, to) => {
            const at = await freshPath(note.commitment, network);
            if (!at) throw new Error("Could not read your private balance. Refresh and try again.");
            setStatus("Proving privately, this takes 10 to 30 seconds…");
            return proveCashOut(note, to, at.path, r.chainId);
          },
          submit: (call) => {
            setStatus(r.relay ? "Sending through the Gloam relay…" : "Confirm the cash out in your wallet…");
            return r.relay ? relayUnshield(call) : latest.current.walletUnshield(call);
          },
          // through the relay, every part in one transaction where the network has Multicall3
          // (lib/relay/batch), at the fee confirmed; a batch the relay surely didn't send
          // leaves the parts to go one by one, unless the fee went up since
          ...(r.relay && batchesOn(r.chainId) && typeof r.feeBps === "number"
            ? {
                submitTogether: (calls: CashOutCall[]) => {
                  setStatus("Sending every part together through the Gloam relay…");
                  return relayUnshieldBatch({ chainId: r.chainId, pool: r.pool, feeBps: r.feeBps!, parts: calls });
                },
                togetherRefused: cashOutTogetherRefused,
              }
            : {}),
          maybeSent: (e) => splitMaybeSent(e, r.relay),
          waitForTx: (h) => waitForTx(h, undefined, client),
          isSpent: async (nullifier) =>
            (await client.readContract({ address: r.pool, abi: shieldPoolAbi, functionName: "isSpent", args: [nullifier] })) as boolean,
          blockNumber: () => client.getBlockNumber(),
          payoutOf: async (nullifier, from) => {
            const head = await client.getBlockNumber();
            if (head < from) return null;
            const logs = await getLogsSafe(
              (a, b) => client.getLogs({ address: r.pool, event: UNSHIELDED, args: { nullifier }, fromBlock: a, toBlock: b }),
              from,
              head
            );
            const hit = logs[0]?.args;
            return hit?.to && hit.amount != null ? { to: hit.to, amount: hit.amount } : null;
          },
          markSpent: (noteId, hash) => {
            updateLocalNote(noteId, { status: "recovered", txHash: hash });
          },
          onUpdate: (b) => setRun(b),
          shouldStop: () => stop.current,
        });
        setRun(done);
        if (done.status !== "done") {
          const held = done.parts.find((p) => p.error && p.status !== "paid" && p.status !== "failed");
          setError(held?.error ?? "The cash out stopped before every part went. Your money is safe: resume to finish it.");
        }
      } catch (e) {
        setError(walletErrorForPeople(e, "The cash out stopped. Your money is safe: resume to finish it."));
        const fresh = await loadCashOutRun(r.id).catch(() => null);
        if (fresh) setRun(fresh);
      } finally {
        runningNow.current = false;
        setRunning(false);
        setStatus(null);
        latest.current.onSettled();
      }
    },
    [network]
  );

  const start = useCallback(
    async (r: CashOutAcrossRun) => {
      if (runningNow.current) return;
      let begun: { run: CashOutAcrossRun; started: boolean };
      try {
        begun = await startCashOutRun(r, STORE);
      } catch (e) {
        setError(walletErrorForPeople(e, "Couldn't start the cash out. Try again."));
        return;
      }
      if (!begun.started) {
        setRun(begun.run);
        setError("A cash out of yours isn't finished yet. Resume it, or stop the rest, before a new one.");
        return;
      }
      await go(begun.run);
    },
    [go]
  );

  const resume = useCallback(async () => {
    if (run && !running) await go(run);
  }, [run, running, go]);

  const cancel = useCallback(async () => {
    if (!run || running) return;
    let stopped: CashOutAcrossRun | null;
    try {
      stopped = await stopCashOutRest(run, STORE);
    } catch (e) {
      setError(walletErrorForPeople(e, "Couldn't stop it just now. Try again."));
      return;
    }
    if (!stopped) {
      setError("A part is still on its way. Resume to let the network settle it first.");
      return;
    }
    setRun(stopped);
    setError(null);
  }, [run, running]);

  const close = useCallback(() => {
    if (running || (run && run.status !== "done")) return;
    setRun(null);
    setError(null);
  }, [run, running]);

  const shown =
    run && address && opts.signedIn && network.pool &&
    run.chainId === network.chainId &&
    run.pool.toLowerCase() === network.pool.toLowerCase() &&
    run.owner.toLowerCase() === address.toLowerCase()
      ? run
      : null;
  return { run: shown, running, status: shown ? status : null, error: shown ? error : null, start, resume, cancel, close };
}

/** A cash out's parts as they go, then each part's receipt. */
export function CashOutAcrossPanel({ across, networkKey }: { across: CashOutAcross; networkKey: string }) {
  const { run, running, error, status } = across;
  if (!run) return null;
  const p = cashOutProgress(run);
  const total = formatAssetLabel(cashOutTotal(run), run.asset);
  const paid = formatAssetLabel(cashOutPaid(run), run.asset);
  const cancelled = p.done && run.parts.some((x) => x.error === CASHOUT_CANCELLED);
  const sent = run.parts.filter((x) => x.status === "paid" && x.txHash);
  // parts sent together wait on the chain together
  const onTheirWay = run.parts.filter((x) => x.status === "sent").length;

  return (
    <div role="status" aria-live="polite" className="rounded-[16px] border border-line bg-surface px-4 py-3.5 text-[13.5px] leading-relaxed">
      {p.done ? (
        <>
          <p className="text-foreground">
            {p.failed === 0 ? `Cashed out ${total} as ${p.parts} withdrawals to the same wallet.` : `Cashed out ${paid} of ${total}. ${cancelled ? "The rest was stopped." : `${p.failed} ${p.failed === 1 ? "part" : "parts"} didn't go.`}`}
          </p>
          {p.failed > 0 && <p className="mt-0.5 text-mute">The rest stays in your private balance.</p>}
          {sent.length > 0 && (
            <div className="mt-2 flex flex-col">
              <span className="text-mute">Get receipts</span>
              {/* parts sent together share one transaction: each receipt names its own part's spend */}
              {sent.map((x, i) => (
                <Link
                  key={x.nullifier ?? `${x.txHash}-${i}`}
                  href={`/app/disclose?mode=cashout&tx=${x.txHash}&net=${networkKey}${x.nullifier ? `&part=${x.nullifier}` : ""}`}
                  className="inline-flex min-h-10 items-center font-medium text-foreground underline underline-offset-4"
                >
                  Part {i + 1}: {formatAssetLabel(x.amount, run.asset)}
                </Link>
              ))}
            </div>
          )}
          <button type="button" className="btn btn-ghost btn-sm mt-3" onClick={across.close}>
            Done
          </button>
        </>
      ) : (
        <>
          <p className="flex items-center gap-2 text-foreground">
            {running && <Spinner />}
            {running ? `Cashing out ${total}` : `Your cash out of ${total} isn't finished`}
          </p>
          <p className="tnum mt-0.5 text-mute">
            {p.paid} of {p.parts} cashed out
            {running && status ? `. ${status}` : p.waiting ? (onTheirWay === 1 ? ". One is waiting for the network to confirm it." : `. ${onTheirWay} are waiting for the network to confirm them.`) : "."}
          </p>
          {error && !running && <p className="mt-1 text-warn">{error}</p>}
          {!running && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn btn-ink btn-sm" onClick={() => void across.resume()}>
                Resume
              </button>
              {!p.waiting && (
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
