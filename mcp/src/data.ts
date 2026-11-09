import { mainnetNetwork } from "@gloamtrade/sdk";

/**
 * Self-contained facts the MCP server answers with, so it has no runtime
 * dependency on the web app. CHAIN is the Robinhood Chain TESTNET, where the
 * public test-ETH transfer and the shield plan point.
 */

/** Robinhood Chain testnet: where the public test-ETH transfer and the shield plan point. */
export const CHAIN = {
  name: "Robinhood Chain Testnet",
  chainId: 46630,
  rpc: "https://rpc.testnet.chain.robinhood.com",
  explorer: "https://explorer.testnet.chain.robinhood.com",
} as const;

/** Elysium mainnet, once the SDK has every value for it (src/elysium.ts); null before, and nothing here names it. */
const ELYSIUM = mainnetNetwork("elysium");

/**
 * Honest privacy posture. The MCP server never claims more than the protocol
 * delivers today (this mirrors Gloam's threat-model honesty).
 */
export const PRIVACY_STATUS = {
  network: `Mainnet on Robinhood Chain and Tempo since 21 October 2026, and on Base and Ethereum since 26 October 2026${ELYSIUM ? ", and on Elysium (gas in HYPE)" : ""}. The testnets stay up.`,
  provingKeys:
    "Mainnet verifies the final keys of the 13-contributor trusted setup (drand round 6561386, release ceremony-final). The testnets use single-party dev keys. This server proves with the set of the network it pays on.",
  live: [
    "shield (deposit)",
    "private send and private payments (x402 and MPP)",
    "receiving and sweeping payments",
    "cash out (in the Gloam app and SDK)",
    "private swaps where the network has a swap router (gloam_swap_quote says): who swapped stays private, the tokens and amounts are public",
  ],
  disabled: ["the old sealed trade: retired on every network"],
  notLive: ["the old sealed trade"],
  review:
    "The contracts and circuits were reviewed internally before launch, with no Critical or High findings open. Kann Audits reviewed the vault contracts (report, 1 November 2026: gloam.trade/security) and found no Critical, High or Medium issues. The swap routers, circuits, app, relay, this server and the SDK were not part of that review.",
  mainnetLimits: `Deposit limits: 50,000 per deposit and 2,500,000 in total for each stablecoin, 20 and 1,000 for ETH on Base and Ethereum, 2,500,000 and 25,000,000 for GLOAM${ELYSIUM ? ", 500 and 25,000 for USDC on Elysium" : ""}. Private payments and cash outs are never limited. Raising a limit or adding an asset waits a public 3-day timelock; the owner can lower limits or close deposits at once.`,
  fees: "Direct deposits and private payments are free. Cashing out costs 0.5%.",
  operator:
    "No admin withdraw: notes leave the pool only with an unshield proof. The pool owner is one wallet at launch (a multisig is planned). The Gloam relay, run by the team, only submits already-proven transactions and pays gas; it cannot move or redirect money.",
  whatIsPublic:
    "The shield deposit and any cash-out are public transactions (amount and address visible). What stays hidden is the link between them, your holdings inside the pool, and the amounts and parties of in-pool payments.",
  anonymitySet:
    "thin on a new pool, and the mainnet pools are new. Unlinkability is only as strong as the crowd of notes to hide among. Do not treat a cash-out as fully private until the pool has real volume, and do not cash out the same amount you just deposited.",
  execution:
    "gloam_execute_shield performs a real private deposit (mints a note, generates the Groth16 proof server-side, and broadcasts shieldBound) when GLOAM_AGENT_PRIVATE_KEY is set, on mainnet too when the network is a -mainnet one. gloam_execute_private_swap proves a private swap here and sends it through the Gloam relay, never from this server's wallet.",
} as const;
