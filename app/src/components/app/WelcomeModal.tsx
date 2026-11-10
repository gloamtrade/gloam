"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Mark } from "@/components/Logo";
import { SealedField } from "@/components/ui/SealedField";
import { useModalFocus } from "@/hooks/useModalFocus";
import { readDemo } from "@/lib/demoFlag";
import { liveMainnetNames } from "@/lib/mainnet";

/** The key the welcome is dismissed under (the mainnet welcome's; the older testnet one is no longer read). */
const SHOWN_KEY = "gloam_mainnet_welcome_v1";

/**
 * Shown once, before the app's JavaScript arrives: the modal is in the server
 * HTML with `hidden`, and the tiny script after it unhides it when this browser
 * has not dismissed it yet. On a slow phone the welcome appears with the first
 * paint instead of seconds later, after the wallet code loads. Once React takes
 * over, state drives it as before (and recording demos keep it shut).
 */
const REVEAL_SCRIPT = `(function(){try{if(localStorage.getItem('${SHOWN_KEY}')==='1')return;if(/[?&]demo=1/.test(location.search)||sessionStorage.getItem('gloam_demo')==='1')return;var el=document.getElementById('gl-welcome');if(el)el.hidden=false}catch(e){}})()`;

export function WelcomeModal() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let show = true;
    try {
      if (localStorage.getItem(SHOWN_KEY) === "1" || readDemo()) show = false;
    } catch {
      /* storage unavailable: show it */
    }
    // The head start may have unhidden it; React's own state takes over here.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- takes over from the head-start script: whether to show depends on this browser's storage, read once after mount
    if (show) setOpen(true);
    else if (ref.current) ref.current.hidden = true;
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(SHOWN_KEY, "1");
    } catch {
      /* ignore */
    }
    setOpen(false);
  }

  // Focus starts on Enter the app and stays in the welcome; Escape closes it.
  const enter = useRef<HTMLButtonElement>(null);
  useModalFocus(ref, dismiss, { initial: enter, open });

  return (
    <>
    <div
      ref={ref}
      id="gl-welcome"
      hidden={!open}
      suppressHydrationWarning
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        aria-label="Dismiss welcome"
        onClick={dismiss}
      />
      <div className="relative z-[1] max-h-[min(90dvh,720px)] w-full max-w-[440px] overflow-y-auto rounded-[24px] border border-line bg-panel shadow-pop">
        <div className="relative overflow-hidden border-b border-line px-7 pb-6 pt-7">
          <SealedField tone="soft" />
          <div className="relative z-[1]">
            <div className="mb-6 max-sm:hidden">
              <Mark size={32} />
            </div>
            <p className="t-eyebrow">Gloam mainnet</p>
            <h2 id="welcome-title" className="t-display-m mt-2 text-foreground">
              Welcome to Gloam
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-mute">
              Private money on {liveMainnetNames()} mainnet.
              The testnet stays open for trying things first.
            </p>
          </div>
        </div>

        <div className="px-7 pt-5">
          <p className="text-[15px] text-foreground">Quick start</p>
          <ol className="mt-2">
            {[
              <>Connect a wallet and pick a network. The menu marks each one Mainnet or Testnet.</>,
              <>
                On testnet, claim test funds if you need them. The{" "}
                <Link
                  href="/docs/testnet"
                  className="font-medium text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground"
                  onClick={dismiss}
                >
                  testnet guide
                </Link>{" "}
                shows how.
              </>,
              <>
                <span className="font-medium text-foreground">Add money</span>{" "}
                to your private balance, pay or send it, then cash out when you
                want it public.
              </>,
            ].map((body, i) => (
              <li
                key={i}
                className="flex gap-3.5 border-t border-line py-3 text-[14px] leading-relaxed text-soft first:border-t-0"
              >
                <span
                  aria-hidden
                  className="tnum mt-px grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface text-[12px] font-medium text-foreground"
                >
                  {i + 1}
                </span>
                <span>{body}</span>
              </li>
            ))}
          </ol>
          <p className="mt-2 flex gap-3 rounded-[14px] bg-surface px-4 py-3 text-[12.5px] leading-relaxed text-mute">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden
              className="mt-0.5 shrink-0 text-sealed"
            >
              <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
              <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.7" />
            </svg>
            Your private balance lives in this browser. Save a backup in
            Settings before you clear your data.
          </p>
        </div>

        <div className="flex flex-wrap gap-2 px-7 pb-7 pt-5">
          <button
            ref={enter}
            type="button"
            onClick={dismiss}
            className="btn btn-ink h-[44px] flex-1 px-[20px] sm:h-12 sm:px-6 sm:text-[15px]"
          >
            Enter the app
          </button>
          <Link
            href="/docs/testnet"
            onClick={dismiss}
            className="btn btn-quiet h-[44px] px-[20px] sm:h-12 sm:px-6 sm:text-[15px]"
          >
            Testnet guide
          </Link>
        </div>
      </div>
    </div>
    <script dangerouslySetInnerHTML={{ __html: REVEAL_SCRIPT }} />
    </>
  );
}
