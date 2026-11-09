/**
 * The engine without the GAME framework: GloamAgent and what it is built from.
 *
 * `@gloamtrade/game-plugin-gloam/engine` loads no GAME code, so an agent kit, an
 * MCP add-on or a cron job can run the same private balance, payments, cash outs
 * and proofs the GAME worker does. The package root adds GloamPlugin on top.
 */
export { GloamAgent, outcomeHoldsSecret, type ClaimLinkOut, type GloamAgentOptions, type Outcome } from "./agent.js";
export { walletCallSender, acpCallSender, NotSentError, isNotSent, type Call, type CallSender, type AcpEvmProviderLike } from "./sender.js";
export {
  CLAIM_LINK_RECIPIENT,
  SPEND_ACTIONS,
  checkSpend,
  loadLimits,
  resolveLimits,
  type LimitsConfig,
  type SpendAction,
  type SpendPolicy,
} from "./limits.js";
export { fileNoteBackend, type NoteStoreBackend } from "./noteStore.js";
export { claimLinkFor, readClaimLink, codeFromLinkText } from "./claimLinks.js";
export { decodeProof, encodeProof, verifyHolderProof, type FundsProof, type PaymentProof, type ProofReport } from "./proofs.js";
export { NETWORK_KEYS, resolveNetwork, type NetworkKey, type PluginNetwork } from "./networks.js";
export { Artifacts, shutdownProver, type ArtifactSource } from "./artifacts.js";
export { redact, registerSecret, registerUrlSecret, safeErrorMessage } from "./redact.js";
