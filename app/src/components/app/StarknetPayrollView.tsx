"use client";

/**
 * Payroll on Starknet, laid out as EVM and Solana payroll are: what it pays in
 * and the team on the left, this run's total, what it costs, the private
 * balance and the one action on the right. Paste or upload a list, check
 * every row, then pay it privately through Gloam's relay, as many people per
 * proof as one transaction takes (lib/starknetPrivacy/payroll). A run is saved
 * in this browser before each proof is sent, so a closed tab resumes where it
 * stopped without paying anyone twice. The account comes from StarknetAccount
 * (its payroll engine).
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  addressesToCheck,
  checkRecipients,
  closeRun,
  newRun,
  parseStarknetPayrollCsv,
  resultsCsv,
  runCounts,
  runOpen,
  runPayroll,
  summarize,
  PAYROLL_MAX_ROWS,
  type PayrollRun,
  type Reach,
  type RowStatus,
} from "@/lib/starknetPrivacy/payroll";
import type { PayrollStore } from "@/lib/starknetPrivacy/payrollStore";
import { isoDay } from "@/lib/payrollSchedule";
import { newSchedule, paydayToRun, peopleFromRows, scheduleListText, withPaid, type StarknetSchedule } from "@/lib/starknetPrivacy/payrollSchedule";
import type { StarknetToken } from "@/lib/starknetPrivacy/config";
import { Spinner } from "@/components/ui/Spinner";
import { TokenLogo } from "./TokenLogo";
import { SolanaSteps } from "./SolanaParts";
import { shortStark, useStarknet, type StarknetLinksEngine, type StarknetPayrollEngine } from "./StarknetAccount";
import { sentLinkUrl } from "@/lib/starknetPrivacy/sentLinks";
import { STARKNET_NAME, StarknetGate, starkAmount } from "./StarknetParts";
import { starknetExplorerTx } from "./StarknetVault";
import { StarknetDueLine, StarknetScheduleList, StarknetScheduleSave, useStarknetSchedules } from "./StarknetPayrollSchedules";
import { LINK_PRIVACY_NOTE } from "./StarknetLinks";

const storeLib = () => import("@/lib/starknetPrivacy/payrollStore");

const TEMPLATE = "name,address,amount\nAda Obi,0xPASTE_THEIR_STARKNET_PRIVATE_ACCOUNT,250\nTunde Bello,,180";

const STATUS_LABEL: Record<RowStatus, string> = {
  queued: "Waiting",
  proving: "Proving",
  sending: "Sending",
  confirming: "Confirming",
  checking: "Checking",
  paid: "Paid",
  skipped: "Skipped",
  not_paid: "Not paid",
  unknown: "Not sure",
};

const BUSY: ReadonlySet<RowStatus> = new Set(["proving", "sending", "confirming", "checking"]);

/** A new run, stamped now. */
function freshRun(args: Omit<Parameters<typeof newRun>[0], "id" | "now">): PayrollRun {
  return newRun({ ...args, id: crypto.randomUUID(), now: Date.now() });
}

