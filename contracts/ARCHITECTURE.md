# Shield architecture (v2, Poseidon vault)

## Goal

Private hold, move and pay on **Robinhood Chain mainnet** (`4663`), **Tempo mainnet** (`4217`), **Base mainnet** (`8453`), **Ethereum mainnet** (`1`) and **Elysium mainnet** (`99901`), with deposit limits, with **Robinhood Chain testnet** (`46630`) and **Tempo Moderato testnet** (`42431`) as the testnets. Private trade is built but switched off pending audit, and the mainnet pool leaves it out entirely.

## Contract surface

```
User wallet
    │
    ├─ public path ──► ETH / ERC-20 / DEX (no Gloam contracts)
    │
    └─ private path ─► ShieldPoolPoseidon ──► DualProofVerifier
                           │                      ├ UnshieldIVerifier (5 inputs)
                           │                      └ TransferIVerifier (4 inputs)
                           ├ shieldBound ────────► ShieldIVerifier (3 inputs)
                           ├ sealedSwap ─────────► sealedSwapVerifier = 0x0 (disabled)
                           ├ commitments (Poseidon Merkle leaves)
                           ├ spent nullifiers
                           └ currentRoot

GloamPayMemo: encrypted payment memos for discovery. Holds no funds.
```

Mainnet runs `ShieldPoolPayments`: the same surface without `sealedSwap`, plus deposit limits and a cash-out fee.

## Owner powers

- **No admin withdraw.** No function moves note-backed funds; notes leave only through a proof-gated `unshield()` to the recipient bound in the proof. `sweepStrayNative()` can only take native currency above `deposited[address(0)] + feesOwed[address(0)]`, i.e. ETH sent straight to the contract that backs no note and is no owed fee.
- **Timelocked rule changes.** Setters that affect proof validity, pricing or asset flows (`setVerifier`, `setSealedSwapVerifier`, `setShieldVerifier`, `setSwapRate`, `setPriceFeed`, `setOracleConfig`, `setOracleRatePair`) run directly only during setup. `setupMode()` is `false` on every live pool, mainnet and testnet, so every change goes `queueChange` → public `CHANGE_DELAY` (3 days) → `executeChange` within a 14-day grace window. The owner wallet can still swap verifiers this way; the delay is what gives users time to see it and cash out.
- **Owner guard** (`src/VaultOwnerGuard.sol`). The contract each mainnet vault's ownership moves to, one way. From the moment it accepts a vault, only `setDepositLimit` and `setWithdrawFee` go through the timelock there, plus `lowerDepositLimit`, `lowerWithdrawFee` and `sweepStrayNative`; `setVerifier`, `setShieldVerifier` and `transferOwnership` can never run again. Until then the bullet above holds. Runbook and trade-off: the owner guard section of [`DEPLOY.md`](../DEPLOY.md). The Elysium vault has been owned by one since its deploy; the other four mainnet vaults are still owned by the wallet below.
- **Two-step ownership** (`transferOwnership` + `acceptOwnership`). On testnet the owner is a single wallet. On mainnet the owner is one wallet (`0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8`); a multisig is planned. Cash-out fees go to the treasury `0xB3900ac9350903218e4c7597bAb0f008F01B30B8` since 24 October 2026.

## Mainnet deploy (from 2026-10-21)

All five mainnets (Robinhood Chain, Tempo, Base, Ethereum and Elysium) run `ShieldPoolPayments` (`src/ShieldPoolPayments.sol`): the shared core with no sealed swap code, deposits through `shieldBound()` only, deposit limits and a cash-out fee, 0.25% at deploy and 0.5% since 3 November 2026 through the timelock (Elysium launched at 0.5%, born owned by a `VaultOwnerGuard`). Each was deployed by `script/MainnetDeploy.sol` (through `DeployRobinhoodMainnet.s.sol`, `DeployTempoMainnet.s.sol`, `DeployBaseMainnet.s.sol`, `DeployEthereumMainnet.s.sol` and `DeployElysiumMainnet.s.sol`), which deploys the final-key verifiers, refuses to create the pool unless they accept final-key proofs and reject dev-key ones, and ends setup in the same run. The internal pre-mainnet review (20 October 2026) closed with no Critical or High findings open. Kann Audits then reviewed the vault contracts (report, 1 November 2026: gloam.trade/security) and found no Critical, High or Medium issues.

