"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useWriteContract } from "wagmi";
import type { Address, Hex } from "viem";
import { demoHistory, simulatePayroll, useAppAccount } from "@/lib/demo";
import { useNetwork } from "./NetworkProvider";
import { PayrollInvoice } from "./PayrollInvoice";
import { PaymentNoteLine } from "./PaymentNote";
import { DueBanner } from "./payroll/DueBanner";
import { ProveTotal } from "./payroll/ProveTotal";
import { ScheduleEditor } from "./payroll/ScheduleEditor";
import { ScheduleList } from "./payroll/ScheduleList";
import { ScheduleIcon } from "./payroll/scheduleUi";
import { useSchedules } from "./payroll/useSchedules";
import { RelayToggle } from "./RelayToggle";
import { TokenLogo } from "./TokenLogo";
import { SealDots } from "@/components/ui/SealDots";
import { SealedField } from "@/components/ui/SealedField";
import { useLocalShieldNotes } from "@/hooks/useLocalShieldNotes";
import { useShieldTree } from "@/hooks/useShieldTree";
import { getRhPublicClient, publicClientFor } from "@/lib/rhClient";
import { track } from "@/lib/track";
import { countPerson } from "@/lib/people";
import { addableTokensFor, isNativeAddable, shieldTokensFor } from "@/lib/tokens";
import { useOpenGatedTokens } from "@/hooks/useOpenGatedTokens";
import {
  NATIVE_ASSET,
  TRANSFER_GAS_LIMIT,
  activeSpendableNotes,
  assetDecimals,
  formatAssetAmount,
  formatAssetAmountExact,
  gasFor,
  shieldPoolAbi,
  SIGNED_OUT_BALANCE_MESSAGE,
  summaryDecimals,
} from "@/lib/shield";
import { MEMO_GAS_LIMIT, isPayMemoLive, payMemoAbi, payMemoAddress } from "@/lib/payMemo";
import {
  relayFor,
  relayMemo,
  relayPreferred,
  relayTransfer,
  setRelayPreferred,
  waitForTx,
  type RelayNetworkStatus,
} from "@/lib/relay/client";
import { gasHighMessage } from "@/lib/relay/gasCeiling";
import { RelayGasNotice } from "./RelayGasNotice";
import {
  PAYROLL_TEMPLATE,
  claimLink,
  deleteBatch,
  draftTotal,
  exportResultsCsv,
  fundingPlan,
  loadBatches,
  newBatch,
  parsePayrollCsv,
  runNetwork,
  runPayroll,
  saveBatch,
  withDemoProofRecords,
  type PayrollBatch,
  type PayrollRow,
  type PayrollRowStatus,
} from "@/lib/payroll";
import { holdsPendingPayment } from "@/lib/payrollStore";
import { walletErrorForPeople } from "@/lib/walletErrors";
import {
  cadenceLabel,
  dayLabel,
  isoDay,
  newSchedule,
  overCap,
  peopleFromBatch,
  peopleFromDraft,
  runTitle,
  scheduleCsv,
  scheduleState,
  sortSchedules,
  type PayrollSchedule,
} from "@/lib/payrollSchedule";

// ------------------------------------------------------------------ bits

const SECONDS_PER_PERSON = 8;
const ease = [0.22, 1, 0.36, 1] as const;

type AssetOption = { address: Address; symbol: string; logoId: string };

const STATUS_LABEL: Record<PayrollRowStatus, string> = {
  queued: "Waiting",
  preparing: "Preparing",
  sending: "Sending",
  confirming: "Confirming",
  notifying: "Letting them know",
  unconfirmed: "Still checking",
  paid: "Paid",
  failed: "Failed",
};

/** Where a busy row sits in its own four-step run (for the per-person ticks). */
const STEP_INDEX: Partial<Record<PayrollRowStatus, number>> = {
  preparing: 1,
  sending: 2,
  confirming: 3,
  notifying: 4,
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "·";
}

function short(tag: string) {
  return tag.length > 22 ? `${tag.slice(0, 12)}…${tag.slice(-6)}` : tag;
}

function people(n: number) {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

function minutes(n: number) {
  return Math.max(1, Math.round((n * SECONDS_PER_PERSON) / 60));
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-70 motion-reduce:animate-none ${className}`}
    />
  );
}

type IconName =
  | "file"
  | "link"
  | "shield"
  | "lock"
  | "check"
  | "alert"
  | "upload"
  | "x"
  | "download"
  | "paste"
  | "pause"
  | "arrow";

function Icon({ name, className = "h-4 w-4" }: { name: IconName; className?: string }) {
  const common = {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "file":
      return (
        <svg {...common}>
          <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
          <path d="M14 3v5h5M9 13h6M9 17h4" />
        </svg>
      );
    case "upload":
      return (
        <svg {...common}>
          <path d="M12 15V4M7.5 8.5L12 4l4.5 4.5" />
          <path d="M5 15v3a2 2 0 002 2h10a2 2 0 002-2v-3" />
        </svg>
      );
    case "download":
      return (
        <svg {...common}>
          <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5" />
          <path d="M5 17v1a2 2 0 002 2h10a2 2 0 002-2v-1" />
        </svg>
      );
    case "paste":
      return (
        <svg {...common}>
          <rect x="6" y="5" width="12" height="15" rx="2.5" />
          <path d="M9.5 5V4a1 1 0 011-1h3a1 1 0 011 1v1M9.5 11h5M9.5 14.5h3.5" />
        </svg>
      );
    case "link":
      return (
        <svg {...common}>
          <path d="M10 14a4 4 0 005.66 0l3-3a4 4 0 00-5.66-5.66l-1 1" />
          <path d="M14 10a4 4 0 00-5.66 0l-3 3a4 4 0 005.66 5.66l1-1" />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path d="M12 3l7 3v5.2c0 4.6-3 8.3-7 9.8-4-1.5-7-5.2-7-9.8V6z" />
        </svg>
      );
    case "lock":
      return (
        <svg {...common}>
          <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
          <path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5" />
        </svg>
      );
    case "check":
      return (
        <svg {...common} strokeWidth={2}>
          <path d="M5 12.5l4.2 4.2L19 7" />
        </svg>
      );
    case "alert":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.75v5M12 16.25v.01" />
        </svg>
      );
    case "x":
      return (
        <svg {...common}>
          <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
        </svg>
      );
    case "pause":
      return (
        <svg {...common}>
          <path d="M9.5 6.5v11M14.5 6.5v11" />
        </svg>
      );
    case "arrow":
      return (
        <svg {...common}>
          <path d="M7 17L17 7M9 7h8v8" />
        </svg>
      );
  }
}

function Amount({
  raw,
  asset,
  logoId,
  symbol,
  size = 18,
  logo = true,
  className = "",
}: {
  raw: bigint | string;
  asset: Address;
  logoId: string;
  symbol: string;
  size?: number;
  /** false: the symbol as quiet text (calmer in long lists). */
  logo?: boolean;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap ${logo ? "gap-2" : "gap-1.5"} ${className}`}>
      <span className="tnum">{formatAssetAmount(raw, asset, 6)}</span>
      {logo ? (
        <TokenLogo id={logoId} symbol={symbol} size={size} />
      ) : (
        <span className="text-mute">{symbol}</span>
      )}
    </span>
  );
}

