/**
 * The nullifier of a claim link's note, for the treasure hunt's "claimed yet?"
 * check (lib/huntPrize). Used by scripts/hunt-nullifier.mts on the founder's
 * own machine. Reads both link forms: the short gloam.trade/c#<body> (also with
 * the "#" written "%23", and the body alone) and the long #claim=gloam1=...
 */
import type { Hex } from "viem";
import { SHORT_CLAIM_PREFIX } from "@gloamtrade/sdk";
import { codeFromHash } from "@/lib/claimLink";
import { decodeNotePackage } from "@/lib/notePackage";
import { paymentNullifier } from "@/lib/sentLinks";

/** The nullifier of the note in a claim link (or a bare gloam1 code). Throws when it can't be read. */
export async function nullifierOfClaimLink(link: string): Promise<Hex> {
  const t = link.trim();
  const at = t.indexOf("#claim=");
  // a long link's code; a short link's body on its own; else a short link or a gloam1/gloam3 code as pasted
  const code = at >= 0 ? codeFromHash(t.slice(at)) : /^[0-9A-Za-z]{20,}$/.test(t) ? SHORT_CLAIM_PREFIX + t : t;
  if (!code) throw new Error("No claim code in that link.");
  const pack = await decodeNotePackage(code);
  return paymentNullifier(pack.secret, pack.commitment);
}
