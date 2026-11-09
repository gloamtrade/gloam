import { jsonBody, withApiKey } from "@/lib/partnersApi";
import { MAX_PROOF_TEXT } from "@/lib/proofsServer";
import { countProofCheck, verifyProofText } from "../../_lib/verify";

/** The proof text plus a little JSON around it. */
const MAX_BODY_BYTES = MAX_PROOF_TEXT + 1_024;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Check a Gloam proof on the server: { proof: "gloamfunds1:..." | "gloampay1:..." |
 * "gloamroll1:..." | "gloambal1:..." | "gloamdisc1:..." }. Returns ok plus every
 * check the /verify page shows, in order. ok is false for an expired proof, a
 * check that could not finish, and any gloamdisc1 (anyone can copy one from a
 * public deposit). The body is capped before it is parsed; per-key rate limits
 * come from withApiKey, and proof checks have their own per-key count.
 */
export async function POST(req: Request) {
  return withApiKey(req, async ({ key }) => {
    const body = await jsonBody(req, MAX_BODY_BYTES);
    await countProofCheck(key.id);
    return { data: await verifyProofText(body.proof) };
  });
}
