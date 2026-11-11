"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type FormEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { AuthState, ClientState, OtpType, useTurnkey } from "@turnkey/react-wallet-kit";
import { Mark } from "@/components/Logo";
import { Spinner } from "@/components/ui/Spinner";
import { useModalFocus } from "@/hooks/useModalFocus";
import { TURNKEY_GOOGLE_CLIENT_ID } from "@/lib/embeddedWallet";
import { onSignInSheetRequest, type SignInSheetOptions } from "@/lib/turnkeyBridge";
import {
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
  signInReducer,
  type OtpFormat,
  type SignInState,
} from "@/lib/signInSheet";

const noopSubscribe = () => () => {};

/**
 * Gloam's sign-in sheet for Gloam wallets: an email code or a passkey, drawn in
 * the app's own tokens instead of Turnkey's stock modal. Mounted once inside the
 * Turnkey provider (TurnkeyKit) and opened from anywhere with openSignInSheet
 * (lib/turnkeyBridge): the header and sidebar Sign in, and the partner portal.
 *
 * Every call goes through the kit's auth-proxy methods, so sign-up needs no
 * backend: initOtp and completeOtp for the email code (completeOtp signs in an
 * email that has an account and makes one for an email that doesn't),
 * loginWithPasskey and signUpWithPasskey for a passkey, handleGoogleOauth for
 * Google (shown only with NEXT_PUBLIC_TURNKEY_GOOGLE_CLIENT_ID set and Google on in
 * the auth proxy config; always a popup window, DEPLOY-TURNKEY.md). Once one succeeds the kit
 * holds the session and the sheet closes; what follows (the wallet list, the
 * Create wallet sheet, the wagmi connector) is unchanged.
 */
export function GloamSignInSheet() {
  const { authState } = useTurnkey();
  const [request, setRequest] = useState<{ n: number; opts: SignInSheetOptions }>({ n: 0, opts: {} });
  const opened = request.n;
  const setOpened = (n: 0) => setRequest({ n, opts: {} });
  const signedIn = authState === AuthState.Authenticated;

  useEffect(() => onSignInSheetRequest((opts) => setRequest((r) => ({ n: r.n + 1, opts }))), []);

  // Signed in, by this sheet or another tab: close, so signing out never brings it back.
  useEffect(() => {
    if (!signedIn || !opened) return;
    const t = window.setTimeout(() => setRequest({ n: 0, opts: {} }), 0);
    return () => window.clearTimeout(t);
  }, [signedIn, opened]);

  if (!opened || signedIn) return null;
  const { onUseWallet, walletLabel } = request.opts;
  // keyed by the request: every open starts at the email step
  return (
    <LiveSheet
      key={opened}
      onClose={() => setOpened(0)}
      walletLabel={walletLabel}
      onUseWallet={
        onUseWallet
          ? () => {
              setOpened(0);
              onUseWallet();
            }
          : undefined
      }
    />
  );
}

/** Ticks once a second while `active`, for the resend wait. */
function useNow(active: boolean): [number, (t: number) => void] {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(t);
  }, [active]);
  return [now, setNow];
}

