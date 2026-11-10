# Changelog

## 0.7.0 (10 November 2026)

Security release. If you sell anything over x402 with `@gloamtrade/sdk` 0.6.0 or older, upgrade.

- **x402 payments are now bound to their payee.** `buildGloamPayment` adds `payload.binding`, an HMAC keyed by the payment note's secret over the chain, the pool, the payee's receive tag and the note's commitment. `settleGloamPayment` checks it (`checkGloamPaymentBinding`) and refuses a payment with no binding or a wrong one. Up to 0.6.0 a sealed ticket copied from the public payment board was accepted as an x402 payment. Advisory: [SECURITY.md](https://github.com/gloamtrade/gloam/blob/main/SECURITY.md#advisories).
- **Unbound payments are refused by default.** A seller that must still serve payers on 0.6.0 or older can pass `allowUnbound: true` to `settleGloamPayment`, accepting that a copied ticket passes then too. A malformed or wrong binding is refused either way. Payers should upgrade as well: 0.6.0 and older send no binding.
- `verifyGloamPayment` returns `ok: false` ("payment binding is malformed") for a binding that is not 43 base64url characters. It is still a structural check only; serve on `settleGloamPayment`.
- New exports: `gloamPaymentBinding`, `checkGloamPaymentBinding`, `GLOAM_X402_BINDING_DOMAIN`.
- **Elysium mainnet** (`elysium-mainnet`, chain `99901`, USDC only, gas in HYPE), live since 9 November 2026: `mainnetNetwork("elysium")`, `ELYSIUM_MAINNET`, `elysiumMainnetConfig()` and the Elysium chain helpers. Private swaps are refused there by name. The Elysium testnet (`99801`) stays off until its pool is in.
- **Short claim and request links:** `encodeShortClaim`, `decodeShortClaim`, `encodeShortRequest`, `decodeShortRequest`, `buildShortPaymentRequestLink`, note seeds (`randomNoteSeed`, `seedToSecret`) and the fixed `SHORT_LINK_WHERE` table. Id 45 is Elysium mainnet USDC and id 47 is KNTQ on Elysium mainnet; no existing id changed.
- Tree sync: `createTreeSync` keeps a pool's tree and reads only new blocks, with an optional store and `gloamLeafSeed` for a cold start; `sweepChainFromClient` keeps one tree per chain.
- The API client and the relay default to `https://www.gloam.trade`. The bare domain redirected, and the redirect dropped the API key header.
