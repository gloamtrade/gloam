// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MainnetDeploy} from "./MainnetDeploy.sol";

/**
 * Gloam on Robinhood Chain mainnet (chainId 4663): the payments pool with beta
 * deposit limits. The deploy itself is MainnetDeploy, shared with Tempo, so
 * both chains get the same pool wired the same way.
 *
 * The USER runs this. It is NOT executed by CI or by any agent.
 *
 * Deployed already (contracts/deployments/mainnet.json): a rerun stops before it reads
 * a key or sends anything (script/RedeployGuard.sol). GLOAM_ALLOW_REDEPLOY=1 is
 * only for a second vault on purpose.
 *
 * Before running:
 *   1. Keys: the script deploys the ceremony-final verifiers (src/verifiers/final)
 *      and refuses to create the pool unless they accept final-key proofs and
 *      reject dev-key ones (MainnetDeploy._requireCeremonyKeys).
 *   2. Deploy Poseidon on mainnet:  node circuits/scripts/deploy-poseidon.mjs
 *
 *   export DEPLOYER_PK=0x...            # funded mainnet deployer (gas is paid in ETH)
 *   export RPC_URL=https://rpc.mainnet.chain.robinhood.com
 *   export POSEIDON2=0x...              # PoseidonT3 from step 2
 *   # USDG (Paxos Global Dollar, 6 decimals) is 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,
 *   # per docs.paxos.com and checked on-chain. 0x0 lists native ETH (18 decimals).
 *   # GLOAM (Gloam's token, 18 decimals, 500,000 fixed supply) is
 *   # 0xDcD885F5c60b3aD49F6D58718696417314e8724d: a plain OpenZeppelin ERC-20 from the
 *   # Orynth launcher, no transfer tax, checked on-chain. Holders shield it to vote privately.
 *   # The three lists below go in the same order: USDG first, then GLOAM.
 *   export LIMIT_ASSETS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,0xDcD885F5c60b3aD49F6D58718696417314e8724d
 *   export LIMIT_PER_DEPOSIT=500000000,25000000000000000000000      # 500 USDG; 25,000 GLOAM (5% of supply)
 *   export LIMIT_TOTAL=25000000000,250000000000000000000000         # 25,000 USDG; 250,000 GLOAM (half of supply)
 *   # Cash-out fee: deposits and private transfers are free, unshield keeps this share of the
 *   # amount for FEE_RECIPIENT (paid out by collectFees(asset)). Capped at 100 bps (1%) in the contract.
 *   # Leave FEE_RECIPIENT unset to launch with the fee off; turning it on later takes the 3-day timelock.
 *   export WITHDRAW_FEE_BPS=25          # 0.25%; this is the default when unset
 *   export FEE_RECIPIENT=0x...          # fee collector (e.g. the treasury multisig)
 *   export NEW_OWNER=0x...              # the owner multisig; it must call acceptOwnership()
 *
 * Run (Robinhood Chain is an Arbitrum chain with no special gas cap; the pool
 * is about 11.9 KB of code, well under the 24 KB limit):
 *   forge script script/DeployRobinhoodMainnet.s.sol:DeployRobinhoodMainnet --rpc-url $RPC_URL --broadcast
 *
 * After: record the pool address and deploy block in app/src/lib/networks.ts.
 */
contract DeployRobinhoodMainnet is MainnetDeploy {
    uint256 constant ROBINHOOD_MAINNET = 4663;

    function run() external {
        _deployMainnet(ROBINHOOD_MAINNET, true);
    }
}
