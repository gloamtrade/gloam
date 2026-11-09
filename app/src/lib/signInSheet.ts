/**
 * The logic behind Gloam's sign-in sheet (components/app/GloamSignInSheet): the
 * steps, the email check, the code field, the resend wait and the error text.
 *
 * Plain logic with no React and no Turnkey SDK, so the self-test runs it
 * (scripts/selftest-signin-sheet.mts).
 */

/* ---------------------------------------------------------------- the code */

/** The shape of the one-time code: the auth proxy config sets it (6 digits for Gloam). */
export type OtpFormat = { length: number; alphanumeric: boolean };

export const DEFAULT_OTP_FORMAT: OtpFormat = { length: 6, alphanumeric: false };

/**
 * The code's shape from the kit's config (`config.auth`), which the kit fills from
 * the auth proxy config. Anything missing or odd falls back to 6 digits.
 */
export function otpFormat(auth: { otpLength?: string | number; otpAlphanumeric?: boolean } | undefined | null): OtpFormat {
  const n = Number(auth?.otpLength);
  const length = Number.isInteger(n) && n >= 4 && n <= 12 ? n : DEFAULT_OTP_FORMAT.length;
  return { length, alphanumeric: auth?.otpAlphanumeric === true };
}

/**
 * What the code field keeps from what was typed, pasted or filled in: digits only
 * (letters too for an alphanumeric code), spaces and dashes dropped, full-width
 * digits read as digits, cut to the code's length.
 */
export function cleanOtp(input: string, format: OtpFormat = DEFAULT_OTP_FORMAT): string {
  const flat = input.normalize("NFKC");
  const kept = format.alphanumeric ? flat.replace(/[^a-zA-Z0-9]/g, "") : flat.replace(/[^0-9]/g, "");
  return kept.slice(0, format.length);
}

/**
 * A paste replaces the whole code (so pasting into a half-typed field never mixes
 * two codes), unless the paste holds nothing usable, which leaves the field as it was.
 */
export function otpAfterPaste(current: string, pasted: string, format: OtpFormat = DEFAULT_OTP_FORMAT): string {
  const next = cleanOtp(pasted, format);
  return next ? next : current;
}

export function otpComplete(code: string, format: OtpFormat = DEFAULT_OTP_FORMAT): boolean {
  return code.length === format.length && cleanOtp(code, format) === code;
}

/* ---------------------------------------------------------------- the email */

/** Trimmed, never lowercased: the auth proxy matches the email as it was first given. */
export function cleanEmail(raw: string): string {
  return raw.trim();
}

/** Why this email can't be sent a code, or null. */
export function emailProblem(raw: string): string | null {
  const e = cleanEmail(raw);
  if (!e) return "Enter your email.";
  if (e.length > 254 || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/.test(e)) return "Enter a full email, like you@example.com.";
  return null;
}

/* ---------------------------------------------------------------- resend */

/** How long after a code is sent before another can be asked for. */
export const RESEND_COOLDOWN_MS = 30_000;

/** Whole seconds until Resend opens again; 0 when it is open. */
export function resendSecondsLeft(sentAt: number, now: number, cooldownMs = RESEND_COOLDOWN_MS): number {
  return Math.max(0, Math.ceil((sentAt + cooldownMs - now) / 1000));
}

/* ---------------------------------------------------------------- errors */

export type SignInErrorKind =
  | "wrong-code"
  | "expired-code"
  | "used-up-code"
  | "rate-limit"
  | "cancelled"
  | "no-account"
  | "not-ready"
  | "popup-blocked"
  | "unavailable"
  | "timeout"
  | "network"
  | "unknown";

export type SignInDuring = "send" | "verify" | "passkey-login" | "passkey-signup" | "google";

/** `during`: what was being tried, so the sheet shows the words next to that control. */
export type SignInError = { kind: SignInErrorKind; text: string; during: SignInDuring };

/** The error and everything it wraps (the kit nests the SDK's error in `cause`). */
function errorChain(e: unknown): { codes: string[]; text: string; statuses: number[] } {
  const codes: string[] = [];
  const texts: string[] = [];
  const statuses: number[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur !== null && cur !== undefined; i++) {
    if (typeof cur === "string") {
      texts.push(cur);
      break;
    }
    if (typeof cur !== "object") break;
    const o = cur as { code?: unknown; name?: unknown; message?: unknown; statusCode?: unknown; status?: unknown; cause?: unknown };
    if (typeof o.code === "string" || typeof o.code === "number") codes.push(String(o.code));
    if (typeof o.name === "string") texts.push(o.name);
    if (typeof o.message === "string") texts.push(o.message);
    for (const s of [o.statusCode, o.status]) if (typeof s === "number") statuses.push(s);
    cur = o.cause;
  }
  return { codes, text: texts.join(" | "), statuses };
}

