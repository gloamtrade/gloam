/**
 * Content-Security-Policy violation reports (app/api/csp-report): what is kept of one.
 *
 * A browser puts the page's whole address in a report (document-uri, or
 * documentURL), query and fragment included, and the page is often one that
 * holds a secret there: a claim code on /c and /claim is the payment itself,
 * /r holds a payment request and /verify a proof. The referrer, the source file
 * and the script sample can hold the same. So a report keeps only:
 *
 *  - the page's path, cut at "?", "#" and an escaped "#" ("%23"), with any
 *    segment that looks like a code, an address or a long blob replaced
 *    (lib/analyticsClean cleanPath);
 *  - the directive it broke (script-src-elem, connect-src...), from a fixed list;
 *  - what was blocked: its origin, never its path or query, or its kind
 *    ("inline", "eval", "data", "blob", an extension); a host name label that
 *    could carry a code (a long run of letters and digits) is replaced;
 *  - whether the policy was enforced or report-only, and whether a browser
 *    extension caused it (counted apart: extensions inject into every page).
 *
 * Never the referrer, the sample, the source file, the policy, the status code
 * or the user agent.
 */
import { cleanPath } from "./analyticsClean";
import { kv } from "./partnersKv";

/** A report body larger than this is refused unread. Browsers send well under 4 KB a report. */
export const CSP_REPORT_MAX_BYTES = 16_384;
/** Reports read from one request (report-to batches them); the rest are dropped. */
export const CSP_REPORTS_PER_REQUEST = 20;

/** "unknown" when an older browser leaves it out. */
export type CspDisposition = "enforce" | "report" | "unknown";

export type CspViolation = {
  path: string;
  directive: string;
  blocked: string;
  disposition: CspDisposition;
  extension: boolean;
};

/** Directive names a report can carry. Anything else is counted as "other". */
const DIRECTIVES = new Set([
  "default-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "img-src",
  "font-src",
  "connect-src",
  "media-src",
  "object-src",
  "frame-src",
  "child-src",
  "worker-src",
  "manifest-src",
  "prefetch-src",
  "fenced-frame-src",
  "frame-ancestors",
  "base-uri",
  "form-action",
  "navigate-to",
  "require-trusted-types-for",
  "trusted-types",
  "upgrade-insecure-requests",
  "block-all-mixed-content",
  "sandbox",
]);

/** What a browser writes for a blocked thing that has no URL. */
const KEYWORDS = new Set(["inline", "eval", "wasm-eval", "trusted-types-policy", "trusted-types-sink"]);

const EXTENSION_SCHEMES = new Set(["chrome-extension", "moz-extension", "safari-extension", "safari-web-extension", "ms-browser-extension"]);

/** The directive's name: the first word of violated-directive in older reports, which carry its sources too. */
export function directiveOf(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  const name = raw.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (!name) return "unknown";
  return DIRECTIVES.has(name) ? name : "other";
}

/** A host name label that could carry a code: a long run of letters and digits, or hex. */
function sensitiveLabel(label: string): boolean {
  return /^[a-z0-9]{20,}$/i.test(label) || /^(?:0x)?[0-9a-f]{16,}$/i.test(label) || /gloam(?:r1|2t|1e|1|3)/i.test(label);
}

