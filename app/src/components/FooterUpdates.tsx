"use client";

import { useState, type FormEvent } from "react";
import { subscribeToUpdates } from "@/lib/updatesClient";
import { BusyLabel } from "./ui/Spinner";

/**
 * "Get Gloam updates" in the site footer: one email field. Sends the email
 * alone (lib/updatesClient), with a field people never see that bots fill.
 */
export function FooterUpdates() {
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (sending) return;
    const f = new FormData(e.currentTarget);
    setSending(true);
    setError(null);
    const res = await subscribeToUpdates(String(f.get("email") ?? ""), "site", String(f.get("hp") ?? ""));
    setSending(false);
    if (res.ok) setDone(true);
    else setError(res.message);
  }

  if (done) {
    return (
      <p className="mt-8 text-[14px] text-soft" role="status">
        You&apos;re on the list. Every update has an unsubscribe link.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="relative mt-8 max-w-[360px]">
      <label htmlFor="footer-updates" className="text-[13px] text-mute">
        Get Gloam updates
      </label>
      <div className="mt-2 flex gap-2">
        <input
          id="footer-updates"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={254}
          placeholder="you@example.com"
          className="gl-input h-10 min-w-0 flex-1 text-[14px]"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "footer-updates-err" : undefined}
        />
        <button type="submit" disabled={sending} aria-busy={sending} className="btn btn-ink btn-sm h-10 shrink-0">
          <BusyLabel busy={sending}>Subscribe</BusyLabel>
        </button>
      </div>
      {/* people never see this field; bots fill it */}
      <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor="footer-updates-hp">Leave this empty</label>
        <input id="footer-updates-hp" name="hp" tabIndex={-1} autoComplete="off" />
      </div>
      {error && (
        <p id="footer-updates-err" role="alert" className="mt-2 text-[12.5px] leading-relaxed text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