Base runs the same deploy, with native ETH listed next to USDC, EURC and, on mainnet, bridged USDT. Base Sepolia (`84532`, a testnet on the final keys) went live on 24 October 2026 through `DeployBaseSepolia.s.sol` (table below). Base mainnet (`8453`, `DeployBaseMainnet.s.sol`) went live on 26 October 2026 (table below). Runbook: [`DEPLOY-BASE.md`](../DEPLOY-BASE.md).

Ethereum runs the same path too: Ethereum Sepolia (`11155111`, a testnet on the final keys) went live on 25 October 2026 through `DeployEthereumSepolia.s.sol` (table below), and Ethereum mainnet (`1`, `DeployEthereumMainnet.s.sol`) went live on 26 October 2026 (table below), with native ETH listed next to USDC, USDT, USDG, PYUSD and EURC. USDT returns nothing from `transfer`, `transferFrom` and `approve`; the pool's low-level calls accept that (proven on a fork in `test/fork/EthereumMainnetFork.t.sol`). Runbook: [`DEPLOY-ETHEREUM.md`](../DEPLOY-ETHEREUM.md).

**Robinhood Chain mainnet `4663`.**

| | |
| --- | --- |
| Pool (`ShieldPoolPayments`) | `0x39e28cde55cab798874746ac52cb4b5cc99a0194` |
| Deploy block | `94194599` |
| PoseidonT3 | `0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4` |
| DualProofVerifier, ShieldIVerifier | Final keys (`src/verifiers/final`); read `verifier()` and `shieldVerifier()` on the pool |
| sealedSwapVerifier | `0x0`, always (no swap code) |
| Listed assets (per deposit / total) | USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (50,000 / 2,500,000), $GLOAM `0xDcD885F5c60b3aD49F6D58718696417314e8724d` (2,500,000 / 25,000,000), native ETH (11 / 110) and 30 more tokens with their own limits (WETH, USDe, U, cbBTC, PONS, CASHCAT, VIRTUAL, AI, ORBIO and 21 Robinhood stock and ETF tokens): every address and limit in [deployments/mainnet.json](./deployments/mainnet.json) |
| Owner | `0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8` (one wallet; a multisig is planned) |
| Fee recipient | `0xB3900ac9350903218e4c7597bAb0f008F01B30B8`, the treasury, since 2026-10-24 (the owner at launch; changed through the 3-day timelock) |
| Relayer | `0xb1E994586E62994648a0b866BF33F2EDd942512e` (submits proven calls and pays gas; cannot move or redirect money) |
| GloamPayMemo | `0x01B3172d9900Cb26d57E986429b9b23854c74598` (block `95494392`, deployed 2026-10-23) |

**Tempo mainnet `4217`.**

| | |
| --- | --- |
| Pool (`ShieldPoolPayments`) | `0x39e28cde55cab798874746ac52cb4b5cc99a0194` |
| Deploy block | `45172561` |
| PoseidonT3 | `0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4` |
| DualProofVerifier, ShieldIVerifier | Final keys (`src/verifiers/final`); read `verifier()` and `shieldVerifier()` on the pool |
| sealedSwapVerifier | `0x0`, always (no swap code) |
| Listed assets (per deposit / total) | USDC.e `0x20c000000000000000000000b9537d11c60e8b50`, pathUSD `0x20c0000000000000000000000000000000000000`, USDT0 `0x20c00000000000000000000014f22ca97301eb73`, OUSD `0x20c0000000000000000000006a37da5c996874be` (TIP-20, 6 decimals, 50,000 / 2,500,000 each) |
| Owner | `0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8` (one wallet; a multisig is planned) |
| Fee recipient | `0xB3900ac9350903218e4c7597bAb0f008F01B30B8`, the treasury, since 2026-10-24 (the owner at launch; changed through the 3-day timelock) |
| Relayer | `0xb1E994586E62994648a0b866BF33F2EDd942512e` (submits proven calls and pays gas; cannot move or redirect money) |
| GloamPayMemo | `0x342E3745967FDB4223902E196Ceb792c15d8C1c4` (block `45417629`, deployed 2026-10-23) |

