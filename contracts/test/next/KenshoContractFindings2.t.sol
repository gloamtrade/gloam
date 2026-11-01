// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Ported from test/KenshoContractFindings.t.sol to the next vault (not deployed, not audited).
// Keep the two in step until the live vaults are retired.

import {PoolHarness2, STRAY} from "./NextHarness.sol";
import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore2} from "../../src/ShieldPoolCore2.sol";
import {IVerifier} from "../../src/interfaces/IVerifier.sol";
import {IPoseidon2} from "../../src/lib/IPoseidon.sol";
import {MockERC20} from "../MockERC20.sol";

/**
 * Kensho CONTRACT-side findings (accounting + state machine).
 *
 * MockVerifier == "attacker holds a valid Groth16 proof for these public inputs".
 * Faithful for contract-side accounting review: the pool's own solvency logic must
 * hold even when every proof it is handed is genuinely valid.
 */
contract MockVerifier is IVerifier {
    bool public ok = true;
    function setOk(bool v) external { ok = v; }
    function verify(bytes calldata, uint256[] calldata) external view returns (bool) {
        return ok;
    }
}

contract KenshoContractFindingsTestNext is Test {
    using stdJson for string;

    PoolHarness2 pool;
    MockVerifier unshieldV;
    address poseidon2;

    address lp = address(0x11c7);      // honest assetOut liquidity provider
    address attacker = address(0xA11CE);

    MockERC20 tokenIn;   // assetIn
    MockERC20 tokenOut;  // assetOut

    function setUp() public {
        poseidon2 = _deployPoseidon();
        unshieldV = new MockVerifier();
        pool = new PoolHarness2(poseidon2, address(unshieldV));

        tokenIn = new MockERC20();
        tokenOut = new MockERC20();
    }

    function test_shield_verifier_is_one_way_cannot_reopen_C1() public {
        MockVerifier shieldV = new MockVerifier();
        pool.setShieldVerifier(address(shieldV));

        // plain shield now blocked
        vm.deal(attacker, 10 ether);
        vm.prank(attacker);
        vm.expectRevert(ShieldPoolCore2.ShieldProofRequired.selector);
        pool.shield{value: 1}(address(0), 1, bytes32(uint256(0x1)));

        // owner CANNOT unset it (one-way)
        vm.expectRevert(ShieldPoolCore2.ShieldVerifierAlreadySet.selector);
        pool.setShieldVerifier(address(0));

        // owner CANNOT repoint it to an always-true verifier either
        MockVerifier other = new MockVerifier();
        vm.expectRevert(ShieldPoolCore2.ShieldVerifierAlreadySet.selector);
        pool.setShieldVerifier(address(other));

        // unbound path stays closed
        vm.prank(attacker);
        vm.expectRevert(ShieldPoolCore2.ShieldProofRequired.selector);
        pool.shield{value: 1}(address(0), 1, bytes32(uint256(0x1)));
    }

    // M-4 FIX: ownership handoff is two-step (transferOwnership names a pending
    // owner; only they can acceptOwnership), so it cannot be sent to a wrong or
    // dead address in one irreversible move.
    function test_two_step_ownership() public {
        address newOwner = address(0xBEEF);

        pool.transferOwnership(newOwner);
        // not transferred until accepted
        assertEq(pool.owner(), address(this));
        assertEq(pool.pendingOwner(), newOwner);

        // a stranger cannot accept
        vm.prank(attacker);
        vm.expectRevert(ShieldPoolCore2.NotPendingOwner.selector);
        pool.acceptOwnership();

        // the pending owner accepts
        vm.prank(newOwner);
        pool.acceptOwnership();
        assertEq(pool.owner(), newOwner);
        assertEq(pool.pendingOwner(), address(0));

        // old owner has lost control
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        pool.transferOwnership(address(this));
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
