# Changelog

## 0.10.1 (20 November 2026)

- Built with `@gloamtrade/sdk` 0.8.1: on BNB Chain, BDX is Beldex's BEP-20 `0x9d10a1ec41Fe7878429BB457e31F9b050D38c633`, not the LayerZero OFT named BDX, which is not Beldex's (closed in every vault on 20 November 2026). A limit or payment naming BDX on `bnb-mainnet` now counts in that contract. No other change.

## 0.10.0 (19 November 2026)

- **BNB Chain mainnet:** `GLOAM_NETWORK=bnb-mainnet` (chain `56`, gas in BNB), live since 19 November 2026. It takes USDT and USDC (18 decimals each), BNB and BDX. Its public RPCs keep about a day of logs, so set `GLOAM_RPC_URL_56` to an RPC that keeps them all. A read that hits pruned history fails loudly instead of reporting no payments. No private swaps there yet.
- **A listed asset always counts in its own decimals.** A `decimals` argument that disagrees with a listed asset is refused with the asset's real decimals (for example 6 for USDT on BNB Chain). It is only used for an asset Gloam does not list. Spending limits naming `bnb-mainnet` count USDT and USDC in 18 decimals.
- `--help` lists every live mainnet.
- Built with `@gloamtrade/sdk` 0.8.0 and `@gloamtrade/mppx-gloam` 0.6.0.

## 0.9.1 (16 November 2026)

- Built with `@gloamtrade/sdk` 0.7.1: Elysium mainnet's payment-message board is in the network data, and the SDK's `checkPaymentReceipt` refuses testnet receipts unless `allowTestnet` is passed ([advisory](https://github.com/gloamtrade/gloam/blob/main/SECURITY.md#advisories)). No tool's behavior changes.
- The SDK's `gloam-cashout` gateway fix in 0.7.1 does not change this server: it pays cash-out quotes and runs no gateway.

## 0.9.0 (10 November 2026)

Security release. If your agent sells anything over x402 and checks payments with `gloam_verify_payment` on `@gloamtrade/mcp` 0.8.0 or older, upgrade.

- **x402 payments are now bound to their payee.** `gloam_verify_payment` checks the payment's binding (an HMAC keyed by the payment note's secret over the chain, pool, receive tag and commitment) and refuses a payment with none or a wrong one. Up to 0.8.0 a sealed ticket copied from the public payment board was accepted as a payment. Payments this server makes with `gloam_fetch_paid` carry the binding. Advisory: [SECURITY.md](https://github.com/gloamtrade/gloam/blob/main/SECURITY.md#advisories).
- **Unbound payments are refused by default.** `GLOAM_X402_ALLOW_UNBOUND=1` takes them from payers older than the binding, accepting that a copied ticket passes then too; a wrong binding is refused either way. Payers should upgrade as well: MCP 0.8.0 and SDK 0.6.0 and older send no binding.
- **Elysium mainnet:** `elysium-mainnet` (chain `99901`, USDC only, gas in HYPE), live since 9 November 2026. No private swaps there yet.
- **Spends no longer re-read the whole vault history.** The server keeps one tree per chain and pool, loads Gloam's public leaf list on a cold start (checked against the chain's root), and reads only new blocks after that. On Robinhood Chain a spend went from about 1,250 RPC calls and 2 minutes to 3 calls and under a second.
- The spend log is written owner-only (mode 0600), and circuit files are cached in `~/.gloam/circuits` instead of a shared temp directory (`GLOAM_ARTIFACTS_DIR` still overrides it).
- Built with `@gloamtrade/sdk` 0.7.0 and `@gloamtrade/mppx-gloam` 0.5.0.
