"use client";

// gloam.trade/c#<code>: the same claim page as /claim, which reads both forms.
// A Starknet claim link (#sn=...) has its own page (components/app/StarknetClaimLanding).
import { useSyncExternalStore } from "react";
import ClaimPage from "../claim/page";
import { StarknetClaimLanding } from "@/components/app/StarknetClaimLanding";
import { isStarknetClaimHash } from "@/lib/starknetPrivacy/claimLink";

const onHash = (f: () => void) => {
  window.addEventListener("hashchange", f);
  return () => window.removeEventListener("hashchange", f);
};

export default function ShortClaimPage() {
  const starknet = useSyncExternalStore(onHash, () => isStarknetClaimHash(window.location.hash), () => false);
  return starknet ? <StarknetClaimLanding /> : <ClaimPage />;
}
