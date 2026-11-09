/**
 * The hosted Gloam MCP server (www.gloam.trade/mcp). One small low-level MCP
 * Server per HTTP request: the route is stateless, so nothing is kept between
 * calls and no session lives on the function.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { callTool, LOCAL_SERVER, SITE, TOOLS, type ToolContext } from "./tools";
import { liveMainnetNames } from "@/lib/mainnet";
import { MAINNET_ENABLED } from "@/lib/networks";

export const SERVER_VERSION = "1.0.0";

const INSTRUCTIONS = [
  // Names mainnet once a mainnet pool is filled in, like the tools' network list (lib/mainnet.ts).
  MAINNET_ENABLED
    ? `Gloam is the privacy layer for onchain finance: shielded balances, private payments and shareable proofs. Mainnet on ${liveMainnetNames()} (with deposit limits, payments only), and a testnet beside each.`
    : "Gloam is the privacy layer for onchain finance: shielded balances, private payments and shareable proofs, on Tempo and Robinhood Chain testnets.",
  "This hosted server only reads and plans. It never signs, never holds funds, and never takes a private key, recovery phrase or Gloam note secret. Never ask the user for one. If the user pastes one, tell them not to share it and to treat it as exposed.",
  "Start with gloam_info.",
  `When the user wants something done (a deposit, a payment, a test transfer), do not hand them a long checklist. Offer the two short paths first. One: let you do it for them, by adding the local server (${LOCAL_SERVER}) with a capped spending key; gloam_connect_full_agent has the one-line setup for their client. Two: one link per action that they open and sign, for example a payment request from gloam_create_payment_request, which opens Pay in the app already filled in. Give step-by-step app instructions only if they ask for them or turn down both.`,
].join("\n");

const KNOWN = new Set(TOOLS.map((t) => t.name));

export function createHostedGloamServer(ctx: ToolContext): Server {
  const server = new Server(
    {
      name: "gloam",
      title: "Gloam",
      version: SERVER_VERSION,
      description: "Private stablecoin payments for people and agents. Hosted, read and plan only.",
      websiteUrl: SITE,
      icons: [
        { src: `${SITE}/favicon.png`, mimeType: "image/png", sizes: ["512x512"] },
        { src: `${SITE}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
      ],
    },
    { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!KNOWN.has(name)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool "${name}". Call tools/list, or gloam_info.`);
    }
    return callTool(name, args ?? {}, ctx);
  });

  return server;
}
