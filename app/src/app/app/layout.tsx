import type { Metadata } from "next";
import { preconnect } from "react-dom";
import { Web3Provider } from "@/components/app/Web3Provider";
import { AppThemeScope } from "@/components/app/AppThemeScope";
import { liveMainnetNames } from "@/lib/mainnet";

export const metadata: Metadata = {
  title: {
    default: "App",
    template: "%s · Gloam",
  },
  description: `The Gloam app: a private balance, private payments, payroll and proofs on ${liveMainnetNames()} mainnet, and on the testnets.`,
};

export default function ProductLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The app reads these chains on every load: open the connections early. Only
  // here, not in the root layout: the site and the docs never call an RPC, so
  // on those pages the two connections were opened for nothing.
  preconnect("https://rpc.mainnet.chain.robinhood.com", { crossOrigin: "anonymous" });
  preconnect("https://rpc.tempo.xyz", { crossOrigin: "anonymous" });
  // Gloam wallets (the Turnkey kit) are not wrapped around the app: the kit is a
  // large download, so it starts inside Web3Provider only for someone signed in or
  // asking to sign in (TurnkeyKitGate), and the pages never wait for it.
  return (
    <>
      <AppThemeScope />
      <Web3Provider>{children}</Web3Provider>
    </>
  );
}
