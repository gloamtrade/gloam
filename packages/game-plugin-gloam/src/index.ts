import GloamPlugin from "./gloamPlugin.js";

export { GloamPlugin };
export type { IGloamPluginOptions } from "./gloamPlugin.js";
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
export { shutdownProver } from "./artifacts.js";
export { redact, registerSecret, registerUrlSecret, safeErrorMessage } from "./redact.js";

export default GloamPlugin;
