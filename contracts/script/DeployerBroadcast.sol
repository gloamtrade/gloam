// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";

/**
 * Who sends a deploy. DEPLOYER_PK signs it, as it always has.
 *
 * DEPLOYER is the deployer's address. Set next to DEPLOYER_PK, the key must be
 * that address's, so a wrong key stops the dry run before anything is sent.
 * Set alone, forge sends as that address without a key: that is how a local
 * fork rehearses the deploy from the real deployer at its real nonce (a forge
 * test, or anvil with `forge script --unlocked --sender <DEPLOYER>`). On a live
 * RPC forge has no wallet for it and refuses to broadcast. An empty value
 * counts as unset.
 */
abstract contract DeployerBroadcast is Script {
    /// @dev The address _startDeployerBroadcast sends as: DEPLOYER_PK's, else DEPLOYER.
    function _deployerAddress() internal view returns (address deployer) {
        deployer = _deployerOrZero();
        require(deployer != address(0), "set DEPLOYER_PK");
    }

    /// @dev The same, or zero when neither is set (a read-only dry run).
    function _deployerOrZero() internal view returns (address) {
        string memory key = vm.envOr("DEPLOYER_PK", string(""));
        if (bytes(key).length > 0) return vm.addr(vm.parseUint(key));
        string memory named = vm.envOr("DEPLOYER", string(""));
        return bytes(named).length > 0 ? vm.parseAddress(named) : address(0);
    }

    function _startDeployerBroadcast() internal {
        string memory named = vm.envOr("DEPLOYER", string(""));
        address deployer = bytes(named).length > 0 ? vm.parseAddress(named) : address(0);
        string memory key = vm.envOr("DEPLOYER_PK", string(""));
        if (bytes(key).length > 0) {
            uint256 pk = vm.parseUint(key);
            require(deployer == address(0) || vm.addr(pk) == deployer, "DEPLOYER_PK is not the key of DEPLOYER");
            vm.startBroadcast(pk);
        } else {
            require(deployer != address(0), "set DEPLOYER_PK");
            vm.startBroadcast(deployer);
        }
    }
}
