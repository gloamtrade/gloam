/**
 * The leaf the Gloam MCP server sends VEYA for one payment. A receipt hashes into
 * one bytes32 (paymentReceiptLeaf in @gloamtrade/sdk), and with
 * GLOAM_VEYA_ANCHOR_URL set the server posts that leaf and the agent id. VEYA
 * writes the leaf to storeCommitment on Veya.sol, so no anchoring wallet is
 * needed. The amount and the payee are not in the leaf.
 *
 *   # a sample record: no keys, no network, nothing sent
 *   npx tsx examples/veya-receipt/veya-receipt.ts
 *
 *   # a record of your own, from buildPaymentReceipt (see examples/san-verano)
 *   npx tsx examples/veya-receipt/veya-receipt.ts record.json
 *
 * This script only shows what would go out. The MCP server does the sending.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RH_MAINNET_CHAIN_ID, RH_MAINNET_USDG, mainnetNetwork, paymentReceiptLeaf, verifyPaymentReceiptLeaf, type ReceiptLeafFields } from "@gloamtrade/sdk";

/** Everything VEYA gets for a receipt. Never the record, the proof, the amount, the payee, a note or the transaction hash. */
export function anchorBody(record: ReceiptLeafFields, agentId: string): { leaf: string; agent_id: string } {
  return { leaf: paymentReceiptLeaf(record), agent_id: agentId };
}

/** Not a real payment: the shape of a receipt's leaf fields, so there is something to hash. */
const SAMPLE: ReceiptLeafFields = {
  chainId: RH_MAINNET_CHAIN_ID,
  pool: mainnetNetwork("robinhood")!.pool,
  txHash: `0x${"ab".repeat(32)}`,
  // root, commitment, asset, minAmount, reveal, shownAmount, context
  publicSignals: ["1", "2", BigInt(RH_MAINNET_USDG).toString(), "1000000", "0", "0", "3"],
};

function main() {
  const path = process.argv[2];
  let record = SAMPLE;
  if (path) {
    const read = JSON.parse(readFileSync(path, "utf8")) as ReceiptLeafFields & { leaf?: string };
    // A record says what its leaf is. One that does not recompute is not worth sending.
    if (read.leaf && !verifyPaymentReceiptLeaf(read.leaf, read)) throw new Error(`The leaf in ${path} does not match its record.`);
    record = read;
  }
  console.log(path ? `Record: ${path}` : "A sample record, not a real payment.");
  console.log(`POST <GLOAM_VEYA_ANCHOR_URL> ${JSON.stringify(anchorBody(record, process.env.GLOAM_VEYA_AGENT_ID?.trim() || "your-agent-id"))}`);
  console.log("Shown only: nothing was sent.");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
