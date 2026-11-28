// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Ported from test/DepositLimits.t.sol to the next vault (not deployed, not audited).
// Keep the two in step until the live vaults are retired.

import {PoolHarness2, STRAY} from "./NextHarness.sol";
import {ShieldPoolPoseidon} from "../../src/ShieldPoolPoseidon.sol";
import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore2} from "../../src/ShieldPoolCore2.sol";
import {ShieldPoolPayments2} from "../../src/ShieldPoolPayments2.sol";
import {ChangeTimelock} from "../../src/lib/ChangeTimelock.sol";
import {IVerifier} from "../../src/interfaces/IVerifier.sol";
import {MockERC20} from "../MockERC20.sol";

contract LimitMockVerifier is IVerifier {
    bool public ok;

    constructor(bool ok_) {
        ok = ok_;
    }

    function verify(bytes calldata, uint256[] calldata) external view returns (bool) {
        return ok;
    }
}

/**
 * Beta deposit limits (ShieldPoolCore2) and the mainnet pool (ShieldPoolPayments2).
 * Limits cap deposits per asset, close an unlisted asset, can be lowered at once
 * and raised only through the timelock, and never block a withdrawal.
 */
contract DepositLimitsTestNext is Test {
    using stdJson for string;

    ShieldPoolPayments2 pool;
    LimitMockVerifier acceptV; // accepts every proof, so withdrawals can be exercised
    MockERC20 usd;
    MockERC20 other;

    address owner = address(this);
    address user = address(0x1234);
    address attacker = address(0xA11CE);

    uint128 constant PER = 1_000e6;
    uint128 constant TOTAL = 2_500e6;

    event DepositLimitsOn();
    event DepositLimitSet(address indexed asset, uint128 perDeposit, uint128 total);

    function setUp() public {
        vm.warp(1_900_000_000);
        acceptV = new LimitMockVerifier(true);
        pool = new ShieldPoolPayments2(_deployPoseidon(), address(acceptV), STRAY);
        // the payments pool takes shieldBound() only; the mock accepts every proof
        pool.setShieldVerifier(address(acceptV));
        usd = new MockERC20();
        other = new MockERC20();
        usd.mint(user, 1_000_000e6);
        other.mint(user, 1_000_000e6);
        vm.startPrank(user);
        usd.approve(address(pool), type(uint256).max);
        other.approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Off by default, on for good
    // ─────────────────────────────────────────────────────────────────────────

    function test_limits_off_by_default_any_deposit_works() public {
        assertFalse(pool.depositLimitsOn());
        _deposit(address(usd), 50_000e6, 1);
        assertEq(pool.deposited(address(usd)), 50_000e6);
    }

    function test_turn_on_emits_and_is_setup_only() public {
        vm.expectEmit(false, false, false, true);
        emit DepositLimitsOn();
        pool.turnOnDepositLimits();
        assertTrue(pool.depositLimitsOn());

        pool.endSetup();
        vm.expectRevert(ChangeTimelock.TimelockRequired.selector);
        pool.turnOnDepositLimits();
    }

    function test_only_owner_turns_on_and_sets() public {
        vm.startPrank(attacker);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        pool.turnOnDepositLimits();
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        pool.setDepositLimit(address(usd), PER, TOTAL);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        pool.lowerDepositLimit(address(usd), 0, 0);
        vm.stopPrank();
    }

    function test_limits_cannot_be_switched_off() public {
        _live();
        // There is no function that clears the flag; the timelock does not take one either.
        vm.expectRevert(ChangeTimelock.UnknownChange.selector);
        pool.queueChange(abi.encodeWithSelector(ShieldPoolCore2.turnOnDepositLimits.selector));
        assertTrue(pool.depositLimitsOn());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Enforcement
    // ─────────────────────────────────────────────────────────────────────────

    function test_unlisted_asset_cannot_be_deposited() public {
        _live();
        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.OverDepositLimit.selector);
        pool.shieldBound(address(other), 1, bytes32(uint256(9)), "");
    }

    function test_per_deposit_limit() public {
        _live();
        _deposit(address(usd), PER, 1); // exactly the limit is fine
        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.OverDepositLimit.selector);
        pool.shieldBound(address(usd), uint256(PER) + 1, bytes32(uint256(2)), "");
    }

    function test_total_limit_and_withdrawal_frees_room() public {
        _live();
        _deposit(address(usd), PER, 1);
        _deposit(address(usd), PER, 2);
        _deposit(address(usd), 500e6, 3); // total now exactly TOTAL
        assertEq(pool.deposited(address(usd)), TOTAL);

        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.OverDepositLimit.selector);
        pool.shieldBound(address(usd), 1, bytes32(uint256(4)), "");

        // A withdrawal is never limited, and it makes room again.
        _withdraw(address(usd), 300e6, 0xAA);
        _deposit(address(usd), 300e6, 5);
        assertEq(pool.deposited(address(usd)), TOTAL);
    }

    function test_rejected_deposit_moves_nothing() public {
        _live();
        uint256 before = usd.balanceOf(user);
        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.OverDepositLimit.selector);
        pool.shieldBound(address(usd), uint256(PER) + 1, bytes32(uint256(7)), "");
        assertEq(usd.balanceOf(user), before);
        assertEq(pool.deposited(address(usd)), 0);
        assertFalse(pool.commitmentSeen(bytes32(uint256(7))));
    }

    function test_native_asset_is_limited_too() public {
        pool.turnOnDepositLimits();
        pool.setDepositLimit(address(0), 1 ether, 2 ether);
        pool.endSetup();
        vm.deal(user, 10 ether);
        vm.prank(user);
        pool.shieldBound{value: 1 ether}(address(0), 1 ether, bytes32(uint256(11)), "");
        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.OverDepositLimit.selector);
        pool.shieldBound{value: 1.5 ether}(address(0), 1.5 ether, bytes32(uint256(12)), "");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lowering is instant, raising is timelocked
    // ─────────────────────────────────────────────────────────────────────────

    function test_lower_is_instant_after_setup() public {
        _live();
        vm.expectEmit(true, false, false, true);
        emit DepositLimitSet(address(usd), 100e6, 1_000e6);
        pool.lowerDepositLimit(address(usd), 100e6, 1_000e6);
        (uint128 per, uint128 total) = pool.depositLimit(address(usd));
        assertEq(per, 100e6);
        assertEq(total, 1_000e6);
        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.OverDepositLimit.selector);
        pool.shieldBound(address(usd), 101e6, bytes32(uint256(1)), "");
    }

    function test_lower_cannot_raise_either_value() public {
        _live();
        vm.expectRevert(ShieldPoolCore2.LimitNotLower.selector);
        pool.lowerDepositLimit(address(usd), PER + 1, TOTAL);
        vm.expectRevert(ShieldPoolCore2.LimitNotLower.selector);
        pool.lowerDepositLimit(address(usd), PER, TOTAL + 1);
        vm.expectRevert(ShieldPoolCore2.LimitNotLower.selector);
        pool.lowerDepositLimit(address(other), 1, 1); // unlisted: (0, 0) cannot go up
    }

    function test_close_deposits_withdrawals_still_work() public {
        _live();
        _deposit(address(usd), PER, 1);
        pool.lowerDepositLimit(address(usd), 0, 0);

        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.OverDepositLimit.selector);
        pool.shieldBound(address(usd), 1, bytes32(uint256(2)), "");

        _withdraw(address(usd), PER, 0xBB);
        assertEq(pool.deposited(address(usd)), 0);
        assertEq(usd.balanceOf(address(0xBEEF)), PER);
    }

    function test_close_deposits_private_transfers_still_work() public {
        _live();
        _deposit(address(usd), PER, 1);
        pool.lowerDepositLimit(address(usd), 0, 0);
        bytes32 root = pool.currentRoot();
        pool.transfer(hex"00", root, bytes32(uint256(0xCC)), [bytes32(uint256(21)), bytes32(uint256(22))]);
        assertTrue(pool.isSpent(bytes32(uint256(0xCC))));
    }

    function test_direct_set_after_setup_needs_timelock() public {
        _live();
        vm.expectRevert(ChangeTimelock.TimelockRequired.selector);
        pool.setDepositLimit(address(usd), PER * 10, TOTAL * 10);
    }

    function test_raise_through_timelock() public {
        _live();
        bytes memory call = abi.encodeCall(ShieldPoolCore2.setDepositLimit, (address(usd), PER * 10, TOTAL * 10));
        pool.queueChange(call);
        vm.expectRevert(ChangeTimelock.ChangeNotReady.selector);
        pool.executeChange(call);

        vm.warp(block.timestamp + 3 days);
        pool.executeChange(call);
        (uint128 per, uint128 total) = pool.depositLimit(address(usd));
        assertEq(per, PER * 10);
        assertEq(total, TOTAL * 10);
        _deposit(address(usd), uint256(PER) * 10, 1);
    }

    function test_list_new_asset_through_timelock() public {
        _live();
        bytes memory call = abi.encodeCall(ShieldPoolCore2.setDepositLimit, (address(other), PER, TOTAL));
        pool.queueChange(call);
        vm.warp(block.timestamp + 3 days);
        pool.executeChange(call);
        _deposit(address(other), PER, 1);
    }

    function test_queued_raise_can_be_cancelled_after_an_emergency_close() public {
        _live();
        bytes memory call = abi.encodeCall(ShieldPoolCore2.setDepositLimit, (address(usd), PER * 10, TOTAL * 10));
        pool.queueChange(call);
        pool.lowerDepositLimit(address(usd), 0, 0);
        pool.cancelChange(call);
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(ChangeTimelock.ChangeNotQueued.selector);
        pool.executeChange(call);
        (uint128 per, ) = pool.depositLimit(address(usd));
        assertEq(per, 0);
    }

    function test_bad_length_limit_change_rejected() public {
        _live();
        bytes memory bad = abi.encodePacked(ShieldPoolCore2.setDepositLimit.selector, uint256(uint160(address(usd))));
        vm.expectRevert(ChangeTimelock.BadChangeLength.selector);
        pool.queueChange(bad);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The owner still cannot move funds
    // ─────────────────────────────────────────────────────────────────────────

    function testFuzz_owner_limit_calls_never_move_funds(address asset, uint128 per, uint128 total) public {
        _live();
        _deposit(address(usd), PER, 1);
        (bool ok, ) = address(pool).call(abi.encodeCall(ShieldPoolCore2.lowerDepositLimit, (asset, per, total)));
        ok;
        (ok, ) = address(pool).call(abi.encodeCall(ShieldPoolCore2.setDepositLimit, (asset, per, total)));
        ok;
        assertEq(pool.deposited(address(usd)), PER);
        assertEq(usd.balanceOf(address(pool)), PER);
    }

    /// Whatever sequence of deposits arrives, deposited[] never passes the total.
    function testFuzz_total_never_exceeded(uint96[6] memory amounts) public {
        _live();
        for (uint256 i = 0; i < amounts.length; i++) {
            uint256 a = uint256(amounts[i]) % (uint256(PER) * 2) + 1;
            vm.prank(user);
            try pool.shieldBound(address(usd), a, bytes32(uint256(100 + i)), "") {} catch {}
            assertLe(pool.deposited(address(usd)), TOTAL, "");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The mainnet pool has no sealed swap
    // ─────────────────────────────────────────────────────────────────────────

    function test_payments_pool_reports_no_swap_verifier() public view {
        assertEq(pool.sealedSwapVerifier(), address(0));
    }

    function test_payments_pool_has_no_sealedSwap() public {
        (bool ok, ) = address(pool).call(
            abi.encodeWithSelector(
                ShieldPoolPoseidon.sealedSwap.selector,
                hex"00",
                bytes32(0),
                bytes32(0),
                bytes32(0),
                bytes32(0),
                address(1),
                address(2),
                uint256(0),
                uint256(1),
                uint256(1)
            )
        );
        assertFalse(ok);
    }

    function test_payments_pool_timelock_rejects_swap_setters() public {
        pool.turnOnDepositLimits();
        pool.endSetup();
        vm.expectRevert(ChangeTimelock.UnknownChange.selector);
        pool.queueChange(abi.encodeCall(ShieldPoolPoseidon.setSealedSwapVerifier, (address(acceptV))));
        vm.expectRevert(ChangeTimelock.UnknownChange.selector);
        pool.queueChange(abi.encodeCall(ShieldPoolPoseidon.setSwapRate, (address(usd), address(other), 1, 1, true)));
    }

    function test_payments_pool_keeps_core_timelock_setters() public {
        pool.turnOnDepositLimits();
        pool.endSetup();
        address next = address(new LimitMockVerifier(true));
        bytes memory call = abi.encodeCall(ShieldPoolCore2.setVerifier, (next));
        pool.queueChange(call);
        vm.warp(block.timestamp + 3 days);
        pool.executeChange(call);
        assertEq(address(pool.verifier()), next);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pre-mainnet audit F1: no unbound deposit, no going live half-wired
    // ─────────────────────────────────────────────────────────────────────────

    function test_payments_pool_never_takes_plain_shield() public {
        ShieldPoolPayments2 fresh = new ShieldPoolPayments2(_deployPoseidon(), address(acceptV), STRAY);
        vm.prank(user);
        usd.approve(address(fresh), type(uint256).max);
        // born with no shield verifier: still no unbound deposit
        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.ShieldProofRequired.selector);
        fresh.shield(address(usd), 1e6, bytes32(uint256(1)));
        // and none after it is wired either
        fresh.setShieldVerifier(address(acceptV));
        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.ShieldProofRequired.selector);
        fresh.shield(address(usd), 1e6, bytes32(uint256(1)));
        assertEq(fresh.deposited(address(usd)), 0);
    }

    function test_setup_cannot_end_until_the_pool_is_wired() public {
        ShieldPoolPayments2 fresh = new ShieldPoolPayments2(_deployPoseidon(), address(acceptV), STRAY);
        vm.expectRevert(ShieldPoolCore2.VerifierNotSet.selector);
        fresh.endSetup();
        fresh.setShieldVerifier(address(acceptV));
        vm.expectRevert(ShieldPoolCore2.DepositLimitsOff.selector);
        fresh.endSetup();
        fresh.turnOnDepositLimits();
        fresh.endSetup();
        assertFalse(fresh.setupMode());
    }

    function test_setup_cannot_end_without_the_spend_verifier() public {
        ShieldPoolPayments2 fresh = new ShieldPoolPayments2(_deployPoseidon(), address(0), STRAY);
        fresh.setShieldVerifier(address(acceptV));
        fresh.turnOnDepositLimits();
        vm.expectRevert(ShieldPoolCore2.VerifierNotSet.selector);
        fresh.endSetup();
    }

    function test_swap_pool_gets_limits_too() public {
        PoolHarness2 swapPool = new PoolHarness2(_deployPoseidon(), address(acceptV));
        swapPool.turnOnDepositLimits();
        swapPool.setDepositLimit(address(usd), PER, TOTAL);
        swapPool.endSetup();
        vm.prank(user);
        usd.approve(address(swapPool), type(uint256).max);
        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.OverDepositLimit.selector);
        swapPool.shield(address(usd), uint256(PER) + 1, bytes32(uint256(1)));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// Limits on, USD listed at PER / TOTAL, setup ended: the mainnet shape.
    function _live() internal {
        pool.turnOnDepositLimits();
        pool.setDepositLimit(address(usd), PER, TOTAL);
        pool.endSetup();
    }

    function _deposit(address asset, uint256 amount, uint256 salt) internal {
        vm.prank(user);
        pool.shieldBound(asset, amount, bytes32(uint256(keccak256(abi.encode(asset, amount, salt)))), "");
    }

    function _withdraw(address asset, uint256 amount, uint256 nullifier) internal {
        bytes32 root = pool.currentRoot();
        pool.unshield(hex"00", root, bytes32(nullifier), asset, address(0xBEEF), amount);
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
