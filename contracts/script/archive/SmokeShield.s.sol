// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ShieldPool} from "../../src/ShieldPool.sol";

/**
 * @notice Live smoke: put dust ETH into the pool (shield only).
 *
 * RH testnet under-estimates gas on multi-tx forge scripts (L2 L1-data overhead).
 * Do shield and pull-back as separate commands.
 *
 *   export DEPLOYER_PK=0x...
 *   export SHIELD_POOL=0x2BD98196D90AB45D58843B4c8B8809aa34343d35
 *
 *   # 1) deposit
 *   forge script script/archive/SmokeShield.s.sol \
 *     --rpc-url https://rpc.testnet.chain.robinhood.com \
 *     --broadcast --gas-estimate-multiplier 200 -vvvv
 *
 *   # 2) pull back (after step 1 confirms). LEGACY 0x2BD9… ONLY: pools built from
 *   #    the current source have no emergencyWithdraw, so smoke deposits there
 *   #    come back out only through a proof-gated unshield.
 *   cast send $SHIELD_POOL \
 *     "emergencyWithdraw(address,address,uint256)" \
 *     0x0000000000000000000000000000000000000000 \
 *     $(cast wallet address --private-key $DEPLOYER_PK) \
 *     100000000000000 \
 *     --rpc-url https://rpc.testnet.chain.robinhood.com \
 *     --private-key $DEPLOYER_PK \
 *     --gas-limit 200000
 */
contract SmokeShield is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address poolAddr = vm.envAddress("SHIELD_POOL");
        uint256 amount = vm.envOr("AMOUNT_WEI", uint256(0.0001 ether));

        ShieldPool pool = ShieldPool(payable(poolAddr));
        address me = vm.addr(pk);

        // unique commitment each run
        bytes32 commitment = keccak256(
            abi.encodePacked("gloam-smoke", me, block.timestamp, amount, pool.nextIndex())
        );

        console2.log("pool", poolAddr);
        console2.log("me", me);
        console2.log("amountWei", amount);
        console2.log("before nextIndex", pool.nextIndex());
        console2.log("before deposited ETH", pool.deposited(address(0)));

        vm.startBroadcast(pk);
        pool.shield{value: amount}(address(0), amount, commitment);
        vm.stopBroadcast();

        console2.log("commitment");
        console2.logBytes32(commitment);
        console2.log("after nextIndex", pool.nextIndex());
        console2.log("after deposited ETH", pool.deposited(address(0)));
        console2.log("OK: shielded. Legacy 0x2BD9 only: pull back via emergencyWithdraw (see header).");
    }
}
