// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";
import {GloamNames} from "../src/GloamNames.sol";
import {DeployerBroadcast} from "./DeployerBroadcast.sol";

/**
 * Deploys GloamNames on Robinhood Chain mainnet (4663), where $GLOAM lives.
 * One registry serves every chain: a name resolves to a Gloam address key,
 * and the same key receives on all of them.
 *
 * The USER runs this. It is NOT executed by CI or by any agent.
 *
 * Prices are whole $GLOAM per year and have no defaults, so nothing deploys
 * at a price nobody chose. The Gloam Owner Safe owns the registry from the
 * start; it can change prices later with setPrices. Payments go to the
 * treasury (setTreasury can move that later).
 *
 *   export DEPLOYER_PK=0x...
 *   export NAMES_PRICE_3=...   # 3-character names, $GLOAM per year
 *   export NAMES_PRICE_4=...   # 4-character names
 *   export NAMES_PRICE_5=...   # 5 or more characters
 *   forge script script/DeployGloamNames.s.sol:DeployGloamNames \
 *     --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
 */
contract DeployGloamNames is DeployerBroadcast {
    /// @notice $GLOAM on Robinhood Chain mainnet (app/src/lib/buybacks.ts GLOAM_TOKEN).
    address constant GLOAM = 0xDcD885F5c60b3aD49F6D58718696417314e8724d;
    /// @notice The Gloam Owner Safe (2 of 3), the same address on every mainnet.
    address constant OWNER_SAFE = 0x8E74b2b85b40f36771f92392b42BBaeacDC75507;
    /// @notice Gloam's treasury, where name payments collect (app/src/lib/buybacks.ts TREASURY_ADDRESS).
    address constant TREASURY = 0xB3900ac9350903218e4c7597bAb0f008F01B30B8;

    function run() external {
        require(block.chainid == 4663, "GloamNames deploys on Robinhood Chain mainnet only");
        uint256 p3 = vm.envUint("NAMES_PRICE_3") * 1e18;
        uint256 p4 = vm.envUint("NAMES_PRICE_4") * 1e18;
        uint256 p5 = vm.envUint("NAMES_PRICE_5") * 1e18;
        require(p3 >= p4 && p4 >= p5, "shorter names should not cost less");

        _startDeployerBroadcast();
        GloamNames names = new GloamNames(GLOAM, OWNER_SAFE, TREASURY, p3, p4, p5);
        vm.stopBroadcast();

        console2.log("GloamNames", address(names));
        console2.log("owner (Safe)", names.owner());
        console2.log("treasury", names.treasury());
        console2.log("price3 / price4 / price5 (GLOAM per year)", p3 / 1e18, p4 / 1e18, p5 / 1e18);
    }
}
