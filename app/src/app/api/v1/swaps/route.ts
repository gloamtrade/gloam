import { withApiKey } from "@/lib/partnersApi";
import { SWAP_PUBLIC_LINE, swapNetworksView } from "@/lib/swapQuote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Private swaps on every network: whether they are live, the router new swaps use,
 * what it swaps between, and the earlier routers kept for refunds. Read only.
 */
export async function GET(req: Request) {
  return withApiKey(req, async () => ({ data: { networks: swapNetworksView(), public: SWAP_PUBLIC_LINE } }));
}
