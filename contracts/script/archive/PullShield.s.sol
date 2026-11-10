// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

/// @dev ABI of the PRE-HARDENING legacy keccak pool only. The current ShieldPool /
///      ShieldPoolPoseidon sources have no emergencyWithdraw (owner cannot move
///      user funds), so this script only works against old deployments such as
///      0x2BD9… that were deployed before that removal.
interface ILegacyShieldPool {
    function emergencyWithdraw(address asset, address to, uint256 amount) external;
    function deposited(address asset) external view returns (uint256);
    function owner() external view returns (address);
}

/**
 * @notice LEGACY ONLY: owner pull-back of ETH (or set ASSET) from the pre-hardening
 *         keccak pool 0x2BD9… after a shield test. Hardened pools have no such path.
 *
 *   export DEPLOYER_PK=0x...
 *   export SHIELD_POOL=0x2BD98196D90AB45D58843B4c8B8809aa34343d35
 *   # optional: AMOUNT_WEI=...  (default = full deposited ETH balance)
 *
 *   forge script script/archive/PullShield.s.sol \
 *     --rpc-url https://rpc.testnet.chain.robinhood.com \
 *     --broadcast --gas-estimate-multiplier 300 -vvvv
 *
 * Prefer cast with a hard gas limit if forge still under-estimates:
 *   cast send $SHIELD_POOL "emergencyWithdraw(address,address,uint256)" \
 *     0x0000000000000000000000000000000000000000 <YOU> <AMOUNT> \
 *     --rpc-url https://rpc.testnet.chain.robinhood.com \
 *     --private-key $DEPLOYER_PK --gas-limit 200000
 */
contract PullShield is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address poolAddr = vm.envAddress("SHIELD_POOL");
        address asset = vm.envOr("ASSET", address(0));

        ILegacyShieldPool pool = ILegacyShieldPool(poolAddr);
        address me = vm.addr(pk);
        uint256 amount = vm.envOr("AMOUNT_WEI", pool.deposited(asset));

        require(amount > 0, "nothing deposited");
        require(pool.owner() == me, "DEPLOYER_PK is not pool owner");

        console2.log("pool", poolAddr);
        console2.log("me", me);
        console2.log("asset", asset);
        console2.log("amountWei", amount);

        vm.startBroadcast(pk);
        pool.emergencyWithdraw(asset, me, amount);
        vm.stopBroadcast();

        console2.log("after deposited", pool.deposited(asset));
        console2.log("OK: pulled back");
    }
}
