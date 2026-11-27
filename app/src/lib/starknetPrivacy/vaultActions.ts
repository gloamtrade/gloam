/**
 * The Vault's actions on Starknet (components/app/StarknetVault, the app nav's
 * Vault list and the Vault's action row): Add privately, Pay privately,
 * Receive and Cash out, in the EVM order and at the same links, each with a
 * line true to what shows on Starknet (lib/starknetPrivacy/config). Swap,
 * Agent top-ups, Trade and Public send are not on Starknet yet.
 */
import { VAULT_ACTIONS, type VaultActionId, type VaultActionInfo } from "@/lib/vaultHub";

const LINES: Partial<Record<VaultActionId, string>> = {
  shield: "Move USDC on your Starknet account into your private balance.",
  pay: "Pay another private account on Starknet. Who and how much stay hidden.",
  receive: "Share your private account, or ask to be paid.",
  cashout: "Back to any Starknet address. The cash out shows on the explorer.",
};

export const STARKNET_VAULT_ACTIONS: readonly VaultActionInfo[] = VAULT_ACTIONS.filter((a) => a.id in LINES).map((a) => ({
  ...a,
  line: LINES[a.id]!,
}));

/** A Vault tab Starknet doesn't have, by name, for "… is not on Starknet yet"; null for any other. */
export function missingOnStarknet(tab: string | null): string | null {
  if (tab === "swap") return "Swap";
  if (tab === "topups") return "Agent top-ups";
  if (tab === "trade") return "Trade";
  if (tab === "send") return "Public send";
  return null;
}

/** The one plain line of what Starknet shows, said once on its screens. */
export const STARKNET_PRIVACY_NOTE =
  "On Starknet, a payment hides who paid, who was paid and how much. The first payment to someone shows their private account. Adding shows your account and the amount; a cash out shows where it went and how much.";
