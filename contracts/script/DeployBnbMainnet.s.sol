// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MainnetDeploy} from "./MainnetDeploy.sol";

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/**
 * Gloam on BNB Chain (BNB Smart Chain mainnet, chain id 56, gas paid in BNB).
 * The payments pool wired the same way as on every other chain (MainnetDeploy)
 * and, like Elysium, born guarded: its owner is a VaultOwnerGuard from the
 * deploy itself, so its proof checkers can never be replaced and its ownership
 * can never move (Kann I-02). See MainnetDeploy._deployMainnetGuarded.
 *
 * The USER runs this. It is NOT executed by CI or by any agent. Runbook: DEPLOY-BNB.md.
 *
 * Assets, all listed in this run so none of them waits on the 3-day timelock
 * (bnb-mainnet-env.sh sets them, each limit from the token's own decimals()):
 *   USDT 0x55d398326f99059fF775485246999027B3197955  18 decimals
 *   USDC 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d  18 decimals
 *   BDX  0x6ad12E761b438beA3EA09F6C6266556Bb24C2181   9 decimals (Beldex's LayerZero OFT)
 *   BNB  address(0), the native coin, 18 decimals
 * The stablecoins here have 18 decimals, not 6: a raw limit copied from Base
 * (50000000000 for 50,000 USDC) would cap USDT at 0.00000005. So this script
 * refuses a listed token whose per-deposit limit is under one whole token, and
 * any token that is not one of the four above (BNB_ALLOW_OTHER_ASSETS=1 for a
 * rehearsal with stand-ins).
 *
 * Where it lands: from the deployer 0xec9993765e249e8e9DC677B7BCB61F78b31c6b60,
 * which has no transactions on BNB Chain (nonce 0, checked 18 November 2026),
 * PoseidonT3 first (deploy-poseidon.mjs) lands at 0x62c435CE6886fa91e3b0e91500c6dC9219723457
 * and this script's vault at 0x89d3042390204f57b8b4F8949D3c2203E4002164, the same
 * addresses as on Elysium. The guard comes after the pool and the four listings,
 * so it lands at the deployer's nonce 16 (not Elysium's guard address).
 * Deployed already (contracts/deployments/bnb-mainnet.json names a vault with code,
 * or this deployer made one): a rerun stops before it reads a key or sends
 * anything (script/RedeployGuard.sol). GLOAM_ALLOW_REDEPLOY=1 is only for a second
 * vault on purpose.
 *
 *   source bnb-mainnet-env.sh          # sets everything, reads the key hidden
 *   forge script script/DeployBnbMainnet.s.sol:DeployBnbMainnet --rpc-url $RPC_URL            # dry run
 *   forge script script/DeployBnbMainnet.s.sol:DeployBnbMainnet --rpc-url $RPC_URL --broadcast --slow
 *
 * After: bnb-mainnet-after-deploy.sh reads the deploy back and writes the pool and
 * its block into packages/sdk/src/bnb.ts. Then GUARD_CONTROLLER (the Safe) calls
 * acceptController() on the guard.
 */
contract DeployBnbMainnet is MainnetDeploy {
    /// @notice BNB Smart Chain mainnet.
    uint256 public constant BNB_MAINNET = 56;

    address public constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address public constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address public constant BDX = 0x6ad12E761b438beA3EA09F6C6266556Bb24C2181;

    function run() external {
        require(block.chainid == BNB_MAINNET, "wrong chain for this script");
        _checkBnbAssets();
        _deployMainnetGuarded(BNB_MAINNET, true);
    }

    /**
     * @dev Every listed asset is one of the four, and each limit is at least one
     *      whole token per deposit in that token's own decimals: a limit written
     *      for 6 decimals stops here instead of landing on a vault that then
     *      needs the 3-day timelock to fix.
     */
    function _checkBnbAssets() internal view {
        address[] memory assets = vm.envAddress("LIMIT_ASSETS", ",");
        uint256[] memory per = vm.envUint("LIMIT_PER_DEPOSIT", ",");
        require(assets.length == per.length, "limit lists differ in length");
        bool others = vm.envOr("BNB_ALLOW_OTHER_ASSETS", uint256(0)) == 1;
        for (uint256 i = 0; i < assets.length; i++) {
            address a = assets[i];
            require(others || a == address(0) || a == USDT || a == USDC || a == BDX, "LIMIT_ASSETS lists a token that is not USDT, USDC, BDX or BNB");
            for (uint256 j = 0; j < i; j++) {
                require(assets[j] != a, "LIMIT_ASSETS lists a token twice");
            }
            uint8 dec = 18;
            if (a != address(0)) {
                require(a.code.length > 0, "listed asset has no code");
                dec = IERC20Decimals(a).decimals();
            }
            require(per[i] >= 10 ** uint256(dec), "a per-deposit limit is under one whole token: limits must be in the token's own decimals");
        }
    }
}
