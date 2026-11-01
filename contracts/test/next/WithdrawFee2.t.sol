// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Ported from test/WithdrawFee.t.sol to the next vault (not deployed, not audited).
// Keep the two in step until the live vaults are retired.

import {PoolHarness2, STRAY} from "./NextHarness.sol";
import {Test, Vm} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore2} from "../../src/ShieldPoolCore2.sol";
import {ShieldPoolPayments2} from "../../src/ShieldPoolPayments2.sol";
import {ChangeTimelock} from "../../src/lib/ChangeTimelock.sol";
import {IVerifier} from "../../src/interfaces/IVerifier.sol";
import {UnshieldVerifier} from "../../src/verifiers/UnshieldVerifier.sol";
import {UnshieldIVerifier} from "../../src/verifiers/UnshieldIVerifier.sol";
import {TransferVerifier} from "../../src/verifiers/TransferVerifier.sol";
import {TransferIVerifier} from "../../src/verifiers/TransferIVerifier.sol";
import {DualProofVerifier2} from "../../src/verifiers/DualProofVerifier2.sol";
import {MockERC20} from "../MockERC20.sol";

contract FeeMockVerifier is IVerifier {
    function verify(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return true;
    }
}

/// Exposes the pool's internal fee math so it can be fuzzed over all of uint256.
contract FeeHarness is ShieldPoolPayments2 {
    constructor(address poseidon2_, address verifier_) ShieldPoolPayments2(poseidon2_, verifier_, STRAY) {}

    function feeOf(uint256 amount) external view returns (uint256) {
        return _withdrawFee(amount);
    }
}

