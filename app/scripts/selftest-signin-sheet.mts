/**
 * Self-test: Gloam's sign-in sheet (lib/signInSheet, drawn by
 * components/app/GloamSignInSheet).
 *
 *  - the steps: email, code, back; one request at a time; a code being checked
 *    can't be walked away from, and the sheet can't close mid-check or mid-passkey
 *  - the code field: digits only, paste replaces, spaces and dashes dropped,
 *    full-width digits read, cut to length, the length from the auth proxy config
 *  - the email check, and the email kept as typed (trimmed, never lowercased)
 *  - resend: a 30 second wait, open at once for a spent code, restarted by a rate limit
 *  - Passkey signs in first and offers to create one when it finds none
 *  - Google: one window at a time, plain words for a closed or blocked window, the
 *    client ID switch, and the origin Google returns its window to
 *  - failures read in plain words, never the SDK's own text
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-signin-sheet.mts
 */
import assert from "node:assert/strict";
import {
  DEFAULT_OTP_FORMAT,
  RESEND_COOLDOWN_MS,
  SIGN_IN_START,
  canClose,
  canResend,
  cleanEmail,
  cleanOtp,
  emailProblem,
  needsNewCode,
  offersPasskeyCreate,
  otpAfterPaste,
  otpComplete,
  otpFormat,
  resendSecondsLeft,
  signInError,
  signInErrorKind,
  signInReducer,
  type SignInState,
} from "../src/lib/signInSheet";
import { googleClientIdFrom, oauthRedirectFor } from "../src/lib/embeddedWallet";
import { SIGN_IN_PENDING_MS, onSignInSheetRequest, openSignInSheet } from "../src/lib/turnkeyBridge";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

/** A TurnkeyError-shaped error wrapping the SDK's own, as the kit throws them. */
function tk(code: string, message: string, cause?: unknown) {
  return Object.assign(new Error(message), { name: "TurnkeyError", code, cause });
}

const T0 = 1_000_000;
const sent = (s: SignInState = SIGN_IN_START) =>
  signInReducer(signInReducer(s, { type: "send" }), { type: "sent", email: "a@b.co", otpId: "otp1", bundle: "b1", at: T0 });

test("email, then the code, then back to the email", () => {
  let s = signInReducer(SIGN_IN_START, { type: "send" });
  assert.deepEqual(s, { kind: "start", busy: "send", error: null });
  // one request at a time
  assert.equal(signInReducer(s, { type: "send" }), s);
  assert.equal(signInReducer(s, { type: "passkey", mode: "login" }), s);
  s = signInReducer(s, { type: "sent", email: "a@b.co", otpId: "otp1", bundle: "b1", at: T0 });
  assert.equal(s.kind, "code");
  assert.ok(s.kind === "code" && s.email === "a@b.co" && s.otpId === "otp1" && !s.resent && s.busy === null);
  assert.deepEqual(signInReducer(s, { type: "back" }), SIGN_IN_START);
});

test("an answer that comes back after Back is dropped", () => {
  const resending = signInReducer(sent(), { type: "resend" });
  const back = signInReducer(resending, { type: "back" });
  assert.deepEqual(back, SIGN_IN_START);
  assert.deepEqual(signInReducer(back, { type: "sent", email: "a@b.co", otpId: "late", bundle: "x", at: T0 }), SIGN_IN_START);
  assert.deepEqual(signInReducer(back, { type: "sendFailed", error: signInError(new Error("x"), "send"), at: T0 }), SIGN_IN_START);
  // and a code step with nothing in flight ignores a stray answer too
  const idle = sent();
  assert.equal(signInReducer(idle, { type: "sent", email: "a@b.co", otpId: "late", bundle: "x", at: T0 + 1 }), idle);
});

test("a code that doesn't send stays on the email step and says why", () => {
  const s = signInReducer(signInReducer(SIGN_IN_START, { type: "send" }), {
    type: "sendFailed",
    error: signInError(new TypeError("Failed to fetch"), "send"),
    at: T0,
  });
  assert.equal(s.kind, "start");
  assert.equal(s.error?.kind, "network");
  assert.equal(s.error?.during, "send");
  // trying again clears it
  assert.equal(signInReducer(s, { type: "send" }).error, null);
});

