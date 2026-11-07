// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MainnetDeploy} from "./MainnetDeploy.sol";

/**
 * Gloam on Elysium testnet (chain id 99801), Kinetiq's Hyperliquid L2 testnet
 * (an Arbitrum Orbit chain that settles to HyperEVM testnet, gas paid in test
 * HYPE). A testnet on the mainnet deploy, like Base Sepolia and Ethereum
 * Sepolia: ShieldPoolPayments on the ceremony's final keys, wired the same way
 * as on every other chain (MainnetDeploy), and born guarded like Elysium
 * mainnet. Its owner is a VaultOwnerGuard from the deploy itself, so its proof
 * checkers can never be replaced and its ownership can never move. See
 * MainnetDeploy._deployMainnetGuarded.
 *
 * The chain id is fixed: the script runs only on 99801, whatever the RPC.
 *
 * The USER runs this. It is NOT executed by CI or by any agent.
 *
 * Before running:
 *   1. Keys: the script deploys the ceremony-final verifiers (src/verifiers/final)
 *      and refuses to create the pool unless they accept final-key proofs and
 *      reject dev-key ones (MainnetDeploy._requireCeremonyKeys).
 *   2. Deploy PoseidonT3 only:  POSEIDON_T3_ONLY=1 node circuits/scripts/deploy-poseidon.mjs
 *      From a deployer with no transactions on Elysium testnet that lands at
 *      0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4 and this script's pool at
 *      0x39e28cde55cab798874746ac52cb4b5cc99a0194, the same as on the other chains.
 *
 *   source elysium-testnet-env.sh       # sets everything below, reads the key hidden
 *
 *   export RPC_URL=https://testnet-rpc.elysium.kinetiq.xyz   # the default; Conduit's
 *                                       # https://rpc-elysium-testnet.t.conduit.xyz also works
 *   export DEPLOYER_PK=0x...            # funded testnet deployer (gas is paid in test HYPE)
 *   export DEPLOYER=0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411   # the key must be this address's
 *   export POSEIDON2=0x...              # PoseidonT3 from step 2
 *   # Test USDC only (Kinetiq's, 6 decimals), at Base Sepolia's testnet limits:
 *   # 500 per deposit and 25,000 in total.
 *   export LIMIT_ASSETS=0x7D29d8047B905000459c0E80c34a26CeedcB47b2
 *   export LIMIT_PER_DEPOSIT=500000000
 *   export LIMIT_TOTAL=25000000000
 *   # Cash-out fee, the same as Elysium mainnet's, so a test there runs mainnet's numbers.
 *   export WITHDRAW_FEE_BPS=50
 *   export FEE_RECIPIENT=0xB3900ac9350903218e4c7597bAb0f008F01B30B8   # the treasury
 *   # Who runs the guard: a multisig, or a plain wallet with GUARD_CONTROLLER_EOA=1.
 *   export GUARD_CONTROLLER=0x...
 *   export GUARD_CONTROLLER_EOA=1       # only when GUARD_CONTROLLER is a plain wallet
 *   # NEW_OWNER must be unset: the guard is the owner.
 *
 * Dry run first (nothing is sent), then:
 *   forge script script/DeployElysiumTestnet.s.sol:DeployElysiumTestnet --rpc-url $RPC_URL --broadcast --slow
 *
 * After: elysium-testnet-after-deploy.sh reads the deploy back and writes the
 * pool and its block into ELYSIUM_TESTNET in packages/sdk/src/elysium.ts.
 */
contract DeployElysiumTestnet is MainnetDeploy {
    /// @notice Elysium testnet's chain id (0x185d9).
    uint256 public constant ELYSIUM_TESTNET = 99801;

    function run() external {
        // Native test HYPE is never listed here: USDC only.
        _deployMainnetGuarded(ELYSIUM_TESTNET, false);
    }
}
