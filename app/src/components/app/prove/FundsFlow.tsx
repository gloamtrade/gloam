"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { formatUnits } from "viem";
import { FUNDS_MAX_NOTES, encodeProof, proveFunds } from "@/lib/proofs";
import {
  assetDecimals,
  assetLabel,
  formatAssetAmount,
  parseAssetAmount,
  updateLocalNote,
  type LocalNote,
} from "@/lib/shield";
import { amountTextError } from "@/lib/amountText";
import { AmountProblem } from "../AmountProblem";
import { shieldTokensFor } from "@/lib/tokens";
import { isClaimedNote, isSecuredClaim } from "@/lib/claimSweep";
import {
  AssetMark,
  CheckMark,
  ExpiryPicker,
  Notice,
  ProofProgress,
  ProofShareCard,
  ProveLayout,
  SafeToShare,
  ShieldCheck,
  ShowsPanel,
  VerifierField,
} from "./ProofParts";
import {
  expiresAtFor,
  friendlyProveError,
  isFundsNote,
  logoIdFor,
  proveFailReason,
  longDate,
  networkFor,
  pickFundsNotes,
  shortDate,
  sumNotes,
  type ExpiryId,
  verifierLabel,
  type FriendlyError,
} from "./proofUtils";

type Done = { token: string; threshold: bigint; asset: string; verifier: string; expiresAt: number; chainId: number };

function noteKind(n: LocalNote): string {
  if (isClaimedNote(n) || isSecuredClaim(n)) return "Claimed";
  if (n.id.startsWith("chg-")) return "Change from a payment";
  return "Added";
}

/** A plain number for the amount field (no grouping), from raw units. */
function plainAmount(raw: bigint, asset: string): string {
  return formatUnits(raw, assetDecimals(asset));
}

