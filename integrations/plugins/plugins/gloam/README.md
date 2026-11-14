# Gloam

Private stablecoin payments for AI agents. With this plugin an agent can pay for x402 and MPP
resources from a private (shielded) balance, get paid, check payments and proofs, and report what
it has spent, while amounts and counterparties stay off the public block explorer. Gloam runs on
Tempo, Robinhood Chain, Base and Ethereum mainnet (deposits capped at 50,000 of a stablecoin
each, cashing out costs 0.5%), and on their testnets. It runs on Elysium mainnet too (USDC only, gas in HYPE).
Reviewed internally before launch; Kann Audits has since reviewed the vault contracts and found no
Critical, High or Medium issues (report: gloam.trade/security).

## What it adds

- The Gloam MCP server, run locally over stdio with `npx -y @gloamtrade/mcp@0.9.1`.
- Two skills: `gloam` (pay, get paid, check limits and spending safely) and `gloam-setup`
  (connect, and give the agent a capped Tempo access key).

## What it runs, reads and contacts

- **Runs:** the `@gloamtrade/mcp` package from npm, pinned to 0.9.1. Source:
  https://github.com/gloamtrade/gloam/tree/main/mcp
- **Reads:** settings from `~/.gloam/agent.env` on your machine (agent key, Tempo account,
  spending limits, note store key). Nothing secret is stored in the plugin's files.
- **Contacts:** the public Tempo, Robinhood Chain, Base, Ethereum and Elysium RPC nodes (mainnet and testnet, or your own
  with `GLOAM_RPC_URL_<chainId>`), Gloam's zero-knowledge circuit files at
  `https://www.gloam.trade/circuits` (checked against pinned SHA-256), Gloam's relay when you turn it on (and always for private swaps), and
  the paid URLs you ask the agent to fetch. Private and local network addresses are refused by
  default.

## Spending and safety

Out of the box the server only reads and plans: it signs nothing until you give it a key, and it
uses the testnet unless you set `GLOAM_NETWORK` to a mainnet. When you
do, every payment is checked against limits you set (per payment, per day, allowed payees, expiry)
before it is proved or signed, and every spend is logged. On Tempo the recommended key is an access
key that your own wallet caps onchain, so the agent cannot spend past the limit even if the server
is misconfigured. Note secrets stay in an encrypted store on your machine; the agent only sees note
handles.

Docs: https://gloam.trade/docs/agents
Questions: hello@gloam.trade

## License

MIT
