/**
 * Whether people see the testnets: the app's network menu, the transparency
 * picker, the contracts list on /verify, and the links that send people to
 * the testnet guide. Off unless NEXT_PUBLIC_SHOW_TESTNETS is "1", "true", "on"
 * or "yes" (any case).
 *
 * Off only takes them out of view. The testnets stay networks (lib/networks
 * NETWORK_KEYS), so the API, relay, SDK, MCP, partner test keys, proofs and a
 * claim or request link on a testnet keep working, and say they are on a
 * testnet. Set the variable and rebuild to show them again.
 *
 * No imports, so the site's footer and docs nav can read it without pulling in
 * the network registry.
 */
export function showTestnetsFrom(raw: string | undefined): boolean {
  return /^(1|true|on|yes)$/i.test((raw ?? "").trim());
}

export const SHOW_TESTNETS: boolean = showTestnetsFrom(process.env.NEXT_PUBLIC_SHOW_TESTNETS);
