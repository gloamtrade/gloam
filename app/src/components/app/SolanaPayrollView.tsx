"use client";

/**
 * Payroll on Solana: paste or upload a list, check every row, then pay it
 * privately through Gloam's relay, up to 15 people per transaction
 * (lib/solanaRings/payroll). A run is saved in this browser before each batch
 * is sent, so a closed tab resumes where it stopped without paying anyone
 * twice.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ringsAssets, ringsExplorerTx, RINGS_PAYROLL_NOTE } from "@/lib/solanaRings/config";
import type { RingsSession } from "@/lib/solanaRings/client";
import {
  addressesToCheck,
  checkRecipients,
  closeRun,
  newRun,
  parseSolanaPayrollCsv,
  resultsCsv,
  runCounts,
  runOpen,
  runPayroll,
  summarize,
  PAYROLL_MAX_ROWS,
  type PayrollRun,
  type RowStatus,
} from "@/lib/solanaRings/payroll";
import type { PayrollStore } from "@/lib/solanaRings/payrollStore";

const lib = () => import("@/lib/solanaRings/client");
const storeLib = () => import("@/lib/solanaRings/payrollStore");

const TEMPLATE = "name,address,amount\nAda Obi,PASTE_THEIR_SOLANA_PRIVATE_ADDRESS,250\nTunde Bello,PASTE_THEIR_SOLANA_PRIVATE_ADDRESS,180";

const STATUS_LABEL: Record<RowStatus, string> = {
  queued: "Waiting",
  sending: "Sending",
  confirming: "Confirming",
  checking: "Checking",
  paid: "Paid",
  skipped: "Skipped",
  not_paid: "Not paid",
  unknown: "Not sure",
};

const BUSY: ReadonlySet<RowStatus> = new Set(["sending", "confirming", "checking"]);

function short(a: string) {
  return a.length > 12 ? `${a.slice(0, 4)}...${a.slice(-4)}` : a;
}

import { displayAmount } from "@/lib/amountShort";
function fmt(v: bigint, decimals: number): string {
  return displayAmount(v, decimals);
}

/** A new run, stamped now. */
function freshRun(args: Omit<Parameters<typeof newRun>[0], "id" | "now">): PayrollRun {
  return newRun({ ...args, id: crypto.randomUUID(), now: Date.now() });
}

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function SolanaPayrollView(props: {
  session: RingsSession;
  /** Private balances in base units, by asset id. */
  balances: Record<string, bigint>;
  /** Which assets are set up on chain, by asset id. */
  ready: Record<string, boolean>;
  relayFunded: boolean;
  onBalances: (b: Record<string, bigint>) => void;
}) {
  const { session, balances, ready, relayFunded, onBalances } = props;
  const assets = ringsAssets(session.network);
  const [store, setStore] = useState<PayrollStore | null>(null);
  const [run, setRun] = useState<PayrollRun | null>(null);
  const [lastDone, setLastDone] = useState<PayrollRun | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [assetId, setAssetId] = useState(assets[0]!.id);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [registry, setRegistry] = useState<Map<string, boolean>>(() => new Map());
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkTick, setCheckTick] = useState(0);

  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const stopRef = useRef(false);
  const [stopping, setStopping] = useState(false);

  // This account's runs: an open one comes back to resume.
  useEffect(() => {
    let live = true;
    void lib()
      .then((l) => l.ringsPayrollStore(session))
      .then(async (s) => {
        const runs = await s.load();
        if (!live) return;
        setStore(s);
        const latest = runs[0] ?? null;
        if (latest && runOpen(latest)) setRun(latest);
        else setLastDone(latest);
      })
      .catch(() => live && setLoadError("This browser can't keep a payroll run. Try another browser."));
    return () => {
      live = false;
    };
  }, [session]);

  // Warn before leaving mid-run (a resume would pick it up, but it stops paying).
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  const asset = assets.find((a) => a.id === assetId)!;
  const parsed = parseSolanaPayrollCsv(text, asset);
  const pending = addressesToCheck(parsed.rows, registry);
  const rows = pending.length ? parsed.rows : checkRecipients(parsed.rows, registry, session.address);
  const summary = summarize(rows, balances[asset.id] ?? 0n);

  // Each new address is read once from the registry: can it be paid privately?
  const pendingKey = pending.join(",");
  useEffect(() => {
    if (!pendingKey) return;
    let live = true;
    const t = setTimeout(() => {
      setCheckError(null);
      void lib()
        .then((l) => l.registeredMany(session, pendingKey.split(",")))
        .then((found) => {
          if (live) setRegistry((m) => new Map([...m, ...found]));
        })
        .catch(() => live && setCheckError("Couldn't check the addresses on Solana."));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [pendingKey, session, checkTick]);

  const loadFile = useCallback(async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 512 * 1024) {
      setError("That file is too large for a payroll list.");
      return;
    }
    setError(null);
    setText(await f.text());
    setFileName(f.name);
  }, []);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void loadFile(e.dataTransfer.files?.[0]);
  };

  const execute = useCallback(
    async (start: PayrollRun) => {
      if (!store) return;
      const l = await lib();
      const { withRunLock } = await storeLib();
      const runAsset = ringsAssets(session.network).find((a) => a.id === start.asset);
      if (!runAsset) return setError("This run pays an asset Gloam no longer lists here.");
      setError(null);
      stopRef.current = false;
      setStopping(false);
      const sleep = (ms: number) =>
        new Promise<void>((done) => {
          const until = Date.now() + ms;
          const tick = () => (stopRef.current || Date.now() >= until ? done() : setTimeout(tick, 400));
          tick();
        });
      const ok = await withRunLock(session.address, async () => {
        setRunning(true);
        try {
          // The stored copy is the truth: another tab may have paid part of it since this one loaded.
          const fresh = (await store.load()).find((r) => r.id === start.id) ?? start;
          setRun({ ...fresh });
          const done = await runPayroll(fresh, {
            save: (x) => store.save(x),
            build: (payments) => l.buildPayments(session, runAsset, payments),
            send: (wire) => l.sendPayments(wire),
            release: () => l.releasePayments(session),
            confirm: (sig) => l.confirmPayments(session, sig),
            resolve: (f) => l.settlePayments(session, f),
            message: (e) => l.ringsErrorMessage(e),
            tooBig: (e) => l.paymentsTooBig(e),
            sleep,
            now: () => Date.now(),
            stopRequested: () => stopRef.current,
            onChange: (x) => setRun({ ...x, rows: [...x.rows] }),
          });
          setRun({ ...done, rows: [...done.rows] });
        } catch (e) {
          if (process.env.NODE_ENV !== "production") console.error("solana payroll:", e);
          setError(l.ringsErrorMessage(e));
        } finally {
          setRunning(false);
          setStopping(false);
          onBalances(l.ringsBalances(session));
        }
      });
      if (!ok) setError("This run is paying in another tab. Use that tab, or close it and resume here.");
    },
    [store, session, onBalances]
  );

  async function start() {
    if (!store || running) return;
    setError(null);
    setBusy("Reading your balance");
    try {
      const l = await lib();
      await l.syncRings(session);
      const now = l.ringsBalances(session);
      onBalances(now);
      const fresh = summarize(rows, now[asset.id] ?? 0n);
      if (fresh.short > 0n) {
        setError(`Your private balance is ${fmt(fresh.short, asset.decimals)} ${asset.symbol} short. Add more first.`);
        return;
      }
      const r = freshRun({ network: session.network, owner: session.address, asset: asset.id, rows });
      setBusy("Saving the run");
      await store.save(r);
      setRun(r);
      setText("");
      setFileName(null);
      setBusy(null);
      await execute(r);
    } catch (e) {
      const l = await lib();
      setError(l.ringsErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function close(r: PayrollRun) {
    if (!store) return;
    try {
      const closed = closeRun(r);
      await store.save(closed);
      setRun(null);
      setLastDone(closed);
      setClosing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't close the run.");
    }
  }

  function exportRun(r: PayrollRun) {
    const a = ringsAssets(r.network).find((x) => x.id === r.asset);
    if (!a) return;
    download(`gloam-solana-payroll-${new Date(r.createdAt).toISOString().slice(0, 10)}.csv`, resultsCsv(r, a));
  }

  if (loadError) {
    return (
      <Card title="Payroll">
        <p role="alert" className="mt-3 text-[13px] leading-relaxed text-warn">
          {loadError}
        </p>
      </Card>
    );
  }
  if (!store) return <div aria-busy="true" className="gl-card h-[320px] motion-safe:animate-pulse" />;

  // A run: resume it, watch it, download it.
  if (run) {
    const runAsset = ringsAssets(run.network).find((a) => a.id === run.asset);
    const c = runCounts(run);
    const decimals = runAsset?.decimals ?? 0;
    const symbol = runAsset?.symbol ?? "";
    const done = run.state === "done" && !runOpen(run);
    return (
      <Card title={done ? "Payroll done" : "Payroll"}>
        <p className="tnum mt-2 text-[14px] text-soft">
          Paid {c.paid} of {c.paid + c.toPay + c.unknown}, {fmt(c.paidAmount, decimals)} of {fmt(c.total, decimals)} {symbol}
          {c.skipped > 0 && <span className="text-mute">. {c.skipped} skipped</span>}
        </p>
        {run.error && !running && (
          <p role="alert" className="mt-4 rounded-[16px] bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
            {run.error}
          </p>
        )}
        {run.inflight && !running && (
          <p className="mt-4 text-[12.5px] leading-relaxed text-mute">
            The last batch may still be landing. Resume checks it on Solana before anything else is sent.
          </p>
        )}

        <RowList>
          {run.rows.map((r, i) => (
            <li key={i} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-[14px] text-foreground">{r.name}</p>
                <p className="truncate font-mono text-[12px] text-mute">{short(r.address)}</p>
                {r.reason && r.status !== "paid" && <p className="mt-0.5 text-[12px] leading-snug text-warn">{r.reason}</p>}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="tnum text-[14px] text-foreground">
                  {r.status === "skipped" ? "" : `${fmt(BigInt(r.amount), decimals)} ${symbol}`}
                </span>
                <StatusChip status={r.status} idle={!running} />
                {r.status === "paid" && r.signature && (
                  <a
                    href={ringsExplorerTx(r.signature, run.network)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] text-mute underline-offset-2 hover:text-foreground hover:underline"
                  >
                    View
                  </a>
                )}
              </div>
            </li>
          ))}
        </RowList>

        <div className="mt-5 space-y-2">
          {running ? (
            <button
              type="button"
              className="btn btn-ghost w-full"
              disabled={stopping}
              onClick={() => {
                stopRef.current = true;
                setStopping(true);
              }}
            >
              {stopping ? "Pausing after this batch" : "Pause after this batch"}
            </button>
          ) : !done ? (
            <>
              <button type="button" className="btn btn-ink btn-lg w-full" disabled={!relayFunded} onClick={() => void execute(run)}>
                Resume
              </button>
              {!relayFunded && <p className="text-[12.5px] text-warn">Private payments on Solana are paused for a moment. Try again later.</p>}
            </>
          ) : null}
          <button type="button" className="btn btn-ghost w-full" onClick={() => exportRun(run)}>
            Download results
          </button>
          {done && (
            <button
              type="button"
              className="btn btn-quiet w-full"
              onClick={() => {
                setLastDone(run);
                setRun(null);
              }}
            >
              New run
            </button>
          )}
          {!running && !done && !run.inflight && (
            <button
              type="button"
              className={`btn btn-quiet w-full ${closing ? "text-warn" : ""}`}
              onClick={() => (closing ? void close(run) : setClosing(true))}
            >
              {closing ? `Close it. ${people(c.toPay)} won't be paid` : "Close this run"}
            </button>
          )}
        </div>
        {running && (
          <p aria-live="polite" className="mt-4 rounded-[16px] bg-sealed-soft px-4 py-3 text-[13px] text-foreground">
            Paying in batches of up to 15. Keep this tab open.
          </p>
        )}
        <Status error={error} />
      </Card>
    );
  }

  // A new run.
  const setUp = ready[asset.id] !== false;
  const can = setUp && relayFunded && !pending.length && !checkError && summary.ready > 0 && summary.short === 0n && !busy && !parsed.error;
  return (
    <Card title="Payroll">
      <p className="mt-2 text-[14px] leading-relaxed text-soft">Pay up to {PAYROLL_MAX_ROWS} people privately from one list.</p>

      <div className="mt-5 flex flex-wrap gap-2">
        {assets.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`gl-chip min-h-10 ${a.id === assetId ? "border-foreground! text-foreground!" : ""}`}
            onClick={() => setAssetId(a.id)}
          >
            {a.symbol}
          </button>
        ))}
      </div>
      {!setUp && <p className="mt-2 text-[12.5px] text-warn">{asset.symbol} is not set up on Gloam yet.</p>}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`mt-5 rounded-[16px] border border-dashed p-3 transition-colors ${dragging ? "border-foreground bg-surface" : "border-line-strong"}`}
      >
        <label htmlFor="sol-payroll-list" className="text-[13px] text-mute">
          {fileName ? fileName : "Paste a list or drop a CSV: name, address, amount"}
        </label>
        <textarea
          id="sol-payroll-list"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setFileName(null);
          }}
          rows={5}
          spellCheck={false}
          wrap="off"
          placeholder={TEMPLATE}
          className="gl-input tnum mt-2 h-auto resize-y overflow-x-auto whitespace-pre py-3 font-mono text-[12.5px] leading-[1.7]"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn btn-ghost btn-sm h-10" onClick={() => fileRef.current?.click()}>
            Choose a CSV
          </button>
          {text && (
            <button
              type="button"
              className="btn btn-quiet btn-sm h-10"
              onClick={() => {
                setText("");
                setFileName(null);
              }}
            >
              Clear
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          className="hidden"
          onChange={(e) => {
            void loadFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {parsed.error && (
        <p role="alert" className="mt-3 text-[13px] leading-relaxed text-warn">
          {parsed.error}
        </p>
      )}

      {rows.length > 0 && (
        <>
          <RowList>
            {rows.map((r) => {
              const waiting = !r.error && pending.includes(r.address);
              return (
                <li key={r.line} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-[14px] text-foreground">{r.name}</p>
                    <p className="truncate font-mono text-[12px] text-mute">{r.address ? short(r.address) : `Line ${r.line}`}</p>
                    {r.error && <p className="mt-0.5 text-[12px] leading-snug text-warn">{r.error}</p>}
                    {!r.error && r.note && <p className="mt-0.5 text-[12px] leading-snug text-mute">{r.note}</p>}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="tnum text-[14px] text-foreground">
                      {r.amount !== null ? `${fmt(r.amount, asset.decimals)} ${asset.symbol}` : r.amountInput}
                    </span>
                    {r.error ? <StatusChip status="skipped" /> : waiting ? <StatusChip status="checking" /> : null}
                  </div>
                </li>
              );
            })}
          </RowList>

          <dl className="mt-4 space-y-1.5 text-[14px]">
            <Line k="People" v={`${summary.ready}${summary.skipped ? `, ${summary.skipped} skipped` : ""}`} />
            <Line k="Total" v={`${fmt(summary.total, asset.decimals)} ${asset.symbol}`} />
            <Line k="Private balance" v={`${fmt(balances[asset.id] ?? 0n, asset.decimals)} ${asset.symbol}`} />
          </dl>
          {summary.short > 0n && (
            <p className="mt-3 text-[13px] leading-relaxed text-warn">
              Your private balance is {fmt(summary.short, asset.decimals)} {asset.symbol} short. Add more first.
            </p>
          )}
          {checkError && (
            <p className="mt-3 text-[13px] text-warn">
              {checkError}{" "}
              <button type="button" className="underline underline-offset-2" onClick={() => setCheckTick((n) => n + 1)}>
                Try again
              </button>
            </p>
          )}
        </>
      )}

      <p className="mt-4 text-[12.5px] leading-relaxed text-mute">{RINGS_PAYROLL_NOTE}</p>
      {!relayFunded && <p className="mt-3 text-[12.5px] leading-relaxed text-warn">Private payments on Solana are paused for a moment. Try again later.</p>}

      <button type="button" className="btn btn-ink btn-lg mt-5 w-full" disabled={!can} onClick={() => void start()}>
        {busy ?? (pending.length ? "Checking addresses" : summary.ready ? `Pay ${people(summary.ready)}` : "Pay")}
      </button>
      <Status error={error} />

      {lastDone && (
        <button type="button" className="btn btn-quiet btn-sm mt-3 h-10 w-full text-mute" onClick={() => exportRun(lastDone)}>
          Download your last run&apos;s results
        </button>
      )}
    </Card>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="gl-card p-5 sm:p-7">
      <h2 className="t-title">{title}</h2>
      {children}
    </div>
  );
}

function RowList({ children }: { children: ReactNode }) {
  return <ul className="mt-4 max-h-[420px] divide-y divide-line overflow-y-auto overscroll-contain border-y border-line pr-2">{children}</ul>;
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-mute">{k}</dt>
      <dd className="tnum text-foreground">{v}</dd>
    </div>
  );
}

/** `idle`: the run isn't running here, so a row left in flight shows as that, without a spinner. */
function StatusChip({ status, idle = false }: { status: RowStatus; idle?: boolean }) {
  const busy = BUSY.has(status) && !idle;
  const tone =
    status === "paid"
      ? "bg-sealed-soft text-foreground"
      : status === "skipped" || status === "unknown" || status === "not_paid"
        ? "bg-warn-soft text-warn"
        : "bg-surface text-soft";
  return (
    <span className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium ${tone}`}>
      {busy && (
        <span aria-hidden className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-70 motion-reduce:animate-none" />
      )}
      {BUSY.has(status) && idle ? "In flight" : STATUS_LABEL[status]}
    </span>
  );
}

function Status({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-4 text-[13px] leading-relaxed text-warn">
      {error}
    </p>
  );
}