/// A stablecoin whose issuer can freeze addresses (Tempo TIP-20 style): any
/// transfer to or from a frozen address reverts.
contract FreezableERC20 {
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public frozen;

    error Frozen();

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setFrozen(address who, bool f) external {
        frozen[who] = f;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        if (frozen[from] || frozen[to]) revert Frozen();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// A fee recipient that refuses native currency.
contract RejectingRecipient {
    receive() external payable {
        revert("no");
    }
}

/// Re-enters the pool from receive(): collectFees again, and an unshield.
contract ReentrantReceiver {
    ShieldPoolCore2 public pool;
    uint256 public hits;
    bytes4 public collectErr;
    bytes4 public unshieldErr;

    constructor(ShieldPoolCore2 pool_) {
        pool = pool_;
    }

    receive() external payable {
        hits++;
        try pool.collectFees(address(0)) {
            collectErr = bytes4(0xffffffff); // re-entry succeeded: the test fails on this
        } catch (bytes memory e) {
            collectErr = bytes4(e);
        }
        bytes32 root = pool.currentRoot();
        try pool.unshield(hex"00", root, bytes32(uint256(0xBAD0 + hits)), address(0), address(this), 1) {
            unshieldErr = bytes4(0xffffffff);
        } catch (bytes memory e) {
            unshieldErr = bytes4(e);
        }
    }
}

/**
 * Mainnet cash-out fee (ShieldPoolCore2). Deposits and private transfers are
 * free; unshield keeps withdrawFeeBps of the proven amount in the pool as
 * feesOwed, and collectFees sends it to feeRecipient. Off by default, capped
 * at 1%, timelocked after setup, lowerable at once, and a recipient that cannot
 * receive never blocks a withdrawal.
 */
contract WithdrawFeeTestNext is Test {
    using stdJson for string;

    ShieldPoolPayments2 pool;
    FeeMockVerifier acceptV; // accepts every proof, so withdrawals can be exercised
    MockERC20 usd;
    address poseidon2;

    address owner = address(this);
    address user = address(0x1234);
    address attacker = address(0xA11CE);
    address to = address(0xBEEF);
    address recipient = address(0xFEE);

    uint256 constant AMT = 1_000e6;

    event Unshielded(bytes32 indexed nullifier, address indexed asset, address indexed to, uint256 amount);
    event WithdrawFeeSet(uint16 bps, address indexed recipient);
    event WithdrawFee(bytes32 indexed nullifier, address indexed asset, uint256 fee);
    event FeesCollected(address indexed asset, address indexed recipient, uint256 amount);

    function setUp() public {
        vm.warp(1_900_000_000);
        poseidon2 = _deployPoseidon();
        acceptV = new FeeMockVerifier();
        pool = new ShieldPoolPayments2(poseidon2, address(acceptV), STRAY);
        // the payments pool takes shieldBound() only (audit F1); the mock accepts every proof
        pool.setShieldVerifier(address(acceptV));
        usd = new MockERC20();
        usd.mint(user, 1_000_000e6);
        vm.prank(user);
        usd.approve(address(pool), type(uint256).max);
        vm.deal(user, 1_000 ether);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Off by default
    // ─────────────────────────────────────────────────────────────────────────

    function test_fee_off_by_default_user_gets_full_amount() public {
        assertEq(pool.withdrawFeeBps(), 0);
        assertEq(pool.feeRecipient(), address(0));
        assertEq(pool.MAX_WITHDRAW_FEE_BPS(), 100);

        _deposit(address(usd), AMT, 1);
        vm.recordLogs();
        _withdraw(address(usd), AMT, 0xA1);
        _assertNoFeeEvent();

        assertEq(usd.balanceOf(to), AMT);
        assertEq(pool.feesOwed(address(usd)), 0);
        assertEq(pool.deposited(address(usd)), 0);
        assertEq(usd.balanceOf(address(pool)), 0);
        vm.expectRevert(ShieldPoolCore2.ZeroAddress.selector);
        pool.collectFees(address(usd));
    }

    function test_fee_off_native_user_gets_full_amount() public {
        _deposit(address(0), 2 ether, 1);
        _withdraw(address(0), 2 ether, 0xA2);
        assertEq(to.balance, 2 ether);
        assertEq(pool.feesOwed(address(0)), 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 25 bps: user gets amount - fee, the fee waits in the pool, anyone collects
    // ─────────────────────────────────────────────────────────────────────────

    function test_fee_25bps_erc20_then_collect() public {
        _live(25);
        _deposit(address(usd), AMT, 1);

        uint256 fee = (AMT * 25) / 10_000; // 2.5 USD
        assertEq(fee, 2_500_000);
        bytes32 nul = bytes32(uint256(0xB1));
        bytes32 root = pool.currentRoot();
        vm.expectEmit(true, true, true, true, address(pool));
        emit Unshielded(nul, address(usd), to, AMT);
        vm.expectEmit(true, true, false, true, address(pool));
        emit WithdrawFee(nul, address(usd), fee);
        pool.unshield(hex"00", root, nul, address(usd), to, AMT);

        assertEq(usd.balanceOf(to), AMT - fee);
        assertEq(pool.deposited(address(usd)), 0);
        assertEq(pool.feesOwed(address(usd)), fee);
        assertEq(usd.balanceOf(address(pool)), fee);

        // Anyone may collect; it always goes to feeRecipient.
        vm.expectEmit(true, true, false, true, address(pool));
        emit FeesCollected(address(usd), recipient, fee);
        vm.prank(attacker);
        pool.collectFees(address(usd));
        assertEq(usd.balanceOf(recipient), fee);
        assertEq(usd.balanceOf(attacker), 0);
        assertEq(pool.feesOwed(address(usd)), 0);
        assertEq(usd.balanceOf(address(pool)), 0);

        vm.expectRevert(ShieldPoolCore2.NothingToCollect.selector);
        pool.collectFees(address(usd));
    }

    function test_fee_25bps_native_then_collect() public {
        _live(25);
        _deposit(address(0), 10 ether, 1);
        _withdraw(address(0), 10 ether, 0xB2);

        uint256 fee = 0.025 ether;
        assertEq(to.balance, 10 ether - fee);
        assertEq(pool.feesOwed(address(0)), fee);
        assertEq(address(pool).balance, fee);

        pool.collectFees(address(0));
        assertEq(recipient.balance, fee);
        assertEq(address(pool).balance, 0);
        assertEq(pool.feesOwed(address(0)), 0);
    }

    function test_fees_accumulate_across_cash_outs_and_assets() public {
        _live(25);
        _deposit(address(usd), AMT, 1);
        _deposit(address(usd), AMT, 2);
        _deposit(address(0), 4 ether, 3);
        _withdraw(address(usd), 400e6, 0xC1);
        _withdraw(address(usd), 1_600e6, 0xC2);
        _withdraw(address(0), 4 ether, 0xC3);

        assertEq(pool.feesOwed(address(usd)), 1_000_000 + 4_000_000);
        assertEq(pool.feesOwed(address(0)), 0.01 ether);
        assertEq(usd.balanceOf(to), 2_000e6 - 5_000_000);

        pool.collectFees(address(usd));
        assertEq(pool.feesOwed(address(0)), 0.01 ether, "collecting one asset leaves the other");
        pool.collectFees(address(0));
        assertEq(usd.balanceOf(recipient), 5_000_000);
        assertEq(recipient.balance, 0.01 ether);
    }

    /// Fees are not spendable by notes: deposited[] alone backs unshield.
    function test_owed_fees_cannot_be_unshielded() public {
        _live(25);
        _deposit(address(usd), AMT, 1);
        _withdraw(address(usd), AMT, 0xD1);
        uint256 fee = pool.feesOwed(address(usd));
        assertGt(fee, 0);
        bytes32 root = pool.currentRoot();
        vm.expectRevert(ShieldPoolCore2.InsufficientPoolBalance.selector);
        pool.unshield(hex"00", root, bytes32(uint256(0xD2)), address(usd), attacker, fee);
        assertEq(usd.balanceOf(address(pool)), fee);
    }

    /// Deposits and private transfers carry no fee.
    function test_deposit_and_private_transfer_are_free() public {
        _live(100);
        _deposit(address(usd), AMT, 1);
        assertEq(pool.deposited(address(usd)), AMT);
        assertEq(usd.balanceOf(address(pool)), AMT);
        bytes32 root = pool.currentRoot();
        pool.transfer(hex"00", root, bytes32(uint256(0xE1)), [bytes32(uint256(31)), bytes32(uint256(32))]);
        assertEq(pool.deposited(address(usd)), AMT);
        assertEq(pool.feesOwed(address(usd)), 0);
    }

    /// A cash-out frees the full proven amount under the deposit limits.
    function test_cash_out_frees_full_amount_of_deposit_room() public {
        pool.turnOnDepositLimits();
        pool.setDepositLimit(address(usd), uint128(AMT), uint128(AMT));
        _live(25);
        _deposit(address(usd), AMT, 1);
        _withdraw(address(usd), AMT, 0xE2);
        _deposit(address(usd), AMT, 2); // room is back to the full total
        assertEq(pool.deposited(address(usd)), AMT);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Rounding and math
    // ─────────────────────────────────────────────────────────────────────────

    function test_rounding_small_amount_pays_no_fee() public {
        _live(25);
        _deposit(address(usd), 1_000, 1);

        vm.recordLogs();
        _withdraw(address(usd), 399, 0xF1); // 399 * 25 / 10_000 = 0.9975 -> 0
        _assertNoFeeEvent();
        assertEq(usd.balanceOf(to), 399);
        assertEq(pool.feesOwed(address(usd)), 0);

        _withdraw(address(usd), 1, 0xF2);
        assertEq(usd.balanceOf(to), 400);

        _withdraw(address(usd), 400, 0xF3); // exactly 1 unit
        assertEq(pool.feesOwed(address(usd)), 1);
        assertEq(usd.balanceOf(to), 400 + 399);

        _withdraw(address(usd), 200, 0xF4); // 0.5 -> 0, rounded down for the user
        assertEq(pool.feesOwed(address(usd)), 1);
        assertEq(usd.balanceOf(to), 400 + 399 + 200);
    }

    function testFuzz_fee_is_floor_and_never_overflows(uint256 amount, uint16 bps) public {
        bps = uint16(bound(bps, 0, 100));
        FeeHarness h = new FeeHarness(poseidon2, address(acceptV));
        h.setWithdrawFee(bps, recipient);
        uint256 fee = h.feeOf(amount);
        if (amount <= type(uint256).max / 100) {
            assertEq(fee, (amount * bps) / 10_000, "floor(amount * bps / 10_000)");
        }
        assertLe(fee, amount / 100, "never above 1%");
        if (amount > 0) assertLt(fee, amount, "user always gets something");
    }

    function test_fee_math_at_uint256_max() public {
        FeeHarness h = new FeeHarness(poseidon2, address(acceptV));
        h.setWithdrawFee(100, recipient);
        uint256 m = type(uint256).max;
        // floor(m / 100), computed without overflow
        assertEq(h.feeOf(m), m / 100);
        h.setWithdrawFee(0, address(0));
        assertEq(h.feeOf(m), 0);
    }

    function testFuzz_unshield_conserves_value(uint96 rawAmount, uint16 bps) public {
        bps = uint16(bound(bps, 0, 100));
        uint256 amount = bound(uint256(rawAmount), 1, 1_000_000e6);
        _live(bps);
        _deposit(address(usd), amount, 1);
        _withdraw(address(usd), amount, 0x1F);
        uint256 fee = (amount * bps) / 10_000;
        assertEq(usd.balanceOf(to), amount - fee);
        assertEq(pool.feesOwed(address(usd)), fee);
        assertEq(usd.balanceOf(address(pool)), fee);
        assertEq(usd.balanceOf(to) + usd.balanceOf(address(pool)), amount);
        _assertInvariant(address(usd));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cap and validation
    // ─────────────────────────────────────────────────────────────────────────

    function test_cap_enforced() public {
        vm.expectRevert(ShieldPoolCore2.FeeTooHigh.selector);
        pool.setWithdrawFee(101, recipient);
        vm.expectRevert(ShieldPoolCore2.FeeTooHigh.selector);
        pool.setWithdrawFee(type(uint16).max, recipient);

        pool.setWithdrawFee(100, recipient); // exactly 1% is allowed
        assertEq(pool.withdrawFeeBps(), 100);
    }

    function test_cap_enforced_through_timelock_too() public {
        _ready();
        pool.endSetup();
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setWithdrawFee, (uint16(101), recipient));
        (, uint256 eta) = pool.queueChange(call_);
        vm.warp(eta);
        vm.expectRevert(ShieldPoolCore2.FeeTooHigh.selector);
        pool.executeChange(call_);
        assertEq(pool.withdrawFeeBps(), 0);
    }

    function test_timelock_rejects_dirty_uint16() public {
        _ready();
        pool.endSetup();
        // bps word with bits above uint16: abi.decode rejects it at execution.
        bytes memory call_ = abi.encodePacked(
            ShieldPoolCore2.setWithdrawFee.selector,
            uint256(65_536 + 25),
            uint256(uint160(recipient))
        );
        (, uint256 eta) = pool.queueChange(call_);
        vm.warp(eta);
        vm.expectRevert();
        pool.executeChange(call_);
        assertEq(pool.withdrawFeeBps(), 0);
        assertEq(pool.feeRecipient(), address(0));
    }

    function test_nonzero_fee_needs_a_recipient() public {
        vm.expectRevert(ShieldPoolCore2.ZeroAddress.selector);
        pool.setWithdrawFee(25, address(0));
        pool.setWithdrawFee(0, address(0)); // off is fine
        assertEq(pool.withdrawFeeBps(), 0);
    }

    function test_set_emits_and_is_owner_only() public {
        vm.expectEmit(true, false, false, true, address(pool));
        emit WithdrawFeeSet(25, recipient);
        pool.setWithdrawFee(25, recipient);
        assertEq(pool.withdrawFeeBps(), 25);
        assertEq(pool.feeRecipient(), recipient);

        vm.startPrank(attacker);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        pool.setWithdrawFee(100, attacker);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        pool.lowerWithdrawFee(0);
        vm.stopPrank();
        assertEq(pool.withdrawFeeBps(), 25);
        assertEq(pool.feeRecipient(), recipient);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Setup vs after setup
    // ─────────────────────────────────────────────────────────────────────────

    function test_direct_set_after_setup_reverts() public {
        _live(25);
        vm.expectRevert(ChangeTimelock.TimelockRequired.selector);
        pool.setWithdrawFee(50, recipient);
        vm.expectRevert(ChangeTimelock.TimelockRequired.selector);
        pool.setWithdrawFee(25, attacker); // nor can the recipient move instantly
        assertEq(pool.withdrawFeeBps(), 25);
        assertEq(pool.feeRecipient(), recipient);
    }

    function test_raise_only_after_three_days() public {
        _ready();
        pool.endSetup(); // fee off, the testnet shape
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setWithdrawFee, (uint16(25), recipient));
        (, uint256 eta) = pool.queueChange(call_);
        assertEq(eta, block.timestamp + 3 days);

        vm.expectRevert(ChangeTimelock.ChangeNotReady.selector);
        pool.executeChange(call_);
        vm.warp(eta - 1);
        vm.expectRevert(ChangeTimelock.ChangeNotReady.selector);
        pool.executeChange(call_);

        // While pending, cash-outs are still free.
        _deposit(address(usd), AMT, 1);
        _withdraw(address(usd), AMT / 2, 0x31);
        assertEq(usd.balanceOf(to), AMT / 2);

        vm.warp(eta);
        vm.expectEmit(true, false, false, true, address(pool));
        emit WithdrawFeeSet(25, recipient);
        pool.executeChange(call_);
        assertEq(pool.withdrawFeeBps(), 25);

        _withdraw(address(usd), AMT / 2, 0x32);
        assertEq(usd.balanceOf(to), AMT / 2 + (AMT / 2 - 1_250_000));
        assertEq(pool.feesOwed(address(usd)), 1_250_000);
    }

    function test_recipient_change_through_timelock() public {
        _live(25);
        address newRecipient = address(0xFEE2);
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setWithdrawFee, (uint16(25), newRecipient));
        (, uint256 eta) = pool.queueChange(call_);
        vm.warp(eta);
        pool.executeChange(call_);
        assertEq(pool.feeRecipient(), newRecipient);
    }

    function test_bad_length_fee_change_rejected() public {
        _ready();
        pool.endSetup();
        bytes memory bad = abi.encodePacked(ShieldPoolCore2.setWithdrawFee.selector, uint256(25));
        vm.expectRevert(ChangeTimelock.BadChangeLength.selector);
        pool.queueChange(bad);
    }

    function test_lower_is_instant_after_setup() public {
        _live(100);
        _deposit(address(usd), AMT, 1);
        _withdraw(address(usd), AMT / 2, 0x41); // 1% of 500
        assertEq(pool.feesOwed(address(usd)), 5_000_000);

        vm.expectEmit(true, false, false, true, address(pool));
        emit WithdrawFeeSet(25, recipient);
        pool.lowerWithdrawFee(25);
        assertEq(pool.withdrawFeeBps(), 25);
        assertEq(pool.feeRecipient(), recipient, "recipient unchanged");

        pool.lowerWithdrawFee(0); // off
        assertEq(pool.withdrawFeeBps(), 0);
        _withdraw(address(usd), AMT / 2, 0x42);
        assertEq(usd.balanceOf(to), (AMT / 2 - 5_000_000) + AMT / 2, "no fee once off");

        // Fees owed from before stay collectable by the same recipient.
        pool.collectFees(address(usd));
        assertEq(usd.balanceOf(recipient), 5_000_000);
    }

    function test_lower_cannot_raise() public {
        _live(25);
        vm.expectRevert(ShieldPoolCore2.FeeNotLower.selector);
        pool.lowerWithdrawFee(26);
        pool.lowerWithdrawFee(0);
        vm.expectRevert(ShieldPoolCore2.FeeNotLower.selector);
        pool.lowerWithdrawFee(1);
        assertEq(pool.withdrawFeeBps(), 0);
    }

    function test_queued_raise_can_be_cancelled_after_an_instant_lower() public {
        _live(25);
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setWithdrawFee, (uint16(100), recipient));
        pool.queueChange(call_);
        pool.lowerWithdrawFee(0);
        pool.cancelChange(call_);
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(ChangeTimelock.ChangeNotQueued.selector);
        pool.executeChange(call_);
        assertEq(pool.withdrawFeeBps(), 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // A recipient that cannot receive never blocks a withdrawal
    // ─────────────────────────────────────────────────────────────────────────

    function test_frozen_recipient_does_not_block_unshield() public {
        FreezableERC20 stable = new FreezableERC20();
        stable.mint(user, 10_000e6);
        vm.prank(user);
        stable.approve(address(pool), type(uint256).max);
        _ready();
        pool.setDepositLimit(address(stable), type(uint128).max, type(uint128).max);
        _live(25);
        stable.setFrozen(recipient, true); // the issuer freezes the fee recipient

        _deposit(address(stable), AMT, 1);
        _withdraw(address(stable), AMT, 0x51);
        assertEq(stable.balanceOf(to), AMT - 2_500_000, "user paid out despite frozen recipient");
        assertEq(pool.feesOwed(address(stable)), 2_500_000);

        // Collecting fails and leaves the fees owed in the pool.
        vm.expectRevert(ShieldPoolCore2.TransferFailed.selector);
        pool.collectFees(address(stable));
        assertEq(pool.feesOwed(address(stable)), 2_500_000);
        assertEq(stable.balanceOf(address(pool)), 2_500_000);

        // More cash-outs keep working.
        _deposit(address(stable), AMT, 2);
        _withdraw(address(stable), AMT, 0x52);
        assertEq(pool.feesOwed(address(stable)), 5_000_000);

        // Rotate the recipient through the timelock, then collect.
        address fresh = address(0xFEE3);
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setWithdrawFee, (uint16(25), fresh));
        (, uint256 eta) = pool.queueChange(call_);
        vm.warp(eta);
        pool.executeChange(call_);
        pool.collectFees(address(stable));
        assertEq(stable.balanceOf(fresh), 5_000_000);
        assertEq(stable.balanceOf(address(pool)), 0);
    }

    function test_reverting_native_recipient_does_not_block_unshield() public {
        RejectingRecipient bad = new RejectingRecipient();
        pool.setWithdrawFee(25, address(bad));
        _ready();
        pool.endSetup();
        _deposit(address(0), 4 ether, 1);
        _withdraw(address(0), 4 ether, 0x53);
        assertEq(to.balance, 4 ether - 0.01 ether);
        assertEq(pool.feesOwed(address(0)), 0.01 ether);

        vm.expectRevert(ShieldPoolCore2.TransferFailed.selector);
        pool.collectFees(address(0));
        assertEq(pool.feesOwed(address(0)), 0.01 ether);
        assertEq(address(pool).balance, 0.01 ether);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // sweepStrayNative cannot take owed native fees
    // ─────────────────────────────────────────────────────────────────────────

    function test_sweep_cannot_take_native_fees() public {
        _live(25);
        _deposit(address(0), 10 ether, 1);
        _withdraw(address(0), 10 ether, 0x61);
        uint256 fee = 0.025 ether;
        assertEq(address(pool).balance, fee);
        assertEq(pool.deposited(address(0)), 0);

        // Only owed fees are left: nothing is stray.
        vm.expectRevert(ShieldPoolCore2.NothingToSweep.selector);
        pool.sweepStrayNative(owner);

        // ETH sent straight to the pool is stray; sweep takes exactly that.
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        (bool ok, ) = address(pool).call{value: 1 ether}("");
        assertTrue(ok);
        address sink = address(0x5111);
        pool.sweepStrayNative(sink);
        assertEq(sink.balance, 1 ether);
        assertEq(address(pool).balance, fee);
        assertEq(pool.feesOwed(address(0)), fee);

        pool.collectFees(address(0));
        assertEq(recipient.balance, fee);
    }

    function test_sweep_protects_notes_and_fees_together() public {
        _live(25);
        _deposit(address(0), 10 ether, 1);
        _deposit(address(0), 3 ether, 2);
        _withdraw(address(0), 10 ether, 0x62); // 3 ether still backs a note, 0.025 owed
        vm.expectRevert(ShieldPoolCore2.NothingToSweep.selector);
        pool.sweepStrayNative(owner);
        assertEq(address(pool).balance, 3 ether + 0.025 ether);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Reentrancy
    // ─────────────────────────────────────────────────────────────────────────

    function test_collectFees_reentrancy_blocked() public {
        ReentrantReceiver r = new ReentrantReceiver(pool);
        pool.setWithdrawFee(25, address(r));
        _ready();
        pool.endSetup();
        _deposit(address(0), 10 ether, 1);
        _deposit(address(0), 5 ether, 2); // a live note the re-entrant unshield would try to spend
        _withdraw(address(0), 10 ether, 0x71);
        uint256 fee = 0.025 ether;

        pool.collectFees(address(0));
        assertEq(r.hits(), 1);
        assertEq(r.collectErr(), ShieldPoolCore2.Reentrancy.selector, "collect re-entry blocked");
        assertEq(r.unshieldErr(), ShieldPoolCore2.Reentrancy.selector, "unshield re-entry blocked");
        assertEq(address(r).balance, fee, "paid exactly once");
        assertEq(pool.feesOwed(address(0)), 0);
        assertEq(pool.deposited(address(0)), 5 ether);
        assertEq(address(pool).balance, 5 ether);
    }

    /// A cash-out recipient that re-enters collectFees during unshield is blocked,
    /// and the fee it tried to grab stays owed.
    function test_unshield_receiver_cannot_reenter_collect() public {
        ReentrantReceiver r = new ReentrantReceiver(pool);
        _live(25);
        _deposit(address(0), 10 ether, 1);
        bytes32 root = pool.currentRoot();
        pool.unshield(hex"00", root, bytes32(uint256(0x72)), address(0), address(r), 10 ether);
        assertEq(r.collectErr(), ShieldPoolCore2.Reentrancy.selector);
        assertEq(r.unshieldErr(), ShieldPoolCore2.Reentrancy.selector);
        assertEq(address(r).balance, 10 ether - 0.025 ether);
        assertEq(pool.feesOwed(address(0)), 0.025 ether);
        assertEq(recipient.balance, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The owner still cannot move note-backing funds
    // ─────────────────────────────────────────────────────────────────────────

    function testFuzz_owner_fee_calls_never_move_note_funds(uint16 bps, address r, address asset) public {
        _live(25);
        _deposit(address(usd), AMT, 1);
        _deposit(address(0), 1 ether, 2);
        (bool ok, ) = address(pool).call(abi.encodeCall(ShieldPoolCore2.setWithdrawFee, (bps, r)));
        ok;
        (ok, ) = address(pool).call(abi.encodeCall(ShieldPoolCore2.lowerWithdrawFee, (bps)));
        ok;
        (ok, ) = address(pool).call(abi.encodeCall(ShieldPoolCore2.collectFees, (asset)));
        ok;
        (ok, ) = address(pool).call(abi.encodeCall(ShieldPoolCore2.sweepStrayNative, (r)));
        ok;
        assertEq(pool.deposited(address(usd)), AMT);
        assertEq(usd.balanceOf(address(pool)), AMT);
        assertEq(pool.deposited(address(0)), 1 ether);
        assertEq(address(pool).balance, 1 ether);
    }

    function test_invariant_holds_through_a_mixed_sequence() public {
        _live(25);
        _deposit(address(usd), AMT, 1);
        _deposit(address(0), 3 ether, 2);
        _assertInvariant(address(usd));
        _assertInvariant(address(0));
        _withdraw(address(usd), 333_333_333, 0x81);
        _withdraw(address(0), 1 ether, 0x82);
        _assertInvariant(address(usd));
        _assertInvariant(address(0));
        pool.collectFees(address(usd));
        _assertInvariant(address(usd));
        pool.lowerWithdrawFee(10);
        _withdraw(address(0), 2 ether, 0x83);
        _assertInvariant(address(0));
        pool.collectFees(address(0));
        _assertInvariant(address(0));
        assertEq(address(pool).balance, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Both pool types get the fee; a real proof still binds the full amount
    // ─────────────────────────────────────────────────────────────────────────

    function test_swap_pool_gets_the_fee_too() public {
        PoolHarness2 swapPool = new PoolHarness2(poseidon2, address(acceptV));
        swapPool.setWithdrawFee(25, recipient);
        swapPool.endSetup();
        vm.prank(user);
        swapPool.shield{value: 4 ether}(address(0), 4 ether, bytes32(uint256(0x91)));
        bytes32 root = swapPool.currentRoot();
        swapPool.unshield(hex"00", root, bytes32(uint256(0x92)), address(0), to, 4 ether);
        assertEq(to.balance, 4 ether - 0.01 ether);
        assertEq(swapPool.feesOwed(address(0)), 0.01 ether);

        // and its timelock accepts the fee setter
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setWithdrawFee, (uint16(50), recipient));
        (, uint256 eta) = swapPool.queueChange(call_);
        vm.warp(eta);
        swapPool.executeChange(call_);
        assertEq(swapPool.withdrawFeeBps(), 50);
    }

    /// The repo's real Groth16 unshield fixture (see KenshoOct11.t.sol) against
    /// the mainnet pool with the fee on: verifier inputs are unchanged, the proof
    /// still binds the full amount, and `to` receives amount - fee.
    function test_real_proof_unshield_with_fee() public {
        uint256 ROOT = 13234193652734635164697424209615330599412255191967788575267034634808796923137;
        uint256 NULLIFIER = 1945704986784996205275124157419427994886512646982192210318468338970744312245;
        uint256 AMOUNT = 1000000000000000;
        address TO = address(uint160(1288467190840644149448244075784839353812473341992));
        uint256 KNOWN_ROOTS_SLOT = 46; // tree at slot 4, same layout as the swap pool

        UnshieldIVerifier u = new UnshieldIVerifier(new UnshieldVerifier());
        TransferIVerifier t = new TransferIVerifier(new TransferVerifier());
        ShieldPoolPayments2 real = new ShieldPoolPayments2(poseidon2, address(new DualProofVerifier2(u, t)), STRAY);
        real.setWithdrawFee(25, recipient);
        real.setShieldVerifier(address(acceptV));
        real.turnOnDepositLimits();
        real.setDepositLimit(address(0), type(uint128).max, type(uint128).max);
        real.endSetup();
        vm.deal(address(this), 1 ether);
        real.shieldBound{value: AMOUNT}(address(0), AMOUNT, bytes32(uint256(777)), "");
        vm.store(address(real), keccak256(abi.encode(ROOT, KNOWN_ROOTS_SLOT)), bytes32(uint256(1)));
        assertTrue(real.isKnownRoot(bytes32(ROOT)));

        // The proof does not verify for a different (e.g. net-of-fee) amount.
        uint256 fee = (AMOUNT * 25) / 10_000;
        vm.expectRevert(ShieldPoolCore2.InvalidProof.selector);
        real.unshield(_realProof(), bytes32(ROOT), bytes32(NULLIFIER), address(0), TO, AMOUNT - fee);

        uint256 before = TO.balance;
        real.unshield(_realProof(), bytes32(ROOT), bytes32(NULLIFIER), address(0), TO, AMOUNT);
        assertEq(TO.balance - before, AMOUNT - fee);
        assertEq(real.feesOwed(address(0)), fee);
        assertEq(real.deposited(address(0)), 0);
        assertEq(address(real).balance, fee);
        real.collectFees(address(0));
        assertEq(recipient.balance, fee);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// Fee set in setup, then setup ended: the mainnet shape.
    function _live(uint16 bps) internal {
        pool.setWithdrawFee(bps, bps == 0 ? address(0) : recipient);
        _ready();
        pool.endSetup();
    }

    function _deposit(address asset, uint256 amount, uint256 salt) internal {
        bytes32 c = bytes32(uint256(keccak256(abi.encode(asset, amount, salt))));
        vm.prank(user);
        if (asset == address(0)) {
            pool.shieldBound{value: amount}(asset, amount, c, "");
        } else {
            pool.shieldBound(asset, amount, c, "");
        }
    }

    /// Deposit limits on before setup ends (the payments pool requires it), with
    /// room for every test's deposits unless a test already set its own.
    function _ready() internal {
        if (pool.depositLimitsOn()) return;
        pool.turnOnDepositLimits();
        pool.setDepositLimit(address(usd), type(uint128).max, type(uint128).max);
        pool.setDepositLimit(address(0), type(uint128).max, type(uint128).max);
    }

    function _withdraw(address asset, uint256 amount, uint256 nullifier) internal {
        bytes32 root = pool.currentRoot();
        pool.unshield(hex"00", root, bytes32(nullifier), asset, to, amount);
    }

    function _assertInvariant(address asset) internal view {
        uint256 bal = asset == address(0) ? address(pool).balance : MockERC20(asset).balanceOf(address(pool));
        assertGe(bal, pool.deposited(asset) + pool.feesOwed(asset), "balance >= deposited + feesOwed");
    }

    function _assertNoFeeEvent() internal view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("WithdrawFee(bytes32,address,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics.length == 0 || logs[i].topics[0] != topic, "no WithdrawFee event");
        }
    }

    function _realProof() internal pure returns (bytes memory) {
        uint256[2] memory a = [
            6957634454184109021678114444733524918042004519382135232440347764408400209238,
            11907590611510504133919552265477234176969003254081885100204008656767523539196
        ];
        uint256[2][2] memory b = [
            [
                12074783442507916633665182906111838295327766373230105789758870116418853661786,
                19673558567803714857983365441418227075419614852577444669868838041523053822495
            ],
            [
                14345503577131882347105010025369547760188533575101097022140360378203860768985,
                19277946504698722565498037945482598261293101185291893033191136039510096573580
            ]
        ];
        uint256[2] memory c = [
            1286191535724976993115868645733440518664215538340370499605925468686013731076,
            11746696505189778215652626326845383882865623404423651651334365119807194577109
        ];
        return abi.encode(a, b, c);
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

/**
 * Stateful handler for the fee invariant: random deposits, cash-outs, fee
 * collection, stray ETH, sweeps and fee lowering on one live pool it owns.
 */
contract FeeHandler is Test {
    ShieldPoolPayments2 public pool;
    MockERC20 public usd;
    address public constant RECIPIENT = address(0xFEE);
    address public constant USER = address(0x1234);
    address public constant TO = address(0xBEEF);

    uint256 internal salt;
    uint256 internal nul;
    mapping(address => uint256) public ghostFees;
    mapping(address => uint256) public ghostCollected;
    mapping(address => uint256) public ghostIn;
    mapping(address => uint256) public ghostOutGross;
    mapping(address => uint256) public ghostPaidToUsers;
    uint256 public ghostDonated;
    uint256 public ghostSwept;

    constructor(address poseidon2, address verifier) {
        pool = new ShieldPoolPayments2(poseidon2, verifier, STRAY);
        usd = new MockERC20();
        pool.setWithdrawFee(25, RECIPIENT);
        pool.setShieldVerifier(verifier);
        pool.turnOnDepositLimits();
        pool.setDepositLimit(address(usd), type(uint128).max, type(uint128).max);
        pool.setDepositLimit(address(0), type(uint128).max, type(uint128).max);
        pool.endSetup();
        usd.mint(USER, type(uint128).max);
        vm.prank(USER);
        usd.approve(address(pool), type(uint256).max);
    }

    receive() external payable {}

    function _asset(bool native) internal view returns (address) {
        return native ? address(0) : address(usd);
    }

    function deposit(bool native, uint256 amount) external {
        amount = bound(amount, 1, 1e30);
        address asset = _asset(native);
        if (native) vm.deal(USER, amount);
        vm.prank(USER);
        pool.shieldBound{value: native ? amount : 0}(asset, amount, bytes32(++salt), "");
        ghostIn[asset] += amount;
    }

    function withdraw(bool native, uint256 amount) external {
        address asset = _asset(native);
        uint256 dep = pool.deposited(asset);
        if (dep == 0) return;
        amount = bound(amount, 1, dep);
        uint256 bps = pool.withdrawFeeBps();
        uint256 fee = (amount * bps) / 10_000;
        uint256 toBefore = native ? TO.balance : usd.balanceOf(TO);
        bytes32 root = pool.currentRoot();
        pool.unshield(hex"00", root, bytes32(++nul), asset, TO, amount);
        uint256 got = (native ? TO.balance : usd.balanceOf(TO)) - toBefore;
        assertEq(got, amount - fee, "user gets amount - fee");
        ghostFees[asset] += fee;
        ghostOutGross[asset] += amount;
        ghostPaidToUsers[asset] += got;
    }

    function collect(bool native) external {
        address asset = _asset(native);
        uint256 owed = pool.feesOwed(asset);
        if (owed == 0) return;
        pool.collectFees(asset);
        ghostCollected[asset] += owed;
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 1, 100 ether);
        vm.deal(address(this), address(this).balance + amount);
        (bool ok, ) = address(pool).call{value: amount}("");
        require(ok);
        ghostDonated += amount;
    }

    function sweep() external {
        uint256 bal = address(pool).balance;
        uint256 protectedAmt = pool.deposited(address(0)) + pool.feesOwed(address(0));
        if (bal <= protectedAmt) return;
        pool.sweepStrayNative(address(0x5111));
        ghostSwept += bal - protectedAmt;
    }

    function lowerFee(uint16 bps) external {
        bps = uint16(bound(bps, 0, pool.withdrawFeeBps()));
        pool.lowerWithdrawFee(bps);
    }

    /// Raise (or re-set) the fee the only way possible after setup: queue, wait, execute.
    function raiseFee(uint16 bps) external {
        bps = uint16(bound(bps, pool.withdrawFeeBps(), 100));
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setWithdrawFee, (bps, RECIPIENT));
        (, uint256 eta) = pool.queueChange(call_);
        vm.warp(eta);
        pool.executeChange(call_);
    }
}

contract WithdrawFeeInvariantTestNext is Test {
    using stdJson for string;

    FeeHandler handler;

    function setUp() public {
        string memory json = vm.readFile("test/fixtures/Poseidon2.json");
        bytes memory bytecode = json.readBytes(".bytecode");
        address poseidon2;
        assembly {
            poseidon2 := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(poseidon2 != address(0), "poseidon deploy failed");
        handler = new FeeHandler(poseidon2, address(new FeeMockVerifier()));
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](7);
        sels[0] = FeeHandler.deposit.selector;
        sels[1] = FeeHandler.withdraw.selector;
        sels[2] = FeeHandler.collect.selector;
        sels[3] = FeeHandler.donate.selector;
        sels[4] = FeeHandler.sweep.selector;
        sels[5] = FeeHandler.lowerFee.selector;
        sels[6] = FeeHandler.raiseFee.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 40
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_balance_covers_notes_and_fees() public view {
        ShieldPoolPayments2 pool = handler.pool();
        MockERC20 usd = handler.usd();
        assertGe(
            usd.balanceOf(address(pool)),
            pool.deposited(address(usd)) + pool.feesOwed(address(usd)),
            "token: balance >= deposited + feesOwed"
        );
        assertGe(
            address(pool).balance,
            pool.deposited(address(0)) + pool.feesOwed(address(0)),
            "native: balance >= deposited + feesOwed"
        );
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 40
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_fee_accounting_is_exact() public view {
        ShieldPoolPayments2 pool = handler.pool();
        MockERC20 usd = handler.usd();
        address[2] memory assets = [address(usd), address(0)];
        for (uint256 i = 0; i < 2; i++) {
            address a = assets[i];
            assertEq(pool.feesOwed(a), handler.ghostFees(a) - handler.ghostCollected(a), "feesOwed = charged - collected");
            assertEq(pool.deposited(a), handler.ghostIn(a) - handler.ghostOutGross(a), "deposited = in - out (gross)");
            assertEq(handler.ghostPaidToUsers(a) + handler.ghostFees(a), handler.ghostOutGross(a), "paid + fees = gross out");
        }
        assertEq(usd.balanceOf(handler.RECIPIENT()), handler.ghostCollected(address(usd)));
        assertEq(handler.RECIPIENT().balance, handler.ghostCollected(address(0)));
        // The token pool holds exactly notes + owed fees; native also holds unswept strays.
        assertEq(
            usd.balanceOf(address(pool)),
            pool.deposited(address(usd)) + pool.feesOwed(address(usd)),
            "token balance exact"
        );
        assertEq(
            address(pool).balance,
            pool.deposited(address(0)) + pool.feesOwed(address(0)) + handler.ghostDonated() - handler.ghostSwept(),
            "native balance exact"
        );
    }
}
