"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { requestLinkFromShort } from "@/lib/paymentRequest";

/**
 * gloam.trade/r#<request>: a short payment request link. The request is read
 * here, in the browser, and the Pay screen opens with it filled in, the same
 * as the long link (lib/paymentRequest). Nothing about it reaches a server.
 */
export default function ShortRequestPage() {
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    const open = () => {
      const body = window.location.hash.replace(/^#/, "");
      const to = body ? requestLinkFromShort(body, window.location.origin) : null;
      if (to) window.location.replace(to);
      else setBroken(true);
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);

  return (
    <div className="flex min-h-[100svh] flex-col items-center justify-center bg-surface px-5 text-foreground">
      <div className="w-full max-w-[480px] rounded-[24px] bg-panel p-7 shadow-card">
        {broken ? (
          <>
            <p className="t-eyebrow">Payment request</p>
            <h1 className="mt-3 text-[28px] font-light leading-[1.1] tracking-[-0.02em]">This link lost part of the request</h1>
            <p className="mt-4 text-[15px] leading-relaxed text-soft">
              Some chat apps cut links short. Ask the person who sent it to send the link again.
            </p>
            <Link href="/app/vault?tab=move&mode=pay" className="btn btn-ink btn-lg btn-block mt-6">
              Open Gloam
            </Link>
          </>
        ) : (
          <>
            <div className="h-4 w-40 animate-pulse rounded bg-surface" />
            <p className="mt-4 text-[15px] text-soft">Opening the payment request…</p>
          </>
        )}
      </div>
    </div>
  );
}
