# Deploy Gloam to Tempo (Moderato testnet)

The runbook for bringing the Gloam shielded pool to Tempo. You run this; no agent
and no CI deploys it, and the proving keys are the dev ceremony, so this is a
**testnet deploy only**. Gloam's Tempo mainnet pool (`4217`) is
`0x39e28cde55cab798874746ac52cb4b5cc99a0194` (deploy block `45172561`), deployed with
`contracts/script/DeployTempoMainnet.s.sol` on the ceremony's final keys; see
[Tempo mainnet](#tempo-mainnet) below and `contracts/PRODUCTION.md`. Sealed swaps stay disabled (audit H1). Design and
rationale: [`TEMPO_EXPANSION.md`](./TEMPO_EXPANSION.md).

## What this deploys

Tempo has none of Gloam's on-chain deps, so this is a full-stack deploy:

1. Poseidon hashers (PoseidonT3 / PoseidonT4) from precomputed bytecode.
2. Raw Groth16 verifiers (shield, unshield, transfer) and their IVerifier adapters.
3. The `DualProofVerifier` (unshield + transfer).
4. The hardened `ShieldPoolPoseidon`, wired to the dual verifier, with the shield
   verifier set so deposits go through `shieldBound()`.
5. sealedSwap is left OFF (verifier unset), same as Robinhood.

Live surface after deploy: shield, private send, cash out, selective disclosure.

## Network (testnet verified against docs.tempo.xyz, 2026-09-07)

| | Testnet (this runbook) | Mainnet |
| --- | --- | --- |
| Name | Tempo Testnet (Moderato) | Tempo |
| chainId | 42431 | 4217 |
| RPC | https://rpc.moderato.tempo.xyz | https://rpc.tempo.xyz |
| Explorer | https://explore.testnet.tempo.xyz | https://explore.tempo.xyz |
| Native currency | USD (gas paid in USD; confirm decimals before wiring amounts) | None; gas is paid in stablecoins |

## Prereqs

- Foundry (`forge`) and Node installed; run from `contracts/`.
- A funded Tempo deployer key. Fund it from the Tempo faucet; gas is paid in USD.
- Poseidon build artifacts present at `circuits/build/poseidon/*.json` (already in
  the repo; regenerate with circomlibjs if missing).
- Decide the first shieldable asset. Start with a non-freezing testnet asset (see
  TEMPO_EXPANSION.md section 3). A compliance-enforcing stablecoin needs the
  issuer-viewing-key path first.

## Step 1: deploy the Poseidon hashers

```bash
cd contracts
export DEPLOYER_PK=0x...        # funded Tempo deployer
export RPC_URL=https://rpc.moderato.tempo.xyz
node circuits/scripts/deploy-poseidon.mjs   # prints PoseidonT3 (2-input) + PoseidonT4
export POSEIDON2=0x...          # PoseidonT3 address from the output
```

## Step 2: deploy the verifier stack and the pool

```bash
forge script script/DeployTempo.s.sol:DeployTempo --rpc-url $RPC_URL --broadcast --gas-estimate-multiplier 105
```

The script logs `ShieldPoolPoseidon`, `DualProofVerifier`, `ShieldIVerifier`, and
confirms `sealedSwapVerifier` is `0`. Record the pool address and, from the
explorer, the block it was deployed at.

## Step 3: point the app at Tempo

Edit the `tempo` entry in [`app/src/lib/networks.ts`](./app/src/lib/networks.ts):

- set `pool` to the deployed `ShieldPoolPoseidon` address,
- set `deployBlock` to its deploy block,
- set `primaryAsset` / `stableAssets` to the asset(s) you registered,
- flip `status` from `"planned"` to `"live"`.

The header network selector enables Tempo automatically once `status` is `"live"`
and `pool` is non-null. `syncTree` uses `deployBlock` to rebuild the tree.

## Step 4: confirm the asset and decimals

Tempo's native currency is USD; confirm its decimals on-chain before wiring
amounts (the app assumes 18 and flags it in `networks.ts`). If shielding an
ERC-20 stable, confirm it is non-freezing for the first launch, and register it
in `stableAssets`.

## Step 5: verify end to end (small amounts)

1. Shield a tiny amount; confirm the `Shielded` event and `commitmentSeen == true`.
2. Private send inside the vault; confirm the `Transferred` event and that no
   amount is public.
3. Cash out; confirm the public `unshield` lands.
4. x402: build requirements + a payment with `@gloamtrade/sdk`, settle the private
   send, and confirm `verifyGloamPayment` passes and the on-chain checks it lists
   hold. See `mcp/scripts/verify-transfer-prover.mjs` for the offline proof path.

## Tempo mainnet

The mainnet pool is a different contract and a different script. `DeployTempoMainnet.s.sol`
runs the shared `script/MainnetDeploy.sol` (the same deploy as Robinhood Chain) and only
runs on chainId 4217:

1. It deploys the final-key verifiers (`src/verifiers/final`) and refuses to create a
   pool unless they accept final-key proofs and reject dev-key ones.
2. It creates `ShieldPoolPayments` (payments only; the sealed swap code is left out)
   on the PoseidonT3 already on Tempo mainnet,
   `0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4` (`POSEIDON2`).
3. It sets the shield verifier, turns deposit limits on and lists each asset in
   `LIMIT_ASSETS`: USDC.e `0x20c000000000000000000000b9537d11c60e8b50`, pathUSD
   `0x20c0000000000000000000000000000000000000`, USDT0
   `0x20c00000000000000000000014f22ca97301eb73` and OUSD
   `0x20c0000000000000000000006a37da5c996874be`, each 500 per deposit and 25,000 in
   total (`500000000` and `25000000000` in raw 6-decimal units). Tempo has no native
   coin to list.
4. It sets the 0.25% cash-out fee (`WITHDRAW_FEE_BPS=25`) when `FEE_RECIPIENT` is set,
   starts the ownership handoff to `NEW_OWNER` if one is given (it must call
   `acceptOwnership()`), and ends setup in the same run.
   At deploy: these limits and the 0.25% fee. Since then the stablecoin limits are 50,000
   and 2,500,000 and the fee is 0.5% (from 3 November 2026), raised through the timelock.
5. It reads every setting back and fails on a mismatch. If it fails, do not announce
   the pool; deploy a fresh one.

```bash
cd contracts
export RPC_URL=https://rpc.tempo.xyz
export POSEIDON2=0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4
# plus DEPLOYER_PK, LIMIT_ASSETS, LIMIT_PER_DEPOSIT, LIMIT_TOTAL, FEE_RECIPIENT, NEW_OWNER
forge script script/DeployTempoMainnet.s.sol:DeployTempoMainnet --rpc-url $RPC_URL \
  --broadcast --gas-estimate-multiplier 115
```

Tempo caps a transaction at 30M gas; the pool deploy is estimated at about 24.9M, so
keep the multiplier at or under 120 and check the dry run first. Then record the pool
and its deploy block in `MAINNET_POOLS` in `app/src/lib/mainnet.ts` (the app's
`tempo-mainnet` entry reads them from there) and in the SDK's `MAINNET_POOLS`.

## Do not

- Run this testnet runbook (`DeployTempo.s.sol`) against Tempo mainnet (chainId 4217).
  Mainnet uses `DeployTempoMainnet.s.sol` above, on the final keys.
- Enable sealedSwap. It stays off until the H1 confidential-reserve work lands.
- Ship a compliance-enforcing stablecoin without the issuer-viewing-key path.
- Reuse the dev-ceremony keys on mainnet.

## Notes

- The verifiers and circuits are identical to Robinhood, so proofs generated by
  the same artifacts verify here. Only the deploy addresses differ per chain.
- Everything is per-chain in `networks.ts`; notes are keyed by chainId, so Tempo
  and Robinhood vaults stay separate with no extra work.