function LiveSheet({
  onClose,
  onUseWallet,
  walletLabel,
}: {
  onClose: () => void;
  onUseWallet?: () => void;
  walletLabel?: string;
}) {
  const { clientState, config, initOtp, completeOtp, loginWithPasskey, signUpWithPasskey, handleGoogleOauth } = useTurnkey();
  const format = otpFormat(config?.auth);
  // Google: its client ID is set for this build, and the auth proxy config hasn't turned it off
  const googleOff = config?.ui?.authModal?.methods?.googleOauthEnabled === false;
  const google = Boolean(TURNKEY_GOOGLE_CLIENT_ID) && !googleOff;
  useEffect(() => {
    if (TURNKEY_GOOGLE_CLIENT_ID && googleOff)
      console.warn("[Gloam] Google sign-in is hidden: turn Google on in the Turnkey auth proxy config (DEPLOY-TURNKEY.md).");
  }, [googleOff]);
  const [state, dispatch] = useReducer(signInReducer, SIGN_IN_START);
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [now, setNow] = useNow(state.kind === "code");
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const close = useCallback(() => {
    if (canClose(state)) onClose();
  }, [state, onClose]);

  async function sendCode(again: boolean) {
    if (state.busy || (again && !canResend(state, Date.now()))) return;
    const to = again && state.kind === "code" ? state.email : cleanEmail(email);
    if (!again) {
      const problem = emailProblem(email);
      setEmailError(problem);
      if (problem) return;
    }
    dispatch({ type: again ? "resend" : "send" });
    try {
      const res = await initOtp({ otpType: OtpType.Email, contact: to });
      if (!live.current) return;
      const at = Date.now();
      setNow(at);
      setCode("");
      dispatch({ type: "sent", email: to, otpId: res.otpId, bundle: res.otpEncryptionTargetBundle, at });
    } catch (e) {
      if (!live.current) return;
      const at = Date.now();
      setNow(at);
      dispatch({ type: "sendFailed", error: signInError(e, "send"), at });
    }
  }

  async function verify(value: string) {
    // a spent code (expired, or too many tries) is never sent again: the sheet asks for a new one
    if (state.kind !== "code" || state.busy || needsNewCode(state.error?.kind) || !otpComplete(value, format)) return;
    dispatch({ type: "verify" });
    try {
      await completeOtp({
        otpId: state.otpId,
        otpCode: value,
        otpEncryptionTargetBundle: state.bundle,
        contact: state.email,
        otpType: OtpType.Email,
      });
      if (live.current) onClose();
    } catch (e) {
      if (!live.current) return;
      setCode("");
      dispatch({ type: "verifyFailed", error: signInError(e, "verify") });
    }
  }

  async function continueWithGoogle() {
    if (state.kind !== "start" || state.busy || !google) return;
    dispatch({ type: "google" });
    try {
      // Always a window, phones included: Google returns it to this origin's root, which
      // doesn't run the kit, so the whole-page flow (the kit's default on phones) could
      // never finish there. The page that opened the window reads the token and closes it.
      await handleGoogleOauth({ openInPage: false });
      if (live.current) onClose();
    } catch (e) {
      if (!live.current) return;
      dispatch({ type: "googleFailed", error: signInError(e, "google") });
    }
  }

  async function passkey(mode: "login" | "signup") {
    if ((state.kind !== "start" && state.kind !== "passkey") || state.busy) return;
    dispatch({ type: "passkey", mode });
    try {
      if (mode === "login") await loginWithPasskey();
      else await signUpWithPasskey();
      if (live.current) onClose();
    } catch (e) {
      if (!live.current) return;
      dispatch({ type: "passkeyFailed", error: signInError(e, mode === "login" ? "passkey-login" : "passkey-signup") });
    }
  }

  return (
    <SignInSheetView
      state={state}
      clientState={clientState === ClientState.Ready ? "ready" : clientState === ClientState.Error ? "error" : "starting"}
      format={format}
      now={now}
      email={email}
      onEmail={(v) => {
        setEmail(v);
        if (emailError) setEmailError(null);
      }}
      emailError={emailError}
      code={code}
      onCode={(v) => {
        setCode(v);
        if (otpComplete(v, format)) void verify(v);
      }}
      onSubmitEmail={() => void sendCode(false)}
      onSubmitCode={() => void verify(code)}
      onResend={() => void sendCode(true)}
      onBack={() => {
        setCode("");
        dispatch({ type: "back" });
      }}
      onPasskey={(mode) => void passkey(mode)}
      google={google}
      onGoogle={() => void continueWithGoogle()}
      onUseWallet={onUseWallet}
      walletLabel={walletLabel}
      onClose={close}
    />
  );
}

/**
 * The sheet itself, drawn from props only (the Turnkey wiring is in LiveSheet
 * above), so every step can be looked at without a live sign-in.
 */
