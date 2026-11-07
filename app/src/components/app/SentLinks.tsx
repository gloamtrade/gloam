"use client";

/**
 * Pay > Send privately > Sent links: the claim codes this browser sent
 * (lib/sentLinks), with whether each one's money has moved, Copy code, and
 * Take back for one nobody used. Taking back runs the same claim and secure as
 * Receive > Claim a payment (passed in as onTakeBack), so a locked code asks
 * for its phrase there too. Once the secure lands the code is dead; until then
 * it stays bearer, and the copy says which.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { claimLinkFor, shortCodeFor } from "@/lib/claimLink";
import { isClaimLink } from "@/lib/funnel";
import { allNetworks } from "@/lib/networks";
import type { Hex } from "viem";
import { decodeNotePackage } from "@/lib/notePackage";
import { formatAssetAmount } from "@/lib/shield";
import {
  SENT_LINK_STATUS_LABEL,
  canRemove,
  canTakeBack,
  needsCheck,
  paymentNullifier,
  sentLinkStatus,
  type SentLink,
  type SentLinkStatus,
} from "@/lib/sentLinks";
import {
  checkSpent,
  loadSentLinks,
  markSentLinkTakenBack,
  markSentLinksUsed,
  removeSentLink,
  subscribeSentLinks,
} from "@/lib/sentLinksStore";
import { useNetwork } from "./NetworkProvider";
import { PaymentNoteLine } from "./PaymentNote";
import { StatusPill } from "./StatusPill";

const HINT = "Kept in this browser only, encrypted like your balance.";
const EMPTY =
  "Claim links you send show up here, so you can copy them again or take back one nobody used.";
const TAKEN_BACK = "It's back in your private balance, and the link no longer works.";
const TAKEN_BACK_OPEN =
  "It's back in your private balance, but not secured yet, so anyone who has the link can still claim it. Tap Secure it now at the top.";
/** Open on its own while the list is this short; longer lists start collapsed. */
const OPEN_UP_TO = 3;

/** The nullifier to check: saved with the record, or worked out from a plain code. */
async function nullifierOf(rec: SentLink): Promise<Hex | null> {
  if (rec.nullifier) return rec.nullifier;
  if (!rec.code.startsWith("gloam1.")) return null;
  try {
    const pack = await decodeNotePackage(rec.code);
    return await paymentNullifier(pack.secret, pack.commitment);
  } catch {
    return null;
  }
}

function tone(status: SentLinkStatus): "lime" | "mute" | "warn" {
  if (status === "unused") return "lime";
  if (status === "unknown") return "warn";
  return "mute";
}

type RowMessage = { id: string; text: string; tone: "done" | "info" | "error" };

