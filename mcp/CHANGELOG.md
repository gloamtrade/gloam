# Changelog

## 0.12.0 (27 November 2026)

**Starknet**, through Starknet's own privacy pool (STRK20). **Not open yet:** until Starknet opens on Gloam, its routes refuse, and the Starknet tools answer `"status": "not_open"` without sending, reserving or logging anything.

- New tools: `gloam_starknet_info`, `gloam_starknet_balance`, `gloam_starknet_register`, `gloam_starknet_add`, `gloam_starknet_pay`, `gloam_starknet_cash_out` and `gloam_starknet_tx_status`. The agent's private Starknet account comes from `GLOAM_AGENT_PRIVATE_KEY`: the same account the Gloam app opens for that wallet (`GLOAM_STARKNET_ACCOUNT_INDEX`, default 0). The key never leaves the server and is never printed.
- What Starknet hides, in every answer: over a channel that is already open, who paid, who was paid and the amount. The first payment to someone shows their private account, adding money shows the account and the amount, and a cash out shows the destination and the amount. The pool's auditor key can read an account's private activity (registering stores its viewing key encrypted to it; it cannot spend), and Starkscan's prover sees what it proves.
- Gloam's relay deploys the account and sends every transaction, so the agent never needs STRK. Each add, payment and cash out pays the relay's fee (0.25 USDC on mainnet) inside its proof; `maxFee` caps it. A fee that changed, a balance too low, the day's proofs used (`"status": "busy"`, `"code": "quota"`) and a refusal that may have been sent each say what to do, and nothing is proven for a move that would be refused.
- Spending limits cover Starknet: the network is `starknet-mainnet` (USDC named with that network, or by its address). Adding money counts as `shield`, paying and cashing out as `pay`, with Gloam's fee counted on top. A cash out to the agent's own account needs no recipient entry. No limits still means no spending.
- `gloam_info` and `gloam_privacy_status` list Starknet as not open yet, with the line above.
- StarkWare's Starknet privacy SDK is not on npm, so the build bundles the copy Gloam vendors (with the modules it imports; its license and notice are in `dist/THIRD-PARTY-NOTICES.txt`). New dependency: `starknet` 10.5.0.
- Built with `@gloamtrade/sdk` 0.10.0.

## 0.11.1 (23 November 2026)

- **ZEC on Solana.** The `gloam_solana_*` tools take `ZEC`, Zcash bridged to Solana by NEAR's Omni Bridge (mint `A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS`, 8 decimals). `gloam_solana_info` says what stays public around it: the bridge itself and adding from the agent's wallet. Spending limits name it like SOL: `ZEC`, Solana's only, counted in ZEC (not a stablecoin). Needs the SDK release that lists it.

## 0.11.0 (23 November 2026)

**Solana**, through Helius Solana Privacy Rings (the permissionless Default Ring).

- New tools: `gloam_solana_info`, `gloam_solana_balance`, `gloam_solana_register`, `gloam_solana_add`, `gloam_solana_pay`, `gloam_solana_cash_out` and `gloam_solana_tx_status`. Set `GLOAM_AGENT_SOLANA_KEY` (a Solana keypair file's JSON array, or its base58 text) in the environment or `~/.gloam/agent.env`; it opens the same private account the Gloam app opens for that wallet (`GLOAM_SOLANA_ACCOUNT_INDEX`, default 0). The key never leaves the server and is never printed; a malformed one stops the server at start.
- What Solana hides, in every answer: the asset and the amount of a private payment. The two private accounts a payment moves between are visible, adding money shows the wallet it came from, a cash out shows its destination, asset and amount, and proofs are made by Helius's prover.
- Gloam's relay pays the fees of registering, paying and cashing out, so the private account never needs SOL. Adding money is paid by the agent's wallet.
- Spending limits cover Solana: the network is `solana-mainnet` (SOL, and USDC and USDT named with that network, or `GLOAM_LIMIT_NETWORK=solana-mainnet`). Adding money counts as `shield`, paying and cashing out as `pay`. A cash out to the agent's own wallet needs no recipient entry. No limits still means no spending.
- Sends never wait forever: each returns `landed`, or `pending` with its signature and blockhash after `timeoutMs` (default 120 s). A relay refusal says whether anything may have been sent; `gloam_solana_tx_status` tells landed, failed, dropped (safe to resend) and pending apart.
- `gloam_info` and `gloam_privacy_status` list Solana with the line above.
- Built with `@gloamtrade/sdk` 0.9.0. New dependencies: `@heliuslabs/spr` 0.9.0-alpha and `@solana/kit`.

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
