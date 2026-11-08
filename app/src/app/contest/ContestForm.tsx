"use client";

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  CONTEST,
  CONTEST_LIMITS,
  CONTEST_NETWORKS,
  CONTEST_NETWORK_LABEL,
  ContestInputError,
  contestDay,
  parseContestInput,
  type ContestField,
} from "@/lib/contest";

type Done = { updated: boolean };

/**
 * The entry form. It checks an entry with the same rules as the server
 * (lib/contest) before sending, and shows the server's answer by the field it
 * names. `closed` comes from the server render, so both agree.
 */
export function ContestForm({ closed }: { closed: boolean }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ field: ContestField | null; message: string } | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [noteLen, setNoteLen] = useState(0);

  if (closed) return <Closed />;
  if (done) return <Success done={done} />;

  function show(err: { field: ContestField | null; message: string }) {
    setError(err);
    if (err.field) document.getElementById(`c-${err.field}`)?.focus();
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (sending) return;
    const f = new FormData(e.currentTarget);
    const body = {
      name: String(f.get("name") ?? ""),
      handle: String(f.get("handle") ?? ""),
      post: String(f.get("post") ?? ""),
      video: String(f.get("video") ?? ""),
      note: String(f.get("note") ?? ""),
      email: String(f.get("email") ?? ""),
      network: String(f.get("network") ?? ""),
      agree: f.get("agree") === "on",
      hp: String(f.get("hp") ?? ""),
    };
    try {
      parseContestInput(body);
    } catch (err) {
      if (err instanceof ContestInputError) return show({ field: err.field, message: err.message });
      throw err;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/contest/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true; data: Done }
        | { ok: false; error: { field: ContestField | null; message: string } }
        | null;
      if (json?.ok) setDone(json.data);
      else show(json?.error ?? { field: null, message: "We couldn't send that. Try again in a moment." });
    } catch {
      show({ field: null, message: "No connection. Check your internet and try again." });
    } finally {
      setSending(false);
    }
  }

  const fieldError = (k: ContestField) => (error?.field === k ? error.message : null);
  const described = (k: ContestField, hint = false) => (fieldError(k) ? `c-${k}-err` : hint ? `c-${k}-hint` : undefined);

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <Row label="Name" htmlFor="c-name" error={fieldError("name")}>
        <input
          id="c-name"
          name="name"
          required
          autoComplete="name"
          maxLength={CONTEST_LIMITS.name}
          className="gl-input"
          aria-invalid={Boolean(fieldError("name"))}
          aria-describedby={described("name")}
        />
      </Row>

      <Row label="X handle" htmlFor="c-handle" error={fieldError("handle")}>
        <input
          id="c-handle"
          name="handle"
          required
          placeholder="@yourname"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={40}
          className="gl-input"
          aria-invalid={Boolean(fieldError("handle"))}
          aria-describedby={described("handle")}
        />
      </Row>

      <Row
        label="Link to your post on X"
        htmlFor="c-post"
        hint={`The post that quotes the announcement, with ${CONTEST.hashtag}. It can hold the video or link to it.`}
        error={fieldError("post")}
      >
        <input
          id="c-post"
          name="post"
          type="url"
          inputMode="url"
          required
          placeholder="https://x.com/yourname/status/…"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={CONTEST_LIMITS.post}
          className="gl-input"
          aria-invalid={Boolean(fieldError("post"))}
          aria-describedby={described("post", true)}
        />
      </Row>

      <Row
        label="Full video link (YouTube or other)"
        optional
        htmlFor="c-video"
        hint="For a longer video hosted somewhere other than X."
        error={fieldError("video")}
      >
        <input
          id="c-video"
          name="video"
          type="url"
          inputMode="url"
          placeholder="https://youtube.com/watch?v=…"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={CONTEST_LIMITS.video}
          className="gl-input"
          aria-invalid={Boolean(fieldError("video"))}
          aria-describedby={described("video", true)}
        />
      </Row>

      <Row label="What your video shows, in a sentence or two" optional htmlFor="c-note" error={fieldError("note")}>
        <textarea
          id="c-note"
          name="note"
          rows={3}
          maxLength={CONTEST_LIMITS.note}
          onChange={(e) => setNoteLen(e.currentTarget.value.length)}
          className="gl-input h-auto resize-y py-3 leading-relaxed"
          aria-invalid={Boolean(fieldError("note"))}
          aria-describedby={fieldError("note") ? "c-note-err" : "c-note-count"}
        />
        <p id="c-note-count" className="tnum mt-1.5 text-right text-[12px] text-faint">
          {noteLen} / {CONTEST_LIMITS.note}
        </p>
      </Row>

      <Row label="Email" optional htmlFor="c-email" hint="Only used to reach you if you win." error={fieldError("email")}>
        <input
          id="c-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={CONTEST_LIMITS.email}
          className="gl-input"
          aria-invalid={Boolean(fieldError("email"))}
          aria-describedby={described("email", true)}
        />
      </Row>

      <Row label="Network you used" htmlFor="c-network" error={fieldError("network")}>
        <select
          id="c-network"
          name="network"
          required
          defaultValue=""
          className="gl-input appearance-none bg-[length:12px] bg-[right_1rem_center] bg-no-repeat pr-10"
          style={{ backgroundImage: CHEVRON }}
          aria-invalid={Boolean(fieldError("network"))}
          aria-describedby={described("network")}
        >
          <option value="" disabled>
            Choose one
          </option>
          {CONTEST_NETWORKS.map((n) => (
            <option key={n} value={n}>
              {CONTEST_NETWORK_LABEL[n]}
            </option>
          ))}
        </select>
      </Row>

      <div>
        <label htmlFor="c-agree" className="flex cursor-pointer items-start gap-3 text-[14.5px] leading-relaxed text-soft">
          <input
            id="c-agree"
            name="agree"
            type="checkbox"
            required
            className="mt-[3px] h-[18px] w-[18px] shrink-0 cursor-pointer accent-[var(--foreground)]"
            aria-invalid={Boolean(fieldError("agree"))}
            aria-describedby={described("agree")}
          />
          <span>
            This is my own original work and I agree to the{" "}
            <a href="#rules" className="text-foreground underline underline-offset-2">
              contest rules
            </a>
            .
          </span>
        </label>
        {fieldError("agree") && (
          <p id="c-agree-err" className="mt-2 text-[13px] text-danger">
            {fieldError("agree")}
          </p>
        )}
      </div>

      {/* people never see this field; bots fill it */}
      <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor="c-hp">Leave this empty</label>
        <input id="c-hp" name="hp" tabIndex={-1} autoComplete="off" />
      </div>

      {error && !error.field && (
        <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger">
          {error.message}
        </p>
      )}

      <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
        <button type="submit" disabled={sending} aria-busy={sending} className="btn btn-ink btn-lg">
          {sending ? "Sending…" : "Send my entry"}
        </button>
        <p className="text-[12.5px] leading-relaxed text-mute sm:max-w-[30ch] sm:text-right">
          We never ask for a private key, a seed phrase or a wallet connection.
        </p>
      </div>

      <p className="text-[12.5px] leading-relaxed text-mute">
        By entering you agree to the contest rules on this page and our{" "}
        <Link href="/terms" className="text-foreground underline underline-offset-2">
          Terms of Use
        </Link>
        . Our{" "}
        <Link href="/privacy" className="text-foreground underline underline-offset-2">
          Privacy Policy
        </Link>{" "}
        explains what we keep and for how long.
      </p>
    </form>
  );
}

