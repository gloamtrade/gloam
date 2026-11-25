"use client";

import type { ReactNode } from "react";
import { useNetwork } from "./NetworkProvider";

/**
 * A page's Solana side while Solana is the network picked (NetworkProvider
 * `solana`), its Starknet side while Starknet is (`starknet`, when the page
 * has one), its EVM side otherwise. Only the one shown is mounted, so the EVM
 * views never run against Solana or Starknet and theirs never load for EVM.
 */
export function SolanaOr({ solana, starknet, children }: { solana: ReactNode; starknet?: ReactNode; children: ReactNode }) {
  const { solana: onSolana, starknet: onStarknet } = useNetwork();
  if (onSolana) return <>{solana}</>;
  if (onStarknet && starknet !== undefined) return <>{starknet}</>;
  return <>{children}</>;
}
