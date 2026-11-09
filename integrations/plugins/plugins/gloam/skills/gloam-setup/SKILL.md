---
name: gloam-setup
description: >
  Use to install, connect or troubleshoot Gloam, and to let the agent spend: setting up a Tempo
  access key with an onchain spending limit and expiry, off-chain limits, the settings file, and
  checking or revoking the key. For payments on a working setup, use gloam.
license: MIT
---

# Gloam setup

The `gloam` MCP server runs with `npx -y @gloamtrade/mcp`. With no settings it only reads and plans.
To execute it needs a key, a note-store key and limits, all read from `~/.gloam/agent.env` (mode
600), never from the plugin config or the chat.

First ask whether the user wants **mainnet** (`tempo-mainnet`, `robinhood-mainnet`,
`base-mainnet` or `ethereum-mainnet`) or the **testnet** (`tempo`, `robinhood`, `base` or
`ethereum`).
Suggest practicing on testnet first if they are new to it. `GLOAM_NETWORK` in the settings file sets
the default network; unset, it is the Robinhood Chain testnet.

## 1. Check the connection

Call `gloam_info` and `gloam_get_limits`. If the tools are missing, the server did not start:

- Claude Code: run `/reload-plugins`, or restart Claude Code. Then `/mcp` shows the server status.
- Codex or Cursor: restart the app or start a new session.
- The server needs Node.js 20 or newer (`node --version`).

## 2. Give the agent capped spending (recommended: a Tempo access key)

The owner's Tempo wallet authorizes a key that only the agent's server holds. The protocol enforces
the key's expiry, its spending limit per period and its call scopes on every transaction, so the
caps hold even if the agent is tricked or the server is compromised. The owner's own key never
leaves the owner.

1. Ask the user for their Tempo account address (public, starts with `0x`), the network
   (`tempo-mainnet` for mainnet, `tempo` for testnet), and the limit, reset period and expiry they
   want. Suggest small numbers, such as 10 USDC.e a day for 30 days on mainnet or 10 PathUSD on
   testnet. The user decides; never pick larger numbers for them.
2. Run, with their values:

   ```bash
   npx -y @gloamtrade/mcp@0.8.0 authorize-access-key --network tempo-mainnet --owner <their address> --generate --limit 10 --period 1d --expires 30d
   ```

   This makes the agent key, saves it to `~/.gloam/agent.env` with a note-store key and matching
   off-chain limits (and, on mainnet, `GLOAM_NETWORK` and `GLOAM_LIMIT_NETWORK`), and prints what
   the owner signs. It never prints the key and never sends anything. A key authorized on testnet
   does nothing on mainnet, and the other way round.
3. Show the user the printed options and let them authorize the key from their own wallet: Tempo
   Wallet (`wallet_authorizeAccessKey`), Foundry `cast send ... --interactive`, or the raw call.
   Never ask for the owner's private key or seed phrase, and never run the owner's signing step
   for them.
4. If the user has used the Gloam app with that account, tell them to reset the account's approval
   of the Gloam pool to 0 first (the printed `approve(...) 0` command). The cap counts approvals
   the key makes, not allowances the owner already gave.
5. When the user says it is sent, check it (read-only):

   ```bash
   npx -y @gloamtrade/mcp@0.8.0 authorize-access-key --check --network tempo-mainnet --owner <their address>
   ```

   Relay every warning. Ready means authorized, limited, scoped and no standing pool allowance.
6. Restart the server (step 1) and call `gloam_get_limits`. The server log line `Signer: Tempo
   access key ...` confirms the mode.

Revoking is one transaction from the owner, printed at the end of step 2 (`revokeKey`). A revoked
key can never be authorized again; run step 2 again for a new one.

## 3. Other setups

- Raw key (no onchain cap, and the only option on Robinhood Chain, Base and Ethereum, and on Elysium once its support, coming, is in): set `GLOAM_AGENT_PRIVATE_KEY`
  to a funded key, plus `GLOAM_NOTE_KEY` (`openssl rand -hex 32`), `GLOAM_NETWORK`, and off-chain
  limits (`GLOAM_LIMIT_ASSETS`, `GLOAM_LIMIT_MAX_PER_PAYMENT`, `GLOAM_LIMIT_MAX_PER_DAY`,
  `GLOAM_LIMIT_RECIPIENTS`, and `GLOAM_LIMIT_NETWORK` for mainnet assets) in `~/.gloam/agent.env`.
  Only the server's own checks bind it, so fund it with what you can lose.
- Payee only (getting paid, no spending): `GLOAM_NOTE_KEY` and `GLOAM_USE_RELAY=1` are enough to
  verify and sweep payments.
- Several agents: one settings file per agent via `GLOAM_ENV_FILE`, or `GLOAM_LIMITS_FILE` with
  `GLOAM_AGENT_ID`.

## Rules

- Never print, paste or summarize `~/.gloam/agent.env`. It holds the agent key and the note-store
  key. To confirm a setting, name the key only (for example "GLOAM_TEMPO_ACCOUNT is set").
- Tell the user to back up `~/.gloam/` (the note store and its key together). Without the key the
  private balance cannot be opened.
- Without limits the server refuses every spend. That is on purpose; do not set `GLOAM_LIMITS=off`
  unless the user asks for it knowing what it means.
- Limits written for testnet never approve mainnet money: a symbol on both sides (USDG, pathUSD,
  OUSD) means the testnet asset unless the limit names a `-mainnet` network. Mainnet limits must
  say so explicitly.
- Setup never needs a payment. Do not run an execute tool to test the connection.
