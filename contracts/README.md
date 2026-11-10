# Gloam Contracts

Live on Robinhood Chain mainnet (`4663`) and Tempo mainnet (`4217`) since 21 October 2026, on Base mainnet (`8453`) and Ethereum mainnet (`1`) since 26 October 2026 and on Elysium mainnet (`99901`) since 9 November 2026, with deposit limits, with `ShieldPoolPayments` on the trusted setup's final keys, and on the testnets (Robinhood Chain `46630`, Tempo `42431`) on dev keys. Base Sepolia (`84532`) and Ethereum Sepolia (`11155111`) are testnets on the mainnet deploy and the final keys. The Elysium vault was born owned by a `VaultOwnerGuard` (`script/DeployElysiumMainnet.s.sol`, runbook `DEPLOY-ELYSIUM.md`). The mainnet deploy (`script/DeployRobinhoodMainnet.s.sol`, `script/DeployTempoMainnet.s.sol`, `script/DeployBaseMainnet.s.sol`, `script/DeployEthereumMainnet.s.sol`, `script/DeployElysiumMainnet.s.sol`) uses the final keys in `src/verifiers/final` and checks them on chain before it creates the pool; see [`PRODUCTION.md`](./PRODUCTION.md). Mainnet was reviewed internally (20 October 2026, no Critical or High findings open), and Kann Audits reviewed the vault contracts (report, 1 November 2026: gloam.trade/security) and found no Critical, High or Medium issues.

## Do we need contracts?

| Path | Contracts |
| --- | --- |
| Send ETH / ERC-20 | No — native + faucet tokens |
| Public swap (when pools exist) | No — existing DEX router |
| **Shield / private send / private trade / cash out** | **Yes — this package** |

## Live (mainnet)

| Network | Vault `ShieldPoolPayments` | Deploy block | PoseidonT3 |
| --- | --- | --- | --- |
| Robinhood Chain mainnet `4663` | `0x39e28cde55cab798874746ac52cb4b5cc99a0194` | `94194599` | `0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4` |
| Tempo mainnet `4217` | `0x39e28cde55cab798874746ac52cb4b5cc99a0194` | `45172561` | `0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4` |
| Base mainnet `8453` | `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194` | `53109632` | `0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4` |
| Ethereum mainnet `1` | `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194` | `26276183` | `0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4` |
| Elysium mainnet `99901` | `0x89d3042390204f57b8b4F8949D3c2203E4002164` | `3248495` | `0x62c435CE6886fa91e3b0e91500c6dC9219723457` |

Elysium was deployed from a different deployer (`0xec9993765e249e8e9DC677B7BCB61F78b31c6b60`), so its vault, PoseidonT3 and verifiers sit at their own addresses ([deployments/elysium-mainnet.json](./deployments/elysium-mainnet.json)).

