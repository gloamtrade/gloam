"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { BNB_ENABLED } from "@/lib/bnb";
import { SOLANA_NAME, SOLANA_RINGS_ENABLED } from "@/lib/solanaRings/config";
import { SolanaMark } from "./SolanaMark";

/** Which note shows: Solana once it is on (NEXT_PUBLIC_SOLANA_RINGS_ENABLED), else BNB Chain while that is on. */
const NOTE: "solana" | "bnb" | null = SOLANA_RINGS_ENABLED ? "solana" : BNB_ENABLED ? "bnb" : null;

// Its own key per note, so someone who closed the BNB Chain note still hears about Solana.
const KEY = NOTE === "solana" ? "gloam:announce-dismissed:solana-live-v1" : "gloam:announce-dismissed:bnb-live-v1";

// Keep the note on marketing + docs; stay out of the working app (it has its own notices).
const HIDDEN_ON = ["/app", "/admin", "/verify", "/pitch", "/claim", "/mainnet", "/status"];

const DISMISSED_EVENT = "gloam-announce-dismissed";

function subscribeDismissed(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(DISMISSED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(DISMISSED_EVENT, onChange);
  };
}

function dismissedSnapshot(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

const linkClass =
  "gl-tap shrink-0 text-[13px] font-medium text-white underline decoration-white/40 underline-offset-4 transition-colors hover:decoration-white";

/**
 * Slim site-wide note: Gloam is live on Solana while Solana is on
 * (SOLANA_RINGS_ENABLED), else on BNB Chain while that is on (BNB_ENABLED).
 * Dismissible per browser.
 */
export function AnnouncementBanner() {
  const pathname = usePathname();
  // The server can't see what this browser closed, so it renders the note.
  const stored = useSyncExternalStore(subscribeDismissed, dismissedSnapshot, () => false);
  // Closed here, for when storage refuses the write.
  const [closed, setClosed] = useState(false);

  if (!NOTE || closed || stored) return null;
  if (HIDDEN_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, "1");
      window.dispatchEvent(new Event(DISMISSED_EVENT));
    } catch {
      /* ignore */
    }
    setClosed(true);
  };

  return (
    <div data-announcement="" className="relative z-[60] w-full border-b border-transparent bg-[#0b0c0e] text-white dark:border-line dark:bg-[#111214]">
      <div className="mx-auto flex max-w-[1400px] items-center justify-center gap-3 py-2 pl-4 pr-12 sm:px-14">
        {NOTE === "solana" ? (
          <>
            <SolanaMark size={16} className="shrink-0" />
            <p className="min-w-0 truncate text-[13px] leading-tight">
              <span className="font-medium">Gloam is live on {SOLANA_NAME}.</span>{" "}
              {/* the token and the amount only: the two private accounts a payment moves between are visible */}
              <span className="text-white/60 max-sm:hidden">Private payments. The token and the amount stay hidden.</span>
            </p>
            <a href="/app/solana" className={linkClass}>
              Open Solana
            </a>
          </>
        ) : (
          <>
            <Image src="/brand/chains/56.png" alt="" width={16} height={16} className="shrink-0 rounded-full" />
            <p className="min-w-0 truncate text-[13px] leading-tight">
              <span className="font-medium">Gloam is live on BNB Chain.</span>{" "}
              <span className="text-white/60 max-sm:hidden">Private USDT and USDC payments.</span>
            </p>
            <a href="/app" className={linkClass}>
              Open the app
            </a>
          </>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss announcement"
          className="gl-tap absolute right-2 grid h-8 w-8 place-items-center rounded-full text-white/45 transition-colors hover:bg-white/10 hover:text-white sm:right-4"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path
              d="M2.5 2.5l7 7M9.5 2.5l-7 7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
