# Gloam plugins

Agent plugins for [Gloam](https://gloam.trade): private stablecoin payments for AI agents on Tempo,
Robinhood Chain, Base and Ethereum, live on mainnet and on the testnets (Elysium mainnet support is coming), under spending
limits the agent cannot lift. The layout mirrors
[tempoxyz/plugins](https://github.com/tempoxyz/plugins), so the same marketplace works in Claude
Code, Codex and Cursor.

| Plugin | What it adds |
| --- | --- |
| [`gloam`](./plugins/gloam) | The Gloam MCP server (`npx -y @gloamtrade/mcp@0.8.0`, stdio) and two skills: `gloam` (pay, get paid and check limits safely) and `gloam-setup` (connect, and give the agent a capped Tempo access key) |

## Install

This directory is the root of a marketplace. Publish it as its own repository (see
[Publishing](#publishing)); with `gloamtrade/gloam-plugins` as that repository:

```sh
# Claude Code
claude plugin marketplace add gloamtrade/gloam-plugins
claude plugin install gloam@gloam

# Codex
codex plugin marketplace add gloamtrade/gloam-plugins
codex plugin add gloam@gloam

# GitHub Agent Skills (skills only, no MCP server)
gh skill install gloamtrade/gloam-plugins gloam
gh skill install gloamtrade/gloam-plugins gloam-setup
```

Cursor reads `.cursor-plugin/marketplace.json` once the repository is submitted at
`https://cursor.com/marketplace/publish`.

### Just the MCP server

Any MCP client can run the server directly from npm:

```sh
claude mcp add gloam -- npx -y @gloamtrade/mcp          # Claude Code
codex mcp add gloam -- npx -y @gloamtrade/mcp           # Codex
code --add-mcp '{"name":"gloam","command":"npx","args":["-y","@gloamtrade/mcp"]}'   # VS Code
```

Cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=gloam&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBnbG9hbXRyYWRlL21jcCJdfQ==`

Or in any `mcpServers` config (Gemini CLI: `~/.gemini/settings.json`):

```json
{ "mcpServers": { "gloam": { "command": "npx", "args": ["-y", "@gloamtrade/mcp"] } } }
```

The plugin pins the server to `@gloamtrade/mcp@0.8.0`, so a new server version reaches agents only
through a plugin update. The plain commands above take the latest version.

### Or connect by URL, nothing installed

Gloam also runs a hosted MCP server at `https://www.gloam.trade/mcp`. Paste it into Claude
(Settings, Connectors, Add custom connector), ChatGPT connectors, or any client that connects by URL:

```sh
claude mcp add --transport http gloam-hosted https://www.gloam.trade/mcp   # Claude Code
```

```json
{ "mcpServers": { "gloam-hosted": { "url": "https://www.gloam.trade/mcp" } } }
```

It only reads and plans (networks, vault stats, payment request links, proof checks, MPP how-to)
and refuses anything that looks like a key or note secret. Signing and paying stay with the local
server above.

## After installing: let the agent spend

Out of the box the server only reads and plans. Nothing is signed until it has a key, and no key or
secret ever goes in a plugin file or the chat. Settings live in `~/.gloam/agent.env` (mode 600).

The recommended setup is a Tempo access key. The owner's wallet authorizes a key that only the
agent's server holds, with an expiry, a spending limit that resets each period, and call scopes
(approve the Gloam pool, shield, private transfer, nothing else). Tempo enforces all three on every
transaction the key signs, so **the caps hold even if the agent is prompt-injected or the MCP
server and its host are compromised**: the most anyone holding the key can move out of the owner's
account is what is left of the current period's limit, only into the Gloam pool, and only until it
expires or the owner revokes it.

```sh
# 1. Make the agent key and print what the owner signs (sends nothing, never prints the key)
npx -y @gloamtrade/mcp authorize-access-key --network tempo-mainnet --owner 0xYOUR_TEMPO_ACCOUNT --generate --limit 10 --period 1d --expires 30d

# 2. Authorize it from the owner wallet: Tempo Wallet (wallet_authorizeAccessKey), cast, or the raw call it prints

# 3. Check it (read-only), then restart the agent
npx -y @gloamtrade/mcp authorize-access-key --check --network tempo-mainnet --owner 0xYOUR_TEMPO_ACCOUNT
```

In Claude Code, `/gloam:gloam-setup` walks through this. The full reference, including what the cap
does and does not cover, is in the [server README](https://github.com/gloamtrade/gloam/tree/main/mcp#onchain-limits-with-a-tempo-access-key).

## Layout

```
.claude-plugin/marketplace.json     Claude Code marketplace
.cursor-plugin/marketplace.json     Cursor marketplace
.agents/plugins/marketplace.json    Codex marketplace
plugins/gloam/
  .claude-plugin/plugin.json        Claude Code manifest (skills + .mcp.json)
  .codex-plugin/plugin.json         Codex manifest (interface, onboarding skill)
  .cursor-plugin/plugin.json        Cursor manifest (logo)
  .mcp.json                         MCP server for Claude Code, Codex and Cursor
  mcp.json, plugin.json             agent-plugins.org manifests
  skills/gloam/SKILL.md             Using the payment tools safely
  skills/gloam-setup/SKILL.md       Connecting, access keys, limits
  assets/gloam-mark.svg
registry/gloam/server.json          Official MCP Registry entry (npm package, stdio)
```

## Publishing

1. Publish the server (from the Gloam repo root): `pnpm --filter @gloamtrade/mcp publish --access public`.
   Use pnpm, not npm, so workspace versions are rewritten. Check `npx -y @gloamtrade/mcp --version`.
2. Make the marketplace repository from this directory, keeping history:
   `git subtree split --prefix integrations/plugins -b gloam-plugins`, then push that branch to a new
   repository `gloamtrade/gloam-plugins` as `main`. Repeat the split and push to update it.
3. Validate: `claude plugin validate .` in the new repository.
4. Optional listings:
   - Claude directory: submit the plugin folder (`plugins/gloam`) as a plugin bundle, and the hosted
     server (`https://www.gloam.trade/mcp`) as an MCP connector, at `https://claude.ai/directory/manage`.
   - Cursor: submit the repository URL at `https://cursor.com/marketplace/publish`. Disclose that the
     plugin can sign transactions and move funds on mainnet or testnet once a
     key is configured.
   - MCP Registry: `registry/gloam/server.json` matches `mcpName` in the npm package. Authenticate the
     `io.github.cryptoduke01` namespace with GitHub and run `mcp-publisher publish` from `registry/gloam`.

Bump `version` in the three `plugin.json` manifests, `plugin.json`, `registry/gloam/server.json`
and the pinned `@gloamtrade/mcp@0.8.0` in `.mcp.json`, `mcp.json` and the skill together with every
server release, patch releases included. `pnpm --filter @gloamtrade/mcp test` fails while a pin here
or in `registry/server.json` differs from the version in `mcp/package.json`.

## License

MIT
