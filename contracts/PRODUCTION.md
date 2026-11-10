# Production gate (contracts + circuits)

Testnet Poseidon pools are live with **dev ceremony** keys.
The mainnet deploy uses the multi-party ceremony's final keys and checks them
on chain. Mainnet launched Wednesday 21 October 2026, 13:00 UTC, with deposit
limits, on Robinhood Chain (`4663`) and Tempo (`4217`). Base (`8453`) and Ethereum
(`1`) followed on 26 October 2026 and Elysium (`99901`) on 9 November 2026.

## 1. Ceremony

- [x] Public Powers of Tau (Hermez `powersOfTau28_hez_final_16.ptau`, blake2b checked)
- [x] Circuit-specific multi-party contribution for all six mainnet circuits (13 contributors)
- [x] Transcript published (`ceremony/TRANSCRIPT.md`, release `ceremony-final`, beacon drand 6561386)
- [x] Final `*_final.zkey` each re-verified against its r1cs and the ptau (`snarkjs zkey verify`: ZKey Ok)
- [x] Solidity verifiers exported from them: `src/verifiers/final` (byte for byte, renamed `*Final`)
- [x] App side: `app/public/circuits/final`, hash-pinned in `circuitArtifacts.ts` and
      `proofs/artifacts.ts`; each network proves with its own set (`GloamNetwork.ceremony`)
- [x] Key gate: `script/KeyCheckProofs.sol` holds real proofs made with both key sets
      (`node circuits/scripts/gen-key-fixtures.mjs`); `test/KeyCheck.t.sol` shows each
      verifier set accepts only its own

## 2. Deploy

- [x] PoseidonT3 deployed on both mainnets at `0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4`
      (Robinhood Chain `4663` and Tempo `4217`): the `POSEIDON2` both deploy scripts take
- [x] `ShieldPoolPayments` (payments only, no sealed swap) on each chain:
      `script/DeployTempoMainnet.s.sol` (4217) and `script/DeployRobinhoodMainnet.s.sol`
      (4663), both running the shared `script/MainnetDeploy.sol`. It deploys the final
      verifiers and **creates no pool unless they accept the final-key proofs and reject
      the dev-key ones**. The pool estimates about 24.9M gas on Tempo with the cash-out
      fee (30M cap; keep `--gas-estimate-multiplier` at or under 120); Robinhood
      Chain has no special cap. USDG on Robinhood Chain is `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`
- [x] The pool can't take a plain `shield()` (deposits need `shieldBound()`), and
      `endSetup()` reverts until both verifiers are set and deposit limits are on
- [x] Deposit limits on: each listed asset gets a per-deposit and a
      total limit; an unlisted asset cannot be deposited. Robinhood Chain lists
      USDG and GLOAM (`0xDcD885F5c60b3aD49F6D58718696417314e8724d`, 18 decimals,
      25,000 per deposit, 250,000 total) so holders can vote privately; Tempo lists
      USDC.e, pathUSD, USDT0 and OUSD. Each stablecoin: 500 per deposit, 25,000 total at
      launch, raised 100x through the timelock on 1 November 2026 on all four chains.
      Robinhood Chain has since listed native ETH and 30 more tokens (deployments/mainnet.json)
- [x] Emergency path: `lowerDepositLimit(asset, 0, 0)` closes deposits at once
      (no timelock); withdrawals and private transfers keep working. Raising a
      limit or listing an asset takes the 3-day timelock
- [x] Transfer ownership to a multisig (`NEW_OWNER`, then `acceptOwnership()`). The
      script refuses a `NEW_OWNER` with no code unless `NEW_OWNER_EOA=1`. At launch the
      owner and fee recipient was one wallet (`0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8`);
      fees go to the treasury `0xB3900ac9350903218e4c7597bAb0f008F01B30B8` since 24 Oct 2026
      (through the timelock), and the multisig is planned. Deployed 21 Oct 2026 on both chains (pool
      `0x39e28cde55cab798874746ac52cb4b5cc99a0194`); that wallet accepted ownership on both the same morning
- [x] After the broadcast the script reads every setting back and fails on a mismatch:
      deposit limits on, setup ended, shield verifier and spend verifier as deployed, fee
      at most 1%, and the key gate again on the pool's own verifiers. If it fails, do
      not announce the pool; deploy a fresh one
- [x] Keep the deposit list to the native coin and vetted fixed-supply stablecoins (plus
      $GLOAM): a rebasing, freezable or fee-on-transfer token only harms its own asset,
      but it can stall that asset
- [x] Record addresses in `deployments/mainnet.json` (or chain-specific)
- [x] App: the mainnet entries in `app/src/lib/networks.ts` (`ceremony: "production"`)
      and the mainnet token lists in `tokens.ts`, hidden until their pool is filled in
- [x] Fill in each pool and its deploy block: `MAINNET_POOLS` in `app/src/lib/mainnet.ts`
      and in the SDK (Robinhood Chain `0x39e28cde55cab798874746ac52cb4b5cc99a0194` at `94194599`, Tempo
      `0x39e28cde55cab798874746ac52cb4b5cc99a0194` at `45172561`), and set `GLOAM_RPC_URL_4663` /
      `GLOAM_RPC_URL_4217` to a private RPC for the server (the RPC env is still to do; the public
      RPCs are the fallback)

## 2b. Base (Base Sepolia and Base mainnet live)