/** A person's avatar: initials on a soft tile, or the sealed tint when hidden. */
function Avatar({
  tone = "plain",
  children,
}: {
  tone?: "plain" | "sealed" | "warn" | "danger";
  children: ReactNode;
}) {
  const tones = {
    plain: "bg-surface text-foreground",
    sealed: "bg-sealed-soft text-sealed",
    warn: "bg-warn-soft text-warn",
    danger: "bg-danger-soft text-danger",
  } as const;
  return (
    <span
      aria-hidden
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[12px] font-medium tracking-[0.02em] transition-colors duration-300 ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** The progress rail: surface track, sealed fill (paid is the one green thing). */
function Rail({
  value,
  reduce,
  tone = "sealed",
}: {
  value: number;
  reduce: boolean | null;
  tone?: "sealed" | "ink";
}) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
      <motion.div
        className={`h-full rounded-full ${tone === "sealed" ? "bg-sealed" : "bg-foreground/70"}`}
        initial={false}
        animate={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
        transition={{ duration: reduce ? 0 : 0.5, ease }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ view

export function PayrollView() {
  const reduce = useReducedMotion();
  const { address, isConnected, chainId: walletChainId, demo } = useAppAccount();
  const { network, networkKey } = useNetwork();
  const pool = network.pool;
  const { open, refresh: refreshNotes } = useLocalShieldNotes(address);
  const { loading: treeLoading, leafIndexForCommitment, refresh: refreshTree } = useShieldTree();
  const { writeContractAsync } = useWriteContract();
  const openGated = useOpenGatedTokens();

  // ---------------------------------------------------------------- assets
  const assetOptions = useMemo<AssetOption[]>(() => {
    // Payroll leads with stablecoins (USDG on Robinhood Chain, PathUSD on Tempo).
    // BDX, or ETH on Robinhood Chain, only once the vault takes it (its live deposit limit is open).
    const tokens = addableTokensFor(network.chainId, openGated);
    const stable = tokens.filter((t) => t.kind === "stablecoin");
    const rest = tokens.filter((t) => t.kind !== "stablecoin");
    const opts: AssetOption[] = stable.map((t) => ({ address: t.address as Address, symbol: t.symbol, logoId: t.id }));
    if (isNativeAddable(network.chainId, openGated)) {
      opts.push({
        address: NATIVE_ASSET,
        symbol: network.primaryAsset.symbol,
        logoId: network.primaryAsset.symbol.toLowerCase(),
      });
    }
    for (const t of rest) opts.push({ address: t.address as Address, symbol: t.symbol, logoId: t.id });
    return opts;
  }, [network.chainId, network.primaryAsset.symbol, openGated]);
  const [assetChoice, setAsset] = useState<Address | null>(null);
  const token: AssetOption = assetOptions.find((o) => o.address === assetChoice) ??
    assetOptions[0] ?? { address: NATIVE_ASSET, symbol: "ETH", logoId: "eth" };
  const asset = token.address;
  // Stablecoins (and the native coin) lead; anything else waits behind "More".
  const [moreAssets, setMoreAssets] = useState(false);
  const leadCount =
    shieldTokensFor(network.chainId).filter((t) => t.kind === "stablecoin").length +
    (isNativeAddable(network.chainId, openGated) ? 1 : 0);

  /** Spendable private balance per asset (only entries the vault tree knows). */
  const balances = useMemo(() => {
    const m = new Map<string, { total: bigint; entries: bigint[] }>();
    for (const n of activeSpendableNotes(open)) {
      if (n.scheme === "keccak") continue;
      if (n.leafIndex == null && leafIndexForCommitment(n.commitment) == null) continue;
      const v = BigInt(n.amountWei);
      if (v <= 0n) continue;
      const k = n.asset.toLowerCase();
      const cur = m.get(k) ?? { total: 0n, entries: [] };
      cur.total += v;
      cur.entries.push(v);
      m.set(k, cur);
    }
    return m;
  }, [open, leafIndexForCommitment]);
  const bal = balances.get(asset.toLowerCase()) ?? { total: 0n, entries: [] as bigint[] };

  // ---------------------------------------------------------------- draft
  const [csv, setCsv] = useState("");
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [view, setViewMode] = useState<"you" | "public">("you");
  const [title, setTitle] = useState(
    () => `Payroll ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
  );
  const fileRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => parsePayrollCsv(csv, asset), [csv, asset]);
  const validRows = useMemo(() => parsed.rows.filter((r) => !r.error), [parsed.rows]);
  const badCount = parsed.rows.length - validRows.length;
  const total = draftTotal(parsed.rows);
  const directCount = validRows.filter((r) => r.kind === "gloam").length;
  // The deposit to add is rounded up to what the summary shows (whole cents for a
  // stablecoin, 0.000001 ETH), so it can be typed as shown; 0.01 ETH steps asked for too much.
  const plan = useMemo(
    () =>
      fundingPlan(
        validRows.map((r) => r.amount!),
        bal.entries,
        10n ** BigInt(Math.max(assetDecimals(asset) - summaryDecimals(asset), 0))
      ),
    [validRows, bal.entries, asset]
  );
  const coverage = total > 0n ? Math.min(1, Number((bal.total * 1000n) / total) / 1000) : 0;

  async function loadFile(f: File | undefined) {
    if (!f) return;
    setReading(f.name);
    try {
      // A short minimum so the spinner reads as a step, not a flicker.
      const [text] = await Promise.all([f.text(), new Promise((r) => setTimeout(r, 450))]);
      setCsv(text.slice(0, 200_000));
      setFile({ name: f.name, size: f.size });
      setPasteOpen(false);
      setFromSchedule(null);
    } finally {
      setReading(null);
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    void loadFile(e.dataTransfer.files?.[0]);
  }

  function clearDraft() {
    setCsv("");
    setFile(null);
    setFromSchedule(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  // ---------------------------------------------------------------- schedules
  const sched = useSchedules({ chainId: network.chainId, pool, demo, demoAsset: assetOptions[0]?.address });
  const { today } = sched;
  /** The schedule (and payday) whose list is in the draft, so the run enforces its cap and counts for it. */
  const [fromSchedule, setFromSchedule] = useState<{ id: string; payday: string } | null>(null);
  const [editor, setEditor] = useState<{ base: PayrollSchedule; isNew: boolean } | null>(null);
  const [bannerHidden, setBannerHidden] = useState(false);
  const loaded = fromSchedule ? (sched.schedules.find((x) => x.id === fromSchedule.id) ?? null) : null;
  const loadedSymbol = loaded ? (assetOptions.find((o) => o.address === loaded.asset)?.symbol ?? "") : "";
  const wrongAsset = Boolean(loaded && loaded.asset.toLowerCase() !== asset.toLowerCase());
  const capOver = loaded && !wrongAsset ? overCap(total, loaded) : 0n;
  const dueItems = useMemo(
    () =>
      sortSchedules(sched.schedules, today)
        .map((s) => ({ s, st: scheduleState(s, today) }))
        .filter((x) => (x.st.status === "due" || x.st.status === "overdue") && x.s.id !== fromSchedule?.id),
    [sched.schedules, today, fromSchedule?.id]
  );

  // ---------------------------------------------------------------- relay
  const [relayAvailable, setRelayAvailable] = useState(false);
  const [relayOn, setRelayOn] = useState(false);
  /** The relay's status here, for its gas ceiling (Ethereum): over it, a relayed run waits. */
  const [relayStatus, setRelayStatus] = useState<RelayNetworkStatus | null>(null);
  useEffect(() => {
    let live = true;
    // A demo always has the relay, with the wallet hidden.
    const status = demo ? Promise.resolve(null) : relayFor(network.chainId);
    void status.then((r) => {
      if (!live) return;
      const ok = demo || Boolean(r?.enabled);
      setRelayStatus(r);
      setRelayAvailable(ok);
      setRelayOn(ok && (demo || relayPreferred()));
    });
    return () => {
      live = false;
    };
  }, [network.chainId, demo]);

  // ---------------------------------------------------------------- runs
  const [batches, setBatches] = useState<PayrollBatch[]>([]);
  const [active, setActive] = useState<PayrollBatch | null>(null);
  const [running, setRunning] = useState(false);
  const startGate = useRef(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  /** The finished run whose total is being proven (the Prove the total dialog). */
  const [proving, setProving] = useState<PayrollBatch | null>(null);
  const stopRef = useRef(false);

  // An open run belongs to its network: its claim links, explorer links and labels are
  // built from the network shown. A switch closes it (it stays in that network's history);
  // a run still going is left alone and closes once it ends.
  const shownChain = useRef(network.chainId);
  useEffect(() => {
    if (shownChain.current === network.chainId || running) return;
    shownChain.current = network.chainId;
    setActive(null);
    setProving(null);
  }, [network.chainId, running]);

  const reloadBatches = useCallback(() => {
    // A demo keeps its runs in memory only.
    if (!pool || demo) return Promise.resolve();
    return loadBatches(network.chainId, pool).then(setBatches);
  }, [network.chainId, pool, demo]);
  useEffect(() => {
    if (!pool) return;
    let live = true;
    const first = assetOptions[0];
    // A demo's past run carries made-up proof records, so its total can be proven too.
    const load =
      demo && first
        ? Promise.all(
            demoHistory({ chainId: network.chainId, pool, asset: first.address, decimals: assetDecimals(first.address) }).map(
              withDemoProofRecords
            )
          )
        : loadBatches(network.chainId, pool);
    void load.then((b) => {
      if (live) setBatches(b);
    });
    return () => {
      live = false;
    };
  }, [network.chainId, pool, demo, assetOptions]);

  const walletOnChain = walletChainId === network.chainId;
  const blocker = !isConnected
    ? "Connect your wallet to pay."
    : !pool
      ? "Payroll is not available on this network."
      : validRows.length === 0
        ? null
        : loaded && wrongAsset
          ? `${loaded.name} pays in ${loadedSymbol}. Switch back to ${loadedSymbol} to run it.`
          : loaded && capOver > 0n
            ? `This list is ${formatAssetAmountExact(capOver, asset)} ${token.symbol} over the schedule's cap, so the run is blocked. Edit the schedule or the list.`
            : !relayOn && !walletOnChain
          ? `Switch your wallet to ${network.label}, or turn on Hide my wallet.`
          : relayOn && relayStatus?.gasHigh
            ? gasHighMessage(network.label)
          : treeLoading
            ? "Syncing your private balance…"
            : null;
  const canRun = !blocker && validRows.length > 0 && plan.shortfall === 0n && !running;

  async function execute(batch: PayrollBatch) {
    if (!address || !pool) return;
    stopRef.current = false;
    setRunning(true);
    setRunError(null);
    setActive(batch);
    const useRelay = batch.relay && relayAvailable;
    const memoOn = isPayMemoLive();
    if (demo) {
      const played = await simulatePayroll(batch, {
        onUpdate: (b) => setActive(b),
        shouldStop: () => stopRef.current,
      });
      // The records a real run keeps, so the demo run's total can be proven.
      const done = await withDemoProofRecords(played);
      setActive({ ...done });
      setBatches((prev) => [done, ...prev.filter((x) => x.id !== done.id)]);
      if (done.status === "done") {
        if (done.scheduleId && done.payday) void sched.markPaid(done.scheduleId, done.payday, done.id);
        clearDraft();
      }
      setRunning(false);
      refreshNotes();
      return;
    }
    // the run's own chain for the whole run, never the one shown at the click: its reads and
    // receipts stay there if the page switches (runPayroll refuses a run of another network)
    const runNet = runNetwork(batch);
    const runClient = runNet ? publicClientFor(runNet) : getRhPublicClient();
    try {
      const done = await runPayroll(batch, {
        client: runClient,
        submitTransfer: (a) =>
          useRelay
            ? relayTransfer({ chainId: network.chainId, ...a })
            : writeContractAsync({
                address: pool,
                abi: shieldPoolAbi,
                functionName: "transfer",
                args: [a.proof, a.root, a.nullifier, [a.commitments[0], a.commitments[1]]],
                gas: gasFor(network.chainId, TRANSFER_GAS_LIMIT),
                chainId: network.chainId,
              }),
        submitMemo: memoOn
          ? (m) => {
              const fromWallet = () =>
                writeContractAsync({
                  address: payMemoAddress()!,
                  abi: payMemoAbi,
                  functionName: "postMemo",
                  args: [m.paymentCommitment, m.memo],
                  gas: gasFor(network.chainId, MEMO_GAS_LIMIT),
                  chainId: network.chainId,
                });
              // Heads-ups go through the relay whenever it is up: no wallet prompt per person. A run sent
              // from the wallet may fall back to it; a hidden run never posts from the wallet.
              if (!relayAvailable) return fromWallet();
              return relayMemo({ chainId: network.chainId, ...m }).catch((e) => (useRelay ? Promise.reject(e) : fromWallet()));
            }
          : null,
        waitForTx: (h: Hex) => waitForTx(h, undefined, runClient),
        onUpdate: (b) => setActive(b),
        shouldStop: () => stopRef.current,
      });
      setActive({ ...done });
      if (done.status === "done") {
        if (done.rows.some((r) => r.status === "paid")) countPerson("payroll", address, network.testnet);
        // How many and where, never amounts or names.
        track("payroll_run_finished", {
          people: done.rows.filter((r) => r.status === "paid").length,
          chainId: done.chainId,
          relay: useRelay,
        });
        // A finished run (failed rows included) settles its payday, so the same list is never offered twice.
        if (done.scheduleId && done.payday) await sched.markPaid(done.scheduleId, done.payday, done.id);
        clearDraft();
      }
    } catch (e) {
      setRunError(walletErrorForPeople(e, "Payroll stopped."));
    } finally {
      setRunning(false);
      refreshNotes();
      void refreshTree();
      void reloadBatches();
    }
  }

  async function startRun() {
    if (!address || !pool || !canRun) return;
    // The schedule's cap is a hard stop, checked again right before anything is built.
    if (loaded && (wrongAsset || overCap(total, loaded) > 0n)) return;
    // Saving the run takes a moment (a lock, then the stored runs re-sealed) before
    // `running` is set: a second click then would start a second run of the same list.
    if (startGate.current) return;
    startGate.current = true;
    setStarting(true);
    setStartError(null);
    let batch: PayrollBatch;
    try {
      batch = newBatch({
      title: title.trim() || "Payroll",
      chainId: network.chainId,
      pool,
      asset,
      employer: address,
      relay: relayOn,
      rows: parsed.rows,
      schedule: loaded && fromSchedule ? fromSchedule : undefined,
      });
      if (!demo) await saveBatch(batch);
    } catch {
      setStartError("Couldn't save this run in the browser, so nothing was paid. Free up some space or leave private browsing, then try again.");
      return;
    } finally {
      startGate.current = false;
      setStarting(false);
    }
    track("payroll_run_started", { people: batch.rows.length, chainId: batch.chainId, relay: batch.relay && relayAvailable });
    if (batch.scheduleId) track("schedule_run", { people: batch.rows.length, chainId: batch.chainId });
    await execute(batch);
  }

  /** Run now: put the schedule's list in the normal run flow, linked so the cap applies. */
  function runSchedule(s: PayrollSchedule) {
    const st = scheduleState(s, today);
    if (!st.payday || st.status === "ended") return;
    // A run for this payday that stopped part way is resumed, never started twice.
    const open = batches.find((b) => b.scheduleId === s.id && b.payday === st.payday && b.status !== "done");
    if (open) {
      setActive(open);
      return;
    }
    // A run that finished but never got recorded (the tab closed in between)
    // already paid this payday: record it now instead of paying it again.
    const ran = batches.find((b) => b.scheduleId === s.id && b.payday === st.payday && b.status === "done");
    if (ran) {
      void sched.markPaid(s.id, st.payday, ran.id);
      return;
    }
    setAsset(s.asset);
    setCsv(scheduleCsv(s.people, s.asset));
    setFile(null);
    setPasteOpen(false);
    setViewMode("you");
    setTitle(runTitle(s, st.payday, today));
    setFromSchedule({ id: s.id, payday: st.payday });
    if (fileRef.current) fileRef.current.value = "";
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }

  function newScheduleFromDraft() {
    if (!pool) return;
    const from = validRows.length > 0 ? peopleFromDraft(parsed.rows) : [];
    setEditor({
      isNew: true,
      base: newSchedule({
        name: "Team payroll",
        chainId: network.chainId,
        pool,
        asset,
        cadence: { kind: "monthly", day: 1 },
        cap: total,
        people: from,
        startsOn: today,
      }),
    });
  }

  /** "Repeat this run": a schedule prefilled from a finished run, monthly on its day. */
  function repeatRun(b: PayrollBatch) {
    const ran = new Date(b.createdAt);
    const list = peopleFromBatch(b);
    setEditor({
      isNew: true,
      base: newSchedule({
        name: b.title.replace(/,?\s+[A-Z][a-z]{2}\s\d{1,2}$/, "").trim() || "Team payroll",
        chainId: b.chainId,
        pool: b.pool,
        asset: b.asset,
        cadence: { kind: "monthly", day: ran.getDate() },
        cap: list.reduce((sum, p) => sum + BigInt(p.amount), 0n),
        people: list,
        startsOn: today,
        // This run already covered its own payday; the schedule starts after it.
        paidThrough: isoDay(ran),
      }),
    });
  }

  async function onSaveSchedule(s: PayrollSchedule) {
    const isNew = editor?.isNew ?? false;
    await sched.save(s);
    if (isNew) track("schedule_created", { people: s.people.length, chainId: s.chainId, cadence: s.cadence.kind });
    setEditor(null);
    // An edit to the list that is loaded right now shows up in it.
    if (fromSchedule?.id === s.id) runSchedule(s);
  }

  function exportBatch(b: PayrollBatch) {
    const opt = assetOptions.find((o) => o.address === b.asset);
    download(
      `${b.title.replace(/[^\w-]+/g, "-").toLowerCase()}-results.csv`,
      exportResultsCsv(b, {
        origin: window.location.origin,
        networkKey,
        assetLabel: opt?.symbol ?? "",
        explorerTx: network.explorerTx,
      })
    );
  }

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  const rowMotion = reduce
    ? {}
    : {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0 },
        transition: { duration: 0.22, ease },
      };

  const proveNode = proving ? (
    <ProveTotal
      key={proving.id}
      batch={proving}
      symbol={assetOptions.find((o) => o.address === proving.asset)?.symbol ?? token.symbol}
      logoId={assetOptions.find((o) => o.address === proving.asset)?.logoId ?? token.logoId}
      networkLabel={network.label}
      onClose={() => setProving(null)}
    />
  ) : null;

  const editorNode = editor ? (
    <ScheduleEditor
      key={editor.base.id}
      base={editor.base}
      isNew={editor.isNew}
      assetOptions={assetOptions}
      today={today}
      onSave={onSaveSchedule}
      onClose={() => setEditor(null)}
    />
  ) : null;

  // ================================================================ run view
  if (active && active.status !== "draft") {
    const b = active;
    const opt = assetOptions.find((o) => o.address === b.asset) ?? token;
    const paid = b.rows.filter((r) => r.status === "paid");
    const paidTotal = paid.reduce((s, r) => s + BigInt(r.amount), 0n);
    const current = b.rows.find(
      (r) => r.status !== "paid" && r.status !== "failed" && r.status !== "queued"
    );
    const remaining = b.rows.filter((r) => r.status !== "paid" && r.status !== "failed").length;
    const links = paid.filter((r) => r.kind === "link" && r.ticket);
    const done = b.status === "done";
    const linkTotal = b.rows.filter((r) => r.kind === "link").length;
    const runSched = b.scheduleId ? sched.schedules.find((x) => x.id === b.scheduleId) : undefined;
    const runNext = runSched ? scheduleState(runSched, today) : null;

    return (
      <div className="grid max-lg:gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
        <section className="gl-card min-w-0 overflow-hidden">
          <header className="relative overflow-hidden border-b border-line max-sm:px-5 pb-6 max-sm:pt-6 sm:px-7 sm:pt-7">
            {done && <SealedField tone="soft" />}
            <div className="relative z-[1]">
              {done ? (
                <div className="flex items-start gap-4">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-sealed-soft text-sealed">
                    <Icon name="check" className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="max-sm:text-[26px] font-light leading-[1.15] tracking-[-0.018em] text-foreground sm:text-[30px]">
                      {people(paid.length)} paid privately
                    </p>
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-mute">
                      <Amount
                        raw={paidTotal}
                        asset={b.asset}
                        logoId={opt.logoId}
                        symbol={opt.symbol}
                        size={16}
                        className="text-foreground"
                      />
                      <span aria-hidden className="text-faint">
                        ·
                      </span>
                      <span className="truncate">{b.title}</span>
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] text-mute">{b.title}</p>
                    <p className="mt-2 flex items-center gap-2.5 max-sm:text-[22px] font-light leading-tight tracking-[-0.012em] text-foreground sm:text-[26px]">
                      {running ? <Spinner className="h-4 w-4 text-mute" /> : null}
                      <span className="truncate">
                        {running
                          ? current
                            ? `Paying ${current.name}`
                            : remaining === 0
                              ? "Finishing up…"
                              : "Starting…"
                          : b.status === "needs_funds"
                            ? "Paused, add money to continue"
                            : "Paused"}
                      </span>
                    </p>
                    <p className="mt-1.5 text-[13px] text-mute">
                      {remaining === 0
                        ? "Keep this tab open."
                        : `About ${minutes(remaining)} min left. Keep this tab open.`}
                    </p>
                  </div>
                  <p className="tnum shrink-0 pt-6 text-right text-[13px] text-mute">
                    <span className="text-[22px] font-light text-foreground">{paid.length}</span>
                    <span className="text-faint"> / {b.rows.length}</span>
                  </p>
                </div>
              )}
              <div className="mt-5">
                <Rail value={paid.length / Math.max(1, b.rows.length)} reduce={reduce} />
              </div>
            </div>
          </header>

          {runError && (
            <p className="flex items-start gap-2.5 border-b border-line bg-warn-soft max-sm:px-5 py-3.5 text-[13px] leading-relaxed text-warn sm:px-7">
              <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">{runError}</span>
            </p>
          )}

          <ul className="divide-y divide-line">
            {b.rows.map((r) => (
              <RunRow
                key={r.id}
                row={r}
                opt={opt}
                asset={b.asset}
                networkKey={networkKey}
                copied={copied}
                onCopy={copy}
              />
            ))}
          </ul>
        </section>

        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <section className="gl-card max-sm:p-5 sm:p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-[17px] text-foreground">{done ? "Receipt" : "This run"}</h2>
              {done ? (
                <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-sealed-soft px-2.5 text-[12px] font-medium text-sealed">
                  <Icon name="lock" className="h-3 w-3" />
                  Private
                </span>
              ) : running ? (
                <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-surface px-2.5 text-[12px] font-medium text-foreground">
                  <span className="livedot h-1.5 w-1.5 rounded-full bg-foreground" aria-hidden />
                  Live
                </span>
              ) : null}
            </div>

            <p className="mt-4 flex items-center gap-2.5 text-foreground">
              <span className="tnum text-[34px] font-light leading-none tracking-[-0.02em]">
                {formatAssetAmount(paidTotal, b.asset, summaryDecimals(b.asset))}
              </span>
              <TokenLogo id={opt.logoId} symbol={opt.symbol} size={22} />
            </p>
            <p className="mt-1.5 text-[13px] text-mute">
              {done ? `Paid in ${opt.symbol}` : `Paid so far, in ${opt.symbol}`}
            </p>

            <dl className="mt-5 divide-y divide-line border-y border-line text-[13.5px]">
              <Line k="Paid" v={`${paid.length} of ${b.rows.length}`} />
              <Line k="Sent by" v={b.relay ? "Gloam, wallet hidden" : "Your wallet"} />
              {runSched && (
                <Line
                  k="Schedule"
                  v={
                    <span className="block max-w-[190px] truncate">
                      {done && runNext?.payday
                        ? `Next ${dayLabel(runNext.payday, today)}`
                        : b.payday
                          ? `Payday ${dayLabel(b.payday, today)}`
                          : runSched.name}
                    </span>
                  }
                />
              )}
              <Line k="Claim links" v={String(linkTotal)} />
              <Line
                k="The public sees"
                v={
                  <span className="inline-flex items-center gap-2 text-mute">
                    {b.rows.length} private transfers
                  </span>
                }
              />
            </dl>

            {b.status === "needs_funds" && !running && (
              <div className="mt-4 rounded-[14px] bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
                Your private balance ran short.{" "}
                <Link href="/app/vault?tab=shield" className="font-medium underline underline-offset-2">
                  Add {opt.symbol} privately
                </Link>
                , then resume.
              </div>
            )}

            <div className="mt-5 space-y-2">
              {running ? (
                <button
                  type="button"
                  onClick={() => (stopRef.current = true)}
                  className="btn btn-ghost btn-block"
                >
                  <Icon name="pause" />
                  Pause after this person
                </button>
              ) : !done ? (
                <button type="button" onClick={() => void execute(b)} className="btn btn-ink btn-lg btn-block">
                  Resume
                </button>
              ) : (
                <>
                  <button type="button" onClick={() => setInvoiceOpen(true)} className="btn btn-ink btn-lg btn-block">
                    <Icon name="file" />
                    View invoice
                  </button>
                  <button type="button" onClick={() => setProving(b)} className="btn btn-ghost btn-block">
                    <Icon name="shield" />
                    Prove the total
                  </button>
                  <button type="button" onClick={() => exportBatch(b)} className="btn btn-ghost btn-block">
                    <Icon name="download" />
                    Download results
                  </button>
                  {!runSched && (
                    <button type="button" onClick={() => repeatRun(b)} className="btn btn-ghost btn-block">
                      <ScheduleIcon name="repeat" />
                      Repeat this run
                    </button>
                  )}
                </>
              )}
              {!running && links.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    void copy(
                      "all",
                      links.map((r) => `${r.name}: ${claimLink(window.location.origin, networkKey, r.ticket!)}`).join("\n")
                    )
                  }
                  className="btn btn-ghost btn-block"
                >
                  {copied === "all" ? <Icon name="check" /> : <Icon name="link" />}
                  {copied === "all" ? "Copied" : `Copy ${links.length} claim ${links.length === 1 ? "link" : "links"}`}
                </button>
              )}
              {!running && (
                <button type="button" onClick={() => setActive(null)} className="btn btn-quiet btn-block text-mute">
                  {done ? "Start a new run" : "Back to your list"}
                </button>
              )}
            </div>
            {done && links.length > 0 && (
              <p className="mt-4 border-t border-line pt-4 text-[12.5px] leading-relaxed text-mute">
                Claim links work like cash. Send each one only to its person.
              </p>
            )}
          </section>
        </aside>

        {done && invoiceOpen && (
          <PayrollInvoice
            batch={b}
            symbol={opt.symbol}
            networkLabel={network.label}
            testnet={Boolean(network.chain.testnet)}
            explorerTx={network.explorerTx}
            linkRefs={!demo}
            onClose={() => setInvoiceOpen(false)}
          />
        )}
        {editorNode}
        {proveNode}
      </div>
    );
  }

  // ================================================================ draft view
  const hasRows = parsed.rows.length > 0;
  const pasted = !file && csv.trim().length > 0;
  const linkCount = validRows.length - directCount;
  const isPublic = view === "public";
  const covered = plan.shortfall === 0n && total > 0n;

  return (
    <div className="space-y-5 lg:space-y-6">
      {!bannerHidden && dueItems.length > 0 && (
        <DueBanner
          items={dueItems}
          today={today}
          assetOptions={assetOptions}
          onRun={runSchedule}
          onDismiss={() => setBannerHidden(true)}
        />
      )}
      <div className="grid max-lg:gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
        <div className="min-w-0 space-y-5">
          {/* currency */}
          <section className="gl-card max-sm:p-5 sm:p-6">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-[17px] text-foreground">Pay in</h2>
              <p className="max-sm:hidden text-[13px] text-mute sm:block">Comes out of your private balance</p>
            </div>
            <div
              className="max-sm:-mx-5 mt-4 flex gap-2 overflow-x-auto max-sm:px-5 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden"
              role="radiogroup"
              aria-label="Currency"
            >
              {assetOptions.map((o, i) => {
                const selected = o.address === asset;
                const b = balances.get(o.address.toLowerCase())?.total ?? 0n;
                if (!moreAssets && i >= leadCount && !selected) return null;
                return (
                  <button
                    key={o.address}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setAsset(o.address)}
                    className={`flex h-14 shrink-0 items-center gap-3 rounded-full border pl-2 pr-5 text-left transition-[border-color,box-shadow,background-color] duration-200 ${
                      selected
                        ? "border-foreground bg-panel shadow-card"
                        : "border-line bg-panel hover:border-line-strong hover:bg-surface"
                    }`}
                  >
                    <TokenLogo id={o.logoId} symbol={o.symbol} size={38} />
                    <span className="min-w-0">
                      <span className="block text-[14px] font-medium leading-tight text-foreground">{o.symbol}</span>
                      {/* Signed out no balance is read, so none is named, not even "No private balance". */}
                      {isConnected && (
                        <span className="tnum mt-0.5 block text-[12px] leading-tight text-mute">
                          {b > 0n ? `${formatAssetAmount(b, o.address, summaryDecimals(o.address))} private` : "No private balance"}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
              {assetOptions.length > leadCount && (
                <button
                  type="button"
                  onClick={() => setMoreAssets((v) => !v)}
                  aria-expanded={moreAssets}
                  className="flex h-14 shrink-0 items-center gap-2 rounded-full px-4 text-[13px] text-mute transition-colors hover:bg-surface hover:text-foreground"
                >
                  {moreAssets ? "Fewer" : `${assetOptions.length - leadCount} more`}
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden
                    className={`transition-transform duration-200 ${moreAssets ? "rotate-180" : ""}`}
                  >
                    <path d="M6 9.5l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </div>
          </section>

          {/* team list */}
          <section className="gl-card max-sm:p-5 sm:p-6">
            <div className="mb-4 flex items-baseline justify-between gap-3">
              <h2 className="text-[17px] text-foreground">Your team</h2>
              <button
                type="button"
                onClick={() => download("gloam-payroll-template.csv", PAYROLL_TEMPLATE)}
                className="btn btn-quiet btn-sm -mr-3 text-mute hover:text-foreground"
              >
                <Icon name="download" className="h-3.5 w-3.5" />
                Template
              </button>
            </div>

            {(file || (pasted && !pasteOpen)) && !reading ? (
              <div className="flex items-center rounded-[14px] bg-surface py-2.5 pl-2.5 pr-2 max-sm:gap-3 sm:gap-4">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] bg-panel text-foreground shadow-card">
                  {loaded && !file ? (
                    <ScheduleIcon name="calendar" className="h-5 w-5" />
                  ) : (
                    <Icon name={file ? "file" : "paste"} className="h-5 w-5" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] text-foreground">
                    {file ? file.name : loaded ? loaded.name : "Pasted list"}
                  </p>
                  <p className="mt-0.5 truncate text-[12.5px] text-mute">
                    {people(validRows.length)} ready
                    {badCount > 0 && <span className="text-warn">, {badCount} to fix</span>}
                    {loaded && fromSchedule && !file && `, from your schedule`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => (file ? fileRef.current?.click() : setPasteOpen(true))}
                  className="btn btn-quiet btn-sm h-10 shrink-0 hover:bg-surface-2"
                >
                  {file ? "Replace" : "Edit"}
                </button>
                <button
                  type="button"
                  onClick={clearDraft}
                  aria-label={file ? "Remove file" : "Clear list"}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-surface-2 hover:text-foreground"
                >
                  <Icon name="x" />
                </button>
              </div>
            ) : (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                className={`rounded-[16px] border border-dashed transition-colors duration-200 ${
                  dragging ? "border-foreground bg-surface" : "border-line-strong bg-surface/50"
                } ${
                  pasteOpen && !reading && !dragging
                    ? "flex items-center gap-3 p-2.5 text-left"
                    : "flex flex-col items-center justify-center px-5 text-center max-sm:py-10 sm:py-12"
                }`}
              >
                {reading ? (
                  <>
                    <Spinner className="h-6 w-6 text-foreground" />
                    <p className="mt-4 text-[15px] text-foreground">Reading {reading}</p>
                    <p className="mt-1 text-[13px] text-mute">Checking names, addresses and amounts</p>
                  </>
                ) : pasteOpen && !dragging ? (
                  <>
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-panel text-foreground shadow-card">
                      <Icon name="upload" className="h-4 w-4" />
                    </span>
                    <p className="min-w-0 flex-1 truncate text-[13.5px] text-mute">
                      <span className="max-sm:hidden">Drop a CSV here, or</span>
                    </p>
                    <button type="button" onClick={() => fileRef.current?.click()} className="btn btn-ghost btn-sm h-10 shrink-0">
                      Choose a file
                    </button>
                    <button
                      type="button"
                      onClick={() => setPasteOpen(false)}
                      aria-expanded={pasteOpen}
                      aria-label="Hide pasted list"
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-surface-2 hover:text-foreground"
                    >
                      <Icon name="x" />
                    </button>
                  </>
                ) : (
                  <>
                    <Icon name="upload" className="h-6 w-6 text-foreground" />
                    <p className="mt-3 text-[17px] text-foreground">
                      {dragging ? "Drop it here" : "Drop your team’s CSV"}
                    </p>
                    <p className="mt-1.5 max-w-[42ch] text-[13.5px] leading-relaxed text-mute">
                      One line per person. Leave the address blank and they get a claim link instead.
                    </p>
                    <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5" aria-label="Columns">
                      {["name", "gloam_address", "amount"].map((c) => (
                        <span
                          key={c}
                          className="inline-flex h-7 items-center rounded-full bg-panel px-3 text-[12px] text-soft shadow-card"
                        >
                          {c}
                        </span>
                      ))}
                      <span
                        className="inline-flex h-7 items-center rounded-full border border-dashed border-line-strong px-3 text-[12px] text-mute"
                        title="Optional. A private note only that person can read, like September salary."
                      >
                        note, optional
                      </span>
                    </div>
                    <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                      <button type="button" onClick={() => fileRef.current?.click()} className="btn btn-ink btn-sm h-10">
                        Choose a file
                      </button>
                      <button
                        type="button"
                        onClick={() => setPasteOpen(true)}
                        className="btn btn-quiet btn-sm h-10"
                        aria-expanded={pasteOpen}
                      >
                        <Icon name="paste" className="h-3.5 w-3.5" />
                        Paste a list
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="hidden"
              onChange={(e) => void loadFile(e.target.files?.[0])}
            />

            {file && !reading && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => setPasteOpen((v) => !v)}
                  className="btn btn-quiet btn-sm -ml-3 h-10 text-mute hover:text-foreground"
                  aria-expanded={pasteOpen}
                >
                  <Icon name="paste" className="h-3.5 w-3.5" />
                  {pasteOpen ? "Hide pasted list" : "Edit as text"}
                </button>
              </div>
            )}
            <AnimatePresence initial={false}>
              {pasteOpen && (
                <motion.div
                  initial={reduce ? false : { height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease }}
                  className="overflow-hidden"
                >
                  <label className="block pt-4">
                    <span className="mb-2 block text-[13px] text-mute">Paste your list, one person per line</span>
                    <textarea
                      value={csv}
                      onChange={(e) => {
                        setCsv(e.target.value);
                        setFile(null);
                      }}
                      rows={6}
                      spellCheck={false}
                      placeholder={PAYROLL_TEMPLATE}
                      wrap="off"
                      className="gl-input tnum h-auto resize-y overflow-x-auto whitespace-pre py-3 text-[13.5px] leading-[1.7]"
                    />
                  </label>
                </motion.div>
              )}
            </AnimatePresence>
            {parsed.error && (
              <p className="mt-4 flex items-start gap-2 rounded-[12px] bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn">
                <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" /> {parsed.error}
              </p>
            )}
          </section>

          {/* pay list, with the "who sees what" switch */}
          {hasRows && (
            <section className="gl-card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 max-sm:px-5 pb-4 pt-5 sm:px-6">
                <div className="min-w-0">
                  <h2 className="text-[17px] text-foreground">Pay list</h2>
                  <p className="mt-0.5 text-[13px] text-mute">
                    {isPublic
                      ? "What anyone can see on the explorer"
                      : `${people(validRows.length)}, ${directCount} to Gloam ${
                          directCount === 1 ? "address" : "addresses"
                        }, ${linkCount} claim ${linkCount === 1 ? "link" : "links"}`}
                  </p>
                </div>
                <div
                  className="flex rounded-full bg-surface p-1 text-[12.5px]"
                  role="tablist"
                  aria-label="Who sees what"
                >
                  {(["you", "public"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="tab"
                      aria-selected={view === m}
                      onClick={() => setViewMode(m)}
                      className={`relative h-8 rounded-full px-3.5 transition-colors duration-200 ${
                        view === m ? "text-foreground" : "text-mute hover:text-foreground"
                      }`}
                    >
                      {view === m && (
                        <motion.span
                          layoutId="payroll-view-pill"
                          className="absolute inset-0 rounded-full bg-panel shadow-card"
                          transition={{ duration: reduce ? 0 : 0.25, ease }}
                        />
                      )}
                      <span className="relative">{m === "you" ? "You see" : "The public sees"}</span>
                    </button>
                  ))}
                </div>
              </div>

              <ul className="border-t border-line" aria-live="polite">
                <AnimatePresence initial={false} mode="popLayout">
                  {parsed.rows.map((r) => {
                    const pub = isPublic && !r.error;
                    return (
                      <motion.li
                        key={`${r.line}-${pub ? "p" : "y"}`}
                        {...rowMotion}
                        className="flex min-h-[64px] items-center gap-3.5 border-b border-line max-sm:px-5 py-3 transition-colors last:border-0 hover:bg-surface/60 sm:px-6"
                      >
                        {pub ? (
                          <Avatar tone="sealed">
                            <Icon name="lock" className="h-3.5 w-3.5" />
                          </Avatar>
                        ) : r.error ? (
                          <Avatar tone="warn">
                            <Icon name="alert" className="h-4 w-4" />
                          </Avatar>
                        ) : (
                          <Avatar>{initials(r.name)}</Avatar>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px] text-foreground">
                            {pub ? "Private transfer" : r.name || `Line ${r.line}`}
                          </p>
                          <p className={`mt-0.5 truncate text-[12.5px] ${r.error ? "text-warn" : "text-mute"}`}>
                            {r.error
                              ? r.error
                              : pub
                                ? relayOn
                                  ? "Sent by Gloam. No name, no amount."
                                  : "No name, no amount."
                                : r.kind === "gloam"
                                  ? `Gloam address ${short(r.recipient)}`
                                  : "Claim link, you share it after the run"}
                          </p>
                          {!pub && !r.error && r.note && (
                            <PaymentNoteLine
                              note={r.note}
                              label="Private note"
                              className="mt-0.5 text-[12.5px] text-soft"
                            />
                          )}
                        </div>
                        {pub ? (
                          <SealDots n={6} className="text-foreground/55" />
                        ) : r.amount != null ? (
                          <Amount
                            raw={r.amount}
                            asset={asset}
                            logoId={token.logoId}
                            symbol={token.symbol}
                            logo={false}
                            className={`text-[15px] ${r.error ? "text-faint line-through" : "text-foreground"}`}
                          />
                        ) : (
                          <span className="text-[13px] text-mute">{r.amountInput || "No amount"}</span>
                        )}
                      </motion.li>
                    );
                  })}
                </AnimatePresence>
              </ul>

              <div className="max-sm:mx-3 mb-3 flex items-center justify-between rounded-[12px] bg-surface px-3.5 py-3 text-[13.5px] sm:mx-3">
                <span className="text-mute">{isPublic ? "Total" : `Total for ${people(validRows.length)}`}</span>
                {isPublic ? (
                  <SealDots n={7} className="text-foreground/55" />
                ) : (
                  <Amount
                    raw={total}
                    asset={asset}
                    logoId={token.logoId}
                    symbol={token.symbol}
                    size={16}
                    className="text-foreground"
                  />
                )}
              </div>
            </section>
          )}
        </div>

        {/* summary */}
        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <section className="gl-card max-sm:p-5 sm:p-6">
            <h2 className="text-[17px] text-foreground">This run</h2>
            <p className="mt-4 flex items-center gap-2.5 text-foreground">
              <span
                className={`tnum text-[40px] font-light leading-none tracking-[-0.025em] ${
                  total === 0n ? "text-faint" : ""
                }`}
              >
                {formatAssetAmountExact(total, asset)}
              </span>
              <TokenLogo id={token.logoId} symbol={token.symbol} size={24} />
            </p>
            <p className="mt-2 text-[13px] text-mute">
              {validRows.length > 0
                ? `${people(validRows.length)} in ${token.symbol}, about ${minutes(validRows.length)} min`
                : "Add your team to see the total"}
            </p>

            {loaded && fromSchedule && (
              <div className="mt-5 rounded-[14px] border border-line p-4">
                <p className="flex min-w-0 items-center gap-2 text-[13.5px] text-foreground">
                  <ScheduleIcon name="calendar" className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{loaded.name}</span>
                </p>
                <p className="mt-0.5 text-[12.5px] text-mute">
                  Payday {dayLabel(fromSchedule.payday, today)}. {cadenceLabel(loaded.cadence, today)}.
                </p>
                <div className="mt-3.5 flex items-center justify-between gap-3 text-[13px]">
                  <span className="text-mute">Cap per run</span>
                  <span className="tnum text-foreground">
                    {formatAssetAmount(loaded.cap, loaded.asset, summaryDecimals(loaded.asset))} {loadedSymbol}
                  </span>
                </div>
                <div className="mt-3">
                  <Rail
                    value={BigInt(loaded.cap) > 0n ? Number((total * 1000n) / BigInt(loaded.cap)) / 1000 : 1}
                    reduce={reduce}
                    tone="ink"
                  />
                </div>
                <p className={`mt-2.5 text-[12.5px] ${capOver > 0n || wrongAsset ? "text-warn" : "text-mute"}`}>
                  {wrongAsset
                    ? `This schedule pays in ${loadedSymbol}.`
                    : capOver > 0n
                      ? `${formatAssetAmountExact(capOver, asset)} ${token.symbol} over the cap. This run is blocked.`
                      : `${formatAssetAmount(BigInt(loaded.cap) - total, asset, summaryDecimals(asset))} ${token.symbol} under the cap.`}
                </p>
              </div>
            )}

            <div className={`${loaded ? "mt-3" : "mt-5"} rounded-[14px] bg-surface p-4`}>
              {!isConnected ? (
                // Signed out: no balance is read, so no amount and no shortfall against one.
                <>
                  <p className="text-[13px] text-mute">Private balance</p>
                  <p className="mt-1.5 text-[12.5px] text-mute">{SIGNED_OUT_BALANCE_MESSAGE}</p>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="text-mute">Private balance</span>
                    <span className="tnum text-foreground">
                      {formatAssetAmount(bal.total, asset, summaryDecimals(asset))} {token.symbol}
                    </span>
                  </div>
                  <div className="mt-3">
                    <Rail value={total > 0n ? coverage : 0} reduce={reduce} tone={covered ? "sealed" : "ink"} />
                  </div>
                  <p
                    className={`mt-2.5 flex items-center gap-1.5 text-[12.5px] ${
                      covered ? "text-sealed" : plan.shortfall > 0n && total > 0n ? "text-foreground" : "text-mute"
                    }`}
                  >
                    {covered && <Icon name="check" className="h-3.5 w-3.5" />}
                    {total === 0n
                      ? "Payments come out of your private balance."
                      : plan.shortfall === 0n
                        ? "Covers this run."
                        : `${formatAssetAmountExact(plan.shortfall, asset)} ${token.symbol} short. Add it as one deposit.`}
                  </p>
                </>
              )}
            </div>

            <div className="mt-3 space-y-3">
              <RelayGasNotice status={relayStatus} label={network.label} />
              <RelayToggle
                available={relayAvailable}
                on={relayOn}
                onChange={(v) => {
                  setRelayOn(v);
                  setRelayPreferred(v);
                }}
                compact
              />
            </div>

            {validRows.length > 0 && (
              <label className="mt-4 block">
                <span className="mb-1.5 block text-[13px] text-mute">Name this run</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} className="gl-input h-11 text-[14px]" />
              </label>
            )}

            <div className="mt-5">
              {validRows.length > 0 && plan.shortfall > 0n && isConnected ? (
                <Link href="/app/vault?tab=shield" className="btn btn-ink btn-lg btn-block">
                  Add {formatAssetAmountExact(plan.shortfall, asset)} {token.symbol} privately
                </Link>
              ) : (
                <button type="button" disabled={!canRun || starting} onClick={() => void startRun()} className="btn btn-ink btn-lg btn-block">
                  {starting ? (
                    <>
                      <Spinner className="h-4 w-4" />
                      Starting…
                    </>
                  ) : validRows.length > 0 ? (
                    `Pay ${people(validRows.length)} privately`
                  ) : (
                    "Pay privately"
                  )}
                </button>
              )}
              {startError && (
                <p role="alert" className="mt-2.5 text-center text-[12.5px] text-danger">
                  {startError}
                </p>
              )}
              {blocker && <p className="mt-2.5 text-center text-[12.5px] text-mute">{blocker}</p>}
              {!blocker && validRows.length === 0 && (
                <p className="mt-2.5 text-center text-[12.5px] text-mute">Add your team first, from a CSV or a pasted list.</p>
              )}
              {badCount > 0 && validRows.length > 0 && (
                <p className="mt-2 text-center text-[12.5px] text-warn">
                  {badCount} {badCount === 1 ? "line" : "lines"} will be skipped until fixed.
                </p>
              )}
              {validRows.length > 0 && !loaded && pool && (
                <button
                  type="button"
                  onClick={newScheduleFromDraft}
                  className="btn btn-quiet btn-block mt-2 text-mute hover:text-foreground"
                >
                  <ScheduleIcon name="calendar" className="h-3.5 w-3.5" />
                  Save as a schedule
                </button>
              )}
            </div>
          </section>

          {pool && sched.error && (
            <p role="alert" className="flex items-start gap-2.5 rounded-[14px] bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
              <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">{sched.error}</span>
            </p>
          )}
          {pool && (
            <ScheduleList
              schedules={sched.schedules}
              today={today}
              assetOptions={assetOptions}
              loadedId={fromSchedule?.id ?? null}
              onRun={runSchedule}
              onTogglePause={(s) => void sched.togglePause(s)}
              onEdit={(s) => setEditor({ base: s, isNew: false })}
              onDelete={(s) => {
                void sched.remove(s.id).then((gone) => {
                  if (gone) setFromSchedule((cur) => (cur?.id === s.id ? null : cur));
                });
              }}
              onNew={newScheduleFromDraft}
            />
          )}

          {batches.length > 0 && (
            <section className="gl-card max-sm:p-5 sm:p-6">
              <div className="flex items-center justify-between">
                <h2 className="text-[17px] text-foreground">Past runs</h2>
                <span className="tnum text-[13px] text-mute">{batches.length}</span>
              </div>
              <ul className="-mx-2 mt-3 space-y-0.5">
                {batches.slice(0, 6).map((b) => {
                  const paid = b.rows.filter((r) => r.status === "paid");
                  const opt = assetOptions.find((o) => o.address === b.asset);
                  const sum = paid.reduce((s, r) => s + BigInt(r.amount), 0n);
                  // A run holding a sent payment is never deleted: its codes may be the only copy.
                  const untouched = b.rows.every((r) => r.status === "queued" && !holdsPendingPayment(r));
                  return (
                    <li key={b.id} className="flex items-center gap-2 rounded-[12px] transition-colors hover:bg-surface">
                      <button
                        type="button"
                        onClick={() => setActive(b)}
                        className="flex min-h-[56px] min-w-0 flex-1 items-center gap-3 rounded-[12px] px-2 text-left"
                      >
                        {opt ? (
                          <TokenLogo id={opt.logoId} symbol={opt.symbol} size={28} />
                        ) : (
                          <span className="h-7 w-7 shrink-0 rounded-full bg-surface" aria-hidden />
                        )}
                        <span className="min-w-0">
                          <span className="block truncate text-[14px] text-foreground">{b.title}</span>
                          <span className="tnum mt-0.5 block truncate text-[12px] text-mute">
                            {paid.length} of {b.rows.length} paid, {formatAssetAmount(sum, b.asset, summaryDecimals(b.asset))} {opt?.symbol ?? ""}
                          </span>
                        </span>
                      </button>
                      <span className="shrink-0 pr-2">
                        {b.status === "done" ? (
                          <button
                            type="button"
                            onClick={() => setProving(b)}
                            aria-label={`Prove the total of ${b.title}`}
                            className="inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-mute transition-colors hover:bg-surface-2 hover:text-foreground"
                          >
                            <Icon name="shield" className="h-3.5 w-3.5" />
                            Prove
                          </button>
                        ) : untouched ? (
                          <button
                            type="button"
                            onClick={() => void deleteBatch(b.id).then(reloadBatches)}
                            className="inline-flex h-10 items-center rounded-full px-3 text-[12.5px] text-mute transition-colors hover:bg-surface-2 hover:text-foreground"
                          >
                            Delete
                          </button>
                        ) : (
                          <span className="inline-flex h-6 items-center rounded-full bg-warn-soft px-2.5 text-[12px] font-medium text-warn">
                            Paused
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </aside>
      </div>
      {editorNode}
      {proveNode}
    </div>
  );
}

function Line({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-3 py-2">
      <dt className="text-mute">{k}</dt>
      <dd className="tnum text-right text-foreground">{v}</dd>
    </div>
  );
}

/** Four small ticks: where this person's payment is in its own run. */
function StepTicks({ step }: { step: number }) {
  return (
    <span className="mt-1.5 flex justify-end gap-1" aria-hidden>
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`h-1 w-3.5 rounded-full transition-colors duration-300 ${
            i < step ? "bg-foreground/70" : i === step ? "bg-foreground/35" : "bg-surface-2"
          }`}
        />
      ))}
    </span>
  );
}

function RunRow({
  row: r,
  opt,
  asset,
  networkKey,
  copied,
  onCopy,
}: {
  row: PayrollRow;
  opt: AssetOption;
  asset: Address;
  networkKey: string;
  copied: string | null;
  onCopy: (key: string, text: string) => void;
}) {
  // Still checking waits on the chain, not on this tab, so it gets no spinner.
  const checking = r.status === "unconfirmed";
  const busy = r.status !== "paid" && r.status !== "failed" && r.status !== "queued" && !checking;
  const chip =
    r.status === "paid"
      ? "bg-sealed-soft text-sealed"
      : r.status === "failed"
        ? "bg-danger-soft text-danger"
        : busy || checking
          ? "bg-panel text-foreground shadow-card"
          : "text-faint";
  return (
    <li
      className={`flex min-h-[68px] items-center gap-3.5 max-sm:px-5 py-3 transition-colors duration-300 sm:px-7 ${
        busy ? "bg-surface" : ""
      }`}
    >
      <Avatar tone={r.status === "failed" ? "danger" : "plain"}>
        {r.status === "failed" ? <Icon name="alert" className="h-4 w-4" /> : initials(r.name)}
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] text-foreground">{r.name}</p>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] text-mute">
          {r.kind === "gloam" ? (
            <Icon name="shield" className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Icon name="link" className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="truncate">
            {r.kind === "gloam" ? (r.memoPosted ? "Gloam address, notified" : "Gloam address") : "Claim link"}
          </span>
          {r.status === "paid" && r.kind === "link" && r.ticket && (
            <button
              type="button"
              onClick={() => onCopy(r.id, claimLink(window.location.origin, networkKey, r.ticket!))}
              className="-my-2.5 ml-1 shrink-0 py-2.5 font-medium text-foreground underline-offset-2 hover:underline"
            >
              {copied === r.id ? "Copied" : "Copy link"}
            </button>
          )}
        </p>
        {r.note && <PaymentNoteLine note={r.note} label="Private note" className="mt-0.5 text-[12.5px] text-soft" />}
        {r.error && r.status !== "paid" && (
          <p className={`mt-0.5 truncate text-[12px] ${checking ? "text-mute" : "text-danger"}`}>{r.error}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <Amount
          raw={r.amount}
          asset={asset}
          logoId={opt.logoId}
          symbol={opt.symbol}
          logo={false}
          className="text-[14.5px] text-foreground"
        />
        <span
          className={`inline-flex h-6 items-center gap-1.5 rounded-full text-[12px] font-medium ${
            r.status === "queued" ? "px-0" : "px-2.5"
          } ${chip}`}
        >
          {busy && <Spinner className="h-3 w-3" />}
          {r.status === "paid" && <Icon name="lock" className="h-3 w-3" />}
          {STATUS_LABEL[r.status]}
        </span>
        {busy && STEP_INDEX[r.status] != null && <StepTicks step={STEP_INDEX[r.status]!} />}
      </div>
    </li>
  );
}
