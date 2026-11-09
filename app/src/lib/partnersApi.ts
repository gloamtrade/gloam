/**
 * Shared plumbing for the public Gloam API (app/api/v1) and the partner
 * portal's own endpoints (app/api/partners). Server only.
 *
 * Every response is JSON in one envelope:
 *   { "v": 1, "ok": true,  "data": { ... },                     "requestId": "req_..." }
 *   { "v": 1, "ok": false, "error": { "code": "...", "message": "..." }, "requestId": "req_..." }
 * with Cache-Control: no-store and a Gloam-Api-Version header. Error codes are
 * listed in /docs/partners.
 */
import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import {
  ApiKeyError,
  apiKeyPepper,
  bearerKey,
  lookupApiKey,
  meterApiKey,
  parseApiKey,
  type AuthedKey,
  type KeyEnv,
  type RateState,
} from "./apiKeys";
import { getPartner, PartnerError, type Partner } from "./partners";
import { readSession, requestHost, SESSION_COOKIE, SignInError } from "./partnersAuth";
import { logSafe } from "./logSafe";
import { KvUnavailableError } from "./partnersKv";
import { clientIp, hitRateLimit } from "./mcpRemote/rateLimit";
import { RelayError } from "./relay/server";

export const API_VERSION = 1;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

export function newRequestId(): string {
  return `req_${randomBytes(8).toString("hex")}`;
}

type Extra = { requestId: string; status?: number; headers?: Record<string, string> };

function baseHeaders(requestId: string, extra?: Record<string, string>): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Gloam-Api-Version": String(API_VERSION),
    "X-Request-Id": requestId,
    ...extra,
  };
}

export function apiOk(data: unknown, extra: Extra): NextResponse {
  return NextResponse.json(
    { v: API_VERSION, ok: true, data, requestId: extra.requestId },
    { status: extra.status ?? 200, headers: baseHeaders(extra.requestId, extra.headers) }
  );
}

/** Any thrown error as the envelope. Unknown errors are logged and say nothing. */
export function apiFail(e: unknown, extra: Extra): NextResponse {
  let status = 500;
  let code = "internal";
  let message = "Something went wrong on our side. Try again.";
  if (e instanceof ApiError || e instanceof RelayError || e instanceof PartnerError || e instanceof ApiKeyError || e instanceof SignInError) {
    status = e.status;
    code = e.code;
    message = e.message;
  } else if (e instanceof KvUnavailableError) {
    status = 503;
    code = "storage_unavailable";
    message = "Partner storage is not available on this server right now.";
  } else {
    console.error("gloam_api", extra.requestId, logSafe(e));
  }
  return NextResponse.json(
    { v: API_VERSION, ok: false, error: { code, message }, requestId: extra.requestId },
    { status, headers: baseHeaders(extra.requestId, extra.headers) }
  );
}

/**
 * Request body as an object, or a 400. With `maxBytes`, a larger body is a 413
 * before it is parsed (by its Content-Length, and by its length once read).
 */
export async function jsonBody(req: Request, maxBytes?: number): Promise<Record<string, unknown>> {
  let body: unknown = null;
  if (maxBytes != null) {
    const tooLarge = () => new ApiError(413, "too_large", "The request body is too large.");
    const declared = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
    const text = await req.text().catch(() => "");
    if (text.length > maxBytes) throw tooLarge();
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  } else {
    body = (await req.json().catch(() => null)) as unknown;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "invalid_json", "The request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

function pepperFor(req: Request): string {
  const p = apiKeyPepper(requestHost(req));
  if (!p.ok) {
    throw new ApiError(
      503,
      "keys_unconfigured",
      p.reason === "short"
        ? "API keys are misconfigured on this server (GLOAM_API_KEY_PEPPER is too short)."
        : "API keys are not configured on this server (GLOAM_API_KEY_PEPPER is not set)."
    );
  }
  return p.pepper;
}

/** The pepper for making keys in the portal; a 503 ApiError when there is none. */
export function portalPepper(req: Request): string {
  return pepperFor(req);
}

export type KeyContext = {
  requestId: string;
  key: AuthedKey;
  partner: Partner;
  rate: RateState;
};

/**
 * Requests per IP per minute before any key is looked up, so unknown or junk
 * keys cannot hammer the key store. Well above one partner's own key limits.
 */
const API_PER_IP_PER_MIN = 900;

function rateHeaders(rate: RateState): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(rate.limit),
    "X-RateLimit-Remaining": String(rate.remaining),
    "X-RateLimit-Reset": String(rate.reset),
  };
}

/**
 * Runs a v1 handler for a valid key: checks the bearer key, counts the
 * request against the key's per-minute limit, loads the partner, and wraps
 * whatever the handler returns or throws in the envelope.
 */