**Base mainnet `8453`.** Deployed 2026-10-26. Record: [deployments/base-mainnet.json](./deployments/base-mainnet.json).

| | |
| --- | --- |
| Pool (`ShieldPoolPayments`) | `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194` |
| Deploy block | `53109632` |
| PoseidonT3 | `0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4` |
| DualProofVerifier | `0x1421353d471dF6C847713aee391Db38978fE714a` (final keys) |
| ShieldIVerifier | `0x69Fa6d2De0A66dA718DF022cEe98485AfDb03465` (final keys) |
| sealedSwapVerifier | `0x0`, always (no swap code) |
| Listed assets (per deposit / total) | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, EURC `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` and bridged USDT `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` (50,000 / 2,500,000 each), ETH (20 / 1,000) |
| Owner | `0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8` (one wallet; a multisig is planned) |
| Fee recipient | `0xB3900ac9350903218e4c7597bAb0f008F01B30B8`, the treasury |
| Relayer | `0xb1E994586E62994648a0b866BF33F2EDd942512e` (submits proven calls and pays gas; cannot move or redirect money) |
| GloamPayMemo | `0xfCa1887e77f738ef9C5751974b3f3873d029F2DC` (block `53109729`) |

**Ethereum mainnet `1`.** Deployed 2026-10-26. Record: [deployments/ethereum-mainnet.json](./deployments/ethereum-mainnet.json).

