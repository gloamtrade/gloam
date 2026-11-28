"use client";

/**
 * Bring money from another chain into the private balance on Solana
 * (lib/solanaRings/bridgeIn). Relay delivers to the private account's own
 * address; the account makes it private with Gloam's relay paying the fee, so
 * it is one step for the person and their Solana wallet never appears.
 *
 *  - SolanaBridgeIn: the "Money on another chain?" card on Add, the sheet that
 *    gets a deposit address or has an EVM wallet pay, and the transfer it
 *    follows (kept in this browser, so a closed tab picks it up again).
 *  - SolanaArrivals: money that reached the private account's address but isn't
 *    private yet, with a button to make it private. Shown wherever the balance is.
 *
 * Both take `deps` so a preview can drive them with made-up answers.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import { erc20Abi, formatUnits, isAddress, type Address } from "viem";
import { useAccount, useBalance, useConfig, useConnect, useReadContract } from "wagmi";
import { BRIDGE_MAX_USD, BRIDGE_MIN_USD, validRefundAddress, type BridgeChain, type BridgeStatus } from "@/lib/bridge";
import {
  FORM,
  LIVE_PRICE_DEBOUNCE_MS,
  LIVE_PRICE_REFRESH_MS,
  SOLANA_BRIDGE_PRIVACY_NOTE,
  bridgeButton,
  costedQuote,
  defaultLanding,
  flowReducer,
  loadRefunds,
  orNames,
  loadTracked,
  payRoute,
  refundKey,
  refundPlace,
  saveRefund,
  saveTracked,
  shownLandingAssets,
  solanaBridgeSources,
  trackPhase,
  trackedFrom,
  trackedKey,
  trackedLive,
  watchingArrivals,
  watchingRelay,
  type Arrival,
  type Flow,
  type RememberedRefunds,
  type SolanaBridgeQuote,
  type TrackedBridge,
  type WalletState,
} from "@/lib/solanaRings/bridgeIn";
import type { ShieldResult } from "@/lib/solanaRings/arrivals";
import type { RingsSession } from "@/lib/solanaRings/client";
import { ringsAssets, SOLANA_RINGS_NETWORK, type RingsNetwork } from "@/lib/solanaRings/config";
import { ringsAmount } from "@/lib/solanaRings/amount";
import { originChain } from "@/lib/originChains";
import type { GloamChainId } from "@/lib/networks";
import { track } from "@/lib/track";
import { payRelayTxs, wagmiPayActions, walletPaysAcrossChains, type PayActions } from "@/lib/relayWalletPay";
import { walletErrorText } from "@/lib/walletErrors";
import { shortAddress } from "@/lib/chain";
import { EMBEDDED_CONNECTOR_ID, EMBEDDED_WALLETS } from "@/lib/embeddedWallet";
import { WALLETCONNECT_ID, prefersWalletConnect } from "@/lib/walletConnect";
import { isTempoWallet } from "@/lib/tempoWallet";
import { embeddedAvailability, openSignInSheet } from "@/lib/turnkeyBridge";
import { useModalFocus } from "@/hooks/useModalFocus";
import { SealedField } from "@/components/ui/SealedField";
import { AmountProblem } from "./AmountProblem";
import { SuccessReceipt } from "./SuccessModal";
import { ChainLogo, CostWarning, PoweredByRelay, SourceBalance, TokenMark, feeRows, fmtMoney, stableMax } from "./BridgeIn";
import { WalletConnectSheet } from "./WalletConnectSheet";
import { displayAmountNumber, displayAmountText, typedAmount } from "@/lib/amountShort";

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

/** Everything the panel asks of the world, so a preview can stand in for it. */
export type SolanaBridgeDeps = {
  quote(body: Record<string, unknown>): Promise<SolanaBridgeQuote>;
  status(t: TrackedBridge): Promise<BridgeStatus | null>;
  arrivals(): Promise<Arrival[]>;
  makePrivate(a: Pick<Arrival, "assetId" | "tokenAccount">): Promise<ShieldResult>;
  store(): KV | null;
  /** The connected EVM wallet paying on the source chain; wagmi's when left out. */
  pay?: PayActions;
};

/** The private account the money goes to: its address and network (a RingsSession is one). */
type Account = Pick<RingsSession, "address" | "network">;

