"use client";

/**
 * Prove on Starknet: the payments in one channel, between this private account
 * and one other (lib/proofs/starknetChannel). In Starknet's privacy pool one
 * key opens every payment in a channel, so this shares them all, including
 * later ones, and the screen says so before anything is made. Single payments,
 * balances and minimums are not here: the pool can't open one payment alone or
 * show money is unspent.
 */
import { useEffect, useId, useState } from "react";
import { encodeStarknetChannel, type ChannelPayment } from "@/lib/proofs/starknetChannel";
import type { ChannelRef } from "@/lib/proofs/starknetChannelRead";
import type { StarknetToken } from "@/lib/starknetPrivacy/config";
import { track } from "@/lib/track";
import { shortStark, useStarknet, type StarknetProveEngine } from "./StarknetAccount";
import { STARKNET_NAME, StarknetGate, starkAmount } from "./StarknetParts";
import { EmptyCard, ExpiryPicker, Notice, ProofShareCard, ProveLayout, ShieldCheck, Spinner, VerifierField } from "./prove/ProofParts";
import { expiresAtFor, longDate, verifierLabel, type ExpiryId } from "./prove/proofUtils";

export const STARKNET_NOT_YET =
  "One payment alone, balances and minimums are not on Starknet yet. The pool has no way to open one payment without the rest of its channel, or to show money is unspent.";

const SHARES_ALL =
  "This shares every payment in this channel, including ones made after you share it. It can't be taken back.";

export function StarknetProve() {
  const sn = useStarknet();
  if (!sn) return null;
  if (!sn.address || !sn.prove) return <StarknetGate />;
  return <ChannelProve engine={sn.prove} token={sn.token} />;
}

const keyOf = (c: ChannelRef) => `${c.side}:${c.sender}:${c.recipient}`;
const other = (c: ChannelRef) => (c.side === "received" ? c.sender : c.recipient);

/** "1,250.00 USDC" for the token this site lists; the raw amount and a short address for any other. */
function amountIn(v: bigint, tokenAddress: string, token: StarknetToken | null): string {
  if (token && BigInt(token.address) === BigInt(tokenAddress)) return `${starkAmount(v, token)} ${token.symbol}`;
  return `${v.toString()} of ${shortStark(tokenAddress)}`;
}

function totals(payments: ChannelPayment[], token: StarknetToken | null): string {
  const by = new Map<string, bigint>();
  for (const p of payments) by.set(p.token, (by.get(p.token) ?? 0n) + p.amount);
  return [...by].map(([t, v]) => amountIn(v, t, token)).join(", ");
}