export function SentLinks({
  onTakeBack,
}: {
  /** Claim this code into the connected wallet's private balance (throws with a readable message). */
  /** Resolves with whether the money moved into a note only this browser knows. */
  onTakeBack: (code: string, passphrase?: string) => Promise<{ secured: boolean }>;
}) {
  const { network } = useNetwork();
  const pool = network.pool;
  const chainId = network.chainId;
  const scope = pool ? `${chainId}:${pool.toLowerCase()}` : "";

  const [loaded, setLoaded] = useState<{ scope: string; list: SentLink[] } | null>(null);
  const [openPref, setOpenPref] = useState<boolean | null>(null);
  const [checks, setChecks] = useState<Record<string, boolean | null>>({});
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [phraseFor, setPhraseFor] = useState<string | null>(null);
  const [phrase, setPhrase] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<RowMessage | null>(null);

  // Read inside async callbacks: a result for another network is dropped.
  const scopeRef = useRef(scope);
  const openPrefRef = useRef<boolean | null>(null);
  const checkedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  const list = loaded && loaded.scope === scope ? loaded.list : null;
  const isOpen = openPref ?? (list ? list.length <= OPEN_UP_TO : false);

  /** On-chain check for the rows whose money could still be there. `all` rechecks every one. */
  const runCheck = useCallback(
    async (rows: SentLink[], all: boolean) => {
      if (!pool) return;
      const at = scope;
      const todo = rows.filter((r) => needsCheck(r) && (all || !checkedRef.current.has(r.id)));
      if (!todo.length) return;
      for (const r of todo) checkedRef.current.add(r.id);
      setChecking(true);
      try {
        const nulls = await Promise.all(todo.map(nullifierOf));
        const ask = todo.flatMap((r, i) => (nulls[i] ? [{ id: r.id, n: nulls[i] as Hex }] : []));
        const answers = await checkSpent(pool, ask.map((a) => a.n));
        if (scopeRef.current !== at) return;
        const next: Record<string, boolean | null> = {};
        for (const r of todo) next[r.id] = null;
        ask.forEach((a, i) => {
          next[a.id] = answers[i];
        });
        setChecks((c) => ({ ...c, ...next }));
        // Spent stays spent: remember it so it is never asked again.
        void markSentLinksUsed(ask.filter((_, i) => answers[i] === true).map((a) => a.id));
      } catch {
        if (scopeRef.current !== at) return;
        setChecks((c) => ({ ...c, ...Object.fromEntries(todo.map((r) => [r.id, null])) }));
      } finally {
        setChecking(false);
      }
    },
    [pool, scope]
  );

  const reload = useCallback(() => {
    if (!pool) return;
    const at = scope;
    void loadSentLinks(chainId, pool)
      .then((rows) => {
        if (scopeRef.current !== at) return;
        setLoaded({ scope: at, list: rows });
        const open = openPrefRef.current ?? rows.length <= OPEN_UP_TO;
        if (open) void runCheck(rows, false);
      })
      .catch(() => {
        if (scopeRef.current === at) setLoaded({ scope: at, list: [] });
      });
  }, [chainId, pool, scope, runCheck]);

  useEffect(() => {
    reload();
    return subscribeSentLinks(reload);
  }, [reload]);

  if (!pool) return null;

  function toggle() {
    const next = !isOpen;
    openPrefRef.current = next;
    setOpenPref(next);
    if (next && list) void runCheck(list, true);
  }

  async function copy(rec: SentLink) {
    try {
      // a tappable link for plain claim codes; anything else as the code itself,
      // short (gloam3) when it can be (the stored code stays the full one)
      const net = allNetworks().find((n) => n.chainId === rec.chainId)?.key;
      const text = net && isClaimLink(rec.code) ? claimLinkFor(rec.code, net, window.location.origin) : shortCodeFor(rec.code, net);
      await navigator.clipboard.writeText(text);
      setCopied(rec.id);
      window.setTimeout(() => setCopied((c) => (c === rec.id ? null : c)), 2000);
    } catch {
      setMessage({ id: rec.id, text: "Could not copy in this browser.", tone: "error" });
    }
  }

  async function takeBack(rec: SentLink, passphrase?: string) {
    if (rec.locked && !passphrase?.trim()) {
      setPhraseFor(rec.id);
      setPhrase("");
      setMessage(null);
      return;
    }
    setBusyId(rec.id);
    setMessage(null);
    try {
      // Moved since the last check: nothing to take back.
      const n = await nullifierOf(rec);
      if (n && pool) {
        const [spent] = await checkSpent(pool, [n]);
        if (spent === true) {
          setChecks((c) => ({ ...c, [rec.id]: true }));
          await markSentLinksUsed([rec.id]);
          setPhraseFor(null);
          setMessage({ id: rec.id, text: "Someone already used this one, so there is nothing to take back.", tone: "info" });
          return;
        }
      }
      const { secured } = await onTakeBack(rec.code, rec.locked ? passphrase : undefined);
      await markSentLinkTakenBack(rec.id);
      setPhraseFor(null);
      setPhrase("");
      setMessage({ id: rec.id, text: secured ? TAKEN_BACK : TAKEN_BACK_OPEN, tone: "done" });
    } catch (e) {
      setMessage({ id: rec.id, text: e instanceof Error ? e.message : "Could not take it back.", tone: "error" });
    } finally {
      setBusyId(null);
    }
  }

  const count = list?.length ?? 0;

  return (
    <section aria-labelledby="sent-links-title" className="mt-7 border-t border-line pt-6">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={isOpen}
          aria-controls="sent-links-body"
          className="-my-2 flex min-h-10 items-center gap-2 text-left"
        >
          <span id="sent-links-title" className="t-eyebrow">
            Sent links
          </span>
          {count > 0 && <span className="tnum text-[12px] text-faint">{count}</span>}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
            className={`text-mute transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
          >
            <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {isOpen && count > 0 && (
          <button
            type="button"
            onClick={() => list && void runCheck(list, true)}
            disabled={checking}
            className="btn btn-ghost btn-sm"
          >
            {checking ? "Checking…" : "Refresh"}
          </button>
        )}
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-mute">{HINT}</p>

      {isOpen && list && (
        <div id="sent-links-body" className="mt-3">
          {count === 0 ? (
            <p className="rounded-[16px] bg-surface p-[16px] text-[13px] leading-relaxed text-mute">{EMPTY}</p>
          ) : (
            <ul className="max-h-[440px] divide-y divide-line overflow-y-auto rounded-[16px] border border-line">
              {list.map((rec) => {
                const status = sentLinkStatus(rec, checks[rec.id]);
                const msg = message?.id === rec.id ? message : null;
                const busy = busyId === rec.id;
                return (
                  <li key={rec.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="tnum truncate text-[15px] text-foreground">
                          {formatAssetAmount(rec.amountWei, rec.asset)}{" "}
                          <span className="text-mute">{rec.symbol}</span>
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-mute">
                          <span>
                            {new Date(rec.createdAt).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                            })}
                          </span>
                          {rec.locked && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-sealed-soft px-2 py-0.5 text-[11.5px] font-medium text-sealed">
                              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" aria-hidden>
                                <rect x="4" y="10.5" width="16" height="10" rx="2.2" fill="currentColor" />
                                <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" stroke="currentColor" strokeWidth="2" />
                              </svg>
                              Locked
                            </span>
                          )}
                          {rec.kind === "address" && (
                            <span className="inline-flex items-center rounded-full bg-surface px-2 py-0.5 text-[11.5px]">
                              To a Gloam address
                            </span>
                          )}
                        </p>
                        {rec.note && (
                          <PaymentNoteLine note={rec.note} className="mt-0.5 text-[12px] text-soft" />
                        )}
                      </div>
                      <StatusPill tone={tone(status)}>{SENT_LINK_STATUS_LABEL[status]}</StatusPill>
                    </div>

                    {rec.kind === "address" && status === "unused" && (
                      <p className="mt-1.5 text-[12px] leading-relaxed text-mute">
                        Sealed to their Gloam address, so only they can claim it. Send them the code.
                      </p>
                    )}

                    <div className="mt-2.5 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void copy(rec)}
                        aria-live="polite"
                        className="btn btn-ghost btn-sm"
                      >
                        {copied === rec.id ? "Copied" : isClaimLink(rec.code) ? "Copy link" : "Copy code"}
                      </button>
                      {canTakeBack(rec, status) && phraseFor !== rec.id && (
                        <button
                          type="button"
                          onClick={() => void takeBack(rec)}
                          disabled={busyId !== null}
                          className="btn btn-ghost btn-sm"
                        >
                          {busy ? "Taking back…" : "Take back"}
                        </button>
                      )}
                      {canRemove(status) && (
                        <button
                          type="button"
                          onClick={() => void removeSentLink(rec.id)}
                          className="btn btn-quiet btn-sm text-mute"
                        >
                          Remove
                        </button>
                      )}
                    </div>

                    {phraseFor === rec.id && canTakeBack(rec, status) && (
                      <form
                        className="mt-3"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void takeBack(rec, phrase);
                        }}
                      >
                        <label htmlFor={`sl-pass-${rec.id}`} className="text-[13px] text-mute">
                          Phrase
                        </label>
                        <input
                          id={`sl-pass-${rec.id}`}
                          type="text"
                          autoComplete="off"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          value={phrase}
                          onChange={(e) => setPhrase(e.target.value)}
                          placeholder="The phrase you locked it with"
                          className="gl-input mt-2"
                        />
                        <div className="mt-2.5 flex flex-wrap gap-2">
                          <button
                            type="submit"
                            disabled={!phrase.trim() || busyId !== null}
                            className="btn btn-ink btn-sm"
                          >
                            {busy ? "Taking back…" : "Take back"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setPhraseFor(null);
                              setPhrase("");
                            }}
                            className="btn btn-ghost btn-sm"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    )}

                    {msg && (
                      <p
                        role={msg.tone === "error" ? "alert" : "status"}
                        className={`mt-3 rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                          msg.tone === "done"
                            ? "bg-sealed-soft text-foreground"
                            : msg.tone === "info"
                              ? "bg-surface text-soft"
                              : "bg-danger-soft text-danger"
                        }`}
                      >
                        {msg.text}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
