"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { encodeProof, provePayment } from "@/lib/proofs";
import { assetDecimals, assetLabel, formatAssetAmount, formatAssetAmountExact, parseAssetAmount, type LocalNote } from "@/lib/shield";
import { amountTextError } from "@/lib/amountText";
import { PaymentNoteLine } from "../PaymentNote";
import {
  AssetMark,
  EmptyCard,
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
  isReceivedPayment,
  logoIdFor,
  proveFailReason,
  longDate,
  networkFor,
  shortDate,
  type ExpiryId,
  verifierLabel,
  type FriendlyError,
} from "./proofUtils";

type Done = {
  token: string;
  asset: string;
  amount: bigint | null;
  minAmount: bigint;
  verifier: string;
  expiresAt: number;
  chainId: number;
  /** The payer's note on this payment. Shown here only, never in the proof. */
  note?: string;
};

export function PaymentFlow({ notes }: { notes: LocalNote[] }) {
  const ids = useId();
  const payments = useMemo(
    () => notes.filter(isReceivedPayment).sort((a, b) => b.createdAt - a.createdAt),
    [notes]
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const note = payments.find((p) => p.id === selectedId) ?? payments[0];
  const [reveal, setReveal] = useState(true);
  const [minText, setMinText] = useState("");
  const [verifier, setVerifier] = useState("");
  const [expiry, setExpiry] = useState<ExpiryId>("7d");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FriendlyError | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  if (!note) {
    return (
      <ProveLayout aside={<PaymentAside note={null} reveal minAmount={null} verifier={verifier} expiry={expiry} />}>
        <EmptyCard
          title="No received payments yet"
          body="When someone pays you privately, claim it under Receive. It shows up here, and you can prove it to anyone, with the amount or only a minimum."
          action={
            <Link href="/app/vault?tab=move&mode=receive" className="btn btn-ink">
              Go to Receive
            </Link>
          }
        />
      </ProveLayout>
    );
  }

  const asset = note.asset;
  const sym = assetLabel(asset);
  const amount = BigInt(note.amountWei);
  const minAmount = reveal ? amount : parseAssetAmount(minText, asset);
  const minProblem = reveal
    ? null
    : amountTextError(minText, assetDecimals(asset))
      ? amountTextError(minText, assetDecimals(asset))
      : minAmount == null || minAmount <= 0n
      ? "Enter the minimum to show"
      : minAmount > amount
        ? `Can't be more than you received (${formatAssetAmount(amount, asset)} ${sym})`
        : null;
  const forLabel = verifierLabel(verifier);
  const missing = minProblem ?? (!forLabel ? "Say who it is for" : null);
  const canCreate = !busy && missing == null;

  function choose(id: string) {
    setSelectedId(id);
    setMinText("");
    setErr(null);
  }

  async function create() {
    if (!canCreate || minAmount == null) return;
    setErr(null);
    setBusy(true);
    const expiresAt = expiresAtFor(expiry);
    try {
      const p = await provePayment({
        chainId: note.chainId,
        pool: note.pool,
        note,
        reveal,
        minAmount: reveal ? undefined : minAmount,
        verifier: forLabel!,
        expiresAt,
      });
      setDone({
        token: encodeProof(p),
        asset,
        amount: reveal ? amount : null,
        minAmount,
        verifier: p.verifier,
        expiresAt: p.expiresAt,
        chainId: note.chainId,
        note: note.note,
      });
      void import("@/lib/track").then(({ track }) => {
        track("proof_created", { kind: "payment", chainId: note.chainId });
      });
    } catch (e) {
      setErr(friendlyProveError(e, "payment"));
      void import("@/lib/track").then(({ track }) => {
        track("proof_create_failed", { kind: "payment", reason: proveFailReason(e) });
      });
    } finally {
      setBusy(false);
    }
  }

  const aside = (
    <PaymentAside
      note={note}
      reveal={done ? done.amount != null : reveal}
      minAmount={done ? done.minAmount : minAmount}
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
            done.amount != null ? (
              <>
                {/* what the proof states, so every unit: the rest of the app shows two places */}
                A payment of {formatAssetAmountExact(done.amount, done.asset)}{" "}
                <span className="text-mute">{assetLabel(done.asset)}</span>
              </>
            ) : (
              <>
                A payment of at least {formatAssetAmountExact(done.minAmount, done.asset)}{" "}
                <span className="text-mute">{assetLabel(done.asset)}</span>
              </>
            )
          }
          rows={[
            { label: "For", value: done.verifier },
            { label: "Good until", value: longDate(done.expiresAt * 1000) },
            { label: "Network", value: net?.label ?? `Chain ${done.chainId}` },
            { label: "Exact amount", value: done.amount != null ? "Shown" : "Hidden" },
          ]}
          onEdit={() => setDone(null)}
        />
        {done.note && (
          <p className="px-1 text-[13px] leading-relaxed text-mute">
            For the payment with the note{" "}
            <span className="break-words text-foreground">{done.note}</span>. The note stays with
            you. It is not in the proof.
          </p>
        )}
      </ProveLayout>
    );
  }

  return (
    <ProveLayout aside={aside}>
      <section className="gl-card min-w-0 max-sm:p-5 sm:p-7">
        <h2 className="text-[17px] text-foreground">Prove you were paid</h2>
        <p className="mt-1 max-w-[52ch] text-[13.5px] leading-relaxed text-mute">
          Pick a payment you received. Show the amount, or only that it was at least a figure you
          choose.
        </p>

        {/* which payment */}
        <div className="mt-6">
          <p id={`${ids}-pay`} className="text-[13px] text-mute">
            Payment
          </p>
          <ul
            role="radiogroup"
            aria-labelledby={`${ids}-pay`}
            className="mt-2 max-h-[300px] space-y-2 overflow-y-auto"
          >
            {payments.map((p) => {
              const active = p.id === note.id;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => choose(p.id)}
                    className={`flex min-h-[60px] w-full items-center gap-3 rounded-[14px] border px-4 py-2.5 text-left transition-colors ${
                      active ? "border-foreground bg-panel" : "border-line hover:border-line-strong hover:bg-surface"
                    }`}
                  >
                    <AssetMark id={logoIdFor(p.asset, p.chainId)} symbol={assetLabel(p.asset)} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="tnum block truncate text-[16px] text-foreground">
                        {formatAssetAmount(p.amountWei, p.asset)}{" "}
                        <span className="text-mute">{assetLabel(p.asset)}</span>
                      </span>
                      <span className="block truncate text-[12px] text-mute">
                        Received privately, {shortDate(p.createdAt)}
                        {p.secured ? ", secured" : p.status === "recovered" ? ", spent since" : ""}
                      </span>
                      {p.note && (
                        <PaymentNoteLine
                          note={p.note}
                          label="Their note"
                          className="mt-0.5 text-[12.5px] text-soft"
                        />
                      )}
                    </span>
                    <span
                      aria-hidden
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors ${
                        active ? "border-foreground bg-foreground" : "border-line-strong"
                      }`}
                    >
                      {active && <span className="h-2 w-2 rounded-full bg-panel" />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* what to show */}
        <div className="mt-6">
          <p id={`${ids}-show`} className="text-[13px] text-mute">
            What they see
          </p>
          <div role="radiogroup" aria-labelledby={`${ids}-show`} className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(
              [
                [true, "Show the amount", `They see ${formatAssetAmountExact(amount, asset)} ${sym}`],
                [false, "Only show it was at least…", "The exact amount stays hidden"],
              ] as const
            ).map(([value, label, hint]) => {
              const active = reveal === value;
              return (
                <button
                  key={label}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setReveal(value)}
                  className={`flex min-h-[64px] items-start gap-3 rounded-[14px] border px-4 py-3 text-left transition-colors ${
                    active ? "border-foreground bg-panel" : "border-line hover:border-line-strong hover:bg-surface"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors ${
                      active ? "border-foreground bg-foreground" : "border-line-strong"
                    }`}
                  >
                    {active && <span className="h-2 w-2 rounded-full bg-panel" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[14px] text-foreground">{label}</span>
                    <span className="tnum mt-0.5 block text-[12.5px] text-mute">{hint}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {!reveal && (
            <div className="mt-4">
              <label htmlFor={`${ids}-min`} className="text-[13px] text-mute">
                At least
              </label>
              <div className="gl-inputcard mt-2 flex items-center gap-3 rounded-[16px] py-2 pl-4 pr-4">
                <input
                  id={`${ids}-min`}
                  inputMode="decimal"
                  autoComplete="off"
                  value={minText}
                  onChange={(e) => setMinText(e.target.value)}
                  placeholder="0"
                  aria-describedby={`${ids}-min-hint`}
                  aria-invalid={Boolean(minText) && Boolean(minProblem)}
                  className="tnum min-w-0 flex-1 bg-transparent text-[28px] font-light leading-[1.25] tracking-[-0.02em] text-foreground outline-none! placeholder:text-faint"
                />
                <span className="shrink-0 text-[15px] text-mute">{sym}</span>
              </div>
              <p
                id={`${ids}-min-hint`}
                className={`mt-2 text-[12.5px] leading-relaxed ${minText && minProblem ? "text-warn" : "text-mute"}`}
              >
                {minText && minProblem
                  ? minProblem
                  : `Any figure up to ${formatAssetAmount(amount, asset)} ${sym}. A round number gives away the least.`}
              </p>
            </div>
          )}
        </div>

        <div className="mt-7 space-y-6 border-t border-line pt-6">
          <VerifierField value={verifier} onChange={setVerifier} />
          <ExpiryPicker value={expiry} onChange={setExpiry} />
        </div>

        <div className="mt-7 space-y-4">
          {err && <Notice tone={err.tone}>{err.text}</Notice>}
          {busy ? (
            <ProofProgress kind="payment" />
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

function PaymentAside({
  note,
  reveal,
  minAmount,
  verifier,
  expiry,
  expiresAt,
}: {
  note: LocalNote | null;
  reveal: boolean;
  minAmount: bigint | null;
  verifier: string;
  expiry: ExpiryId;
  expiresAt?: number;
}) {
  const unset = <span className="text-faint">Not set yet</span>;
  const until = expiresAt ?? expiresAtFor(expiry);
  // what the proof states, so every unit: the rest of the app shows two places
  const amountValue = !note
    ? unset
    : reveal
      ? `${formatAssetAmountExact(note.amountWei, note.asset)} ${assetLabel(note.asset)}`
      : minAmount != null && minAmount > 0n
        ? `At least ${formatAssetAmountExact(minAmount, note.asset)} ${assetLabel(note.asset)}`
        : unset;
  return (
    <>
      <ShowsPanel
        shows={[
          { label: "Asset", value: note ? assetLabel(note.asset) : unset },
          { label: "Amount", value: amountValue },
          { label: "Who it is for", value: verifier.trim() || unset },
          { label: "Good until", value: longDate(until * 1000) },
        ]}
        never={[
          ...(reveal ? [] : ["The exact amount"]),
          ...(note?.note ? ["The note on this payment"] : []),
          "Your balance",
          "Your other payments",
          "Your wallet",
        ]}
        note={
          <p>
            The proof points at this payment&apos;s record in the vault, so they can see when it
            landed. It shows a private payment was made, not who paid whom. The record never
            shows the amount, and shows the sender&apos;s wallet only if they paid without Hide
            my wallet.
          </p>
        }
      />
      <SafeToShare />
    </>
  );
}
