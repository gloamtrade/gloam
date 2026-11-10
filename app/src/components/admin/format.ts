/**
 * Number and time formatting for /admin. Every figure on the page goes
 * through one of these, so dollars, counts and days read the same everywhere.
 */

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const countCompact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Dollars to the cent; "Not priced" when there is no price. */
export function fmtUsd(v: number | null | undefined): string {
  if (v == null) return "Not priced";
  if (v > 0 && v < 0.01) return "<$0.01";
  return usdFmt.format(v);
}

/**
 * Dollars for a big card figure: cents under $10k, whole dollars to $1M,
 * then $1.2M. The exact figure goes in the element's title.
 */
export function fmtUsdBig(v: number | null | undefined): string {
  if (v == null) return "Not priced";
  if (v > 0 && v < 0.01) return "<$0.01";
  const a = Math.abs(v);
  if (a < 10_000) return usdFmt.format(v);
  if (a < 1_000_000) return usdWhole.format(v);
  return usdCompact.format(v);
}

/** A short dollar label for a chart pill or axis: $840, $8.4K, $1.2M. */
export function fmtUsdShort(v: number): string {
  if (v > 0 && v < 0.01) return "<$0.01";
  if (Math.abs(v) < 1_000) return usdFmt.format(v).replace(/\.00$/, "");
  return usdCompact.format(v);
}

/** A count with separators: 1,204. */
export function n(v: number | null | undefined): string {
  return (v ?? 0).toLocaleString("en-US");
}

/** A short count for a chart pill: 840, 8.4K. */
export function nShort(v: number): string {
  return Math.abs(v) < 10_000 ? n(v) : countCompact.format(v);
}

/** Unix seconds as "Nov 3, 09:12 PM"; "None yet" for nothing. */
export function fmtWhen(ts: number | null | undefined): string {
  if (!ts) return "None yet";
  return new Date(ts * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A UTC day (YYYY-MM-DD) as "Nov 3". */
export function fmtDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** A UTC day's day of the month, for a chart axis. */
export function dayOfMonth(day: string): string {
  return String(Number(day.slice(8, 10)));
}

/** Seconds ago as "12s ago", "4m ago", "3h ago". */
export function fmtAge(sec: number): string {
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

/** Milliseconds since an event as "just now", "4m ago", "3h ago", "2d ago". */
export function agoMs(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** ETH to four places. */
export function fmtEth(v: number | null | undefined): string {
  if (v == null) return "Unknown";
  if (v > 0 && v < 0.0001) return "<0.0001 ETH";
  return `${v.toLocaleString("en-US", { maximumFractionDigits: 4 })} ETH`;
}

/** A share as "42%", or "<1%" for a sliver that is not zero. */
export function pctText(part: number, whole: number): string {
  if (!(whole > 0) || !(part > 0)) return "0%";
  const p = (part / whole) * 100;
  if (p < 1) return "<1%";
  return `${Math.round(p)}%`;
}

/** The UTC day a millisecond time falls on. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The last `count` UTC days ending today, oldest first. */
export function lastDays(count: number, now = Date.now()): string[] {
  return Array.from({ length: count }, (_, i) => utcDay(now - (count - 1 - i) * 86_400_000));
}