export function SignInSheetView({
  state,
  clientState,
  format,
  now,
  email,
  onEmail,
  emailError,
  code,
  onCode,
  onSubmitEmail,
  onSubmitCode,
  onResend,
  onBack,
  onPasskey,
  google,
  onGoogle,
  onUseWallet,
  walletLabel = "Use a browser wallet",
  onClose,
}: {
  state: SignInState;
  clientState: "starting" | "ready" | "error";
  format: OtpFormat;
  now: number;
  email: string;
  onEmail: (v: string) => void;
  emailError: string | null;
  code: string;
  onCode: (v: string) => void;
  onSubmitEmail: () => void;
  onSubmitCode: () => void;
  onResend: () => void;
  onBack: () => void;
  onPasskey: (mode: "login" | "signup") => void;
  /** Continue with Google is set up here. */
  google: boolean;
  onGoogle: () => void;
  /** The opener's own wallet connect, as a full button under the other ways in. Unset: none is offered. */
  onUseWallet?: () => void;
  walletLabel?: string;
  onClose: () => void;
}) {
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const dialog = useRef<HTMLDivElement>(null);
  const emailField = useRef<HTMLInputElement>(null);
  const codeField = useRef<HTMLInputElement>(null);
  const passkeyCreate = useRef<HTMLButtonElement>(null);
  const closable = canClose(state);
  useModalFocus(dialog, onClose, { initial: emailField });

  // The field for the step: the code field when a code goes out (and again after a
  // wrong one), the email field on the way back, and Create a passkey on the passkey
  // step (the Passkey button that led there is gone, so focus would sit on the page).
  const step = state.kind;
  // a failed try on the code or passkey step comes back here too: the buttons it disabled dropped focus
  const stepError = state.kind === "start" ? null : state.error;
  useEffect(() => {
    const el = step === "code" ? codeField.current : step === "passkey" ? passkeyCreate.current : emailField.current;
    // only when focus is in the sheet, or was dropped to the page by a button that went busy
    const at = document.activeElement;
    if (el && (!at || at === document.body || dialog.current?.contains(at))) el.focus({ preventScroll: true });
  }, [step, stepError]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div
      ref={dialog}
      tabIndex={-1}
      className="fixed inset-0 z-[210] flex items-end justify-center outline-none sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="gs-title"
      aria-describedby="gs-sub"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="gl-rise-scrim absolute inset-0 bg-black/40 backdrop-blur-sm"
        aria-label="Close"
        onClick={onClose}
      />
      {/* rises into place on CSS (gl-rise-sheet in globals.css), still for reduced motion */}
      <div className="gl-rise-sheet relative z-[1] max-h-[92dvh] w-full max-w-[420px] overflow-y-auto rounded-t-[24px] bg-panel px-6 pb-[max(18px,env(safe-area-inset-bottom))] pt-6 shadow-pop sm:rounded-[24px] sm:px-7 sm:pb-5 sm:pt-7">
        <button
          type="button"
          onClick={onClose}
          disabled={!closable}
          aria-label="Close"
          className="absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground disabled:opacity-50 sm:right-4 sm:top-4"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>

        {state.kind === "start" ? (
          <StartStep
            state={state}
            clientState={clientState}
            email={email}
            onEmail={onEmail}
            emailError={emailError}
            emailField={emailField}
            onSubmitEmail={onSubmitEmail}
            onPasskey={onPasskey}
            google={google}
            onGoogle={onGoogle}
            onUseWallet={onUseWallet}
            walletLabel={walletLabel}
            walletDisabled={!closable}
          />
        ) : state.kind === "passkey" ? (
          <PasskeyStep state={state} onPasskey={onPasskey} onBack={onBack} createButton={passkeyCreate} />
        ) : (
          <CodeStep
            state={state}
            format={format}
            now={now}
            code={code}
            onCode={onCode}
            codeField={codeField}
            onSubmitCode={onSubmitCode}
            onResend={onResend}
            onBack={onBack}
          />
        )}

        <p className="mt-6 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-[11.5px] text-faint">
          <span className="inline-flex items-center gap-1">
            <ShieldGlyph />
            Secured by Turnkey
          </span>
          <Dot />
          <Link href="/terms" target="_blank" rel="noopener" className={FOOT_LINK}>
            Terms
          </Link>
          <Dot />
          <Link href="/privacy" target="_blank" rel="noopener" className={FOOT_LINK}>
            Privacy
          </Link>
        </p>
      </div>
    </div>,
    document.body
  );
}

