import type { MetadataRoute } from "next";

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
  { path: "/verify", priority: 0.7 },
  { path: "/security", priority: 0.7 },
  { path: "/transparency", priority: 0.7 },
  { path: "/stats", priority: 0.7 },
  { path: "/token", priority: 0.7 },
  { path: "/sdk", priority: 0.7 },
  { path: "/sdk/playground", priority: 0.5 },
  { path: "/partners", priority: 0.6 },
  { path: "/testers", priority: 0.5 },
  { path: "/contest", priority: 0.5 },
  { path: "/pitch", priority: 0.5 },
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
  { path: "/docs/fresh-wallet", priority: 0.6 },
  { path: "/docs/chain", priority: 0.6 },
  { path: "/docs/testnet", priority: 0.6 },
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
  { path: "/docs/sealed-trade", priority: 0.3 },
  { path: "/brand", priority: 0.3 },
  { path: "/privacy", priority: 0.2 },
  { path: "/terms", priority: 0.2 },
  { path: "/cookies", priority: 0.2 },
  { path: "/disclosures", priority: 0.2 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map(({ path, priority }) => ({ url: `${SITE}${path === "/" ? "" : path}`, priority }));
}
