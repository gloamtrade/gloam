/**
 * The nullifier of a claim link's note, for the treasure hunt's "claimed yet?"
 * check (lib/huntPrize). Used by scripts/hunt-nullifier.mts on the founder's
 * own machine; the app never sees the prize link.
 */
import type { Hex } from "viem";
import { codeFromHash } from "@/lib/claimLink";
import { decodeNotePackage } from "@/lib/notePackage";
import { paymentNullifier } from "@/lib/sentLinks";

/** The nullifier of the note in a claim link (or a bare gloam1 code). Throws when it can't be read. */
export async function nullifierOfClaimLink(link: string): Promise<Hex> {
  const t = link.trim();
  const at = t.indexOf("#claim=");
  const code = at >= 0 ? codeFromHash(t.slice(at)) : t;
  if (!code) throw new Error("No claim code in that link.");
  const pack = await decodeNotePackage(code);
  return paymentNullifier(pack.secret, pack.commitment);
}
