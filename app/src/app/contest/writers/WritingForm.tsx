"use client";

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { contestDay } from "@/lib/contest";
import {
  WRITING_CONTEST,
  WRITING_KINDS,
  WRITING_KIND_LABEL,
  WRITING_LIMITS,
  WritingInputError,
  parseWritingInput,
  type WritingField,
} from "@/lib/writingContest";
import { CHEVRON, Row, Tick } from "../ContestForm";

type Done = { updated: boolean };

/**
 * The writing contest entry form. It checks an entry with the same rules as
 * the server (lib/writingContest) before sending, and shows the server's
 * answer by the field it names. `closed` comes from the server render.
 */
export function WritingForm({ closed }: { closed: boolean }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ field: WritingField | null; message: string } | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  if (closed) return <Closed />;
  if (done) return <Success done={done} />;

  function show(err: { field: WritingField | null; message: string }) {
    setError(err);
    if (err.field) document.getElementById(`w-${err.field}`)?.focus();
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (sending) return;
    const f = new FormData(e.currentTarget);
    const body = {
      name: String(f.get("name") ?? ""),
      handle: String(f.get("handle") ?? ""),
      post: String(f.get("post") ?? ""),
      kind: String(f.get("kind") ?? ""),
      title: String(f.get("title") ?? ""),
      email: String(f.get("email") ?? ""),
      agree: f.get("agree") === "on",
      marketing: f.get("marketing") === "on",
      hp: String(f.get("hp") ?? ""),
    };
    try {
      parseWritingInput(body);
    } catch (err) {
      if (err instanceof WritingInputError) return show({ field: err.field, message: err.message });
      throw err;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/contest/writers/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true; data: Done }
        | { ok: false; error: { field: WritingField | null; message: string } }
        | null;
      if (json?.ok) setDone(json.data);
      else show(json?.error ?? { field: null, message: "We couldn't send that. Try again in a moment." });
    } catch {
      show({ field: null, message: "No connection. Check your internet and try again." });
    } finally {
      setSending(false);
    }
  }

  const fieldError = (k: WritingField) => (error?.field === k ? error.message : null);
  const described = (k: WritingField, hint = false) => (fieldError(k) ? `w-${k}-err` : hint ? `w-${k}-hint` : undefined);

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <Row label="Name" htmlFor="w-name" error={fieldError("name")}>
        <input
          id="w-name"
          name="name"
          required
          autoComplete="name"
          maxLength={WRITING_LIMITS.name}
          className="gl-input"
          aria-invalid={Boolean(fieldError("name"))}
          aria-describedby={described("name")}
        />
      </Row>

      <Row label="X handle" htmlFor="w-handle" error={fieldError("handle")}>
        <input
          id="w-handle"
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

      <Row label="What you wrote" htmlFor="w-kind" error={fieldError("kind")}>
        <select
          id="w-kind"
          name="kind"
          required
          defaultValue=""
          className="gl-input appearance-none bg-[length:12px] bg-[right_1rem_center] bg-no-repeat pr-10"
          style={{ backgroundImage: CHEVRON }}
          aria-invalid={Boolean(fieldError("kind"))}
          aria-describedby={described("kind")}
        >
          <option value="" disabled>
            Choose one
          </option>
          {WRITING_KINDS.map((k) => (
            <option key={k} value={k}>
              {WRITING_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </Row>

      <Row
        label="Link to your post on X"
        htmlFor="w-post"
        hint={`The first post of your thread, or your X Article (or the post that shares it). Quote the announcement and tag @${WRITING_CONTEST.account}.`}
        error={fieldError("post")}
      >
        <input
          id="w-post"
          name="post"
          type="url"
          inputMode="url"
          required
          placeholder="https://x.com/yourname/status/…"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={WRITING_LIMITS.post}
          className="gl-input"
          aria-invalid={Boolean(fieldError("post"))}
          aria-describedby={described("post", true)}
        />
      </Row>

      <Row label="Title or first line" optional htmlFor="w-title" error={fieldError("title")}>
        <input
          id="w-title"
          name="title"
          autoComplete="off"
          maxLength={WRITING_LIMITS.title}
          className="gl-input"
          aria-invalid={Boolean(fieldError("title"))}
          aria-describedby={described("title")}
        />
      </Row>

      <Row label="Email" optional htmlFor="w-email" hint="Only used to reach you if you win." error={fieldError("email")}>
        <input
          id="w-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={WRITING_LIMITS.email}
          className="gl-input"
          aria-invalid={Boolean(fieldError("email"))}
          aria-describedby={described("email", true)}
        />
      </Row>

      <Check id="w-agree" name="agree" error={fieldError("agree")}>
        This is my own writing and I agree to the{" "}
        <a href="#rules" className="text-foreground underline underline-offset-2">
          contest rules
        </a>
        .
      </Check>

      <Check id="w-marketing" name="marketing" error={fieldError("marketing")}>
        Gloam may share and quote my writing, with credit to me.
      </Check>

      {/* people never see this field; bots fill it */}
      <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor="w-hp">Leave this empty</label>
        <input id="w-hp" name="hp" tabIndex={-1} autoComplete="off" />
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

function Check({ id, name, error, children }: { id: string; name: string; error: string | null; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="flex cursor-pointer items-start gap-3 text-[14.5px] leading-relaxed text-soft">
        <input
          id={id}
          name={name}
          type="checkbox"
          required
          className="mt-[3px] h-[18px] w-[18px] shrink-0 cursor-pointer accent-[var(--foreground)]"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        <span>{children}</span>
      </label>
      {error && (
        <p id={`${id}-err`} className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      )}
    </div>
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
        We&rsquo;ll announce winners by {contestDay(WRITING_CONTEST.winnersBy, false)} on @{WRITING_CONTEST.account}.
      </p>
      <p className="mt-2 max-w-[42ch] text-[15px] leading-relaxed text-soft">Keep your post on X public until winners are paid.</p>
      <p className="mt-5 text-[13px] leading-relaxed text-mute">To change your entry, send the form again with the same X handle.</p>
    </div>
  );
}

function Closed() {
  return (
    <div role="status" className="flex flex-col items-start">
      <h2 className="text-[24px] font-light tracking-[-0.02em] text-foreground">Entries are closed.</h2>
      <p className="mt-2 max-w-[42ch] text-[15px] leading-relaxed text-soft">
        Winners are announced by {contestDay(WRITING_CONTEST.winnersBy, false)} on @{WRITING_CONTEST.account}.
      </p>
      <a
        href={`https://x.com/${WRITING_CONTEST.account}`}
        target="_blank"
        rel="noreferrer"
        className="mt-5 text-[14px] text-mute underline decoration-line-strong underline-offset-4 hover:text-foreground"
      >
        Follow @{WRITING_CONTEST.account}
      </a>
    </div>
  );
}
