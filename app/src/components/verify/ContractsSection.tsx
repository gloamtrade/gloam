"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { SealedField } from "@/components/ui/SealedField";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { liveMainnetNames } from "@/lib/mainnet";
import { publicClientFor } from "@/lib/rhClient";
import type { ChainFamily, NetworkKey } from "@/lib/networks";
import {
  chainRows,
  contractDirectory,
  csvFileName,
  directoryCsv,
  explorerBlock,
  readVault,
  vaultChecks,
  type DirectoryEntry,
  type DirectoryRow,
  type VaultRead,
} from "@/lib/contractDirectory";
import { CheckMark, CopyButton, ExplorerLink } from "./VerifyBits";

/**
 * /verify#contracts: every address behind Gloam, one network at a time, with
 * what its vault says right now and a CSV of the lot. The list is the app's
 * own network data (lib/contractDirectory), so a mainnet joins the moment its
 * pool is filled in; until then it shows as next.
 */

const GITHUB = "https://github.com/gloamtrade/gloam";
const ENTRIES = contractDirectory();
const READ_TIMEOUT_MS = 20_000;

const LOGOS: Record<ChainFamily, string> = {
  robinhood: "/brand/chains/4663.png",
  tempo: "/brand/logos/tempo.svg",
  base: "/brand/chains/8453.png",
  ethereum: "/brand/chains/1.png",
  // A plain stand-in until Elysium's own mark is added (DEPLOY-ELYSIUM.md)
  elysium: "/brand/chains/elysium.svg",
};

type Side = "mainnet" | "testnet";
const SIDES: { side: Side; label: string }[] = [
  { side: "mainnet", label: "Mainnets" },
  { side: "testnet", label: "Testnets" },
];

type ReadState = { status: "done"; read: VaultRead } | { status: "error" };