export function FundsFlow({ notes, empty }: { notes: LocalNote[]; empty: ReactNode }) {
  const ids = useId();
  const usable = useMemo(() => notes.filter(isFundsNote), [notes]);

  // Assets with something to prove: stablecoins first, then the largest holdings.
  const assets = useMemo(() => {
    const m = new Map<string, LocalNote[]>();
    for (const n of usable) {
      const k = n.asset.toLowerCase();
      m.set(k, [...(m.get(k) ?? []), n]);
    }
    const chainId = usable[0]?.chainId ?? 0;
    const stable = new Set(
      shieldTokensFor(chainId)
        .filter((t) => t.kind === "stablecoin")
        .map((t) => t.address.toLowerCase())
    );
    return Array.from(m.entries())
      .map(([asset, list]) => ({
        asset,
        notes: [...list].sort((a, b) => (BigInt(b.amountWei) > BigInt(a.amountWei) ? 1 : -1)),
        total: sumNotes(list),
        stable: stable.has(asset),
      }))
      .sort((a, b) => Number(b.stable) - Number(a.stable) || b.notes.length - a.notes.length);
  }, [usable]);

  const [assetKey, setAssetKey] = useState<string | null>(null);
  const current = assets.find((a) => a.asset === assetKey) ?? assets[0];
  const [amountText, setAmountText] = useState("");
  const [manual, setManual] = useState<string[] | null>(null);
  const [verifier, setVerifier] = useState("");
  const [expiry, setExpiry] = useState<ExpiryId>("7d");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FriendlyError | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  if (!current) {
    return (
      <ProveLayout aside={<FundsAside asset={null} threshold={null} verifier={verifier} expiry={expiry} />}>
        {empty}
      </ProveLayout>
    );
  }

  const asset = current.asset;
  const sym = assetLabel(asset);
  const chainId = current.notes[0]!.chainId;
  const threshold = parseAssetAmount(amountText, asset);
  const pick = pickFundsNotes(current.notes, threshold);
  const maxProvable = sumNotes(current.notes.slice(0, FUNDS_MAX_NOTES));
  const selected = manual
    ? current.notes.filter((n) => manual.includes(n.id))
    : pick.kind === "ok"
      ? pick.notes
      : [];
  const selectedSum = sumNotes(selected);
  const covered = threshold != null && threshold > 0n && selectedSum >= threshold;
  const fmt = (v: bigint) => formatAssetAmount(v, asset);

  const forLabel = verifierLabel(verifier);
  const missing =
    threshold == null || threshold <= 0n
      ? "Enter an amount"
      : pick.kind === "short" || pick.kind === "too-many"
        ? null
        : selected.length === 0
          ? "Pick at least one balance"
          : !covered
            ? "The balances you picked do not cover it"
            : !forLabel
              ? "Say who it is for"
              : null;
  const canCreate =
    !busy && missing == null && covered && selected.length <= FUNDS_MAX_NOTES && forLabel != null;

  function selectAsset(a: string) {
    setAssetKey(a);
    setManual(null);
    setErr(null);
  }

  function toggle(n: LocalNote) {
    const base = manual ?? selected.map((x) => x.id);
    if (base.includes(n.id)) setManual(base.filter((id) => id !== n.id));
    else if (base.length < FUNDS_MAX_NOTES) setManual([...base, n.id]);
  }

  async function create() {
    if (!canCreate || threshold == null) return;
    setErr(null);
    setBusy(true);
    const expiresAt = expiresAtFor(expiry);
    try {
      const first = selected[0]!;
      // The proof carries these balances' spend markers: a later cash out or swap moves each
      // to a fresh balance first, so the proof can't point at it (lib/cashOutSplit spendPlanFor).
      // Marked before proving, so no proof ever leaves without its balances marked.
      const at = Date.now();
      await Promise.all(selected.map((n) => updateLocalNote(n.id, { fundsProofAt: at })));
      const p = await proveFunds({
        chainId: first.chainId,
        pool: first.pool,
        asset: first.asset,
        threshold,
        notes: selected,
        verifier: forLabel!,
        expiresAt,
      });
      setDone({
        token: encodeProof(p),
        threshold,
        asset,
        verifier: p.verifier,
        expiresAt: p.expiresAt,
        chainId: first.chainId,
      });
      void import("@/lib/track").then(({ track }) => {
        track("proof_created", { kind: "funds", chainId: first.chainId });
      });
    } catch (e) {
      setErr(friendlyProveError(e, "funds"));
      void import("@/lib/track").then(({ track }) => {
        track("proof_create_failed", { kind: "funds", reason: proveFailReason(e) });
      });
    } finally {
      setBusy(false);
    }
  }

  const aside = (
    <FundsAside
      asset={asset}
      threshold={done ? done.threshold : threshold}
      verifier={done ? done.verifier : (forLabel ?? "")}
      expiry={expiry}
      expiresAt={done?.expiresAt}
    />
  );

  if (done) {
    const net = networkFor(done.chainId);
    return (
      <ProveLayout aside={aside}>
        <ProofShareCard
          token={done.token}
          headline={
            <>
              Holds at least {formatAssetAmount(done.threshold, done.asset)}{" "}
              <span className="text-mute">{assetLabel(done.asset)}</span>
            </>
          }
          rows={[
            { label: "For", value: done.verifier },
            { label: "Good until", value: longDate(done.expiresAt * 1000) },
            { label: "Network", value: net?.label ?? `Chain ${done.chainId}` },
            { label: "Balance", value: "Hidden" },
          ]}
          onEdit={() => setDone(null)}
        />
      </ProveLayout>
    );
  }

  return (
    <ProveLayout aside={aside}>
      <section className="gl-card min-w-0 max-sm:p-5 sm:p-7">
        <h2 className="text-[17px] text-foreground">Prove you hold at least an amount</h2>
        <p className="mt-1 max-w-[52ch] text-[13.5px] leading-relaxed text-mute">
          They see that you hold at least what you name. Your balance stays hidden.
        </p>

        {/* asset */}
        <div className="mt-6">
          <p id={`${ids}-asset`} className="text-[13px] text-mute">
            Asset
          </p>
          <div role="radiogroup" aria-labelledby={`${ids}-asset`} className="mt-2 flex flex-wrap gap-2">
            {assets.map((a) => {
              const active = a.asset === asset;
              return (
                <button
                  key={a.asset}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => selectAsset(a.asset)}
                  className={`flex h-12 items-center gap-2.5 rounded-[14px] border pl-2 pr-3.5 text-left transition-colors ${
                    active ? "border-foreground bg-panel" : "border-line hover:border-line-strong hover:bg-surface"
                  }`}
                >
                  <AssetMark id={logoIdFor(a.asset, chainId)} symbol={assetLabel(a.asset)} size={30} />
                  <span className="text-[14px] text-foreground">{assetLabel(a.asset)}</span>
                  <span className="tnum text-[13px] text-mute">{formatAssetAmount(a.total, a.asset)}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* amount */}
        <div className="mt-6">
          <label htmlFor={`${ids}-amt`} className="text-[13px] text-mute">
            At least
          </label>
          <div className="gl-inputcard mt-2 flex items-center gap-3 rounded-[16px] py-2 pl-4 pr-2">
            <input
              id={`${ids}-amt`}
              inputMode="decimal"
              autoComplete="off"
              value={amountText}
              onChange={(e) => {
                setAmountText(e.target.value);
                setManual(null);
              }}
              placeholder="0"
              aria-describedby={`${ids}-amt-hint`}
              className="tnum min-w-0 flex-1 bg-transparent text-[32px] font-light leading-[1.25] tracking-[-0.02em] text-foreground outline-none! placeholder:text-faint"
            />
            <span className="shrink-0 text-[15px] text-mute">{sym}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm shrink-0"
              onClick={() => {
                setAmountText(plainAmount(maxProvable, asset));
                setManual(null);
              }}
            >
              Max
            </button>
          </div>
          <div id={`${ids}-amt-hint`} className="mt-2">
            {amountTextError(amountText, assetDecimals(asset)) ? (
              <AmountProblem value={amountText} decimals={assetDecimals(asset)} />
            ) : pick.kind === "short" ? (
              <Notice tone="warn">
                You hold {fmt(pick.total)} {sym} privately, less than {fmt(threshold!)}. Lower the
                amount, or add more to your vault first.
              </Notice>
            ) : pick.kind === "too-many" ? (
              <div className="rounded-[14px] bg-warn-soft px-4 py-3 text-[13.5px] leading-relaxed text-warn" role="status">
                <p>
                  That needs more than {FUNDS_MAX_NOTES} of your balances, and one proof can use at
                  most {FUNDS_MAX_NOTES}. You can prove up to {fmt(pick.maxProvable)} {sym} right now.
                </p>
                <p className="mt-1">
                  To prove more, combine some first: cash a few out and add them back as one deposit.
                </p>
                <button
                  type="button"
                  onClick={() => setAmountText(plainAmount(pick.maxProvable, asset))}
                  className="mt-2 inline-flex min-h-9 items-center font-medium text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground"
                >
                  Prove {fmt(pick.maxProvable)} {sym} instead
                </button>
              </div>
            ) : (
              <p className="text-[12.5px] leading-relaxed text-mute">
                You hold {fmt(current.total)} {sym} privately, across {current.notes.length}{" "}
                {current.notes.length === 1 ? "balance" : "balances"}. Only you can see this.
              </p>
            )}
          </div>
        </div>

        {/* backing balances */}
        <div className="mt-6">
          <div className="flex items-center justify-between gap-3">
            <p id={`${ids}-backing`} className="text-[13px] text-mute">
              Backed by
            </p>
            {manual ? (
              <button
                type="button"
                onClick={() => setManual(null)}
                className="-my-2 inline-flex min-h-10 items-center text-[13px] text-mute transition-colors hover:text-foreground"
              >
                Pick for me
              </button>
            ) : (
              <span className="text-[12.5px] text-faint">
                {pick.kind === "ok" ? "Picked for you" : `Up to ${FUNDS_MAX_NOTES}`}
              </span>
            )}
          </div>
          <ul
            role="group"
            aria-labelledby={`${ids}-backing`}
            className="mt-2 max-h-[292px] space-y-2 overflow-y-auto"
          >
            {current.notes.map((n) => {
              const on = selected.some((x) => x.id === n.id);
              const full = !on && selected.length >= FUNDS_MAX_NOTES;
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    disabled={full}
                    onClick={() => toggle(n)}
                    className={`flex min-h-[56px] w-full items-center gap-3 rounded-[14px] border px-4 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      on ? "border-foreground bg-panel" : "border-line hover:border-line-strong hover:bg-surface"
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="tnum block truncate text-[15px] text-foreground">
                        {formatAssetAmount(n.amountWei, n.asset)} <span className="text-mute">{sym}</span>
                      </span>
                      <span className="block truncate text-[12px] text-mute">
                        {noteKind(n)}, {shortDate(n.createdAt)}
                      </span>
                    </span>
                    <span
                      aria-hidden
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded-[6px] border transition-colors ${
                        on ? "border-foreground bg-foreground text-panel" : "border-line-strong"
                      }`}
                    >
                      {on && <CheckMark size={12} />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {selected.length > 0 && (
            <p className="mt-2 text-[12.5px] leading-relaxed text-mute" aria-live="polite">
              {selected.length} of {FUNDS_MAX_NOTES} used, adding up to {fmt(selectedSum)} {sym}.
              {threshold != null && threshold > 0n && !covered && (
                <span className="text-warn"> Short by {fmt(threshold - selectedSum)} {sym}.</span>
              )}
            </p>
          )}
        </div>

        <div className="mt-7 space-y-6 border-t border-line pt-6">
          <VerifierField value={verifier} onChange={setVerifier} />
          <ExpiryPicker value={expiry} onChange={setExpiry} />
        </div>

        <div className="mt-7 space-y-4">
          {err && <Notice tone={err.tone}>{err.text}</Notice>}
          {busy ? (
            <ProofProgress kind="funds" />
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                type="button"
                onClick={() => void create()}
                disabled={!canCreate}
                className="btn btn-ink btn-lg max-sm:w-full"
              >
                <ShieldCheck className="h-4 w-4" />
                Create proof
              </button>
              {missing && <span className="text-[13px] text-mute">{missing}</span>}
            </div>
          )}
        </div>
      </section>
    </ProveLayout>
  );
}

function FundsAside({
  asset,
  threshold,
  verifier,
  expiry,
  expiresAt,
}: {
  asset: string | null;
  threshold: bigint | null;
  verifier: string;
  expiry: ExpiryId;
  expiresAt?: number;
}) {
  const unset = <span className="text-faint">Not set yet</span>;
  const until = expiresAt ?? expiresAtFor(expiry);
  return (
    <>
      <ShowsPanel
        shows={[
          { label: "Asset", value: asset ? assetLabel(asset) : unset },
          {
            label: "At least",
            value:
              asset && threshold != null && threshold > 0n
                ? `${formatAssetAmount(threshold, asset)} ${assetLabel(asset)}`
                : unset,
          },
          { label: "Who it is for", value: verifier.trim() || unset },
          { label: "Good until", value: longDate(until * 1000) },
        ]}
        never={["Your balance", "Your other balances", "Your wallet", "Your history"]}
        note={
          <ul className="space-y-2">
            <li>
              The proof carries a spend marker for each balance behind it. If you later spend one,
              whoever has the proof can tell it was spent, and when.
            </li>
            <li>
              Before a cash out or swap, Gloam moves those balances to a fresh one first, so the proof
              doesn&apos;t lead to where the money went or how much.
            </li>
            <li>The move and the cash out land close together, so their timing can still hint at a link.</li>
          </ul>
        }
      />
      <SafeToShare />
    </>
  );
}