/** The URL's scheme, without the colon, or null when it is not a URL. */
function schemeOf(raw: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(raw.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** True for a URL from a browser extension. */
function fromExtension(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const s = schemeOf(raw);
  return s !== null && EXTENSION_SCHEMES.has(s);
}

/**
 * What was blocked: an http(s) or ws(s) URL's origin, a keyword ("inline",
 * "eval"), or a scheme ("data", "blob", "chrome-extension"). Never a path, a
 * query, a fragment or an extension's id.
 */
export function blockedOf(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "none";
  const s = raw.trim();
  if (KEYWORDS.has(s.toLowerCase())) return s.toLowerCase();
  const scheme = schemeOf(s);
  if (scheme === null) return "other";
  if (!["http", "https", "ws", "wss"].includes(scheme)) return /^[a-z][a-z0-9+.-]{0,30}$/.test(scheme) ? scheme : "other";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return "other";
  }
  const host = u.hostname
    .split(".")
    .map((label) => (sensitiveLabel(label) ? "redacted" : label))
    .join(".");
  const origin = `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`;
  return origin.length <= 120 ? origin : `${u.protocol}//redacted`;
}

function dispositionOf(raw: unknown): CspDisposition {
  return raw === "report" || raw === "enforce" ? raw : "unknown";
}

type Fields = {
  documentURL: unknown;
  directive: unknown;
  blockedURL: unknown;
  disposition: unknown;
  sourceFile: unknown;
};

function violation(f: Fields): CspViolation {
  return {
    path: cleanPath(f.documentURL) ?? "unknown",
    directive: directiveOf(f.directive),
    blocked: blockedOf(f.blockedURL),
    disposition: dispositionOf(f.disposition),
    extension: fromExtension(f.blockedURL) || fromExtension(f.sourceFile),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The violations in a report body, by its Content-Type:
 *  - application/csp-report (report-uri): {"csp-report": {"document-uri", "effective-directive", ...}}
 *  - application/reports+json (report-to): [{"type": "csp-violation", "body": {"documentURL", ...}}],
 *    where entries of any other type are skipped
 *  - application/json: either shape (some browsers label report-uri bodies so)
 * Null when the body is not a report at all.
 */
export function parseCspReports(contentType: string, text: string): CspViolation[] | null {
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const out: CspViolation[] = [];
  if ((type === "application/csp-report" || type === "application/json") && isObject(data) && isObject(data["csp-report"])) {
    const r = data["csp-report"];
    out.push(
      violation({
        documentURL: r["document-uri"],
        directive: r["effective-directive"] ?? r["violated-directive"],
        blockedURL: r["blocked-uri"],
        disposition: r["disposition"],
        sourceFile: r["source-file"],
      }),
    );
    return out;
  }
  if ((type === "application/reports+json" || type === "application/json") && Array.isArray(data)) {
    for (const entry of data.slice(0, CSP_REPORTS_PER_REQUEST)) {
      if (!isObject(entry) || entry.type !== "csp-violation" || !isObject(entry.body)) continue;
      const b = entry.body;
      out.push(
        violation({
          documentURL: b.documentURL ?? entry.url,
          directive: b.effectiveDirective ?? b.violatedDirective,
          blockedURL: b.blockedURL,
          disposition: b.disposition,
          sourceFile: b.sourceFile,
        }),
      );
    }
    return out;
  }
  return null;
}

/** The same violations folded together, with how many of each, for one log line apiece. */
export function foldViolations(list: CspViolation[]): (CspViolation & { n: number })[] {
  const byKey = new Map<string, CspViolation & { n: number }>();
  for (const v of list) {
    const key = JSON.stringify([v.path, v.directive, v.blocked, v.disposition, v.extension]);
    const cur = byKey.get(key);
    if (cur) cur.n++;
    else byKey.set(key, { ...v, n: 1 });
  }
  return [...byKey.values()];
}

/**
 * The body, read up to `max` bytes. Null once it runs past them: the rest is
 * never read. A declared Content-Length over the cap is refused before reading.
 */
export async function readCappedBody(req: Request, max = CSP_REPORT_MAX_BYTES): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const PREFIX = "gloam:csp:v1:";
/** Days of counts kept. */
const TTL_SEC = 90 * 86_400;

/** The Redis hash that holds one UTC day's counts. */
export function cspCountKey(now = Date.now()): string {
  return `${PREFIX}${new Date(now).toISOString().slice(0, 10)}`;
}

/** The field a violation is counted under: "enforce:connect-src", "report:img-src", "ext:report:script-src-elem". */
export function cspCountField(v: CspViolation): string {
  return `${v.extension ? "ext:" : ""}${v.disposition}:${v.directive}`;
}

/**
 * Adds the violations to today's counts, one field per directive (and per
 * enforced or report-only, and extension or not). Best effort: with no store,
 * or one that does not answer, nothing is counted and nothing is thrown.
 */
export async function countCspViolations(list: CspViolation[], now = Date.now()): Promise<void> {
  if (list.length === 0) return;
  const fields = new Map<string, number>();
  for (const v of list) fields.set(cspCountField(v), (fields.get(cspCountField(v)) ?? 0) + 1);
  const key = cspCountKey(now);
  try {
    await kv([...[...fields].map(([field, n]) => ["HINCRBY", key, field, n]), ["EXPIRE", key, TTL_SEC]]);
  } catch {
    // counting is best effort
  }
}
