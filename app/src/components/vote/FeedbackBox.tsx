"use client";

import { useId, useState } from "react";
import { useSignTypedData } from "wagmi";
import { FEEDBACK_CATEGORIES, FEEDBACK_MAX, cleanFeedback, feedbackTypedData, type FeedbackCategory } from "@/lib/vote/core";
import { CheckIcon } from "./VoteParts";
import { Spinner } from "@/components/ui/Spinner";

type Phase = { k: "edit" } | { k: "signing" } | { k: "sending" } | { k: "sent" } | { k: "error"; message: string };

/**
 * The last, optional step after voting: a note to the team. Signed like a
 * vote (free, nothing on chain) so it always comes from a holder, and kept
 * private: only the team reads it.
 */
export function FeedbackBox({ address }: { address: `0x${string}` }) {
  const id = useId();
  const [category, setCategory] = useState<FeedbackCategory>("Idea");
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ k: "edit" });
  const { signTypedDataAsync } = useSignTypedData();
  const message = cleanFeedback(text);
  const busy = phase.k === "signing" || phase.k === "sending";

  async function send() {
    if (busy || message.length < 3) return;
    setPhase({ k: "signing" });
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = await signTypedDataAsync({ ...feedbackTypedData({ category, message, author: address, timestamp }), account: address });
      setPhase({ k: "sending" });
      const res = await fetch("/api/vote/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author: address, category, message, timestamp, signature }),
      });
      const j = (await res.json().catch(() => null)) as { ok: boolean; error?: { message: string } } | null;
      if (j?.ok) setPhase({ k: "sent" });
      else setPhase({ k: "error", message: j?.error?.message ?? "We couldn't send that. Try again." });
    } catch (e) {
      const msg = e instanceof Error ? `${e.name} ${e.message}` : "";
      setPhase({ k: "error", message: /reject|denied|cancel/i.test(msg) ? "No problem. Nothing was sent." : "We couldn't reach Gloam. Check your connection and try again." });
    }
  }

  if (phase.k === "sent") {
    return (
      <section aria-live="polite" className="gl-card gl-settle p-5 sm:p-8">
        <div className="flex items-start gap-3">
          <span className="gl-pop mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-sealed text-panel">
            <CheckIcon size={16} stroke={2.2} />
          </span>
          <div>
            <p className="text-[18px] leading-snug tracking-[-0.01em] text-foreground">Thank you. It&apos;s with the team now.</p>
            <p className="mt-1 text-[14.5px] leading-relaxed text-soft">We read every note. It stays private to the Gloam team.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby={`${id}-t`} className="gl-card p-5 sm:p-8">
      <h2 id={`${id}-t`} className="text-[20px] leading-snug tracking-[-0.01em] text-foreground sm:text-[22px]">
        Anything you&apos;d like us to build or fix?
      </h2>
      <p className="mt-2 text-[14.5px] leading-relaxed text-soft">Optional. Your note goes only to the Gloam team and is never shown publicly.</p>

      <div role="radiogroup" aria-label="Kind of note" className="mt-5 flex flex-wrap gap-2">
        {FEEDBACK_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={category === c}
            onClick={() => setCategory(c)}
            disabled={busy}
            className={`min-h-10 rounded-full border px-4 text-[14px] transition-colors ${
              category === c ? "border-foreground bg-foreground text-panel" : "border-line text-soft hover:border-line-strong hover:text-foreground"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <label htmlFor={`${id}-m`} className="sr-only">
        Your note
      </label>
      <textarea
        id={`${id}-m`}
        value={text}
        onChange={(e) => {
          setText(e.target.value.slice(0, FEEDBACK_MAX));
          if (phase.k === "error") setPhase({ k: "edit" });
        }}
        disabled={busy}
        rows={4}
        maxLength={FEEDBACK_MAX}
        placeholder="What would make Gloam more useful to you?"
        className="gl-input mt-4 min-h-[120px] w-full resize-y py-3 leading-relaxed"
      />
      <div className="mt-2 flex items-center justify-between gap-4 text-[12.5px] text-mute">
        <span>Plain text. Links and formatting are removed.</span>
        <span className="tnum" aria-live="off">
          {text.length.toLocaleString("en-US")} / {FEEDBACK_MAX.toLocaleString("en-US")}
        </span>
      </div>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <button type="button" onClick={send} disabled={busy || message.length < 3} aria-busy={busy} className="btn btn-ghost btn-lg w-full sm:w-auto">
          {busy && <Spinner />}
          {phase.k === "signing" ? "Sign in your wallet…" : phase.k === "sending" ? "Sending…" : "Sign and send"}
        </button>
        <p className="text-[13px] leading-relaxed text-mute">You sign your note so we know it&apos;s from a holder. It&apos;s free and nothing goes on chain.</p>
      </div>
      {phase.k === "error" && (
        <p role="alert" className="mt-3 text-[14px] text-danger">
          {phase.message}
        </p>
      )}
    </section>
  );
}
