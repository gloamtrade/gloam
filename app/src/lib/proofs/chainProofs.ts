/**
 * Proofs from the chains outside Gloam's own vault, recognised by their prefix
 * and checked by their own rules (lib/proofs/solanaPayment, lib/proofs/starknetChannel).
 * The EVM proofs (lib/proofs) are untouched by these.
 */
import { decodeSolanaPayment, isSolanaPaymentText, type ChainCheck, type SolanaPaymentProof } from "./solanaPayment";
import { decodeStarknetChannel, isStarknetChannelText, type ChannelPayment, type StarknetChannelProof } from "./starknetChannel";

export type ChainProof = SolanaPaymentProof | StarknetChannelProof;

export type ChainProofResult = {
  ok: boolean;
  checks: ChainCheck[];
  expired: boolean;
  /** Solana: when the payment landed, and who paid when the transaction names it. */
  paidAt?: number;
  from?: string;
  /** Starknet: every payment in the channel, and notes funded from outside the pool. */
  payments?: ChannelPayment[];
  outside?: number;
};

export function isChainProofText(text: string): boolean {
  return isSolanaPaymentText(text) || isStarknetChannelText(text);
}

export function decodeChainProof(text: string): ChainProof {
  if (isSolanaPaymentText(text)) return decodeSolanaPayment(text);
  if (isStarknetChannelText(text)) return decodeStarknetChannel(text);
  throw new Error("Not a Gloam proof.");
}

/** Every check in this browser, through Gloam's read-only proxies for the network this site runs. */
export async function verifyChainProof(p: ChainProof): Promise<ChainProofResult> {
  if (p.kind === "solana-payment") {
    const { verifySolanaPaymentHere } = await import("./solanaPaymentClient");
    return verifySolanaPaymentHere(p);
  }
  const { verifyStarknetChannelHere } = await import("./starknetChannelClient");
  return verifyStarknetChannelHere(p);
}
