/**
 * The "Email me Gloam updates" list: the rules both the browser and the server
 * use. No server code here, so the forms can check an email before sending it.
 *
 * The list keeps an email address alone (lib/updatesList). Nothing that links a
 * person to a wallet ever goes with it: the forms send only the email and where
 * it was typed, and the route refuses any other field.
 */

/** Where someone asked for updates. */
export const UPDATES_SOURCES = ["sign-in", "settings", "site"] as const;
export type UpdatesSource = (typeof UPDATES_SOURCES)[number];

export const EMAIL_MAX = 254;

/**
 * An email trimmed and lowercased, or null when it isn't one we can send to.
 * Plain checks only: one @, a local part up to 64 characters, a domain with a
 * dot and no spaces or control characters anywhere.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX) return null;
  if (/[\s\u0000-\u001f\u007f<>()[\]\\,;:"]/.test(email)) return null;
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@")) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  const labels = domain.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((l) => /^[a-z0-9-]{1,63}$/.test(l) && !l.startsWith("-") && !l.endsWith("-"))) return null;
  if (!/^([a-z]{2,}|xn--[a-z0-9-]+)$/.test(labels[labels.length - 1] ?? "")) return null;
  return email;
}

export function isUpdatesSource(v: unknown): v is UpdatesSource {
  return typeof v === "string" && (UPDATES_SOURCES as readonly string[]).includes(v);
}
