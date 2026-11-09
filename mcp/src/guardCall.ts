/**
 * What the checks before a payment share (wormholeGuard, veyaGuard): where a
 * key may be sent, how long to wait, the call itself, and how to read an answer
 * that is not to be trusted.
 */

export interface GuardEndpoint {
  key: string;
  url: string;
  timeoutMs: number;
}

const loopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/** The key rides along as a bearer token, so only https, or plain http on this machine (tests, a local proxy). */
export const keyMayGoTo = (url: URL): boolean => url.protocol === "https:" || (url.protocol === "http:" && loopback(url.hostname));

/** A timeout setting, held between half a second and 30 seconds. Unset or unusable is `fallback`. */
export function guardTimeoutMs(raw: string | undefined, fallback: number): number {
  const ms = Number(raw?.trim() || fallback);
  return Number.isFinite(ms) ? Math.min(Math.max(Math.round(ms), 500), 30_000) : fallback;
}

/** Plain characters only, capped: text from a check is attacker-reachable and must not reach the model as written. */
export const plainText = (v: unknown): string => (typeof v === "string" ? v.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 40) : "");

/** POST `body` as JSON with the key as a bearer token. Never throws, and a redirect is a failure: the key does not follow one. */
export async function postToGuard(
  to: GuardEndpoint,
  body: unknown,
  fetchImpl: typeof fetch
): Promise<{ res: Response } | { failed: "timeout" | "unreachable" }> {
  try {
    const res = await fetchImpl(to.url, {
      method: "POST",
      // identity: an answer is a few hundred bytes, so a compressed one is never asked for (see guardBody).
      headers: { authorization: `Bearer ${to.key}`, "content-type": "application/json", "accept-encoding": "identity" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(to.timeoutMs),
    });
    return { res };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { failed: timedOut ? "timeout" : "unreachable" };
  }
}

/** The most of an answer that is read: real answers are a few hundred bytes. */
export const GUARD_BODY_LIMIT = 64 * 1024;

/**
 * The answer as a JSON object, or null when it is anything else, or longer than GUARD_BODY_LIMIT bytes as read (after any
 * decoding, so a small compressed body that inflates past it is cut off too). Never throws, and the timeout above still
 * covers the read.
 */
export async function guardBody(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > GUARD_BODY_LIMIT) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > GUARD_BODY_LIMIT) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
