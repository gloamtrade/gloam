# Changelog

## 0.3.0 (10 November 2026)

- `payX402` adds the x402 payment binding, the same way `buildGloamPayment` does. Sellers on `@gloamtrade/sdk` 0.7.0 or `@gloamtrade/mcp` 0.9.0 refuse unbound payments by default, so a payment from 0.2.1 is turned down after the agent has paid. Upgrade agents that pay over x402.
- **Elysium mainnet:** `elysium-mainnet` (USDC only, gas in HYPE).
- Tree sync uses the SDK's kept sync with the public leaf list on a cold start, so a fresh agent no longer walks the whole chain. The old `leaves.*.json` cache is not read; the first sync after upgrading loads the leaf list once.
- Depends on `@gloamtrade/sdk` `^0.7.0`.
