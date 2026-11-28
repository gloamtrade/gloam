"use client";

/**
 * Claim links and payment requests on Solana, drawn like their EVM twins
 * (PaymentTicketShare, SentLinks, Receive's claim box, PaymentRequest):
 *
 *  - SolanaLinkShare: a link to send, with its QR (made here, never by a third
 *    party), Copy link and Share.
 *  - SolanaSentLinks: Pay's list of the claim links this account made, with
 *    whether each one's money has moved, and Take back for one nobody used.
 *  - SolanaClaimCard: Receive's "Claim a payment", which a claim link opens.
 *  - SolanaRequestCard and SolanaRequestBanner: Receive's "Request a payment",
 *    and the line Pay shows when a request link opened it.
 *
 * What each says follows lib/solanaRings: a claim link hides the token and the
 * amount; the private accounts it moves between show on Solana, its own
 * one-time account among them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { claimBodyFromHash, claimBodyIn, claimLinkUrl, decodeClaim, encodeRequest, requestLinkUrl, SOLANA_REQUEST_NAME_MAX, SOLANA_REQUEST_NOTE_MAX, type SolanaRequest } from "@/lib/solanaRings/claimLink";
import { CLAIMED_ALREADY, NOTHING_YET } from "@/lib/solanaRings/claim";
import { dropSolanaClaim, keepSolanaClaim, keptSolanaClaim } from "@/lib/solanaRings/claimKeep";
import {
  SOLANA_SENT_LINK_LABEL,
  canRemove,
  canTakeBack,
  needsCheck,
  solanaSentLinkStatus,
  type SolanaSentLink,
  type SolanaSentLinkStatus,
} from "@/lib/solanaRings/sentLinks";
import { ringsAssets, SOLANA_CLAIM_LINKS_ENABLED, SOLANA_RINGS_NETWORK, type RingsAsset } from "@/lib/solanaRings/config";
import type { LinkState } from "@/lib/solanaRings/claim";
import { amountTextError } from "@/lib/amountText";
import { Spinner } from "@/components/ui/Spinner";
import { StatusPill } from "./StatusPill";
import { SuccessModal } from "./SuccessModal";
import { TokenLogo } from "./TokenLogo";
import { formatSolAmount, parseSolAmount, shortSol, useSolana, type SolanaLinkRead } from "./SolanaAccount";
import { SolanaActionButton, SolanaAssetSelect, SolanaError, SolanaSteps, LockGlyph, useShownAssets } from "./SolanaParts";

const assetById = (id: string) => ringsAssets().find((a) => a.id === id) ?? null;
const amountLabel = (amount: bigint, a: RingsAsset | null) => (a ? `${formatSolAmount(amount, a.decimals)} ${a.symbol}` : "");

// ---------------------------------------------------------------- a link to send

export function SolanaLinkShare({
  url,
  kind,
  label,
  stacked = false,
}: {
  url: string;
  kind: "claim" | "request";
  /** The amount as shown ("12.50 USDC"), or "any amount of USDC". */
  label: string;
  /** QR above the text, for the success dialog. */
  stacked?: boolean;
}) {
  const [qr, setQr] = useState<{ url: string; data: string | null } | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [shared, setShared] = useState(false);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const data = qr?.url === url ? qr.data : undefined;

  useEffect(() => {
    let live = true;
    void import("qrcode")
      .then((QR) => QR.toDataURL(url, { margin: 2, width: 272, errorCorrectionLevel: "M", color: { dark: "#0a0a0a", light: "#ffffff" } }))
      .then((d) => live && setQr({ url, data: d }))
      .catch(() => live && setQr({ url, data: null }));
    return () => {
      live = false;
    };
  }, [url]);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
    window.setTimeout(() => setCopy("idle"), 2000);
  }

  async function onShare() {
    try {
      await navigator.share({
        title: kind === "claim" ? "Gloam payment" : "Gloam payment request",
        text:
          kind === "claim"
            ? `I sent you a private payment on Gloam (${label}). Tap to claim it on Solana:`
            : `Pay me ${label} privately on Gloam, on Solana. The link fills in my private address.`,
        url,
      });
      setShared(true);
      window.setTimeout(() => setShared(false), 2000);
    } catch {
      /* cancelled */
    }
  }

  return (
    <div className="gl-tile p-[16px] text-left sm:p-5">
      <div className={stacked ? "flex flex-col items-center gap-4" : "flex gap-5 max-sm:flex-col max-sm:items-center"}>
        {data ? (
          // eslint-disable-next-line @next/next/no-img-element -- made here, never by a third party
          <img src={data} alt={kind === "claim" ? "QR code for this claim link" : "QR code for this payment request"} width={136} height={136} className="h-[136px] w-[136px] shrink-0 rounded-[14px] shadow-card" />
        ) : (
          <div className="grid h-[136px] w-[136px] shrink-0 place-items-center rounded-[14px] bg-panel px-3 text-center text-[11px] leading-snug text-mute">
            {data === null ? "QR code not available. Copy the link instead." : "Making QR..."}
          </div>
        )}
        <div className={stacked ? "w-full min-w-0" : "min-w-0 flex-1 max-sm:w-full"}>
          <p className="text-[15px] font-medium text-foreground">
            {kind === "claim" ? "Claim link ready" : "Request ready"}
            <span className="tnum font-normal text-mute">, {label}</span>
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-mute">
            {kind === "claim"
              ? "Send it any way you like. They tap it and claim in Gloam. Anyone with this link can claim it, so treat it like cash."
              : "Send it any way you like. Gloam fills in your private address and the amount. They check it and press Pay."}
          </p>
          <div className="tnum mt-3 max-h-24 overflow-y-auto break-all rounded-xl bg-panel px-3 py-2.5 text-[12px] leading-relaxed text-mute">{url}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => void onCopy()} className="btn btn-ink btn-sm" aria-live="polite">
              {copy === "copied" ? "Copied" : "Copy link"}
            </button>
            {canShare && (
              <button type="button" onClick={() => void onShare()} className="btn btn-ghost btn-sm">
                {shared ? "Shared" : "Share..."}
              </button>
            )}
          </div>
          {copy === "failed" && (
            <p role="alert" className="mt-2 text-[12.5px] text-danger">
              Could not copy. Select the link above and copy it by hand.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Sent links

const HINT = "Kept in this browser only, sealed with your private account.";
const EMPTY = "Claim links you make show up here, so you can copy them again or take back one nobody used.";
const OPEN_UP_TO = 3;

function tone(status: SolanaSentLinkStatus): "lime" | "mute" | "warn" {
  if (status === "unused") return "lime";
  if (status === "unknown") return "warn";
  return "mute";
}

type RowMessage = { id: string; text: string; tone: "done" | "info" | "error" };

export function SolanaSentLinks() {
  const sol = useSolana()!;
  const open = sol.sentLinks;
  const scope = sol.address ?? "";
  const [loaded, setLoaded] = useState<{ scope: string; list: SolanaSentLink[] } | null>(null);
  const [openPref, setOpenPref] = useState<boolean | null>(null);
  const [reads, setReads] = useState<Record<string, LinkState | null>>({});
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<RowMessage | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const scopeRef = useRef(scope);
  const checked = useRef<Set<string>>(new Set());
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  const list = loaded && loaded.scope === scope ? loaded.list : null;
  const isOpen = openPref ?? (list ? list.length <= OPEN_UP_TO : false);

  const readLinks = sol.readLinks;
  const runCheck = useCallback(
    async (rows: SolanaSentLink[], all: boolean) => {
      const at = scopeRef.current;
      const todo = rows.filter((r) => needsCheck(r) && (all || !checked.current.has(r.id)));
      if (!todo.length || !open) return;
      for (const r of todo) checked.current.add(r.id);
      setChecking(true);
      try {
        const states = await readLinks(todo.map((r) => r.body));
        if (scopeRef.current !== at) return;
        setNow(Date.now());
        setReads((m) => ({ ...m, ...Object.fromEntries(todo.map((r, i) => [r.id, states[i] ?? null])) }));
        // Claimed stays claimed: never read again.
        const used = todo.filter((_, i) => states[i] === "used").map((r) => r.id);
        if (used.length) await (await open()).markUsed(used).catch(() => undefined);
      } finally {
        setChecking(false);
      }
    },
    [open, readLinks]
  );

  const tick = sol.linksTick;
  useEffect(() => {
    if (!open) return;
    let live = true;
    const at = scope;
    void open()
      .then((s) => s.load())
      .then((rows) => {
        if (!live || scopeRef.current !== at) return;
        setLoaded({ scope: at, list: rows });
        if (openPref ?? rows.length <= OPEN_UP_TO) void runCheck(rows, false);
      })
      .catch(() => live && setLoaded({ scope: at, list: [] }));
    return () => {
      live = false;
    };
    // openPref is read once per load: toggling runs its own check
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scope, tick, runCheck]);

  if (!open || !scope) return null;
  // With making links off (config SOLANA_CLAIM_LINKS_ENABLED), the list shows only once it has a link to copy or take back.
  if (!SOLANA_CLAIM_LINKS_ENABLED && !list?.length) return null;

  function toggle() {
    const next = !isOpen;
    setOpenPref(next);
    if (next && list) void runCheck(list, true);
  }

  async function copyLink(rec: SolanaSentLink) {
    try {
      await navigator.clipboard.writeText(claimLinkUrl(rec.body, window.location.origin));
      setCopied(rec.id);
      window.setTimeout(() => setCopied((c) => (c === rec.id ? null : c)), 2000);
    } catch {
      setMessage({ id: rec.id, text: "Could not copy in this browser.", tone: "error" });
    }
  }

  async function takeBack(rec: SolanaSentLink) {
    setBusyId(rec.id);
    setMessage(null);
    try {
      const r = await sol.claimLink(rec.body, rec.id);
      if (!r) return; // the error shows under the list
      if (r.state === "claimed") {
        setReads((m) => ({ ...m, [rec.id]: "used" }));
        setMessage({ id: rec.id, text: "It's back in your private balance, and the link no longer works.", tone: "done" });
      } else if (r.state === "used") {
        setReads((m) => ({ ...m, [rec.id]: "used" }));
        setMessage({ id: rec.id, text: `${CLAIMED_ALREADY} There is nothing to take back.`, tone: "info" });
      } else {
        setMessage({ id: rec.id, text: NOTHING_YET, tone: "info" });
      }
    } finally {
      setBusyId(null);
    }
  }

  async function remove(rec: SolanaSentLink) {
    if (!open) return;
    try {
      await (await open()).remove(rec.id);
      setLoaded((l) => (l ? { ...l, list: l.list.filter((r) => r.id !== rec.id) } : l));
    } catch {
      setMessage({ id: rec.id, text: "Could not remove it in this browser.", tone: "error" });
    }
  }

  const count = list?.length ?? 0;
  const takingBack = sol.task?.kind === "takeback";

  return (
    <section aria-labelledby="sol-sent-links-title" className="mt-7 border-t border-line pt-6">
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={toggle} aria-expanded={isOpen} aria-controls="sol-sent-links-body" className="-my-2 flex min-h-10 items-center gap-2 text-left">
          <span id="sol-sent-links-title" className="t-eyebrow">
            Sent links
          </span>
          {count > 0 && <span className="tnum text-[12px] text-faint">{count}</span>}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden className={`text-mute transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}>
            <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {isOpen && count > 0 && (
          <button type="button" onClick={() => list && void runCheck(list, true)} disabled={checking} className="btn btn-ghost btn-sm">
            {checking ? "Checking..." : "Refresh"}
          </button>
        )}
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-mute">{HINT}</p>

      {isOpen && !list && (
        <div className="mt-3 space-y-2" aria-busy="true" aria-label="Loading your sent links">
          <span className="gl-skeleton block h-[68px]" />
        </div>
      )}
      {isOpen && list && (
        <div id="sol-sent-links-body" className="mt-3">
          {count === 0 ? (
            <p className="rounded-[16px] bg-surface p-[16px] text-[13px] leading-relaxed text-mute">{EMPTY}</p>
          ) : (
            <ul className="max-h-[440px] divide-y divide-line overflow-y-auto rounded-[16px] border border-line">
              {list.map((rec) => {
                const status = solanaSentLinkStatus(rec, reads[rec.id], now);
                const a = assetById(rec.asset);
                const msg = message?.id === rec.id ? message : null;
                const busy = busyId === rec.id;
                return (
                  <li key={rec.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="tnum truncate text-[15px] text-foreground">
                          {a ? formatSolAmount(BigInt(rec.amount), a.decimals) : rec.amount} <span className="text-mute">{a?.symbol ?? ""}</span>
                        </p>
                        <p className="mt-0.5 text-[12px] text-mute">{new Date(rec.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</p>
                      </div>
                      <StatusPill tone={tone(status)}>{status === "checking" ? "Checking..." : SOLANA_SENT_LINK_LABEL[status]}</StatusPill>
                    </div>
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {status !== "used" && status !== "taken-back" && (
                        <button type="button" onClick={() => void copyLink(rec)} aria-live="polite" className="btn btn-ghost btn-sm">
                          {copied === rec.id ? "Copied" : "Copy link"}
                        </button>
                      )}
                      {canTakeBack(status) && (
                        <button type="button" onClick={() => void takeBack(rec)} disabled={busyId !== null || Boolean(sol.task)} aria-busy={busy || undefined} className="btn btn-ghost btn-sm">
                          {busy ? (
                            <>
                              <Spinner />
                              Taking back...
                            </>
                          ) : (
                            "Take back"
                          )}
                        </button>
                      )}
                      {canRemove(status) && (
                        <button type="button" onClick={() => void remove(rec)} className="btn btn-quiet btn-sm text-mute">
                          Remove
                        </button>
                      )}
                    </div>
                    {busy && takingBack && <SolanaSteps task={sol.task} className="mt-3" />}
                    {msg && (
                      <p
                        role={msg.tone === "error" ? "alert" : "status"}
                        className={`mt-3 rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                          msg.tone === "done" ? "bg-sealed-soft text-foreground" : msg.tone === "info" ? "bg-surface text-soft" : "bg-danger-soft text-danger"
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
          <SolanaError kind="takeback" className="mt-3" />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Receive: Claim a payment

/** A claim link opened in the address bar (#sol=...): kept for the tab and cleared from the bar, since it is bearer. */
export function useSolanaClaimFromUrl(): string | null {
  const [body, setBody] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      const fromHash = claimBodyFromHash(window.location.hash);
      if (fromHash && decodeClaim(fromHash).ok) {
        keepSolanaClaim(fromHash);
        window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
        setBody(fromHash);
        return;
      }
      setBody(keptSolanaClaim());
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  return body;
}

type Preview =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "bad"; text: string }
  | { kind: "read"; read: SolanaLinkRead; asset: RingsAsset; amount: bigint };

/** What the last read of a link came back with, by its body. */
type Read = { body: string } & ({ kind: "read"; read: SolanaLinkRead; asset: RingsAsset; amount: bigint } | { kind: "bad"; text: string });

export function SolanaClaimCard({ initial }: { initial: string | null }) {
  const sol = useSolana()!;
  const [text, setText] = useState(() => (initial ? claimLinkUrl(initial, typeof window === "undefined" ? undefined : window.location.origin) : ""));
  const [last, setLast] = useState<Read | null>(null);
  const [done, setDone] = useState<{ asset: RingsAsset; amount: bigint; sig: string } | null>(null);
  const reads = useRef(0);
  const readLink = sol.readLink;

  // A link opened later in this tab fills the box.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a claim link opened in the address bar after mount
    if (initial) setText(claimLinkUrl(initial, window.location.origin));
  }, [initial]);

  const body = claimBodyIn(text);
  const decoded = body ? decodeClaim(body) : null;
  const whole = body && decoded?.ok ? body : null;

  const check = useCallback(
    async (b: string) => {
      const n = ++reads.current;
      setLast(null);
      try {
        const r = await readLink(b);
        if (n !== reads.current) return;
        const d = decodeClaim(b);
        if (!d.ok) return;
        const held = Object.entries(r.unspent).find(([, v]) => v > 0n);
        const asset = (held && assetById(held[0])) || d.claim.asset;
        setLast({ body: b, kind: "read", read: r, asset, amount: held ? held[1] : d.claim.amount });
        if (r.state === "used") dropSolanaClaim();
      } catch (e) {
        if (n === reads.current) setLast({ body: b, kind: "bad", text: e instanceof Error ? e.message : "Couldn't read this link." });
      }
    },
    [readLink]
  );

  // Read what the link holds as soon as it is whole.
  useEffect(() => {
    if (!whole) return;
    const t = setTimeout(() => void check(whole), 250);
    return () => clearTimeout(t);
  }, [whole, check]);

  const preview: Preview = !text.trim()
    ? { kind: "idle" }
    : !whole
      ? {
          kind: "bad",
          text:
            decoded && !decoded.ok && decoded.why === "unknown"
              ? "This link is from a newer Gloam. Reload the page and try again."
              : body
                ? "This link is cut off or damaged. Paste the whole message it came in, or ask the sender to send it again."
                : "That isn't a Solana claim link. Paste the whole link you were sent.",
        }
      : last && last.body === whole
        ? last
        : { kind: "reading" };

  const working = sol.task?.kind === "claim";
  const ready = preview.kind === "read" && preview.read.state === "unused";
  const stop = !text.trim()
    ? "Paste a claim link"
    : preview.kind === "reading"
      ? "Reading the link"
      : preview.kind === "bad"
        ? "Check the link"
        : preview.kind === "read" && preview.read.state === "used"
          ? "Already claimed"
          : preview.kind === "read" && preview.read.state === "empty"
            ? "Nothing in it yet"
            : sol.relay?.funded === false
              ? "Paused for a moment"
              : !ready
                ? "Paste a claim link"
                : null;

  return (
    <section id="claim-payment" className="scroll-mt-24 max-lg:border-t max-lg:border-line max-lg:pt-6">
      <h3 className="text-[15px] font-medium text-foreground">Claim a payment</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-mute">Paste the claim link you were sent. It moves into your private balance.</p>
      <label htmlFor="sol-claim-link" className="sr-only">
        Claim link
      </label>
      <textarea
        id="sol-claim-link"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDone(null);
          sol.clearError();
          dropSolanaClaim();
        }}
        rows={3}
        spellCheck={false}
        disabled={working}
        className="gl-input tnum mt-3 h-auto min-h-[88px] resize-none py-3 text-[13px] leading-relaxed"
        placeholder="gloam.trade/c#sol=..."
      />
      <div aria-live="polite">
        {preview.kind === "reading" && (
          <p className="mt-2 flex items-center gap-2 rounded-xl bg-surface px-3.5 py-2.5 text-[13px] text-soft">
            <Spinner />
            Reading the link on Solana
          </p>
        )}
        {preview.kind === "bad" && text.trim() && (
          <p role="alert" className="mt-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-warn">
            {preview.text}
          </p>
        )}
        {preview.kind === "read" && (
          <div className="mt-2 flex items-center gap-3 rounded-xl bg-surface px-3.5 py-2.5 text-[13px] leading-relaxed text-soft">
            {preview.read.state === "unused" && <TokenLogo id={preview.asset.id} symbol={preview.asset.symbol} size={28} />}
            <p className="min-w-0">
              {preview.read.state === "unused" ? (
                <>
                  <span className="tnum font-medium text-foreground">{amountLabel(preview.amount, preview.asset)}</span> waits in this link.
                </>
              ) : preview.read.state === "used" ? (
                CLAIMED_ALREADY
              ) : (
                NOTHING_YET
              )}
            </p>
          </div>
        )}
      </div>
      <div className="mt-4">
        <SolanaActionButton
          kind="claim"
          label="Claim it"
          stop={stop}
          onClick={() => {
            if (!body || preview.kind !== "read") return;
            const asset = preview.asset;
            void sol.claimLink(body).then((r) => {
              if (!r) return;
              if (r.state === "claimed") {
                dropSolanaClaim();
                const moved = r.moved.find((m) => m.assetId === asset.id) ?? r.moved[0]!;
                setDone({ asset: assetById(moved.assetId) ?? asset, amount: moved.amount, sig: moved.signature });
                setText("");
              } else {
                void check(body);
              }
            });
          }}
        />
        {preview.kind === "read" && preview.read.state === "empty" && body && (
          <button type="button" onClick={() => void check(body)} className="btn btn-ghost btn-sm mt-2">
            Check again
          </button>
        )}
        <SolanaSteps task={working ? sol.task : null} className="mt-4" />
        <SolanaError kind="claim" className="mt-4" />
        <p className="mt-3 text-center text-[12.5px] leading-relaxed text-mute">Gloam pays the network fee. The token and the amount stay hidden on Solana.</p>
      </div>
      <SuccessModal
        open={Boolean(done)}
        title="Claimed privately"
        body="It is in your private balance now. Only you can see it."
        logo={done ? <TokenLogo id={done.asset.id} symbol={done.asset.symbol} size={56} /> : undefined}
        amount={done ? amountLabel(done.amount, done.asset) : undefined}
        secondaryLabel="Done"
        onClose={() => setDone(null)}
      />
    </section>
  );
}

