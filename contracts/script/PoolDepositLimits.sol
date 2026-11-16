// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ShieldPoolCore} from "../src/ShieldPoolCore.sol";

/**
 * @notice Turns deposit limits on for a pool still in setup, and lists the assets
 *         named in the environment. Every pool's endSetup() requires limits on,
 *         and turnOnDepositLimits() exists only in setup, so a deploy script calls
 *         this before endSetup().
 *
 *   export LIMIT_ASSETS=0xToken,0x0000000000000000000000000000000000000000   # optional
 *   export LIMIT_PER_DEPOSIT=500000000,200000000000000000                    # same order
 *   export LIMIT_TOTAL=25000000000,10000000000000000000
 *
 * With no LIMIT_ASSETS every deposit is refused until a setDepositLimit clears
 * the 3-day timelock. Same lists and checks as script/MainnetDeploy.sol.
 */
abstract contract PoolDepositLimits is Script {
    function _turnOnDepositLimits(ShieldPoolCore pool) internal {
        pool.turnOnDepositLimits();
        address[] memory assets = vm.envOr("LIMIT_ASSETS", ",", new address[](0));
        uint256[] memory per = vm.envOr("LIMIT_PER_DEPOSIT", ",", new uint256[](0));
        uint256[] memory total = vm.envOr("LIMIT_TOTAL", ",", new uint256[](0));
        require(assets.length == per.length && assets.length == total.length, "limit lists differ in length");
        for (uint256 i = 0; i < assets.length; i++) {
            require(assets[i] == address(0) || assets[i].code.length > 0, "listed asset has no code");
            require(per[i] > 0 && per[i] <= total[i], "need 0 < perDeposit <= total");
            require(total[i] <= type(uint128).max, "limit too large");
            pool.setDepositLimit(assets[i], uint128(per[i]), uint128(total[i]));
        }
        if (assets.length == 0) {
            console2.log("No LIMIT_ASSETS: deposits stay closed until a setDepositLimit clears the timelock");
        }
    }
}
