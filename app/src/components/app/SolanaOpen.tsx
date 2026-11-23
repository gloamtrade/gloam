"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useNetwork } from "./NetworkProvider";

/**
 * The old Solana page's address (/app/solana, in the banner, the docs and
 * shared links): picks Solana in the network menu and opens the Vault there,
 * where Solana is a network like the others.
 */
export function SolanaOpen() {
  const { settled, selectSolana } = useNetwork();
  const router = useRouter();
  useEffect(() => {
    if (!settled) return;
    selectSolana();
    router.replace("/app/vault");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when this browser's network is read
  }, [settled]);
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Opening Solana">
      <div className="gl-card h-[260px] motion-safe:animate-pulse" />
      <div className="gl-card h-[190px] motion-safe:animate-pulse" />
    </div>
  );
}
