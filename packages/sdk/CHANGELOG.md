# Changelog

## 0.8.2 (21 November 2026)

- **Circuit hashes for `funds` and `payroll_total`.** `GloamCircuit` and `CIRCUIT_SHA256` now cover both (wasm, dev zkey and ceremony-final zkey), so a headless prover for proofs of holdings or a payroll run's total can fetch them with `circuitArtifactUrls` / `circuitArtifactFiles` and check them before proving.
- **`paySeed` on `buildPrivateSendIntent`.** Pass `randomNoteSeed().seed` and the payment note's secret is made from it, so the payment fits a short claim link (`encodeShortClaim`). Left out, the secret is random as before.
- **`buildShieldBoundIntent` takes `prove`**, the name every other builder uses. `prover` still works.

## 0.8.1 (20 November 2026)

- **BNB Chain: BDX is Beldex's BEP-20 `0x9d10a1ec41Fe7878429BB457e31F9b050D38c633`** (9 decimals), confirmed by Beldex on 20 November 2026. 0.8.0 listed the LayerZero OFT `0x6ad12E761b438beA3EA09F6C6266556Bb24C2181`, the LayerZero OFT named BDX, which is not Beldex's (Beldex's BDX exists only on BNB Chain); it was also closed (0, 0) in the Base and Ethereum vaults on 20 November 2026. `BNB_MAINNET.bdx`, `bnbMainnetAssets()` and every BNB Chain reader now name the Beldex contract.
- BDX on BNB Chain opens once its deposit limit (100,000 per deposit, 2,000,000 in total) is live on chain. It was queued through the vault's 3-day timelock on 20 November 2026. The OFT's BNB Chain limit is set to 0.
- Base and Ethereum are unchanged: BDX there is still the OFT.

## 0.8.0 (19 November 2026)

**BNB Chain mainnet**, live since 19 November 2026.

- `bnb-mainnet` (chain `56`, gas in BNB): `mainnetNetwork("bnb")`, `getGloamNetwork("bnb-mainnet")`, `BNB_MAINNET`, `bnbMainnetConfig()`, `BNB_MAINNET_CHAIN` and the other exports of `src/bnb.ts`. The vault is `0x89d3042390204f57b8b4F8949D3c2203E4002164` (deploy block `134431196`), the same address and code as Elysium's. It is owned by a `VaultOwnerGuard` (`0x633B24cf4C48CF68cB815BC87C110c47E218B4af`) whose controller is the Gloam Owner Safe (2 of 3). Its payment-message board is `0xb692c86B13f65a123f45cF9A21580b2dDC7B8a79` (block `134431743`, `payMemoBoardFor(56)`).
- Assets: USDT and USDC with **18 decimals** each (not 6), BNB, and BDX (9 decimals, 100,000 per deposit and 2,000,000 in total). USDT, USDC and BNB have no deposit limit.
- Deposit limits are now built in each token's own decimals (`stableLimitFor(decimals)`, `bdxCapFor(decimals)`), so an 18-decimal stablecoin is never capped as if it had 6.
- Private swaps are refused on BNB Chain by name, as on Elysium; there is no router there yet. BNB Chain has no Gloam testnet.

**Reads fail loudly on pruned logs**

- BNB Chain's public RPCs keep only about a day of logs and answer an empty list for anything older. A read through `gloamReadTransport(network)` now checks old ranges against a canary contract that logs in every block (`BNB_LOG_CANARY`). When an RPC has dropped that history it throws `PrunedLogsError` instead of returning "no events". So a balance or a tree is never built from a partial history.
- New `guardPrunedLogs(transport, canary, opts)` and `PrunedLogsError` for your own transports. Every old log answer is checked, not only empty ones, so a range that straddles the oldest block an RPC keeps fails instead of passing its newer half. `archiveOnError` sends a failed read to the archive RPC you pass. Each RPC's proven block is cached for 10 minutes, and BNB Chain trusts a log answer without the canary only for the last 1,000 blocks.
- For BNB Chain, set an RPC that keeps every log (for example `GLOAM_RPC_URL_56` in the MCP server, or your own `historyRpc`).

No change on the other chains.

## 0.7.1 (16 November 2026)

Security fixes. If you check payment receipts with `checkPaymentReceipt`, or run a gateway that takes x402 `gloam-cashout` payments, upgrade.

**Payment receipts**

- **Testnet receipts are refused by default.** Up to 0.7.0, `checkPaymentReceipt` returned `ok: true` for a receipt from any Gloam network, testnets included. Base Sepolia and Ethereum Sepolia share the mainnet vault address and production keys, and the Robinhood Chain and Tempo testnets run development keys, so a checker that built its chain client from `record.chainId` could credit free or made-up test value as a real payment. The `vault` check now fails on a testnet chain unless you pass `allowTestnet: true`.
- `ReceiptCheckResult` gains `network` (the record's Gloam network key, or null) and `testnet` (true, false, or null for an unknown chain).
- Build the chain client from the chains you accept, not from the record's chain id.
- **Elysium mainnet's payment-message board:** `0xB99DB19CdEAF3779013a75F2Cb7a13d0eecd075a` from block `6033047` (`payMemoBoardFor(99901)`, `ELYSIUM_MAINNET.payMemo`). It was deployed by Cloak from `GloamPayMemo` unchanged (same runtime code as the boards on the other chains, no owner), so payments on Elysium can now post a memo the payee finds. The board is refused as a cash-out address there, as on the other chains.

**Gateways that take `gloam-cashout` payments**

- **G must be unique among a gateway's open quotes to a `payTo`, not just the tag.** The chain shows a cash out of G to `payTo` and nothing else, so a cash out matches every open quote with the same `payTo` and G. A tag unique per quote does not give that: at 50 bps, price 10000 with tag 7 and price 5000 with tag 5032 both give G = 10058, and a fee change can collide the same way. The docs said a unique tag was enough; they now say G.
- New `reserveCashoutGross({ payTo, price, reserve, bps?, client?, rpcUrl?, startTag? })`: picks a tag whose G no open quote to `payTo` holds, across prices and fee rates, by claiming `cashoutGrossKey(payTo, G)` through your store's atomic `reserve` (a Map set-if-absent, or Redis `SET NX`). Reads the fee live when `bps` is not given.
- New `cashoutGrossKey(payTo, gross)`: the store key, one open quote per key.
- `verifyGloamCashout` takes `openQuoteIds` (your store's ids at that key) and `quote.quoteId`. With them, `ok` is false unless the quote is the only one open at its `payTo` and G: `ambiguous_quote` when another quote holds the same G, `quote_not_open` when this one is not held there. Without them it behaves as before.

- Advisories: [SECURITY.md](https://github.com/gloamtrade/gloam/blob/main/SECURITY.md#advisories).

## 0.7.0 (10 November 2026)

Security release. If you sell anything over x402 with `@gloamtrade/sdk` 0.6.0 or older, upgrade.

- **x402 payments are now bound to their payee.** `buildGloamPayment` adds `payload.binding`, an HMAC keyed by the payment note's secret over the chain, the pool, the payee's receive tag and the note's commitment. `settleGloamPayment` checks it (`checkGloamPaymentBinding`) and refuses a payment with no binding or a wrong one. Up to 0.6.0 a sealed ticket copied from the public payment board was accepted as an x402 payment. Advisory: [SECURITY.md](https://github.com/gloamtrade/gloam/blob/main/SECURITY.md#advisories).
- **Unbound payments are refused by default.** A seller that must still serve payers on 0.6.0 or older can pass `allowUnbound: true` to `settleGloamPayment`, accepting that a copied ticket passes then too. A malformed or wrong binding is refused either way. Payers should upgrade as well: 0.6.0 and older send no binding.
- `verifyGloamPayment` returns `ok: false` ("payment binding is malformed") for a binding that is not 43 base64url characters. It is still a structural check only; serve on `settleGloamPayment`.
- New exports: `gloamPaymentBinding`, `checkGloamPaymentBinding`, `GLOAM_X402_BINDING_DOMAIN`.
- **Elysium mainnet** (`elysium-mainnet`, chain `99901`, USDC only, gas in HYPE), live since 9 November 2026: `mainnetNetwork("elysium")`, `ELYSIUM_MAINNET`, `elysiumMainnetConfig()` and the Elysium chain helpers. Private swaps are refused there by name. The Elysium testnet (`99801`) stays off until its pool is in.
- **Short claim and request links:** `encodeShortClaim`, `decodeShortClaim`, `encodeShortRequest`, `decodeShortRequest`, `buildShortPaymentRequestLink`, note seeds (`randomNoteSeed`, `seedToSecret`) and the fixed `SHORT_LINK_WHERE` table. Id 45 is Elysium mainnet USDC and id 47 is KNTQ on Elysium mainnet; no existing id changed.
- Tree sync: `createTreeSync` keeps a pool's tree and reads only new blocks, with an optional store and `gloamLeafSeed` for a cold start; `sweepChainFromClient` keeps one tree per chain.
- Tree sync reads each range in one `eth_getLogs` per chain-sized range (Robinhood Chain 10M blocks, Elysium 1M, Tempo 100k, Base 50k, Ethereum 10k), retries rate limits and timeouts, and checks the result against the pool's `currentRoot()` (or `isKnownRoot()` where the node has no state for that block). Any other RPC failure throws a `TreeSyncError` naming the chain and blocks; a partial tree is never returned as complete.
- The API client and the relay default to `https://www.gloam.trade`. The bare domain redirected, and the redirect dropped the API key header.
