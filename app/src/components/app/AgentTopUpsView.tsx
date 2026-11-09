"use client";

/**
 * Vault > Agent top-ups (lib/agentTopUp): refill an AI agent's wallet from the
 * private balance on a schedule, with Gloam closed. On the left the one form
 * and what it costs; on the right what is coming and what went. It says once,
 * where the owner confirms, what shows on the chain: each top-up is a public
 * cash out, and only where the money came from stays private.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ELYSIUM_ENABLED } from "@/lib/elysium";
import { CASH_OUT_FEE_BPS } from "@gloamtrade/sdk";
import { isAddress, type Address } from "viem";
import { useReadContract } from "wagmi";
import { Select } from "@/components/ui/Select";
import { useLocalShieldNotes } from "@/hooks/useLocalShieldNotes";
import {
  TOP_UPS_MIN,
  agentGasLine,
  cancelTopUp,
  finishTopUps,
  fundingWaitLine,
  largestTopUpNote,
  mostTopUps,
  moveLooseProofs,
  pickReadyNote,
  readVaultLeaves,
  reconcileTopUps,
  setUpTopUps,
  topUpAhead,
  topUpAmountProblem,
  topUpCandidates,
  topUpDayLabel,
  topUpDays,
  topUpMinutes,
  topUpRows,
  topUpSeries,
  topUpSetAside,
  topUpTotals,
  topUpWhen,
  type TopUpEvery,
  type TopUpRow,
  type TopUpSeries,
  type VaultLeaves,
} from "@/lib/agentTopUp";
import { shortAddress } from "@/lib/chain";
import { feeMoved, feeRise, feeRiseLine } from "@/lib/cashOutLater";
import { findCashOutLink, linkMessage } from "@/lib/cashOutPlan";
import { cashOutPrivacyWarnings } from "@/lib/cashOutPrivacy";
import { keepPiece, schedulePiece, unscheduledPieces } from "@/lib/cashOutPrivately";
import { cashOutTargetProblem } from "@/lib/cashOutTarget";
import { useAppAccount, useDemo } from "@/lib/demo";
import { countPerson } from "@/lib/people";
import { relayFor, type RelayNetworkStatus } from "@/lib/relay/client";
import { DATED_KEY_OFF_MESSAGE, DATED_OFF_MESSAGE, datedOff } from "@/lib/relay/scheduled";
import { webhookUrlProblem } from "@/lib/relay/webhookUrl";
import { publicClientFor } from "@/lib/rhClient";
import { SCREEN_BLOCKED_MESSAGE } from "@/lib/screening";
import { screenWallets } from "@/lib/screeningClient";
import {
  HASH_SCHEME,
  assetDecimals,
  formatAssetLabel,
  formatFeePercent,
  parseAssetAmount,
  shieldPoolAbi,
  type LocalNote,
} from "@/lib/shield";
import { checkSweep, type SweepReader } from "@/lib/sweepCheck";
import { shieldTokensFor } from "@/lib/tokens";
import { CashOutWarnings } from "./CashOutPrivacy";
import { useNetwork } from "./NetworkProvider";
import { CashOutLinkNote } from "./PrivateCashOut";
import { RelayGasNotice } from "./RelayGasNotice";
import { TokenLogo } from "./TokenLogo";
import { WalletMenu } from "./WalletMenu";

/** The older testnet pools carry no cash-out fee; every other network must report its fee first. */
const NO_FEE_CHAINS = new Set<number>([46630, 42431]);
/** What the recording demo shows: the mainnet fee, with no pool to read it from. */
const DEMO_FEE_BPS = CASH_OUT_FEE_BPS;
/** How many past top-ups show. */
const PAST_SHOWN = 12;

/** A UTC day as its date in the owner's calendar: midday lands on it in almost every timezone. */
function midday(day: number): number {
  return day + 12 * 3_600_000;
}

const PACES: [TopUpEvery, string][] = [
  ["week", "Every week"],
  ["2weeks", "Every 2 weeks"],
];

