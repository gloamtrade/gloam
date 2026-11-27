import { CASH_OUT_FEE_PERCENT } from "@/lib/cashOutFee";
import { liveMainnetNames } from "@/lib/mainnet";
import { GLOAM_TOKEN } from "@/lib/buybacks";
import { RINGS_PRIVACY_NOTE, SOLANA_NAME, SOLANA_RINGS_ENABLED } from "@/lib/solanaRings/config";
import { STARKNET_PRIVACY_NOTE } from "@gloamtrade/sdk";
import { STARKNET_ENABLED } from "@/lib/starknetPrivacy/config";

/**
 * /llms.txt (llmstxt.org): what Gloam is and where an agent or a model should
 * read next, as plain markdown. Built from the same values the app shows, so
 * the live networks and the cash-out fee stay current.
 */
export const revalidate = 3600;

const SITE = "https://www.gloam.trade";

const DOCS: [path: string, title: string, about: string][] = [
  ["/docs/quickstart", "Quickstart", "shield a first private balance with @gloamtrade/sdk: install, prove, deposit, cash out"],
  ["/docs/agents", "Build a private agent", "give an AI agent a private balance through the SDK or the MCP server, under spending policy"],
  ["/docs/integrate", "Add Gloam to an agent kit or marketplace", "a drop-in tool pack, and private payments for sellers on x402 marketplaces"],
  ["/docs/agents/commitments", "Private commerce with commitments", "agents pay each other privately and every payment stays checkable against a posted merkle root"],
  ["/docs/sdk", "SDK", "@gloamtrade/sdk: networks, intents (plan and exec), proofs, guardrails"],
  ["/docs/sdk/reference", "SDK API reference", "every export of @gloamtrade/sdk"],
  ["/docs/partners", "Partner program and API", "the v1 REST API with an API key, partner codes, attributed volume"],
  ["/docs/payroll", "Private payroll", "pay a team from a list; nobody sees who got what"],
  ["/docs/private-swaps", "Private swaps", "swap inside the vault without showing who swapped"],
  ["/docs/bridge", "Deposit from another chain", "pay in from Solana, Bitcoin, Tron or EVM chains through Relay"],
  ["/docs/proofs", "Proofs", "prove a balance, a payment or a payroll total to one chosen person"],
  ["/docs/privacy-model", "What stays private", "what an explorer still shows, what stays hidden, the anonymity set"],
  ["/docs/threat-model", "Threat model", "who Gloam defends against and the known gaps"],
  ["/docs/chain", "Networks", "chains, vault addresses, deploy blocks and verified source"],
  // only while Starknet is on (lib/starknetPrivacy/config): the page answers 404 otherwise
  ...(STARKNET_ENABLED ? ([["/docs/starknet", "Starknet", "Gloam on Starknet's privacy pool: what is public and hidden, the auditor key, fees, the SDK and MCP tools"]] as [string, string, string][]) : []),
  ["/docs/virtuals", "Virtuals agents", "private balances and payments for Virtuals (GAME and ACP) agents"],
];

/** Gloam on Solana, only while it is on: its own line, since a payment there hides less than in the vault. */
function solanaLine(): string {
  if (!SOLANA_RINGS_ENABLED) return "";
  return `- Gloam is on ${SOLANA_NAME} too, through Helius Privacy Rings, in the app at ${SITE}/app/solana. ${RINGS_PRIVACY_NOTE} Gloam's relay pays the Solana fees. Solana is in the app only: the SDK and the MCP servers cover the networks above.\n`;
}

/** Gloam on Starknet, only while it is on: its own line, since the first payment there shows the payee. */
function starknetLine(): string {
  if (!STARKNET_ENABLED) return "";
  return `- Gloam is on Starknet too, through Starknet's own privacy pool (${SITE}/docs/starknet). ${STARKNET_PRIVACY_NOTE} Gloam's relay pays Starknet's fees. The SDK (@gloamtrade/sdk/starknet) and the local MCP server (gloam_starknet_* tools) cover it.\n`;
}

function body(): string {
  const chains = liveMainnetNames();
  return `# Gloam

> Private money on public chains. Gloam gives people and AI agents a private stablecoin balance on ${chains}: hold, pay, get paid, run payroll and swap, with amounts and payees hidden from the public chain. It is self-custodial: zero-knowledge proofs are made on the user's own device, and nobody, including the Gloam team, can move a user's money.

- Adding money and cashing out are public transfers. Everything in between (balances, private payments, payroll, swaps) stays private.
- Private payments are free. Cashing out costs ${CASH_OUT_FEE_PERCENT}. The Gloam relay can send private transactions for the user, so their wallet doesn't appear next to them.
- Depositing wallets are screened. A user can prove a balance, a payment or a payroll total to one person they choose.
- Gloam names: an @name points to a Gloam address and is paid for in $GLOAM.
- $GLOAM is on Robinhood Chain at ${GLOAM_TOKEN}. A copycat token uses the same name, so match the address, not the name.
${solanaLine()}${starknetLine()}
## For agents

- [Hosted MCP server](${SITE}/mcp): streamable HTTP, no key. Tools: gloam_info, gloam_networks, gloam_vault_stats, gloam_plan_deposit, gloam_swap_quote, gloam_create_payment_request, gloam_verify_proof, gloam_mpp_how_to, gloam_connect_full_agent. Add it with \`claude mcp add --transport http gloam-hosted ${SITE}/mcp\`.
- [Local MCP server with a wallet](https://www.npmjs.com/package/@gloamtrade/mcp): \`npx -y @gloamtrade/mcp\` holds, pays and proves for the agent, under spending limits. MCP Registry name: io.github.cryptoduke01/gloam.
- [SDK](https://www.npmjs.com/package/@gloamtrade/sdk): \`npm i @gloamtrade/sdk\` (TypeScript, ES modules).
- [x402 and MPP payments](https://www.npmjs.com/package/@gloamtrade/mppx-gloam): \`@gloamtrade/mppx-gloam\`, a private payment method for paid endpoints.
- [Virtuals GAME plugin](https://www.npmjs.com/package/@gloamtrade/game-plugin-gloam): \`@gloamtrade/game-plugin-gloam\`.
- [Starter app](https://www.npmjs.com/package/create-gloam-app): \`npx create-gloam-app\`.
- [Plugins for Claude Code, Codex and Cursor](https://github.com/gloamtrade/gloam-plugins)

## Docs

${DOCS.map(([path, title, about]) => `- [${title}](${SITE}${path}): ${about}`).join("\n")}

## Optional

- [App](${SITE}/app): the web app
- [Transparency](${SITE}/transparency): what each vault holds, read live from the chain
- [Verify a proof](${SITE}/verify)
- [Whitepaper](${SITE}/whitepaper)
- [Security](${SITE}/security)
- [$GLOAM](${SITE}/token)
- [Status](https://status.gloam.trade)
- [Source code](https://github.com/gloamtrade/gloam): MIT
`;
}

export function GET() {
  return new Response(body(), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
