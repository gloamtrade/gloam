// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MainnetDeploy} from "./MainnetDeploy.sol";

/**
 * Gloam on Tempo mainnet (chainId 4217): the payments pool with beta deposit
 * limits. The deploy itself is MainnetDeploy, shared with Robinhood Chain.
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
 *   export DEPLOYER_PK=0x...            # funded mainnet deployer (gas is paid in USD)
 *   export RPC_URL=https://rpc.tempo.xyz
 *   export POSEIDON2=0x...              # PoseidonT3 from step 2
 *   export LIMIT_ASSETS=0xA,0xB         # stablecoins to list (TIP-20 addresses); Tempo has no native coin
 *   export LIMIT_PER_DEPOSIT=500000000,500000000      # raw units (6 decimals: 500 = 500000000)
 *   export LIMIT_TOTAL=25000000000,25000000000        # raw units per asset
 *   # Cash-out fee: deposits and private transfers are free, unshield keeps this share of the
 *   # amount for FEE_RECIPIENT (paid out by collectFees(asset)). Capped at 100 bps (1%) in the contract.
 *   # Leave FEE_RECIPIENT unset to launch with the fee off; turning it on later takes the 3-day timelock.
 *   # A frozen FEE_RECIPIENT never blocks withdrawals; fees just wait in the pool until it can receive.
 *   export WITHDRAW_FEE_BPS=25          # 0.25%; this is the default when unset
 *   export FEE_RECIPIENT=0x...          # fee collector (e.g. the treasury multisig)
 *   export NEW_OWNER=0x...              # the owner multisig; it must call acceptOwnership()
 *
 * Run (Tempo caps a tx at 30M gas and meters code at about 1,100 gas per byte.
 * The pool was ~23.2M at 10.4 KB; the cash-out fee adds ~1.5 KB, so expect about
 * 24.9M. Keep the multiplier at or under 120; forge's default 130 is too high.
 * Check the dry run's estimate before broadcasting):
 *   forge script script/DeployTempoMainnet.s.sol:DeployTempoMainnet --rpc-url $RPC_URL \
 *     --broadcast --gas-estimate-multiplier 115
 *
 * After: record the pool address and deploy block in app/src/lib/networks.ts.
 */
contract DeployTempoMainnet is MainnetDeploy {
    uint256 constant TEMPO_MAINNET = 4217;

    function run() external {
        _deployMainnet(TEMPO_MAINNET, false);
    }
}
