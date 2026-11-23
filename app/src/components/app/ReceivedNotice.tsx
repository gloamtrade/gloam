"use client";

/**
 * On every app page: payments to this account's Gloam address that just landed
 * in the balance on their own (lib/autoReceive). "Received 25 USDC", with the
 * payer's private note when there is one, and the network when it isn't the
 * one shown. It stays until closed or the page changes account.
 */
import { useEffect } from "react";
import { PAYMENTS_RECEIVED_EVENT, type ReceivedPayment } from "@/lib/autoReceive";
import { useAppAccount } from "@/lib/demo";
import { useWalletState } from "@/hooks/useWalletState";
import { useNetwork } from "./NetworkProvider";

const NONE: ReceivedPayment[] = [];

export function ReceivedNotice() {
  const { address } = useAppAccount();
  const { network, setNetworkKey } = useNetwork();
  // what landed is the connected wallet's: gone on sign out or a switch of account
  const [landed, setLanded] = useWalletState<ReceivedPayment[]>(address, NONE);

  useEffect(() => {
    const on = (e: Event) => {
      const more = (e as CustomEvent<ReceivedPayment[]>).detail;
      if (!Array.isArray(more) || more.length === 0) return;
      setLanded((was) => [...more, ...was].slice(0, 6));
    };
    window.addEventListener(PAYMENTS_RECEIVED_EVENT, on);
    return () => window.removeEventListener(PAYMENTS_RECEIVED_EVENT, on);
  }, [setLanded]);

  if (!address || landed.length === 0) return null;
  const first = landed[0]!;
  const elsewhere = landed.find((p) => p.networkKey !== network.key);
  const others = landed.length - 1;

  return (
    <div role="status" className="mb-4 flex items-start justify-between gap-3 rounded-[14px] bg-sealed-soft px-4 py-3 text-[13.5px] leading-relaxed text-on-tint">
      <div className="min-w-0">
        <p>
          <span className="font-medium">Received {first.label}</span>
          {first.networkKey !== network.key ? ` on ${first.network}` : ""}
          {others > 0 ? `, and ${others} more ${others === 1 ? "payment" : "payments"}` : ""}. It&apos;s in your private balance.
        </p>
        {first.note && <p className="mt-0.5 truncate text-soft">&ldquo;{first.note}&rdquo;</p>}
        {elsewhere && (
          <button
            type="button"
            className="mt-1 inline-flex min-h-10 items-center font-medium underline underline-offset-4"
            onClick={() => setNetworkKey(elsewhere.networkKey)}
          >
            Show {elsewhere.network}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="Close"
        className="-mr-1 grid h-10 w-10 shrink-0 place-items-center rounded-full text-on-tint hover:bg-panel/60"
        onClick={() => setLanded(NONE)}
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
