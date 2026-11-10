// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VaultOwnerGuard} from "../src/VaultOwnerGuard.sol";

/// @notice The part of the live vault (ShieldPoolPayments) this script reads.
interface IVaultRead {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function setupMode() external view returns (bool);
    function depositLimitsOn() external view returns (bool);
    function verifier() external view returns (address);
    function shieldVerifier() external view returns (address);
}

/**
 * Deploys VaultOwnerGuard at one address on all four mainnets. The runbook is
 * the owner guard section of DEPLOY.md.
 *
 * The USER runs this. It is NOT executed by CI or by any agent. Deploying moves
 * no ownership: the guard does nothing until the vault's owner offers it the
 * vault and the controller accepts (contracts/launch/guard.html).
 *
 * Same address everywhere: the deployer's nonce differs per chain (19, 20, 19,
 * 21 when this was written), so a plain CREATE cannot match. The script calls
 * the canonical CREATE2 factory (0x4e59b44847b379578588920cA78FbF26c0B4956C, the
 * same code on all four) itself, rather than `new X{salt: ...}`: forge routes
 * that through the factory on three of the four chains, but not when it
 * simulates Base. The address depends only on the salt and the init code, so
 * any compiler setting or source change moves it: compile from one commit for
 * all four. A deploy from someone else's key lands the same contract with the
 * same controller, so the script accepts a guard already there once it checks out.
 *
 * Any time, no key, nothing sent (the address, and where each chain stands):
 *   forge script script/DeployVaultOwnerGuard.s.sol:DeployVaultOwnerGuard \
 *     --sig "status()" --rpc-url <RPC>
 *
 * Deploy. --interactives 1 makes forge ask for the key once; nothing is stored,
 * and no key belongs in a file or an env var. Who sends it does not move the
 * address (CREATE2: only the salt and the init code count), so any funded
 * account can; use the owner wallet, CONTROLLER below, which owns the vault on
 * all four chains. Forge simulates the run first and sends nothing if a check
 * fails. Without --broadcast this is a dry run that needs no key.
 *   forge script script/DeployVaultOwnerGuard.s.sol:DeployVaultOwnerGuard \
 *     --rpc-url <RPC> --sender 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8 \
 *     --interactives 1 --broadcast --slow
 *
 * After the owner's handover on that chain, this fails unless it landed right:
 *   forge script script/DeployVaultOwnerGuard.s.sol:DeployVaultOwnerGuard \
 *     --sig "check()" --rpc-url <RPC>
 *
 * RPCs: https://rpc.tempo.xyz, https://ethereum-rpc.publicnode.com,
 * https://base-rpc.publicnode.com, https://rpc.mainnet.chain.robinhood.com.
 */
