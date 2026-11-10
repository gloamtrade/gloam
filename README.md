<div align="center">

# Gloam

### Private money on public chains. Private stablecoin payments for people, teams and AI agents: private by default, provable on demand.

[gloam.trade](https://gloam.trade) · [App](https://gloam.trade/app) · [Verify a proof](https://gloam.trade/verify) · [Research report and deck](https://gloam.trade/pitch) · [How Gloam compares](https://gloam.trade/docs/compare) · [Docs](https://gloam.trade/docs) · [Whitepaper](https://gloam.trade/whitepaper) · [@gloamtrade](https://x.com/gloamtrade)

**Live on mainnet:** Robinhood Chain `4663` · Tempo `4217` · Base `8453` · Ethereum `1` · Elysium `99901` · real ZK proofs, no mock fills

</div>

![Gloam: private money on public chains](https://raw.githubusercontent.com/gloamtrade/gloam/main/app/public/media/readme-home.jpg)

---

Stablecoins are becoming how businesses and AI agents pay each other, and every one of those payments is public. Gloam makes them private, and lets the payer prove exactly what someone needs to see: a balance above a figure, that a payment was made, or a payroll total, to one named reader, with an expiry. It is live on five mainnets, Robinhood Chain, Tempo, Base, Ethereum and Elysium, with deposit limits. You can pay anyone privately, send money as a claim link, run payroll, swap straight from the private balance (who swapped stays private; the tokens and amounts are public, like any DEX trade), and cash out at once or privately in pieces over time.

**Why one owner matters.** Privacy splits into two jobs. Shared secrets (sealed auctions, order books, lending pools) need someone to compute on many people's hidden data, so FHE and MPC networks such as Zama and Arcium use a committee that holds keys. A payment has one owner, so the owner proves it on their own device with zero-knowledge proofs, and nobody else ever holds a key. If a committee or operator is breached, everyone can be exposed, past payments included. If one owner's device is breached, one person is. Gloam does not invent new cryptography: it uses the proven ZK maths of the Zcash lineage and builds the payments product on top. Full comparison with Zama, Arcium, Tempo Zones, Helius Privacy and Railgun: [gloam.trade/docs/compare](https://gloam.trade/docs/compare).

## What is new

Gloam is not new cryptography. It is a new building block for finance: private payments you can prove. As far as our research found, three parts are new:

1. **Payroll total proof.** `payroll_total` proves a run of up to 32 payments adds up to exactly a total, all funded by the prover, without showing who got what. We found nothing like it.
2. **Proofs scoped to one reader.** The label (who the proof is for), expiry, chain and pool are hashed into a public `context` input bound into the `solvency`, `receipt` and `payroll_total` proofs. Change the label and the proof fails. Anyone can check one in a browser, with no wallet, at [`/verify`](https://gloam.trade/verify). Viewing keys, the usual alternative, show a whole history and cannot be taken back.
3. **Private payments for AI agents.** A private payment method proposed for the Machine Payments Protocol from Tempo and Stripe ([tempoxyz/mpp-specs#376](https://github.com/tempoxyz/mpp-specs/pull/376); MPP had no private method), private x402 payments, and an MCP server that gives agents handles instead of secrets, with spending limits.

Not new: the private pool design (Zcash lineage from 2016, Tornado, Railgun, Cloak) and selective disclosure as an idea (Zcash and Railgun viewing keys, Privacy Pools, Zama decryption rights). One honest limit: a reader can still forward a proof. It says who it was for and when it expires, and a designated-verifier mode is next.

## Three surfaces, one private core

The vault app is the reference implementation, not the whole product.

| Surface | What it is | Package |
| --- | --- | --- |
| **SDK** | Drop shielded balances, private sends, and selective disclosure into any onchain app or agent, on Robinhood Chain, Tempo, Base or Ethereum. Unsigned intents + client proving. | [`@gloamtrade/sdk`](./packages/sdk) |
| **Agents** | An MCP server + a reference wrapper so an AI agent can shield, move value, and pay for tools privately over x402 or MPP, under policy. | [`@gloamtrade/mcp`](./mcp) · [`@gloamtrade/mppx-gloam`](./packages/mppx-gloam) · [`examples/`](./examples) |
| **Vault** | The live app on all five mainnets that proves the whole path works. | [`app/`](./app) |
| **Partner API** | Apps add private payments with an API key, set their own fee (flat per private payment, a share of cash outs and deposits), and see attributed volume and would-be fees live in the partner portal. Partner fees are not collected yet, on mainnet either: every response says `"charged": false` and the portal shows what the setting would earn. Only Gloam's own 0.5% cash-out fee is taken on mainnet. Live keys (`gloam_live_`) are for the mainnets, test keys (`gloam_test_`) for the testnets. | [`/partners`](https://gloam.trade/partners) · [`/docs/partners`](https://gloam.trade/docs/partners) · `GloamApiClient` |

![The Gloam app: a private balance only you can see](https://raw.githubusercontent.com/gloamtrade/gloam/main/app/public/media/readme-app.jpg)

All three share one core: a Poseidon note scheme, a depth-20 incremental Merkle tree, circom witness builders, real Groth16 verification, and one canonical intent shape.

## Mainnet

Gloam is live on Robinhood Chain mainnet (`4663`) and Tempo mainnet (`4217`) since Wednesday 21 October 2026, 13:00 UTC, and on Base mainnet (`8453`) and Ethereum mainnet (`1`) since 26 October 2026, and on Elysium mainnet (`99901`) since 9 November 2026 ([below](#live-on-elysium)). The vault has the same address on the first four, `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194`; Elysium's is `0x89d3042390204f57b8b4F8949D3c2203E4002164`. It was reviewed internally before launch (20 October 2026, no Critical or High findings open), and an independent review on 23 October found no new exploitable contract flaw and eight app issues, and fixes in each of the areas it named were merged by 24 October. Kann Audits reviewed the vault contracts (report, 1 November 2026: [gloam.trade/security](https://gloam.trade/security)) and found no Critical, High or Medium issues; the swap routers, circuits, app and relay were not part of it.

| | Robinhood Chain `4663` | Tempo `4217` | Base `8453` | Ethereum `1` | Elysium `99901` |
| --- | --- | --- | --- | --- | --- |
| Live since | 21 October 2026 | 21 October 2026 | 26 October 2026 | 26 October 2026 | 9 November 2026 |
| Pool | `ShieldPoolPayments`, payments only | `ShieldPoolPayments`, payments only | `ShieldPoolPayments`, payments only | `ShieldPoolPayments`, payments only | `ShieldPoolPayments`, payments only, owned by a `VaultOwnerGuard` |
| Assets | USDG, $GLOAM, PONS, CASHCAT, ETH, AI, ORBIO; GRIFT once its timelocked limit lands | USDC.e, pathUSD, USDT0, OUSD | USDC, EURC, USDT, ETH | USDC, USDT, USDG, PYUSD, EURC, ETH | USDC |
| Gas | ETH | Paid in stablecoins | ETH | ETH; the relay waits while gas is above its ceiling | HYPE |
| Keys | Final keys from the trusted setup | Final keys from the trusted setup | Final keys from the trusted setup | Final keys from the trusted setup | Final keys from the trusted setup |
| Private swaps | Router v2 (`GloamVaultSwapV4b`) swaps the 29 tokens it lists, stock tokens and ETH (as WETH) included, over allowlisted Uniswap v4 pools. Router v1 (`GloamVaultSwapV4`) stays for refunds | USDC.e, pathUSD, USDT0, OUSD on Tempo's stablecoin exchange (`GloamVaultSwapTempo`) | Not yet | Not yet | Not yet |

- **Fees.** Direct deposits and private payments are free. Cashing out costs 0.5%, taken when the cash out lands, at the vault's rate that day. A private swap pays the same 0.5% on the amount swapped, plus a price buffer (0.5% on Robinhood Chain, 0.1% on Tempo) whose unused part goes to the treasury. Money bridged in from another chain pays Relay's fee, and Gloam's own fee when one is set, shown before you send. Since 24 October fees go to their own treasury wallet (`0xB390…30B8`), and half of them are set to buy back $GLOAM, half of that burned and half kept.
- **Deposit limits.** 50,000 per deposit and 2,500,000 in total for each stablecoin; ETH on Base and Ethereum 20 per deposit and 1,000 in total, and on Robinhood Chain 11 and 110; $GLOAM 2,500,000 per deposit and 25,000,000 in total; USDC on Elysium 500 per deposit and 25,000 in total. Cash outs and private payments are never limited. Raising a limit or adding an asset waits a public 3-day timelock; the owner can lower limits or close deposits at once.
- **Keys.** Mainnet proofs use the final keys from the 13-contributor trusted setup (drand round 6561386, release `ceremony-final`).
- **Partners.** [Raeto](https://raeto.cc) funds AI agents from a private Gloam balance, and [Agent Wormhole](https://agentwormhole.com) checks an agent's payment request before it pays (MCP 0.4.0, optional).

Addresses are in [Contracts](#architecture) below.

## What works today (real ZK proofs)

Everything here runs on the Robinhood Chain, Tempo, Base and Ethereum mainnets unless the row says otherwise. What Elysium has so far is [below](#live-on-elysium).

| Path | Status | What you can do |
| --- | --- | --- |
| **Shield** | Live, proof-gated | Deposit USDG (Paxos Global Dollar) and $GLOAM on Robinhood Chain; USDC.e, pathUSD, USDT0 and OUSD on Tempo; USDC, EURC, USDT and ETH on Base; USDC, USDT, USDG, PYUSD, EURC and ETH on Ethereum, within the deposit limits. The pool enforces `shieldBound()` so a deposit proves `commitment == Poseidon(secret, amount, asset)` (audit C1) |
| **Private send** | Live | Send inside the vault to a Gloam address. The recipient finds it through an encrypted heads-up on the payment board (`GloamPayMemo`) on each chain, which never logs who posted. The Gloam relay posts the heads-up, so your wallet is not the sender either |
| **Private payroll** | Live | Upload a CSV and pay a whole team at once in any vault stablecoin. Gloam-address payees are paid directly and get an encrypted heads-up; everyone else gets a claim link. Crash-safe resume, results export. [Docs](https://gloam.trade/docs/payroll) |
| **Scheduled payroll** | Live | Save a pay list as a schedule (monthly, every two weeks, weekly or one time) with a cap per run and an end date. A "Payroll due" reminder runs it in one click. Runs happen in your browser because only you hold the keys; schedules are encrypted at rest |
| **Payment requests** | Live | Share a link or QR that opens Pay with your Gloam address, amount, asset and reference filled in. The details sit after the `#`, so they never reach a server and nothing about the request goes on-chain |
| **Claim links** | Live | Send money to anyone as a link. Claiming is free: no gas, no seed phrase, nothing to buy. The claim moves the payment into a fresh note only the claimer knows, so the sender cannot spend it back |
| **Gloam relay** | Live | Submits proven sends, cash outs, private swaps and payment memos from a Gloam account so the user's wallet never appears. One request per spend at a time, small memos only, and no cash out to the vault itself. Dry-runs every payment against the pool first; cash-out recipients are bound in the proof, so the relay can only submit or refuse. On mainnet the Gloam team runs the relayer at launch: it pays gas and cannot move or redirect money. SDK `relayIntent`, MCP `GLOAM_USE_RELAY=1` |
| **Passkey lock** | Live, optional | Protect the private balance on a browser with a passkey (Face ID, Touch ID, security key). The WebAuthn PRF output wraps the key that encrypts notes at rest, so the app unlocks only with the passkey. Backups stay restorable without it. Browsers without PRF keep the device key. [Docs](https://gloam.trade/docs/privacy-model#security) |
| **Sanctions screening** | Live | Checked against a vendored snapshot of the OFAC sanctioned-address list (EVM): the depositing wallet in the app before signing and at `/api/screen`, and every cash-out address inside the relay before it submits. Public addresses only; a blocked wallet sees one neutral message. Refresh with `node app/scripts/refresh-ofac-list.mjs`; optional Chainalysis check via `CHAINALYSIS_API_KEY` |
| **Issuer policies (Tempo)** | Live | Deposits and cash outs on Tempo also respect the stablecoin's TIP-403 transfer policy: the wallet must be allowed to send and the vault to receive on deposit, the vault to send and the recipient to receive on cash out. Read-only checks in the app, at `/api/screen` and in the relay, next to sanctions screening, with a warning when an issuer policy or pause would block the vault itself. Compliant privacy with no operator |
| **Cash out** | Live, proof-gated | Unshield to a public balance with a real browser-generated Groth16 proof. **Now** sends it in one go. **Privately** splits it into 2 to 4 ordinary-looking pieces and sends each through the relay at its own time over a window you pick, so the amount coming out does not match money that went in. The pool keeps 0.5%; cash outs are never limited |
| **Exact balance** | Live, new format | Prove one private balance exactly, revealing nothing else. A `gloambal1` proof is made on the device from the receipt circuit with the amount shown, carries a label and an expiry, and never goes on chain. The older `gloamdisc1` disclosure is retired: anyone could copy one from a public deposit, so `/verify` no longer accepts it |
| **Proof of funds** | Live, new circuit | Prove you hold *at least* an amount across up to four private balances, without showing the balance. A `gloamfunds1` proof carries a label (who it is for) and an expiry, both bound into the proof; it is verified off-chain at [`/verify`](https://gloam.trade/verify), in the browser against the live vault, including that the backing balances are still unspent. [Docs](https://gloam.trade/docs/proofs) |
| **Proof of payment** | Live, new circuit | A `gloampay1` receipt showing a private payment was made (either side of the payment can make one; it does not yet show who paid or who received): show the amount, or only that it was at least some amount, anchored to the real payment in the vault. Same label and expiry, verified off-chain at `/verify`. The checker fails closed: a payment it cannot confirm on chain, a change output or a deposit never passes |
| **Payroll total proof** | Live, new circuit | A `gloamroll1` proof that a payroll run paid exactly a total in a given number of private payments, without showing any single amount. Same label and expiry, verified off-chain at `/verify` |
| **Private agent payments (x402)** | SDK + MCP live | Agents pay for tools over HTTP 402 with a private send. The payment note is sealed to the payee's receive tag, and the payee sweeps it into a fresh note before serving, so the payer cannot spend it back. Optional [Agent Wormhole](https://agentwormhole.com) check in MCP 0.4.0 (`GLOAM_WORMHOLE_KEY`): the payment request is checked before anything is proved, and only an allow pays. `settleGloamPayment` in the SDK, `gloam_fetch_paid` / `gloam_verify_payment` in the MCP server |
| **Agent spending limits** | Live (MCP) | The owner sets each agent's assets, per-payment and per-day caps, allowed recipients, tools and expiry. Every spend is checked and logged before it is proved or signed; no limits means no spending. Note secrets stay in an encrypted store inside the server and the agent only sees handles. Enforced by the MCP server, off-chain. `gloam_get_limits`, `gloam_get_spending_report`. [Config](./mcp/README.md#spending-limits) |
| **Hosted MCP server** | Live | Paste `https://www.gloam.trade/mcp` into Claude (Settings, Connectors, Add custom connector), ChatGPT, Cursor or any MCP client; nothing to install. Read and plan only: networks and assets, vault stats, payment request links, proof checks, deposit plans and MPP how-to. It never signs and refuses anything that looks like a key or note secret; for signing, the local server (`npx -y @gloamtrade/mcp`). [Docs](https://gloam.trade/docs/agents#connect-by-url) |
| **Transparency page** | Live | [`/transparency`](https://gloam.trade/transparency) shows what anyone can see about the vault on each network: what it holds, counts of deposits, private transfers, cash-outs and payment messages, and recent public activity, read straight from public nodes |
| **Private swaps** | Live (not on Base, Ethereum or Elysium yet) | The next router (`GloamVaultSwapV4c`: native ETH notes, stablecoin swaps on Base and Ethereum, an exit for a refund that can't land) is built and not deployed: [DEPLOY-ROUTER.md](DEPLOY-ROUTER.md). Swap straight from the private balance in Vault > Swap: on Robinhood Chain, router v2 (`GloamVaultSwapV4b`) swaps the 29 tokens it lists, stock tokens and ETH (as WETH) included, over allowlisted Uniswap v4 pools; on Tempo, USDC.e, pathUSD, USDT0 and OUSD (Tempo's stablecoin exchange). One relayed transaction unshields one note to a one-time CREATE2 escrow (`SwapEscrow`), buys an exact output, and shields it back as a new note. Who swapped, which note paid and where the output goes next stay private; the tokens and amounts are public. If someone sends the unshield step alone, the swap fails safely and 99% of the note comes back as a refund note. The v1 routers have no owner, admin or upgrade, and v1 on Robinhood Chain stays for refunds. Router v2's owner can only add a pool after a public 3-day delay, or remove one; pools for AI and ORBIO are queued for 3 November. [Docs](https://gloam.trade/docs/private-swaps) |
| **Sealed trade** | Retired | `sealedSwap` was the first private trade design. It stays off on every network (the mainnet pool has no swap code at all), after audit H1 (solvency) and a rate overflow found on 2026-10-11 (ZK-1). Private swaps replaced it |

Every private action is proof-gated on-chain. No mock fills, no theatrical privacy. If a path cannot be both private and solvent yet, it waits. See [`contracts/audit/H1-SWAP-SOLVENCY.md`](./contracts/audit/H1-SWAP-SOLVENCY.md).

## Selective disclosure: private by default, proven by choice

The answer to the "dark pool" objection. A holder proves one fact about their money to one reader, and nothing else. Four proofs: `gloambal1` (exact balance), `gloamfunds1` (at least an amount), `gloampay1` (a payment was made) and `gloamroll1` (payroll total). Each carries a label naming who it is for and an expiry, both bound into the proof, and each is checked off-chain at [`/verify`](https://gloam.trade/verify) against the live vault, with no wallet. Make them at `/app/disclose`.

What they do not prove is said plainly on the verify page: a proof of payment shows a payment was made, not which side of it the holder was on, because notes do not yet bind a recipient key. The original `gloamdisc1` format reused the deposit statement, so anyone could copy one from public deposit data; it is retired and never verifies.

## Robinhood Chain native

Robinhood Chain is an **Arbitrum Orbit L2** (Nitro, mainnet live since July 2026), ETH gas, Ethereum blob DA. Gloam targets what the chain actually ships:

- **Chainlink oracles from block zero.** RH Chain prices tokenized equities on-chain via standard `AggregatorV3` feeds. Gloam's `OracleRates` module binds sealed-trade rates to the live feed with L2 sequencer-uptime, staleness, and positivity guards, and a ratio-tolerance check that is also on-chain slippage protection. Built and tested (`contracts/src/lib/OracleRates.sol`) for the sealed trade, which is retired. Private swaps take the DEX pool's own price.
- **Tokenized stocks are ERC-20s** (18 decimals, ERC-8056 Total-Return value). The vault has taken stock tokens and other liquid Robinhood Chain tokens since 27 October, and private swaps through router v2 buy them into the private balance and sell them back out.
- **Groth16 runs native.** bn254 pairing precompiles are present and the 96 KB code-size cap fits large verifier contracts, so shield / unshield / transfer proofs verify with no special infra.
- **First-class ERC-4337** opens the door to gasless private transactions.

## Live on Tempo

The same private core runs on [Tempo](https://tempo.xyz) mainnet (`4217`), the payments-first stablecoin L1, as private stablecoin payments for people and agents. Tempo ships its own operator-run privacy (Zones); Gloam is the self-custodial, permissionless complement, with selective disclosure a user can hand an issuer or auditor. Shield USDC.e, pathUSD, USDT0 or OUSD, send, swap and cash out, proof-gated end to end. Because Tempo blocks native `msg.value` and pays gas in stablecoins, Gloam shields ERC-20 stablecoins there instead of a native asset. Design and constraints: [`TEMPO_EXPANSION.md`](./TEMPO_EXPANSION.md).

## Live on Base

Base (an Ethereum L2 on the OP Stack) is the third chain. Base mainnet (`8453`) is live since 26 October 2026, and Base Sepolia (`84532`) is its testnet, live since 24 October 2026. Both run the mainnet vault (`ShieldPoolPayments` on the final keys, deposit limits, a cash-out fee of 0.5% on Base mainnet and 0.25% on Base Sepolia), so Base Sepolia is a testnet on the mainnet contract and keys.

- **Assets.** USDC, EURC and ETH on both; USDT (Tether bridged from Ethereum) on mainnet only, since Base Sepolia has none. On Base mainnet each stablecoin takes 50,000 per deposit and 2,500,000 in total, and ETH 20 per deposit and 1,000 in total. On Base Sepolia each stablecoin takes 500 per deposit and 25,000 in total, and ETH 0.2 per deposit and 10 in total.
- **Base Sepolia.** Vault `0x39e28cde55cab798874746ac52cb4b5cc99a0194` (deploy block `49802958`) and payment-message board `0x01B3172d9900Cb26d57E986429b9b23854c74598`, the same addresses as on the other chains, every contract source-verified on Sourcify. Test USDC and EURC from [faucet.circle.com](https://faucet.circle.com/), test ETH from a Base Sepolia faucet. Addresses: [`contracts/deployments/base-sepolia.json`](./contracts/deployments/base-sepolia.json).
- **Base mainnet.** Vault `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194` (deploy block `53109632`) and payment-message board `0xfCa1887e77f738ef9C5751974b3f3873d029F2DC`. Addresses: [`contracts/deployments/base-mainnet.json`](./contracts/deployments/base-mainnet.json).
- **Later.** Private swaps on Base (the next router, on Uniswap v4). Bringing money over into Base (the Relay bridge) is live since 26 October 2026.

Runbook: [`DEPLOY-BASE.md`](./DEPLOY-BASE.md).

## Live on Ethereum

Ethereum mainnet (`1`) is the fourth chain, live since 26 October 2026, on the same mainnet vault (`ShieldPoolPayments`, the final keys, deposit limits, the 0.5% cash-out fee). Its testnet is Ethereum Sepolia, below, on the same contract and keys.

- **Assets.** USDC, USDT, USDG, PYUSD and EURC, each 50,000 per deposit and 2,500,000 in total, and ETH, 20 per deposit and 1,000 in total.
- **Gas.** The Gloam relay pays Ethereum gas for relayed private sends and cash outs only while gas is under its ceiling (3 gwei by default); above it the relay waits and the app says so, and a cash out for later waits for gas to come down.
- **Contracts.** Vault `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194` (deploy block `26276183`) and payment-message board `0x8699D015087dE6D25d55d5ceB63b34b9d773f135`. Addresses: [`contracts/deployments/ethereum-mainnet.json`](./contracts/deployments/ethereum-mainnet.json).

Runbook: [`DEPLOY-ETHEREUM.md`](./DEPLOY-ETHEREUM.md).

## Live on Elysium

Elysium mainnet (`99901`) is the fifth chain, live since 9 November 2026. Elysium is Kinetiq's Hyperliquid L2, an Arbitrum Orbit chain that settles to HyperEVM, with HYPE as its gas coin. Gloam there is the same vault (`ShieldPoolPayments`, the final keys, deposit limits, the 0.5% cash-out fee), with one difference: its owner is a `VaultOwnerGuard` from the deploy itself, so its proof checkers can never be replaced and its ownership can never move.

- **Contracts.** Vault `0x89d3042390204f57b8b4F8949D3c2203E4002164` (deploy block `3248495`), owned by the guard `0x268D7CAd645282D1e77461b5B2dd997bd54eFAf5`. No payment-message board yet. Addresses: [`contracts/deployments/elysium-mainnet.json`](./contracts/deployments/elysium-mainnet.json).
- **Assets.** USDC, 500 per deposit and 25,000 in total. HYPE, the gas coin, is not a pool asset.
- **Bring money over.** Into Elysium USDC from other chains through Relay, or swap HYPE into USDC on Elysium.
- **Not on Elysium yet.** Private swaps, and a Gloam testnet (Elysium testnet `99801` is known to the SDK and switched off until its vault is deployed).
- **SDK and MCP.** The SDK and the local MCP server in this repo know Elysium mainnet as `elysium-mainnet`; on npm it arrives with the release after `@gloamtrade/sdk` 0.6.0 and `@gloamtrade/mcp` 0.8.0.

Runbook: [`DEPLOY-ELYSIUM.md`](./DEPLOY-ELYSIUM.md).

## Ethereum Sepolia: testnet live

Ethereum Sepolia (`11155111`) runs the mainnet vault the same way as Base Sepolia: `ShieldPoolPayments` on the final keys, deposit limits, the 0.25% cash-out fee. It takes test USDC and EURC (Circle), test USDG and PYUSD (Paxos), and ETH, each stablecoin at 500 per deposit and 25,000 in total, ETH at 0.2 and 10. It is live since 25 October 2026: vault `0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef` (deploy block `11992914`) and payment-message board `0x8699D015087dE6D25d55d5ceB63b34b9d773f135` (block `11992942`), in the app now and in the SDK and the MCP server from their next release. Addresses: [`contracts/deployments/ethereum-sepolia.json`](./contracts/deployments/ethereum-sepolia.json). Runbook: [`DEPLOY-ETHEREUM-SEPOLIA.md`](./DEPLOY-ETHEREUM-SEPOLIA.md).

## Trust, verified

Privacy has to be checkable and correct before mainnet. This is where it stands on mainnet.

- **Where review stands.** An internal pre-mainnet review finished on 20 October 2026 with no Critical or High findings open. An independent review on 23 October found no new exploitable contract flaw and eight issues in the app (amount entry, saving notes, payroll resume and addresses, API key rotation, and two displayed figures). Fixes in each of those areas were merged by 24 October. Kann Audits reviewed the vault contracts (report, 1 November 2026: [gloam.trade/security](https://gloam.trade/security)) and found no Critical, High or Medium issues. Its findings are acknowledged and not fixed: the vault cannot be upgraded, so changes land in the next vault. The swap routers, circuits, app and relay were not part of that review. The routers and VaultOwnerGuard have had internal review only, most recently on 7 November 2026, and an outside review of them is being sourced. Deposit limits cap what each pool can take in.
- **Earlier reviews.** Kensho reviews of the contracts and an independent review of the circuits (latest 2026-10-11) found no way to steal, inflate, double-spend or redirect pool funds. What they did find is fixed or switched off: an earlier critical drain in the first sealed pool (drained and de-published), value binding at deposit (C1), swap solvency (H1, the sealed trade is retired), an overclaiming proof checker and a copyable legacy disclosure. Every finding and its status: [`contracts/audit/REMEDIATION.md`](./contracts/audit/REMEDIATION.md).
- **No admin withdraw, timelocked rule changes.** There is no function the team can call to take pooled funds, and notes leave only through an unshield proof. The mainnet pools end setup in the same deploy run that creates them (`endSetup()`), so a new verifier, a raised deposit limit, a new asset or a higher fee must be queued on-chain and waits a public 3-day delay before it can run (`queueChange`). Lowering a limit or closing deposits works at once. Verify `setupMode() == false` on the pools listed below. Each vault's ownership moves to [`VaultOwnerGuard`](./contracts/src/VaultOwnerGuard.sol), which forwards only limit and fee changes and the sweep of stray native coin: on a vault it holds, `setVerifier` can never run again. Read `owner()` on a vault to see which holds it.
- **Selective disclosure, not a mixer.** Prove balance or a payment to a counterparty or auditor without revealing everything. The right posture for a regulated-sponsor chain.
- **Fast vault sync, same privacy.** The app loads the vault's public leaf list (every commitment, in order) from `/api/vault-leaves` in one request instead of walking the chain, rebuilds the Merkle tree in the browser, and uses it only if the root matches the pool's on-chain root; otherwise it reads the chain itself. The request names only the network and is the same for everyone, so the server never learns which notes are yours.
- **Honest gates.** Mainnet runs on the final keys from the multi-party trusted setup (13 contributors, drand round 6561386, release `ceremony-final`): the deploy script refuses to create a pool unless the verifiers on chain accept final-key proofs and reject dev-key ones. Cash-out fees go to a dedicated treasury wallet since 24 October (a change that waited out the timelock); the owner is one wallet, and a multisig is planned. The Gloam team runs the relayer: it only submits already-proven transactions and pays gas, and cannot move or redirect money. Note secrets and the receive key are encrypted at rest (AES-GCM under a non-extractable device key, or wrapped by a passkey PRF), audit M-1. A payment someone sends you is moved into a fresh note only you know as you claim it, so the sender cannot spend it back.

## Using the SDK

Deposit privately into the pool in a few lines. The SDK mints the note and generates the shield proof; you sign the resolved call. This deposits USDC.e on Tempo mainnet (`@gloamtrade/sdk` 0.4.6):

```ts
import { mainnetNetwork, buildShieldBoundIntent, artifactProver, circuitArtifactUrls, TEMPO_USDCE } from "@gloamtrade/sdk";

const net = mainnetNetwork("tempo")!;
const intent = await buildShieldBoundIntent({
  chainId: net.chainId,
  poolAddress: net.pool,
  asset: TEMPO_USDCE,
  amountWei: 25_000_000n,                    // 25 USDC.e (6 decimals); the limit is 50,000 per deposit
  prover: artifactProver(circuitArtifactUrls("shield", net.chainId)),
});

// intent.exec is the resolved shieldBound(asset, amount, commitment, proof) call.
// The wallet approves the pool for the amount first (the pool pulls the token with transferFrom).
// Persist intent.note.secret to spend the balance later.
await wallet.writeContract({ ...intent.exec, abi: shieldPoolAbi });
```

- Pass a mainnet network explicitly: for backward compatibility the SDK still defaults to the testnet. `getGloamNetwork(key)` takes `"robinhood-mainnet"`, `"tempo-mainnet"`, `"base-mainnet"` or `"ethereum-mainnet"` (the last two from SDK 0.3.0 and 0.4.0), and `circuitArtifactUrls` picks the final keys for a mainnet chain.
- To take payments, `scanIncomingPayments` reads the payment board for payments sealed to your Gloam address, and `sweepReceivedNote` moves each into a fresh note so the payer cannot spend it back. See [`packages/sdk/examples/receive-and-credit.ts`](./packages/sdk/examples/receive-and-credit.ts).
- `cashOutFee(amount)` returns what the pool keeps on a mainnet cash out (`CASH_OUT_FEE_BPS = 50`, 0.5%). `readCashOutFeeBps(client, pool)` reads a vault's live rate.

Runnable examples are in [`examples/`](./examples): an agent that shields (`agent-shield`), a pay bot, private x402 and MPP payments, and a web shield. Start a new app with `npx create-gloam-app`.

## Architecture

```
gloam/
  packages/sdk/          @gloamtrade/sdk  the private path as a reusable package
  packages/mppx-gloam/   private payment method for the Machine Payments Protocol
  packages/create-gloam-app/  starter for a new app on the SDK
  mcp/                   @gloamtrade/mcp  agent server (plan + signed execution)
  examples/              agent-shield, pay-bot, pay-x402, mpp-gloam, web-shield
  app/                   Next.js reference app + docs → Vercel root: app
  contracts/             Foundry · ShieldPoolPayments (mainnet) and ShieldPoolPoseidon (testnet) vaults, verifiers, circuits, audit
```

**Contracts: Robinhood Chain mainnet `4663`**

| Role | Address |
| --- | --- |
| Payments vault `ShieldPoolPayments` (payments only, no admin withdraw, 3-day timelock on rule changes) | [`0x39e28cde55cab798874746ac52cb4b5cc99a0194`](https://robin.etherscan.io/address/0x39e28cde55cab798874746ac52cb4b5cc99a0194) |
| Deploy block | `94194599` |
| `PoseidonT3` | [`0x1a32…9Cb4`](https://robin.etherscan.io/address/0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4) |
| Owner (one wallet; a multisig is planned) | [`0x76b7…D4D8`](https://robin.etherscan.io/address/0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8) |
| Relayer (run by the Gloam team; submits proven transactions and pays gas, cannot move or redirect money) | [`0xb1E9…512e`](https://robin.etherscan.io/address/0xb1E994586E62994648a0b866BF33F2EDd942512e) |
| Private swap router `GloamVaultSwapV4` (Uniswap v4, three pools fixed at deploy; no owner, admin or upgrade) | [`0x34AB…c52d`](https://robin.etherscan.io/address/0x34AB06208586A737Bf1607fa996Bc9162271c52d) |
| Private swap router v2 `GloamVaultSwapV4b` (allowlisted Uniswap v4 pools, ETH via WETH, up to 3 hops; pools added only after a 3-day delay; new swaps go through it, and v1 stays for refunds) | [`0xfCa1…F2DC`](https://robin.etherscan.io/address/0xfCa1887e77f738ef9C5751974b3f3873d029F2DC) |
| Payment board `GloamPayMemo` (encrypted heads-ups; no owner, never logs the poster) | [`0x01B3…4598`](https://robin.etherscan.io/address/0x01B3172d9900Cb26d57E986429b9b23854c74598) |
| Treasury (cash-out fees since 24 October, and where a swap's unused input goes, fixed in the router) | [`0xB390…30B8`](https://robin.etherscan.io/address/0xB3900ac9350903218e4c7597bAb0f008F01B30B8) |

| Asset | Address | Deposit limit (per deposit / total) |
| --- | --- | --- |
| USDG (6 decimals) | [`0x5fc5…d168`](https://robin.etherscan.io/address/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) | 50,000 / 2,500,000 |
| $GLOAM (18 decimals) | [`0xDcD8…724d`](https://robin.etherscan.io/address/0xDcD885F5c60b3aD49F6D58718696417314e8724d) | 2,500,000 / 25,000,000 |

**Contracts: Tempo mainnet `4217`**

| Role | Address |
| --- | --- |
| Payments vault `ShieldPoolPayments` (payments only, no admin withdraw, 3-day timelock on rule changes) | [`0x39e28cde55cab798874746ac52cb4b5cc99a0194`](https://explore.tempo.xyz/address/0x39e28cde55cab798874746ac52cb4b5cc99a0194) |
| Deploy block | `45172561` |
| `PoseidonT3` | [`0x1a32…9Cb4`](https://explore.tempo.xyz/address/0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4) |
| Owner (one wallet; a multisig is planned) | [`0x76b7…D4D8`](https://explore.tempo.xyz/address/0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8) |
| Relayer (run by the Gloam team; submits proven transactions and pays gas, cannot move or redirect money) | [`0xb1E9…512e`](https://explore.tempo.xyz/address/0xb1E994586E62994648a0b866BF33F2EDd942512e) |
| Private swap router `GloamVaultSwapTempo` (Tempo's stablecoin exchange; no owner, admin or upgrade) | [`0xfCa1…F2DC`](https://explore.tempo.xyz/address/0xfCa1887e77f738ef9C5751974b3f3873d029F2DC) |
| Payment board `GloamPayMemo` (encrypted heads-ups; no owner, never logs the poster) | [`0x342E…C1c4`](https://explore.tempo.xyz/address/0x342E3745967FDB4223902E196Ceb792c15d8C1c4) |
| Treasury (cash-out fees since 24 October, and where a swap's unused input goes, fixed in the router) | [`0xB390…30B8`](https://explore.tempo.xyz/address/0xB3900ac9350903218e4c7597bAb0f008F01B30B8) |

| Asset (TIP-20, 6 decimals) | Address | Deposit limit (per deposit / total) |
| --- | --- | --- |
| USDC.e | [`0x20c0…8b50`](https://explore.tempo.xyz/address/0x20c000000000000000000000b9537d11c60e8b50) | 50,000 / 2,500,000 |
| pathUSD | [`0x20c0…0000`](https://explore.tempo.xyz/address/0x20c0000000000000000000000000000000000000) | 50,000 / 2,500,000 |
| USDT0 | [`0x20c0…eb73`](https://explore.tempo.xyz/address/0x20c00000000000000000000014f22ca97301eb73) | 50,000 / 2,500,000 |
| OUSD | [`0x20c0…74be`](https://explore.tempo.xyz/address/0x20c0000000000000000000006a37da5c996874be) | 50,000 / 2,500,000 |

On every mainnet: direct deposits and private payments are free, and a cash out costs 0.5%. The pools run on the trusted setup's final keys; read the verifiers from the pool (`verifier()`, `shieldVerifier()`).

Circuits (Groth16 on BN254, Circom 2.1.6, Poseidon, depth-20 Merkle membership): `shield`, `transfer`, `unshield` and `sealedSwap` (retired) for the pool, plus `solvency`, `receipt` and `payroll_total` for the off-chain proofs. Constraint counts and key sets are in [`contracts/circuits/README.md`](./contracts/circuits/README.md).

## Local

```bash
pnpm install
pnpm --filter @gloamtrade/sdk build        # build the SDK
cd contracts && forge test            # contracts
pnpm --filter @gloamtrade/sdk test         # SDK core self-tests
```

Run the reference app from `app/` (`next dev`), or open [gloam.trade/app](https://gloam.trade/app).

## Testnet

Robinhood Chain testnet (`46630`) and Tempo Moderato (`42431`) stay up as testnets: the same app (switch networks in the app), with test funds from faucets. Get testnet ETH and stock tokens from [faucet.testnet.chain.robinhood.com](https://faucet.testnet.chain.robinhood.com/), and test stablecoins (PathUSD and friends) from the Tempo faucet (`tempo_fundAddress`). The testnets run on single-contributor dev keys, fine for test funds only. On the Robinhood Chain testnet you can also shield ETH and hold and send stock tokens (TSLA, AMZN, PLTR, NFLX, AMD) privately; neither is a mainnet pool asset. The SDK and MCP default to the Robinhood Chain testnet for backward compatibility (`GLOAM_NETWORKS.robinhood` and `.tempo` are the testnets). Base Sepolia (`84532`) and Ethereum Sepolia (`11155111`) are testnets too (see [Base](#live-on-base) and [Ethereum Sepolia](#ethereum-sepolia-testnet-live)); unlike the other two they run the mainnet vault and the final keys, with test stablecoins from Circle's faucet (and Paxos's on Ethereum Sepolia).

**Contracts: Robinhood Chain testnet `46630`**

| Role | Address |
| --- | --- |
| Sealed vault `ShieldPoolPoseidon` (no admin withdraw, 3-day timelock on rule changes) | [`0x7240…d740`](https://explorer.testnet.chain.robinhood.com/address/0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740) |
| Dual-proof verifier `DualProofVerifier` | [`0xB077…f7eF`](https://explorer.testnet.chain.robinhood.com/address/0xB077c620384813bB31Bb82Cd55b63608Ac20f7eF) |
| Pay memo `GloamPayMemo` (first deploy, indexes the poster) | [`0x689e…5DCE`](https://explorer.testnet.chain.robinhood.com/address/0x689ebd9d30E0235c73fd8f10236F850CDB3c5DCE) |

**Contracts: Tempo Moderato testnet `42431`**

| Role | Address |
| --- | --- |
| Sealed vault `ShieldPoolPoseidon` (no admin withdraw, 3-day timelock on rule changes) | [`0x841D…d5eb`](https://explore.testnet.tempo.xyz/address/0x841dc046ea3cc842ba3a855731472c6eb0f2d5eb) |
| Dual-proof verifier `DualProofVerifier` | [`0x82F4…03A2`](https://explore.testnet.tempo.xyz/address/0x82f4ece6533e48574914bedeb55a8242bc1a03a2) |
| Pay memo `GloamPayMemo` (no poster in the event) | [`0x3ca8…b4E3`](https://explore.testnet.tempo.xyz/address/0x3ca88712e9219b5ee4c82d31cafeab64c9e9b4e3) |

Earlier testnet pools are superseded and listed in [`contracts/ARCHITECTURE.md`](./contracts/ARCHITECTURE.md); the pre-C1 Robinhood Chain pool `0x4F38…` is drained and retired, never use it.

## Guardrails

- Mainnet is live: deposit limits on, reviewed internally, and Kann Audits reviewed the vault contracts only. Say so plainly.
- The sealed trade stays retired. Private swaps are live on mainnet: always say the tokens and amounts are public.
- Real privacy only. Never fake or mock a private success.
- Selective disclosure over opacity. Verifiable, not just hidden.
- Brand: monochrome with a green tint (`#2e7d53` light, `#8fd3ad` dark), Aeonik, light and dark. Calm, spacious, plain-language.

---

No private keys in-repo. Deploy with `DEPLOYER_PK` env only. Mainnet uses the trusted setup's final keys (`app/public/circuits/final`); the older testnets' keys are dev artifacts. See [`SECURITY.md`](./SECURITY.md).

Contact: [hello@gloam.trade](mailto:hello@gloam.trade) · [@gloamtrade](https://x.com/gloamtrade) · Telegram [t.me/gloamhq](https://t.me/gloamhq). Found a security issue? See [`SECURITY.md`](./SECURITY.md#reporting-a-vulnerability).
