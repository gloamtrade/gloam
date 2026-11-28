// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MainnetDeploy} from "./MainnetDeploy.sol";

/**
 * Gloam on Base Sepolia (chainId 84532), Base's testnet: the
 * same payments pool, final keys, beta deposit limits and cash-out fee as Base
 * mainnet, on test funds. The deploy itself is MainnetDeploy, shared with
 * Robinhood Chain and Tempo, so a dry run here is a rehearsal of the mainnet one.
 *
 * The USER runs this. It is NOT executed by CI or by any agent. Runbook: DEPLOY-BASE.md.
 *
 * Before running:
 *   1. Keys: the script deploys the ceremony-final verifiers (src/verifiers/final)
 *      and refuses to create the pool unless they accept final-key proofs and
 *      reject dev-key ones (MainnetDeploy._requireCeremonyKeys).
 *   2. Deploy PoseidonT3 only:  POSEIDON_T3_ONLY=1 node circuits/scripts/deploy-poseidon.mjs
 *      From a deployer with no transactions on this chain that lands at
 *      0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4 and this script's pool at
 *      0x39e28cde55cab798874746ac52cb4b5cc99a0194, the same as Robinhood Chain and Tempo.
 *
 *   export DEPLOYER_PK=0x...            # funded deployer (gas is paid in Base Sepolia ETH)
 *   export RPC_URL=https://sepolia.base.org
 *   export POSEIDON2=0x...              # PoseidonT3 from step 2
 *   # Circle's test USDC and EURC on Base Sepolia (6 decimals each), checked on-chain.
 *   # 0x0 lists native ETH (18 decimals). There is no USDT on Base Sepolia to list.
 *   # The three lists below go in the same order: USDC, EURC, ETH.
 *   export LIMIT_ASSETS=0x036CbD53842c5426634e7929541eC2318f3dCF7e,0x808456652fdb597867f38412077A9182bf77359F,0x0000000000000000000000000000000000000000
 *   export LIMIT_PER_DEPOSIT=500000000,500000000,200000000000000000          # 500 USDC; 500 EURC; 0.2 ETH
 *   export LIMIT_TOTAL=25000000000,25000000000,10000000000000000000          # 25,000 USDC; 25,000 EURC; 10 ETH
 *   # Cash-out fee: deposits and private transfers are free, unshield keeps this share of the
 *   # amount for FEE_RECIPIENT (paid out by collectFees(asset)). Capped at 100 bps (1%) in the contract.
 *   export WITHDRAW_FEE_BPS=50          # 0.5%; this is the default when unset
 *   export FEE_RECIPIENT=0xB3900ac9350903218e4c7597bAb0f008F01B30B8   # the treasury
 *   export NEW_OWNER=0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8       # it must call acceptOwnership()
 *   export NEW_OWNER_EOA=1              # the owner is a wallet, not a multisig, as on the other chains
 *
 * Run (Base is an OP Stack chain with no special gas cap; the pool is about
 * 11.9 KB of code, under the 24 KB limit). Dry run first, then:
 *   forge script script/DeployBaseSepolia.s.sol:DeployBaseSepolia --rpc-url $RPC_URL --broadcast --slow
 *
 * After: record the pool address and deploy block in BASE_SEPOLIA_POOL
 * (app/src/lib/mainnet.ts and packages/sdk/src/mainnet.ts).
 */
contract DeployBaseSepolia is MainnetDeploy {
    uint256 constant BASE_SEPOLIA = 84532;

    function run() external {
        _deployMainnet(BASE_SEPOLIA, true);
    }
}