- Owner: `0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8` (one wallet; a multisig is planned), until [`VaultOwnerGuard`](./src/VaultOwnerGuard.sol) takes over a vault: it forwards only limit and fee changes and the sweep of stray native coin, so `setVerifier` can never run again there. Read `owner()` on a vault to see which holds it; the runbook is the owner guard section of [`DEPLOY.md`](../DEPLOY.md). The Elysium vault has been owned by its guard `0x268D7CAd645282D1e77461b5B2dd997bd54eFAf5` since its deploy (controller `0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8`); the other four are still owned by the wallet. Fee recipient: the treasury `0xB3900ac9350903218e4c7597bAb0f008F01B30B8` since 24 October 2026 (it was the owner at launch; the change waited the 3-day timelock). Relayer: `0xb1E994586E62994648a0b866BF33F2EDd942512e` (run by the Gloam team; it only submits already-proven transactions and pays gas, and cannot move or redirect money).
- Assets and deposit limits (per deposit / total): Robinhood Chain USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (50,000 / 2,500,000), $GLOAM `0xDcD885F5c60b3aD49F6D58718696417314e8724d` (2,500,000 / 25,000,000), native ETH (11 / 110) and 30 more tokens, each with its own limit (WETH, USDe, U, cbBTC, PONS, CASHCAT, VIRTUAL, AI, ORBIO and 21 Robinhood stock and ETF tokens; every address and limit is in `deployments/mainnet.json`); Tempo USDC.e `0x20c000000000000000000000b9537d11c60e8b50`, pathUSD `0x20c0000000000000000000000000000000000000`, USDT0 `0x20c00000000000000000000014f22ca97301eb73` and OUSD `0x20c0000000000000000000006a37da5c996874be` (50,000 / 2,500,000 each); Base USDC, EURC and USDT (50,000 / 2,500,000 each) and ETH (20 / 1,000); Ethereum USDC, USDT, USDG, PYUSD and EURC (50,000 / 2,500,000 each) and ETH (20 / 1,000); Elysium USDC `0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65` (500 / 25,000). Full addresses are in `deployments/base-mainnet.json`, `deployments/ethereum-mainnet.json` and `deployments/elysium-mainnet.json`. Read `depositLimit(asset)` on a vault for the live value.
- Deposits and private transfers are free; `unshield` keeps 0.5% on the mainnet vaults (`withdrawFeeBps = 50`, up from 25 on 3 November 2026 through the timelock; Elysium launched at 50) for the fee recipient, at the rate on the day it lands. Base Sepolia and Ethereum Sepolia stay at 25. Withdrawals and private transfers are never limited. Raising a limit, listing an asset or raising the fee takes the 3-day timelock; lowering a limit or the fee is instant.
- Payment-memo boards (`GloamPayMemo`, deployed 23 October 2026): Robinhood Chain `0x01B3172d9900Cb26d57E986429b9b23854c74598` (block `95494392`), Tempo `0x342E3745967FDB4223902E196Ceb792c15d8C1c4` (block `45417629`); deployed 26 October 2026: Base `0xfCa1887e77f738ef9C5751974b3f3873d029F2DC` (block `53109729`), Ethereum `0x8699D015087dE6D25d55d5ceB63b34b9d773f135` (block `26276234`). Verifier addresses: read `verifier()` and `shieldVerifier()` on the pool.

## Testnet (dev keys)

| Network | Vault `ShieldPoolPoseidon` | Pay memo board |
| --- | --- | --- |
| Robinhood Chain testnet `46630` | `0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740` | `0x689ebd9d30E0235c73fd8f10236F850CDB3c5DCE` |
| Tempo Moderato testnet `42431` | `0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb` | `0x3ca88712e9219b5ee4c82d31cafeab64c9e9b4e3` |

Full addresses, verifiers and superseded pools: [deployments/poseidon-testnet.json](./deployments/poseidon-testnet.json) and [ARCHITECTURE.md](./ARCHITECTURE.md).

## Base: Base Sepolia and Base mainnet

Base Sepolia (`84532`) and Base mainnet (`8453`) run the same `ShieldPoolPayments` deploy as the mainnets, on the final keys: `script/DeployBaseSepolia.s.sol` and `script/DeployBaseMainnet.s.sol`, both through `script/MainnetDeploy.sol` with native ETH allowed. Assets: USDC, EURC and ETH on both, plus bridged USDT on Base mainnet; 50,000 / 2,500,000 per stablecoin and 20 / 1,000 ETH on Base mainnet, 500 / 25,000 per stablecoin and 0.2 / 10 ETH on Base Sepolia. The runbook is [`DEPLOY-BASE.md`](../DEPLOY-BASE.md).

| Network | Vault `ShieldPoolPayments` | Deploy block | Pay memo board |
| --- | --- | --- | --- |
| Base Sepolia `84532` (testnet, live since 24 October 2026) | `0x39e28cde55cab798874746ac52cb4b5cc99a0194` | `49802958` | `0x01B3172d9900Cb26d57E986429b9b23854c74598` |
| Base mainnet `8453` (live since 26 October 2026) | `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194` | `53109632` | `0xfCa1887e77f738ef9C5751974b3f3873d029F2DC` |

