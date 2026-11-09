/**
 * The five-minute check: list the tools, read the balance, and preview a
 * deposit. Nothing moves unless GLOAM_EXECUTE=1.
 *
 *   GLOAM_NETWORK=robinhood-mainnet GLOAM_AGENT_PRIVATE_KEY=0x... pnpm example
 *
 * Optional: GLOAM_AMOUNT (default 1), GLOAM_ASSET (default the network's first,
 * USDG on Robinhood Chain), GLOAM_NOTE_KEY, GLOAM_API_KEY (a partner key).
 */
import { createGloamToolPack } from "./index.js";

const pack = createGloamToolPack({
  // The owner's limits: each asset its own caps. Without limits nothing moves.
  limits: {
    recipients: "any",
    assets: { USDG: { maxPerPayment: "25", maxPerDay: "100" } },
  },
  // A kit with its own approval screen sees every call before the wallet signs it.
  onSign: (calls, ctx) => {
    console.log(`about to sign for ${ctx.action}:`, calls.map((c) => `${c.fn} on ${c.to}`).join(", "));
    return true;
  },
});

console.log("tools:", pack.definitions.map((d) => `${d.name} (${d.kind})`).join(", "));
console.log(JSON.stringify(await pack.call("gloam_balance", {}), null, 2));

const preview = await pack.call("gloam_preview_shield", { amount: process.env.GLOAM_AMOUNT ?? "1", asset: process.env.GLOAM_ASSET });
console.log(JSON.stringify(preview, null, 2));

if (process.env.GLOAM_EXECUTE === "1" && preview.status === "preview") {
  console.log(JSON.stringify(await pack.call("gloam_execute", { previewId: preview.previewId, digest: preview.digest }), null, 2));
}