function ChannelProve({ engine, token }: { engine: StarknetProveEngine; token: StarknetToken | null }) {
  const ids = useId();
  const [channels, setChannels] = useState<ChannelRef[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; payments: ChannelPayment[]; outside: number } | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [verifier, setVerifier] = useState("");
  const [expiry, setExpiry] = useState<ExpiryId>("7d");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ token: string; ref: ChannelRef; payments: ChannelPayment[]; expiresAt: number } | null>(null);

  useEffect(() => {
    let live = true;
    engine
      .channels()
      .then((c) => live && (setChannels(c), setLoadErr(null)))
      .catch(() => live && setLoadErr(`Could not read your channels from ${STARKNET_NAME}. Try again.`));
    return () => {
      live = false;
    };
  }, [engine, tick]);

  const list = channels ?? [];
  const channel = list.find((c) => keyOf(c) === picked) ?? list[0] ?? null;
  const channelKey = channel ? keyOf(channel) : null;

  useEffect(() => {
    if (!channel || !channelKey) return;
    let live = true;
    engine
      .preview(channel)
      .then((p) => live && (setPreview({ key: channelKey, ...p }), setPreviewErr(null)))
      .catch(() => live && setPreviewErr(`Could not read this channel from ${STARKNET_NAME}. Try again.`));
    return () => {
      live = false;
    };
    // the channel is named by its key; a new list with the same channel needs no new read
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, channelKey]);

  const shown = preview && preview.key === channelKey ? preview : null;
  const label = verifierLabel(verifier);

  async function create() {
    if (!channel || !label || !shown || shown.payments.length === 0) return;
    setBusy(true);
    setErr(null);
    const expiresAt = expiresAtFor(expiry);
    try {
      const proof = await engine.make(channel, label, expiresAt);
      setDone({ token: encodeStarknetChannel(proof), ref: channel, payments: shown.payments, expiresAt });
      track("proof_created", { kind: "starknet-channel" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const aside = <SharesPanel channel={channel} payments={shown?.payments ?? null} token={token} verifier={verifier} expiry={expiry} />;

  if (done) {
    const n = done.payments.length;
    return (
      <ProveLayout aside={aside}>
        <ProofShareCard
          token={done.token}
          badge="Ready to share"
          tokenLabel="What you share. Send it to them however you like."
          headline={
            <>
              {n === 1 ? "One payment of" : `${n} payments adding up to`} <span className="text-foreground">{totals(done.payments, token)}</span>
            </>
          }
          rows={[
            { label: done.ref.side === "received" ? "From" : "To", value: shortStark(other(done.ref)) },
            { label: "For", value: label ?? verifier },
            { label: "Good until", value: longDate(done.expiresAt * 1000) },
            { label: "Network", value: STARKNET_NAME },
          ]}
          onEdit={() => setDone(null)}
        />
        <p className="px-1 text-[13px] leading-relaxed text-mute">{SHARES_ALL}</p>
      </ProveLayout>
    );
  }

  if (!channels) {
    return (
      <ProveLayout aside={aside}>
        <section className="gl-card max-sm:p-5 sm:p-7" aria-busy={!loadErr}>
          {loadErr ? (
            <div className="space-y-4">
              <Notice tone="danger">{loadErr}</Notice>
              <button type="button" onClick={() => setTick((t) => t + 1)} className="btn btn-ghost">
                Try again
              </button>
            </div>
          ) : (
            <div className="space-y-4" aria-label="Loading">
              <span className="gl-skeleton block h-6 w-56" />
              <span className="gl-skeleton block h-[60px]" />
              <span className="gl-skeleton block h-[60px]" />
            </div>
          )}
        </section>
      </ProveLayout>
    );
  }

  if (list.length === 0) {
    return (
      <ProveLayout aside={aside}>
        <EmptyCard
          title="No payments yet"
          body={`When you pay someone or someone pays you on ${STARKNET_NAME}, you can show those payments here. ${STARKNET_NOT_YET}`}
          action={
            <button type="button" onClick={() => setTick((t) => t + 1)} className="btn btn-ghost">
              Check again
            </button>
          }
        />
      </ProveLayout>
    );
  }

  const groups: [string, ChannelRef[]][] = [
    ["Paid to you", list.filter((c) => c.side === "received")],
    ["Paid by you", list.filter((c) => c.side === "sent")],
  ];

  return (
    <ProveLayout aside={aside}>
      <section className="gl-card min-w-0 max-sm:p-5 sm:p-7">
        <h2 className="text-[17px] text-foreground">Show the payments with one account</h2>
        <p className="mt-1 max-w-[52ch] text-[13.5px] leading-relaxed text-mute">
          Pick the account. They see every payment between you, its amount and its date, read from {STARKNET_NAME}&apos;s privacy pool.
        </p>

        {groups.map(([title, cs]) =>
          cs.length === 0 ? null : (
            <div key={title} className="mt-6">
              <p id={`${ids}-${title}`} className="text-[13px] text-mute">
                {title}
              </p>
              <ul role="radiogroup" aria-labelledby={`${ids}-${title}`} className="mt-2 space-y-2">
                {cs.map((c) => {
                  const active = channel ? keyOf(c) === keyOf(channel) : false;
                  const read = active ? shown : null;
                  return (
                    <li key={keyOf(c)}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setPicked(keyOf(c))}
                        className={`flex min-h-[60px] w-full items-center gap-3 rounded-[14px] border px-4 py-2.5 text-left transition-colors ${
                          active ? "border-foreground bg-panel" : "border-line hover:border-line-strong hover:bg-surface"
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="tnum block truncate text-[15px] text-foreground">
                            {c.side === "received" ? "From" : "To"} {shortStark(other(c))}
                          </span>
                          <span className="tnum block truncate text-[12px] text-mute">
                            {!active
                              ? "Private account"
                              : read
                                ? read.payments.length === 0
                                  ? "No payments yet"
                                  : `${read.payments.length} ${read.payments.length === 1 ? "payment" : "payments"}, ${totals(read.payments, token)}`
                                : previewErr ?? "Reading the payments"}
                          </span>
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
          )
        )}

        <div className="mt-7 space-y-6 border-t border-line pt-6">
          <VerifierField value={verifier} onChange={setVerifier} />
          <ExpiryPicker value={expiry} onChange={setExpiry} />
        </div>

        <div className="mt-7 space-y-4">
          <p className="rounded-[14px] bg-warn-soft px-4 py-3 text-[13.5px] leading-relaxed text-warn">{SHARES_ALL}</p>
          {err && <Notice tone="danger">{err}</Notice>}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy || !label || !shown || shown.payments.length === 0}
              className="btn btn-ink btn-lg max-sm:w-full"
            >
              {busy ? <Spinner /> : <ShieldCheck className="h-4 w-4" />}
              {busy ? "Checking it on Starknet" : "Create and sign"}
            </button>
            {!label && !busy && <span className="text-[13px] text-mute">Add who it is for</span>}
          </div>
          <p className="text-[12.5px] leading-relaxed text-mute">{STARKNET_NOT_YET}</p>
        </div>
      </section>
    </ProveLayout>
  );
}

/** What the disclosure shares, and what it never does. */
function SharesPanel({
  channel,
  payments,
  token,
  verifier,
  expiry,
}: {
  channel: ChannelRef | null;
  payments: ChannelPayment[] | null;
  token: StarknetToken | null;
  verifier: string;
  expiry: ExpiryId;
}) {
  const unset = <span className="text-faint">Not set yet</span>;
  const rows = [
    { label: "From", value: channel ? shortStark(channel.sender) : unset },
    { label: "To", value: channel ? shortStark(channel.recipient) : unset },
    { label: "Payments", value: payments ? String(payments.length) : unset },
    { label: "Total", value: payments && payments.length > 0 ? totals(payments, token) : unset },
    { label: "Who it is for", value: verifier.trim() || unset },
    { label: "Good until", value: longDate(expiresAtFor(expiry) * 1000) },
  ];
  return (
    <section className="gl-card max-sm:p-5 sm:p-7 lg:p-6">
      <p className="text-[13px] text-mute">What this shares</p>
      <dl className="mt-3 divide-y divide-line text-[14px]">
        {rows.map((r) => (
          <div key={r.label} className="flex min-h-11 items-center justify-between gap-3 py-2">
            <dt className="shrink-0 text-mute">{r.label}</dt>
            <dd className="tnum min-w-0 truncate text-right text-foreground">{r.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-5 text-[13px] text-mute">Never shows</p>
      <ul className="mt-2 divide-y divide-line rounded-[14px] bg-surface px-4 text-[13.5px]">
        {["Your balance", "Payments with anyone else", "When money was spent", "Your main wallet"].map((n) => (
          <li key={n} className="flex min-h-11 items-center py-2 text-soft">
            {n}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[12.5px] leading-relaxed text-mute">
        On {STARKNET_NAME} one key opens every payment in a channel, so there is no way to show only one. Whoever has this can read the channel for
        good, even after it expires. It can never move your money.
      </p>
    </section>
  );
}
