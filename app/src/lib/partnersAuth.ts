/**
 * Partner portal sign-in: Sign-In with Ethereum (EIP-4361), checked on the
 * server with viem, then a signed session cookie. Server only.
 *
 *  1. GET /api/partners/nonce issues a random nonce, kept for ten minutes and
 *     usable once.
 *  2. The browser builds the EIP-4361 message for this site (domain = the
 *     host, our statement, the nonce, issued now, expiring within the hour)
 *     and the wallet signs it.
 *  3. POST /api/partners/session checks every field, the signature (plain
 *     wallets by recovery; smart wallets through ERC-1271/6492 on the chain the
 *     message names), then burns the nonce and sets an httpOnly cookie.
 *
 * The cookie holds the wallet address, an expiry and an HMAC. Its key is
 * GLOAM_PARTNER_SESSION_SECRET, or one derived from GLOAM_API_KEY_PEPPER when
 * that is unset, so a deployment that can make API keys can also sign people
 * in, and neither works without a configured secret.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { createPublicClient, getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { apiKeyPepper } from "./apiKeys";
import { getNetwork, NETWORK_KEYS } from "./networks";
import { k, kv1 } from "./partnersKv";
import { serverTransport } from "@/lib/serverRpc";

export const SIWE_STATEMENT =
  "Sign in to the Gloam Partner Portal. This proves you own this wallet. It costs nothing and moves no money.";

export const NONCE_TTL_SEC = 10 * 60;
/** A signed message may be valid for at most this long after it was issued. */
export const MESSAGE_MAX_LIFETIME_SEC = 60 * 60;
const CLOCK_SKEW_SEC = 60;

export const SESSION_COOKIE = "gloam_partner";
export const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

export class SignInError extends Error {
  constructor(
    message: string,
    public status = 401,
    public code = "sign_in_failed"
  ) {
    super(message);
  }
}

/**
 * Hosts a sign-in message may name. GLOAM_PARTNER_DOMAINS (comma separated,
 * e.g. "gloam.trade,www.gloam.trade") pins them; without it, the host the
 * request came to (fine behind Vercel, which sets the host headers itself).
 */
