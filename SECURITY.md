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

## Acknowledgments

With thanks to the researchers who have reported issues responsibly.

- **[@mylifechangefa1](https://x.com/mylifechangefa1)** (GitHub [EFCCWEB3](https://github.com/EFCCWEB3)): SSRF in the MCP server's `gloam_fetch_paid`. The private-address guard classified an IPv4-in-IPv6 address by its text, so an IPv4-mapped address written in hex (e.g. `::ffff:7f00:1`), long form, NAT64 (`64:ff9b::/96`) or 6to4 (`2002::/16`) slipped past it and could reach loopback or cloud-metadata services on a self-hosted server. Affected `@gloamtrade/mcp <= 0.3.0`; fixed in **0.3.1** (classify by the address bytes), with the resolved IP pinned in the connector against DNS rebinding in **0.3.2**, and credential and payment headers dropped on cross-origin redirects in **0.3.3**.

The Kann Audits report and its scope: [gloam.trade/security](https://gloam.trade/security). Past reviews and their findings: [`contracts/audit/REMEDIATION.md`](./contracts/audit/REMEDIATION.md).