export function AgentTopUpsView() {
  const { address, isConnected } = useAppAccount();
  const { network, setNetworkKey } = useNetwork();
  const demoMode = useDemo();
  const { open, local, refresh } = useLocalShieldNotes(address);

  const [agent, setAgent] = useState("");
  const [tokenId, setTokenId] = useState<string | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [every, setEvery] = useState<TopUpEvery>("week");
  const [countPick, setCountPick] = useState(4);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  /** The series being set up: how many are done of how many. */
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [relay, setRelay] = useState<RelayNetworkStatus | null>(null);
  const [relayChecked, setRelayChecked] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [vault, setVault] = useState<VaultLeaves | null>(null);
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertUrl, setAlertUrl] = useState("");

  const { data: feeBpsRead, refetch: refetchFee } = useReadContract({
    address: network.pool ?? undefined,
    abi: shieldPoolAbi,
    functionName: "withdrawFeeBps",
    chainId: network.chainId,
    query: { enabled: Boolean(network.pool) && !demoMode, refetchInterval: 60_000 },
  });
  const liveFeeBps = !demoMode && typeof feeBpsRead === "number" ? feeBpsRead : null;
  const feeBps = demoMode ? DEMO_FEE_BPS : (liveFeeBps ?? 0);
  const feeUnknown = !demoMode && !NO_FEE_CHAINS.has(network.chainId) && typeof feeBpsRead !== "number";

  useEffect(() => {
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- each network's relay is checked anew; the button waits until the answer comes back
    setRelayChecked(false);
    void relayFor(network.chainId).then((r) => {
      if (!live) return;
      setRelay(r);
      setRelayChecked(true);
    });
    return () => {
      live = false;
    };
  }, [network.chainId]);
  const relayOk = Boolean(relay?.enabled);
  const gasHigh = Boolean(relay?.gasHigh);

  // What the relay holds, read on arrival: top-ups go out while the app is closed.
  useEffect(() => {
    void reconcileTopUps()
      .then((changed) => changed && refresh())
      .catch(() => false)
      // a cancel the tab closed on: nothing can spend that note until this has moved it
      .then(() => moveLooseProofs())
      .catch(() => {})
      .finally(refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network.key]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  // Closing the tab mid-way loses nothing, but it stops the series part way.
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  // A locked screen stops the run part way, so while it runs the screen stays on where the browser allows it.
  useEffect(() => {
    if (!busy) return;
    let lock: WakeLockSentinel | null = null;
    let ended = false;
    void navigator.wakeLock
      ?.request("screen")
      .then((l) => {
        if (ended) void l.release();
        else lock = l;
      })
      .catch(() => {
        /* refused or not offered: the run goes on, and a stop loses nothing */
      });
    return () => {
      ended = true;
      void lock?.release().catch(() => {});
    };
  }, [busy]);

  const tokens = useMemo(() => shieldTokensFor(network.chainId).filter((t) => t.kind === "stablecoin"), [network.chainId]);
  const biggest = useMemo(
    () => [...tokens].sort((a, b) => (largestTopUpNote(open, b.address) > largestTopUpNote(open, a.address) ? 1 : -1))[0] ?? null,
    [tokens, open]
  );
  const token = tokens.find((t) => t.id === tokenId) ?? biggest;

  const most = mostTopUps(every);
  const count = Math.min(countPick, most);
  const parsed = token && amountInput.trim() ? parseAssetAmount(amountInput.trim(), token.address) : null;
  const amount = parsed !== null && parsed > 0n ? parsed : null;
  const amountBad = amountInput.trim() !== "" && amount === null;
  const totals = amount !== null ? topUpTotals(amount, count, feeBps) : null;
  const largest = token ? largestTopUpNote(open, token.address) : 0n;
  const covering = token && totals ? topUpCandidates(open, token.address, totals.total) : [];
  const probe = covering[0] ?? null;
  // The vault as the chain has it: the same check runs again when the series starts.
  useEffect(() => {
    if (!probe) return;
    let live = true;
    void readVaultLeaves(probe).then(
      (v) => live && setVault(v),
      () => live && setVault(null)
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe?.id, now]);
  const pick = vault && covering.length ? pickReadyNote(covering, local, vault, now) : null;
  const source = pick?.note ?? null;
  const fundingWait = pick?.wait && !pick.wait.ok ? fundingWaitLine(pick.wait, now) : null;
  const alertClean = alertUrl.trim();
  const alertProblem = alertClean ? webhookUrlProblem(alertClean) : null;
  const days = topUpDays(now, every, count);

  const agentClean = agent.trim();
  const agentOk = isAddress(agentClean);
  const targetProblem = agentOk ? cashOutTargetProblem(agentClean, network) : null;
  const agentProblem = agentClean && !agentOk ? "Paste the agent's 0x address." : targetProblem;
  const amountProblem = amountBad
    ? "Enter an amount."
    : amount !== null && token
      ? topUpAmountProblem(amount, assetDecimals(token.address))
      : null;
  const shortOf =
    totals && token && covering.length === 0 && !amountProblem
      ? largest > 0n
        ? `A series comes out of one balance, and your largest is ${formatAssetLabel(largest, token.address)}.`
        : `Nothing to set aside in ${token.symbol} yet. Add some privately first.`
      : null;

  const warnings = token
    ? cashOutPrivacyWarnings({
        to: agentOk ? agentClean : null,
        connected: address,
        amountWei: amount,
        asset: token.address,
        chainId: network.chainId,
        pool: network.pool,
        notes: local,
      })
    : [];
  // They all land in one public wallet, so the total is as visible as any one of them.
  // A deposit that is simply recent is not a note here: fundingWait stops the series instead.
  const link =
    totals && token
      ? ([findCashOutLink(totals.total, local, token.address, now), findCashOutLink(amount!, local, token.address, now)].find((l) => l && l.kind !== "recent") ?? null)
      : null;

  const rows = useMemo(() => topUpRows(local), [local]);
  const series = useMemo(() => topUpSeries(local, now), [local, now]);
  const leftovers = useMemo(() => unscheduledPieces(local).filter((n) => n.cashOutPlan?.topUp), [local]);
  const ahead = rows.filter((r) => topUpAhead(r.state) && r.state !== "unscheduled");
  const past = rows
    .filter((r) => !topUpAhead(r.state))
    .reverse()
    .slice(0, PAST_SHOWN);
  const setAside = [...topUpSetAside(rows)].map(([asset, wei]) => formatAssetLabel(wei, asset)).join(", ");
  const unfinished = series.filter((s) => s.missing.length > 0 && !s.settling);

  const topUpsOn = Boolean(relay?.topUps);
  const ready =
    isConnected &&
    relayOk &&
    topUpsOn &&
    !alertProblem &&
    !gasHigh &&
    !feeUnknown &&
    HASH_SCHEME === "poseidon" &&
    agentOk &&
    !targetProblem &&
    !amountProblem &&
    source !== null;

  /** What every top-up passes before anything moves, as any cash out does. */
  async function checkAgent(to: Address, asset: Address): Promise<boolean> {
    const problem = cashOutTargetProblem(to, network);
    if (problem) {
      setError(problem);
      return false;
    }
    if (!demoMode) {
      const check = checkSweep(publicClientFor(network) as unknown as SweepReader, network.chainId, to, asset).catch(() => null);
      const swept = await Promise.race([check, new Promise<null>((r) => window.setTimeout(() => r(null), 4_000))]);
      if (swept?.swept) {
        setError(`Money sent to ${shortAddress(to, 4)} has been moved out automatically within seconds before, by another account. Use another address.`);
        return false;
      }
    }
    const screen = await screenWallets([to], { chainId: network.chainId, asset, flow: "cashout" });
    if (!screen.allowed) {
      setError(screen.message ?? SCREEN_BLOCKED_MESSAGE);
      return false;
    }
    return true;
  }

  /** Runs a setup or a finish, and says plainly where it ended up. */
  async function runSeries(of: number, start: (onScheduled: () => void) => ReturnType<typeof setUpTopUps>, done: () => void) {
    setBusy(true);
    setProgress({ done: 0, of });
    try {
      const r = await start(() => setProgress((p) => p && { ...p, done: p.done + 1 }));
      if (r.stoppedAt === null) {
        done();
      } else {
        const k = r.jobs.length;
        const said = k === 0 ? "Nothing was scheduled." : `${k} of ${of} ${k === 1 ? "is" : "are"} scheduled and ${k === 1 ? "goes" : "go"} out as planned.`;
        setError(
          r.maybeSent
            ? `${said} Setting aside the next one may have gone out. Your money is safe in the vault and shows again once it lands.`
            : `${said} ${r.error ?? ""} The rest is safe in your private balance.`.replace(/\s+/g, " ")
        );
      }
      if (r.jobs.length > 0 && address) countPerson("cashout", address, network.testnet);
      void import("@/lib/track").then(({ track }) => {
        track("agent_topups", { every, topUpCount: of, scheduledCount: r.jobs.length, done: r.stoppedAt === null });
      });
    } catch (e) {
      // Refused before anything moved.
      setError(e instanceof Error ? e.message : "Could not set this up.");
    } finally {
      setBusy(false);
      setStatus(null);
      setProgress(null);
      refresh();
    }
  }

  async function onSetUp() {
    if (!ready || !address || !token || amount === null || !source || !totals) return;
    setError(null);
    setNotice(null);
    const to = agentClean as Address;
    if (!(await checkAgent(to, token.address))) return;
    const feeNote = await feeMoved(network, liveFeeBps);
    if (feeNote) {
      setError(feeNote);
      void refetchFee();
      return;
    }
    const label = formatAssetLabel(totals.total, token.address);
    await runSeries(
      count,
      (onScheduled) =>
        setUpTopUps({
          note: source,
          owner: address as Address,
          feeBps,
          agent: to,
          amount,
          every,
          count,
          webhook: alertClean || undefined,
          onStatus: setStatus,
          onPiece: (_, p) => p.state === "scheduled" && onScheduled(),
        }),
      () => {
        setNotice(`${label} set aside for ${count} top-ups. You can close Gloam: the relay sends each one on its day.`);
        setAmountInput("");
        setAgent("");
        setAlertUrl("");
        setAlertOpen(false);
      }
    );
  }

  async function onFinish(s: TopUpSeries) {
    if (!address || busy) return;
    setError(null);
    setNotice(null);
    if (!relayOk) {
      setError("Setting up top-ups needs the Gloam relay, which is off right now. Try again shortly.");
      return;
    }
    const need = s.amount * BigInt(s.missing.length);
    const candidates = topUpCandidates(open, s.asset, need);
    if (!candidates.length) {
      setError(`Setting up the rest needs ${formatAssetLabel(need, s.asset)} in one balance.`);
      return;
    }
    const leaves = await readVaultLeaves(candidates[0]!).catch(() => null);
    if (!leaves) {
      setError("Could not read the vault. Try again in a moment.");
      return;
    }
    const { note, wait } = pickReadyNote(candidates, local, leaves, now);
    if (!note) {
      if (wait && !wait.ok) setError(fundingWaitLine(wait, now));
      return;
    }
    if (!(await checkAgent(s.to, s.asset))) return;
    await runSeries(
      s.missing.length,
      (onScheduled) =>
        finishTopUps({
          note,
          owner: address as Address,
          feeBps: liveFeeBps ?? undefined,
          series: s,
          onStatus: setStatus,
          onPiece: (_, p) => p.state === "scheduled" && onScheduled(),
        }),
      () => setNotice("The rest of this series is set. You can close Gloam.")
    );
  }

  async function onSchedule(n: LocalNote) {
    const tag = n.cashOutPlan;
    if (!tag || busy) return;
    setError(null);
    setNotice(null);
    if (!relayOk) {
      setError("Scheduling needs the Gloam relay, which is off right now. Try again shortly.");
      return;
    }
    if (!(await checkAgent(tag.to, n.asset))) return;
    setBusy(true);
    setProgress({ done: 0, of: 1 });
    setStatus("Proving privately, this takes 10 to 30 seconds…");
    try {
      const job = await schedulePiece(n, {}, liveFeeBps ?? undefined);
      setNotice(`Top-up scheduled for ${topUpDayLabel(job.sendAfter)}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not schedule this top-up.");
    } finally {
      setBusy(false);
      setStatus(null);
      setProgress(null);
      refresh();
    }
  }

  async function onCancel(list: LocalNote[]) {
    setError(null);
    setNotice(null);
    let cancelled = 0;
    for (const n of list) {
      const problem = await cancelTopUp(n);
      if (problem) {
        setError(problem);
        break;
      }
      cancelled++;
    }
    refresh();
    if (cancelled === 0) return;
    setNotice(`Cancelled. ${cancelled === 1 ? "It moves" : "They move"} to a fresh private balance first, so the old proof can't be used, then ${cancelled === 1 ? "shows" : "show"} in your balance.`);
    void moveLooseProofs()
      .catch(() => {})
      .finally(refresh);
  }

  if (datedOff(network.chainId)) {
    return (
      <div className="gl-card max-w-[640px] p-5 sm:p-7">
        <h2 className="t-title">Agent top-ups</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-soft">{DATED_OFF_MESSAGE}</p>
        <p className="mt-2 text-[14px] leading-relaxed text-mute">They work on {ELYSIUM_ENABLED ? "Robinhood Chain, Tempo, Base and Elysium" : "Robinhood Chain, Tempo and Base"}.</p>
        <button type="button" className="btn btn-ghost mt-5" onClick={() => setNetworkKey("base-mainnet")}>
          Switch to Base
        </button>
      </div>
    );
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="gl-card min-w-0 p-5 sm:p-7">
        <h2 className="t-title">Agent top-ups</h2>
        <p className="mt-1.5 max-w-[52ch] text-[14px] leading-relaxed text-mute">
          Refill an agent&apos;s wallet from your private balance on a schedule, even with Gloam closed.
        </p>

        {gasHigh && (
          <div className="mt-5">
            <RelayGasNotice status={relay} label={network.label} later />
          </div>
        )}

        <div className="mt-6 space-y-5">
          <div>
            <label htmlFor="topup-agent" className="text-[13px] text-mute">
              Agent wallet on {network.label}
            </label>
            <input
              id="topup-agent"
              className="gl-input mt-2 font-mono text-[14px]"
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              aria-invalid={Boolean(agentProblem)}
            />
            {agentProblem && <p className="mt-1.5 text-[12.5px] leading-relaxed text-warn">{agentProblem}</p>}
            <CashOutWarnings warnings={warnings} scope={agentClean} disabled={busy} />
          </div>

          <div className="gl-inputcard px-4 py-3.5 sm:px-5" data-invalid={Boolean(amountProblem)}>
            <label htmlFor="topup-amount" className="text-[13px] text-mute">
              Each top-up
            </label>
            <div className="mt-1 flex items-center gap-3">
              <input
                id="topup-amount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                disabled={busy}
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                className="tnum min-w-0 flex-1 bg-transparent text-[34px] font-light leading-[1.15] tracking-[-0.02em] text-foreground outline-none! placeholder:text-faint"
              />
              {token && (
                <Select
                  variant="pill"
                  align="end"
                  className="shrink-0"
                  label="Stablecoin"
                  value={token.id}
                  disabled={busy}
                  onChange={(v) => setTokenId(v)}
                  options={tokens.map((t) => ({
                    value: t.id,
                    label: t.symbol,
                    description: t.name,
                    icon: <TokenLogo id={t.id} symbol={t.symbol} size={30} />,
                  }))}
                />
              )}
            </div>
            <p className={`tnum mt-1 min-h-5 text-[12.5px] ${amountProblem ? "text-warn" : "text-mute"}`}>
              {amountProblem ?? (token && largest > 0n ? `Largest balance ${formatAssetLabel(largest, token.address)}` : " ")}
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <p id="topup-pace" className="text-[13px] text-mute">
                How often
              </p>
              <div role="radiogroup" aria-labelledby="topup-pace" className="mt-2 grid grid-cols-2 gap-2">
                {PACES.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={every === value}
                    disabled={busy}
                    onClick={() => setEvery(value)}
                    className={`min-h-[48px] rounded-[14px] border px-2 py-2.5 text-center text-[13.5px] leading-snug transition-colors disabled:opacity-60 ${
                      every === value ? "border-foreground bg-panel text-foreground" : "border-line text-soft hover:border-line-strong hover:bg-surface"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p id="topup-count" className="text-[13px] text-mute">
                How many
              </p>
              <div role="group" aria-labelledby="topup-count" className="mt-2 flex h-12 items-center gap-1">
                <StepButton label="One fewer" disabled={busy || count <= TOP_UPS_MIN} onClick={() => setCountPick(Math.max(TOP_UPS_MIN, count - 1))}>
                  <path d="M6 12h12" />
                </StepButton>
                <output aria-live="polite" className="tnum w-10 text-center text-[17px] text-foreground">
                  {count}
                </output>
                <StepButton label="One more" disabled={busy || count >= most} onClick={() => setCountPick(Math.min(most, count + 1))}>
                  <path d="M6 12h12M12 6v12" />
                </StepButton>
              </div>
            </div>
          </div>
          {every === "2weeks" && (
            <p className="-mt-3 text-[12.5px] leading-relaxed text-mute">
              Up to {most} every 2 weeks: the relay holds a top-up for about 90 days.
            </p>
          )}

          {fundingWait && <CashOutLinkNote text={fundingWait} />}
          {link && <CashOutLinkNote text={linkMessage(link, now)} />}

          {totals && token && !amountProblem && (
            <div className="rounded-[16px] bg-surface px-4 py-3">
            <dl className="text-[13.5px]">
              <SummaryRow label="Set aside now" value={formatAssetLabel(totals.total, token.address)} strong />
              <SummaryRow label={`Fee per top-up (${feeUnknown ? "reading" : formatFeePercent(feeBps)})`} value={formatAssetLabel(totals.feeEach, token.address)} />
              <SummaryRow label="Agent gets each" value={formatAssetLabel(totals.agentGets, token.address)} />
              <SummaryRow label="Dates" value={`${topUpDayLabel(midday(days[0]!))} to ${topUpDayLabel(midday(days.at(-1)!))}`} />
            </dl>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-mute">
              That is at today&apos;s fee. The vault takes its fee as each top-up goes out, at the rate that day. If it goes up, this screen shows what each one will pay, and you can cancel any that haven&apos;t gone.
            </p>
            </div>
          )}

          <dl className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1.5 rounded-[14px] border border-line px-4 py-3 text-[12.5px] leading-relaxed">
            <dt className="text-foreground">Public</dt>
            <dd className="text-soft">Each top-up&apos;s amount, the agent&apos;s wallet and the time. Anyone can add them up.</dd>
            <dt className="flex items-center gap-1.5 text-sealed">
              <LockGlyph />
              Private
            </dt>
            <dd className="text-soft">Where the money came from.</dd>
          </dl>

          {agentGasLine(network) && <p className="text-[12.5px] leading-relaxed text-mute">{agentGasLine(network)}</p>}

          {alertOpen ? (
            <div>
              <label htmlFor="topup-alert" className="text-[13px] text-mute">
                Alert address (optional)
              </label>
              <input
                id="topup-alert"
                className="gl-input mt-2 text-[14px]"
                placeholder="https://"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                value={alertUrl}
                onChange={(e) => setAlertUrl(e.target.value)}
                aria-invalid={Boolean(alertProblem)}
              />
              {alertProblem && <p className="mt-1.5 text-[12.5px] leading-relaxed text-warn">{alertProblem}</p>}
              <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
                If a top-up fails or is held, the relay tells this address so. Whoever runs it learns when that happened.
                It never gets an amount, an address or a proof.
              </p>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setAlertOpen(true)}
              className="inline-flex min-h-10 items-center text-[13px] text-mute underline underline-offset-4 hover:text-foreground disabled:opacity-50"
            >
              Get an alert if a top-up fails
            </button>
          )}

          {shortOf && <p className="text-[12.5px] leading-relaxed text-warn">{shortOf}</p>}
          {relayChecked && !relayOk && (
            <p className="text-[12.5px] leading-relaxed text-warn">Top-ups need the Gloam relay, which is off right now.</p>
          )}
          {relayChecked && relayOk && !topUpsOn && <p className="text-[12.5px] leading-relaxed text-warn">{DATED_KEY_OFF_MESSAGE}</p>}

          {busy && progress ? (
            <div aria-live="polite" className="rounded-[16px] bg-sealed-soft px-4 py-3.5">
              <p className="tnum text-[13.5px] text-foreground">{`${progress.done} of ${progress.of} set up`}</p>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-panel">
                <div className="h-full rounded-full bg-foreground transition-[width] duration-500" style={{ width: `${(progress.done / progress.of) * 100}%` }} />
              </div>
              {status && <p className="mt-2 truncate text-[12.5px] text-soft">{status}</p>}
              <p className="mt-1 text-[12.5px] text-mute">Keep this tab open until it finishes.</p>
            </div>
          ) : isConnected ? (
            <>
              <button type="button" className="btn btn-ink btn-lg w-full" disabled={!ready || busy} onClick={() => void onSetUp()}>
                {totals && token ? `Set aside ${formatAssetLabel(totals.total, token.address)}` : "Set up top-ups"}
              </button>
              <p className="text-center text-[12.5px] leading-relaxed text-mute">
                {`Takes about ${topUpMinutes(count)} minutes with this tab open. Then you can close Gloam, and cancel any top-up before it goes.`}
              </p>
            </>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] bg-surface px-4 py-3">
              <p className="text-[14px] text-mute">Connect a wallet to set up top-ups.</p>
              <WalletMenu />
            </div>
          )}

          {error && (
            <p role="alert" className="text-[13px] leading-relaxed text-warn">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="rounded-[16px] bg-sealed-soft px-4 py-3.5 text-[13px] leading-relaxed text-foreground">
              {notice}
            </p>
          )}
        </div>
      </div>

      <div className="min-w-0 space-y-6">
        {/* Mid-run a top-up is between its split and its schedule, not stopped: these wait until it is over. */}
        {!busy && (unfinished.length > 0 || leftovers.length > 0) && (
          <div className="space-y-3">
            {unfinished.map((s) => (
              <div key={s.id} className="gl-card px-4 py-3.5 text-[13px] leading-relaxed">
                <p className="text-foreground">
                  {`${s.scheduled} of ${s.of} top-ups to ${shortAddress(s.to)} are scheduled. ${s.missing.length} more ${s.missing.length === 1 ? "is" : "are"} still in your private balance.`}
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onFinish(s)}
                  className="mt-1 inline-flex min-h-10 items-center font-medium underline underline-offset-4 disabled:opacity-50"
                >
                  {`Set up ${s.missing.length} more`}
                </button>
              </div>
            ))}
            {leftovers.map((n) => (
              <div key={n.id} className="gl-card px-4 py-3.5 text-[13px] leading-relaxed">
                <p className="text-foreground">
                  {`A top-up of ${formatAssetLabel(n.amountWei, n.asset)} to ${shortAddress(n.cashOutPlan!.to)} wasn't scheduled. It's safe in your private balance.`}
                </p>
                <div className="mt-1 flex flex-wrap gap-x-5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onSchedule(n)}
                    className="inline-flex min-h-10 items-center font-medium underline underline-offset-4 disabled:opacity-50"
                  >
                    Schedule it
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      keepPiece(n.id);
                      refresh();
                    }}
                    className="inline-flex min-h-10 items-center text-mute underline underline-offset-4 hover:text-foreground disabled:opacity-50"
                  >
                    Keep it in my balance
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <Upcoming rows={ahead} setAside={setAside} now={now} liveFeeBps={liveFeeBps} onCancel={(list) => void onCancel(list)} />

        {past.length > 0 && (
          <section className="gl-card p-5" aria-labelledby="topups-past">
            <h3 id="topups-past" className="text-[15px] font-medium text-foreground">
              Past
            </h3>
            {oneAgentOf(past) && <p className="mt-0.5 text-[12.5px] text-mute">{`To ${shortAddress(oneAgentOf(past)!)}`}</p>}
            <ul className="mt-1 divide-y divide-line">
              {past.map((r) => (
                <Row key={r.note.id} row={r} now={now} showAgent={!oneAgentOf(past)} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function Upcoming({
  rows,
  setAside,
  now,
  liveFeeBps,
  onCancel,
}: {
  rows: TopUpRow[];
  setAside: string;
  now: number;
  liveFeeBps: number | null;
  onCancel: (notes: LocalNote[]) => void;
}) {
  const [asked, setAsked] = useState(false);
  const waiting = rows.filter((r) => r.state === "upcoming" && r.at > now).map((r) => r.note);
  const oneAgent = oneAgentOf(rows);
  return (
    <section className="gl-card p-5" aria-labelledby="topups-upcoming">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="topups-upcoming" className="text-[15px] font-medium text-foreground">
          Upcoming
        </h3>
        {setAside && <p className="tnum min-w-0 truncate text-right text-[13px] text-mute">{setAside} set aside</p>}
      </div>
      {oneAgent && <p className="mt-0.5 text-[12.5px] text-mute">{`To ${shortAddress(oneAgent)}`}</p>}
      {rows.length === 0 ? (
        <p className="mt-2 text-[13.5px] leading-relaxed text-mute">Nothing scheduled yet.</p>
      ) : (
        <ul className="mt-1 divide-y divide-line">
          {rows.map((r) => (
            <Row
              key={r.note.id}
              row={r}
              now={now}
              showAgent={!oneAgent}
              liveFeeBps={liveFeeBps}
              onCancel={r.state === "upcoming" && r.at > now ? () => onCancel([r.note]) : undefined}
            />
          ))}
        </ul>
      )}
      {waiting.length > 1 && (
        <button
          type="button"
          onClick={() => {
            if (asked) onCancel(waiting);
            setAsked(!asked);
          }}
          onBlur={() => setAsked(false)}
          className="mt-1 inline-flex min-h-10 items-center text-[13px] text-mute underline underline-offset-4 hover:text-foreground"
        >
          {asked ? `Cancel all ${waiting.length}? Tap again` : "Cancel all"}
        </button>
      )}
    </section>
  );
}

/** The agent, when every row pays the same one: then it is said once, not on every row. */
function oneAgentOf(rows: TopUpRow[]): Address | null {
  const to = rows[0]?.note.cashOutPlan?.to;
  return to && rows.every((r) => r.note.cashOutPlan?.to.toLowerCase() === to.toLowerCase()) ? to : null;
}

function Row({
  row,
  now,
  showAgent,
  liveFeeBps = null,
  onCancel,
}: {
  row: TopUpRow;
  now: number;
  showAgent: boolean;
  liveFeeBps?: number | null;
  onCancel?: () => void;
}) {
  const n = row.note;
  const rise = feeRise(n, liveFeeBps);
  return (
    <li className="flex items-center justify-between gap-3 py-2.5 text-[13.5px]">
      <span className="min-w-0">
        <span className="tnum block text-foreground">{formatAssetLabel(n.amountWei, n.asset)}</span>
        <span className="block truncate text-[12px] text-mute">
          {showAgent ? `${topUpWhen(row, now)} · to ${shortAddress(n.cashOutPlan!.to)}` : topUpWhen(row, now)}
        </span>
        {rise && <span className="tnum block text-[12px] leading-relaxed text-warn">{feeRiseLine(rise, n.asset)}</span>}
      </span>
      {onCancel && (
        <button type="button" className="btn btn-quiet btn-sm min-h-10 shrink-0" onClick={onCancel}>
          Cancel
        </button>
      )}
    </li>
  );
}

function SummaryRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="text-mute">{label}</dt>
      <dd className={`tnum text-right ${strong ? "font-medium text-foreground" : "text-soft"}`}>{value}</dd>
    </div>
  );
}

function StepButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-11 w-11 place-items-center rounded-full border border-line text-foreground transition-colors hover:border-line-strong hover:bg-surface disabled:opacity-40"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

function LockGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