| | |
| --- | --- |
| Pool (`ShieldPoolPayments`) | `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194` |
| Deploy block | `26276183` |
| PoseidonT3 | `0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4` |
| DualProofVerifier | `0x1421353d471dF6C847713aee391Db38978fE714a` (final keys) |
| ShieldIVerifier | `0x69Fa6d2De0A66dA718DF022cEe98485AfDb03465` (final keys) |
| sealedSwapVerifier | `0x0`, always (no swap code) |
| Listed assets (per deposit / total) | USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7`, USDG `0xe343167631d89B6Ffc58B88d6b7fB0228795491D`, PYUSD `0x6c3ea9036406852006290770BEdFcAbA0e23A0e8` and EURC `0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c` (50,000 / 2,500,000 each), ETH (20 / 1,000) |
| Owner | `0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8` (one wallet; a multisig is planned) |
| Fee recipient | `0xB3900ac9350903218e4c7597bAb0f008F01B30B8`, the treasury |
| Relayer | `0xb1E994586E62994648a0b866BF33F2EDd942512e` (submits proven calls and pays gas; cannot move or redirect money) |
| GloamPayMemo | `0x8699D015087dE6D25d55d5ceB63b34b9d773f135` (block `26276234`) |

**Elysium mainnet `99901`.** Deployed 2026-11-09 from its own deployer (`0xec9993765e249e8e9DC677B7BCB61F78b31c6b60`), so every address differs from the other mainnets. Gas is paid in HYPE. Record: [deployments/elysium-mainnet.json](./deployments/elysium-mainnet.json).

| | |
| --- | --- |
| Pool (`ShieldPoolPayments`) | `0x89d3042390204f57b8b4F8949D3c2203E4002164` |
| Deploy block | `3248495` |
| PoseidonT3 | `0x62c435CE6886fa91e3b0e91500c6dC9219723457` |
| DualProofVerifier | `0x29053A713E3a7D37053374446869a6f55858FcEf` (final keys) |
| ShieldIVerifier | `0xAEB8cb99B3BB43eB230F9fEB7293fB5E39080016` (final keys) |
| sealedSwapVerifier | `0x0`, always (no swap code) |
| Listed assets (per deposit / total) | USDC `0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65` (500 / 25,000) |
| Owner | `VaultOwnerGuard` `0x268D7CAd645282D1e77461b5B2dd997bd54eFAf5` since the deploy, controller `0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8` |
| Fee recipient | `0xB3900ac9350903218e4c7597bAb0f008F01B30B8`, the treasury |
| Relayer | `0xb1E994586E62994648a0b866BF33F2EDd942512e` (submits proven calls and pays gas; cannot move or redirect money) |
| GloamPayMemo | none |

**Base Sepolia `84532`** (testnet on the mainnet contract and final keys, deployed 2026-10-24). Record: [deployments/base-sepolia.json](./deployments/base-sepolia.json).

| | |
| --- | --- |
| Pool (`ShieldPoolPayments`) | `0x39e28cde55cab798874746ac52cb4b5cc99a0194` |
| Deploy block | `49802958` |
| PoseidonT3 | `0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4` |
| DualProofVerifier | `0x1421353d471dF6C847713aee391Db38978fE714a` (final keys) |
| ShieldIVerifier | `0x69Fa6d2De0A66dA718DF022cEe98485AfDb03465` (final keys) |
| sealedSwapVerifier | `0x0`, always (no swap code) |
| Listed assets (per deposit / total) | USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` and EURC `0x808456652fdb597867f38412077A9182bf77359F` (500 / 25,000 each), ETH (0.2 / 10) |
| Owner | `0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8` (ownership accepted) |
| Fee recipient | `0xB3900ac9350903218e4c7597bAb0f008F01B30B8` |
| Relayer | `0xb1E994586E62994648a0b866BF33F2EDd942512e` (submits proven calls and pays gas; cannot move or redirect money) |
| GloamPayMemo | `0x01B3172d9900Cb26d57E986429b9b23854c74598` (block `49804175`) |

Every Base Sepolia contract but PoseidonT3 is an exact source match on Sourcify; PoseidonT3 is raw circomlibjs bytecode, checked by code hash.

**Ethereum Sepolia `11155111`** (testnet on the mainnet contract and final keys, deployed 2026-10-25). Record: [deployments/ethereum-sepolia.json](./deployments/ethereum-sepolia.json). Every contract landed one nonce later than on the other chains, so the vault is not at `0x39e2…0194` here (see [`DEPLOY-ETHEREUM-SEPOLIA.md`](../DEPLOY-ETHEREUM-SEPOLIA.md)).

| | |
| --- | --- |
| Pool (`ShieldPoolPayments`) | `0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef` |
| Deploy block | `11992914` |
| PoseidonT3 | `0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4` |
| DualProofVerifier | `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194` (final keys) |
| ShieldIVerifier | `0xa8cf34C6F3985B7901F6fA0e1E13a3Da2D2dC7E4` (final keys) |
| sealedSwapVerifier | `0x0`, always (no swap code) |
| Listed assets (per deposit / total) | USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, USDG `0xfBb2A78CceEb415b00300925e464C3E44E6e06b0`, PYUSD `0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9` and EURC `0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4` (500 / 25,000 each), ETH (0.2 / 10) |
| Owner | `0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8` (ownership accepted) |
| Fee recipient | `0xB3900ac9350903218e4c7597bAb0f008F01B30B8` |
| Relayer | `0xb1E994586E62994648a0b866BF33F2EDd942512e` (submits proven calls and pays gas; cannot move or redirect money) |
| GloamPayMemo | `0x8699D015087dE6D25d55d5ceB63b34b9d773f135` (block `11992942`) |

