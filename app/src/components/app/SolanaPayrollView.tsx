"use client";

/**
 * Payroll on Solana, laid out as EVM payroll is: what to pay in and the team
 * on the left, this run's total, the private balance and the one action on
 * the right. Paste or upload a list, check every row, then pay it privately
 * through Gloam's relay, up to 15 people per transaction
 * (lib/solanaRings/payroll). A run is saved in this browser before each batch
 * is sent, so a closed tab resumes where it stopped without paying anyone
 * twice. The account comes from SolanaAccount (its payroll engine).
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { RINGS_PAYROLL_NOTE, ringsAssets, ringsExplorerTx, shownAssets } from "@/lib/solanaRings/config";
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
import { claimLinkUrl, encodeClaim, newClaim } from "@/lib/solanaRings/claimLink";
import { Spinner } from "@/components/ui/Spinner";
import { TokenLogo } from "./TokenLogo";
import { formatSolAmount, useSolana, type SolanaPayrollEngine } from "./SolanaAccount";
import { SolanaGate, SolanaSteps, preferredAsset, useSolanaUsd, usd } from "./SolanaParts";

const storeLib = () => import("@/lib/solanaRings/payrollStore");

// a blank address gets a claim link, as on the other chains
const TEMPLATE = "name,address,amount\nAda Obi,PASTE_THEIR_SOLANA_PRIVATE_ADDRESS,250\nTunde Bello,,180";

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

function fmt(v: bigint, decimals: number): string {
  return formatSolAmount(v, decimals);
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

function UploadGlyph({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The clipboard on "Paste a list", as EVM Payroll draws it. */
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

/** Payroll on Solana: the connect card until the private account is open. */
export function SolanaPayrollPage() {
  const sol = useSolana();
  if (!sol) return null;
  if (!sol.address || !sol.payroll) return <SolanaGate />;
  return (
    <SolanaPayrollView
      engine={sol.payroll}
      balances={sol.balances ?? {}}
      ready={sol.ready}
      relayFunded={sol.relay?.funded !== false}
      onBalances={sol.setBalances}
    />
  );
}

