// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {GloamVaultSwapV4, PoolKey} from "../../src/GloamVaultSwapV4.sol";

/**
 * Private swaps through the Robinhood Chain mainnet vault (GloamVaultSwapV4).
 * No owner, no admin, no upgrade: the vault, the treasury, the PoolManager and
 * the allowed pools are fixed here for good. A new list means a new router.
 *
 * The USER runs this. It is NOT executed by CI or by any agent.
 *
 *   export DEPLOYER_PK=0x...      # any funded mainnet account; it gets no powers
 *   export TREASURY=0x...         # where each swap's unused input goes (the treasury)
 *   forge script script/archive/DeployVaultSwapRobinhood.s.sol:DeployVaultSwapRobinhood \
 *     --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
 *
 * After: put the router address in VAULT_SWAP_ROUTERS[4663] (app/src/lib/vaultSwap.ts).
 * The pool list there (RH_SWAP_POOLS) must stay the same as the one below.
 */
contract DeployVaultSwapRobinhood is Script {
    address constant VAULT = 0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant GLOAM = 0xDcD885F5c60b3aD49F6D58718696417314e8724d;
    address constant ORYNTH_HOOK = 0x953391a2DDf7E8437FeB878FDF2C6f325Fbf00CC;

    function pools() public pure returns (PoolKey[] memory p) {
        p = new PoolKey[](3);
        // ETH / USDG, the deepest hookless pool (PoolId 0x3b0cbf06…)
        p[0] = PoolKey(address(0), USDG, 87, 1, address(0));
        // ETH / GLOAM, the launch pool with the Orynth hook (0xc5f37371…)
        p[1] = PoolKey(address(0), GLOAM, 0, 200, ORYNTH_HOOK);
        // USDG / GLOAM direct, 4.215% fee (0xe5b1e488…)
        p[2] = PoolKey(USDG, GLOAM, 42150, 422, address(0));
    }

    function run() external {
        require(block.chainid == 4663, "Robinhood Chain mainnet only");
        address treasury = vm.envAddress("TREASURY");
        uint256 pk = vm.envUint("DEPLOYER_PK");

        vm.startBroadcast(pk);
        GloamVaultSwapV4 router = new GloamVaultSwapV4(VAULT, treasury, POOL_MANAGER, pools());
        vm.stopBroadcast();

        require(address(router.vault()) == VAULT && router.treasury() == treasury, "wiring");
        PoolKey[] memory p = pools();
        for (uint256 i = 0; i < p.length; i++) {
            require(router.allowedPool(keccak256(abi.encode(p[i]))), "pool not allowed");
        }
        console2.log("GloamVaultSwapV4:", address(router));
        console2.log("treasury:", treasury);
    }
}