/** A small chevron for the select, drawn in the muted text colour. */
const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";

function Row({
  label,
  htmlFor,
  optional,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  optional?: boolean;
  hint?: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="flex items-baseline justify-between gap-3 text-[13.5px] text-foreground">
        {label}
        {optional && <span className="shrink-0 text-[12.5px] text-faint">Optional</span>}
      </label>
      <div className="mt-2">{children}</div>
      {error ? (
        <p id={`${htmlFor}-err`} className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="mt-2 text-[13px] text-mute">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Tick() {
  return (
    <span aria-hidden className="grid h-11 w-11 place-items-center rounded-full bg-sealed-soft text-sealed">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function Success({ done }: { done: Done }) {
  return (
    <div role="status" className="flex flex-col items-start">
      <Tick />
      <h2 className="mt-5 text-[24px] font-light tracking-[-0.02em] text-foreground">
        {done.updated ? "Your entry was updated." : "You're in."}
      </h2>
      <p className="mt-2 max-w-[42ch] text-[15px] leading-relaxed text-soft">
        We&rsquo;ll announce winners by {contestDay(CONTEST.winnersBy, false)} on @{CONTEST.account}.
      </p>
      <p className="mt-2 max-w-[42ch] text-[15px] leading-relaxed text-soft">
        Keep your post on X public until winners are paid.
      </p>
      <p className="mt-5 text-[13px] leading-relaxed text-mute">
        To change your entry, send the form again with the same X handle.
      </p>
    </div>
  );
}

function Closed() {
  return (
    <div role="status" className="flex flex-col items-start">
      <h2 className="text-[24px] font-light tracking-[-0.02em] text-foreground">Entries are closed.</h2>
      <p className="mt-2 max-w-[42ch] text-[15px] leading-relaxed text-soft">
        Winners are announced by {contestDay(CONTEST.winnersBy, false)} on @{CONTEST.account}.
      </p>
      <a
        href={`https://x.com/${CONTEST.account}`}
        target="_blank"
        rel="noreferrer"
        className="mt-5 text-[14px] text-mute underline decoration-line-strong underline-offset-4 hover:text-foreground"
      >
        Follow @{CONTEST.account}
      </a>
    </div>
  );
}
