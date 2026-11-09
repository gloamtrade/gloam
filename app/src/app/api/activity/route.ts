import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { NETWORK_KEYS } from "@/lib/networks";
import { ELYSIUM } from "@/lib/elysium";

const EXPLORER_API = "https://explorer.testnet.chain.robinhood.com/api";
/** Robinhood Chain mainnet's explorer answers the same account API (checked 2026-10-20). */

/**
 * Which explorer to ask. No chainId: the testnet, as always. A mainnet Gloam
 * runs on: its own explorer, or null for Tempo, which has no account API (the
 * feed then shows nothing rather than another chain's history).
 */
function explorerFor(chainId: string | null): string | null | "bad" {
  if (chainId === null) return EXPLORER_API;
  // Robinhood Chain mainnet's explorer API sits behind a bot check a server
  // can't pass; the app reads that history straight from the chain instead
  // (lib/walletActivity), so this answers empty, as for Tempo.
  if (chainId === "4663" && NETWORK_KEYS.includes("robinhood-mainnet")) return null;
  if (chainId === "4217" && NETWORK_KEYS.includes("tempo-mainnet")) return null;
  // Base (Sepolia too) is read from the chain like a mainnet; Basescan's API needs a key.
  if (chainId === "8453" && NETWORK_KEYS.includes("base-mainnet")) return null;
  if (chainId === "84532" && NETWORK_KEYS.includes("base")) return null;
  // Ethereum too: Etherscan's API needs a key.
  if (chainId === "1" && NETWORK_KEYS.includes("ethereum-mainnet")) return null;
  // Ethereum Sepolia too; Etherscan's API needs a key.
  if (chainId === "11155111" && NETWORK_KEYS.includes("ethereum")) return null;
  // Elysium, once on (lib/elysium): read from the chain; its explorer's API is not known yet.
  if (ELYSIUM && chainId === String(ELYSIUM.chainId) && NETWORK_KEYS.includes("elysium-mainnet")) return null;
  // Elysium testnet too, once on.
  if (chainId === "99801" && NETWORK_KEYS.includes("elysium")) return null;
  return "bad";
}

export const dynamic = "force-dynamic";

/** Lookups per IP per minute. The app polls every 30 seconds per open tab. */
const PER_IP_PER_MIN = 30;

type TxRow = {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  isError: string;
};

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address") ?? "";
  if (!isAddress(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }
  const explorer = explorerFor(req.nextUrl.searchParams.get("chainId"));
  if (explorer === "bad") return NextResponse.json({ error: "unknown_chain" }, { status: 400 });
  if (explorer === null) return NextResponse.json({ txs: [], address });
  const rate = await hitRateLimit(clientIp(req), "activity", PER_IP_PER_MIN);
  if (!rate.allowed) {
    return NextResponse.json(
      { txs: [], error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
    );
  }

  try {
    // Cap server fetch; UI paginates client-side (PAGE_SIZE=5)
    const url = `${explorer}?module=account&action=txlist&address=${address}&page=1&offset=40&sort=desc`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { txs: [], error: "explorer_unavailable" },
        { status: 502 }
      );
    }
    const data = (await res.json()) as {
      result?: TxRow[] | string;
    };
    const rows = Array.isArray(data.result) ? data.result : [];
    const txs = rows.map((t) => ({
      hash: t.hash,
      from: t.from,
      to: t.to,
      valueWei: t.value,
      timestamp: Number(t.timeStamp) * 1000,
      ok: t.isError === "0",
    }));

    // public explorer data per address: the CDN answers the 30 s polls
    return NextResponse.json({ txs, address }, { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" } });
  } catch {
    return NextResponse.json(
      { txs: [], error: "fetch_failed" },
      { status: 502 }
    );
  }
}