Records (verifiers, assets, owner, fee recipient): [deployments/base-sepolia.json](./deployments/base-sepolia.json) and [deployments/base-mainnet.json](./deployments/base-mainnet.json).

| Feature | Status |
| --- | --- |
| Shield / unshield / transfer | Live on mainnet (final keys, deposit limits, 0.5% cash-out fee) and testnet (dev keys); no admin withdraw, 3-day timelock on rule changes |
| Sealed private trade | Built, switched off on the testnet pools and left out of the mainnet pool (`ShieldPoolPayments`); must not be re-enabled until the H1 and ZK-1 fixes land (see audit/REMEDIATION.md) |
| Pay memos | Live on the mainnets and the testnets |
| Production keys | Done: the 13-contributor ceremony's final keys (drand round 6561386, release `ceremony-final`) in `src/verifiers/final`, used on mainnet |

## Ethereum: Ethereum Sepolia and Ethereum mainnet

Ethereum mainnet (`1`) runs the same `ShieldPoolPayments` deploy on the final keys: `script/DeployEthereumMainnet.s.sol`, through `script/MainnetDeploy.sol` with native ETH allowed. Assets: USDC, USDT, USDG, PYUSD and EURC (50,000 / 2,500,000 each) and ETH (20 / 1,000). A fork test (`test/fork/EthereumMainnetFork.t.sol`, `ETH_FORK=1`) puts real USDT and ETH through the vault with final-key proofs. The runbook is [`DEPLOY-ETHEREUM.md`](../DEPLOY-ETHEREUM.md). Ethereum Sepolia (`script/DeployEthereumSepolia.s.sol`, runbook [`DEPLOY-ETHEREUM-SEPOLIA.md`](../DEPLOY-ETHEREUM-SEPOLIA.md)) runs the same deploy with test USDC, USDG, PYUSD, EURC and ETH.

| Network | Vault `ShieldPoolPayments` | Deploy block | Pay memo board |
| --- | --- | --- | --- |
| Ethereum Sepolia `11155111` (testnet, live since 25 October 2026) | `0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef` | `11992914` | `0x8699D015087dE6D25d55d5ceB63b34b9d773f135` |
| Ethereum mainnet `1` (live since 26 October 2026) | `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194` | `26276183` | `0x8699D015087dE6D25d55d5ceB63b34b9d773f135` |

Ethereum Sepolia record (verifiers, assets, owner, fee recipient, and why its vault is not at `0x39e2…0194`): [deployments/ethereum-sepolia.json](./deployments/ethereum-sepolia.json) and [`DEPLOY-ETHEREUM-SEPOLIA.md`](../DEPLOY-ETHEREUM-SEPOLIA.md).

## Stack

- [Foundry](https://book.getfoundry.sh/) — `forge` / `cast` / `anvil`
- Solidity `0.8.24+`, `evm_version = shanghai` (RH faucet tokens use PUSH0)
- Circom circuits under `circuits/`

## Commands

```bash
cd contracts
forge build
forge test
```

`script/archive/` keeps scripts whose job is done: changes already executed, one-off and
testnet deploys, and the testnet vault inventory seed (`SeedVaultInventory.s.sol`, see
[SEALED_TRADE.md](./SEALED_TRADE.md)). They still compile; nothing runs them.

## Docs

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [SEALED_TRADE.md](./SEALED_TRADE.md)
- [PRODUCTION.md](./PRODUCTION.md)
- [AUDIT.md](./AUDIT.md)

## Honesty

- No mock “private success” in the app.
- Public app paths work without this package.
- Dev ceremony zkeys on the testnets only; mainnet runs on the final keys. Never use dev keys on mainnet.