export async function withApiKey(
  req: Request,
  handler: (ctx: KeyContext) => Promise<{ data: unknown; status?: number }>
): Promise<NextResponse> {
  const requestId = newRequestId();
  let headers: Record<string, string> | undefined;
  try {
    const secret = bearerKey(req.headers.get("authorization"));
    if (!secret) {
      throw new ApiError(401, "missing_key", "Send your API key as Authorization: Bearer gloam_test_...");
    }
    if (!parseApiKey(secret)) throw new ApiError(401, "invalid_key", "That is not a Gloam API key.");
    const perIp = await hitRateLimit(clientIp(req), "api-ip", API_PER_IP_PER_MIN);
    if (!perIp.allowed) {
      headers = { "Retry-After": String(perIp.retryAfterSec) };
      throw new ApiError(429, "rate_limited", "Too many requests from this address. Slow down and retry.");
    }
    const key = await lookupApiKey(secret, pepperFor(req));
    if (!key) throw new ApiError(401, "invalid_key", "This API key is not valid. It may have been revoked or rotated.");
    const rate = await meterApiKey(key.id);
    headers = rateHeaders(rate);
    if (!rate.allowed) {
      headers["Retry-After"] = String(Math.max(1, rate.reset - Math.floor(Date.now() / 1000)));
      throw new ApiError(429, "rate_limited", `This key is limited to ${rate.limit} requests a minute. Slow down and retry.`);
    }
    const partner = await getPartner(key.partnerId);
    if (!partner) throw new ApiError(401, "invalid_key", "The account behind this key no longer exists.");
    const { data, status } = await handler({ requestId, key, partner, rate });
    return apiOk(data, { requestId, status, headers });
  } catch (e) {
    return apiFail(e, { requestId, headers });
  }
}

/** A test key works on testnets, a live key on mainnets; anything else is refused. */
export function requireKeyEnv(key: { env: KeyEnv }, want: KeyEnv, networkLabel: string) {
  if (key.env !== want) {
    throw new ApiError(
      403,
      "key_env_mismatch",
      want === "test"
        ? `${networkLabel} is a testnet. Use a gloam_test_ key.`
        : `${networkLabel} is a mainnet. Use a gloam_live_ key.`
    );
  }
}

// ---------------------------------------------------------------- portal

/** Portal sign-ins and nonces per IP per minute (a sign-in can mean a chain read). */
const SIGN_IN_PER_MIN = 20;
/** Portal changes (account, keys) per wallet per minute. */
const PORTAL_WRITES_PER_MIN = 30;

/** A 429 when this IP has asked for too many sign-ins or nonces lately. */
export async function limitSignIn(req: Request): Promise<void> {
  const rate = await hitRateLimit(clientIp(req), "partner-signin", SIGN_IN_PER_MIN);
  if (!rate.allowed) throw new ApiError(429, "rate_limited", "Too many sign-in attempts from here. Wait a minute.");
}

/** A 429 when this wallet has changed its account or keys too often in the last minute. */
export async function limitPortalWrite(wallet: string): Promise<void> {
  const rate = await hitRateLimit(`wallet:${wallet.toLowerCase()}`, "partner-write", PORTAL_WRITES_PER_MIN);
  if (!rate.allowed) throw new ApiError(429, "rate_limited", "Too many changes in a minute. Wait a moment and try again.");
}

/** New partner accounts one IP may make in a UTC day. */
export const NEW_ACCOUNTS_PER_IP_PER_DAY = 3;

/**
 * Counts one new account against this IP's day, in one increment, before the account
 * is made: sign-ups sent together are each counted. A 429 past the limit. Check the
 * input first (checkNewPartner), so a sign-up refused for its input isn't counted.
 */
export async function takeNewAccount(req: Request): Promise<void> {
  const rate = await hitRateLimit(clientIp(req), "partner-new", NEW_ACCOUNTS_PER_IP_PER_DAY, Date.now(), 86_400);
  if (!rate.allowed) throw new ApiError(429, "rate_limited", "Too many new accounts from here today. Try again tomorrow.");
}

/** The signed-in wallet for a portal request, or a 401. */
export function sessionWallet(req: Request & { cookies?: { get(name: string): { value: string } | undefined } }) {
  const token =
    req.cookies?.get(SESSION_COOKIE)?.value ??
    req.headers
      .get("cookie")
      ?.split(/;\s*/)
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
  const wallet = readSession(token ? decodeURIComponent(token) : null, requestHost(req));
  if (!wallet) throw new ApiError(401, "signed_out", "Sign in with your wallet first.");
  return wallet;
}

/** Runs a portal handler and wraps the result in the envelope. */
export async function portal(
  handler: (requestId: string) => Promise<{ data: unknown; status?: number } | NextResponse>
): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const out = await handler(requestId);
    if (out instanceof NextResponse) return out;
    return apiOk(out.data, { requestId, status: out.status });
  } catch (e) {
    return apiFail(e, { requestId });
  }
}
