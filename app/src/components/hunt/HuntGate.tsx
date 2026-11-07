"use client";

import { useState, type FormEvent, type ReactNode } from "react";

/** Plain text with any https link made clickable. */
function withLinks(text: string): ReactNode[] {
  return text.split(/(https:\/\/[^\s<>"']+)/g).map((part, i) =>
    /^https:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

/**
 * The hidden page's riddle and answer box. The answer is checked on the server
 * (/api/hunt); nothing here knows it or what comes next.
 */
export function HuntGate({ title, riddle }: { title: string; riddle: string }) {
  const [answer, setAnswer] = useState("");
  const [state, setState] = useState<"idle" | "checking" | "wrong" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!answer.trim() || state === "checking") return;
    setState("checking");
    setMessage(null);
    try {
      const res = await fetch("/api/hunt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: { next?: string }; error?: { message?: string } } | null;
      if (res.ok && json?.ok && json.data?.next) {
        setNext(json.data.next);
        setState("idle");
        return;
      }
      if (res.ok && json?.ok) {
        setState("wrong");
        setMessage("Not quite. Read it again.");
        return;
      }
      setState("error");
      setMessage(json?.error?.message ?? "That didn't go through. Try again in a minute.");
    } catch {
      setState("error");
      setMessage("That didn't go through. Check your connection and try again.");
    }
  }

  return (
    <div>
      {title && <h1 className="t-display-m">{title}</h1>}
      <p className={`${title ? "mt-6" : ""} whitespace-pre-line text-[17px] leading-relaxed text-soft`}>{riddle}</p>
      {next ? (
        <div className="mt-10 rounded-2xl bg-sealed-soft px-5 py-5" role="status">
          <p className="whitespace-pre-line break-words text-[16px] leading-relaxed text-foreground">{withLinks(next)}</p>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="mt-10 flex flex-col gap-3 sm:flex-row">
          <label htmlFor="hunt-answer" className="sr-only">
            Your answer
          </label>
          <input
            id="hunt-answer"
            value={answer}
            onChange={(e) => {
              setAnswer(e.target.value);
              if (state !== "checking") setState("idle");
            }}
            placeholder="Your answer"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={200}
            className="gl-input"
          />
          <button type="submit" disabled={state === "checking" || !answer.trim()} className="btn btn-ink btn-lg shrink-0">
            {state === "checking" ? "Checking" : "Check"}
          </button>
        </form>
      )}
      {message && !next && (
        <p role={state === "error" ? "alert" : "status"} className={`mt-4 text-[14px] ${state === "error" ? "text-danger" : "text-mute"}`}>
          {message}
        </p>
      )}
    </div>
  );
}
