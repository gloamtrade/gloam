/**
 * The Vault's actions on Solana (components/app/SolanaVault, the app nav's
 * Vault list and the Vault's action row): Add privately, Pay privately,
 * Receive and Cash out, in the EVM order and at the same links, each with a
 * line true to what shows on Solana. Swap, Agent top-ups, Trade and Public
 * send are not on Solana yet.
 */
import { VAULT_ACTIONS, type VaultActionId, type VaultActionInfo } from "@/lib/vaultHub";
import { SOLANA_CLAIM_LINKS_ENABLED } from "./config";

const LINES: Partial<Record<VaultActionId, string>> = {
  shield: "Move money from your Solana wallet into your private balance.",
  pay: SOLANA_CLAIM_LINKS_ENABLED
    ? "Pay a Gloam private account, or anyone by claim link. The token and the amount stay hidden."
    : "Pay another Gloam private account. The token and the amount stay hidden.",
  receive: SOLANA_CLAIM_LINKS_ENABLED
    ? "Share your private address, claim a payment, or ask for one. The token and the amount stay hidden."
    : "Share your private address, or ask to be paid. The token and the amount stay hidden.",
  cashout: "Back to any Solana address. The cash out shows on the explorer.",
};

export const SOLANA_VAULT_ACTIONS: readonly VaultActionInfo[] = VAULT_ACTIONS.filter((a) => a.id in LINES).map((a) => ({
  ...a,
  line: LINES[a.id]!,
}));

/** A Vault tab Solana doesn't have, by name, for "… is not on Solana yet"; null for any other. */
export function missingOnSolana(tab: string | null): string | null {
  if (tab === "swap") return "Swap";
  if (tab === "topups") return "Agent top-ups";
  if (tab === "trade") return "Trade";
  if (tab === "send") return "Public send";
  return null;
}
