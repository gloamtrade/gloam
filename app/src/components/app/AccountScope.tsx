"use client";

/**
 * Binds this page to the signed-in account's own private account (lib/accountScope),
 * and asks, once, whether the browser's private account from before is theirs when
 * nothing else can tell. Lives inside WagmiProvider, on every app page.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useAccount } from "wagmi";
import { useModalFocus } from "@/hooks/useModalFocus";
import {
  accountScopeServerState,
  accountScopeState,
  answerFirstAccount,
  signInAs,
  subscribeAccountScope,
  type ScopeState,
} from "@/lib/accountScope";
import { DEMO_ADDRESS, useDemo } from "@/lib/demo";

/** Where this page is with the signed-in account's private account. */
export function useAccountScope(): ScopeState {
  return useSyncExternalStore(subscribeAccountScope, accountScopeState, accountScopeServerState);
}

/**
 * The account whose private data a view may read and show: the signed-in
 * address once its own account is bound, else null. Put it in the deps of an
 * effect that reads a private store, so it reads again once the account is bound.
 */
export function useShownAccount(): string | null {
  const s = useAccountScope();
  return s.phase === "ready" ? s.account : null;
}

const noSubscribe = () => () => {};

/** "gloamr1…" and the last 8 characters: the start of every Gloam address is the same. */
function tagEnd(tag: string): string {
  return `gloamr1…${tag.trim().slice(-8)}`;
}

function Question({ scope }: { scope: ScopeState }) {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  // No way to close it but an answer (or signing out): the answer decides whose account this is.
  useModalFocus(dialog, () => undefined, { initial: first });
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const answer = (mine: boolean) => {
    setBusy(true);
    void answerFirstAccount(mine).finally(() => setBusy(false));
  };

  return createPortal(
    <div
      ref={dialog}
      tabIndex={-1}
      className="fixed inset-0 z-[210] flex items-center justify-center p-[16px] outline-none sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-question-title"
      aria-describedby="account-question-body"
    >
      <div aria-hidden className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative z-[1] w-full max-w-[420px] rounded-[24px] bg-panel px-6 pb-6 pt-7 shadow-pop sm:px-8 sm:pb-8">
        <h2 id="account-question-title" className="text-balance text-[22px] font-light leading-[1.2] tracking-[-0.012em] text-foreground">
          {sure ? "Use a new private account?" : "Is this private account yours?"}
        </h2>
        <div id="account-question-body" className="mt-3 space-y-2 text-[14px] leading-relaxed text-mute">
          {sure ? (
            <p>You get a new, empty private account here. The other one stays in this browser for its owner. Nothing is deleted.</p>
          ) : (
            <>
              <p>This browser holds a private account from before each sign-in got its own.</p>
              {scope.tag && (
                <p>
                  Its Gloam address ends <span className="tnum whitespace-nowrap text-foreground">{tagEnd(scope.tag)}</span>.
                </p>
              )}
              <p>Choose yes only if it&apos;s yours.</p>
            </>
          )}
        </div>
        {scope.error && (
          <p className="mt-3 text-[13px] text-danger" role="alert">
            {scope.error}
          </p>
        )}
        <div className="mt-6 flex gap-2 max-sm:flex-col">
          {sure ? (
            <>
              <button ref={first} type="button" disabled={busy} onClick={() => answer(false)} className="btn btn-ink sm:flex-1">
                Use a new account
              </button>
              <button type="button" disabled={busy} onClick={() => setSure(false)} className="btn btn-ghost sm:flex-1">
                Back
              </button>
            </>
          ) : (
            <>
              <button ref={first} type="button" disabled={busy} onClick={() => answer(true)} className="btn btn-ink sm:flex-1">
                Yes, it&apos;s mine
              </button>
              <button type="button" disabled={busy} onClick={() => setSure(true)} className="btn btn-ghost sm:flex-1">
                No, it&apos;s not mine
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Follows the signed-in address and binds its own private account. Draws only the question. */
export function AccountScope() {
  const { address, status } = useAccount();
  const demo = useDemo();
  const scope = useAccountScope();
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false);

  useEffect(() => {
    // The recording demo's pretend wallet has keys of its own and never takes the browser's account.
    if (demo) void signInAs(DEMO_ADDRESS, { demo });
    else if (status === "connected") void signInAs(address ?? null);
    else if (status === "disconnected") void signInAs(null);
    // connecting or reconnecting: wait for the wallet to settle, so a restore in progress never binds or reloads
  }, [address, status, demo]);

  if (!mounted) return null;
  if (scope.phase === "asking") return <Question key={scope.account ?? ""} scope={scope} />;
  // The private account couldn't be opened (storage refused, or reloads kept coming): say so, nothing else shows meanwhile.
  if ((scope.phase === "checking" || scope.phase === "leaving") && scope.error) {
    return createPortal(
      <div role="alert" className="fixed inset-x-0 bottom-0 z-[210] flex justify-center p-[16px]">
        <div className="flex max-w-[420px] items-center gap-3 rounded-[16px] bg-panel px-4 py-3 text-[13px] text-foreground shadow-pop">
          <p className="flex-1">{scope.error}</p>
          <button type="button" onClick={() => window.location.reload()} className="btn btn-ghost btn-sm">
            Reload
          </button>
        </div>
      </div>,
      document.body
    );
  }
  return null;
}
