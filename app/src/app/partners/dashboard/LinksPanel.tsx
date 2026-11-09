"use client";

import { useState, type FormEvent } from "react";
import { portal, PortalError, type LinkCodeView } from "./client";
import { ago, Card, CopyButton, Field, fullDate, Notice } from "./ui";

const STATE_LABEL: Record<LinkCodeView["state"], string> = { live: "Live", revoked: "Revoked", expired: "Expired" };

/** The two link formats with a code in them, for the partner to copy. */
function examples(origin: string, code: string) {
  const o = origin || "https://gloam.trade";
  return {
    pay: `${o}/app/vault?tab=move&mode=pay#to=<0x… or gloamr1…>&amount=25&asset=USDG&chain=robinhood-mainnet&p=${code}`,
    swap: `${o}/app/vault?tab=swap#from=USDG&to=GLOAM&amount=100&chain=robinhood-mainnet&p=${code}`,
  };
}

function CodeRow({ c, origin, onChanged }: { c: LinkCodeView; origin: string; onChanged: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const live = c.state === "live";
  const ex = examples(origin, c.code);

  async function revoke() {
    setBusy(true);
    setErr(null);
    try {
      await portal(`/link-codes/${c.code}`, { method: "DELETE" });
      setConfirm(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof PortalError ? e.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`px-5 py-4 sm:px-6 ${live ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-2 text-[15px] text-foreground">
            <span className="truncate">{c.label || "Link code"}</span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11.5px] ${live ? "bg-sealed-soft text-sealed" : c.state === "revoked" ? "bg-danger-soft text-danger" : "bg-surface text-mute"}`}
            >
              {STATE_LABEL[c.state]}
            </span>
            {c.createdBy === "admin" && <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[11.5px] text-mute">From Gloam</span>}
          </p>
          <p className="tnum mt-1 truncate text-[13px] text-mute">p={c.code}</p>
        </div>
        <dl className="grid shrink-0 grid-cols-2 gap-x-6 text-[12.5px] max-sm:w-full sm:w-[240px]">
          <div>
            <dt className="text-faint">Made</dt>
            <dd className="text-soft" title={fullDate(c.createdAt)}>
              {ago(c.createdAt)}
            </dd>
          </div>
          <div>
            <dt className="text-faint">{c.revokedAt ? "Revoked" : "Expires"}</dt>
            <dd className="text-soft">{c.revokedAt ? ago(c.revokedAt) : c.expiresAt ? fullDate(c.expiresAt) : "Never"}</dd>
          </div>
        </dl>
        {live && (
          <div className="flex shrink-0 items-center gap-1 max-sm:-ml-3 max-sm:w-full sm:justify-end">
            <CopyButton text={c.code} label="Copy code" />
            <button type="button" className="btn btn-quiet btn-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? "Hide links" : "Show links"}
            </button>
            <button type="button" className="btn btn-quiet btn-sm text-danger" onClick={() => setConfirm(true)}>
              Revoke
            </button>
          </div>
        )}
      </div>
      {open && live && (
        <div className="mt-4 space-y-2">
          {(
            [
              ["Pay link", ex.pay],
              ["Swap link", ex.swap],
            ] as const
          ).map(([label, url]) => (
            <div key={label} className="flex min-w-0 items-center gap-1 rounded-xl bg-surface py-1 pl-4 pr-1">
              <span className="min-w-0 flex-1 py-2 text-[12.5px] leading-snug text-soft [overflow-wrap:anywhere]">
                <span className="mr-2 text-mute">{label}</span>
                {url}
              </span>
              <CopyButton text={url} />
            </div>
          ))}
        </div>
      )}
      {confirm && (
        <div className="mt-4 flex flex-col gap-3 rounded-xl bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13.5px] leading-relaxed text-soft">
            Revoke stops this code for good. Links with it still open, but nothing from them counts to you from now on. What they
            counted stays.
          </p>
          <div className="flex shrink-0 gap-2">
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirm(false)}>
              Keep it
            </button>
            <button type="button" disabled={busy} className="btn btn-danger btn-sm" onClick={() => void revoke()}>
              {busy ? "Revoking…" : "Revoke"}
            </button>
          </div>
        </div>
      )}
      {err && (
        <div className="mt-3">
          <Notice tone="danger">{err}</Notice>
        </div>
      )}
    </li>
  );
}

/**
 * Link codes: what a partner puts in a pay or swap link as `p=`, so payments and
 * swaps opened from it count to them (checked on chain once they land).
 */
export function LinksPanel({
  codes,
  maxLive,
  origin,
  onChanged,
  approvedName,
  name,
}: {
  codes: LinkCodeView[] | null;
  maxLive: number;
  origin: string;
  onChanged: () => void;
  /** The name Gloam approved to show in links, or null. */
  approvedName: string | null;
  /** The account's name now. */
  name: string;
}) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const live = (codes ?? []).filter((c) => c.state === "live").length;

  async function make(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await portal("/link-codes", { method: "POST", body: { label } });
      setLabel("");
      onChanged();
    } catch (e) {
      setErr(e instanceof PortalError ? e.message : "Could not make a code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card title="Your name in links">
        {approvedName ? (
          <p className="text-[14px] leading-relaxed text-soft">
            People who open your links see <span className="font-medium text-foreground">From {approvedName}</span> with a Gloam partner
            mark.
            {approvedName !== name ? ` Your account is now named ${name}; links keep showing ${approvedName} until Gloam approves the new name.` : ""}
          </p>
        ) : (
          <p className="text-[14px] leading-relaxed text-soft">
            Links show no partner name yet. Gloam checks a name before it shows next to the Gloam partner mark, so nobody can pass
            as Gloam or another brand. Your links still count to you meanwhile.
          </p>
        )}
        {approvedName !== name && (
          <p className="mt-3 text-[13.5px] text-mute">
            To show your name on links, message{" "}
            <a
              href="https://x.com/gloamtrade"
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground"
            >
              @gloamtrade on X
            </a>{" "}
            from your project&apos;s account. We&apos;ll approve it.
          </p>
        )}
      </Card>

      <Card title="New link code">
        <form onSubmit={make} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Field label="What it is for (optional)" htmlFor="lc-label" hint="Only you and Gloam see this. One code can go in every link you make.">
              <input id="lc-label" className="gl-input" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Fund button" />
            </Field>
          </div>
          <button type="submit" disabled={busy || live >= maxLive} className="btn btn-ink btn-lg shrink-0 sm:mb-[26px]">
            {busy ? "Making…" : "Make a code"}
          </button>
        </form>
        {err && (
          <div className="mt-3">
            <Notice tone="danger">{err}</Notice>
          </div>
        )}
      </Card>

      <Card
        title="Your link codes"
        flush
        action={<span className="text-[12.5px] text-mute">{codes ? `${live} of ${maxLive} live` : "Loading…"}</span>}
        foot={
          <>
            Add <span className="tnum text-foreground">p=&lt;code&gt;</span> to the part after # in a pay link or a swap link. The
            Gloam app ties each payment, cash out or swap opened from it to the code before it is sent, and Gloam counts it to you
            once it lands, checked on its chain. Only public facts about the transaction are kept: hash, chain, kind, token, amount
            and time. Never the payer&apos;s wallet or anything else about them. You see cash outs and swaps one by one, since they
            are public on chain; private payments only as counts per day. A name in a link (name=, ref=) counts for nothing.
            Nothing is charged.
          </>
        }
      >
        {codes === null ? (
          <div className="h-24 motion-safe:animate-pulse" aria-busy="true" />
        ) : codes.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13.5px] text-mute sm:px-6">No codes yet. Make one above.</p>
        ) : (
          <ul className="divide-y divide-line">
            {codes.map((c) => (
              <CodeRow key={c.code} c={c} origin={origin} onChanged={onChanged} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