/** What kind of failure this was, read from the kit's error codes first and its words second. */
export function signInErrorKind(e: unknown, during: SignInDuring): SignInErrorKind {
  const { codes, text, statuses } = errorChain(e);
  const has = (...c: string[]) => c.some((x) => codes.includes(x));
  const code = during === "send" || during === "verify";

  if (code && (has("INVALID_OTP_CODE") || /invalid (otp|code)|(otp|code) (is )?(invalid|incorrect)|incorrect code/i.test(text))) return "wrong-code";
  if (code && /attempts/i.test(text) && /(max|too many|exceed)/i.test(text)) return "used-up-code";
  if (code && /(otp|code)[^|]*expired|expired[^|]*(otp|code)/i.test(text)) return "expired-code";
  if (
    // 8 is gRPC's RESOURCE_EXHAUSTED, the code Turnkey's API gives a rate limit
    has("MAX_OTP_INITIATED_ERROR", "8") ||
    statuses.includes(429) ||
    /\b429\b|rate.?limit|too many requests|resource.?exhausted|max(imum)? number of otps/i.test(text)
  )
    return "rate-limit";
  if (during === "google") {
    // the kit's own words for its Google window (react-wallet-kit 2.2.0, handleGoogleOauth)
    if (/window was closed|popup.*closed|closed.*popup/i.test(text)) return "cancelled";
    if (/failed to open|popup.*blocked|blocked.*popup/i.test(text)) return "popup-blocked";
    if (/client id is not configured|redirect uri is not configured/i.test(text) || has("AUTH_METHOD_NOT_ENABLED", "FEATURE_NOT_ENABLED"))
      return "unavailable";
    if (/timed? ?out/i.test(text) && !has("NETWORK_ERROR")) return "timeout";
    if (/access_denied|consent/i.test(text)) return "cancelled";
  }
  if (has("SELECT_PASSKEY_CANCELLED", "USER_CANCELED") || /NotAllowedError|AbortError|not allowed|cancel/i.test(text)) return "cancelled";
  if (during === "passkey-login" && /not found|no (sub-?)?organi[sz]ation|no user|could not find|unknown credential/i.test(text)) return "no-account";
  if (has("CLIENT_NOT_INITIALIZED", "CONFIG_NOT_INITIALIZED", "INVALID_CONFIGURATION")) return "not-ready";
  if (
    has("NETWORK_ERROR", "TIMEOUT", "SERVICE_UNAVAILABLE", "GATEWAY_TIMEOUT") ||
    statuses.some((s) => s >= 500) ||
    /failed to fetch|network|load failed|timed? ?out|offline/i.test(text)
  )
    return "network";
  return "unknown";
}

/** Plain words for a sign-in that didn't work. Never the SDK's own text, which names internals. */
export function signInError(e: unknown, during: SignInDuring): SignInError {
  const kind = signInErrorKind(e, during);
  return { kind, text: signInErrorText(kind, during), during };
}

export function signInErrorText(kind: SignInErrorKind, during: SignInDuring): string {
  switch (kind) {
    case "wrong-code":
      return "That code didn't match. Check it and try again.";
    case "expired-code":
      return "That code expired. Send a new one.";
    case "used-up-code":
      return "Too many tries with that code. Send a new one.";
    case "rate-limit":
      return during === "send"
        ? "Too many codes sent to this email. Wait a few minutes, then try again."
        : "Too many tries. Wait a few minutes, then try again.";
    case "cancelled":
      return during === "google"
        ? "The Google window closed. Try again when you're ready."
        : during === "passkey-signup"
          ? "The passkey prompt closed. Nothing was made."
          : "The passkey prompt closed. Try again when you're ready.";
    case "popup-blocked":
      return "Your browser blocked the Google window. Allow pop-ups for this site, then try again.";
    case "unavailable":
      return "Google sign-in isn't set up here yet. Use your email or a passkey.";
    case "timeout":
      return "Google sign-in took too long. Try again.";
    case "no-account":
      return "No Gloam account uses that passkey. Create one, or continue with your email.";
    case "not-ready":
      return "Sign-in is still starting. Try again in a moment.";
    case "network":
      return "Couldn't reach the sign-in service. Check your connection and try again.";
    default:
      return during === "send"
        ? "Couldn't send a code. Try again."
        : during === "verify"
          ? "Couldn't sign you in. Try again."
          : during === "google"
            ? "Couldn't sign you in with Google. Try again."
            : during === "passkey-login"
              ? "Couldn't sign in with that passkey. Try again."
              : "Couldn't create a passkey. Try again.";
  }
}

/** A code that can't be used again: the sheet offers a new one at once, without the wait. */
export function needsNewCode(kind: SignInErrorKind | undefined): boolean {
  return kind === "expired-code" || kind === "used-up-code";
}

/* ---------------------------------------------------------------- steps */

/**
 * - start: the email field, then Google and Passkey. `busy` while a code is on
 *   its way, the passkey prompt is open, or the Google window is.
 * - passkey: a passkey sign-in that found nothing (closed, or no account for it).
 *   It offers to create a passkey, or to try again. `busy` while a prompt is open.
 * - code: the code sent to `email`. `busy` while it is checked or a new one is sent.
 */
