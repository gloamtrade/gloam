# Changelog

## 0.6.0 (19 November 2026)

- **BNB Chain mainnet:** `"bnb-mainnet"` (chain `56`, gas in BNB), live since 19 November 2026, with USDT and USDC (18 decimals each), BNB and BDX. It is refused by name with an SDK that has no pool for it.
- Decimals come from each network's own asset list. A `decimals` that disagrees with a listed asset is refused rather than used, and an unknown chain no longer falls back silently to PathUSD.
- Pin a client's spending cap to its token and chain (`currencies` and `chainIds`): on BNB Chain the base units of 0.05 USDT would otherwise also read as 0.05 BNB. With both set, `assertPayable` refuses a charge in BNB or BDX (now tested), and Gloam's pay snippet sets both.
- Depends on `@gloamtrade/sdk` `^0.8.0`.

## 0.5.0 (10 November 2026)

- Depends on `@gloamtrade/sdk` `^0.7.0`. 0.4.1 was published pinned to SDK 0.5.1 exactly, so it never picked up SDK fixes; this release takes every 0.7.x patch.
- SDK 0.7.0 binds x402 payments to their payee. An MPP credential already carries its own binding to the challenge, keyed by the same note secret and checked in validate, so settle passes `allowUnbound` for the x402 check.
- **Elysium mainnet:** `"elysium-mainnet"` (USDC only, gas in HYPE). `"elysium"` (Elysium testnet) is refused until its pool is in.
- `gloamChargeChainFromClient` takes the SDK's tree sync options and `warm()`, so a server keeps the pool tree instead of rebuilding it for every charge. Validate runs its pull-mode reads in parallel.
