"use client";

/**
 * Prove on Solana: one payment this private account received, its exact
 * amount and asset, checked by anyone against the transaction that made it
 * (lib/proofs/solanaPayment). Balances and "at least" proofs are not here:
 * Solana Privacy Rings can't show a balance is unspent, or a minimum with the
 * amount hidden, without a circuit of Gloam's own.
 */
import { useId, useMemo, useState } from "react";
import type { RingsSession } from "@/lib/solanaRings/client";
import { SOLANA_NAME } from "@/lib/solanaRings/config";
import { encodeSolanaPayment } from "@/lib/proofs/solanaPayment";
import { makeSolanaPaymentProof, receivedSolanaPayments, solanaAssetOf, type ReceivedSolanaPayment } from "@/lib/proofs/solanaPaymentClient";
import { track } from "@/lib/track";
import { formatSolAmount, shortSol, useSolana } from "./SolanaAccount";
import { SolanaGate } from "./SolanaParts";
import { TokenLogo } from "./TokenLogo";
import { EmptyCard, ExpiryPicker, Notice, ProofShareCard, ProveLayout, SafeToShare, ShieldCheck, ShowsPanel, Spinner, VerifierField } from "./prove/ProofParts";
import { expiresAtFor, longDate, verifierLabel, type ExpiryId } from "./prove/proofUtils";

/** What Solana can't prove yet, in one plain line each. */
export const SOLANA_NOT_YET =
  "Balances and minimums are not on Solana yet. Its private pool can't show money is still unspent, or that a hidden amount is at least a figure, without showing more.";

export function SolanaProve() {
  const sol = useSolana();
  if (!sol) return null;
  if (!sol.address || !sol.session) return <SolanaGate />;
  return <SolanaPaymentProve session={sol.session} refresh={sol.refresh} />;
}

type Asset = { symbol: string; decimals: number; logo: string | null };

