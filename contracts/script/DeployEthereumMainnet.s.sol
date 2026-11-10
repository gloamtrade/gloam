// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MainnetDeploy} from "./MainnetDeploy.sol";

/**
 * Gloam on Ethereum mainnet (chainId 1): the payments pool with beta deposit
 * limits. The deploy itself is MainnetDeploy, shared with Robinhood Chain, Tempo
 * and Base, so every chain gets the same pool wired the same way. Ethereum
 * Sepolia, its testnet, runs this same deploy first (DeployEthereumSepolia.s.sol).
 *
 * The USER runs this. It is NOT executed by CI or by any agent. Runbook: DEPLOY-ETHEREUM.md.
 *
 * Deployed already (contracts/deployments/ethereum-mainnet.json): a rerun stops before it reads
 * a key or sends anything (script/RedeployGuard.sol). GLOAM_ALLOW_REDEPLOY=1 is
 * only for a second vault on purpose.
 *
 * Before running:
 *   1. Keys: the script deploys the ceremony-final verifiers (src/verifiers/final)
 *      and refuses to create the pool unless they accept final-key proofs and
 *      reject dev-key ones (MainnetDeploy._requireCeremonyKeys).
 *   2. Deploy PoseidonT3 only:  POSEIDON_T3_ONLY=1 node circuits/scripts/deploy-poseidon.mjs
 *      From a deployer with no transactions on Ethereum that lands at
 *      0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4 and this script's pool at
 *      0x39e28cde55cab798874746ac52cb4b5cc99a0194, the same as on the other chains.
 *
 *   export DEPLOYER_PK=0x...            # funded mainnet deployer (gas is paid in ETH)
 *   export RPC_URL=https://ethereum-rpc.publicnode.com
 *   export POSEIDON2=0x...              # PoseidonT3 from step 2
 *   # USDC and EURC are Circle's, USDT is Tether's, USDG and PYUSD are issued by Paxos
 *   # (PYUSD for PayPal). All 6 decimals, checked on-chain. 0x0 lists native ETH (18 decimals).
 *   # The three lists below go in the same order: USDC, USDT, USDG, PYUSD, EURC, ETH.
 *   export LIMIT_ASSETS=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,0xdAC17F958D2ee523a2206206994597C13D831ec7,0xe343167631d89B6Ffc58B88d6b7fB0228795491D,0x6c3ea9036406852006290770BEdFcAbA0e23A0e8,0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c,0x0000000000000000000000000000000000000000
 *   export LIMIT_PER_DEPOSIT=500000000,500000000,500000000,500000000,500000000,200000000000000000            # 500 each stablecoin; 0.2 ETH
 *   export LIMIT_TOTAL=25000000000,25000000000,25000000000,25000000000,25000000000,10000000000000000000      # 25,000 each stablecoin; 10 ETH
 *   # Cash-out fee: deposits and private transfers are free, unshield keeps this share of the
 *   # amount for FEE_RECIPIENT (paid out by collectFees(asset)). Capped at 100 bps (1%) in the contract.
 *   export WITHDRAW_FEE_BPS=25          # 0.25%; this is the default when unset
 *   export FEE_RECIPIENT=0xB3900ac9350903218e4c7597bAb0f008F01B30B8   # the treasury
 *   export NEW_OWNER=0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8       # it must call acceptOwnership()
 *   export NEW_OWNER_EOA=1              # the owner is a wallet, not a multisig, as on the other chains
 *
 * Run (Ethereum blocks hold 60M gas; the largest call here, the pool, is about
 * 11.9 KB of code, under the 24 KB limit). Gas is the real cost on Ethereum:
 * check the price first and cap what forge may pay (DEPLOY-ETHEREUM.md). Dry run first, then:
 *   forge script script/DeployEthereumMainnet.s.sol:DeployEthereumMainnet --rpc-url $RPC_URL \
 *     --broadcast --slow --with-gas-price 2gwei --priority-gas-price 0.01gwei
 *
 * USDT's approve() refuses to change one non-zero allowance into another and
 * returns nothing; the pool pulls and pays out with low-level calls that accept
 * no return data, and the app resets a stale USDT allowance to 0 before
 * approving a deposit. A fee on USDT transfers (off today, Tether can turn it
 * on) would make every USDT deposit revert with FeeOnTransferNotSupported:
 * nothing is taken, nothing is stuck.
 *
 * After: record the pool address and deploy block in MAINNET_POOLS[1]
 * (app/src/lib/mainnet.ts and packages/sdk/src/mainnet.ts).
 */
contract DeployEthereumMainnet is MainnetDeploy {
    uint256 constant ETHEREUM_MAINNET = 1;

    function run() external {
        _deployMainnet(ETHEREUM_MAINNET, true);
    }
}
