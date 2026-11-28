/**
 * Proofs from the chains outside Gloam's own vault, recognised by their prefix
 * and checked by their own rules (lib/proofs/solanaPayment, lib/proofs/starknetChannel).
 * The EVM proofs (lib/proofs) are untouched by these. Light on purpose: the
 * verify page imports this for every visitor, and the Solana and Starknet
 * code (starknet.js, the Rings SDK) loads only for a proof of theirs.
 */
import type { ChainCheck, SolanaPaymentProof } from "./solanaPayment";
import type { ChannelPayment, StarknetChannelProof } from "./starknetChannel";

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

/** The text prefixes (SOLANA_PAYMENT_PREFIX, STARKNET_CHANNEL_PREFIX), kept here so this file stays light. */
const SOLANA = "gloamsolpay1:";
const STARKNET = "gloamsnpay1:";

export function isChainProofText(text: string): boolean {
  const t = text.trim();
  return t.startsWith(SOLANA) || t.startsWith(STARKNET);
}

export async function decodeChainProof(text: string): Promise<ChainProof> {
  const t = text.trim();
  if (t.startsWith(SOLANA)) return (await import("./solanaPayment")).decodeSolanaPayment(t);
  if (t.startsWith(STARKNET)) return (await import("./starknetChannel")).decodeStarknetChannel(t);
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