function SolanaPaymentProve({ session, refresh }: { session: RingsSession; refresh: () => Promise<boolean> }) {
  const ids = useId();
  const [tick, setTick] = useState(0);
  const payments = useMemo<ReceivedSolanaPayment[]>(() => {
    void tick;
    try {
      // the wallet is the SDK's synced state; reading it never touches the network
      return receivedSolanaPayments(session);
    } catch {
      return [];
    }
  }, [session, tick]);
  const assets = (mint: string): Asset | null => {
    const a = solanaAssetOf(mint, session.network);
    return a ? { symbol: a.symbol, decimals: a.decimals, logo: a.id } : null;
  };
  const [picked, setPicked] = useState<string | null>(null);
  const [verifier, setVerifier] = useState("");
  const [expiry, setExpiry] = useState<ExpiryId>("7d");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ token: string; payment: ReceivedSolanaPayment; expiresAt: number } | null>(null);

  const list = payments;
  const payment = list.find((p) => p.id === picked) ?? list[0] ?? null;
  const asset = payment ? assets(payment.asset) : null;
  const label = verifierLabel(verifier);
  const amountText = payment && asset ? `${formatSolAmount(payment.amount, asset.decimals)} ${asset.symbol}` : null;

  async function reload() {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
      setTick((t) => t + 1);
    }
  }

  async function create() {
    if (!payment || !label) return;
    setBusy(true);
    setErr(null);
    const expiresAt = expiresAtFor(expiry);
    try {
      const proof = await makeSolanaPaymentProof(session, payment, label, expiresAt);
      setDone({ token: encodeSolanaPayment(proof), payment, expiresAt });
      track("proof_created", { kind: "solana-payment" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const aside = (
    <>
      <ShowsPanel
        shows={[
          { label: "Asset", value: asset?.symbol ?? <span className="text-faint">Not set yet</span> },
          { label: "Amount", value: amountText ?? <span className="text-faint">Not set yet</span> },
          { label: "Who it is for", value: verifier.trim() || <span className="text-faint">Not set yet</span> },
          { label: "Good until", value: longDate(expiresAtFor(expiry) * 1000) },
        ]}
        never={["Your balance", "Your other payments", "Your main wallet"]}
        note={
          <p>
            On {SOLANA_NAME} the two private accounts a payment moves between are already public. The proof adds the asset and the amount of this one
            payment, signed by your private account.
          </p>
        }
      />
      <SafeToShare />
    </>
  );

  if (done) {
    const a = assets(done.payment.asset);
    return (
      <ProveLayout aside={aside}>
        <ProofShareCard
          token={done.token}
          headline={
            <>
              A payment of {a ? formatSolAmount(done.payment.amount, a.decimals) : done.payment.amount.toString()}{" "}
              <span className="text-mute">{a?.symbol ?? ""}</span>
            </>
          }
          rows={[
            { label: "For", value: label ?? verifier },
            { label: "Good until", value: longDate(done.expiresAt * 1000) },
            { label: "Network", value: SOLANA_NAME },
          ]}
          onEdit={() => setDone(null)}
        />
      </ProveLayout>
    );
  }

  if (list.length === 0) {
    return (
      <ProveLayout aside={<SafeToShare />}>
        <EmptyCard
          title="No payments received yet"
          body={`When someone pays this private account on ${SOLANA_NAME}, you can prove that payment here. ${SOLANA_NOT_YET}`}
          action={
            <button type="button" onClick={() => void reload()} disabled={refreshing} className="btn btn-ghost">
              {refreshing ? <Spinner /> : null}
              Check again
            </button>
          }
        />
      </ProveLayout>
    );
  }

  return (
    <ProveLayout aside={aside}>
      <section className="gl-card min-w-0 max-sm:p-5 sm:p-7">
        <h2 className="text-[17px] text-foreground">Prove you were paid</h2>
        <p className="mt-1 max-w-[52ch] text-[13.5px] leading-relaxed text-mute">
          Pick a payment you received. They see its exact amount and when it landed, checked against {SOLANA_NAME}.
        </p>

        <div className="mt-6">
          <p id={`${ids}-pay`} className="text-[13px] text-mute">
            Payment
          </p>
          <ul role="radiogroup" aria-labelledby={`${ids}-pay`} className="mt-2 max-h-[300px] space-y-2 overflow-y-auto">
            {list.map((p) => {
              const active = p.id === payment?.id;
              const a = assets(p.asset);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setPicked(p.id)}
                    className={`flex min-h-[60px] w-full items-center gap-3 rounded-[14px] border px-4 py-2.5 text-left transition-colors ${
                      active ? "border-foreground bg-panel" : "border-line hover:border-line-strong hover:bg-surface"
                    }`}
                  >
                    {a?.logo ? <TokenLogo id={a.logo} symbol={a.symbol} size={32} /> : <span className="h-8 w-8 shrink-0 rounded-full bg-surface" />}
                    <span className="min-w-0 flex-1">
                      <span className="tnum block truncate text-[16px] text-foreground">
                        {a ? formatSolAmount(p.amount, a.decimals) : p.amount.toString()} <span className="text-mute">{a?.symbol ?? ""}</span>
                      </span>
                      <span className="block truncate text-[12px] text-mute">Received privately, {shortSol(p.tx)}</span>
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
          {err && <Notice tone="danger">{err}</Notice>}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button type="button" onClick={() => void create()} disabled={busy || !payment || !label} className="btn btn-ink btn-lg max-sm:w-full">
              {busy ? <Spinner /> : <ShieldCheck className="h-4 w-4" />}
              {busy ? "Checking it on Solana" : "Create proof"}
            </button>
            {!label && !busy && <span className="text-[13px] text-mute">Add who it is for</span>}
          </div>
          <p className="text-[12.5px] leading-relaxed text-mute">{SOLANA_NOT_YET}</p>
        </div>
      </section>
    </ProveLayout>
  );
}
