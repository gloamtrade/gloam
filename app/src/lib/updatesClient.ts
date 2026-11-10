"use client";

import { normalizeEmail, type UpdatesSource } from "./updatesEmail";

/**
 * The browser side of the updates list (api/updates). Each call builds its body
 * from the email alone, plus where it was typed: never a wallet, an address or
 * an account id, and the route refuses any of them anyway.
 */

export type UpdatesResult = { ok: true } | { ok: false; message: string };

async function send(method: "POST", body: Record<string, string>): Promise<UpdatesResult> {
  try {
    const res = await fetch("/api/updates", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
    if (res.ok && json?.ok) return { ok: true };
    return { ok: false, message: json?.error?.message ?? "We couldn't save that. Try again in a moment." };
  } catch {
    return { ok: false, message: "No connection. Check your internet and try again." };
  }
}

/** Adds an email to the updates list. */
export function subscribeToUpdates(email: string, source: UpdatesSource, hp?: string): Promise<UpdatesResult> {
  const clean = normalizeEmail(email);
  if (!clean) return Promise.resolve({ ok: false, message: "That email doesn't look right. Check it and try again." });
  return send("POST", hp ? { email: clean, source, hp } : { email: clean, source });
}

/**
 * There is no unsubscribe by email here: anyone can type anyone's email. People
 * leave with the link at the bottom of every update (/unsubscribe?token=).
 */
