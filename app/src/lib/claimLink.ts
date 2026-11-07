import {
  SHORT_CLAIM_PREFIX,
  decodeNotePackage as decodeSdkPackage,
  encodeShortClaim,
  shortClaimLink,
} from "@gloamtrade/sdk";
import { getNetwork, isNetworkKey } from "./networks";

/**
 * Claim links. New ones are short: gloam.trade/c#<about 30 letters and digits>
 * (SDK shortLink: a seed or the secret, a small id for chain, vault and token,
 * and the amount). A payment that can't be written short (an older code that
 * names no chain, a locked or sealed code) keeps the long form,
 * gloam.trade/claim?net=<network>#claim=<code>, and both keep working.
 *
 * The payment rides in the URL fragment, which browsers never send to a
 * server, so link previews in chat apps and our own server never see it. The
 * /c and /claim pages show the amount and send the person into the app to
 * claim. Older links (/app/vault?tab=move#claim=...) still open the app directly.
 */
export function claimLinkFor(code: string, networkKey: string, origin = "https://www.gloam.trade"): string {
  const body = shortBodyFor(code, networkKey);
  if (body) return shortClaimLink(body, origin);
  return longClaimLinkFor(code, networkKey, origin);
}

/** The long claim link (gloam.trade/claim?net=...#claim=gloam1=...), which every app version reads. */
export function longClaimLinkFor(code: string, networkKey: string, origin = "https://www.gloam.trade"): string {
  return `${origin}/claim?net=${encodeURIComponent(networkKey)}#claim=${linkSafe(code)}`;
}

/**
 * The code to show and copy for a payment: gloam3.<the short link's body>
 * when it can have a short link (same rule as claimLinkFor), else the code as
 * it is. Worked out when shown, so what is stored (sent links, payroll runs)
 * stays the full gloam1 code. Either form pastes back anywhere a code goes.
 * With no network given, the code's own chain is used.
 */
export function shortCodeFor(code: string, networkKey?: string): string {
  const body = shortBodyFor(code, networkKey);
  return body ? SHORT_CLAIM_PREFIX + body : code;
}

/**
 * The short link body for a code, or null. A gloam3 code already is one. A
 * plain gloam1 code gets one when it names its chain and that chain is the
 * link's network (or, with none given, any chain); anything else (locked,
 * sealed, older codes) keeps its long link.
 */
function shortBodyFor(code: string, networkKey?: string): string | null {
  const c = codeFromLinkText(code.trim());
  if (c.startsWith(SHORT_CLAIM_PREFIX)) return c.slice(SHORT_CLAIM_PREFIX.length) || null;
  if (!c.startsWith("gloam1.")) return null;
  try {
    const pack = decodeSdkPackage(c);
    if (pack.chainId === undefined) return null;
    if (networkKey !== undefined && (!isNetworkKey(networkKey) || getNetwork(networkKey).chainId !== pack.chainId)) return null;
    return encodeShortClaim(pack);
  } catch {
    return null;
  }
}

/**
 * The code for a URL, made only of letters, digits and "=", the characters
 * every chat app keeps inside a link. Telegram ended an auto-link at the dot
 * in "gloam1.eyJ...", WhatsApp at the %2E that replaced it and then at a
 * hyphen, which cut shared links to "gloam1". So the dot after the prefix is
 * written "=", and in the body "-", "_" and "." are written "=1", "=2" and
 * "=3" (a code never has "=" of its own). codeFromLinkText reads it back, and
 * older links ("." , %2E or "-" after the prefix) still read.
 */
function linkSafe(code: string): string {
  const c = code.trim();
  const m = c.match(/^(gloam1e|gloam2t|gloam1|gloam3)\.([A-Za-z0-9_\-.]+)$/);
  if (m) return `${m[1]}=${m[2]!.replace(/[-_.]/g, (ch) => LINK_ESCAPE[ch]!)}`;
  return encodeURIComponent(c).replace(/\./g, "%2E");
}

const LINK_ESCAPE: Record<string, string> = { "-": "=1", _: "=2", ".": "=3" };
const LINK_UNESCAPE: Record<string, string> = { "1": "-", "2": "_", "3": "." };

/**
 * A code as a link wrote it, back to the code: "gloam1=..." with its escapes,
 * or the older "gloam1-..." (a link written that way never escaped its body).
 * Anything else comes back as it was.
 */
export function codeFromLinkText(s: string): string {
  const eq = s.match(/^(gloam1e|gloam2t|gloam1|gloam3)=(.*)$/s);
  if (eq) return `${eq[1]}.${eq[2]!.replace(/=([123])/g, (_, d: string) => LINK_UNESCAPE[d]!)}`;
  return s.replace(/^(gloam1e|gloam2t|gloam1)-/, "$1.");
}

/** The in-app claim screen for a code, which the /claim page sends people to. */
export function appClaimPath(code: string, networkKey: string): string {
  return `/app/vault?tab=move&mode=receive&net=${encodeURIComponent(networkKey)}#claim=${linkSafe(code)}`;
}

/**
 * The code in a short claim link's fragment ("#<letters and digits>" on /c),
 * as its gloam3 code, or null.
 */
export function shortCodeFromHash(hash: string): string | null {
  const m = hash.match(/^#([0-9A-Za-z]{20,})$/);
  return m ? SHORT_CLAIM_PREFIX + m[1] : null;
}

/** The code from a "#claim=" fragment, or null. */
export function codeFromHash(hash: string): string | null {
  if (!hash.startsWith("#claim=")) return null;
  try {
    const code = codeFromLinkText(decodeURIComponent(hash.slice("#claim=".length)).trim());
    return code || null;
  } catch {
    return null;
  }
}
