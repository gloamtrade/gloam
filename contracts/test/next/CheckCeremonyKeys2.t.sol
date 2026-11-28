// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Ported from test/CheckCeremonyKeys.t.sol to the next vault (not deployed, not audited).
// Keep the two in step until the live vaults are retired.

import {STRAY} from "./NextHarness.sol";
import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolPayments2} from "../../src/ShieldPoolPayments2.sol";
import {DualProofVerifier2} from "../../src/verifiers/DualProofVerifier2.sol";
import {ShieldVerifier} from "../../src/verifiers/ShieldVerifier.sol";
import {ShieldIVerifier} from "../../src/verifiers/ShieldIVerifier.sol";
import {UnshieldVerifier} from "../../src/verifiers/UnshieldVerifier.sol";
import {UnshieldIVerifier} from "../../src/verifiers/UnshieldIVerifier.sol";
import {TransferVerifier} from "../../src/verifiers/TransferVerifier.sol";
import {TransferIVerifier} from "../../src/verifiers/TransferIVerifier.sol";
import {ShieldVerifierFinal} from "../../src/verifiers/final/ShieldVerifierFinal.sol";
import {ShieldIVerifierFinal} from "../../src/verifiers/final/ShieldIVerifierFinal.sol";
import {UnshieldVerifierFinal} from "../../src/verifiers/final/UnshieldVerifierFinal.sol";
import {UnshieldIVerifierFinal} from "../../src/verifiers/final/UnshieldIVerifierFinal.sol";
import {TransferVerifierFinal} from "../../src/verifiers/final/TransferVerifierFinal.sol";
import {TransferIVerifierFinal} from "../../src/verifiers/final/TransferIVerifierFinal.sol";
import {CheckCeremonyKeys} from "../../script/CheckCeremonyKeys.s.sol";

/**
 * The read-back the after-deploy scripts run: a vault on the final keys passes,
 * one with a dev-key verifier on either side stops, and so does an address that
 * is not a vault.
 */
contract CheckCeremonyKeysTestNext is Test {
    using stdJson for string;

    CheckCeremonyKeys check;
    address poseidon;

    function setUp() public {
        check = new CheckCeremonyKeys();
        bytes memory bytecode = vm.readFile("test/fixtures/Poseidon2.json").readBytes(".bytecode");
        address addr;
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "poseidon deploy failed");
        poseidon = addr;
    }

    function _finalDual() internal returns (address) {
        return address(
            new DualProofVerifier2(
                new UnshieldIVerifierFinal(new UnshieldVerifierFinal()),
                new TransferIVerifierFinal(new TransferVerifierFinal())
            )
        );
    }

    function _devDual() internal returns (address) {
        return address(
            new DualProofVerifier2(new UnshieldIVerifier(new UnshieldVerifier()), new TransferIVerifier(new TransferVerifier()))
        );
    }

    function _vault(address dual, address shield) internal returns (address) {
        ShieldPoolPayments2 pool = new ShieldPoolPayments2(poseidon, dual, STRAY);
        pool.setShieldVerifier(shield);
        vm.setEnv("POOL", vm.toString(address(pool)));
        return address(pool);
    }

    function test_final_keys_pass() public {
        _vault(_finalDual(), address(new ShieldIVerifierFinal(new ShieldVerifierFinal())));
        check.run();
    }

    function test_a_dev_shield_verifier_stops() public {
        _vault(_finalDual(), address(new ShieldIVerifier(new ShieldVerifier())));
        vm.expectRevert(bytes("shield verifier rejects a final-key proof"));
        check.run();
    }

    function test_a_dev_spend_verifier_stops() public {
        _vault(_devDual(), address(new ShieldIVerifierFinal(new ShieldVerifierFinal())));
        vm.expectRevert(bytes("unshield verifier rejects a final-key proof"));
        check.run();
    }

    function test_no_vault_stops() public {
        vm.setEnv("POOL", vm.toString(address(0xBEEF)));
        vm.expectRevert();
        check.run();
    }
}
