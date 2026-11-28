import "server-only";

/**
 * A local starknet-devnet's prover: the SDK's mock (the pool's own compile step
 * runs against the devnet, the screening attestation is signed with the SDK's
 * test screener key, and devnet, run with --proof-mode none, takes a
 * placeholder proof). Devnet only: it proves nothing, so /api/starknet/prove
 * calls it only while NEXT_PUBLIC_STARKNET_NETWORK is devnet. The SDK's
 * testing entry is loaded at run time and never bundled.
 */
import { STARKNET_NETWORK } from "./config";

/** A placeholder proof: devnet (--proof-mode none) checks none, and the SDK's client needs one. */
const PLACEHOLDER_PROOF = "AA==";

type MockProof = { output: string[]; proofFacts: string[]; additionalData?: { signature?: { issued_at: number; sig_r: string; sig_s: string } } };

export async function devnetMockProve(nodeUrl: string, chainId: string, blockId: unknown, transaction: unknown) {
  if (STARKNET_NETWORK !== "devnet") throw new Error("The mock prover runs only on a local devnet.");
  const spec = "@starkware-libs/starknet-privacy-sdk/testing";
  const [{ ScreeningCallMockProofProvider }, { RpcProvider }] = await Promise.all([
    import(/* webpackIgnore: true */ spec) as Promise<typeof import("@starkware-libs/starknet-privacy-sdk/testing")>,
    import("starknet"),
  ]);
  const node = new RpcProvider({ nodeUrl, batch: 0 });
  const prover = new ScreeningCallMockProofProvider(node as never, chainId as never);
  const tx = transaction as { sender_address: string };
  const block = blockId && typeof blockId === "object" && "block_number" in (blockId as object) ? Number((blockId as { block_number: number }).block_number) : undefined;
  const proof = (await prover.prove(transaction as never, block as never)) as unknown as MockProof;
  return {
    proof: PLACEHOLDER_PROOF,
    proof_facts: proof.proofFacts.map((f) => (typeof f === "string" ? f : `0x${BigInt(f).toString(16)}`)),
    l2_to_l1_messages: [{ from_address: tx.sender_address, to_address: "0x0", payload: proof.output.map((x) => (typeof x === "string" ? x : `0x${BigInt(x).toString(16)}`)) }],
    ...(proof.additionalData?.signature ? { additional_data: { signature: proof.additionalData.signature } } : {}),
  };
}