// ---------------------------------------------------------------- Receive: Request a payment

export function SolanaRequestCard() {
  const sol = useSolana()!;
  const assets = useShownAssets();
  const [assetId, setAssetId] = useState(() => (assets.find((a) => a.stable) ?? assets[0]!).id);
  const asset = assets.find((a) => a.id === assetId) ?? assets[0]!;
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ url: string; label: string; to: string } | null>(null);
  const to = sol.address;
  const live = made && made.to === to ? made : null;
  const typedProblem = amountTextError(amount, asset.decimals);

  function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!to) return;
    const t = amount.trim();
    const value = t ? parseSolAmount(t, asset.decimals) : null;
    if (t && value === null) {
      setError(typedProblem ?? "Enter an amount above zero, or leave it empty.");
      setMade(null);
      return;
    }
    const request: SolanaRequest = { network: SOLANA_RINGS_NETWORK, to, asset, amount: value, note, name };
    try {
      const body = encodeRequest(request);
      setError(null);
      setMade({ url: requestLinkUrl(body, window.location.origin), label: value !== null ? amountLabel(value, asset) : `any amount of ${asset.symbol}`, to });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't make the link.");
      setMade(null);
    }
  }

  return (
    <div>
      <form onSubmit={onCreate} noValidate className="mt-3 space-y-4">
        <div>
          <label htmlFor="sol-req-amount" className="text-[13px] text-mute">
            Amount <span className="text-faint">(optional)</span>
          </label>
          <div data-invalid={Boolean(error || typedProblem) || undefined} className="gl-inputcard mt-2 flex items-center gap-2 rounded-[16px] py-2 pl-4 pr-2">
            <input
              id="sol-req-amount"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setError(null);
                setMade(null);
              }}
              placeholder="0"
              aria-invalid={error || typedProblem ? true : undefined}
              aria-describedby="sol-req-amount-hint"
              className="tnum min-w-0 flex-1 bg-transparent text-[28px] font-light leading-[1.25] tracking-[-0.02em] text-foreground outline-none! placeholder:text-faint"
            />
            <SolanaAssetSelect
              value={asset.id}
              onChange={(id) => {
                setAssetId(id);
                setError(null);
                setMade(null);
              }}
              label="Token to be paid in"
              assets={assets}
            />
          </div>
          {error || typedProblem ? (
            <p id="sol-req-amount-hint" role="alert" className="mt-2 text-[12.5px] leading-relaxed text-danger">
              {error ?? typedProblem}
            </p>
          ) : (
            <p id="sol-req-amount-hint" className="mt-2 text-[12.5px] leading-relaxed text-mute">
              Leave it empty to let them choose how much.
            </p>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor="sol-req-note" className="text-[13px] text-mute">
              Note <span className="text-faint">(optional)</span>
            </label>
            <input
              id="sol-req-note"
              type="text"
              autoComplete="off"
              maxLength={SOLANA_REQUEST_NOTE_MAX}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setMade(null);
              }}
              placeholder="e.g. Invoice 042"
              className="gl-input mt-2"
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="sol-req-name" className="text-[13px] text-mute">
              Your name <span className="text-faint">(optional)</span>
            </label>
            <input
              id="sol-req-name"
              type="text"
              autoComplete="off"
              maxLength={SOLANA_REQUEST_NAME_MAX}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setMade(null);
              }}
              placeholder="Shown to them, like Robin"
              className="gl-input mt-2"
            />
          </div>
        </div>
        <button type="submit" className="btn btn-ink btn-lg btn-block" disabled={!to}>
          {live ? "Update request link" : "Create request link"}
        </button>
        <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-mute">
          <span className="mt-[3px] shrink-0 text-sealed" aria-hidden>
            <LockGlyph />
          </span>
          This link stays between you and the person you send it to. Nothing about the request goes on chain.
        </p>
      </form>
      <div aria-live="polite" className="mt-4">
        {live && <SolanaLinkShare key={live.url} url={live.url} kind="request" label={live.label} />}
      </div>
    </div>
  );
}

