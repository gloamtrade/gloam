// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MainnetDeploy} from "./MainnetDeploy.sol";

/**
 * Gloam on Base mainnet (chainId 8453): the payments pool with beta deposit
 * limits. The deploy itself is MainnetDeploy, shared with Robinhood Chain and
 * Tempo, so all three chains get the same pool wired the same way. Run it only
 * after the same deploy has been tested end to end on Base Sepolia
 * (DeployBaseSepolia.s.sol).
 *
 * The USER runs this. It is NOT executed by CI or by any agent. Runbook: DEPLOY-BASE.md.
 *
 * Deployed already (contracts/deployments/base-mainnet.json): a rerun stops before it reads
 * a key or sends anything (script/RedeployGuard.sol). GLOAM_ALLOW_REDEPLOY=1 is
 * only for a second vault on purpose.
 *
 * Before running:
 *   1. Keys: the script deploys the ceremony-final verifiers (src/verifiers/final)
 *      and refuses to create the pool unless they accept final-key proofs and
 *      reject dev-key ones (MainnetDeploy._requireCeremonyKeys).
 *   2. Deploy PoseidonT3 only:  POSEIDON_T3_ONLY=1 node circuits/scripts/deploy-poseidon.mjs
 *      From a deployer with no transactions on Base that lands at
 *      0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4 and this script's pool at
 *      0x39e28cde55cab798874746ac52cb4b5cc99a0194, the same as Robinhood Chain and Tempo.
 *
 *   export DEPLOYER_PK=0x...            # funded mainnet deployer (gas is paid in ETH)
 *   export RPC_URL=https://mainnet.base.org
 *   export POSEIDON2=0x...              # PoseidonT3 from step 2
 *   # USDC and EURC are Circle's native tokens on Base (6 decimals each). USDT is Tether
 *   # bridged from Ethereum through Base's standard bridge (6 decimals; L1 token
 *   # 0xdAC17F958D2ee523a2206206994597C13D831ec7). 0x0 lists native ETH (18 decimals).
 *   # All checked on-chain. The three lists below go in the same order: USDC, EURC, USDT, ETH.
 *   export LIMIT_ASSETS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42,0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2,0x0000000000000000000000000000000000000000
 *   export LIMIT_PER_DEPOSIT=500000000,500000000,500000000,200000000000000000            # 500 each stablecoin; 0.2 ETH
 *   export LIMIT_TOTAL=25000000000,25000000000,25000000000,10000000000000000000          # 25,000 each stablecoin; 10 ETH
 *   # Cash-out fee: deposits and private transfers are free, unshield keeps this share of the
 *   # amount for FEE_RECIPIENT (paid out by collectFees(asset)). Capped at 100 bps (1%) in the contract.
 *   export WITHDRAW_FEE_BPS=25          # 0.25%; this is the default when unset
 *   export FEE_RECIPIENT=0xB3900ac9350903218e4c7597bAb0f008F01B30B8   # the treasury
 *   export NEW_OWNER=0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8       # it must call acceptOwnership()
 *   export NEW_OWNER_EOA=1              # the owner is a wallet, not a multisig, as on the other chains
 *
 * Run (Base is an OP Stack chain with no special gas cap; the pool is about
 * 11.9 KB of code, under the 24 KB limit). Dry run first, then:
 *   forge script script/DeployBaseMainnet.s.sol:DeployBaseMainnet --rpc-url $RPC_URL --broadcast --slow
 *
 * After: record the pool address and deploy block in MAINNET_POOLS[8453]
 * (app/src/lib/mainnet.ts and packages/sdk/src/mainnet.ts).
 */
contract DeployBaseMainnet is MainnetDeploy {
    uint256 constant BASE_MAINNET = 8453;

    function run() external {
        _deployMainnet(BASE_MAINNET, true);
    }
}
