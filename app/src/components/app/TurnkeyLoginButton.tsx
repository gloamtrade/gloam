"use client";

import { AuthState, useTurnkey } from "@turnkey/react-wallet-kit";
import { openSignInSheet } from "@/lib/turnkeyBridge";

/**
 * Passkey / email sign-in entry for the embedded wallet: opens Gloam's sign-in sheet.
 * Only mount this inside TurnkeyEmbeddedProvider (i.e. when TURNKEY_ENABLED),
 * otherwise useTurnkey has no context.
 */
export function TurnkeyLoginButton() {
  const { authState, wallets } = useTurnkey();
  const signedIn = authState === AuthState.Authenticated;

  if (signedIn) {
    return (
      <div className="flex items-center gap-3 rounded-[16px] bg-surface px-4 py-3">
        <span
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-sealed-soft text-sealed"
          aria-hidden
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path
              d="m5.5 12.5 4 4 9-9"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-foreground">
            Signed in with passkey
          </p>
          <p className="mt-0.5 text-[12px] text-mute">
            {wallets.filter((w) => w.source === "embedded").length} embedded wallet{wallets.filter((w) => w.source === "embedded").length === 1 ? "" : "s"} ready
          </p>
        </div>
      </div>
    );
  }

  return (
    <button type="button" onClick={() => openSignInSheet()} className="btn btn-ink btn-lg btn-block">
      Sign in with passkey
    </button>
  );
}
