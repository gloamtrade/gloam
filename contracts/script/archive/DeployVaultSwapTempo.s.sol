// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {GloamVaultSwapTempo} from "../../src/GloamVaultSwapTempo.sol";

/**
 * Private stablecoin swaps through the Tempo mainnet vault, on Tempo's
 * Stablecoin DEX (GloamVaultSwapTempo). No owner, no admin, no upgrade.
 *
 * The USER runs this. It is NOT executed by CI or by any agent.
 *
 *   export DEPLOYER_PK=0x...      # any funded mainnet account (gas is paid in USD); it gets no powers
 *   export TREASURY=0x...         # where each swap's unused input goes (the treasury)
 *   forge script script/archive/DeployVaultSwapTempo.s.sol:DeployVaultSwapTempo \
 *     --rpc-url https://rpc.tempo.xyz --broadcast --gas-estimate-multiplier 115
 *
 * After: put the router address in VAULT_SWAP_ROUTERS[4217] (app/src/lib/vaultSwap.ts).
 */
contract DeployVaultSwapTempo is Script {
    address constant VAULT = 0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194;
    address constant STABLECOIN_DEX = 0xDEc0000000000000000000000000000000000000;

    function run() external {
        require(block.chainid == 4217, "Tempo mainnet only");
        address treasury = vm.envAddress("TREASURY");
        uint256 pk = vm.envUint("DEPLOYER_PK");

        vm.startBroadcast(pk);
        GloamVaultSwapTempo router = new GloamVaultSwapTempo(VAULT, treasury, STABLECOIN_DEX);
        vm.stopBroadcast();

        require(address(router.vault()) == VAULT && router.treasury() == treasury, "wiring");
        console2.log("GloamVaultSwapTempo:", address(router));
        console2.log("treasury:", treasury);
    }
}
