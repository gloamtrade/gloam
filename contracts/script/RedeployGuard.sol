// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";
import {DeployerBroadcast} from "./DeployerBroadcast.sol";

/**
 * A mainnet vault deploy runs once per chain. A second run would land a second
 * vault next to the live one, so every mainnet deploy (MainnetDeploy) asks this
 * first and stops, before it reads a key or sends anything, when:
 *
 *   1. the vault recorded for this chain in contracts/deployments/ has code on
 *      chain (the deploy happened and was written down), or
 *   2. the deployer already created a vault on this chain: one of the addresses
 *      its earlier nonces created answers verifier(), shieldVerifier() and
 *      poseidon2() (the deploy happened, but nobody recorded it yet).
 *
 * The second check reads the deployer's first REDEPLOY_SCAN_NONCES nonces, which
 * covers a deployer used the way the runbooks say (PoseidonT3 first, then the
 * vault). It needs the deployer (DEPLOYER_PK or DEPLOYER); a dry run with neither
 * runs only the first check, and the deploy itself stops later without one.
 *
 * GLOAM_ALLOW_REDEPLOY=1 skips both, for a second vault on purpose (a fork
 * rehearsal of a chain that already has one, or a new vault after an incident).
 *
 * Testnets are not checked: rehearsals there run again on purpose. A new mainnet
 * gets a line in _vaultRecord before its first deploy; until its deployments file
 * names a vault, only the deployer check applies there.
 */
abstract contract RedeployGuard is DeployerBroadcast {
    /// @notice How many of the deployer's nonces the second check reads.
    uint256 internal constant REDEPLOY_SCAN_NONCES = 64;

    string internal constant REDEPLOY_HINT = ". Set GLOAM_ALLOW_REDEPLOY=1 only to deploy a second vault on purpose";

    /// @dev Both checks for this chain and deployer, unless GLOAM_ALLOW_REDEPLOY=1.
    function _refuseRedeploy() internal view {
        if (vm.envOr("GLOAM_ALLOW_REDEPLOY", uint256(0)) == 1) {
            console2.log("GLOAM_ALLOW_REDEPLOY=1: redeploy check skipped, this run deploys another vault");
            return;
        }
        _requireFirstDeploy(block.chainid, _deployerOrZero());
    }

    /// @dev Reverts when this chain's vault is already deployed (see the contract comment).
    function _requireFirstDeploy(uint256 chainId, address deployer) internal view {
        (string memory file, string memory key) = _vaultRecord(chainId);
        if (bytes(file).length == 0) return;

        address recorded = _recordedVault(file, key);
        if (recorded != address(0) && recorded.code.length > 0) {
            revert(
                string.concat(
                    "already deployed: this chain's vault ",
                    vm.toString(recorded),
                    " (",
                    file,
                    ") has code",
                    REDEPLOY_HINT
                )
            );
        }

        if (deployer == address(0)) {
            console2.log("Redeploy check: no deployer set, so only the recorded vault was checked");
            return;
        }
        uint256 nonce = vm.getNonce(deployer);
        uint256 upTo = nonce < REDEPLOY_SCAN_NONCES ? nonce : REDEPLOY_SCAN_NONCES;
        for (uint256 k = 0; k < upTo; k++) {
            address made = vm.computeCreateAddress(deployer, k);
            if (_looksLikeVault(made)) {
                revert(
                    string.concat(
                        "already deployed: the deployer made a vault at ",
                        vm.toString(made),
                        " (its nonce ",
                        vm.toString(k),
                        ")",
                        REDEPLOY_HINT
                    )
                );
            }
        }
        if (nonce > upTo) console2.log("Redeploy check: deployer nonces read", upTo, "of", nonce);
        console2.log("Redeploy check passed: no vault on this chain yet");
    }

    /**
     * @dev Where each mainnet's vault is recorded: the file under contracts/ and
     *      the JSON key of its address. An empty file means not a mainnet.
     */
    function _vaultRecord(uint256 chainId) internal view virtual returns (string memory file, string memory key) {
        if (chainId == 4663) return ("deployments/mainnet.json", ".chains.4663.ShieldPoolPayments");
        if (chainId == 4217) return ("deployments/mainnet.json", ".chains.4217.ShieldPoolPayments");
        if (chainId == 8453) return ("deployments/base-mainnet.json", ".contracts.ShieldPoolPayments");
        if (chainId == 1) return ("deployments/ethereum-mainnet.json", ".contracts.ShieldPoolPayments");
        if (chainId == 99901) return ("deployments/elysium-mainnet.json", ".contracts.ShieldPoolPayments");
    }

    /// @dev The recorded vault, or zero while the file names none.
    function _recordedVault(string memory file, string memory key) internal view returns (address) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/", file));
        if (!vm.keyExistsJson(json, key)) return address(0);
        return vm.parseJsonAddress(json, key);
    }

    /// @dev A contract that answers the vault's three fixed getters with one word each.
    function _looksLikeVault(address a) internal view returns (bool) {
        if (a.code.length == 0) return false;
        return _answersWord(a, "verifier()") && _answersWord(a, "shieldVerifier()") && _answersWord(a, "poseidon2()");
    }

    /// @dev Capped gas: a contract that answers an unknown call with INVALID (PoseidonT3
    ///      does) would otherwise burn 63/64 of what the run has left.
    function _answersWord(address a, string memory sig) private view returns (bool) {
        (bool ok, bytes memory ret) = a.staticcall{gas: 100_000}(abi.encodeWithSignature(sig));
        return ok && ret.length == 32;
    }
}
