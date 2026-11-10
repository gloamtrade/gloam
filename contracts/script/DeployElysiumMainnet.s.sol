// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MainnetDeploy} from "./MainnetDeploy.sol";

/**
 * Gloam on Elysium mainnet, Kinetiq's Hyperliquid L2 (an Arbitrum Orbit chain
 * that settles to HyperEVM, gas paid in HYPE). The payments pool with the
 * launch deposit limits, wired the same way as on every other chain
 * (MainnetDeploy), with one difference: the vault is born guarded. Its owner is
 * a VaultOwnerGuard from the deploy itself, so its proof checkers can never be
 * replaced and its ownership can never move (Kann I-02). See
 * MainnetDeploy._deployMainnetGuarded.
 *
 * The chain id is read from ELYSIUM_CHAIN_ID and must be 99901, Elysium
 * mainnet's (Kinetiq's docs). 99801, the testnet, is refused unless
 * ELYSIUM_ALLOW_TESTNET=1 (a rehearsal there; DeployElysiumTestnet is the
 * testnet's own script).
 *
 * The USER runs this. It is NOT executed by CI or by any agent. Runbook: DEPLOY-ELYSIUM.md.
 *
 * Deployed already (contracts/deployments/elysium-mainnet.json): a rerun stops before it reads
 * a key or sends anything (script/RedeployGuard.sol). GLOAM_ALLOW_REDEPLOY=1 is
 * only for a second vault on purpose.
 *
 * Before running:
 *   1. Keys: the script deploys the ceremony-final verifiers (src/verifiers/final)
 *      and refuses to create the pool unless they accept final-key proofs and
 *      reject dev-key ones (MainnetDeploy._requireCeremonyKeys).
 *   2. Deploy PoseidonT3 only:  POSEIDON_T3_ONLY=1 node circuits/scripts/deploy-poseidon.mjs
 *      From a deployer with no transactions on Elysium that lands at
 *      0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4 and this script's pool at
 *      0x39e28cde55cab798874746ac52cb4b5cc99a0194, the same as on the other chains.
 *      The guard is created after the pool, so it does not move the pool.
 *      The 9 November 2026 deploy used its own deployer (0xec9993765e249e8e9DC677B7BCB61F78b31c6b60),
 *      so it landed elsewhere: PoseidonT3 0x62c435CE6886fa91e3b0e91500c6dC9219723457, vault
 *      0x89d3042390204f57b8b4F8949D3c2203E4002164, guard 0x268D7CAd645282D1e77461b5B2dd997bd54eFAf5
 *      (deployments/elysium-mainnet.json).
 *
 *   source elysium-mainnet-env.sh       # sets everything below from four values, reads the key hidden
 *
 *   export ELYSIUM_CHAIN_ID=...         # Elysium mainnet's chain id, from Kinetiq's docs, checked with cast chain-id
 *   export RPC_URL=...                  # an Elysium mainnet RPC
 *   export DEPLOYER_PK=0x...            # funded mainnet deployer (gas is paid in HYPE)
 *   export DEPLOYER=0x...               # the deployer's address; the key must be this address's
 *   export POSEIDON2=0x...              # PoseidonT3 from step 2
 *   # USDC only at launch. Its address comes from Kinetiq's or Circle's docs, checked on
 *   # chain (symbol USDC, and its decimals). 500 per deposit and 25,000 in total, the Base
 *   # launch caps, written here for 6 decimals: scale both if USDC has other decimals.
 *   # Native HYPE (0x0, 18 decimals) may be listed too; it is optional.
 *   export LIMIT_ASSETS=$ELYSIUM_USDC
 *   export LIMIT_PER_DEPOSIT=500000000
 *   export LIMIT_TOTAL=25000000000
 *   # Cash-out fee: deposits and private transfers are free, unshield keeps this share of the
 *   # amount for FEE_RECIPIENT (paid out by collectFees(asset)). Capped at 100 bps (1%) in the contract.
 *   export WITHDRAW_FEE_BPS=50          # 0.5%, the mainnet fee since 3 Nov 2026
 *   export FEE_RECIPIENT=0xB3900ac9350903218e4c7597bAb0f008F01B30B8   # the treasury
 *   # Who runs the guard: a multisig. If no Safe exists on Elysium on day one, use the
 *   # owner wallet with GUARD_CONTROLLER_EOA=1 and move it later with transferController.
 *   export GUARD_CONTROLLER=0x...
 *   export GUARD_CONTROLLER_EOA=1       # only when GUARD_CONTROLLER is a plain wallet
 *   # NEW_OWNER must be unset: the guard is the owner.
 *
 * Run. Elysium is an Arbitrum Orbit chain like Robinhood Chain: gas limits carry
 * the L1 (here HyperEVM) data cost, so check what creating a contract costs first
 * (elysium-mainnet-env.sh does it) and, if it is well over forge's own estimate,
 * add --gas-estimate-multiplier to every --broadcast and --resume (you pay only
 * the gas used). The pool is about 11.9 KB of code, under the 24 KB limit.
 * Dry run first (nothing is sent), then:
 *   forge script script/DeployElysiumMainnet.s.sol:DeployElysiumMainnet --rpc-url $RPC_URL --broadcast --slow
 *
 * After: elysium-mainnet-after-deploy.sh reads the deploy back and writes the
 * pool and its block into packages/sdk/src/elysium.ts. Then GUARD_CONTROLLER calls
 * acceptController() on the guard, if it is not the deployer.
 */
contract DeployElysiumMainnet is MainnetDeploy {
    /// @notice Elysium's testnet. Refused unless ELYSIUM_ALLOW_TESTNET=1.
    uint256 constant ELYSIUM_TESTNET = 99801;
    /// @notice Elysium mainnet's chain id (0x1863d), from Kinetiq's docs.
    uint256 constant ELYSIUM_MAINNET = 99901;

    function run() external {
        uint256 chainId = vm.envOr("ELYSIUM_CHAIN_ID", uint256(0));
        require(chainId != 0, "set ELYSIUM_CHAIN_ID: Elysium mainnet's chain id");
        require(
            chainId != ELYSIUM_TESTNET || vm.envOr("ELYSIUM_ALLOW_TESTNET", uint256(0)) == 1,
            "ELYSIUM_CHAIN_ID is the Elysium testnet: set ELYSIUM_ALLOW_TESTNET=1 for a rehearsal there"
        );
        require(!_isOtherGloamChain(chainId), "ELYSIUM_CHAIN_ID is another Gloam chain, not Elysium");
        require(chainId == ELYSIUM_MAINNET || chainId == ELYSIUM_TESTNET, "ELYSIUM_CHAIN_ID must be 99901, Elysium mainnet's");
        _deployMainnetGuarded(chainId, true);
    }

    /// @dev Every chain Gloam already runs on, mainnet or testnet: none of them is Elysium.
    function _isOtherGloamChain(uint256 id) internal pure returns (bool) {
        return id == 1 || id == 4663 || id == 4217 || id == 8453 || id == 46630 || id == 42431 || id == 84532
            || id == 11155111;
    }
}