export function allowedSignInHosts(host: string | null): string[] {
  const pinned = (process.env.GLOAM_PARTNER_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (pinned.length) return pinned;
  return host ? [host] : [];
}

/** The host a request was made to (what a SIWE domain must equal). */
export function requestHost(req: Request): string | null {
  const h = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  return h ? h.split(",")[0]!.trim().toLowerCase() : null;
}

// ---------------------------------------------------------------- nonce

/** 128 random bits as hex: alphanumeric, as EIP-4361 requires. */
export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

// Nonces are written to the store, so their issue is capped per client (best
// effort, per server instance) to keep a flood from filling it.
const NONCE_WINDOW_MS = 10 * 60_000;
const NONCES_PER_WINDOW = 30;
const nonceHits = new Map<string, number[]>();

export function nonceAllowed(client: string, now = Date.now()): boolean {
  const list = (nonceHits.get(client) ?? []).filter((t) => now - t < NONCE_WINDOW_MS);
  if (list.length >= NONCES_PER_WINDOW) {
    nonceHits.set(client, list);
    return false;
  }
  list.push(now);
  nonceHits.set(client, list);
  if (nonceHits.size > 10_000) {
    for (const [key, hits] of nonceHits) if (!hits.some((t) => now - t < NONCE_WINDOW_MS)) nonceHits.delete(key);
  }
  return true;
}

export async function issueNonce(now = Date.now()): Promise<{ nonce: string; expiresAt: number }> {
  const nonce = newNonce();
  await kv1(["SET", k("nonce", nonce), "1", "EX", NONCE_TTL_SEC]);
  return { nonce, expiresAt: now + NONCE_TTL_SEC * 1000 };
}

async function consumeNonce(nonce: string): Promise<boolean> {
  if (!/^[a-f0-9]{32}$/.test(nonce)) return false;
  return (await kv1(["GETDEL", k("nonce", nonce)])) === "1";
}

// ---------------------------------------------------------------- verify

async function signatureValid(address: Address, message: string, signature: Hex, chainId: number | undefined) {
  // A plain wallet: recover the signer.
  try {
    if (await verifyMessage({ address, message, signature })) return true;
  } catch {
    /* not a 65-byte signature: maybe a smart wallet */
  }
  // A smart wallet: ask its contract (ERC-1271), or its factory (ERC-6492), on
  // the chain the message names, when that is a Gloam network.
  const net = NETWORK_KEYS.map(getNetwork).find((n) => n.chainId === chainId);
  if (!net) return false;
  try {
    const client = createPublicClient({ chain: net.chain, ccipRead: false, transport: serverTransport(net, { timeout: 15_000 }) });
    return await client.verifyMessage({ address, message, signature });
  } catch {
    return false;
  }
}

/**
 * Checks a signed sign-in message for this host and returns the wallet.
 * Every failure is a SignInError with a plain reason.
 */
export async function verifySignIn(args: {
  message: unknown;
  signature: unknown;
  host: string | null;
  now?: number;
}): Promise<Address> {
  const { host } = args;
  const now = args.now ?? Date.now();
  if (!host) throw new SignInError("Missing host.", 400, "bad_request");
  if (typeof args.message !== "string" || args.message.length > 2000) {
    throw new SignInError("The sign-in message is missing or too long.", 400, "bad_message");
  }
  if (typeof args.signature !== "string" || !/^0x([0-9a-fA-F]{2}){65,4096}$/.test(args.signature)) {
    throw new SignInError("The signature is missing or malformed.", 400, "bad_signature");
  }
  const message = args.message;
  const fields = parseSiweMessage(message);
  const bad = (why: string) => new SignInError(why, 401, "bad_message");

  if (!fields.address || !isAddress(fields.address, { strict: false })) throw bad("The message names no wallet.");
  if (fields.version !== "1") throw bad("Unsupported sign-in message version.");
  const allowed = allowedSignInHosts(host);
  const domain = fields.domain?.toLowerCase() ?? "";
  if (!domain || !allowed.includes(domain)) {
    throw bad("This message was made for a different site.");
  }
  let uriHost = "";
  try {
    uriHost = new URL(fields.uri ?? "").host.toLowerCase();
  } catch {
    /* checked below */
  }
  if (uriHost !== domain) throw bad("This message was made for a different site.");
  if (fields.statement !== SIWE_STATEMENT) throw bad("This is not a Gloam partner sign-in message.");
  if (!fields.nonce) throw bad("The message has no nonce.");

  const issued = fields.issuedAt?.getTime();
  const expires = fields.expirationTime?.getTime();
  if (issued == null || Number.isNaN(issued) || expires == null || Number.isNaN(expires)) {
    throw bad("The message needs an issue time and an expiry.");
  }
  if (issued > now + CLOCK_SKEW_SEC * 1000 || now - issued > NONCE_TTL_SEC * 1000) {
    throw new SignInError("This sign-in request is too old. Try again.", 401, "expired");
  }
  if (expires - issued > MESSAGE_MAX_LIFETIME_SEC * 1000) throw bad("The message stays valid for too long.");
  if (!validateSiweMessage({ message: fields, domain: fields.domain, time: new Date(now) })) {
    throw new SignInError("This sign-in request has expired. Try again.", 401, "expired");
  }

  const address = getAddress(fields.address);
  const ok = await signatureValid(address, message, args.signature as Hex, fields.chainId);
  if (!ok) throw new SignInError("The signature does not match this wallet.", 401, "bad_signature");

  // Last, so only a fully valid sign-in uses the nonce up. GETDEL is atomic:
  // the same signed message can never open two sessions.
  if (!(await consumeNonce(fields.nonce))) {
    throw new SignInError("This sign-in request was already used or has expired. Try again.", 401, "nonce");
  }
  return address;
}

// ---------------------------------------------------------------- session

const MIN_SECRET = 32;

function sessionKey(host: string | null): string | null {
  const own = process.env.GLOAM_PARTNER_SESSION_SECRET?.trim();
  if (own) return own.length >= MIN_SECRET ? own : null;
  const pepper = apiKeyPepper(host);
  if (!pepper.ok) return null;
  return createHmac("sha256", pepper.pepper).update("gloam-partner-session-v1").digest("hex");
}

/** True when this server can sign partners in for `host`. */
export function sessionsConfigured(host: string | null): boolean {
  return sessionKey(host) !== null;
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** "v1.<address>.<exp>.<sig>", or null when no session secret is configured. */
export function createSession(address: Address, host: string | null, now = Date.now()): string | null {
  const key = sessionKey(host);
  if (!key) return null;
  const exp = Math.floor(now / 1000) + SESSION_MAX_AGE_SEC;
  const payload = `v1.${address.toLowerCase()}.${exp}`;
  return `${payload}.${sign(payload, key)}`;
}

/** The wallet a session cookie belongs to, or null when missing, expired or forged. */
export function readSession(token: string | undefined | null, host: string | null, now = Date.now()): Address | null {
  if (!token) return null;
  const key = sessionKey(host);
  if (!key) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, address, expRaw, sig] = parts as [string, string, string, string];
  if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp) || exp <= Math.floor(now / 1000)) return null;
  const expected = Buffer.from(sign(`v1.${address}.${expRaw}`, key));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  return getAddress(address);
}

/** Cookie options for the session (Secure on HTTPS deployments). */
export function sessionCookieOptions(maxAge = SESSION_MAX_AGE_SEC) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" && process.env.GLOAM_PARTNER_COOKIE_INSECURE !== "true",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

/**
 * Mutating portal requests must be JSON and, when the browser says where they
 * came from, come from this site. With the Lax cookie this keeps other sites
 * from acting for a signed-in partner.
 */
export function sameSiteJson(req: Request): boolean {
  const type = req.headers.get("content-type") ?? "";
  return /^application\/json\b/i.test(type) && originAllowed(req);
}

/** The origins the app runs on. A local dev server is let in outside production. */
const GLOAM_ORIGINS = new Set(["gloam.trade", "www.gloam.trade"]);

/**
 * For the routes only the Gloam app calls (partner link lookups, registrations
 * and counts): a JSON body from https://gloam.trade or https://www.gloam.trade.
 * A missing Origin is refused, so a script can't call them without saying where
 * it comes from. Outside production, a localhost origin is let in too.
 */
export function gloamOriginJson(req: Request): boolean {
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return false;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === "https:" && GLOAM_ORIGINS.has(url.host.toLowerCase())) return true;
  return process.env.NODE_ENV !== "production" && /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url.host);
}

/** No Origin header (not a browser), or this site's own origin. */
export function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === requestHost(req);
  } catch {
    return false;
  }
}
