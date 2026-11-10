# Changelog

## 0.5.0 (10 November 2026)

- Depends on `@gloamtrade/sdk` `^0.7.0`. 0.4.1 was published pinned to SDK 0.5.1 exactly, so it never picked up SDK fixes; this release takes every 0.7.x patch.
- SDK 0.7.0 binds x402 payments to their payee. An MPP credential already carries its own binding to the challenge, keyed by the same note secret and checked in validate, so settle passes `allowUnbound` for the x402 check.
- **Elysium mainnet:** `"elysium-mainnet"` (USDC only, gas in HYPE). `"elysium"` (Elysium testnet) is refused until its pool is in.
- `gloamChargeChainFromClient` takes the SDK's tree sync options and `warm()`, so a server keeps the pool tree instead of rebuilding it for every charge. Validate runs its pull-mode reads in parallel.
