/**
 * What the analytics intake (/api/collect) keeps of a path or a referrer.
 *
 * The app sends only window.location.pathname, but the intake accepts what any
 * caller posts, and it logs and stores it and may forward it to a webhook. A
 * claim code lives in a URL fragment and a proof can sit in a query, so a path
 * is cut at "?" and "#" (and at "%23", a "#" a chat app escaped), must be a same-site path, and any segment that looks
 * like a code, an address, a hash or a long blob is replaced before it is kept.
 */

const MAX_PATH = 120;
const MAX_SEGMENTS = 8;
const REDACTED = ":redacted";

/**
 * A Wallet X-ray page: its path holds the wallet someone looked up, an address
 * or an ENS name, and analytics never gets either. Unlike the other sensitive
 * segments a name reads as an ordinary slug, so this goes by the route.
 */
const XRAY_PAGE = /\/xray\/[^/?#]+.*$/;

/** A path or full URL with any looked-up wallet taken out. Runs in the browser, before anything is sent. */
export function withoutLookup(pathOrUrl: string): string {
  return pathOrUrl.replace(XRAY_PAGE, `/xray/${REDACTED}`);
}

/**
 * Where the private part of a URL starts: the query, the fragment, or a "#"
 * that a chat app wrote as "%23" (or "%2523"), which puts a short link's body
 * in the path itself (lib/mangledLink).
 */
const PRIVATE_FROM = /[?#]|%(?:25)*23/i;

/** A path or full URL up to its private part, with any looked-up wallet taken out. Runs in the browser, before anything is sent. */
export function analyticsUrl(pathOrUrl: string): string {
  return withoutLookup(pathOrUrl.split(PRIVATE_FROM, 1)[0]!);
}

/** A segment that could carry something private: a payment code, an address, a hash, a long number. */
const SENSITIVE_SEGMENT = /gloam(?:r1|2t|1e|1|3)|0x[0-9a-f]{8,}|^[0-9a-f]{24,}$|^\d{6,}$/i;
/** Readable slugs (blog posts, docs pages) are kept even when long. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True when a segment could hold a code, key or id rather than a route name. */
function sensitive(segment: string): boolean {
  if (SENSITIVE_SEGMENT.test(segment)) return true;
  // a long run of mixed letters and digits (base64, base58, ids) that isn't a plain slug
  return segment.length >= 24 && !SLUG.test(segment);
}

/** A clean same-site path, or null. Never more than the route and its plain segments. */
export function cleanPath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  let p = raw.split(PRIVATE_FROM, 1)[0]!;
  try {
    // a caller may send a full URL; keep only the path, and only of a plain http(s) URL
    if (/^[a-z][a-z0-9+.-]*:/i.test(p)) {
      const u = new URL(p);
      if (u.protocol !== "https:" && u.protocol !== "http:") return null;
      p = u.pathname;
    }
  } catch {
    return null;
  }
  if (!p.startsWith("/") || p.startsWith("//")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    return null;
  }
  const segments = decoded
    .split("/")
    .filter(Boolean)
    .slice(0, MAX_SEGMENTS)
    .map((s) => (sensitive(s) ? REDACTED : s.replace(/[^A-Za-z0-9._~-]/g, "")))
    .filter(Boolean);
  return withoutLookup(`/${segments.join("/")}`).slice(0, MAX_PATH);
}

/**
 * Referrer as origin + cleaned path only. A query string can carry a proof
 * (/verify?proof=) or anything another site put there.
 */
export function cleanRef(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.origin}${cleanPath(u.pathname) ?? "/"}`.slice(0, 200);
  } catch {
    return null;
  }
}