const FOOT_LINK = "rounded underline-offset-2 transition-colors hover:text-foreground hover:underline";

function Dot() {
  return <span aria-hidden>·</span>;
}

function StartStep({
  state,
  clientState,
  email,
  onEmail,
  emailError,
  emailField,
  onSubmitEmail,
  onPasskey,
  google,
  onGoogle,
  onUseWallet,
  walletLabel,
  walletDisabled,
}: {
  state: Extract<SignInState, { kind: "start" }>;
  clientState: "starting" | "ready" | "error";
  email: string;
  onEmail: (v: string) => void;
  emailError: string | null;
  emailField: RefObject<HTMLInputElement | null>;
  onSubmitEmail: () => void;
  onPasskey: (mode: "login" | "signup") => void;
  google: boolean;
  onGoogle: () => void;
  /** A browser wallet is a first-class way in, so it gets a full button, not a footer link. */
  onUseWallet?: () => void;
  walletLabel: string;
  walletDisabled: boolean;
}) {
  const ready = clientState === "ready";
  const walletButton = onUseWallet ? (
    <button type="button" onClick={onUseWallet} disabled={walletDisabled} className="btn btn-ghost btn-lg btn-block mt-2 px-3">
      <WalletGlyph />
      {walletLabel}
    </button>
  ) : null;
  const busy = state.busy;
  const sendError = state.error?.during === "send" ? state.error : null;
  const otherError = state.error && !sendError ? state.error : null;
  const fieldError = emailError ?? sendError?.text ?? null;

  return (
    <div>
      <Mark size={32} />
      <h2 id="gs-title" className="mt-4 text-[21px] font-medium tracking-[-0.015em] text-foreground">
        Sign in to Gloam
      </h2>
      <p id="gs-sub" className="mt-0.5 text-[14px] text-mute">
        {google ? "Email, Google or passkey. No seed phrase." : "Email or passkey. No seed phrase."}
      </p>

      {clientState === "error" ? (
        <>
          <p role="alert" className="mt-5 text-[13.5px] leading-relaxed text-danger">
            {walletButton
              ? "Email and passkey sign-in isn't available here right now. Use a browser wallet instead."
              : "Email and passkey sign-in isn't available here right now. Try again in a little while."}
          </p>
          {walletButton && <div className="mt-3">{walletButton}</div>}
        </>
      ) : (
        <>
          <form
            className="mt-5"
            noValidate
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (ready && !busy) onSubmitEmail();
            }}
          >
            <label htmlFor="gs-email" className="sr-only">
              Email
            </label>
            <input
              id="gs-email"
              ref={emailField}
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="you@example.com"
              className="gl-input"
              value={email}
              disabled={busy === "send"}
              onChange={(e) => onEmail(e.target.value)}
              aria-invalid={Boolean(fieldError)}
              aria-describedby={fieldError ? "gs-email-error" : undefined}
            />
            {fieldError && (
              <p id="gs-email-error" role="alert" className="mt-1.5 text-[12.5px] leading-snug text-danger">
                {fieldError}
              </p>
            )}
            <button type="submit" disabled={!ready || busy !== null} aria-busy={busy === "send"} className="btn btn-ink btn-lg btn-block mt-2.5">
              {busy === "send" && <Spinner />}
              {busy === "send" ? "Sending code…" : "Continue"}
            </button>
          </form>

          <div className="my-4 flex items-center gap-3 text-[12px] text-faint" aria-hidden>
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>

          <div className={`grid gap-2 ${google ? "grid-cols-2" : "grid-cols-1"}`}>
            {google && (
              <button
                type="button"
                onClick={onGoogle}
                disabled={!ready || busy !== null}
                aria-label="Continue with Google"
                className="btn btn-ghost btn-lg btn-block px-3"
              >
                {busy === "google" ? <Spinner className="h-4 w-4" /> : <GoogleGlyph />}
                {busy === "google" ? "Opening…" : "Google"}
              </button>
            )}
            <button
              type="button"
              onClick={() => onPasskey("login")}
              disabled={!ready || busy !== null}
              aria-label="Sign in with a passkey"
              className="btn btn-ghost btn-lg btn-block px-3"
            >
              {busy === "passkey-login" ? <Spinner className="h-4 w-4" /> : <KeyGlyph />}
              {busy === "passkey-login" ? "Waiting…" : "Passkey"}
            </button>
          </div>
          {walletButton}
          {otherError && (
            <p role="alert" className="mt-2.5 text-center text-[12.5px] leading-snug text-danger">
              {otherError.text}
            </p>
          )}
          {!ready && (
            <p role="status" className="mt-2.5 flex items-center justify-center gap-2 text-[12.5px] text-mute">
              <Spinner className="h-3 w-3" />
              Getting sign-in ready…
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * A passkey sign-in that found nothing: most often there is no Gloam passkey on
 * this device yet (the browser's prompt looks the same as a closed one), so the
 * way on is to create one. Trying again stays here.
 */
function PasskeyStep({
  state,
  onPasskey,
  onBack,
  createButton,
}: {
  state: Extract<SignInState, { kind: "passkey" }>;
  onPasskey: (mode: "login" | "signup") => void;
  onBack: () => void;
  createButton: RefObject<HTMLButtonElement | null>;
}) {
  const busy = state.busy;
  // the words above already say what a closed prompt or an unknown passkey means
  const error = state.error && !(state.error.during === "passkey-login" && offersPasskeyCreate(state.error.kind)) ? state.error : null;

  return (
    <div>
      <BackButton onBack={onBack} disabled={busy !== null} />
      <h2 id="gs-title" className="mt-3 text-[21px] font-medium tracking-[-0.015em] text-foreground">
        No passkey found
      </h2>
      <p id="gs-sub" className="mt-0.5 text-[14px] leading-relaxed text-mute">
        New to Gloam? Create a passkey. It stays on this device or in your password manager.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-[12.5px] leading-snug text-danger">
          {error.text}
        </p>
      )}
      <button
        ref={createButton}
        type="button"
        onClick={() => onPasskey("signup")}
        disabled={busy !== null}
        aria-busy={busy === "passkey-signup"}
        className="btn btn-ink btn-lg btn-block mt-5"
      >
        {busy === "passkey-signup" && <Spinner />}
        {busy === "passkey-signup" ? "Waiting for your passkey…" : "Create a passkey"}
      </button>
      <button type="button" onClick={() => onPasskey("login")} disabled={busy !== null} className="btn btn-quiet btn-block mt-1.5">
        {busy === "passkey-login" && <Spinner />}
        {busy === "passkey-login" ? "Waiting…" : "I have one. Try again"}
      </button>
    </div>
  );
}

function BackButton({ onBack, disabled }: { onBack: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onBack}
      disabled={disabled}
      className="-ml-2 -mt-1 inline-flex h-10 items-center gap-1 rounded-full pl-1.5 pr-3 text-[13.5px] text-mute transition-colors hover:bg-surface hover:text-foreground disabled:opacity-50"
    >
      <BackGlyph />
      Back
    </button>
  );
}

function CodeStep({
  state,
  format,
  now,
  code,
  onCode,
  codeField,
  onSubmitCode,
  onResend,
  onBack,
}: {
  state: Extract<SignInState, { kind: "code" }>;
  format: OtpFormat;
  now: number;
  code: string;
  onCode: (v: string) => void;
  codeField: RefObject<HTMLInputElement | null>;
  onSubmitCode: () => void;
  onResend: () => void;
  onBack: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const verifying = state.busy === "verify";
  const wait = resendSecondsLeft(state.sentAt, now);
  const resendOpen = canResend(state, now);
  const spent = needsNewCode(state.error?.kind);
  const unit = format.alphanumeric ? "character" : "digit";

  return (
    <div>
      <BackButton onBack={onBack} disabled={verifying} />
      <h2 id="gs-title" className="mt-3 text-[21px] font-medium tracking-[-0.015em] text-foreground">
        Check your email
      </h2>
      <p id="gs-sub" className="mt-0.5 text-[14px] leading-relaxed text-mute [overflow-wrap:anywhere]">
        Enter the {format.length}-{unit} code sent to <span className="text-foreground">{state.email}</span>
      </p>

      <form
        className="mt-5"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onSubmitCode();
        }}
      >
        <div className="relative">
          <input
            id="gs-code"
            ref={codeField}
            type="text"
            inputMode={format.alphanumeric ? "text" : "numeric"}
            pattern={format.alphanumeric ? undefined : "[0-9]*"}
            autoComplete="one-time-code"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            aria-label={`${format.length}-${unit} code`}
            aria-invalid={Boolean(state.error)}
            aria-describedby={state.error ? "gs-code-error" : undefined}
            disabled={verifying}
            value={code}
            onChange={(e) => onCode(cleanOtp(e.target.value, format))}
            onPaste={(e: ClipboardEvent<HTMLInputElement>) => {
              e.preventDefault();
              onCode(otpAfterPaste(code, e.clipboardData.getData("text"), format));
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className="absolute inset-0 z-[1] h-full w-full cursor-text bg-transparent text-transparent caret-transparent outline-none selection:bg-transparent disabled:cursor-not-allowed"
          />
          <div aria-hidden className="grid gap-2" style={{ gridTemplateColumns: `repeat(${format.length}, minmax(0, 1fr))` }}>
            {Array.from({ length: format.length }, (_, i) => {
              const ch = code[i] ?? "";
              const active = focused && !verifying && i === Math.min(code.length, format.length - 1);
              return (
                <span
                  key={i}
                  className={`tnum grid h-14 place-items-center rounded-[14px] border bg-panel text-[22px] font-medium text-foreground transition-[border-color,box-shadow] duration-200 ${
                    state.error
                      ? "border-danger"
                      : active
                        ? "border-[color-mix(in_srgb,var(--navy-500)_65%,var(--line-strong))] shadow-[0_0_0_4px_color-mix(in_srgb,var(--navy-500)_12%,transparent)]"
                        : "border-line-strong"
                  } ${verifying ? "opacity-60" : ""}`}
                >
                  {ch || (active ? <span className="h-6 w-px animate-pulse bg-foreground" /> : null)}
                </span>
              );
            })}
          </div>
        </div>

        {state.error ? (
          <p id="gs-code-error" role="alert" className="mt-2 min-h-[1lh] text-[12.5px] leading-snug text-danger">
            {state.error.text}
          </p>
        ) : (
          <p role="status" aria-live="polite" className="mt-2 min-h-[1lh] text-[12.5px] leading-snug text-mute">
            {verifying ? "Signing you in…" : state.resent && state.busy === null ? "A new code is on its way." : ""}
          </p>
        )}

        <button type="submit" disabled={verifying || !otpComplete(code, format) || spent} className="btn btn-ink btn-lg btn-block mt-2.5">
          {verifying && <Spinner />}
          {verifying ? "Signing in…" : "Continue"}
        </button>
      </form>

      <div className="mt-1.5 grid grid-cols-2 gap-1">
        <button type="button" onClick={onResend} disabled={!resendOpen} className="btn btn-quiet btn-sm">
          {state.busy === "resend" && <Spinner />}
          {state.busy === "resend" ? "Sending…" : resendOpen ? (spent ? "Send a new code" : "Resend code") : `Resend in ${wait}s`}
        </button>
        <button type="button" onClick={onBack} disabled={verifying} className="btn btn-quiet btn-sm text-mute">
          Different email
        </button>
      </div>
    </div>
  );
}

function BackGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="m15 6-6 6 6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WalletGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18a1 1 0 0 1 1 1v2" />
      <rect x="4" y="7.5" width="16" height="11.5" rx="2.5" />
      <circle cx="16" cy="13.25" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function KeyGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="8" cy="15" r="4" stroke="currentColor" strokeWidth="1.7" />
      <path d="m11 12 8.5-8.5M16.5 6.5 19 9M14 9l2 2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Google's "G", in its own colours, as Google's sign-in branding asks. */
function GoogleGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function ShieldGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3.5 5 6.2v5.3c0 4.3 2.9 7.7 7 9 4.1-1.3 7-4.7 7-9V6.2L12 3.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}
