// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";
import {GloamNamesRegistrar} from "../src/GloamNamesRegistrar.sol";
import {DeployerBroadcast} from "./DeployerBroadcast.sol";

interface IVaultCheck {
    function isSpent(bytes32 nullifier) external view returns (bool);
    function withdrawFeeBps() external view returns (uint16);
}

/**
 * Deploys GloamNamesRegistrar on Robinhood Chain mainnet (4663): claim a Gloam
 * name with $GLOAM from a private balance, paid out of the live vault in one
 * relayed transaction. No owner and no admin, so only the deployer is needed
 * (no Safe step). After deploy, set NAMES_REGISTRAR_ADDRESS in
 * app/src/lib/gloamNames.ts and the relay starts accepting private claims.
 *
 * The USER runs this. It is NOT executed by CI or by any agent.
 *
 *   forge script script/DeployGloamNamesRegistrar.s.sol:DeployGloamNamesRegistrar \
 *     --rpc-url https://rpc.mainnet.chain.robinhood.com --interactives 1 \
 *     --sender <deployer> --broadcast
 */
contract DeployGloamNamesRegistrar is DeployerBroadcast {
    /// @notice The Robinhood Chain mainnet vault (contracts/deployments/mainnet.json ShieldPoolPayments).
    address constant VAULT = 0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194;
    /// @notice The GloamNames registry (contracts/deployments/mainnet.json GloamNames).
    address constant NAMES = 0x62c435CE6886fa91e3b0e91500c6dC9219723457;
    /// @notice $GLOAM, which the registry is paid in.
    address constant GLOAM = 0xDcD885F5c60b3aD49F6D58718696417314e8724d;
    /// @notice Gloam's treasury: where a claim's rounding dust goes (the registry pays it the price too).
    address constant TREASURY = 0xB3900ac9350903218e4c7597bAb0f008F01B30B8;

    function run() external returns (GloamNamesRegistrar reg) {
        require(block.chainid == 4663, "the registrar deploys on Robinhood Chain mainnet only");
        // the vault answers the calls a claim makes
        IVaultCheck(VAULT).isSpent(bytes32(0));
        uint16 fee = IVaultCheck(VAULT).withdrawFeeBps();

        _startDeployerBroadcast();
        reg = new GloamNamesRegistrar(VAULT, NAMES, TREASURY);
        vm.stopBroadcast();

        require(reg.token() == GLOAM, "the registry is not paid in $GLOAM");
        console2.log("GloamNamesRegistrar", address(reg));
        console2.log("vault", address(reg.vault()));
        console2.log("names", address(reg.names()));
        console2.log("token", reg.token());
        console2.log("treasury", reg.treasury());
        console2.log("vault cash-out fee (bps)", fee);
    }
}
