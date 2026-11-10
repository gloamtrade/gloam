// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RejectVerifier} from "../../src/verifiers/RejectVerifier.sol";

/**
 * @notice Deploy a verifier that always rejects (safe wiring test).
 *         Does NOT call setVerifier on the pool — do that manually only if needed.
 *
 *   export DEPLOYER_PK=0x...
 *   forge script script/archive/DeployRejectVerifier.s.sol \
 *     --rpc-url https://rpc.testnet.chain.robinhood.com \
 *     --broadcast
 */
contract DeployRejectVerifier is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        vm.startBroadcast(pk);
        RejectVerifier v = new RejectVerifier();
        vm.stopBroadcast();
        console2.log("RejectVerifier", address(v));
        console2.log("Safe: always false. Do not confuse with production keys.");
    }
}
