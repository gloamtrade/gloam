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

/** { address, chainId } fits in far less. */
const MAX_BODY = 256;

/** Every answer here names a wallet: never kept by the CDN or a browser cache. */
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The wallet goes in a POST body, never in the URL, where access logs would
 * keep it next to the IP. Nothing outside the app asked this way.
 */
export function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST", ...NO_STORE } });
}

/**
 * POST { address, chainId? }: a wallet's public history from the testnet's
 * explorer. No chainId is the Robinhood Chain testnet, as always.
 */
function objectFrom(text: string): { address?: unknown; chainId?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const text = await req.text().catch(() => "");
  if (text.length > MAX_BODY) return NextResponse.json({ error: "too_large" }, { status: 413, headers: NO_STORE });
  const body = objectFrom(text);
  if (!body) return NextResponse.json({ error: "bad_body" }, { status: 400, headers: NO_STORE });
  const address = typeof body.address === "string" ? body.address : "";
  if (!isAddress(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400, headers: NO_STORE });
  }
  const chainId = body.chainId == null ? null : typeof body.chainId === "number" || typeof body.chainId === "string" ? String(body.chainId) : "";
  const explorer = explorerFor(chainId);
  if (explorer === "bad") return NextResponse.json({ error: "unknown_chain" }, { status: 400, headers: NO_STORE });
  if (explorer === null) return NextResponse.json({ txs: [], address }, { headers: NO_STORE });
  const rate = await hitRateLimit(clientIp(req), "activity", PER_IP_PER_MIN);
  if (!rate.allowed) {
    return NextResponse.json(
      { txs: [], error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec), ...NO_STORE } },
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
        { status: 502, headers: NO_STORE }
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

    return NextResponse.json({ txs, address }, { headers: NO_STORE });
  } catch {
    return NextResponse.json(
      { txs: [], error: "fetch_failed" },
      { status: 502, headers: NO_STORE }
    );
  }
}