- [x] `script/DeployBaseSepolia.s.sol` (`84532`) and `script/DeployBaseMainnet.s.sol` (`8453`) on
      the shared `script/MainnetDeploy.sol`, native ETH allowed, final keys on both (Base Sepolia
      is a rehearsal of the mainnet deploy, so it runs the same keys and contract)
- [x] Assets checked on chain: USDC and EURC (Circle, 6 decimals) on both, bridged USDT
      (6 decimals) on Base mainnet only, and ETH. 500 / 25,000 per stablecoin; 0.2 / 10 ETH
- [x] `POSEIDON_T3_ONLY=1 node circuits/scripts/deploy-poseidon.mjs` deploys PoseidonT3 alone, so
      a fresh deployer gets the same PoseidonT3 and vault addresses as on Robinhood Chain and Tempo
- [x] Fork dry runs of both scripts pass every read-back check; `test/DeployBase.t.sol` runs both
      with the runbook settings
- [x] Base Sepolia deployed (24 Oct 2026, block `49802958`) and ownership accepted; record in
      [`deployments/base-sepolia.json`](./deployments/base-sepolia.json)
- [ ] Base Sepolia relayer funded and tested end to end in the app
- [x] Base mainnet deployed (26 Oct 2026, block `53109632`), ownership accepted, pool and block in
      `MAINNET_POOLS[8453]`; record in [`deployments/base-mainnet.json`](./deployments/base-mainnet.json)

Runbook: [`DEPLOY-BASE.md`](../DEPLOY-BASE.md).

## 2c. Ethereum (Ethereum Sepolia and Ethereum mainnet live)

- [x] `script/DeployEthereumMainnet.s.sol` (`1`) on the shared `script/MainnetDeploy.sol`, native
      ETH allowed, final keys; its testnet is Ethereum Sepolia (`script/DeployEthereumSepolia.s.sol`,
      `11155111`, runbook `DEPLOY-ETHEREUM-SEPOLIA.md`), rehearsed on a fork as the real deployer
- [x] Assets checked on chain: USDC, USDT, USDG, PYUSD and EURC (6 decimals each) and ETH. 500 /
      25,000 per stablecoin; 0.2 / 10 ETH
- [x] Fork rehearsal of the whole runbook ends "All checks passed", owner accepts; 8.93M gas
- [x] `test/fork/EthereumMainnetFork.t.sol`: real USDT and ETH through the vault with final-key
      proofs; `test/DeployChains.t.sol`: every mainnet script refuses every other chain
- [x] Ethereum Sepolia deployed (25 Oct 2026, vault `0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef` at
      block `11992914`, memo board `0x8699D015087dE6D25d55d5ceB63b34b9d773f135`) and ownership
      accepted; record in [`deployments/ethereum-sepolia.json`](./deployments/ethereum-sepolia.json)
- [x] Ethereum deployed (26 Oct 2026, block `26276183`), ownership accepted, relayer funded, pool and
      block in `MAINNET_POOLS[1]`; record in [`deployments/ethereum-mainnet.json`](./deployments/ethereum-mainnet.json)

Runbook: [`DEPLOY-ETHEREUM.md`](../DEPLOY-ETHEREUM.md).

## 2d. Elysium (mainnet live)

- [x] `script/DeployElysiumMainnet.s.sol` (`99901`) on `MainnetDeploy._deployMainnetGuarded`: the same
      vault, final keys, born owned by a `VaultOwnerGuard` so no proof checker can be replaced
- [x] Deployed 9 Nov 2026 (vault `0x89d3042390204f57b8b4F8949D3c2203E4002164` at block `3248495`,
      guard `0x268D7CAd645282D1e77461b5B2dd997bd54eFAf5`, controller accepted); USDC only at 500 / 25,000,
      0.5% cash-out fee; record in [`deployments/elysium-mainnet.json`](./deployments/elysium-mainnet.json)

Runbook: [`DEPLOY-ELYSIUM.md`](../DEPLOY-ELYSIUM.md).

## 3. Review

- [x] Internal pre-mainnet review, 20 Oct 2026 (six-part review of the mainnet
      code): no Critical or High in the contracts. Fixed: dev keys (GATE 2), deploy-window
      unbound deposit (F1), soft post-deploy checks (F3), multisig check (F2), duplicate
      spend gas (R-1), inbox spoofing (NEW-1), passphrase KDF
- [ ] Independent external review of pool, verifiers, circuits
- [x] Fix critical/high findings from the internal review
- [ ] Threat model sign-off (anonymity set, owner keys, note custody)
- [ ] Outside review of `src/VaultOwnerGuard.sol`, then the handover on all four
      chains (the owner guard section of [`DEPLOY.md`](../DEPLOY.md)). It is one-way.
      The Elysium vault was born guarded on 9 Nov 2026, before that review

## 4. Ops

- [ ] Incident contact + disclosure process
- [ ] Monitoring (pool balance, root, verifier, pause if any)
- [ ] No always-true mock verifier on funded pool (ever)

## Explicit non-claims

- No full external audit: Kann Audits reviewed the vault contracts only (report, 1 November 2026). The swap routers, circuits, app and relay were not part of it
- Mainnet runs with deposit limits on and one owner wallet until the multisig (on Elysium the
  wallet is the guard's controller)
- Until the owner guard holds a vault, its owner can replace a proof checker through
  the 3-day timelock: read `owner()`. After that a proof checker cannot be patched,
  only left behind for a new vault
- Private trading is not on mainnet (`ShieldPoolPayments` has no swap code)
- Dev zkeys must not be used on mainnet