On `ShieldPoolPayments` the timelocked setters are `setVerifier`, `setShieldVerifier`, `setDepositLimit` and `setWithdrawFee`. `lowerDepositLimit` (down to `0, 0`, which closes deposits for that asset) and `lowerWithdrawFee` are instant. Withdrawals and private transfers are never limited.

## Testnet deploy (current pools, redeployed 2026-09-29)

**Robinhood Chain testnet `46630`.** Record: [deployments/poseidon-testnet.json](./deployments/poseidon-testnet.json).

| | |
| --- | --- |
| Pool (product) | `0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740` |
| Deploy block | `126185021` |
| DualProofVerifier | `0xB077c620384813bB31Bb82Cd55b63608Ac20f7eF` |
| ShieldIVerifier | `0x28E6d0D02568EE634f9596645775275DE76b2847` |
| sealedSwapVerifier | `0x0` (private trade off) |
| GloamPayMemo | `0x689ebd9d30E0235c73fd8f10236F850CDB3c5DCE` (first deploy; its event still indexes the poster, so relayed memos are the only way to keep the sender off it) |

**Tempo Moderato testnet `42431`.**

| | |
| --- | --- |
| Pool (product) | `0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb` |
| Deploy block | `37411195` |
| DualProofVerifier | `0x82F4eCE6533e48574914bEDEb55A8242Bc1A03A2` |
| ShieldIVerifier | `0x7836A07d6a5f1F09c91B343161152133924E6Eb3` |
| sealedSwapVerifier | `0x0` (private trade off) |
| GloamPayMemo | `0x3ca88712e9219b5EE4c82D31cAfEaB64C9E9b4E3` (fixed source, no poster in the event) |

Both: hash Poseidon, proof layout v2, Groth16 on BN254, keys from a **single-contributor dev ceremony** (testnet only). Mainnet runs `ShieldPoolPayments` on the multi-party ceremony's final keys (`src/verifiers/final`), above.

### Superseded pools (history only)

These remain on-chain but are no longer used. **The app must not default to them** (`app/src/lib/config.ts` remaps a stale env that points at one).

| Network | Pool | Note |
| --- | --- | --- |
| RH `46630` | `0xAc25c3C4A880194324d1fC78722694e0F315aF1c` | 2026-09-16 hardened pool, superseded 2026-09-29 |
| RH `46630` | `0xaEbB8E3b5C4648Aa7Cc4E41d3Cec008Db4bb1834` | 2026-09-01 C1/C2/C3 pool, superseded 2026-09-16 |
| RH `46630` | `0x4F38…12D8F` | Pre-C1 pool, drained (audit H-P1). Never use or seed |
| RH `46630` | `0xA488809a089F003A2B6E69daa65B0db79823c93B` | Legacy Poseidon, pre-sealed |
| RH `46630` | `0x2BD98196D90AB45D58843B4c8B8809aa34343d35` | Phase-1 keccak pool |
| Tempo `42431` | `0xeD0b0F8eE6206eCd87cF47Fc1C5220d15C6e2276` | 2026-09-16 hardened pool, superseded 2026-09-29 |
| Tempo `42431` | `0x3eeE869aFF476D90aF6CF0bC8F0b450C98A8D30b` | First Tempo pool |

Older verifier deployments (for example `DualProofVerifier 0x4B0D…949C`, `SealedSwapVerifier 0xE19a…dF8D`) belonged to superseded pools.

## Phases (status)