export type SignInState =
  | {
      kind: "start";
      busy: null | "send" | "passkey-login" | "google";
      error: SignInError | null;
    }
  | {
      kind: "passkey";
      busy: null | "passkey-login" | "passkey-signup";
      error: SignInError | null;
    }
  | {
      kind: "code";
      email: string;
      otpId: string;
      bundle: string;
      sentAt: number;
      busy: null | "verify" | "resend";
      error: SignInError | null;
      /** A new code went out from this step. */
      resent: boolean;
    };

export type SignInAction =
  | { type: "send" }
  | { type: "sent"; email: string; otpId: string; bundle: string; at: number }
  | { type: "sendFailed"; error: SignInError; at: number }
  | { type: "resend" }
  | { type: "verify" }
  | { type: "verifyFailed"; error: SignInError }
  | { type: "passkey"; mode: "login" | "signup" }
  | { type: "passkeyFailed"; error: SignInError }
  | { type: "google" }
  | { type: "googleFailed"; error: SignInError }
  | { type: "back" };

export const SIGN_IN_START: SignInState = { kind: "start", busy: null, error: null };

/**
 * A passkey sign-in that ends on the passkey step's offer to create one: the prompt
 * closed (which is also what a browser with no passkey for this site gives) or the
 * passkey belongs to no account. Anything else (network, rate limit) says so where it was.
 */
export function offersPasskeyCreate(kind: SignInErrorKind): boolean {
  return kind === "cancelled" || kind === "no-account" || kind === "unknown";
}

export function signInReducer(s: SignInState, a: SignInAction): SignInState {
  switch (a.type) {
    case "send":
      // from the start: the email went in. One request at a time.
      return s.kind === "start" && !s.busy ? { kind: "start", busy: "send", error: null } : s;
    case "resend":
      return s.kind === "code" && !s.busy ? { ...s, busy: "resend", error: null } : s;
    case "sent":
      // only an answer to the request still waiting: one that comes back after a Back is dropped
      if (!(s.kind === "start" && s.busy === "send") && !(s.kind === "code" && s.busy === "resend")) return s;
      if (s.kind === "code")
        return { ...s, email: a.email, otpId: a.otpId, bundle: a.bundle, sentAt: a.at, busy: null, error: null, resent: true };
      return { kind: "code", email: a.email, otpId: a.otpId, bundle: a.bundle, sentAt: a.at, busy: null, error: null, resent: false };
    case "sendFailed":
      if (!(s.kind === "start" && s.busy === "send") && !(s.kind === "code" && s.busy === "resend")) return s;
      if (s.kind === "code")
        // a refused resend starts the wait over, so a rate limit is never hammered
        return { ...s, busy: null, error: a.error, sentAt: a.error.kind === "rate-limit" ? a.at : s.sentAt };
      return { kind: "start", busy: null, error: a.error };
    case "verify":
      return s.kind === "code" && !s.busy ? { ...s, busy: "verify", error: null } : s;
    case "verifyFailed":
      return s.kind === "code" ? { ...s, busy: null, error: a.error } : s;
    case "passkey":
      // the first step only signs in; making a passkey is offered on the passkey step
      if (s.kind === "start" && !s.busy && a.mode === "login") return { kind: "start", busy: "passkey-login", error: null };
      if (s.kind === "passkey" && !s.busy) return { kind: "passkey", busy: a.mode === "login" ? "passkey-login" : "passkey-signup", error: null };
      return s;
    case "passkeyFailed":
      if (s.kind === "start" && s.busy === "passkey-login")
        return offersPasskeyCreate(a.error.kind) ? { kind: "passkey", busy: null, error: a.error } : { kind: "start", busy: null, error: a.error };
      if (s.kind === "passkey" && s.busy) return { kind: "passkey", busy: null, error: a.error };
      return s;
    case "google":
      return s.kind === "start" && !s.busy ? { kind: "start", busy: "google", error: null } : s;
    case "googleFailed":
      return s.kind === "start" && s.busy === "google" ? { kind: "start", busy: null, error: a.error } : s;
    case "back":
      // a code being checked, or a passkey prompt that is open, can't be walked away from mid-way
      if (!canClose(s)) return s;
      return SIGN_IN_START;
  }
}

/** Resend is open: on the code step, nothing running, and the wait is over or the code is spent. */
export function canResend(s: SignInState, now: number): boolean {
  if (s.kind !== "code" || s.busy) return false;
  return needsNewCode(s.error?.kind) || resendSecondsLeft(s.sentAt, now) === 0;
}

/**
 * The sheet can be closed: not while a code is checked or a passkey prompt is open.
 * The Google window can be left open: if it finishes, the sign-in still lands.
 */
export function canClose(s: SignInState): boolean {
  if (s.kind === "code") return s.busy !== "verify";
  return s.busy !== "passkey-login" && s.busy !== "passkey-signup";
}
