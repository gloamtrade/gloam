# Changelog

## 0.9.1 (14 November 2026)

- Built with `@gloamtrade/sdk` 0.7.1: Elysium mainnet's payment-message board is in the network data, and the SDK's `checkPaymentReceipt` refuses testnet receipts unless `allowTestnet` is passed ([advisory](https://github.com/gloamtrade/gloam/blob/main/SECURITY.md#advisories)). No tool's behavior changes.

## 0.9.0 (10 November 2026)

Security release. If your agent sells anything over x402 and checks payments with `gloam_verify_payment` on `@gloamtrade/mcp` 0.8.0 or older, upgrade.

- **x402 payments are now bound to their payee.** `gloam_verify_payment` checks the payment's binding (an HMAC keyed by the payment note's secret over the chain, pool, receive tag and commitment) and refuses a payment with none or a wrong one. Up to 0.8.0 a sealed ticket copied from the public payment board was accepted as a payment. Payments this server makes with `gloam_fetch_paid` carry the binding. Advisory: [SECURITY.md](https://github.com/gloamtrade/gloam/blob/main/SECURITY.md#advisories).
- **Unbound payments are refused by default.** `GLOAM_X402_ALLOW_UNBOUND=1` takes them from payers older than the binding, accepting that a copied ticket passes then too; a wrong binding is refused either way. Payers should upgrade as well: MCP 0.8.0 and SDK 0.6.0 and older send no binding.
- **Elysium mainnet:** `elysium-mainnet` (chain `99901`, USDC only, gas in HYPE), live since 9 November 2026. No private swaps there yet.
- **Spends no longer re-read the whole vault history.** The server keeps one tree per chain and pool, loads Gloam's public leaf list on a cold start (checked against the chain's root), and reads only new blocks after that. On Robinhood Chain a spend went from about 1,250 RPC calls and 2 minutes to 3 calls and under a second.
- The spend log is written owner-only (mode 0600), and circuit files are cached in `~/.gloam/circuits` instead of a shared temp directory (`GLOAM_ARTIFACTS_DIR` still overrides it).
- Built with `@gloamtrade/sdk` 0.7.0 and `@gloamtrade/mppx-gloam` 0.5.0.