contract DeployVaultOwnerGuard is Script {
    /// @notice The vault, the same address on all four chains.
    address public constant VAULT = 0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194;
    /// @notice The vault's owner today, and the guard's first controller. It is
    ///         part of the init code, so it fixes the address; the controller
    ///         then moves to the Safe with transferController (DEPLOY.md).
    address public constant CONTROLLER = 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8;
    address public constant VERIFIER = 0x1421353d471dF6C847713aee391Db38978fE714a;
    address public constant SHIELD_VERIFIER = 0x69Fa6d2De0A66dA718DF022cEe98485AfDb03465;

    /// @notice keccak256 of the vault's runtime code, the same on all four chains
    ///         and equal to src/ShieldPoolPayments.sol as compiled from this repo.
    bytes32 public constant VAULT_CODEHASH = 0x58d9843b0c6d9b81fbbb015de6a2413a7443cc63476185edf43d882f672088f2;

    /// @notice The CREATE2 factory's runtime code hash.
    bytes32 public constant FACTORY_CODEHASH = 0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;

    bytes32 public constant SALT = keccak256("gloam.vault-owner-guard.v1");

    function _initCode() internal pure returns (bytes memory) {
        return abi.encodePacked(type(VaultOwnerGuard).creationCode, abi.encode(VAULT, CONTROLLER));
    }

    /// @notice Where the guard lands on every chain, from this build.
    function predicted() public pure returns (address) {
        return vm.computeCreate2Address(SALT, keccak256(_initCode()), CREATE2_FACTORY);
    }

    function run() external returns (VaultOwnerGuard guard) {
        _checkChain();
        require(CREATE2_FACTORY.codehash == FACTORY_CODEHASH, "the CREATE2 factory is not the canonical one");
        _checkVault();

        address at = predicted();
        console2.log("guard address", at);
        if (at.code.length == 0) {
            vm.startBroadcast();
            // The factory's interface: 32 bytes of salt, then the init code.
            (bool ok, ) = CREATE2_FACTORY.call(abi.encodePacked(SALT, _initCode()));
            vm.stopBroadcast();
            require(ok && at.code.length > 0, "the factory did not deploy the guard");
        } else {
            console2.log("already deployed here, nothing to send");
        }
        guard = VaultOwnerGuard(at);
        require(address(guard.vault()) == VAULT, "guard names the wrong vault");
        require(guard.controller() == CONTROLLER, "guard has another controller: review this script");
        require(guard.pendingController() == address(0), "guard has a controller handover pending");
        console2.log("guard controller", guard.controller());
        console2.log("Next: verify the source, then the handover. See the owner guard section of DEPLOY.md.");
    }

    /// @notice Reads only: where this chain stands.
    function status() external view {
        _checkChain();
        IVaultRead v = IVaultRead(VAULT);
        address at = predicted();
        console2.log("chain", block.chainid);
        console2.log("guard address", at);
        console2.log("guard deployed here", at.code.length > 0);
        console2.log("vault code as expected", VAULT.codehash == VAULT_CODEHASH);
        console2.log("factory code as expected", CREATE2_FACTORY.codehash == FACTORY_CODEHASH);
        console2.log("vault owner", v.owner());
        console2.log("vault pending owner", v.pendingOwner());
        console2.log("setup mode (must be false)", v.setupMode());
        console2.log("verifier as deployed", v.verifier() == VERIFIER);
        console2.log("shield verifier as deployed", v.shieldVerifier() == SHIELD_VERIFIER);
        if (at.code.length > 0) {
            console2.log("guard controller", VaultOwnerGuard(at).controller());
            console2.log("guard pending controller", VaultOwnerGuard(at).pendingController());
        }
    }

    /// @notice Reads only, and reverts unless the guard holds the vault as intended.
    function check() external view {
        _checkChain();
        IVaultRead v = IVaultRead(VAULT);
        address at = predicted();
        require(at.code.length > 0, "guard not deployed on this chain");
        VaultOwnerGuard guard = VaultOwnerGuard(at);
        require(address(guard.vault()) == VAULT, "guard names the wrong vault");
        require(guard.pendingController() == address(0), "guard has a controller handover pending");
        require(VAULT.codehash == VAULT_CODEHASH, "vault code changed");
        require(v.owner() == at, "the guard does not own the vault");
        require(v.pendingOwner() == address(0), "someone is offered the vault");
        require(!v.setupMode(), "setup is open");
        require(v.depositLimitsOn(), "deposit limits are off");
        require(v.verifier() == VERIFIER, "verifier changed");
        require(v.shieldVerifier() == SHIELD_VERIFIER, "shield verifier changed");
        // The filter itself, asked on chain.
        bytes memory setVerifier = abi.encodeWithSignature("setVerifier(address)", address(1));
        bytes memory setShield = abi.encodeWithSignature("setShieldVerifier(address)", address(1));
        require(!guard.isAllowedChange(setVerifier), "the filter allows setVerifier");
        require(!guard.isAllowedChange(setShield), "the filter allows setShieldVerifier");
        console2.log("guard controller", guard.controller());
        console2.log("All checks passed: the guard owns the vault on chain", block.chainid);
    }

    /// @dev The vault is the one this script was written for, ready for a guard:
    ///      setup over, nobody else offered it. A guard already holding it is fine.
    function _checkVault() internal view {
        require(VAULT.codehash == VAULT_CODEHASH, "vault code changed: review this script");
        IVaultRead v = IVaultRead(VAULT);
        require(!v.setupMode(), "vault still in setup: the guard would refuse it");
        address owner = v.owner();
        require(owner == CONTROLLER || owner == predicted(), "vault owner changed: review this script");
        address pending = v.pendingOwner();
        require(pending == address(0) || pending == predicted(), "someone else is offered the vault");
    }

    function _checkChain() internal view {
        uint256 id = block.chainid;
        require(id == 4663 || id == 4217 || id == 8453 || id == 1, "not a Gloam mainnet");
    }
}