export function SolanaPayrollView(props: {
  engine: SolanaPayrollEngine;
  /** Private balances in base units, by asset id. */
  balances: Record<string, bigint>;
  /** Which assets are set up on chain, by asset id. */
  ready: Record<string, boolean>;
  relayFunded: boolean;
  onBalances: (b: Record<string, bigint>) => void;
}) {
  const { engine, balances, ready, relayFunded, onBalances } = props;
  const toUsd = useSolanaUsd();
  // ZEC shows once it is set up (config shownAssets), or while some is held privately
  const assets = shownAssets(ready, engine.network, balances);
  const [store, setStore] = useState<PayrollStore | null>(null);
  const [run, setRun] = useState<PayrollRun | null>(null);
  const [lastDone, setLastDone] = useState<PayrollRun | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [assetId, setAssetId] = useState(() => preferredAsset(balances, assets).id);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [registry, setRegistry] = useState<Map<string, boolean>>(() => new Map());
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkTick, setCheckTick] = useState(0);
  const [running, setRunning] = useState(false);
  /** 0 reading the balance, 1 saving the run; null when not starting. */
  const [starting, setStarting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const stopRef = useRef(false);
  const [stopping, setStopping] = useState(false);

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

  const asset = assets.find((a) => a.id === assetId) ?? assets[0]!;
  const parsed = parseSolanaPayrollCsv(text, asset);
  const pending = addressesToCheck(parsed.rows, registry);
  const rows = pending.length ? parsed.rows : checkRecipients(parsed.rows, registry, engine.owner);
  const summary = summarize(rows, balances[asset.id] ?? 0n);

  // Each new address is read once from the registry: can it be paid privately?
  const pendingKey = pending.join(",");
  useEffect(() => {
    if (!pendingKey) return;
    let live = true;
    const t = setTimeout(() => {
      setCheckError(null);
      void engine
        .registeredMany(pendingKey.split(","))
        .then((found) => {
          if (live) setRegistry((m) => new Map([...m, ...found]));
        })
        .catch(() => live && setCheckError("Couldn't check the addresses on Solana."));
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
      const runAsset = ringsAssets(engine.network).find((a) => a.id === start.asset);
      if (!runAsset) return setError("This run pays an asset Gloam no longer lists here.");
      const deps = await engine.deps(runAsset);
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
          // The stored copy is the truth: another tab may have paid part of it since this one loaded.
          const fresh = (await store.load()).find((r) => r.id === start.id) ?? start;
          setRun({ ...fresh });
          const done = await runPayroll(fresh, {
            ...deps,
            save: (x) => store.save(x),
            sleep,
            now: () => Date.now(),
            stopRequested: () => stopRef.current,
            onChange: (x) => setRun({ ...x, rows: [...x.rows] }),
          });
          setRun({ ...done, rows: [...done.rows] });
        } catch (e) {
          if (process.env.NODE_ENV !== "production") console.error("solana payroll:", e);
          setError(await engine.message(e));
        } finally {
          setRunning(false);
          setStopping(false);
          onBalances(engine.balances());
        }
      });
      if (!ok) setError("This run is paying in another tab. Use that tab, or close it and resume here.");
    },
    [store, engine, onBalances]
  );

  async function start() {
    if (!store || running || starting !== null) return;
    setError(null);
    setStarting(0);
    try {
      const now = await engine.sync();
      onBalances(now);
      const fresh = summarize(rows, now[asset.id] ?? 0n);
      if (fresh.short > 0n) {
        setError(`Your private balance is ${fmt(fresh.short, asset.decimals)} ${asset.symbol} short. Add more first.`);
        return;
      }
      // A claim link for each row with no address, made now and saved with the run before anything is paid.
      const withLinks = await Promise.all(
        rows.map(async (row) => {
          if (!row.link || row.error || row.amount === null) return row;
          const linkBody = encodeClaim(newClaim(engine.network, asset, row.amount));
          return { ...row, linkBody, address: await engine.claimAddress(linkBody) };
        })
      );
      const r = freshRun({ network: engine.network, owner: engine.owner, asset: asset.id, rows: withLinks });
      setStarting(1);
      await store.save(r);
      setRun(r);
      setText("");
      setFileName(null);
      setStarting(null);
      await execute(r);
    } catch (e) {
      setError(await engine.message(e));
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

  function exportRun(r: PayrollRun) {
    const a = ringsAssets(r.network).find((x) => x.id === r.asset);
    if (!a) return;
    download(`gloam-solana-payroll-${new Date(r.createdAt).toISOString().slice(0, 10)}.csv`, resultsCsv(r, a, (b) => claimLinkUrl(b, window.location.origin)));
  }

  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
    } catch {
      setError("Could not copy in this browser.");
    }
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
      <div className="grid max-lg:gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6" aria-busy="true">
        <div className="gl-card h-[420px] motion-safe:animate-pulse" />
        <div className="gl-card h-[320px] motion-safe:animate-pulse" />
      </div>
    );
  }

  // A run: watch it, resume it, download it.
  if (run) {
    const runAsset = ringsAssets(run.network).find((a) => a.id === run.asset);
    const c = runCounts(run);
    const decimals = runAsset?.decimals ?? 0;
    const symbol = runAsset?.symbol ?? "";
    const done = run.state === "done" && !runOpen(run);
    const of = c.paid + c.toPay + c.unknown;
    const links = run.rows.filter((r) => r.link && r.status === "paid");
    const share = of > 0 ? Math.round((c.paid / of) * 100) : 0;
    return (
      <div className="grid max-lg:gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
        <section className="gl-card min-w-0 max-sm:p-5 sm:p-6">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[17px] text-foreground">{done ? "Payroll done" : "This payroll"}</h2>
            <span className="tnum text-[13px] text-mute">{people(run.rows.length)}</span>
          </div>
          <RowList>
            {run.rows.map((r, i) => (
              <li key={i} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[14px] text-foreground">{r.name}</p>
                  {r.link ? <p className="text-[12px] text-mute">Claim link</p> : <p className="truncate font-mono text-[12px] text-mute">{short(r.address)}</p>}
                  {r.reason && r.status !== "paid" && <p className="mt-0.5 text-[12px] leading-snug text-warn">{r.reason}</p>}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="tnum text-[14px] text-foreground">{r.status === "skipped" ? "" : `${fmt(BigInt(r.amount), decimals)} ${symbol}`}</span>
                  <span className="flex items-center gap-1">
                    {r.status === "paid" && r.link && (
                      <button
                        type="button"
                        onClick={() => void copy(`row-${i}`, claimLinkUrl(r.link!, window.location.origin))}
                        className="inline-flex h-6 items-center rounded-full px-2 text-[12px] text-mute underline-offset-2 hover:text-foreground hover:underline"
                      >
                        {copied === `row-${i}` ? "Copied" : "Copy link"}
                      </button>
                    )}
                    {r.status === "paid" && r.signature && (
                      <a
                        href={ringsExplorerTx(r.signature, run.network)}
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
            ))}
          </RowList>
        </section>

        <aside className="min-w-0 space-y-5">
          <section className="gl-card max-sm:p-5 sm:p-6">
            <h2 className="text-[17px] text-foreground">This run</h2>
            <p className="tnum mt-4 flex items-center gap-2.5 text-[34px] font-light leading-none tracking-[-0.02em] text-foreground">
              {fmt(c.paidAmount, decimals)}
              {runAsset && <TokenLogo id={runAsset.id} symbol={symbol} size={26} />}
            </p>
            <p className="tnum mt-2 text-[13.5px] text-mute">
              Paid {c.paid} of {of}, of {fmt(c.total, decimals)} {symbol}
              {c.skipped > 0 ? `. ${c.skipped} skipped` : ""}
            </p>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <div className="h-full rounded-full bg-foreground transition-[width] duration-500" style={{ width: `${share}%` }} />
            </div>
            {running && (
              <SolanaSteps className="mt-5" task={{ kind: "pay", steps: [stopping ? "Pausing after this batch" : "Paying in batches of up to 15"], at: 0 }} />
            )}
            {run.error && !running && (
              <p role="alert" className="mt-4 rounded-[16px] bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
                {run.error}
              </p>
            )}
            {run.inflight && !running && (
              <p className="mt-4 text-[12.5px] leading-relaxed text-mute">The last batch may still be landing. Resume checks it on Solana before anything else is sent.</p>
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
                  {stopping ? "Pausing after this batch" : "Pause after this batch"}
                </button>
              ) : !done ? (
                <>
                  <button type="button" className="btn btn-ink btn-lg btn-block" disabled={!relayFunded} onClick={() => void execute(run)}>
                    Resume
                  </button>
                  {!relayFunded && <p className="text-[12.5px] text-warn">Private payments on Solana are paused for a moment. Try again later.</p>}
                </>
              ) : null}
              {!running && links.length > 0 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-block"
                  onClick={() => void copy("all", links.map((r) => `${r.name}: ${claimLinkUrl(r.link!, window.location.origin)}`).join("\n"))}
                >
                  {copied === "all" ? "Copied" : `Copy ${links.length} claim ${links.length === 1 ? "link" : "links"}`}
                </button>
              )}
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
            {done && links.length > 0 && (
              <p className="mt-4 border-t border-line pt-4 text-[12.5px] leading-relaxed text-mute">Claim links work like cash. Send each one only to its person.</p>
            )}
            <Status error={error} />
          </section>
        </aside>
      </div>
    );
  }

  // A new run.
  const setUp = ready[asset.id] !== false;
  const can = setUp && relayFunded && !pending.length && !checkError && summary.ready > 0 && summary.short === 0n && starting === null && !parsed.error;
  const have = balances[asset.id] ?? 0n;
  const use = have > 0n ? Math.min(100, Number((summary.total * 100n) / have)) : summary.total > 0n ? 100 : 0;
  const totalUsd = summary.total > 0n ? toUsd(asset.id, summary.total) : null;
  const showList = Boolean(text) || pasteOpen;

  return (
    <div className="grid max-lg:gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
      <div className="min-w-0 space-y-5">
        <section className="gl-card max-sm:p-5 sm:p-6">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[17px] text-foreground">Pay in</h2>
            <p className="text-[13px] text-mute max-sm:hidden">Comes out of your private balance</p>
          </div>
          <div className="mt-4 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] max-sm:-mx-5 max-sm:px-5 sm:flex-wrap [&::-webkit-scrollbar]:hidden" role="radiogroup" aria-label="Currency">
            {assets.map((a) => {
              const selected = a.id === assetId;
              const b = balances[a.id] ?? 0n;
              return (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setAssetId(a.id)}
                  className={`flex h-14 shrink-0 items-center gap-3 rounded-full border pl-2 pr-5 text-left transition-[border-color,box-shadow,background-color] duration-200 ${
                    selected ? "border-foreground bg-panel shadow-card" : "border-line bg-panel hover:border-line-strong hover:bg-surface"
                  }`}
                >
                  <TokenLogo id={a.id} symbol={a.symbol} size={38} />
                  <span className="min-w-0">
                    <span className="block text-[14px] font-medium leading-tight text-foreground">{a.symbol}</span>
                    <span className="tnum mt-0.5 block text-[12px] leading-tight text-mute">
                      {ready[a.id] === false ? "Not set up yet" : b > 0n ? `${fmt(b, a.decimals)} private` : "No private balance"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="gl-card max-sm:p-5 sm:p-6">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <h2 className="text-[17px] text-foreground">Your team</h2>
            <button type="button" onClick={() => download("gloam-solana-payroll-template.csv", TEMPLATE)} className="btn btn-quiet btn-sm -mr-3 text-mute hover:text-foreground">
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
                  Choose a file
                </button>
                <button
                  type="button"
                  className="btn btn-quiet btn-sm h-10"
                  onClick={() => {
                    setText("");
                    setFileName(null);
                    setPasteOpen(false);
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
                One line per person, up to {PAYROLL_MAX_ROWS}. Put their Gloam private address on Solana, or leave it blank and they get a claim link instead.
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

          {rows.length > 0 && (
            <RowList>
              {rows.map((r) => {
                const waiting = !r.error && pending.includes(r.address);
                return (
                  <li key={r.line} className="flex items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-[14px] text-foreground">{r.name}</p>
                      {r.link ? (
                        <p className="text-[12px] text-mute">Claim link, you share it after the run</p>
                      ) : (
                        <p className="truncate font-mono text-[12px] text-mute">{r.address ? short(r.address) : `Line ${r.line}`}</p>
                      )}
                      {r.error && <p className="mt-0.5 text-[12px] leading-snug text-warn">{r.error}</p>}
                      {!r.error && r.note && <p className="mt-0.5 text-[12px] leading-snug text-mute">{r.note}</p>}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="tnum text-[14px] text-foreground">{r.amount !== null ? `${fmt(r.amount, asset.decimals)} ${asset.symbol}` : r.amountInput}</span>
                      {r.error ? <StatusChip status="skipped" /> : waiting ? <StatusChip status="checking" /> : null}
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
      </div>

      <aside className="min-w-0 space-y-5">
        <section className="gl-card max-sm:p-5 sm:p-6">
          <h2 className="text-[17px] text-foreground">This run</h2>
          <p className="tnum mt-4 flex items-center gap-2.5 text-[34px] font-light leading-none tracking-[-0.02em] text-foreground">
            {fmt(summary.total, asset.decimals)}
            <TokenLogo id={asset.id} symbol={asset.symbol} size={26} />
          </p>
          <p className="tnum mt-2 text-[13.5px] text-mute">
            {summary.ready > 0
              ? `${people(summary.ready)}${summary.skipped ? `, ${summary.skipped} skipped` : ""}${totalUsd != null ? `, about ${usd(totalUsd)}` : ""}`
              : "Add your team to see the total"}
          </p>
          <div className="mt-5 rounded-[16px] bg-surface p-4">
            <div className="flex items-baseline justify-between gap-3 text-[13.5px]">
              <span className="text-mute">Private balance</span>
              <span className="tnum text-foreground">
                {fmt(have, asset.decimals)} {asset.symbol}
              </span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <div className={`h-full rounded-full ${summary.short > 0n ? "bg-warn" : "bg-foreground"}`} style={{ width: `${use}%` }} />
            </div>
            <p className={`mt-3 text-[12.5px] leading-relaxed ${summary.short > 0n ? "text-warn" : "text-mute"}`}>
              {summary.short > 0n
                ? `${fmt(summary.short, asset.decimals)} ${asset.symbol} short. Add more first.`
                : "Payments come out of your private balance."}
            </p>
          </div>
          <p className="mt-4 text-[12.5px] leading-relaxed text-mute">{RINGS_PAYROLL_NOTE}</p>
          {!setUp && <p className="mt-3 text-[12.5px] text-warn">{asset.symbol} is not set up on Gloam yet.</p>}
          {!relayFunded && <p className="mt-3 text-[12.5px] leading-relaxed text-warn">Private payments on Solana are paused for a moment. Try again later.</p>}
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
                Checking addresses
              </>
            ) : summary.ready ? (
              `Pay ${people(summary.ready)} privately`
            ) : (
              "Pay privately"
            )}
          </button>
          {/* why it is greyed out, in the words EVM Payroll uses */}
          {rows.length === 0 && starting === null && (
            <p className="mt-2.5 text-center text-[12.5px] text-mute">Add your team first, from a CSV or a pasted list.</p>
          )}
          {starting !== null && (
            <SolanaSteps className="mt-4" task={{ kind: "pay", steps: ["Reading your private balance", "Saving the run", "Paying in batches of up to 15"], at: starting }} />
          )}
          <Status error={error} />
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
