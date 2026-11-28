// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Ported from test/GloamSecurityFixes.t.sol to the next vault (not deployed, not audited).
// Keep the two in step until the live vaults are retired.

import {PoolHarness2, STRAY} from "./NextHarness.sol";
import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore2} from "../../src/ShieldPoolCore2.sol";
import {IVerifier} from "../../src/interfaces/IVerifier.sol";
import {IPoseidon2} from "../../src/lib/IPoseidon.sol";

/**
 * Kensho security-fix regression tests for PoolHarness2.
 *
 * MockVerifier models "the attacker holds a valid Groth16 proof." This is faithful,
 * not a cheat: the real verifier returns true for any (root, nullifier, asset, amount, to)
 * whenever a leaf = Poseidon(secret, amount, asset) is in the tree — and shield() lets the
 * attacker insert exactly such a leaf while depositing a smaller amount (C1). So a
 * true-returning verifier stands in for a genuinely provable-but-inflated note.
 */
contract MockVerifier is IVerifier {
    bool public ok = true;

    function setOk(bool v) external {
        ok = v;
    }

    function verify(bytes calldata, uint256[] calldata) external view returns (bool) {
        return ok;
    }
}

contract GloamSecurityFixesTestNext is Test {
    using stdJson for string;

    PoolHarness2 pool;
    MockVerifier unshieldV;
    address poseidon2;

    address victim = address(0x11c7);
    address attacker = address(0xA11CE);

    function setUp() public {
        poseidon2 = _deployPoseidon();
        unshieldV = new MockVerifier();
        pool = new PoolHarness2(poseidon2, address(unshieldV));
        vm.deal(victim, 100 ether);
        vm.deal(attacker, 100 ether);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // C1 — value not bound at shield: deposit small, embed large in commitment,
    // unshield large, drain other users. Demonstrated at the contract level.
    // (Documents the bug the v2 note scheme fixes; unchanged v1 accounting.)
    // ─────────────────────────────────────────────────────────────────────────
    function test_C1_value_not_bound_at_shield_drains_pool() public {
        // Victim honestly shields 10 ETH.
        vm.prank(victim);
        pool.shield{value: 10 ether}(address(0), 10 ether, bytes32(uint256(0xBEEF)));
        assertEq(address(pool).balance, 10 ether);

        // Attacker deposits 1 wei but inserts a *different* commitment. In reality that
        // commitment = Poseidon(secret, 10 ether, asset); the pool never checks it.
        vm.prank(attacker);
        pool.shield{value: 1}(address(0), 1, bytes32(uint256(0xA11CE)));

        // Attacker unshields 10 ETH against a known root with a "valid" proof.
        bytes32 root = pool.currentRoot();
        uint256 balBefore = attacker.balance;
        vm.prank(attacker);
        pool.unshield(hex"00", root, bytes32(uint256(1)), address(0), attacker, 10 ether);

        // Attacker walked away with the victim's 10 ETH for 1 wei.
        assertEq(attacker.balance, balBefore + 10 ether);
        assertLt(address(pool).balance, 1 ether);
    }

    function test_duplicate_commitment_reverts() public {
        vm.prank(victim);
        pool.shield{value: 1 ether}(address(0), 1 ether, bytes32(uint256(0xC0FFEE)));
        vm.prank(victim);
        vm.expectRevert(ShieldPoolCore2.DuplicateCommitment.selector);
        pool.shield{value: 1 ether}(address(0), 1 ether, bytes32(uint256(0xC0FFEE)));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // C1 fix — once a shieldVerifier is set, plain shield() is blocked and the
    // value-bound path (proof required) is enforced.
    // ─────────────────────────────────────────────────────────────────────────
    function test_C1fix_plain_shield_blocked_when_verifier_set() public {
        MockVerifier shieldV = new MockVerifier();
        pool.setShieldVerifier(address(shieldV));
        vm.prank(attacker);
        vm.expectRevert(ShieldPoolCore2.ShieldProofRequired.selector);
        pool.shield{value: 1}(address(0), 1, bytes32(uint256(0x1)));
    }

    function test_C1fix_shieldBound_rejects_bad_proof() public {
        MockVerifier shieldV = new MockVerifier();
        shieldV.setOk(false);
        pool.setShieldVerifier(address(shieldV));
        vm.prank(attacker);
        vm.expectRevert(ShieldPoolCore2.InvalidProof.selector);
        pool.shieldBound{value: 1 ether}(address(0), 1 ether, bytes32(uint256(0x2)), hex"00");
    }

    function test_C1fix_shieldBound_accepts_good_proof() public {
        MockVerifier shieldV = new MockVerifier(); // ok = true
        pool.setShieldVerifier(address(shieldV));
        vm.prank(victim);
        pool.shieldBound{value: 2 ether}(address(0), 2 ether, bytes32(uint256(0x3)), hex"00");
        assertEq(pool.deposited(address(0)), 2 ether);
        assertEq(pool.nextIndex(), 1);
    }

    function test_C1fix_shieldBound_reverts_without_verifier() public {
        vm.prank(victim);
        vm.expectRevert(ShieldPoolCore2.VerifierNotSet.selector);
        pool.shieldBound{value: 1 ether}(address(0), 1 ether, bytes32(uint256(0x4)), hex"00");
    }

    // helper: make a known root by shielding once
    function _seedRoot() internal returns (bytes32) {
        vm.prank(victim);
        pool.shield{value: 1 ether}(address(0), 1 ether, bytes32(uint256(0xD00D)));
        return pool.currentRoot();
    }

    function _deployPoseidon() internal returns (address addr) {
        string memory json = vm.readFile("test/fixtures/Poseidon2.json");
        bytes memory bytecode = json.readBytes(".bytecode");
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "poseidon deploy failed");
    }
}
