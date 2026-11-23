import type { MetadataRoute } from "next";
import { SHOW_TESTNETS } from "@/lib/showTestnets";
import { FRESH_WALLET_ENABLED } from "@/lib/freshWalletFlag";
import { kvBackend } from "@/lib/partnersKv";
import { listPublishedUpdates } from "@/lib/updatesMail";

const SITE = "https://www.gloam.trade";

/**
 * Every public page. Add a page here when it ships; pages marked noindex
 * (claim, vault, merch, admin, partner portal) and redirects stay out.
 */
const PAGES: { path: string; priority: number }[] = [
  { path: "/", priority: 1 },
  { path: "/app", priority: 0.9 },
  { path: "/agents", priority: 0.9 },
  { path: "/mainnet", priority: 0.8 },
  { path: "/docs", priority: 0.8 },
  { path: "/whitepaper", priority: 0.8 },
  { path: "/research", priority: 0.7 },
  { path: "/updates", priority: 0.5 },
  { path: "/verify", priority: 0.7 },
  { path: "/security", priority: 0.7 },
  { path: "/compliance", priority: 0.5 },
  { path: "/transparency", priority: 0.7 },
  { path: "/stats", priority: 0.7 },
  { path: "/token", priority: 0.7 },
  { path: "/sdk", priority: 0.7 },
  { path: "/sdk/playground", priority: 0.5 },
  { path: "/partners", priority: 0.6 },
  { path: "/testers", priority: 0.5 },
  { path: "/contest", priority: 0.5 },
  { path: "/contest/writers", priority: 0.5 },
  { path: "/vote", priority: 0.5 },
  { path: "/xray", priority: 0.5 },
  { path: "/pitch", priority: 0.5 },
  { path: "/blog/live-on-solana", priority: 0.6 },
  { path: "/blog/build-with-gloam-at-the-near-hackathon", priority: 0.6 },
  { path: "/blog/agents-should-not-do-business-in-public", priority: 0.6 },
  { path: "/blog/private-agent-payments", priority: 0.6 },
  { path: "/blog/live-on-mainnet", priority: 0.6 },
  { path: "/blog/privacy-without-an-operator", priority: 0.6 },
  { path: "/blog/live-on-tempo", priority: 0.6 },
  { path: "/docs/quickstart", priority: 0.7 },
  { path: "/docs/product", priority: 0.6 },
  { path: "/docs/private-pay", priority: 0.6 },
  { path: "/docs/payroll", priority: 0.6 },
  { path: "/docs/private-swaps", priority: 0.6 },
  { path: "/docs/proofs", priority: 0.6 },
  { path: "/docs/agents", priority: 0.6 },
  { path: "/docs/agents/commitments", priority: 0.6 },
  { path: "/docs/virtuals", priority: 0.6 },
  { path: "/docs/integrate", priority: 0.6 },
  { path: "/docs/bridge", priority: 0.6 },
  // the fresh-wallet guide only while the flow is on (lib/freshWalletFlag)
  ...(FRESH_WALLET_ENABLED ? [{ path: "/docs/fresh-wallet", priority: 0.6 }] : []),
  { path: "/docs/chain", priority: 0.6 },
  // the testnet guide only while people see the testnets (lib/showTestnets)
  ...(SHOW_TESTNETS ? [{ path: "/docs/testnet", priority: 0.6 }] : []),
  { path: "/docs/privacy-model", priority: 0.6 },
  { path: "/docs/threat-model", priority: 0.6 },
  { path: "/docs/compare", priority: 0.6 },
  { path: "/docs/encryption", priority: 0.5 },
  { path: "/docs/production", priority: 0.5 },
  { path: "/docs/data", priority: 0.5 },
  { path: "/docs/partners", priority: 0.5 },
  { path: "/docs/sdk", priority: 0.6 },
  { path: "/docs/sdk/reference", priority: 0.5 },
  { path: "/docs/sdk/disclosure", priority: 0.5 },
  { path: "/brand", priority: 0.3 },
  { path: "/privacy", priority: 0.2 },
  { path: "/terms", priority: 0.2 },
  { path: "/cookies", priority: 0.2 },
  { path: "/disclosures", priority: 0.2 },
];

/** Read again at most hourly, so a new email update joins the list without a deploy. */
export const revalidate = 3600;

/** Each email update that went out (/updates/<id>). A store that doesn't answer leaves them out this time. */
async function updatePages(): Promise<MetadataRoute.Sitemap> {
  if (kvBackend() !== "redis") return [];
  try {
    const updates = await listPublishedUpdates();
    return updates.map((u) => ({ url: `${SITE}/updates/${u.id}`, lastModified: u.day, priority: 0.4 }));
  } catch {
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages = PAGES.map(({ path, priority }) => ({ url: `${SITE}${path === "/" ? "" : path}`, priority }));
  return [...pages, ...(await updatePages())];
}
