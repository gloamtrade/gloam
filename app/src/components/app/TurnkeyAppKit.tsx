"use client";

import TurnkeyKitProvider from "./TurnkeyKit";
import EmbeddedWalletFlow from "./EmbeddedWalletFlow";
import { TurnkeySolanaSync } from "./TurnkeySolanaSync";
import { TurnkeyPasskeysSync } from "./TurnkeyPasskeysSync";
import { SOLANA_RINGS_ENABLED } from "@/lib/solanaRings/config";
import { STARKNET_ENABLED } from "@/lib/starknetPrivacy/config";

/**
 * Everything in the app that runs on the Turnkey kit, in one download: the kit's
 * provider with the sign-in sheet and the wallet sync it carries (TurnkeyKit), and
 * the create-a-wallet sheet, while Solana is on, the wallet's Solana account
 * (TurnkeySolanaSync), and while Starknet is on, the wallet's passkey ids, which
 * open its private account there (TurnkeyPasskeysSync). TurnkeyKitGate loads it only when it is needed. It
 * sits beside the app's pages, not around them: the pages read the kit's state
 * from lib/turnkeyBridge, so they never wait for it.
 */
export default function TurnkeyAppKit() {
  return (
    <TurnkeyKitProvider>
      <EmbeddedWalletFlow />
      {SOLANA_RINGS_ENABLED && <TurnkeySolanaSync />}
      {STARKNET_ENABLED && <TurnkeyPasskeysSync />}
    </TurnkeyKitProvider>
  );
}
