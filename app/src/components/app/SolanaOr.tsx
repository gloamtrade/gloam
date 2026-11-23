"use client";

import type { ReactNode } from "react";
import { useNetwork } from "./NetworkProvider";

/**
 * A page's Solana side while Solana is the network picked (NetworkProvider
 * `solana`), its EVM side otherwise. Only the one shown is mounted, so the EVM
 * views never run against Solana and the Solana ones never load for EVM.
 */
export function SolanaOr({ solana, children }: { solana: ReactNode; children: ReactNode }) {
  const { solana: on } = useNetwork();
  return <>{on ? solana : children}</>;
}
