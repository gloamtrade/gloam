# Changelog

## 0.9.0 (10 November 2026)

Security release. If your agent sells anything over x402 and checks payments with `gloam_verify_payment` on `@gloamtrade/mcp` 0.8.0 or older, upgrade.

- **x402 payments are now bound to their payee.** `gloam_verify_payment` checks the payment's binding (an HMAC keyed by the payment note's secret over the chain, pool, receive tag and commitment) and refuses a payment with none or a wrong one. Up to 0.8.0 a sealed ticket copied from the public payment board was accepted as a payment. Payments this server makes with `gloam_fetch_paid` carry the binding. Advisory: [SECURITY.md](https://github.com/gloamtrade/gloam/blob/main/SECURITY.md#advisories).
- **Unbound payments are refused by default.** `GLOAM_X402_ALLOW_UNBOUND=1` takes them from payers older than the binding, accepting that a copied ticket passes then too; a wrong binding is refused either way. Payers should upgrade as well: MCP 0.8.0 and SDK 0.6.0 and older send no binding.
- **Elysium mainnet:** `elysium-mainnet` (chain `99901`, USDC only, gas in HYPE), live since 9 November 2026. No private swaps there yet.
- The spend log is written owner-only (mode 0600), and circuit files are cached in `~/.gloam/circuits` instead of a shared temp directory (`GLOAM_ARTIFACTS_DIR` still overrides it).
- Built with `@gloamtrade/sdk` 0.7.0 and `@gloamtrade/mppx-gloam` 0.5.0.
