"use client";

import dynamic from "next/dynamic";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
import { EMBEDDED_WALLETS } from "@/lib/embeddedWallet";
import { TurnkeyAutoConnect } from "./TurnkeyAutoConnect";
import { TurnkeyKitGate } from "./TurnkeyKitGate";
import { NetworkProvider } from "./NetworkProvider";
import { CashOutProofRefresh } from "./CashOutProofRefresh";
import { ReconnectWatchdog } from "./ReconnectWatchdog";
import { PeopleCount } from "./PeopleCount";
import { RecoverySync } from "./RecoverySync";

// Brings the private balance back on a new device after sign-in. Loaded apart from the page.
const AutoRestore = dynamic(() => import("./AutoRestore"), { ssr: false });

export function Web3Provider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 8_000,
            refetchOnWindowFocus: false,
            // the RPC transport already retries; stacking three more turns a rate limit into a storm
            retry: 1,
          },
        },
      })
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ReconnectWatchdog />
        <NetworkProvider>
          {/* Gloam wallets: the Turnkey kit, its sign-in sheet and the create-a-wallet sheet load only when needed (TurnkeyKitGate) */}
          {EMBEDDED_WALLETS && (
            <>
              <TurnkeyAutoConnect />
              <TurnkeyKitGate />
            </>
          )}
          <CashOutProofRefresh />
          <RecoverySync />
          <AutoRestore />
          <PeopleCount />
          {children}
        </NetworkProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
