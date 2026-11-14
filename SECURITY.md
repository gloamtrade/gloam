# Security notes (Gloam)

Gloam runs on Robinhood Chain mainnet (`4663`), Tempo mainnet (`4217`), Base mainnet (`8453`), Ethereum mainnet (`1`) and Elysium mainnet (`99901`), with deposit limits, and with the testnets (`46630`, `42431`, Base Sepolia `84532` and Ethereum Sepolia `11155111`) next to them. The code was reviewed internally before mainnet (20 October 2026, no Critical or High findings open). Kann Audits reviewed the vault contracts (report, 1 November 2026: [gloam.trade/security](https://gloam.trade/security)) and found no Critical, High or Medium issues. The swap routers, circuits, app and relay were not part of that review. The routers (GloamVaultSwap, GloamVaultSwap2, GloamVaultSwapV4, V4b, V4c, GloamVaultSwapTempo, GloamVaultSwapTempo2, SwapEscrow and SwapEscrow2) and VaultOwnerGuard have had internal review only, most recently on 7 November 2026; an outside review of them is being sourced.

## Secrets policy

| Do | Don't |
| --- | --- |
| Put `DEPLOYER_PK` only in shell env / CI secrets | Commit private keys, mnemonics, or `.env` |
| Use public contract addresses in app defaults | Put funded mainnet keys anywhere in the repo |
| Keep the testnet zkeys labeled **dev** and the mainnet ones in `circuits/final` | Use dev keys or dev verifiers on mainnet |

## Secret scanners / git guard false positives

These are **not** private keys:

- `app/public/circuits/*.zkey` / `*.wasm`: public proving artifacts (dev keys, testnet)
- `app/public/circuits/final/*`: public proving artifacts (the ceremony's final keys, mainnet)
- `contracts/script/KeyCheckProofs.sol`: public test proofs, no secrets
- `contracts/deployments/*.json`: public addresses + explorer URLs
- `contracts/test/fixtures/*`: Poseidon bytecode for unit tests
- Long `0x…` hex that is a **transaction hash** or **contract address**

Allowlist: [`.gitleaks.toml`](./.gitleaks.toml)

If a scanner still flags a **public** tx hash or zkey, mark as false positive. If it flags a 64-byte hex that is a real private key, **rotate immediately** and purge history.

## Vault notes

- Notes (secrets) and receive keys live in the browser, encrypted at rest under a non-extractable device key, or under a passkey if the user turns that on.
- Settings → backup: plain JSON or passphrase-locked (`gloambak1.…`). Recovery keeps an end-to-end encrypted copy that only the user's wallet signature or passkey can open.
- Anyone with an unlocked backup can spend those notes.
- Who can do what, and the assumptions behind it: [gloam.trade/docs/threat-model](https://gloam.trade/docs/threat-model).

## Reporting a vulnerability

Thank you for looking. Please report privately; don't open a public issue or post details until a fix ships.

- **Where:** email [hello@gloam.trade](mailto:hello@gloam.trade) with "Security" in the subject, or DM [@gloamtrade](https://x.com/gloamtrade). A machine-readable contact is at [gloam.trade/.well-known/security.txt](https://gloam.trade/.well-known/security.txt).
- **What helps:** the affected contract, route or page, exact steps or a proof of concept, and the impact you saw. Tests on a fork, a local chain or the testnet are ideal; please never test an exploit against the mainnet pools.
- **What's in scope:** the vault and verifier contracts on mainnet and testnet, the circuits and both key sets, the app and API at gloam.trade, the relay, the SDK and the MCP server.
- **Please don't:** run attacks that degrade the service for others, touch other people's data or notes, or use social engineering.
- **What to expect:** we aim to reply within 3 days, keep you updated, and credit you once it's fixed if you'd like that.
- **Rewards:** Gloam does not run a paid bug bounty yet. We'll say so here when that changes.

## Advisories

### Payment receipts from testnets accepted as real (14 November 2026, Low)

- **Affected:** `@gloamtrade/sdk <= 0.7.0`, for anyone who checks payment receipts with `checkPaymentReceipt` and accepts receipts from more than one chain. No funds in Gloam's vaults were at risk, and gloam.trade and the Gloam API do not use this check.
- **What went wrong:** `checkPaymentReceipt` returned `ok: true` for a receipt from any Gloam network, testnets included, and its result did not say which. Base Sepolia and Ethereum Sepolia run the mainnet vault address and the final keys, and the Robinhood Chain and Tempo testnets run development keys, so a checker that built its chain client from the receipt's own chain id could credit free or made-up test value as a real payment.
- **Fixed in:** `@gloamtrade/sdk` **0.7.1** (and `@gloamtrade/mcp` **0.9.1**, built with it). The `vault` check fails on a testnet chain unless the caller passes `allowTestnet: true`, and the result carries `network` and `testnet`.
- **What to do:** upgrade (`npm i @gloamtrade/sdk@^0.7.1`) and build your chain client from the chains you accept, not from `record.chainId`.
- **Credit:** an independent security team.

### x402 payments not bound to their payee (10 November 2026, Medium)

- **Affected:** `@gloamtrade/sdk <= 0.6.0` and `@gloamtrade/mcp <= 0.8.0`, for anyone who sells over x402 with them (`settleGloamPayment`, `verifyGloamPayment`, or the MCP server's `gloam_verify_payment`).
- **What went wrong:** a payment made with the app or `buildPrivatePaymentWithReceipt` posts a sealed ticket on the public payment board so the payee can find it. That ticket has the same form as an x402 payment note, and these versions checked only the note, so anyone could copy a ticket into an `X-PAYMENT` header and be served without paying. A malformed binding was not refused either.
- **Fixed in:** `@gloamtrade/sdk` **0.7.0** and `@gloamtrade/mcp` **0.9.0**. A payment now carries a binding, an HMAC keyed by the payment note's secret over the chain, the pool, the payee's receive tag and the commitment, that only the payer and the payee can make. Sellers refuse a payment with no binding or a wrong one.
- **What to do:** sellers, upgrade (`npm i @gloamtrade/sdk@^0.7.0`, or run `@gloamtrade/mcp@0.9.0`) and serve only after `settleGloamPayment`. Payers, upgrade too (GAME agents: `@gloamtrade/game-plugin-gloam` 0.3.0): older payers send no binding, and their payments are refused by default. A seller that must still serve them can set `allowUnbound: true` (SDK) or `GLOAM_X402_ALLOW_UNBOUND=1` (MCP), accepting that a copied ticket passes then too.
- **Credit:** an independent researcher.

## Acknowledgments

With thanks to the researchers who have reported issues responsibly.

- **[@mylifechangefa1](https://x.com/mylifechangefa1)** (GitHub [EFCCWEB3](https://github.com/EFCCWEB3)): SSRF in the MCP server's `gloam_fetch_paid`. The private-address guard classified an IPv4-in-IPv6 address by its text, so an IPv4-mapped address written in hex (e.g. `::ffff:7f00:1`), long form, NAT64 (`64:ff9b::/96`) or 6to4 (`2002::/16`) slipped past it and could reach loopback or cloud-metadata services on a self-hosted server. Affected `@gloamtrade/mcp <= 0.3.0`; fixed in **0.3.1** (classify by the address bytes), with the resolved IP pinned in the connector against DNS rebinding in **0.3.2**, and credential and payment headers dropped on cross-origin redirects in **0.3.3**.
- **An independent researcher:** x402 payments not bound to their payee, so a sealed ticket copied from the public payment board passed as a payment. Affected `@gloamtrade/sdk <= 0.6.0` and `@gloamtrade/mcp <= 0.8.0`; fixed in **0.7.0** and **0.9.0** ([advisory](#advisories)).
- **An independent security team:** `checkPaymentReceipt` accepted receipts from Gloam testnets as real payments, with no testnet signal. Affected `@gloamtrade/sdk <= 0.7.0`; fixed in **0.7.1** ([advisory](#advisories)).

The Kann Audits report and its scope: [gloam.trade/security](https://gloam.trade/security). Past reviews and their findings: [`contracts/audit/REMEDIATION.md`](./contracts/audit/REMEDIATION.md).