/** Shown above Pay when a request link opened it. The name is what the link says, never trusted on its own. */
export function SolanaRequestBanner({ request, onDismiss }: { request: SolanaRequest; onDismiss: () => void }) {
  const amount = request.amount !== null ? amountLabel(request.amount, request.asset) : null;
  return (
    <section aria-label="Payment request" className="mt-5 rounded-[16px] border border-line bg-surface p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-1.5 text-[12px] font-medium text-mute">
            <span className="text-sealed" aria-hidden>
              <LockGlyph />
            </span>
            Payment request
          </p>
          <p className="mt-1.5 break-words text-[17px] leading-snug text-foreground">
            {request.name ? <span className="font-medium">{request.name}</span> : "Someone"}{" "}
            {amount ? (
              <>
                asked for <span className="tnum font-medium">{amount}</span>
              </>
            ) : (
              <>asked to be paid in {request.asset.symbol}</>
            )}
            {request.note && <span className="text-mute"> · {request.note}</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close payment request"
          className="-mr-1.5 -mt-1.5 grid h-10 w-10 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-panel hover:text-foreground"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
        To {shortSol(request.to)}. Check the details below, then press Pay privately. On Solana the note stays with you: it is not sent with the payment.
      </p>
      {request.name && <p className="mt-2 text-[12.5px] leading-relaxed text-warn">The name comes from the link. Check the address with them before you pay.</p>}
    </section>
  );
}
