/**
 * Prints the nullifier of the treasure hunt's prize note, for HUNT_PRIZE_NULLIFIER
 * (lib/huntPrize). The nullifier lets the admin panel see when the prize is
 * claimed; it can't be used to claim it.
 *
 * Takes either link form (short gloam.trade/c#..., long ...#claim=gloam1=...),
 * the same text as HUNT_PRIZE_LINK. Reads it from standard input, so it never lands in shell history
 * or the process list, and sends nothing anywhere.
 *
 * Run from app/:  pbpaste | ../mcp/node_modules/.bin/tsx scripts/hunt-nullifier.mts
 */
import { nullifierOfClaimLink } from "../src/lib/huntNullifier";

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const link = Buffer.concat(chunks).toString("utf8").trim();
if (!link) {
  console.error("Paste the claim link on standard input, for example: pbpaste | tsx scripts/hunt-nullifier.mts");
  process.exit(1);
}
try {
  console.log(await nullifierOfClaimLink(link));
} catch (e) {
  console.error(e instanceof Error ? e.message : "That link could not be read.");
  process.exit(1);
}