test("checking a code: busy, then a wrong code says so and lets them retype", () => {
  let s = signInReducer(sent(), { type: "verify" });
  assert.ok(s.kind === "code" && s.busy === "verify");
  assert.equal(signInReducer(s, { type: "verify" }), s, "never checked twice at once");
  assert.equal(signInReducer(s, { type: "back" }), s, "no walking away mid-check");
  assert.equal(canClose(s), false, "no closing mid-check");
  s = signInReducer(s, { type: "verifyFailed", error: signInError(tk("INVALID_OTP_CODE", "The provided OTP code is invalid."), "verify") });
  assert.ok(s.kind === "code" && s.busy === null && s.error?.kind === "wrong-code");
  assert.equal(canClose(s), true);
  assert.equal(signInReducer(s, { type: "verify" }).error, null);
});

test("Passkey signs in first; finding nothing offers to create one", () => {
  const cancelled = () => signInError(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"), "passkey-login");
  // the first step never makes a passkey by itself
  assert.equal(signInReducer(SIGN_IN_START, { type: "passkey", mode: "signup" }), SIGN_IN_START);
  const trying = signInReducer(SIGN_IN_START, { type: "passkey", mode: "login" });
  assert.ok(trying.kind === "start" && trying.busy === "passkey-login");
  assert.equal(canClose(trying), false, "no closing while the prompt is open");
  assert.equal(signInReducer(trying, { type: "back" }), trying);
  // closed, or no passkey on this device (the same to the page): the passkey step
  const offer = signInReducer(trying, { type: "passkeyFailed", error: cancelled() });
  assert.ok(offer.kind === "passkey" && offer.busy === null && offer.error?.kind === "cancelled");
  assert.equal(canClose(offer), true);
  const noAccount = signInReducer(trying, { type: "passkeyFailed", error: signInError(new Error("organization not found"), "passkey-login") });
  assert.equal(noAccount.kind, "passkey");
  // a network failure says so on the first step instead
  const offline = signInReducer(trying, { type: "passkeyFailed", error: signInError(new TypeError("Failed to fetch"), "passkey-login") });
  assert.ok(offline.kind === "start" && offline.error?.kind === "network");
  assert.ok(offersPasskeyCreate("cancelled") && offersPasskeyCreate("no-account") && !offersPasskeyCreate("network") && !offersPasskeyCreate("rate-limit"));
  // on the passkey step: create, or try again
  const creating = signInReducer(offer, { type: "passkey", mode: "signup" });
  assert.ok(creating.kind === "passkey" && creating.busy === "passkey-signup");
  assert.equal(canClose(creating), false);
  const closed = signInReducer(creating, {
    type: "passkeyFailed",
    error: signInError(Object.assign(new Error("Passkey creation was cancelled by the user."), { code: "SELECT_PASSKEY_CANCELLED" }), "passkey-signup"),
  });
  assert.ok(closed.kind === "passkey" && closed.error?.text === "The passkey prompt closed. Nothing was made.");
  const again = signInReducer(closed, { type: "passkey", mode: "login" });
  assert.ok(again.kind === "passkey" && again.busy === "passkey-login");
  assert.deepEqual(signInReducer(closed, { type: "back" }), SIGN_IN_START);
});

test("Google: one window at a time, and a failure says why on the first step", () => {
  const g = signInReducer(SIGN_IN_START, { type: "google" });
  assert.ok(g.kind === "start" && g.busy === "google");
  assert.equal(signInReducer(g, { type: "google" }), g);
  assert.equal(signInReducer(g, { type: "send" }), g, "no email code while Google is open");
  assert.equal(canClose(g), true, "the sheet can close: a finished Google window still signs in");
  const closed = signInReducer(g, { type: "googleFailed", error: signInError(new Error("Authentication window was closed."), "google") });
  assert.ok(closed.kind === "start" && closed.busy === null && closed.error?.kind === "cancelled");
  assert.equal(closed.error?.text, "The Google window closed. Try again when you're ready.");
  // a stray answer after Back changes nothing
  assert.deepEqual(signInReducer(SIGN_IN_START, { type: "googleFailed", error: closed.error! }), SIGN_IN_START);
});

test("Google failures read in plain words", () => {
  const k = (e: unknown) => signInErrorKind(e, "google");
  const wrap = (cause: unknown) => Object.assign(new Error("Failed to complete OAuth"), { name: "TurnkeyError", code: "OAUTH_LOGIN_ERROR", cause });
  assert.equal(k(new Error("Authentication window was closed.")), "cancelled");
  assert.equal(k(wrap(new Error("Authentication window was closed."))), "cancelled");
  assert.equal(k(new Error("Failed to open Google login window.")), "popup-blocked");
  assert.match(signInError(new Error("Failed to open Google login window."), "google").text, /blocked the Google window/);
  assert.equal(k(Object.assign(new Error("Google Client ID is not configured."), { code: "INVALID_CONFIGURATION" })), "unavailable");
  assert.equal(k(new Error("OAuth Redirect URI is not configured.")), "unavailable");
  assert.equal(k(new Error("Authentication timed out.")), "timeout");
  assert.equal(k(new TypeError("Failed to fetch")), "network");
  assert.equal(k(new Error("boom")), "unknown");
  assert.equal(signInError(new Error("boom"), "google").text, "Couldn't sign you in with Google. Try again.");
  // the same words outside Google stay what they were
  assert.equal(signInErrorKind(new Error("Failed to open Google login window."), "send"), "unknown");
});

test("Google's client ID turns the button on, and Google returns its window to this origin", () => {
  assert.equal(googleClientIdFrom({}), "");
  assert.equal(googleClientIdFrom({ googleClientId: "  " }), "");
  assert.equal(googleClientIdFrom({ googleClientId: "not-a-client-id" }), "");
  assert.equal(googleClientIdFrom({ googleClientId: "GOCSPX-secret" }), "", "a client secret is never taken for the ID");
  const id = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com";
  assert.equal(googleClientIdFrom({ googleClientId: ` ${id} ` }), id);
  const live = "311220231992-4k897gu7d074ls84vrh2i1q47t26u5a8.apps.googleusercontent.com";
  assert.equal(googleClientIdFrom({ googleClientId: live }), live, "the production client ID");
  // each origin sends Google's window back to itself, exactly as registered: no path, no trailing slash
  assert.equal(oauthRedirectFor("https://www.gloam.trade"), "https://www.gloam.trade");
  assert.equal(oauthRedirectFor("https://gloam.trade/"), "https://gloam.trade");
  assert.equal(oauthRedirectFor("http://localhost:3000"), "http://localhost:3000");
  assert.equal(
    oauthRedirectFor("https://gloam-trade-git-feat-gloam-signin-sheet-duke-s-team.vercel.app"),
    "https://gloam-trade-git-feat-gloam-signin-sheet-duke-s-team.vercel.app",
  );
});

test("the code field keeps digits only, and a paste replaces the code", () => {
  const f = DEFAULT_OTP_FORMAT;
  assert.deepEqual(f, { length: 6, alphanumeric: false });
  assert.equal(cleanOtp("12a3 4-5", f), "12345");
  assert.equal(cleanOtp("123 456", f), "123456");
  assert.equal(cleanOtp("123-456-789", f), "123456");
  assert.equal(cleanOtp("１２３４５６", f), "123456", "full-width digits");
  assert.equal(cleanOtp("abc", f), "");
  assert.equal(cleanOtp("Your code is 482913.", f), "482913");
  assert.equal(otpAfterPaste("12", " 654 321 ", f), "654321", "a paste into a half-typed field replaces it");
  assert.equal(otpAfterPaste("12", "hello", f), "12", "a paste with no digits changes nothing");
  assert.equal(otpAfterPaste("", "98765", f), "98765");
  assert.equal(otpComplete("123456", f), true);
  assert.equal(otpComplete("12345", f), false);
  assert.equal(otpComplete("12345a", f), false);
});

test("the code's shape comes from the auth proxy config, 6 digits when it says nothing", () => {
  assert.deepEqual(otpFormat(undefined), { length: 6, alphanumeric: false });
  assert.deepEqual(otpFormat({ otpLength: "6", otpAlphanumeric: false }), { length: 6, alphanumeric: false });
  assert.deepEqual(otpFormat({ otpLength: "8", otpAlphanumeric: true }), { length: 8, alphanumeric: true });
  assert.deepEqual(otpFormat({ otpLength: "nope" }), { length: 6, alphanumeric: false });
  assert.deepEqual(otpFormat({ otpLength: "99" }), { length: 6, alphanumeric: false });
  const alnum = otpFormat({ otpLength: "6", otpAlphanumeric: true });
  assert.equal(cleanOtp("ab-12 cD", alnum), "ab12cD", "letters kept as typed for a letter code");
});

test("the email is checked, and kept as typed", () => {
  assert.equal(emailProblem(""), "Enter your email.");
  assert.equal(emailProblem("   "), "Enter your email.");
  for (const bad of ["duke", "duke@", "@gloam.trade", "duke@gloam", "du ke@gloam.trade", "duke@gloam.t", "duke@@gloam.trade", "duke@.trade"])
    assert.ok(emailProblem(bad), bad);
  for (const ok of ["duke@gloam.trade", " Duke.Smith+pay@Mail.Example.co.uk ", "a@b.co"]) assert.equal(emailProblem(ok), null, ok);
  // the auth proxy matches the email as it was first given: never lowercased
  assert.equal(cleanEmail("  Duke@Gloam.trade "), "Duke@Gloam.trade");
});

test("resend waits 30 seconds, then opens", () => {
  assert.equal(RESEND_COOLDOWN_MS, 30_000);
  assert.equal(resendSecondsLeft(T0, T0), 30);
  assert.equal(resendSecondsLeft(T0, T0 + 100), 30);
  assert.equal(resendSecondsLeft(T0, T0 + 29_001), 1);
  assert.equal(resendSecondsLeft(T0, T0 + 30_000), 0);
  assert.equal(resendSecondsLeft(T0, T0 + 99_000), 0);
  const s = sent();
  assert.equal(canResend(s, T0 + 10_000), false);
  assert.equal(canResend(s, T0 + 30_000), true);
  assert.equal(canResend(SIGN_IN_START, T0 + 99_000), false);
  // a resend in flight can't be doubled
  const r = signInReducer(s, { type: "resend" });
  assert.equal(canResend(r, T0 + 99_000), false);
  const again = signInReducer(r, { type: "sent", email: "a@b.co", otpId: "otp2", bundle: "b2", at: T0 + 40_000 });
  assert.ok(again.kind === "code" && again.otpId === "otp2" && again.resent && again.sentAt === T0 + 40_000);
  assert.equal(canResend(again, T0 + 50_000), false, "the wait starts over");
});

test("a spent code opens resend at once, and a rate limit starts the wait over", () => {
  const s = sent();
  const expired = signInReducer(signInReducer(s, { type: "verify" }), {
    type: "verifyFailed",
    error: signInError(tk("OTP_COMPLETION_ERROR", "Failed to complete OTP", new Error("Turnkey error 3: OTP has expired")), "verify"),
  });
  assert.equal(expired.error?.kind, "expired-code");
  assert.ok(needsNewCode(expired.error?.kind));
  assert.equal(canResend(expired, T0 + 1_000), true);
  const used = signInError(new Error("Turnkey error 9: max number of attempts exceeded for this OTP"), "verify");
  assert.equal(used.kind, "used-up-code");
  assert.ok(needsNewCode(used.kind));
  assert.ok(!needsNewCode("wrong-code"));

  const limited = signInReducer(signInReducer(s, { type: "resend" }), {
    type: "sendFailed",
    error: signInError(tk("MAX_OTP_INITIATED_ERROR", "Maximum number of OTPs has been reached for this contact."), "send"),
    at: T0 + 35_000,
  });
  assert.ok(limited.kind === "code" && limited.error?.kind === "rate-limit" && limited.sentAt === T0 + 35_000);
  assert.equal(canResend(limited, T0 + 40_000), false);
  assert.equal(limited.kind === "code" && limited.otpId, "otp1", "the code already sent still works");
});

test("failures are read from the kit's codes, its wrapped errors, and their words", () => {
  const k = signInErrorKind;
  assert.equal(k(tk("INVALID_OTP_CODE", "x"), "verify"), "wrong-code");
  assert.equal(k(tk("OTP_COMPLETION_ERROR", "Failed to complete OTP", tk("INVALID_OTP_CODE", "The provided OTP code is invalid.")), "verify"), "wrong-code");
  assert.equal(k(tk("MAX_OTP_INITIATED_ERROR", "x"), "send"), "rate-limit");
  assert.equal(k(new Error("429 Too Many Requests"), "send"), "rate-limit");
  assert.equal(k(Object.assign(new Error("x"), { statusCode: 429 }), "send"), "rate-limit");
  assert.equal(k(Object.assign(new Error("Turnkey error 8: slow down"), { name: "TurnkeyRequestError", code: 8 }), "send"), "rate-limit");
  assert.equal(k(tk("INIT_OTP_ERROR", "Failed to initialize OTP", new Error("Turnkey error 8: rate limit exceeded")), "send"), "rate-limit");
  assert.equal(k(tk("SELECT_PASSKEY_CANCELLED", "Passkey creation was cancelled by the user."), "passkey-signup"), "cancelled");
  assert.equal(k(tk("PASSKEY_LOGIN_AUTH_ERROR", "Failed", new DOMException("The operation either timed out or was not allowed.", "NotAllowedError")), "passkey-login"), "cancelled");
  assert.equal(k(tk("PASSKEY_LOGIN_AUTH_ERROR", "Failed", new Error("Turnkey error 5: organization not found")), "passkey-login"), "no-account");
  assert.equal(k(tk("CLIENT_NOT_INITIALIZED", "Client is not initialized."), "send"), "not-ready");
  assert.equal(k(tk("INIT_OTP_ERROR", "Failed to initialize OTP", new TypeError("Failed to fetch")), "send"), "network");
  assert.equal(k(new TypeError("Load failed"), "verify"), "network");
  assert.equal(k(Object.assign(new Error("x"), { statusCode: 503 }), "send"), "network");
  assert.equal(k(tk("UNKNOWN", "boom"), "verify"), "unknown");
  // a wrong code only counts as one while a code is in play
  assert.equal(k(tk("INVALID_OTP_CODE", "x"), "passkey-login"), "unknown");
  assert.equal(k(null, "send"), "unknown");
  assert.equal(k("Failed to fetch", "send"), "network");
});

test("every failure reads in plain words, never the SDK's own text", () => {
  const cases: [unknown, Parameters<typeof signInError>[1], RegExp][] = [
    [tk("INVALID_OTP_CODE", "x"), "verify", /didn't match/],
    [new Error("OTP has expired"), "verify", /expired\. Send a new one/],
    [tk("MAX_OTP_INITIATED_ERROR", "x"), "send", /Too many codes sent to this email/],
    [new Error("429"), "verify", /Too many tries/],
    [new TypeError("Failed to fetch"), "send", /Couldn't reach the sign-in service/],
    [tk("SELECT_PASSKEY_CANCELLED", "x"), "passkey-login", /passkey prompt closed/],
    [new Error("organization not found"), "passkey-login", /No Gloam account uses that passkey/],
    [tk("UNKNOWN", "Turnkey error 13: internal"), "send", /^Couldn't send a code\. Try again\.$/],
    [tk("UNKNOWN", "x"), "verify", /^Couldn't sign you in\. Try again\.$/],
    [tk("UNKNOWN", "x"), "passkey-login", /^Couldn't sign in with that passkey/],
    [tk("UNKNOWN", "x"), "passkey-signup", /^Couldn't create a passkey/],
  ];
  for (const [e, during, want] of cases) {
    const { text } = signInError(e, during);
    assert.match(text, want, text);
    assert.ok(!/Turnkey|OTP|—|error \d/i.test(text), `no internals or em dashes: ${text}`);
  }
});

test("a Sign in tapped before the sheet is listening is never dropped: the sheet opens with it once it mounts", () => {
  const seen: string[] = [];
  // tapped while the kit's code is still loading: nothing is listening yet
  assert.equal(openSignInSheet({ walletLabel: "early" }, 1_000), false);
  const off = onSignInSheetRequest((o) => seen.push(o.walletLabel ?? ""), 1_500);
  assert.deepEqual(seen, ["early"], "handed over as the sheet mounts");
  // once listening, a tap opens it straight away, and nothing is replayed
  assert.equal(openSignInSheet({ walletLabel: "now" }, 2_000), true);
  assert.deepEqual(seen, ["early", "now"]);
  off();
  // a tap long before the sheet ever mounts is not opened out of nowhere later
  openSignInSheet({ walletLabel: "stale" }, 10_000);
  const off2 = onSignInSheetRequest((o) => seen.push(o.walletLabel ?? ""), 10_000 + SIGN_IN_PENDING_MS + 1);
  assert.deepEqual(seen, ["early", "now"]);
  // and it is used up: a second listener doesn't get it either
  const off3 = onSignInSheetRequest((o) => seen.push(o.walletLabel ?? ""), 10_001);
  assert.deepEqual(seen, ["early", "now"]);
  off2();
  off3();
});

console.log(`selftest-signin-sheet: ${passed} passed`);
