"use client";

import { useId, useMemo, useState } from "react";
import { encodeProof, proveBalance } from "@/lib/proofs";
import { assetLabel, formatAssetAmount, type LocalNote } from "@/lib/shield";
import {
  AssetMark,
  ExpiryPicker,
  NoBalanceCard,
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
  longDate,
  networkFor,
  proveFailReason,
  shortDate,
  verifierLabel,
  type ExpiryId,
  type FriendlyError,
} from "./proofUtils";

type Done = {
  token: string;
  asset: string;
  amount: bigint;
  verifier: string;
  expiresAt: number;
  chainId: number;
};

/**
 * Prove one private balance, amount shown exactly. Sealed for one verifier and
 * an expiry like the other proofs, made on this device and never put on chain
 * (lib/proofs proveBalance). The older gloamdisc1 format is retired: it reused
 * the deposit statement, which anyone can copy from a public deposit.
 */
export function ExactBalance({ notes }: { notes: LocalNote[] }) {
  const ids = useId();
  const balances = useMemo(
    () =>
      notes.filter(isFundsNote).sort((a, b) => {
        const x = BigInt(a.amountWei);
        const y = BigInt(b.amountWei);
        return x === y ? b.createdAt - a.createdAt : x > y ? -1 : 1;
      }),
    [notes]
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const note = balances.find((n) => n.id === selectedId) ?? balances[0];
  const [verifier, setVerifier] = useState("");
  const [expiry, setExpiry] = useState<ExpiryId>("7d");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FriendlyError | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  if (!note) {
    return (
      <ProveLayout aside={<BalanceAside note={null} verifier={verifier} expiry={expiry} />}>
        <NoBalanceCard />
      </ProveLayout>
    );
  }

  const forLabel = verifierLabel(verifier);
  const missing = !forLabel ? "Say who it is for" : null;
  const canCreate = !busy && missing == null;

  async function create() {
    if (!canCreate) return;
    setErr(null);
    setBusy(true);
    try {
      const p = await proveBalance({
        chainId: note.chainId,
        pool: note.pool,
        note,
        verifier: forLabel!,
        expiresAt: expiresAtFor(expiry),
      });
      setDone({
        token: encodeProof(p),
        asset: note.asset,
        amount: BigInt(p.amount),
        verifier: p.verifier,
        expiresAt: p.expiresAt,
        chainId: note.chainId,
      });
      void import("@/lib/track").then(({ track }) => {
        track("proof_created", { kind: "exact", chainId: note.chainId });
      });
    } catch (e) {
      setErr(friendlyProveError(e, "balance"));
      void import("@/lib/track").then(({ track }) => {
        track("proof_create_failed", { kind: "exact", reason: proveFailReason(e) });
      });
    } finally {
      setBusy(false);
    }
  }

  const aside = (
    <BalanceAside
      note={note}
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
              Exactly {formatAssetAmount(done.amount, done.asset)}{" "}
              <span className="text-mute">{assetLabel(done.asset)}</span>
            </>
          }
          rows={[
            { label: "For", value: done.verifier },
            { label: "Good until", value: longDate(done.expiresAt * 1000) },
            { label: "Network", value: net?.label ?? `Chain ${done.chainId}` },
            { label: "Exact amount", value: "Shown" },
          ]}
          onEdit={() => setDone(null)}
        />
      </ProveLayout>
    );
  }

  return (
    <ProveLayout aside={aside}>
      <section className="gl-card min-w-0 max-sm:p-5 sm:p-7">
        <h2 className="text-[17px] text-foreground">Show one balance exactly</h2>
        <p className="mt-1 max-w-[52ch] text-[13.5px] leading-relaxed text-mute">
          Pick a private balance. They see its exact amount and nothing else you hold.
        </p>

        <div className="mt-6">
          <p id={`${ids}-bal`} className="text-[13px] text-mute">
            Balance
          </p>
          <ul role="radiogroup" aria-labelledby={`${ids}-bal`} className="mt-2 max-h-[300px] space-y-2 overflow-y-auto">
            {balances.map((n) => {
              const active = n.id === note.id;
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => {
                      setSelectedId(n.id);
                      setErr(null);
                    }}
                    className={`flex min-h-[60px] w-full items-center gap-3 rounded-[14px] border px-4 py-2.5 text-left transition-colors ${
                      active ? "border-foreground bg-panel" : "border-line hover:border-line-strong hover:bg-surface"
                    }`}
                  >
                    <AssetMark id={logoIdFor(n.asset, n.chainId)} symbol={assetLabel(n.asset)} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="tnum block truncate text-[16px] text-foreground">
                        {formatAssetAmount(n.amountWei, n.asset)} <span className="text-mute">{assetLabel(n.asset)}</span>
                      </span>
                      <span className="block truncate text-[12px] text-mute">Private balance, {shortDate(n.createdAt)}</span>
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

        <div className="mt-7 space-y-6 border-t border-line pt-6">
          <VerifierField value={verifier} onChange={setVerifier} />
          <ExpiryPicker value={expiry} onChange={setExpiry} />
        </div>

        <div className="mt-7 space-y-4">
          {err && <Notice tone={err.tone}>{err.text}</Notice>}
          {busy ? (
            <ProofProgress kind="balance" />
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <button type="button" onClick={() => void create()} disabled={!canCreate} className="btn btn-ink btn-lg max-sm:w-full">
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

function BalanceAside({
  note,
  verifier,
  expiry,
  expiresAt,
}: {
  note: LocalNote | null;
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
          { label: "Asset", value: note ? assetLabel(note.asset) : unset },
          { label: "Amount", value: note ? `${formatAssetAmount(note.amountWei, note.asset)} ${assetLabel(note.asset)}` : unset },
          { label: "Who it is for", value: verifier.trim() || unset },
          { label: "Good until", value: longDate(until * 1000) },
        ]}
        never={["Your other balances", "Your history"]}
        note={
          <ul className="space-y-2">
            <li>Whoever has the proof can find the transaction that made this balance.</li>
            <li>
              A balance straight from a deposit can&apos;t be proven this way: its record names your
              wallet. Send it to your own Gloam address first.
            </li>
            <li>A balance from a send you made without the relay shows that wallet too.</li>
            <li>It does not show whether the balance moves later. An At least proof does.</li>
          </ul>
        }
      />
      <SafeToShare />
    </>
  );
}