| Phase | What | Status |
| --- | --- | --- |
| 0 | Interfaces + scaffold | Done |
| 1 | Keccak pool, shield only | Superseded (history only) |
| 2 | Poseidon pool, bound shield + unshield + transfer, dual verifier | **Live on mainnet (final keys, `ShieldPoolPayments`)** on RH, Tempo, Base, Ethereum and Elysium, and **on testnet (dev keys)** on RH + Tempo |
| 2b | No admin withdraw, timelocked rule changes | **Live on testnet** since 2026-09-29, **on mainnet** from launch |
| 3a | Vault trade adapter (unshield → DEX → reshield) | **Live on mainnet** on Robinhood Chain (`GloamVaultSwapV4` `0x34AB06208586A737Bf1607fa996Bc9162271c52d`, `GloamVaultSwapV4b` `0xfCa1887e77f738ef9C5751974b3f3873d029F2DC`) and Tempo (`GloamVaultSwapTempo` `0xfCa1887e77f738ef9C5751974b3f3873d029F2DC`); v3 (`GloamVaultSwapV4c`, `GloamVaultSwapTempo2`) is built and not deployed. The pair and the amounts are public on the swap edge |
| 3b | Sealed-size private trade | **Built, switched off pending audit** (`sealedSwapVerifier = 0`); see [SEALED_TRADE.md](./SEALED_TRADE.md) |
| 4 | Off-chain proofs: funds, payment, payroll total | **Live on mainnet and testnet**, verified at gloam.trade/verify |
| Prod | Multi-party ceremony + mainnet | **Live** from 2026-10-21: ceremony done (13 contributors), internal review, deposit limits. Kann Audits reviewed the vault contracts (report, 1 November 2026). See [PRODUCTION.md](./PRODUCTION.md) |

## Note scheme (Poseidon)

```
commitment = Poseidon(secret, amount, asset)
nullifier  = Poseidon(secret, commitment)
Merkle     = Poseidon(left, right)  // depth 20
```

| Piece | Location |
| --- | --- |
| Circuits (all seven) | `circuits/`, see [circuits/README.md](./circuits/README.md) |
| Dual verifier | `src/verifiers/DualProofVerifier.sol` |
| Shield verifier | `src/verifiers/Shield*.sol` |
| Sealed swap verifier (not wired) | `src/verifiers/SealedSwap*.sol` |
| Pool core (deposits, transfers, withdrawals, deposit limits) | `src/ShieldPoolCore.sol` |
| Testnet pool (core + sealed swap) | `src/ShieldPoolPoseidon.sol` |
| Mainnet pool (core only) | `src/ShieldPoolPayments.sol` |
| Timelock | `src/lib/ChangeTimelock.sol` |
| App artifacts | `app/public/circuits/*.wasm` + `*_final.zkey` (testnet dev keys); `app/public/circuits/final/` (mainnet final keys) |

### Proof public inputs (v2)

**Shield (3):** `[commitment, amount, asset]`  
**Unshield (5):** `[root, nullifier, asset, amount, to]`  
**Transfer (4):** `[root, nullifier, newC0, newC1]`  
**Sealed swap (9, disabled):** `[root, nullifier, newCOut, newCChange, assetIn, assetOut, amountOutMin, rateIn, rateOut]`  

If private trade is re-enabled, the app's privacy default publishes `amountOutMin = 1` so size is not leaked as min-out (see `app/src/lib/privacy.ts`).

## App integration

```
app/src/lib/config.ts          → current pool default (remaps superseded pools)
app/src/lib/networks.ts        → per-network pool, deploy block, memo board
app/src/lib/shield.ts          → ABI, local notes, gas limits
app/src/lib/noteVault.ts       → notes encrypted at rest
app/src/lib/treeSync.ts        → rebuild from Shielded + Transferred + SealedSwapped
app/src/lib/proveClient.ts     → browser snarkjs
app/.../ShieldView.tsx         → deposit (shieldBound)
app/.../MoveView.tsx           → private send + cash out
app/.../SealedTradePanel.tsx   → private trade (shows offline while disabled)
app/.../VaultTradePanel.tsx    → via-market adapter
```

## Scripts

```bash
# Inventory seed (faucet stocks into vault for cash-out solvency).
# Only relevant once private trade is re-enabled.
forge script script/SeedVaultInventory.s.sol --rpc-url $RH_TESTNET_RPC --broadcast
```