function liveDeps(session: RingsSession | Account): SolanaBridgeDeps {
  const lib = () => import("@/lib/solanaRings/arrivals");
  return {
    async quote(body) {
      let res: Response;
      try {
        res = await fetch("/api/bridge/solana", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      } catch {
        throw new Error("Couldn't reach the bridge. Check your connection and try again.");
      }
      const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: SolanaBridgeQuote; error?: { message?: string } } | null;
      if (!json?.ok || !json.data) throw new Error(json?.error?.message ?? "The bridge couldn't make a route right now. Try again.");
      return json.data;
    },
    async status(t) {
      const q = `requestId=${t.requestId}${t.depositAddress ? `&depositAddress=${encodeURIComponent(t.depositAddress)}` : ""}`;
      const res = await fetch(`/api/bridge/status?${q}`, { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: BridgeStatus } | null;
      return json?.ok && json.data ? json.data : null;
    },
    async arrivals() {
      const l = await lib();
      return l.readArrivals(l.proxyRpc, session.address, session.network);
    },
    async makePrivate(a) {
      if (!("keypair" in session)) return { state: "notSent", message: "Open your private account first." };
      return (await lib()).makeArrivalPrivate(session, a);
    },
    store() {
      try {
        return typeof localStorage === "undefined" ? null : localStorage;
      } catch {
        return null;
      }
    },
  };
}

const noopSubscribe = () => () => {};
const noop = () => {};
const assetOf = (id: string, network: RingsNetwork = "mainnet") => ringsAssets(network).find((a) => a.id === id) ?? null;
const ADDRESS_NAME: Record<string, string> = { svm: "Solana", tvm: "Tron", bvm: "Bitcoin" };
/** The few logos the card shows before "+N more". */
const FEATURED = [1, 8453, 4663, 56, 8253038, 42161, 728126428];

// ---------------------------------------------------------------- money waiting at the private account

function ArrivalsNotice({
  list,
  network,
  busy,
  errors,
  onMake,
}: {
  list: readonly Arrival[];
  network: RingsNetwork;
  busy: string | null;
  errors: Record<string, string>;
  onMake: (a: Arrival) => void;
}) {
  if (!list.length) return null;
  return (
    <div className="gl-card p-5" aria-live="polite">
      <p className="text-[13px] text-mute">Not private yet</p>
      <ul className="mt-3 grid gap-3">
        {list.map((a) => {
          const asset = assetOf(a.assetId, network);
          if (!asset) return null;
          const key = `${a.assetId}:${a.tokenAccount ?? ""}`;
          const working = busy === key;
          return (
            <li key={key}>
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[14px] leading-relaxed text-foreground">
                <TokenMark src={`/brand/tokens/${asset.id}.png`} size={18} />
                <span className="tnum font-medium">
                  {ringsAmount(a.amount, asset.decimals)} {asset.symbol}
                </span>
                arrived and isn&apos;t private yet.
              </p>
              {errors[key] && (
                <p role="alert" className="mt-2 rounded-xl bg-danger-soft px-4 py-3 text-[13px] leading-relaxed text-danger">
                  {errors[key]}
                </p>
              )}
              <button type="button" onClick={() => onMake(a)} disabled={busy !== null} className="btn btn-ink btn-sm mt-3">
                {working ? "Making it private…" : "Make it private"}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[12px] leading-relaxed text-mute">Gloam pays the Solana fee. Adding it shows your private account, the asset and the amount.</p>
    </div>
  );
}

/** Make-it-private for whatever `list` holds, one at a time, with its own errors. */
function useMakePrivate(deps: SolanaBridgeDeps, refresh: () => void, onPrivate?: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const make = useCallback(
    async (a: Arrival) => {
      const key = `${a.assetId}:${a.tokenAccount ?? ""}`;
      setBusy(key);
      setErrors((e) => ({ ...e, [key]: "" }));
      try {
        const r = await deps.makePrivate(a);
        if (r.state === "landed" || r.state === "none") onPrivate?.();
        else setErrors((e) => ({ ...e, [key]: r.message }));
      } catch (err) {
        setErrors((e) => ({ ...e, [key]: err instanceof Error ? err.message : "Something went wrong on Solana. Try again." }));
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [deps, refresh, onPrivate]
  );
  return { busy, errors, make };
}

/**
 * Money at the private account's own address that isn't private yet: a
 * transfer from another chain that arrived while Gloam was closed, or anything
 * sent there in the open. Renders nothing when there is none.
 */
export function SolanaArrivals({ session, onPrivate, deps: override }: { session: RingsSession | Account; onPrivate?: () => void; deps?: Partial<SolanaBridgeDeps> }) {
  const deps = useMemo(() => ({ ...liveDeps(session), ...override }), [session, override]);
  const [list, setList] = useState<Arrival[]>([]);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let live = true;
    const look = () =>
      void deps
        .arrivals()
        .then((l) => live && setList(l))
        .catch(() => {
          /* the next look tries again */
        });
    look();
    const t = window.setInterval(look, 30_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [deps, tick]);
  const { busy, errors, make } = useMakePrivate(deps, refresh, onPrivate);
  return <ArrivalsNotice list={list} network={session.network} busy={busy} errors={errors} onMake={(a) => void make(a)} />;
}

// ---------------------------------------------------------------- the card and its transfer

/**
 * "Money on another chain?" on Add, for a private account on Solana. Follows
 * the transfer it started (here or before a reload) until its money is
 * private, and shows anything else waiting at the account.
 */
export function SolanaBridgeIn({
  session,
  ready = {},
  relayFunded = true,
  onPrivate,
  deps: override,
}: {
  session: RingsSession | Account;
  /** Which assets are set up on Gloam (client assetsReady). */
  ready?: Record<string, boolean>;
  relayFunded?: boolean;
  onPrivate?: () => void;
  deps?: Partial<SolanaBridgeDeps>;
}) {
  const deps = useMemo(() => ({ ...liveDeps(session), ...override }), [session, override]);
  const key = trackedKey(session.network, session.address);
  const [flow, dispatch] = useReducer(flowReducer, undefined, (): Flow => {
    const t = loadTracked(deps.store(), key);
    return t && trackedLive(t, Date.now()) ? { kind: "track", t, relay: "waiting", shield: { kind: "idle" }, qr: null } : FORM;
  });
  const [opened, setOpen] = useState(false);
  // Connecting a wallet from the sheet: it steps aside for the sign-in or
  // WalletConnect sheet, and comes back with the wallet paying once one is here.
  const [resume, setResume] = useState(false);
  const { address: evm } = useAccount();
  const open = opened || (resume && Boolean(evm));
  const { connect, connectors, isPending: connectPending, error: connectFailed } = useConnect();
  const [wc, setWc] = useState<{ shown: boolean; open: boolean }>({ shown: false, open: false });
  const closeWc = useCallback(() => setWc((w) => ({ ...w, open: false })), []);
  const connectWallet = useCallback(() => {
    const viaApp = prefersWalletConnect();
    // A browser wallet in this browser, as the wallet menu picks it.
    const browserWallet = connectors.find((c) => c.id !== EMBEDDED_CONNECTOR_ID && c.id !== WALLETCONNECT_ID && !isTempoWallet(c));
    const viaWallet = () => {
      if (viaApp) setWc({ shown: true, open: true });
      else if (browserWallet) connect({ connector: browserWallet });
    };
    if (EMBEDDED_WALLETS && embeddedAvailability() !== "unavailable") {
      setOpen(false);
      setResume(true);
      openSignInSheet({ onUseWallet: viaWallet, walletLabel: viaApp ? "Use a wallet app" : "Use a browser wallet" });
    } else if (viaApp) {
      setOpen(false);
      setResume(true);
      viaWallet();
    } else {
      viaWallet();
    }
  }, [connect, connectors]);
  const [arrivals, setArrivals] = useState<Arrival[]>([]);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const tracked = flow.kind === "track" ? flow.t : null;
  const landingId = tracked?.receive.assetId ?? null;
  const landing = useRef<Arrival | null>(null);

  // Kept in this browser while there is a transfer to follow; gone once it is private or started over.
  useEffect(() => {
    saveTracked(deps.store(), key, flow.kind === "track" ? flow.t : null);
  }, [deps, key, flow]);

  // Relay's word, every 5 seconds, until it is finished or the money is here.
  const askRelay = watchingRelay(flow);
  useEffect(() => {
    if (!askRelay || !tracked) return;
    let live = true;
    const check = () =>
      void deps
        .status(tracked)
        .then((st) => live && st && dispatch({ type: "status", stage: st.stage }))
        .catch(() => {
          /* the next check tries again */
        });
    check();
    const t = window.setInterval(check, 5_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [askRelay, tracked, deps]);

  // The private account's address: every 5 seconds while a transfer is on its way, else every 30.
  const following = watchingArrivals(flow);
  useEffect(() => {
    let live = true;
    const look = () =>
      void deps
        .arrivals()
        .then((list) => {
          if (!live) return;
          setArrivals(list);
          if (!landingId) return;
          const mine = list.filter((a) => a.assetId === landingId);
          landing.current = mine[0] ?? null;
          dispatch(mine.length ? { type: "arrived", amount: mine.reduce((s, a) => s + a.amount, 0n) } : { type: "gone" });
        })
        .catch(() => {
          /* the next look tries again */
        });
    look();
    const t = window.setInterval(look, following ? 5_000 : 30_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [deps, following, landingId, tick]);

  // Arrived: make it private at once. Gloam's relay pays; the money waits at the account if it can't.
  const shielding = useRef(false);
  const shield = useCallback(async () => {
    if (shielding.current || flow.kind !== "track") return;
    const t = flow.t;
    const here = landing.current;
    shielding.current = true;
    dispatch({ type: "shielding" });
    try {
      const r = await deps.makePrivate({ assetId: t.receive.assetId, tokenAccount: here?.tokenAccount ?? null });
      if (r.state === "landed" || r.state === "none") {
        const amount = flow.shield.kind === "idle" ? 0n : flow.shield.amount;
        dispatch({ type: "shielded", amount, signature: r.state === "landed" ? r.signature : null });
        track("bridge_private_landed", { source: t.send.chain, token: t.send.symbol, dest: "solana" });
        onPrivate?.();
      } else {
        dispatch({ type: "shieldFailed", message: r.message });
      }
    } catch (err) {
      dispatch({ type: "shieldFailed", message: err instanceof Error ? err.message : "Something went wrong on Solana. Try again." });
    } finally {
      shielding.current = false;
      refresh();
    }
  }, [flow, deps, onPrivate, refresh]);
  useEffect(() => {
    if (flow.kind === "track" && flow.shield.kind === "arrived") void shield();
  }, [flow, shield]);

  // A deposit address picked up again after a reload: draw its code again.
  const needsQr = flow.kind === "track" && flow.t.mode === "address" && !flow.qr && flow.relay === "waiting" ? flow.t : null;
  useEffect(() => {
    if (!needsQr) return;
    void import("qrcode")
      .then((QR) => QR.toDataURL(needsQr.depositAddress, { margin: 1, width: 400, errorCorrectionLevel: "M" }))
      .then((qr) => dispatch({ type: "qr", requestId: needsQr.requestId, qr }))
      .catch(() => {
        /* the address and copy button still work */
      });
  }, [needsQr]);

  // Once this transfer's money is here the panel above handles it; until then, anything waiting shows as usual.
  const others = arrivals.filter((a) => !(flow.kind === "track" && flow.shield.kind !== "idle" && a.assetId === landingId));
  const notice = useMakePrivate(deps, refresh, onPrivate);
  const sources = useMemo(() => solanaBridgeSources(), []);
  const featured = FEATURED.filter((id) => sources.some((c) => c.id === id));
  const phase = flow.kind === "track" ? trackPhase(flow) : null;

  return (
    <div className="grid gap-4">
      <ArrivalsNotice list={others} network={session.network} busy={notice.busy} errors={notice.errors} onMake={(a) => void notice.make(a)} />
      <div className="gl-card p-5 sm:p-7">
        <p className="text-[13px] text-mute">Money on another chain?</p>
        <div className="mt-3 flex items-center">
          {featured.map((id, i) => (
            <ChainLogo key={id} id={id} size={28} className={`ring-2 ring-panel ${i > 0 ? "-ml-2" : ""}`} />
          ))}
          <span className="ml-2.5 text-[12.5px] text-mute">+{sources.length - featured.length} more</span>
        </div>
        {flow.kind === "track" && phase ? (
          <>
            <PhaseLine flow={flow} phase={phase} compact />
            <div className="mt-4 flex flex-wrap gap-2">
              {phase === "notPrivate" && (
                <button type="button" onClick={() => void shield()} className="btn btn-ink btn-sm">
                  Make it private
                </button>
              )}
              <button type="button" onClick={() => setOpen(true)} className="btn btn-ghost btn-sm">
                See the transfer
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-3 text-[14px] leading-relaxed text-foreground">
              Bring money over from {sources.length} chains, or straight from an exchange.
            </p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-mute">
              It lands in your private account on Solana and goes private by itself, as {orNames(shownLandingAssets(ready))}. Your
              Solana wallet never appears.
            </p>
            <button type="button" onClick={() => setOpen(true)} className="btn btn-ghost btn-sm mt-4">
              {flow.kind === "landed" ? "See what arrived" : "Bring money over"}
            </button>
          </>
        )}
      </div>
      <BridgeSheet
        open={open}
        account={session}
        flow={flow}
        dispatch={dispatch}
        deps={deps}
        ready={ready}
        relayFunded={relayFunded}
        waiting={(id) => arrivals.filter((a) => a.assetId === id).reduce((sum, a) => sum + a.amount, 0n)}
        onRetry={() => void shield()}
        onConnect={connectWallet}
        connecting={connectPending}
        connectError={connectFailed ? walletErrorText(connectFailed) || "Couldn't connect the wallet. Try again." : null}
        onClose={() => {
          setOpen(false);
          setResume(false);
          if (flow.kind === "landed") dispatch({ type: "reset" });
        }}
      />
      {wc.shown && <WalletConnectSheet open={wc.open} onClose={closeWc} />}
    </div>
  );
}

// ---------------------------------------------------------------- where it stands

function phaseText(flow: Extract<Flow, { kind: "track" }>, phase: ReturnType<typeof trackPhase>): string {
  const t = flow.t;
  const lands = `${t.receive.symbol}`;
  switch (phase) {
    case "waiting":
      return t.mode === "wallet"
        ? t.unsure
          ? "Checking whether your wallet sent it…"
          : `Sent from your wallet. Waiting for ${t.send.chain} to confirm…`
        : `Waiting for your ${t.send.symbol} on ${t.send.chain}…`;
    case "moving":
      return `Received. Sending it to your private account on Solana as ${lands}…`;
    case "arrived":
      return flow.shield.kind === "idle" ? "Delivered on Solana. Making it private as soon as Solana shows it…" : "Arrived. Making it private…";
    case "shielding":
      return "Making it private…";
    case "notPrivate":
      return `It's in your private account on Solana, not private yet. ${flow.shield.kind === "failed" ? flow.shield.message : ""}`.trim();
    case "refunded":
      return `The transfer didn't go through. Relay sent it back to ${refundPlace(t)}.`;
    case "failed":
      return `The transfer didn't go through. Relay returns the money to ${refundPlace(t)}.`;
  }
}

function PhaseLine({ flow, phase, compact = false }: { flow: Extract<Flow, { kind: "track" }>; phase: ReturnType<typeof trackPhase>; compact?: boolean }) {
  const bad = phase === "refunded" || phase === "failed";
  const warn = phase === "notPrivate";
  return (
    <p
      className={`${compact ? "mt-3" : "mt-4"} flex items-start gap-2.5 rounded-2xl bg-surface px-4 py-3 text-[13.5px] leading-relaxed ${
        bad ? "text-danger" : warn ? "text-warn" : "text-foreground"
      }`}
    >
      <span
        aria-hidden
        className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${bad ? "bg-danger" : warn ? "bg-warn" : "animate-pulse bg-foreground/50"}`}
      />
      {phaseText(flow, phase)}
    </p>
  );
}

function arrivesText(q: { timeSec: number; bitcoin: boolean }): string {
  if (q.bitcoin) return "After Bitcoin confirms, usually 10 to 30 min";
  return q.timeSec > 0 && q.timeSec < 60 ? "In under a minute" : `In about ${Math.max(1, Math.round(q.timeSec / 60))} min`;
}

/** The rows every screen of a transfer shows: what lands, the fees, when. */
function QuoteRows({
  q,
  sentRow,
  returned = false,
}: {
  q: Pick<SolanaBridgeQuote, "receive" | "feeUsd" | "appFee" | "timeSec" | "bitcoin"> & {
    gasUsd?: number | null;
    send: SolanaBridgeQuote["send"];
    /** The connected wallet pays, so its network fee shows in the wallet. */
    walletPays?: boolean;
  };
  sentRow?: boolean;
  /** Relay sent it back: nothing lands. */
  returned?: boolean;
}) {
  const gas: [string, React.ReactNode][] =
    q.gasUsd != null && q.gasUsd >= 0.01
      ? [["Network fee", `about $${fmtMoney(q.gasUsd)} on ${q.send.chain}`]]
      : q.walletPays
        ? [["Network fee", `Shown in your wallet, on ${q.send.chain}`]]
        : [];
  const lands: [string, React.ReactNode] = [
    "Added privately, about",
    <span key="a" className="flex items-center gap-1.5 font-medium">
      <TokenMark src={q.receive.logo} size={18} />
      {displayAmountText(q.receive.amount)}{" "}
      {q.receive.symbol}
    </span>,
  ];
  // Once it is paid, only what was sent, what lands and what it cost: the rest was for deciding.
  const rows: [string, React.ReactNode][] = sentRow
    ? [["Sent", `${typedAmount(q.send.amount)} ${q.send.symbol} on ${q.send.chain}`], ...(returned ? [] : [lands]), ...feeRows(q, "Relay fee")]
    : [
        lands,
        ["At least", `${displayAmountText(q.receive.minimum)} ${q.receive.symbol}`],
        ...feeRows(q, "Relay fee"),
        ...gas,
        ["Making it private", "Free, Gloam pays the Solana fee"],
        ["Arrives", arrivesText(q)],
      ];
  return (
    <dl className="mt-4 divide-y divide-line text-[14px]">
      {rows.map(([k, v]) => (
        <div key={k} className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">{k}</dt>
          <dd className="tnum text-right text-foreground">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The live price under the amount, before anything is asked of the wallet:
 * what lands privately, Relay's fee (and Gloam's when it takes one), the
 * network fee when the wallet pays, when it arrives, and the cost warning when
 * the route takes a large share. Relay delivers exactly what the amount buys
 * (exact input), so nothing comes back and there is no leftover line here.
 */
function LivePrice({
  quote,
  error,
  walletPays,
  onRetry,
}: {
  quote: SolanaBridgeQuote | null;
  error: string | null;
  walletPays: boolean;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <div role="alert" className="flex items-start justify-between gap-3 rounded-xl bg-danger-soft px-4 py-3 text-[13px] leading-relaxed text-danger">
        <p className="min-w-0 py-1">{error}</p>
        <button type="button" onClick={onRetry} className="-my-0.5 min-h-10 shrink-0 rounded-lg px-1 font-medium underline underline-offset-4">
          Try again
        </button>
      </div>
    );
  }
  const wait = <span aria-hidden className="inline-block h-3.5 w-20 animate-pulse rounded bg-foreground/10" />;
  const gas: [string, React.ReactNode][] = !walletPays
    ? []
    : quote?.gasUsd != null && quote.gasUsd >= 0.01
      ? [["Network fee", `about $${fmtMoney(quote.gasUsd)} on ${quote.send.chain}`]]
      : [["Network fee", "Shown in your wallet"]];
  const rows: [string, React.ReactNode][] = [
    ["At least", quote ? `${displayAmountText(quote.receive.minimum)} ${quote.receive.symbol}` : wait],
    ...(quote ? feeRows(quote, "Relay fee") : ([["Relay fee", wait]] as [string, React.ReactNode][])),
    ...gas,
    ["Arrives", quote ? arrivesText(quote) : wait],
  ];
  return (
    <div aria-live="polite" aria-busy={!quote}>
      <div className="rounded-2xl bg-surface px-4">
        <p className="flex min-h-12 flex-wrap items-center gap-x-1.5 gap-y-1 py-2.5 text-[14px] leading-relaxed text-foreground">
          {quote ? (
            <>
              You get about
              <TokenMark src={quote.receive.logo} size={18} />
              <span className="tnum font-medium">
                {displayAmountText(quote.receive.amount)} {quote.receive.symbol}
              </span>
              in your private balance
            </>
          ) : (
            <span className="text-mute">Getting a price…</span>
          )}
        </p>
        <dl className="divide-y divide-line border-t border-line text-[13.5px]">
          {rows.map(([k, v]) => (
            <div key={k} className="flex min-h-10 items-center justify-between gap-3">
              <dt className="text-mute">{k}</dt>
              <dd className="tnum text-right text-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      {quote && <CostWarning quote={costedQuote(quote)} />}
    </div>
  );
}

/** A transaction's page on the source chain's explorer, when the app knows one. */
function txLink(chainId: number, hash: string): string | null {
  const url = originChain(chainId)?.blockExplorers?.default.url;
  return url ? `${url.replace(/\/$/, "")}/tx/${hash}` : null;
}

// ---------------------------------------------------------------- the sheet

function BridgeSheet({
  open,
  account,
  flow,
  dispatch,
  deps,
  ready,
  relayFunded,
  waiting,
  onRetry,
  onConnect,
  connecting,
  connectError,
  onClose,
}: {
  open: boolean;
  account: Account;
  flow: Flow;
  dispatch: React.Dispatch<Parameters<typeof flowReducer>[1]>;
  deps: SolanaBridgeDeps;
  ready: Record<string, boolean>;
  relayFunded: boolean;
  /** How much of an asset is already waiting at the account, so only more counts as this transfer arriving. */
  waiting: (assetId: string) => bigint;
  onRetry: () => void;
  /** Connect an EVM wallet to pay from (the sheet may step aside for it). */
  onConnect: () => void;
  connecting: boolean;
  connectError: string | null;
  onClose: () => void;
}) {
  const reduce = useReducedMotion();
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const sources = useMemo(() => solanaBridgeSources(), []);
  const [chain, setChain] = useState<BridgeChain>(() => sources[0]!);
  const [symbol, setSymbol] = useState(() => sources[0]!.tokens[0]!.symbol);
  const token = chain.tokens.find((t) => t.symbol === symbol) ?? chain.tokens[0]!;
  const [landingPick, setLanding] = useState<string | null>(null);
  const landing = landingPick && ready[landingPick] !== false ? landingPick : defaultLanding(token, ready);
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState("");
  const [amount, setAmount] = useState("");
  const [copied, setCopied] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const onMainnet = account.network === "mainnet";

  // The connected EVM wallet pays when it can switch to the chain picked (a browser
  // wallet, a wallet app or a Gloam wallet): that is the default. A deposit address
  // (an exchange, another wallet) is one tap away, and the only way from Tron or Bitcoin.
  const config = useConfig();
  const { address: evm, connector, status: evmStatus } = useAccount();
  const onChain = config.chains.some((c) => c.id === chain.id);
  const walletState: WalletState = !evm ? "none" : walletPaysAcrossChains(connector?.type) && onChain ? "pays" : "cannot";
  const [wantAddress, setWantAddress] = useState(false);
  const route = payRoute({ chainKind: chain.kind, wallet: walletState, wantAddress });
  const walletPays = route === "wallet" && Boolean(evm);

  // Where a failed transfer goes back to: the paying wallet, else the address in the
  // field, which starts as the connected wallet or the one used here last time.
  const refunds = refundKey(account.network, account.address);
  const [remembered] = useState<RememberedRefunds>(() => loadRefunds(deps.store(), refunds));
  const [typed, setTyped] = useState<RememberedRefunds>({});
  const refundField = typed[chain.kind] ?? (chain.kind === "evm" && evm ? evm : (remembered[chain.kind] ?? ""));
  const refundTo = walletPays && evm ? evm : refundField.trim();

  // The wallet's balance of the picked token on that chain, so the amount isn't a guess (and Max).
  const nativeToken = token.address === "0x0000000000000000000000000000000000000000";
  const readable = open && chain.kind === "evm" && onChain && Boolean(evm) && isAddress(evm ?? "");
  const srcToken = useReadContract({
    address: token.address as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [(evm ?? "0x0000000000000000000000000000000000000000") as Address],
    chainId: chain.id as GloamChainId,
    query: { enabled: readable && !nativeToken, retry: 1 },
  });
  const srcCoin = useBalance({ address: evm as Address | undefined, chainId: chain.id as GloamChainId, query: { enabled: readable && nativeToken, retry: 1 } });
  const srcRead = nativeToken ? srcCoin : srcToken;
  const srcBalance: bigint | null = readable && !srcRead.isError ? ((nativeToken ? srcCoin.data?.value : srcToken.data) ?? null) : null;

  const dismiss = useCallback(() => (picking ? setPicking(false) : onClose()), [picking, onClose]);
  useModalFocus(panel, dismiss, { open: open && mounted });
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? sources.filter((c) => c.name.toLowerCase().includes(q) || c.tokens.some((t) => t.symbol.toLowerCase().includes(q))) : sources;
  }, [search, sources]);

  const amountNum = Number(amount);
  const amountOk = /^\d+(\.\d+)?$/.test(amount) && (token.stable ? amountNum >= BRIDGE_MIN_USD && amountNum <= BRIDGE_MAX_USD : amountNum > 0);
  const overSource = srcBalance != null && amountOk && amountNum > Number(formatUnits(srcBalance, token.decimals));
  const refundOk = validRefundAddress(chain.kind, refundTo);
  const landingReady = ready[landing] !== false;
  const addressName = ADDRESS_NAME[chain.kind] ?? chain.name;
  // The main button says what it does, or what is missing first.
  const button = bridgeButton({
    route,
    busy: flow.kind === "quoting",
    onMainnet,
    landingReady,
    amount,
    stable: Boolean(token.stable),
    symbol: token.symbol,
    overSource,
    refund: refundField,
    refundOk,
    addressName,
  });
  const canAsk = button.ready && flow.kind === "form";
  const walletConnecting = connecting || evmStatus === "connecting" || evmStatus === "reconnecting";

  // The live price under the amount, as soon as one is typed: what lands, the fees, when.
  // Asked after a pause in typing, again every 20 seconds, and whenever what it depends on
  // changes. A price only: no deposit address and nothing to sign (the route's `preview`).
  const priceAsk = useMemo(() => {
    if (!open || picking || flow.kind !== "form" || !onMainnet || !landingReady || !amountOk) return null;
    return {
      chainId: chain.id,
      symbol: token.symbol,
      asset: landing,
      amount: amount.trim(),
      recipient: account.address,
      preview: true,
      ...(walletPays && evm ? { sender: evm } : {}),
    };
  }, [open, picking, flow.kind, onMainnet, landingReady, amountOk, chain.id, token.symbol, landing, amount, account.address, walletPays, evm]);
  const priceKey = priceAsk ? JSON.stringify(priceAsk) : null;
  const [price, setPrice] = useState<{ key: string; quote: SolanaBridgeQuote | null; error: string | null } | null>(null);
  const [priceTick, setPriceTick] = useState(0);
  useEffect(() => {
    if (!priceAsk || !priceKey) return;
    let live = true;
    const t = window.setTimeout(() => {
      void deps
        .quote(priceAsk)
        .then((quote) => live && setPrice({ key: priceKey, quote, error: null }))
        .catch((err) => live && setPrice({ key: priceKey, quote: null, error: err instanceof Error ? err.message : "Couldn't get a price. Try again." }));
    }, LIVE_PRICE_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [priceAsk, priceKey, deps, priceTick]);
  useEffect(() => {
    if (!priceKey) return;
    const t = window.setInterval(() => setPriceTick((n) => n + 1), LIVE_PRICE_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [priceKey]);
  // The price for what is on screen now; an older one stays up while a refresh of the same ask is on its way.
  const livePrice = priceKey && price?.key === priceKey ? price : null;
  const retryPrice = useCallback(() => {
    setPrice(null);
    setPriceTick((n) => n + 1);
  }, []);

  function body(extra: Record<string, unknown>) {
    return { chainId: chain.id, symbol: token.symbol, asset: landing, amount, recipient: account.address, ...extra };
  }

  async function getAddress(e?: React.FormEvent) {
    e?.preventDefault();
    if (!canAsk || walletPays || !refundOk) return;
    dispatch({ type: "quoting" });
    try {
      const quote = await deps.quote(body({ refundTo }));
      saveRefund(deps.store(), refunds, chain.kind, refundTo);
      const t = trackedFrom(quote, "address", Date.now(), { baseline: waiting(quote.receive.assetId) });
      dispatch({ type: "track", t });
      track("bridge_address_created", { source: quote.send.chain, token: quote.send.symbol, dest: "solana" });
      void import("qrcode")
        .then((QR) => QR.toDataURL(quote.depositAddress, { margin: 1, width: 400, errorCorrectionLevel: "M" }))
        .then((qr) => dispatch({ type: "qr", requestId: quote.requestId, qr }))
        .catch(() => {
          /* the address and copy button still work */
        });
    } catch (err) {
      dispatch({ type: "quoteFailed", error: err instanceof Error ? err.message : "Couldn't reach the bridge. Check your connection and try again." });
    }
  }

  async function startWallet(e: React.FormEvent) {
    e.preventDefault();
    if (!canAsk || !walletPays || !evm) return;
    dispatch({ type: "quoting" });
    try {
      const quote = await deps.quote(body({ sender: evm }));
      if (!quote.evmTxs?.length) throw new Error("The bridge couldn't make a route right now. Try again.");
      saveRefund(deps.store(), refunds, "evm", evm);
      dispatch({ type: "review", quote, at: Date.now() });
      track("bridge_wallet_review", { source: quote.send.chain, token: quote.send.symbol, dest: "solana" });
    } catch (err) {
      dispatch({ type: "quoteFailed", error: err instanceof Error ? err.message : "Couldn't reach the bridge. Check your connection and try again." });
    }
  }

  /** The wallet signs the approve (for a token), then the deposit, on the source chain. */
  async function confirmWallet() {
    if (flow.kind !== "review" || flow.signing || !evm) return;
    let quote = flow.quote;
    let at = flow.at;
    try {
      // A quote is only good for about a minute: an older one is fetched again.
      if (Date.now() - at > 40_000) {
        dispatch({ type: "signing", progress: "Refreshing the price…" });
        quote = await deps.quote(body({ amount: quote.send.amount, sender: evm }));
        at = Date.now();
      }
    } catch (err) {
      dispatch({ type: "signFailed", error: err instanceof Error ? err.message : "Couldn't refresh the price. Try again." });
      return;
    }
    // The same path as the bridge into a wallet on a Gloam network (lib/relayWalletPay).
    const sentToken = chain.tokens.find((t) => t.symbol === quote.send.symbol) ?? token;
    dispatch({ type: "signing", quote, at, progress: null });
    const paid = await payRelayTxs(
      quote.evmTxs ?? [],
      { amount: quote.send.amount, symbol: quote.send.symbol, chain: quote.send.chain, decimals: sentToken.decimals },
      deps.pay ?? wagmiPayActions(config),
      (progress) => dispatch({ type: "signing", quote, at, progress })
    );
    if (!paid.sent) {
      dispatch({ type: "signFailed", error: paid.error });
      return;
    }
    const hash = paid.hash;
    dispatch({ type: "track", t: trackedFrom(quote, "wallet", Date.now(), { hash, unsure: !hash, baseline: waiting(quote.receive.assetId) }) });
    track("bridge_wallet_sent", { source: quote.send.chain, token: quote.send.symbol, dest: "solana" });
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* the address is selectable text */
    }
  }

  if (!open || !mounted) return null;

  const title = picking ? "Where is the money?" : flow.kind === "landed" ? "" : "Bring money over";
  const subtitle = picking
    ? `${sources.length} chains. Sending from an exchange works too: pick the chain you withdraw on.`
    : flow.kind === "track" || flow.kind === "review"
      ? "Into your private balance on Solana."
      : "From another chain or an exchange, into your private balance on Solana.";

  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="sol-bridge-title">
      <motion.button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        aria-label="Close"
        onClick={onClose}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      />
      <motion.div
        ref={panel}
        tabIndex={-1}
        className="relative z-[1] max-h-[92dvh] w-full max-w-[440px] overflow-y-auto rounded-t-[24px] bg-panel px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-6 shadow-pop outline-none sm:rounded-[24px] sm:px-7 sm:pb-7"
        initial={reduce ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 36 }}
      >
        {flow.kind === "landed" ? (
          <>
            <div className="absolute inset-0 overflow-hidden">
              <SealedField tone="soft" />
            </div>
            <Landed flow={flow} onDone={onClose} />
          </>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 id="sol-bridge-title" className="text-[20px] font-medium tracking-[-0.01em] text-foreground">
                  {title}
                </h2>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-mute">{subtitle}</p>
              </div>
              <button
                type="button"
                onClick={dismiss}
                aria-label={picking ? "Back" : "Close"}
                className="-mr-2 -mt-1 grid h-10 w-10 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {!onMainnet && !picking && (
              <p className="mt-4 rounded-2xl bg-surface px-4 py-3 text-[12.5px] leading-relaxed text-soft">
                Preview. Relay only delivers to Solana mainnet, so this account on {SOLANA_RINGS_NETWORK} can&apos;t receive it.
              </p>
            )}

            {picking && (
              <div className="mt-5">
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search chains or tokens"
                  aria-label="Search chains or tokens"
                  className="gl-input h-12 px-3.5 text-[16px] sm:text-[15px]"
                />
                <ul className="mt-3 grid gap-1">
                  {matches.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setChain(c);
                          setSymbol(c.tokens[0]!.symbol);
                          setLanding(null);
                          setAmount("");
                          setWantAddress(false);
                          setPicking(false);
                          setSearch("");
                        }}
                        aria-current={c.id === chain.id ? "true" : undefined}
                        className={`flex min-h-[56px] w-full items-center gap-3 rounded-2xl px-3 text-left transition-colors hover:bg-surface ${c.id === chain.id ? "bg-surface" : ""}`}
                      >
                        <ChainLogo id={c.id} size={32} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[15px] text-foreground">{c.name}</span>
                          <span className="block truncate text-[12.5px] text-mute">{c.tokens.map((t) => t.symbol).join(", ")}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                  {matches.length === 0 && <li className="rounded-2xl bg-surface px-4 py-4 text-[13.5px] text-mute">No chain matches that. Try another name.</li>}
                </ul>
              </div>
            )}

            {!picking && (flow.kind === "form" || flow.kind === "quoting") && (
              <form onSubmit={walletPays ? startWallet : getAddress} className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-4">
                <div>
                  <p className="text-[13px] text-mute">From</p>
                  <button
                    type="button"
                    onClick={() => setPicking(true)}
                    className="mt-1.5 flex h-14 w-full items-center gap-3 rounded-xl border border-line px-3.5 text-left transition-colors hover:bg-surface"
                  >
                    <ChainLogo id={chain.id} size={28} />
                    <span className="min-w-0 flex-1 text-[15px] text-foreground">{chain.name}</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden className="text-mute">
                      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>

                {chain.tokens.length > 1 && (
                  <div role="radiogroup" aria-label="Token" className="flex flex-wrap gap-2">
                    {chain.tokens.map((t) => (
                      <button
                        key={t.symbol}
                        type="button"
                        role="radio"
                        aria-checked={t.symbol === token.symbol}
                        onClick={() => {
                          setSymbol(t.symbol);
                          setLanding(null);
                          setAmount("");
                        }}
                        className={`inline-flex h-10 items-center gap-2 rounded-full border pl-1.5 pr-3.5 text-[14px] transition-colors ${
                          t.symbol === token.symbol ? "border-foreground text-foreground" : "border-line text-soft hover:bg-surface"
                        }`}
                      >
                        <TokenMark src={t.logo} size={26} />
                        {t.symbol}
                      </button>
                    ))}
                  </div>
                )}

                <div>
                  <p className="text-[13px] text-mute">To your private balance on Solana, as</p>
                  <div role="radiogroup" aria-label="Lands as" className="mt-1.5 flex flex-wrap gap-2">
                    {shownLandingAssets(ready).map((a) => {
                      const off = ready[a.id] === false;
                      return (
                        <button
                          key={a.id}
                          type="button"
                          role="radio"
                          aria-checked={a.id === landing}
                          disabled={off}
                          onClick={() => setLanding(a.id)}
                          className={`inline-flex h-10 items-center gap-2 rounded-full border pl-1.5 pr-3.5 text-[14px] transition-colors disabled:opacity-40 ${
                            a.id === landing ? "border-sealed/60 bg-sealed-soft text-foreground" : "border-line text-soft hover:bg-surface"
                          }`}
                        >
                          <TokenMark src={`/brand/tokens/${a.id}.png`} size={26} />
                          {a.symbol}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label htmlFor="sol-bridge-amount" className="text-[13px] text-mute">
                    Amount to send
                  </label>
                  <div className="gl-inputwrap mt-1.5 flex h-12 items-center gap-2 px-3.5">
                    <input
                      id="sol-bridge-amount"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="tnum min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none! placeholder:text-faint"
                    />
                    <TokenMark src={token.logo} size={20} />
                    <span className="text-[14px] text-mute">{token.symbol}</span>
                  </div>
                  <AmountProblem value={amount} decimals={token.decimals} />
                  {readable && (
                    <SourceBalance
                      value={srcBalance}
                      loading={srcRead.isLoading}
                      decimals={token.decimals}
                      symbol={token.symbol}
                      over={overSource ? chain.name : null}
                      // Stablecoins only: a chain's own coin also pays the network fee to send it.
                      onMax={token.stable && srcBalance != null ? () => setAmount(stableMax(srcBalance, token.decimals)) : null}
                    />
                  )}
                  <p className="mt-1.5 text-[12px] text-mute">
                    {token.stable
                      ? `From ${displayAmountNumber(BRIDGE_MIN_USD)} to ${displayAmountNumber(BRIDGE_MAX_USD)} ${token.symbol}.`
                      : `Up to about $${BRIDGE_MAX_USD.toLocaleString("en-US")} worth.`}{" "}
                    All of what arrives goes private.
                  </p>
                </div>

                {priceKey && <LivePrice quote={livePrice?.quote ?? null} error={livePrice?.error ?? null} walletPays={walletPays} onRetry={retryPrice} />}

                {walletPays && evm && (
                  <p className="-mt-1 text-[12.5px] leading-relaxed text-mute">
                    Paying from your wallet <span className="tnum text-soft">{shortAddress(evm)}</span>. If the transfer fails, the money goes back to it.
                  </p>
                )}

                {route === "connect" && (
                  <div>
                    <button type="button" onClick={onConnect} disabled={walletConnecting} className="btn btn-ink btn-lg btn-block">
                      {walletConnecting ? "Connecting…" : "Connect a wallet to pay from it"}
                    </button>
                    {connectError && (
                      <p role="alert" className="mt-2 text-[12.5px] leading-relaxed text-danger">
                        {connectError}
                      </p>
                    )}
                  </div>
                )}

                {!walletPays && (
                  <div>
                    {chain.kind === "evm" && <p className="mb-3 text-[13.5px] text-foreground">{route === "connect" ? "Or send from an exchange or another wallet" : "Send from an exchange or another wallet"}</p>}
                    <label htmlFor="sol-bridge-refund" className="text-[13px] text-mute">
                      Your {addressName} address
                    </label>
                    <input
                      id="sol-bridge-refund"
                      autoComplete="off"
                      spellCheck={false}
                      value={refundField}
                      onChange={(e) => {
                        const v = e.target.value.trim();
                        setTyped((t) => ({ ...t, [chain.kind]: v }));
                      }}
                      placeholder={chain.kind === "evm" ? "0x…" : undefined}
                      className="gl-input tnum mt-1.5 h-12 px-3.5 text-[16px] sm:text-[14px]"
                    />
                    <p className="mt-1.5 text-[12px] text-mute">If the transfer fails, the money goes back here.</p>
                  </div>
                )}

                {flow.kind === "form" && flow.error && (
                  <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-[13px] leading-relaxed text-danger">
                    {flow.error}
                  </p>
                )}
                {!relayFunded && (
                  <p className="rounded-xl bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
                    Gloam&apos;s Solana relay is paused for a moment. Money you bring over waits in your private account until it can go private.
                  </p>
                )}

                <button
                  type="submit"
                  disabled={!canAsk}
                  className={`btn ${route === "connect" ? "btn-ghost" : "btn-ink"} btn-lg btn-block h-auto min-h-12 whitespace-normal py-3 text-center leading-snug`}
                >
                  {button.label}
                </button>
                {walletPays ? (
                  <button
                    type="button"
                    onClick={() => setWantAddress(true)}
                    className="-mt-1 min-h-10 text-center text-[13px] text-mute underline-offset-4 transition-colors hover:text-foreground hover:underline"
                  >
                    Or send from an exchange or another wallet
                  </button>
                ) : (
                  wantAddress &&
                  walletState === "pays" &&
                  chain.kind === "evm" && (
                    <button
                      type="button"
                      onClick={() => setWantAddress(false)}
                      className="-mt-1 min-h-10 text-center text-[13px] text-mute underline-offset-4 transition-colors hover:text-foreground hover:underline"
                    >
                      Pay from your wallet instead
                    </button>
                  )
                )}
                <p className="text-center text-[12px] leading-relaxed text-mute">
                  {SOLANA_BRIDGE_PRIVACY_NOTE} <PoweredByRelay />
                </p>
              </form>
            )}

            {!picking && flow.kind === "review" && (
              <div className="mt-5" aria-live="polite">
                <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[14px] leading-relaxed text-foreground">
                  Bridge
                  <TokenMark src={flow.quote.send.logo} size={18} />
                  <span className="tnum font-medium">
                    {typedAmount(flow.quote.send.amount)} {flow.quote.send.symbol}
                  </span>
                  from your wallet on
                  <ChainLogo id={flow.quote.send.chainId} size={18} />
                  {flow.quote.send.chain}
                </p>
                <QuoteRows q={{ ...flow.quote, walletPays: true }} />
                <CostWarning quote={costedQuote(flow.quote)} />
                {flow.signing && flow.progress && (
                  <p className="mt-4 flex items-center gap-2.5 rounded-2xl bg-surface px-4 py-3 text-[13.5px] text-foreground">
                    <span aria-hidden className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-foreground/50" />
                    {flow.progress}
                  </p>
                )}
                {flow.error && (
                  <p role="alert" className="mt-4 rounded-xl bg-danger-soft px-4 py-3 text-[13px] leading-relaxed text-danger">
                    {flow.error}
                  </p>
                )}
                <button type="button" onClick={() => void confirmWallet()} disabled={flow.signing} className="btn btn-ink btn-lg btn-block mt-4">
                  {flow.signing ? "Waiting for your wallet…" : (flow.quote.evmTxs?.length ?? 1) > 1 ? "Approve and bridge" : "Confirm in your wallet"}
                </button>
                {!flow.signing && (
                  <button type="button" onClick={() => dispatch({ type: "reset" })} className="btn btn-ghost btn-sm mt-3">
                    Start over
                  </button>
                )}
                <p className="mt-3 text-[12px] leading-relaxed text-mute">
                  It lands in your private account on Solana and goes private by itself. If the bridge can&apos;t finish, Relay returns it to
                  your wallet on {flow.quote.send.chain}.{(flow.quote.evmTxs?.length ?? 1) > 1 && " Your wallet asks twice: once to approve, once to bridge."}
                </p>
              </div>
            )}

            {!picking && flow.kind === "track" && (
              <Tracking flow={flow} copied={copied} onCopy={(a) => void copy(a)} onRetry={onRetry} onReset={() => dispatch({ type: "reset" })} />
            )}
          </>
        )}
      </motion.div>
    </div>,
    document.body
  );
}

function Tracking({
  flow,
  copied,
  onCopy,
  onRetry,
  onReset,
}: {
  flow: Extract<Flow, { kind: "track" }>;
  copied: boolean;
  onCopy: (address: string) => void;
  onRetry: () => void;
  onReset: () => void;
}) {
  const t = flow.t;
  const phase = trackPhase(flow);
  const showAddress = t.mode === "address" && phase === "waiting";
  const link = t.hash ? txLink(t.send.chainId, t.hash) : null;
  return (
    <div className="mt-5" aria-live="polite">
      {showAddress ? (
        <>
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[14px] leading-relaxed text-foreground">
            Send exactly
            <TokenMark src={t.send.logo} size={18} />
            <span className="tnum font-medium">
              {t.send.amount} {t.send.symbol}
            </span>
            on
            <ChainLogo id={t.send.chainId} size={18} />
            {t.send.chain}
            {t.send.usd !== null && !t.send.symbol.startsWith("USD") && <span className="tnum text-mute">(about ${t.send.usd.toFixed(2)})</span>}
          </p>
          {flow.qr && (
            // eslint-disable-next-line @next/next/no-img-element -- a local data URL
            <img
              src={flow.qr}
              alt={`Deposit address on ${t.send.chain}`}
              width={200}
              height={200}
              className="mx-auto mt-4 aspect-square w-full max-w-[200px] rounded-2xl bg-white p-2"
            />
          )}
          <button
            type="button"
            onClick={() => onCopy(t.depositAddress)}
            className="mt-4 flex w-full items-center gap-3 rounded-xl border border-line px-3.5 py-3 text-left transition-colors hover:bg-surface"
          >
            <span className="tnum min-w-0 flex-1 break-all text-[13.5px] text-foreground">{t.depositAddress}</span>
            <span className="shrink-0 text-[13px] font-medium text-foreground">{copied ? "Copied" : "Copy"}</span>
          </button>
        </>
      ) : null}

      <QuoteRows q={{ ...t, gasUsd: null }} sentRow={!showAddress} returned={phase === "refunded" || phase === "failed"} />
      {link && (
        <p className="mt-2 text-[13px]">
          <a href={link} target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4">
            View on {t.send.chain}
          </a>
        </p>
      )}
      {showAddress && (
        <>
          <CostWarning quote={costedQuote({ ...t, gasUsd: null })} />
          <p className="mt-3 text-[12.5px] leading-relaxed text-mute">
            Send only {t.send.symbol} on {t.send.chain}, and use this address for this transfer only. Sending from an exchange works too.
          </p>
        </>
      )}

      <PhaseLine flow={flow} phase={phase} />

      {phase === "notPrivate" ? (
        <>
          <button type="button" onClick={onRetry} className="btn btn-ink btn-lg btn-block mt-4">
            Make it private
          </button>
          <p className="mt-3 text-[12px] leading-relaxed text-mute">It stays in your private account until then, and shows on your balance.</p>
        </>
      ) : phase === "refunded" || phase === "failed" ? (
        <button type="button" onClick={onReset} className="btn btn-ghost btn-sm mt-4">
          Start over
        </button>
      ) : (
        <>
          <p className="mt-3 text-[12px] leading-relaxed text-mute">
            You can close this. It goes private as it arrives while Gloam is open. If you leave, it waits in your private account until
            you&apos;re back.
          </p>
          {phase === "waiting" && (
            <button type="button" onClick={onReset} className="btn btn-ghost btn-sm mt-3">
              Start over
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** The money is in the private balance: the same receipt as every other success. */
function Landed({ flow, onDone }: { flow: Extract<Flow, { kind: "landed" }>; onDone: () => void }) {
  const receipt = useRef<HTMLDivElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  useModalFocus(receipt, noop, { initial: done });
  const asset = assetOf(flow.t.receive.assetId);
  const amount = asset && flow.amount > 0n ? ringsAmount(flow.amount, asset.decimals) : displayAmountText(flow.t.receive.amount);
  return (
    <div ref={receipt} className="relative pt-3 text-center">
      <SuccessReceipt
        titleId="sol-bridge-title"
        title="Added privately"
        logo={<TokenMark src={flow.t.receive.logo} size={56} />}
        amount={
          <>
            {amount} <span className="text-[16px] tracking-normal text-mute">{flow.t.receive.symbol}</span>
          </>
        }
        body="Only you can see it."
      />
      <button ref={done} type="button" onClick={onDone} className="btn btn-ink btn-lg btn-block mt-8">
        Done
      </button>
    </div>
  );
}
