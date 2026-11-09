/**
 * MPP (Machine Payments Protocol) support for the Gloam MCP tools.
 *
 * MPP is HTTP 402 with `WWW-Authenticate: Payment …` challenges and
 * `Authorization: Payment …` credentials. The "gloam" method settles an MPP
 * charge exactly like the x402 gloam-private scheme: a private send sealed to
 * the payee's receive tag, swept by the payee before access. So the tools reuse
 * the x402 machinery (spending limits, the note store, the sweep) and this
 * module only translates between the two wire forms.
 *
 * Challenges this server issues are HMAC-bound (the core spec's recommended
 * construction) with MPP_SECRET_KEY when set, so they verify on any mppx server
 * that shares the key. Otherwise the key is derived from the note store key, so
 * a restart does not invalidate open challenges and no new secret is needed.
 */

import { hkdfSync } from "node:crypto";
import type { Address, Hex } from "viem";
import type { GloamPaymentRequirements, SweepChain } from "@gloamtrade/sdk";
import {
  allowedModes,
  createPaymentChallenge,
  extractPaymentCredential,
  formatPaymentChallenge,
  fromPaymentRequirements,
  isExpired,
  isGloamChargeChallenge,
  parseCredential,
  parseGloamChargeRequest,
  parsePaymentChallenges,
  secondsLeft,
  toPaymentRequirements,
  transferCheckFromCall,
  GLOAM_CHARGE_INTENT,
  GLOAM_METHOD,
  type GloamChargeChain,
  type GloamChargePayload,
  type GloamChargeRequest,
  type MinimalReceipt,
  type PaymentChallenge,
  type PaymentCredential,
} from "@gloamtrade/mppx-gloam/core";
import { noteStoreKey } from "./noteStore.js";

type Env = Record<string, string | undefined>;

/** How long a challenge from gloam_payment_requirements stays valid: long enough to prove and confirm a payment. */
export const MPP_DEFAULT_EXPIRES_SECONDS = 600;
/** A payer does not start a push payment with less than this left on the challenge. */
export const MPP_MIN_SECONDS_LEFT = 30;

/**
 * The HMAC key for MPP challenges: GLOAM_MPP_SECRET_KEY or MPP_SECRET_KEY
 * (UTF-8, as mppx reads it; the GLOAM_ name can live in the settings file),
 * else HKDF-SHA256 of the note store key under an MPP label.
 */
export function mppSecret(env: Env): Uint8Array {
  const explicit = (env.GLOAM_MPP_SECRET_KEY ?? env.MPP_SECRET_KEY)?.trim();
  if (explicit) {
    if (explicit.length < 32) throw new Error("The MPP secret key must be at least 32 characters (openssl rand -base64 32).");
    return new TextEncoder().encode(explicit);
  }
  const { key } = noteStoreKey(env);
  return new Uint8Array(hkdfSync("sha256", key, Buffer.alloc(0), "gloam-mcp:mpp-challenge-v1", 32));
}

/** The realm for a challenge: the resource URL's host, or a fixed label for MCP tool ids. */
export function realmFor(resource: string): string {
  try {
    return new URL(resource).host || "gloam-mcp";
  } catch {
    return "gloam-mcp";
  }
}

/** Issue an MPP gloam charge challenge carrying the same terms as these x402 requirements. */
export async function mppChallengeFor(
  req: GloamPaymentRequirements,
  opts: { env: Env; realm?: string; decimals?: number; expiresInSeconds?: number; description?: string; now?: number }
): Promise<{ challenge: PaymentChallenge; wwwAuthenticate: string }> {
  const request = fromPaymentRequirements(req, { decimals: opts.decimals });
  const challenge = await createPaymentChallenge({
    secretKey: mppSecret(opts.env),
    realm: opts.realm?.trim() || realmFor(req.resource),
    method: GLOAM_METHOD,
    intent: GLOAM_CHARGE_INTENT,
    request: request as unknown as Record<string, unknown>,
    expires: new Date((opts.now ?? Date.now()) + (opts.expiresInSeconds ?? MPP_DEFAULT_EXPIRES_SECONDS) * 1000),
    ...(opts.description ? { description: opts.description } : {}),
  });
  return { challenge, wwwAuthenticate: formatPaymentChallenge(challenge) };
}

/** True for a `Payment …` value (an MPP challenge or credential), as opposed to x402 forms. */
export const looksLikeMpp = (input: string) => /^\s*Payment\s+/i.test(input);

/** The gloam charge challenges in a WWW-Authenticate value (other methods and schemes are ignored). */
export function gloamChallenges(wwwAuthenticate: string | null | undefined): PaymentChallenge[] {
  return parsePaymentChallenges(wwwAuthenticate).filter(isGloamChargeChallenge);
}

/** Parse a gloam MPP challenge given as a WWW-Authenticate value, or null. */
export function parseMppChallenge(input: string): PaymentChallenge | null {
  return gloamChallenges(input.trim())[0] ?? null;
}

/** Parse an MPP credential (`Payment <base64url>`), possibly inside a multi-scheme field value. */
export function parseMppCredential(input: string): PaymentCredential<GloamChargePayload> {
  return parseCredential<GloamChargePayload>(extractPaymentCredential(input) ?? input);
}

/** The x402 requirements for a gloam challenge, so payPrivately's spend gate and builder serve it unchanged. */
export function requirementsFromChallenge(ch: PaymentChallenge): { req: GloamPaymentRequirements; request: GloamChargeRequest } {
  const request = parseGloamChargeRequest(ch.request);
  return { req: toPaymentRequirements(request, ch.realm), request };
}

/** Why this MCP (which pays in push mode, from its own notes) cannot pay a challenge, or null when it can. */
export function cannotPay(ch: PaymentChallenge, request: GloamChargeRequest, now = Date.now()): string | null {
  if (isExpired(ch, now)) return "The challenge has expired. Request the resource again for a fresh one.";
  if (!allowedModes(request).includes("push")) {
    return "This server only accepts pull mode (it submits the transfer itself). This MCP pays in push mode; use @gloamtrade/mppx-gloam's client for pull.";
  }
  const left = secondsLeft(ch, now);
  if (left < MPP_MIN_SECONDS_LEFT) return `Only ${Math.floor(left)}s left on this challenge, too little to settle safely. Request a fresh one.`;
  return null;
}

/**
 * A GloamChargeChain over this server's chain reads plus transaction receipts with logs. With `call` (an eth_call),
 * a payer's pull transfer is checked against the pool before this server submits it, and one the pool would
 * refuse is never sent.
 */
export function mppChain(
  sweep: SweepChain,
  getTransactionReceipt: (args: { hash: Hex }) => Promise<{ status: "success" | "reverted"; logs: readonly { address: string; topics: readonly string[]; data: string }[] }>,
  call?: (args: { to: Address; data: Hex }) => Promise<unknown>
): GloamChargeChain {
  return {
    ...sweep,
    ...(call ? { transferWouldLand: transferCheckFromCall(call) } : {}),
    async getReceipt(hash): Promise<MinimalReceipt | null> {
      try {
        const r = await getTransactionReceipt({ hash });
        return { status: r.status, logs: r.logs ?? [] };
      } catch (e) {
        if (e instanceof Error && /not.?found|could not be found/i.test(`${e.name} ${e.message}`)) return null;
        throw e;
      }
    },
  };
}