/** A new schedule, stamped now. */
function freshSchedule(args: Omit<Parameters<typeof newSchedule>[0], "id" | "now">): StarknetSchedule {
  return newSchedule({ ...args, id: crypto.randomUUID(), now: Date.now() });
}

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
const proofsText = (n: number) => `${n} ${n === 1 ? "proof" : "proofs"}`;

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function UploadGlyph({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PasteGlyph() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="6" y="5" width="12" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9.5 5V4a1 1 0 011-1h3a1 1 0 011 1v1M9.5 11h5M9.5 14.5h3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DownloadGlyph() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Payroll on Starknet: the open-your-account card until the private account is open. */
export function StarknetPayrollPage() {
  const sn = useStarknet();
  if (!sn) return null;
  if (!sn.address || !sn.payroll) return <StarknetGate />;
  const relayNote =
    sn.relay?.funded === false
      ? `Private payments on ${STARKNET_NAME} are paused for a moment. Try again later.`
      : sn.relay?.moves === "off"
        ? `Paying on ${STARKNET_NAME} isn't open yet. Try again later.`
        : null;
  return <StarknetPayrollView engine={sn.payroll} links={sn.links} balance={sn.privateBalance} fee={sn.fee} relayNote={relayNote} />;
}

export function StarknetPayrollView(props: {
  engine: StarknetPayrollEngine;
  /** Private balance in base units, once read. */
  balance: bigint | null;
  /** Gloam's fee per proof, base units (0 when none). */
  fee: bigint;
  /** Why the relay can't pay right now (paused, or moves not open), or null. */
  relayNote: string | null;
  /** Claim links: a row with no account is paid by one. Null leaves them out (every row needs an account). */
  links?: StarknetLinksEngine | null;
}) {
  const { engine, balance, fee, relayNote } = props;
  const links = props.links ?? null;
  /** Each paid link's URL by its id, for Copy and the results file (read from Sent links). */
  const [linkUrls, setLinkUrls] = useState<Map<string, string>>(() => new Map());
  const relayFunded = relayNote === null;
  const token = engine.token;
  const [store, setStore] = useState<PayrollStore | null>(null);
  const [run, setRun] = useState<PayrollRun | null>(null);
  const [lastDone, setLastDone] = useState<PayrollRun | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [reach, setReach] = useState<Map<string, Reach>>(() => new Map());
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkTick, setCheckTick] = useState(0);
  const [running, setRunning] = useState(false);
  /** What the run is on, for the wait's line. */
  const [detail, setDetail] = useState<string | null>(null);
  /** 0 reading the balance, 1 saving the run; null when not starting. */
  const [starting, setStarting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const stopRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [today] = useState(() => isoDay());
  const sched = useStarknetSchedules(engine.schedules);
  /** The schedule whose list is loaded, and the payday a run of it covers (null: none owed yet). */
  const [loaded, setLoaded] = useState<{ id: string; payday: string | null } | null>(null);
  const schedulesRef = useRef<StarknetSchedule[]>([]);
  useEffect(() => {
    schedulesRef.current = sched.list ?? [];
  }, [sched.list]);

  // Paid claim links in the run on screen: their URLs, for Copy and the results file.
  const paidLinks = run ? run.rows.flatMap((r) => (r.link?.id && r.status === "paid" ? [r.link.id] : [])).join(",") : "";
  useEffect(() => {
    if (!links || !paidLinks) return;
    let live = true;
    void links
      .sentLinks()
      .then((st) => st.load())
      .then((all) => {
        if (live) setLinkUrls(new Map(all.map((l) => [l.id, sentLinkUrl(l, window.location.origin)] as const)));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [links, paidLinks]);

  // This account's runs: an open one comes back to resume.
  useEffect(() => {
    let live = true;
    void engine
      .store()
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
  }, [engine]);

  // Warn before leaving mid-run (a resume would pick it up, but it stops paying), and pause when the page goes.
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);
  useEffect(
    () => () => {
      stopRef.current = true;
    },
    []
  );

  const parsed = parseStarknetPayrollCsv(text, token, { links: Boolean(links) });
  const pending = addressesToCheck(parsed.rows, reach);
  const rows = pending.length ? parsed.rows : checkRecipients(parsed.rows, reach, engine.owner);
  const have = balance ?? 0n;
  const summary = summarize(rows, have, fee);

  // Each new account is read once: can it be paid privately, and is this the first payment to it?
  const pendingKey = pending.join(",");
  useEffect(() => {
    if (!pendingKey) return;
    let live = true;
    const t = setTimeout(() => {
      setCheckError(null);
      void engine
        .reach(pendingKey.split(","))
        .then((found) => {
          if (live) setReach((m) => new Map([...m, ...found]));
        })
        .catch(() => live && setCheckError(`Couldn't check the accounts on ${STARKNET_NAME}.`));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [pendingKey, engine, checkTick]);

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
      const { withRunLock } = await storeLib();
      setError(null);
      stopRef.current = false;
      setStopping(false);
      const sleep = (ms: number) =>
        new Promise<void>((done) => {
          const until = Date.now() + ms;
          const tick = () => (stopRef.current || Date.now() >= until ? done() : setTimeout(tick, 400));
          tick();
        });
      const ok = await withRunLock(engine.owner, async () => {
        setRunning(true);
        try {
          const deps = { ...(await engine.deps()), ...(links ? await links.linkDeps() : {}) };
          // The stored copy is the truth: another tab may have paid part of it since this one loaded.
          const fresh = (await store.load()).find((r) => r.id === start.id) ?? start;
          setRun({ ...fresh });
          const done = await runPayroll(fresh, {
            ...deps,
            message: engine.message,
            save: (x) => store.save(x),
            sleep,
            now: () => Date.now(),
            stopRequested: () => stopRef.current,
            onChange: (x, d) => {
              setRun({ ...x, rows: [...x.rows] });
              setDetail(d ?? null);
            },
          });
          setRun({ ...done, rows: [...done.rows] });
          // A run of a schedule's payday that finished: that payday is paid.
          const of = done.state === "done" && done.scheduleId && done.payday ? schedulesRef.current.find((x) => x.id === done.scheduleId) : undefined;
          if (of && done.payday) await sched.save(withPaid(of, done.payday, done.id, Date.now())).catch(() => undefined);
        } catch (e) {
          if (process.env.NODE_ENV !== "production") console.error("starknet payroll:", e);
          setError(engine.message(e));
        } finally {
          setRunning(false);
          setStopping(false);
          setDetail(null);
          await engine.sync().catch(() => undefined);
        }
      });
      if (!ok) setError("This run is paying in another tab. Use that tab, or close it and resume here.");
    },
    [store, engine, sched, links]
  );

  async function start() {
    if (!store || running || starting !== null) return;
    setError(null);
    setStarting(0);
    try {
      const now = await engine.sync();
      const fresh = summarize(rows, now, fee);
      if (fresh.short > 0n) {
        setError(`Your private balance is ${starkAmount(fresh.short, token)} ${token.symbol} short with Gloam's fee. Add more first.`);
        return;
      }
      const r = freshRun({ network: engine.network, owner: engine.owner, token: token.address, rows, ...(loaded?.payday ? { schedule: { id: loaded.id, payday: loaded.payday } } : {}) });
      setStarting(1);
      await store.save(r);
      setRun(r);
      setText("");
      setFileName(null);
      setLoaded(null);
      setStarting(null);
      await execute(r);
    } catch (e) {
      setError(engine.message(e));
    } finally {
      setStarting(null);
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

  function loadSchedule(s: StarknetSchedule) {
    setText(scheduleListText(s, token));
    setFileName(s.name);
    setPasteOpen(true);
    setLoaded({ id: s.id, payday: paydayToRun(s, today) });
  }

  async function saveSchedule(name: string, cadence: StarknetSchedule["cadence"], startsOn: string) {
    const s = freshSchedule({ name, network: engine.network, owner: engine.owner, token: token.address, cadence, startsOn, people: peopleFromRows(rows) });
    await sched.save(s);
    setLoaded({ id: s.id, payday: paydayToRun(s, today) });
  }

  function exportRun(r: PayrollRun) {
    download(`gloam-starknet-payroll-${new Date(r.createdAt).toISOString().slice(0, 10)}.csv`, resultsCsv(r, token, (id) => linkUrls.get(id) ?? null));
  }

  if (loadError) {
    return (
      <div className="gl-card max-sm:p-5 sm:p-6">
        <h2 className="text-[17px] text-foreground">Payroll</h2>
        <p role="alert" className="mt-3 text-[13px] leading-relaxed text-warn">
          {loadError}
        </p>
      </div>
    );
  }

  if (!store) {
    return (
      <div className="grid max-lg:gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6" aria-busy="true" aria-label="Loading">
        <div className="gl-card h-[420px] motion-safe:animate-pulse" />
        <div className="gl-card h-[320px] motion-safe:animate-pulse" />
      </div>
    );
  }

  // A run: watch it, resume it, download it.
  if (run) {
    const c = runCounts(run);
    const done = run.state === "done" && !runOpen(run);
    const of = c.paid + c.toPay + c.unknown;
    const share = of > 0 ? Math.round((c.paid / of) * 100) : 0;
    const feesPaid = BigInt(run.feesPaid);
    return (
      <div className="grid max-lg:gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
        <section className="gl-card min-w-0 max-sm:p-5 sm:p-6">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[17px] text-foreground">{done ? "Payroll done" : "This payroll"}</h2>
            <span className="tnum text-[13px] text-mute">{people(run.rows.length)}</span>
          </div>
          <RowList>
            {run.rows.map((r, i) => {
              const href = r.status === "paid" && r.txHash ? starknetExplorerTx(r.txHash) : null;
              return (
                <li key={i} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-[14px] text-foreground">{r.name}</p>
                    <p className="tnum truncate text-[12px] text-mute">{r.link ? "Claim link" : shortStark(r.address)}</p>
                    {r.reason && r.status !== "paid" && <p className="mt-0.5 text-[12px] leading-snug text-warn">{r.reason}</p>}
                    {r.link?.id && r.status === "paid" && linkUrls.get(r.link.id) && <CopyLink url={linkUrls.get(r.link.id)!} />}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="tnum text-[14px] text-foreground">{r.status === "skipped" ? "" : `${starkAmount(BigInt(r.amount), token)} ${token.symbol}`}</span>
                    <span className="flex items-center gap-1">
                      {href && (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-6 items-center rounded-full px-2 text-[12px] text-mute underline-offset-2 hover:text-foreground hover:underline"
                        >
                          View
                        </a>
                      )}
                      <StatusChip status={r.status} idle={!running} />
                    </span>
                  </div>
                </li>
              );
            })}
          </RowList>
        </section>

        <aside className="min-w-0 space-y-5">
          <section className="gl-card max-sm:p-5 sm:p-6">
            <h2 className="text-[17px] text-foreground">This run</h2>
            <p className="tnum mt-4 flex items-center gap-2.5 text-[34px] font-light leading-none tracking-[-0.02em] text-foreground">
              {starkAmount(c.paidAmount, token)}
              <TokenLogo id="usdc" symbol={token.symbol} size={26} />
            </p>
            <p className="tnum mt-2 text-[13.5px] text-mute">
              Paid {c.paid} of {of}, of {starkAmount(c.total, token)} {token.symbol}
              {c.skipped > 0 ? `. ${c.skipped} skipped` : ""}
            </p>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <div className="h-full rounded-full bg-foreground transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${share}%` }} />
            </div>
            {run.proofs > 0 && (
              <p className="tnum mt-3 text-[12.5px] text-mute">
                {proofsText(run.proofs)} sent{feesPaid > 0n ? `, Gloam's fee ${starkAmount(feesPaid, token)} ${token.symbol}` : ""}
              </p>
            )}
            {running && (
              <SolanaSteps
                className="mt-5"
                task={{ kind: "pay", steps: [stopping ? "Pausing after this proof" : "Paying privately"], at: 0, detail: detail ?? undefined }}
              />
            )}
            {run.error && !running && (
              <p role="alert" className="mt-4 rounded-[16px] bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
                {run.error}
              </p>
            )}
            {run.inflight && !running && (
              <p className="mt-4 text-[12.5px] leading-relaxed text-mute">The last proof may still be landing. Resume checks it on {STARKNET_NAME} before anything else is sent.</p>
            )}
            <div className="mt-5 space-y-2">
              {running ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-block"
                  disabled={stopping}
                  onClick={() => {
                    stopRef.current = true;
                    setStopping(true);
                  }}
                >
                  {stopping ? "Pausing after this proof" : "Pause after this proof"}
                </button>
              ) : !done ? (
                <>
                  <button type="button" className="btn btn-ink btn-lg btn-block" disabled={!relayFunded} onClick={() => void execute(run)}>
                    Resume
                  </button>
                  {relayNote && <p className="text-[12.5px] text-warn">{relayNote}</p>}
                </>
              ) : null}
              <button type="button" className="btn btn-ghost btn-block" onClick={() => exportRun(run)}>
                Download results
              </button>
              {done && (
                <button
                  type="button"
                  className="btn btn-quiet btn-block"
                  onClick={() => {
                    setLastDone(run);
                    setRun(null);
                  }}
                >
                  New run
                </button>
              )}
              {!running && !done && !run.inflight && (
                <button type="button" className={`btn btn-quiet btn-block ${closing ? "text-warn" : ""}`} onClick={() => (closing ? void close(run) : setClosing(true))}>
                  {closing ? `Close it. ${people(c.toPay)} won't be paid` : "Close this run"}
                </button>
              )}
            </div>
            <Status error={error} />
          </section>
        </aside>
      </div>
    );
  }

  // A new run.
  const can = relayFunded && balance !== null && !pending.length && !checkError && summary.ready > 0 && summary.short === 0n && starting === null && !parsed.error;
  const use = have > 0n ? Math.min(100, Number(((summary.total + summary.fees) * 100n) / have)) : summary.total > 0n ? 100 : 0;
  const showList = Boolean(text) || pasteOpen;

  return (
    <div className="grid max-lg:gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
      <div className="min-w-0 space-y-5">
        {sched.list && !loaded && <StarknetDueLine schedules={sched.list} today={today} token={token} onLoad={loadSchedule} />}
        <section className="gl-card max-sm:p-5 sm:p-6">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[17px] text-foreground">Pay in</h2>
            <p className="text-[13px] text-mute max-sm:hidden">Comes out of your private balance</p>
          </div>
          <div className="mt-4 flex h-14 w-fit items-center gap-3 rounded-full border border-foreground bg-panel pl-2 pr-5 shadow-card">
            <TokenLogo id="usdc" symbol={token.symbol} size={38} />
            <span className="min-w-0">
              <span className="block text-[14px] font-medium leading-tight text-foreground">{token.symbol}</span>
              <span className="tnum mt-0.5 block text-[12px] leading-tight text-mute">
                {balance === null ? "Reading your balance" : balance > 0n ? `${starkAmount(balance, token)} private` : "No private balance"}
              </span>
            </span>
          </div>
        </section>

        <section className="gl-card max-sm:p-5 sm:p-6">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <h2 className="text-[17px] text-foreground">Your team</h2>
            <button type="button" onClick={() => download("gloam-starknet-payroll-template.csv", TEMPLATE)} className="btn btn-quiet btn-sm -mr-3 text-mute hover:text-foreground">
              <DownloadGlyph />
              Template
            </button>
          </div>

          {showList ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`rounded-[16px] border border-dashed p-3 transition-colors ${dragging ? "border-foreground bg-surface" : "border-line-strong bg-surface/50"}`}
            >
              <label htmlFor="sn-payroll-list" className="text-[13px] text-mute">
                {fileName ? fileName : "Paste a list or drop a CSV: name, address, amount"}
              </label>
              <textarea
                id="sn-payroll-list"
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
                  Choose a file
                </button>
                <button
                  type="button"
                  className="btn btn-quiet btn-sm h-10"
                  onClick={() => {
                    setText("");
                    setFileName(null);
                    setPasteOpen(false);
                    setLoaded(null);
                  }}
                >
                  Clear
                </button>
              </div>
            </div>
          ) : (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`flex flex-col items-center justify-center rounded-[16px] border border-dashed px-5 text-center transition-colors duration-200 max-sm:py-10 sm:py-12 ${
                dragging ? "border-foreground bg-surface" : "border-line-strong bg-surface/50"
              }`}
            >
              <UploadGlyph className="h-6 w-6 text-foreground" />
              <p className="mt-3 text-[17px] text-foreground">{dragging ? "Drop it here" : "Drop your team’s CSV"}</p>
              <p className="mt-1.5 max-w-[42ch] text-[13.5px] leading-relaxed text-mute">
                One line per person, up to {PAYROLL_MAX_ROWS}. Each one needs a Gloam private account on {STARKNET_NAME}
                {links ? ", or leave the address empty to pay them by claim link." : "."}
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5" aria-label="Columns">
                {["name", "address", "amount"].map((c) => (
                  <span key={c} className="inline-flex h-7 items-center rounded-full bg-panel px-3 text-[12px] text-soft shadow-card">
                    {c}
                  </span>
                ))}
              </div>
              <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                <button type="button" onClick={() => fileRef.current?.click()} className="btn btn-ink btn-sm h-10">
                  Choose a file
                </button>
                <button type="button" onClick={() => setPasteOpen(true)} className="btn btn-quiet btn-sm h-10" aria-expanded={pasteOpen}>
                  <PasteGlyph />
                  Paste a list
                </button>
              </div>
            </div>
          )}
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
          {parsed.error && (
            <p role="alert" className="mt-3 text-[13px] leading-relaxed text-warn">
              {parsed.error}
            </p>
          )}
          {parsed.notesLeftOut && !parsed.error && <p className="mt-3 text-[12.5px] leading-relaxed text-mute">Payments on {STARKNET_NAME} carry no note, so the note column is left out.</p>}

          {rows.length > 0 && (
            <RowList>
              {rows.map((r) => {
                const waiting = !r.error && pending.includes(r.address);
                return (
                  <li key={r.line} className="flex items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-[14px] text-foreground">{r.name}</p>
                      <p className="tnum truncate text-[12px] text-mute">{r.link ? "Claim link" : r.address ? shortStark(r.address) : `Line ${r.line}`}</p>
                      {r.error && <p className="mt-0.5 text-[12px] leading-snug text-warn">{r.error}</p>}
                      {!r.error && r.note && <p className="mt-0.5 text-[12px] leading-snug text-mute">{r.note}</p>}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="tnum text-[14px] text-foreground">{r.amount !== null ? `${starkAmount(r.amount, token)} ${token.symbol}` : r.amountInput}</span>
                      {r.error ? (
                        <StatusChip status="skipped" />
                      ) : waiting ? (
                        <StatusChip status="checking" />
                      ) : r.first ? (
                        <span className="inline-flex h-6 items-center rounded-full bg-surface px-2.5 text-[12px] font-medium text-soft">First payment</span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </RowList>
          )}
          {checkError && (
            <p className="mt-3 text-[13px] text-warn">
              {checkError}{" "}
              <button type="button" className="inline-flex min-h-10 items-center underline underline-offset-2" onClick={() => setCheckTick((n) => n + 1)}>
                Try again
              </button>
            </p>
          )}
        </section>
        {sched.list && (
          <StarknetScheduleList schedules={sched.list} today={today} token={token} loadedId={loaded?.id ?? null} onLoad={loadSchedule} onSave={sched.save} onRemove={sched.remove} />
        )}
        {sched.error && <p className="px-1 text-[12.5px] text-warn">{sched.error}</p>}
      </div>

      <aside className="min-w-0 space-y-5">
        <section className="gl-card max-sm:p-5 sm:p-6">
          <h2 className="text-[17px] text-foreground">This run</h2>
          <p className="tnum mt-4 flex items-center gap-2.5 text-[34px] font-light leading-none tracking-[-0.02em] text-foreground">
            {starkAmount(summary.total, token)}
            <TokenLogo id="usdc" symbol={token.symbol} size={26} />
          </p>
          <p className="tnum mt-2 text-[13.5px] text-mute">
            {summary.ready > 0 ? `${people(summary.ready)}${summary.skipped ? `, ${summary.skipped} skipped` : ""}` : "Add your team to see the total"}
          </p>
          <CostBox token={token} fee={fee} proofs={summary.ready > 0 ? summary.proofs : 0} fees={summary.fees} links={summary.links} />
          <div className="mt-3 rounded-[16px] bg-surface p-4">
            <div className="flex items-baseline justify-between gap-3 text-[13.5px]">
              <span className="text-mute">Private balance</span>
              <span className="tnum text-foreground">
                {balance === null ? "..." : starkAmount(have, token)} {token.symbol}
              </span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <div className={`h-full rounded-full ${summary.short > 0n ? "bg-warn" : "bg-foreground"}`} style={{ width: `${use}%` }} />
            </div>
            <p className={`mt-3 text-[12.5px] leading-relaxed ${summary.short > 0n ? "text-warn" : "text-mute"}`}>
              {summary.short > 0n ? `${starkAmount(summary.short, token)} ${token.symbol} short with Gloam's fee. Add more first.` : "Payments and the fee come out of your private balance."}
            </p>
          </div>
          <PrivacyLines first={summary.first} proofs={summary.proofs} links={summary.links} />
          {relayNote && <p className="mt-3 text-[12.5px] leading-relaxed text-warn">{relayNote}</p>}
          <button
            type="button"
            className="btn btn-ink btn-lg btn-block mt-5"
            aria-busy={starting !== null || pending.length > 0 || undefined}
            disabled={!can && starting === null && !pending.length}
            onClick={() => can && void start()}
          >
            {starting !== null ? (
              <>
                <Spinner />
                {starting === 0 ? "Reading your private balance" : "Saving the run"}
              </>
            ) : pending.length ? (
              <>
                <Spinner />
                Checking accounts
              </>
            ) : summary.ready ? (
              `Pay ${people(summary.ready)} privately`
            ) : (
              "Pay privately"
            )}
          </button>
          {rows.length === 0 && starting === null && <p className="mt-2.5 text-center text-[12.5px] text-mute">Add your team first, from a CSV or a pasted list.</p>}
          {starting !== null && <SolanaSteps className="mt-4" task={{ kind: "pay", steps: ["Reading your private balance", "Saving the run", "Paying privately"], at: starting }} />}
          <Status error={error} />
          {sched.list && !loaded && summary.ready > 0 && !pending.length && <StarknetScheduleSave today={today} count={summary.ready} onSave={saveSchedule} />}
          {loaded && (
            <p className="mt-3 text-[12.5px] leading-relaxed text-mute">
              {loaded.payday ? "This pays the schedule's payday. Check the list, then pay." : "No payday is owed yet. Paying now doesn't count as one."}
            </p>
          )}
          {lastDone && (
            <button type="button" className="btn btn-quiet btn-sm mt-3 h-10 w-full text-mute" onClick={() => exportRun(lastDone)}>
              Download your last run&apos;s results
            </button>
          )}
        </section>
      </aside>
    </div>
  );
}

/** What the run costs: proofs and Gloam's fee on each, before anything is sent. */
function CostBox({ token, fee, proofs, fees, links }: { token: StarknetToken; fee: bigint; proofs: number; fees: bigint; links: number }) {
  return (
    <dl className="tnum mt-5 space-y-2 rounded-[16px] border border-line p-4 text-[13.5px]">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-mute">Proofs</dt>
        <dd className="text-foreground">{proofs > 0 ? `About ${proofs}${links > 0 ? `, ${links} more when claimed` : ""}` : "None yet"}</dd>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-mute">Gloam&apos;s fee</dt>
        <dd className="text-foreground">
          {fee > 0n ? (proofs > 0 ? `${starkAmount(fees, token)} ${token.symbol}` : `${starkAmount(fee, token)} ${token.symbol} a proof`) : "None"}
        </dd>
      </div>
      {fee > 0n && proofs > 0 && (
        <p className="pt-1 text-[12px] leading-relaxed text-mute">
          {starkAmount(fee, token)} {token.symbol} a proof. One proof pays many people at once.
          {links > 0 ? " A claim link adds it twice: to open the link, and for its claim, so they get the whole amount." : ""}
        </p>
      )}
    </dl>
  );
}

/** What a run shows on Starknet, said once, and the daily limit on proofs when a run needs a few. */
function PrivacyLines({ first, proofs, links }: { first: number; proofs: number; links: number }) {
  return (
    <div className="mt-4 space-y-2 text-[12.5px] leading-relaxed text-mute">
      <p>Nobody can see who you paid or how much. Each proof shows how many payments it carries and Gloam&apos;s fee.</p>
      {links > 0 && <p>{LINK_PRIVACY_NOTE}</p>}
      {first > 0 && (
        <p>
          {first === 1
            ? "One person is paid here for the first time, so their private account shows."
            : `${first} people are paid here for the first time, so their private accounts show, together when they share a proof.`}
        </p>
      )}
      {proofs >= 3 && <p>{STARKNET_NAME} proofs are limited each day, so a long run may finish tomorrow. It picks up where it stopped.</p>}
    </div>
  );
}

/** A paid claim link's Copy, in the run's list. */
function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="mt-1 inline-flex h-8 items-center rounded-full px-0 text-[12.5px] text-foreground underline-offset-2 hover:underline"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(url)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          })
          .catch(() => {});
      }}
    >
      {copied ? "Copied" : "Copy claim link"}
    </button>
  );
}

function RowList({ children }: { children: ReactNode }) {
  return <ul className="mt-4 max-h-[460px] divide-y divide-line overflow-y-auto overscroll-contain border-y border-line pr-2">{children}</ul>;
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
      {busy && <Spinner className="h-3 w-3" />}
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