function firstOn(side: Side): DirectoryEntry {
  const on = ENTRIES.filter((e) => e.kind === side);
  return on.find((e) => e.live) ?? on[0]!;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** The vault reads, one per network, shared by the card and the CSV. */
function useVaultReads() {
  const [reads, setReads] = useState<Partial<Record<NetworkKey, ReadState>>>({});
  const done = useRef<Partial<Record<NetworkKey, VaultRead>>>({});
  const inflight = useRef(new Map<NetworkKey, Promise<VaultRead | null>>());

  /** Reads one network's vault once; a second call while it runs waits on the same read. */
  const load = useCallback((e: DirectoryEntry): Promise<VaultRead | null> => {
    const hit = done.current[e.key];
    if (hit) return Promise.resolve(hit);
    const running = inflight.current.get(e.key);
    if (running) return running;
    const p = withTimeout(readVault(e.network, publicClientFor(e.network)), READ_TIMEOUT_MS)
      .then((read) => {
        done.current[e.key] = read;
        setReads((s) => ({ ...s, [e.key]: { status: "done", read } }));
        return read;
      })
      .catch(() => {
        setReads((s) => ({ ...s, [e.key]: { status: "error" } }));
        return null;
      })
      .finally(() => inflight.current.delete(e.key));
    inflight.current.set(e.key, p);
    return p;
  }, []);

  /** After a failed read: back to reading. Called from a click. */
  const retry = useCallback(
    (e: DirectoryEntry) => {
      setReads((s) => {
        const next = { ...s };
        delete next[e.key];
        return next;
      });
      void load(e);
    },
    [load]
  );

  return { reads, done, load, retry };
}

/* ---------------------------------------------------------------- pieces */

function SideSwitch({ value, onChange }: { value: Side; onChange: (s: Side) => void }) {
  const refs = useRef<Partial<Record<Side, HTMLButtonElement | null>>>({});
  function onKey(e: KeyboardEvent<HTMLButtonElement>) {
    const i = SIDES.findIndex((s) => s.side === value);
    let j = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") j = (i + 1) % SIDES.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") j = (i - 1 + SIDES.length) % SIDES.length;
    if (j < 0) return;
    e.preventDefault();
    onChange(SIDES[j]!.side);
    refs.current[SIDES[j]!.side]?.focus();
  }
  return (
    <div role="radiogroup" aria-label="Mainnets or testnets" className="flex w-full rounded-full bg-panel p-1 ring-1 ring-line sm:w-auto">
      {SIDES.map((s) => {
        const on = s.side === value;
        return (
          <button
            key={s.side}
            ref={(el) => {
              refs.current[s.side] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(s.side)}
            onKeyDown={onKey}
            className={`h-10 flex-1 rounded-full px-5 text-[14px] font-medium transition-colors duration-200 sm:flex-none ${
              on ? "bg-foreground text-background" : "text-mute hover:text-foreground"
            }`}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

function ChainChoice({ entries, value, onChange }: { entries: DirectoryEntry[]; value: NetworkKey; onChange: (k: NetworkKey) => void }) {
  return (
    <div role="group" aria-label="Network" className="flex flex-wrap gap-2">
      {entries.map((e) => {
        const on = e.key === value;
        return (
          <button
            key={e.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(e.key)}
            className={`inline-flex h-10 items-center gap-2 rounded-full border pl-1.5 pr-3.5 text-[13.5px] font-medium transition-colors duration-200 ${
              on
                ? "border-foreground bg-panel text-foreground"
                : "border-line bg-panel text-soft hover:border-line-strong hover:text-foreground"
            }`}
          >
            <Image src={LOGOS[e.network.family]} alt="" width={28} height={28} className="h-7 w-7 rounded-full ring-1 ring-line" />
            {e.network.label}
            {!e.live && <span className="text-[12px] font-normal text-mute">Next</span>}
          </button>
        );
      })}
    </div>
  );
}

function AddressRow({ entry, row }: { entry: DirectoryEntry; row: DirectoryRow }) {
  const n = entry.network;
  const block = row.deployBlock !== null ? explorerBlock(n, row.deployBlock) : null;
  return (
    <li className="px-5 py-4 sm:px-6">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.45fr)] lg:items-center lg:gap-8">
        <div className="min-w-0">
          <p className="text-[15px] text-foreground">
            {row.name}
            {row.contract && <span className="ml-2 text-[12.5px] text-mute">{row.contract}</span>}
          </p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-mute">{row.what}</p>
          {row.deployBlock !== null && (
            <p className="tnum mt-1 text-[12.5px] text-mute">
              Deploy block{" "}
              {block ? (
                <a href={block} target="_blank" rel="noreferrer" className="text-soft underline decoration-line-strong underline-offset-2 hover:text-foreground">
                  {row.deployBlock.toString()}
                </a>
              ) : (
                <span className="text-soft">{row.deployBlock.toString()}</span>
              )}
            </p>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center rounded-xl bg-surface py-1 pl-3.5 pr-1 sm:flex-nowrap sm:gap-1">
          <span
            className="tnum min-w-0 flex-1 basis-full break-all pb-1 pr-2 pt-2.5 text-[13.5px] leading-snug text-foreground sm:basis-auto sm:truncate sm:p-0"
            title={row.address}
          >
            {row.address}
          </span>
          <div className="-ml-3 flex shrink-0 items-center sm:ml-0">
            <CopyButton value={row.address} label={`${entry.name} ${row.name.toLowerCase()} address`} />
            <ExplorerLink href={n.explorerAddress(row.address)} label={`${entry.name} ${row.name.toLowerCase()} on the explorer`} />
          </div>
        </div>
      </div>
    </li>
  );
}

function WarnMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 8v5m0 3.5v.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function ChainRead({ entry, state, onRetry }: { entry: DirectoryEntry; state: ReadState | undefined; onRetry: () => void }) {
  return (
    <div className="border-t border-line">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-1 pt-5 sm:px-6">
        <p className="text-[14px] text-foreground">Read from the vault just now</p>
        <p className="text-[12.5px] text-mute">Straight from {entry.name}, not from Gloam</p>
      </div>
      <div aria-live="polite">
        {!state && (
          <ul className="space-y-3 px-5 py-4 sm:px-6" aria-label="Reading the vault">
            {[0, 1, 2].map((i) => (
              <li key={i} className="h-12 animate-pulse rounded-xl bg-surface motion-reduce:animate-none" />
            ))}
          </ul>
        )}
        {state?.status === "error" && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-6">
            <p className="max-w-[52ch] text-[13.5px] leading-relaxed text-soft">
              Could not reach {entry.name} just now. Public nodes sometimes slow down or limit requests.
            </p>
            <button type="button" onClick={onRetry} className="btn btn-ghost btn-sm min-h-10">
              Try again
            </button>
          </div>
        )}
        {state?.status === "done" && (
          <>
            <ul className="divide-y divide-line">
              {chainRows(entry.network, state.read).map((r) => (
                <AddressRow key={r.role} entry={entry} row={r} />
              ))}
            </ul>
            <ul className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-line px-5 py-5 sm:grid-cols-2 sm:px-6">
              {vaultChecks(entry.network, state.read).map((c) => (
                <li key={c.label} className="flex gap-2.5">
                  <span className={`mt-0.5 shrink-0 ${c.ok ? "text-sealed" : "text-warn"}`}>
                    {c.ok ? <CheckMark size={15} /> : <WarnMark />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[14px] text-foreground">
                      {c.label}
                      {!c.ok && <span className="sr-only"> (does not match)</span>}
                    </span>
                    <span className="block break-words text-[12.5px] leading-relaxed text-mute">{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function NetworkCard({ entry, state, onRetry }: { entry: DirectoryEntry; state: ReadState | undefined; onRetry: () => void }) {
  const n = entry.network;
  return (
    <div className="gl-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <Image src={LOGOS[n.family]} alt="" width={28} height={28} className="h-7 w-7 rounded-lg ring-1 ring-line" />
          <div>
            <p className="text-[16px] text-foreground">{entry.name}</p>
            <p className="tnum text-[12.5px] text-mute">
              {entry.kind === "mainnet" ? "Mainnet" : "Testnet"}, chain {n.chainId}
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-[12px] text-soft">
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${entry.live ? "bg-foreground/70" : "bg-faint"}`} />
          {entry.live ? "Live" : "Next"}
        </span>
      </div>
      {entry.live ? (
        <>
          <ul className="divide-y divide-line">
            {entry.rows.map((r) => (
              <AddressRow key={`${r.role}-${r.address}`} entry={entry} row={r} />
            ))}
          </ul>
          <ChainRead entry={entry} state={state} onRetry={onRetry} />
        </>
      ) : (
        <p className="max-w-[60ch] px-5 py-6 text-[14px] leading-relaxed text-soft sm:px-6">
          {entry.name} {entry.kind} is next. Its addresses show here once its vault is deployed and switched on in the
          app, read from the same list the app uses.
        </p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- the section */

type CsvState = { status: "idle" } | { status: "preparing" } | { status: "done"; missing: string[] } | { status: "failed" };

export function ContractsSection({ live }: { live: boolean }) {
  const [shown, setShown] = useState<NetworkKey>(() => firstOn(ENTRIES.some((e) => e.kind === "mainnet" && e.live) ? "mainnet" : "testnet").key);
  const entry = ENTRIES.find((e) => e.key === shown)!;
  const side: Side = entry.kind;
  const { reads, load, retry } = useVaultReads();
  const [inView, setInView] = useState(false);
  const [csv, setCsv] = useState<CsvState>({ status: "idle" });
  const sectionRef = useRef<HTMLElement | null>(null);

  // Read nothing until the list is near the screen: most visitors come to check a proof.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      const t = window.setTimeout(() => setInView(true), 0);
      return () => window.clearTimeout(t);
    }
    const io = new IntersectionObserver(
      (items) => {
        if (items.some((i) => i.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: "400px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!inView || !entry.live) return;
    const t = window.setTimeout(() => void load(entry), 0);
    return () => window.clearTimeout(t);
  }, [inView, entry, load]);

  async function downloadCsv() {
    setCsv({ status: "preparing" });
    try {
      const liveEntries = ENTRIES.filter((e) => e.live);
      const got = await Promise.all(liveEntries.map((e) => load(e)));
      const read: Partial<Record<NetworkKey, VaultRead>> = {};
      const missing: string[] = [];
      liveEntries.forEach((e, i) => {
        const r = got[i];
        if (r) read[e.key] = r;
        else missing.push(e.name);
      });
      const blob = new Blob([directoryCsv(ENTRIES, read)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = csvFileName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setCsv({ status: "done", missing });
    } catch {
      setCsv({ status: "failed" });
    }
  }

  return (
    <section ref={sectionRef} id="contracts" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 sm:px-7">
      <div className="gl-panel bg-surface px-5 py-14 sm:px-12 sm:py-20">
        <SealedField tone="soft" />
        <div className="relative mx-auto max-w-[1120px]">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-[640px]">
              <h2 className="t-display-l">The contracts</h2>
              <p className="mt-5 max-w-[54ch] text-[16px] leading-relaxed text-mute">
                {live ? (
                  <>
                    Gloam runs on {liveMainnetNames()} mainnet, and on the testnets. Every address here comes from the
                    list the app itself uses, and each vault is read on chain as you look. The source is on GitHub.
                  </>
                ) : (
                  <>
                    Every address here comes from the list the app itself uses, and each vault is read on chain as you
                    look. The source is on GitHub.
                  </>
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 self-start lg:self-auto">
              <button
                type="button"
                onClick={() => void downloadCsv()}
                disabled={csv.status === "preparing"}
                className="btn btn-ghost"
              >
                {csv.status === "preparing" ? "Reading the vaults…" : "Download CSV"}
              </button>
              <a href={`${GITHUB}/tree/main/contracts`} target="_blank" rel="noreferrer" className="btn btn-quiet">
                Read the source <ArrowUpRight />
              </a>
            </div>
          </div>
          <p aria-live="polite" className="mt-3 min-h-[1.25rem] text-[12.5px] text-mute lg:text-right">
            {csv.status === "done" &&
              (csv.missing.length
                ? `Downloaded. ${csv.missing.join(", ")} did not answer, so the file has their listed addresses but not what their vaults read. Try again for those.`
                : "Downloaded: every address on every network, with what each vault read just now.")}
            {csv.status === "failed" && "Could not make the file just now. Try again."}
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <SideSwitch value={side} onChange={(s) => setShown(firstOn(s).key)} />
            <ChainChoice entries={ENTRIES.filter((e) => e.kind === side)} value={shown} onChange={setShown} />
          </div>

          <div className="mt-5">
            <NetworkCard entry={entry} state={reads[entry.key]} onRetry={() => retry(entry)} />
          </div>
        </div>
      </div>
    </section>
  );
}
