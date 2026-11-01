// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Ported from test/NoMiddlemen.t.sol to the next vault (not deployed, not audited).
// Keep the two in step until the live vaults are retired.

import {PoolHarness2, STRAY} from "./NextHarness.sol";
import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore2} from "../../src/ShieldPoolCore2.sol";
import {ChangeTimelock} from "../../src/lib/ChangeTimelock.sol";
import {IVerifier} from "../../src/interfaces/IVerifier.sol";
import {MockERC20} from "../MockERC20.sol";

contract TLMockVerifier is IVerifier {
    bool public ok;

    constructor(bool ok_) {
        ok = ok_;
    }

    function verify(bytes calldata, uint256[] calldata) external view returns (bool) {
        return ok;
    }
}

/**
 * No-middlemen hardening: the owner cannot move user funds, and after endSetup()
 * cannot change any proof / pricing / asset-flow rule without a public queue
 * event at least CHANGE_DELAY earlier.
 */
contract NoMiddlemenTestNext is Test {
    using stdJson for string;

    PoolHarness2 pool;
    TLMockVerifier rejectV; // pool's proof verifier: rejects everything
    MockERC20 token;
    address poseidon2;

    address owner = address(this);
    address user = address(0x1234);
    address attacker = address(0xA11CE);
    address assetB = address(0xEEE);

    event SetupEnded(address indexed by);
    event ChangeQueued(bytes32 indexed id, bytes call, uint256 eta);
    event ChangeExecuted(bytes32 indexed id);
    event ChangeCancelled(bytes32 indexed id);
    event VerifierSet(address indexed verifier);

    function setUp() public {
        vm.warp(1_900_000_000);
        poseidon2 = _deployPoseidon();
        rejectV = new TLMockVerifier(false);
        pool = new PoolHarness2(poseidon2, address(rejectV));
        token = new MockERC20();
        vm.deal(user, 100 ether);
        vm.deal(attacker, 100 ether);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Setup mode
    // ─────────────────────────────────────────────────────────────────────────

    function test_setupMode_true_at_construction() public view {
        assertTrue(pool.setupMode());
        assertEq(pool.CHANGE_DELAY(), 3 days);
        assertEq(pool.CHANGE_GRACE(), 14 days);
    }

    function test_setters_instant_during_setup() public {
        TLMockVerifier v = new TLMockVerifier(true);
        pool.setVerifier(address(v));
        assertEq(address(pool.verifier()), address(v));

        pool.setShieldVerifier(address(v));
        assertEq(address(pool.shieldVerifier()), address(v));
    }

    function test_endSetup_flips_mode_and_emits() public {
        vm.expectEmit(true, false, false, true, address(pool));
        emit SetupEnded(owner);
        pool.endSetup();
        assertFalse(pool.setupMode());

        // irreversible / one-shot
        vm.expectRevert(ChangeTimelock.SetupAlreadyEnded.selector);
        pool.endSetup();
    }

    function test_endSetup_only_owner() public {
        vm.prank(attacker);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        pool.endSetup();
        assertTrue(pool.setupMode());
    }

    function test_direct_setters_revert_after_setup() public {
        pool.endSetup();
        address v = address(new TLMockVerifier(true));

        vm.expectRevert(ChangeTimelock.TimelockRequired.selector);
        pool.setVerifier(v);
        vm.expectRevert(ChangeTimelock.TimelockRequired.selector);
        pool.setShieldVerifier(v);

        // nothing changed
        assertEq(address(pool.verifier()), address(rejectV));
        assertEq(address(pool.shieldVerifier()), address(0));
    }

    function test_non_owner_setters_still_NotOwner() public {
        vm.startPrank(attacker);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        pool.setVerifier(attacker);
        vm.stopPrank();
    }

    function test_queue_reverts_during_setup() public {
        vm.expectRevert(ChangeTimelock.SetupActive.selector);
        pool.queueChange(abi.encodeCall(ShieldPoolCore2.setVerifier, (address(1))));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Queue -> delay -> execute
    // ─────────────────────────────────────────────────────────────────────────

    function test_queue_execute_verifier_change() public {
        pool.endSetup();
        TLMockVerifier v2 = new TLMockVerifier(true);
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setVerifier, (address(v2)));
        bytes32 id = keccak256(call_);
        uint256 expectEta = block.timestamp + 3 days;

        vm.expectEmit(true, false, false, true, address(pool));
        emit ChangeQueued(id, call_, expectEta);
        (bytes32 qid, uint256 eta) = pool.queueChange(call_);
        assertEq(qid, id);
        assertEq(qid, pool.changeId(call_));
        assertEq(eta, expectEta);
        assertEq(pool.changeEta(id), eta);

        // still the old verifier while pending
        assertEq(address(pool.verifier()), address(rejectV));

        vm.warp(eta);
        vm.expectEmit(true, false, false, true, address(pool));
        emit VerifierSet(address(v2));
        vm.expectEmit(true, false, false, true, address(pool));
        emit ChangeExecuted(id);
        pool.executeChange(call_);

        assertEq(address(pool.verifier()), address(v2));
        assertEq(pool.changeEta(id), 0);
    }

    function test_execute_before_eta_reverts() public {
        pool.endSetup();
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setVerifier, (address(0xB0B)));
        (, uint256 eta) = pool.queueChange(call_);

        vm.expectRevert(ChangeTimelock.ChangeNotReady.selector);
        pool.executeChange(call_);

        vm.warp(eta - 1);
        vm.expectRevert(ChangeTimelock.ChangeNotReady.selector);
        pool.executeChange(call_);
        assertEq(address(pool.verifier()), address(rejectV));
    }

    function test_execute_after_grace_reverts() public {
        pool.endSetup();
        address next = address(new TLMockVerifier(true));
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setVerifier, (next));
        (, uint256 eta) = pool.queueChange(call_);

        vm.warp(eta + 14 days + 1);
        vm.expectRevert(ChangeTimelock.ChangeExpired.selector);
        pool.executeChange(call_);
        assertEq(address(pool.verifier()), address(rejectV));

        // an expired entry may be re-queued, which restarts the full delay
        (, uint256 eta2) = pool.queueChange(call_);
        assertEq(eta2, block.timestamp + 3 days);
        vm.expectRevert(ChangeTimelock.ChangeNotReady.selector);
        pool.executeChange(call_);
        vm.warp(eta2);
        pool.executeChange(call_);
        assertEq(address(pool.verifier()), next);
    }

    function test_execute_at_last_grace_second_works() public {
        pool.endSetup();
        address next = address(new TLMockVerifier(true));
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setVerifier, (next));
        (, uint256 eta) = pool.queueChange(call_);
        vm.warp(eta + 14 days);
        pool.executeChange(call_);
        assertEq(address(pool.verifier()), next);
    }

    function test_cancel_works() public {
        pool.endSetup();
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setVerifier, (address(0xB0B)));
        (bytes32 id, uint256 eta) = pool.queueChange(call_);

        vm.expectEmit(true, false, false, true, address(pool));
        emit ChangeCancelled(id);
        pool.cancelChange(call_);
        assertEq(pool.changeEta(id), 0);

        vm.warp(eta);
        vm.expectRevert(ChangeTimelock.ChangeNotQueued.selector);
        pool.executeChange(call_);
        assertEq(address(pool.verifier()), address(rejectV));

        // cancelling something not queued reverts
        vm.expectRevert(ChangeTimelock.ChangeNotQueued.selector);
        pool.cancelChange(call_);
    }

    function test_non_owner_cannot_queue_execute_cancel() public {
        pool.endSetup();
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setVerifier, (attacker));

        vm.prank(attacker);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        pool.queueChange(call_);

        // owner queues; attacker can neither execute nor cancel it
        (, uint256 eta) = pool.queueChange(call_);
        vm.warp(eta);
        vm.prank(attacker);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        pool.executeChange(call_);
        vm.prank(attacker);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        pool.cancelChange(call_);
        assertEq(address(pool.verifier()), address(rejectV));
    }

    function test_queued_call_cannot_execute_twice() public {
        pool.endSetup();
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setDepositLimit, (address(0), 1, 1));
        (, uint256 eta) = pool.queueChange(call_);
        vm.warp(eta);
        pool.executeChange(call_);

        vm.expectRevert(ChangeTimelock.ChangeNotQueued.selector);
        pool.executeChange(call_);

        // Re-applying the same change needs a fresh queue and a fresh full delay.
        (, uint256 eta2) = pool.queueChange(call_);
        assertEq(eta2, block.timestamp + 3 days);
        vm.expectRevert(ChangeTimelock.ChangeNotReady.selector);
        pool.executeChange(call_);
    }

    function test_cannot_requeue_live_change() public {
        pool.endSetup();
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setVerifier, (address(0xB0B)));
        (, uint256 eta) = pool.queueChange(call_);
        vm.warp(eta - 1 hours);
        vm.expectRevert(ChangeTimelock.ChangeAlreadyQueued.selector);
        pool.queueChange(call_);
        assertEq(pool.changeEta(keccak256(call_)), eta);
    }

    function test_queue_rejects_non_setter_calls() public {
        pool.endSetup();
        bytes[] memory bad = new bytes[](10);
        bad[0] = abi.encodeCall(ShieldPoolCore2.transferOwnership, (attacker));
        bad[1] = abi.encodeCall(ShieldPoolCore2.sweepStrayNative, (attacker));
        bad[2] = abi.encodeCall(ChangeTimelock.endSetup, ());
        bad[3] = abi.encodeCall(ChangeTimelock.executeChange, (hex"12345678"));
        bad[4] = abi.encodeCall(ChangeTimelock.queueChange, (hex"12345678"));
        bad[5] = abi.encodeWithSignature(
            "emergencyWithdraw(address,address,uint256)", address(0), attacker, 1
        );
        bad[6] = abi.encodeWithSignature(
            "unshield(bytes,bytes32,bytes32,address,address,uint256)",
            hex"00", bytes32(0), bytes32(0), address(0), attacker, 1
        );
        bad[7] = hex"";
        bad[8] = hex"aabbcc";
        bad[9] = abi.encodeCall(ShieldPoolCore2.acceptOwnership, ());
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(ChangeTimelock.UnknownChange.selector);
            pool.queueChange(bad[i]);
        }
    }

    function test_queue_rejects_non_canonical_length() public {
        pool.endSetup();
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setVerifier, (address(0xB0B)));
        vm.expectRevert(ChangeTimelock.BadChangeLength.selector);
        pool.queueChange(bytes.concat(call_, hex"00"));
        vm.expectRevert(ChangeTimelock.BadChangeLength.selector);
        pool.queueChange(abi.encodePacked(ShieldPoolCore2.setVerifier.selector, uint128(1)));
    }

    function test_new_owner_inherits_queue_old_owner_loses_it() public {
        pool.endSetup();
        address next = address(new TLMockVerifier(true));
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setVerifier, (next));
        (, uint256 eta) = pool.queueChange(call_);
        address newOwner = address(0xBEEF);
        pool.transferOwnership(newOwner);
        vm.prank(newOwner);
        pool.acceptOwnership();

        vm.warp(eta);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        pool.executeChange(call_);
        vm.prank(newOwner);
        pool.executeChange(call_);
        assertEq(address(pool.verifier()), next);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Owner cannot move user funds
    // ─────────────────────────────────────────────────────────────────────────

    function test_emergencyWithdraw_removed() public {
        _seedDeposits();
        (bool ok, ) = address(pool).call(
            abi.encodeWithSignature(
                "emergencyWithdraw(address,address,uint256)",
                address(0),
                owner,
                1 ether
            )
        );
        assertFalse(ok, "emergencyWithdraw must not exist");
        (ok, ) = address(pool).call(
            abi.encodeWithSignature(
                "emergencyWithdraw(address,address,uint256)",
                address(token),
                owner,
                1 ether
            )
        );
        assertFalse(ok, "emergencyWithdraw must not exist");
        _assertFundsIntact();
    }

    /// Walk every owner-callable external function after setup and show none of
    /// them reduces deposited[] or the pool's balances. (The pool's proof verifier
    /// rejects everything, so any drain would have to be an owner privilege.)
    function test_owner_cannot_reduce_deposited_via_any_function() public {
        _seedDeposits();
        pool.endSetup();
        address v = address(new TLMockVerifier(true));

        // sweep: nothing unbacked to take
        vm.expectRevert(ShieldPoolCore2.NothingToSweep.selector);
        pool.sweepStrayNative(owner);

        // direct setters are dead
        vm.expectRevert(ChangeTimelock.TimelockRequired.selector);
        pool.setVerifier(v);

        // Queue every timelockable change, including an always-true verifier: in
        // the same block none of them can take effect.
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(ShieldPoolCore2.setVerifier, (v));
        calls[1] = abi.encodeCall(ShieldPoolCore2.setDepositLimit, (address(0), 1, 1));
        calls[2] = abi.encodeCall(ShieldPoolCore2.setWithdrawFee, (100, attacker));
        for (uint256 i = 0; i < calls.length; i++) {
            pool.queueChange(calls[i]);
            vm.expectRevert(ChangeTimelock.ChangeNotReady.selector);
            pool.executeChange(calls[i]);
        }

        // the malicious verifier is not live, so a fake-proof unshield still fails
        bytes32 root = pool.currentRoot();
        vm.expectRevert(ShieldPoolCore2.InvalidProof.selector);
        pool.unshield(hex"00", root, bytes32(uint256(0xDEAD)), address(0), owner, 5 ether);

        // ownership handoff moves no funds
        pool.transferOwnership(attacker);
        vm.prank(attacker);
        pool.acceptOwnership();

        _assertFundsIntact();
    }

    /// Fuzz: any calldata the owner sends (post-setup, same block) leaves every
    /// deposited[] and balance untouched.
    function testFuzz_owner_arbitrary_call_cannot_move_funds(bytes calldata data) public {
        _seedDeposits();
        pool.endSetup();
        (bool ok, ) = address(pool).call(data);
        ok;
        _assertFundsIntact();
    }

    /// Fuzz over the pool's own selectors with fuzzed args (post-setup, same block).
    function testFuzz_owner_known_selectors_cannot_move_funds(
        uint8 which,
        address a,
        address b,
        uint256 amt
    ) public {
        _seedDeposits();
        pool.endSetup();
        bytes4[11] memory sels = [
            ShieldPoolCore2.setVerifier.selector,
            ShieldPoolCore2.setShieldVerifier.selector,
            ShieldPoolCore2.sweepStrayToken.selector,
            ShieldPoolCore2.sweepStrayNative.selector,
            ShieldPoolCore2.transferOwnership.selector,
            ChangeTimelock.endSetup.selector,
            bytes4(keccak256("emergencyWithdraw(address,address,uint256)")),
            ShieldPoolCore2.shield.selector,
            ShieldPoolCore2.acceptOwnership.selector,
            ChangeTimelock.cancelChange.selector,
            ChangeTimelock.executeChange.selector
        ];
        bytes4 sel = sels[which % sels.length];
        bytes memory data;
        if (sel == ChangeTimelock.executeChange.selector || sel == ChangeTimelock.cancelChange.selector) {
            // queue a real change then try to force it early
            bytes memory inner = abi.encodeCall(ShieldPoolCore2.setVerifier, (a));
            pool.queueChange(inner);
            data = abi.encodeWithSelector(sel, inner);
        } else {
            data = abi.encodeWithSelector(sel, a, b, amt);
        }
        (bool ok, ) = address(pool).call(data);
        ok;
        _assertFundsIntact();
        // and the proof verifier never changed in the same block
        assertEq(address(pool.verifier()), address(rejectV));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _seedDeposits() internal {
        vm.prank(user);
        pool.shield{value: 5 ether}(address(0), 5 ether, bytes32(uint256(0xE7E7)));
        token.mint(user, 100 ether);
        vm.startPrank(user);
        token.approve(address(pool), 100 ether);
        pool.shield(address(token), 100 ether, bytes32(uint256(0x70C3)));
        vm.stopPrank();
        _assertFundsIntact();
    }

    function _assertFundsIntact() internal view {
        assertEq(pool.deposited(address(0)), 5 ether, "deposited[native] moved");
        assertEq(pool.deposited(address(token)), 100 ether, "deposited[token] moved");
        assertEq(address(pool).balance, 5 ether, "native balance moved");
        assertEq(token.balanceOf(address(pool)), 100 ether, "token balance moved");
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
