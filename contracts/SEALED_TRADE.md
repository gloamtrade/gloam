# Sealed-size private trade

> **Do not re-enable sealed swap (ZK-1, 2026-10-11).** H1 is not the only blocker. The rate check `amountOut * rateOut === amountSwap * rateIn` wraps the BN254 field, and the 128-bit rate caps do NOT stop it: on an oracle-bound pair the caller picks the absolute rates, so 1 wei of assetIn mints about 2.57e38 units of assetOut and drains real deposits. Proven end to end in `test/auditzk/SealedSwapRateWrap.t.sol`. Before any re-enable:
>
> - amount bits + rate bits must be <= 252, for example 96-bit rates, checked in both the circuit and the contract;
> - one side of an oracle-bound rate must be a fixed scale (for example `rateOut == 1e18`).
>
> The shipped `sealed_swap` zkey and `src/verifiers/SealedSwapVerifier.sol` are stale vs the circuit source (ZK review I-1), so they carry none of the hardening below. The verifier that matches them is deployed on Robinhood Chain testnet, unwired: `SealedSwapIVerifier` `0x9D866ca3b981585D5E6B138E4411C804c4d6C198` (Groth16 `0xa06461Ec…2B89`). It accepts the ZK-1 proof. Do not wire it to any pool.
>
> The deploy scripts are now guarded. `DeployPoseidonPoolSealed`, `DeploySealedSwapStack`, `DeploySealedSwapVerifier` and `circuits/scripts/deploy-phase2.mjs` refuse to deploy or wire a sealed swap verifier unless `GLOAM_ACK_SEALED_SWAP_H1_ZK1=1`. Only set it once H1 and ZK-1 are fixed and a new circuit and ceremony are done. See `script/SealedSwapGuard.sol`.

**Status: built, switched off pending audit.** The circuit is compiled with a dev zkey in `app/public/circuits/sealed_swap*`, and `SealedSwapVerifier` plus `ShieldPoolPoseidon.sealedSwap(...)` are in source and tested. On both live pools (Robinhood Chain `0x7240…d740`, Tempo `0x841D…d5eb`) `sealedSwapVerifier` is `0x0`, so every `sealedSwap` call reverts and the app shows private trade as offline. It stays off until the swap solvency accounting (audit H1, see [`audit/H1-SWAP-SOLVENCY.md`](./audit/H1-SWAP-SOLVENCY.md)) is redesigned and audited, and ZK-1 (above) is fixed. Re-enabling means queueing `setSealedSwapVerifier` behind the public 3-day timelock.

**Privacy (app, when enabled):** default `amountOutMin = 1` so public min-out does not equal real size (see `app/src/lib/privacy.ts`). Rates are coarsened display marks, still public. Assets and caller remain public. Dev ceremony keys only.

## Goal

Swap without broadcasting **full size** as free public signal. Settlement still on Robinhood Chain.

## v0 circuit (fixed rate)

File: `circuits/sealedSwap/sealedSwap.circom` (6,649 constraints in the shipped build; the current source compiles to 7,036)

**Public (9):**  
`root, nullifier, newCommitmentOut, newCommitmentChange, assetIn, assetOut, amountOutMin, rateIn, rateOut`

**Private:**  
spend note secrets, `amountIn`, `amountSwap`, `amountOut`, change, Merkle path

**Constraints:**

- Merkle membership of spent note (`assetIn`)
- `amountIn = amountSwap + amountChange`
- `amountOut * rateOut === amountSwap * rateIn` (rate per direction is owner-pinned, or oracle-bound via `OracleRates`)
- `amountOut >= amountOutMin`
- Poseidon commitments for out + change notes

The source also carries audit fixes (`secret != 0` on all three notes, 128-bit range checks on amounts, rates and `amountOutMin`). They take effect only after a recompile, a new ceremony and a verifier deploy. The 128-bit rate checks do not close the product wrap (ZK-1, see the note at the top), and the circuit comment that says they do is wrong.

**App witness builder:** `app/src/lib/proverSealedSwap.ts` (`buildSealedSwapWitness`)  
**Browser prove:** `proveSealedSwapInBrowser` in `app/src/lib/proveClient.ts`  
**UI:** `app/src/components/app/SealedTradePanel.tsx` (checks `sealedSwapVerifier` on-chain and shows "Private trade is offline" while it is `0x0`)

## Settlement (built, not enabled)

- `SealedSwapVerifier.sol` + `SealedSwapIVerifier.sol` (9 public inputs). A dev-key pair was deployed on RH testnet on 2026-09-01 (`0xa06461Ec…2B89` / `0x9D866ca3…C198`) but is not wired to any live pool, and must stay unwired (see the note at the top).
- `ShieldPoolPoseidon.sealedSwap(...)`, gated by `sealedSwapVerifier` and an owner-pinned or oracle-bound rate per direction.
- Deploy record: `deployments/poseidon-testnet.json` (`liveState.sealedSwapVerifier` is `0x0`).

## Vault inventory, and why it is off

`sealedSwap` does **not** move `deposited[asset]`: the swap amounts are private, so the contract has no number to credit or debit. The pool keeps the swapper's `assetIn` and owes an `assetOut` note that no deposit backs. That is the H1 solvency gap, and the reason the path is disabled rather than merely unpriced.

Seed throwaway inventory (only relevant once swaps re-enable; needs faucet tokens + `DEPLOYER_PK`):

```bash
export DEPLOYER_PK=0x...
export RH_TESTNET_RPC=https://rpc.testnet.chain.robinhood.com
# optional: TOKEN_AMT=1000000000000000000  (1e18 per stock)
forge script script/archive/SeedVaultInventory.s.sol \
  --rpc-url $RH_TESTNET_RPC --broadcast --gas-estimate-multiplier 200 -vvvv
```

## Next engineering steps

1. Pick and build the H1 solvency design (see `audit/H1-SWAP-SOLVENCY.md`), then get it audited
2. Fix ZK-1 in the circuit and the contract (rate bits so amount + rate <= 252, fixed scale on one oracle side), recompile `sealedSwap`, run a new ceremony, regenerate and deploy the verifier, and flip `test/auditzk/SealedSwapRateWrap.t.sol` to expect a revert
3. Oracle-bound pricing is built and tested (`OracleRates`, including the F-1 decimals fix); enable per pair through the timelock
4. Production multi-party ceremony keys (see `PRODUCTION.md`)
5. Run / automate inventory seed if the chosen design needs it

## Adapter

Cash out → public DEX → re-shield, where a public pool exists. Size **is** public on the swap edge. Honest fallback for thin books.

## Explicit non-goals for v0

- Fake private swap UI  
- Mainnet / production keys  
- Full Zcash-style multi-asset AMM privacy
