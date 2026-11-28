// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Ported from test/VaultOwnerGuard.t.sol to the next vault (not deployed, not audited).
// Keep the two in step until the live vaults are retired.

import {PoolHarness2, STRAY} from "./NextHarness.sol";
import {ShieldPoolPoseidon} from "../../src/ShieldPoolPoseidon.sol";
import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {VaultOwnerGuard} from "../../src/VaultOwnerGuard.sol";
import {ShieldPoolCore2} from "../../src/ShieldPoolCore2.sol";
import {ShieldPoolPayments2} from "../../src/ShieldPoolPayments2.sol";
import {ChangeTimelock} from "../../src/lib/ChangeTimelock.sol";
import {IVerifier} from "../../src/interfaces/IVerifier.sol";
import {MockERC20} from "../MockERC20.sol";

contract GuardMockVerifier is IVerifier {
    bool public ok = true;

    function setOk(bool ok_) external {
        ok = ok_;
    }

    function verify(bytes calldata, uint256[] calldata) external view returns (bool) {
        return ok;
    }
}

/// The verifier an attacker wants installed: it accepts anything.
contract EvilVerifier is IVerifier {
    function verify(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return true;
    }
}

/// A sweep target that is not the controller and calls back while it is paid.
contract ReentrantReceiver {
    VaultOwnerGuard public immutable guard;
    bytes public attempt;
    bool public reached;
    bool public anySucceeded;

    constructor(VaultOwnerGuard guard_) {
        guard = guard_;
    }

    function arm(bytes calldata attempt_) external {
        attempt = attempt_;
    }

    receive() external payable {
        reached = true;
        (bool ok, ) = address(guard).call(attempt);
        anySucceeded = anySucceeded || ok;
    }
}

/// A controller gone bad: a contract, the sweep target too, that tries everything
/// from inside the sweep and from outside it.
contract MaliciousController {
    VaultOwnerGuard public immutable guard;
    address public immutable evil;
    bool public reachedDuringSweep;
    uint256 public verifierAttemptsThatWorked;

    constructor(VaultOwnerGuard guard_, address evil_) {
        guard = guard_;
        evil = evil_;
    }

    function accept() external {
        guard.acceptController();
    }

    function sweep() external {
        guard.sweepStrayNative(address(this));
    }

    /// Every route this contract can think of, from its seat as the controller.
    function tryEverything() public {
        ShieldPoolCore2 vault = ShieldPoolCore2(payable(address(guard.vault())));
        bytes memory setVerifier = abi.encodeCall(ShieldPoolCore2.setVerifier, (evil));
        bytes memory setShield = abi.encodeCall(ShieldPoolCore2.setShieldVerifier, (evil));
        bytes memory takeVault = abi.encodeCall(ShieldPoolCore2.transferOwnership, (address(this)));

        bytes[3] memory calls = [setVerifier, setShield, takeVault];
        for (uint256 i = 0; i < calls.length; i++) {
            _count(address(guard), abi.encodeCall(VaultOwnerGuard.queueChange, (calls[i])));
            _count(address(guard), abi.encodeCall(VaultOwnerGuard.executeChange, (calls[i])));
            _count(address(guard), abi.encodeCall(VaultOwnerGuard.cancelChange, (calls[i])));
            // and raw, as if the guard were a proxy, and straight at the vault
            _count(address(guard), calls[i]);
            _count(address(vault), calls[i]);
            _count(address(vault), abi.encodeCall(ChangeTimelock.queueChange, (calls[i])));
            _count(address(vault), abi.encodeCall(ChangeTimelock.executeChange, (calls[i])));
        }
    }

    function _count(address to, bytes memory data) private {
        (bool ok, ) = to.call(data);
        if (ok) verifierAttemptsThatWorked++;
    }

    receive() external payable {
        reachedDuringSweep = true;
        tryEverything();
    }
}

/// A vault, live and in the mainnet shape, owned by `oldOwner`.
abstract contract GuardFixture is Test {
    using stdJson for string;

    ShieldPoolPayments2 vault;
    VaultOwnerGuard guard;
    GuardMockVerifier spendV;
    GuardMockVerifier shieldV;
    MockERC20 usd;
    EvilVerifier evil;

    address oldOwner = makeAddr("old owner");
    address controller = makeAddr("controller");
    address stranger = makeAddr("stranger");
    address user = makeAddr("user");
    address treasury = makeAddr("treasury");
    address recipient = makeAddr("recipient");

    uint128 constant PER = 1_000e6;
    uint128 constant TOTAL = 25_000e6;
    uint16 constant FEE = 25;

    function _deployVault() internal {
        vm.warp(1_900_000_000);
        spendV = new GuardMockVerifier();
        shieldV = new GuardMockVerifier();
        evil = new EvilVerifier();
        usd = new MockERC20();
        vm.startPrank(oldOwner);
        vault = new ShieldPoolPayments2(_deployPoseidon(), address(spendV), STRAY);
        vault.turnOnDepositLimits();
        vault.setShieldVerifier(address(shieldV));
        vault.setDepositLimit(address(usd), PER, TOTAL);
        vault.setDepositLimit(address(0), 1 ether, 10 ether);
        vault.setWithdrawFee(FEE, treasury);
        vault.endSetup();
        vm.stopPrank();
        guard = new VaultOwnerGuard(address(vault), controller);
        usd.mint(user, 1_000_000e6);
        vm.prank(user);
        usd.approve(address(vault), type(uint256).max);
    }

    function _takeOver() internal {
        vm.prank(oldOwner);
        vault.transferOwnership(address(guard));
        vm.prank(controller);
        guard.acceptVaultOwnership();
    }

    function _deposit(uint256 amount, uint256 salt) internal returns (bytes32 commitment) {
        commitment = keccak256(abi.encode("note", amount, salt));
        vm.prank(user);
        vault.shieldBound(address(usd), amount, commitment, "");
    }

    function _withdraw(uint256 amount, uint256 nullifier) internal {
        bytes32 root = vault.currentRoot();
        vm.prank(stranger);
        vault.unshield(hex"00", root, bytes32(nullifier), address(usd), recipient, amount);
    }

    function _limitCall(address asset, uint128 per, uint128 total) internal pure returns (bytes memory) {
        return abi.encodeCall(ShieldPoolCore2.setDepositLimit, (asset, per, total));
    }

    function _feeCall(uint16 bps, address to) internal pure returns (bytes memory) {
        return abi.encodeCall(ShieldPoolCore2.setWithdrawFee, (bps, to));
    }

    function _setVerifierCall(address to) internal pure returns (bytes memory) {
        return abi.encodeCall(ShieldPoolCore2.setVerifier, (to));
    }

    function _setShieldVerifierCall(address to) internal pure returns (bytes memory) {
        return abi.encodeCall(ShieldPoolCore2.setShieldVerifier, (to));
    }

    function _assertLocked() internal view {
        assertEq(address(vault.verifier()), address(spendV), "verifier never changes");
        assertEq(address(vault.shieldVerifier()), address(shieldV), "shield verifier never changes");
        assertEq(vault.owner(), address(guard), "owner never changes");
        assertEq(vault.pendingOwner(), address(0), "nobody is ever offered the vault");
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

contract VaultOwnerGuardTest is GuardFixture {
    event VaultOwnershipAccepted(address indexed previousOwner);
    event ControllerTransferStarted(address indexed previousController, address indexed newController);
    event ControllerTransferred(address indexed previousController, address indexed newController);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ChangeQueued(bytes32 indexed id, bytes call, uint256 eta);
    event ChangeExecuted(bytes32 indexed id);
    event ChangeCancelled(bytes32 indexed id);

    function setUp() public {
        _deployVault();
    }

    // ───────────────────────────────────────────────────────────── construction

    function test_constructor_sets_the_vault_and_controller() public view {
        assertEq(address(guard.vault()), address(vault));
        assertEq(guard.controller(), controller);
        assertEq(guard.pendingController(), address(0));
    }

    function test_constructor_refuses_zero_addresses_and_a_codeless_vault() public {
        vm.expectRevert(VaultOwnerGuard.ZeroAddress.selector);
        new VaultOwnerGuard(address(0), controller);
        vm.expectRevert(VaultOwnerGuard.ZeroAddress.selector);
        new VaultOwnerGuard(address(vault), address(0));
        vm.expectRevert(VaultOwnerGuard.NotAContract.selector);
        new VaultOwnerGuard(makeAddr("not a vault"), controller);
    }

    function test_the_filtered_selectors_are_the_vaults() public view {
        assertEq(guard.SET_DEPOSIT_LIMIT(), ShieldPoolCore2.setDepositLimit.selector);
        assertEq(guard.SET_WITHDRAW_FEE(), ShieldPoolCore2.setWithdrawFee.selector);
    }

    // ───────────────────────────────────────────────────────────── taking over

    function test_takeover() public {
        vm.prank(oldOwner);
        vault.transferOwnership(address(guard));
        assertEq(vault.owner(), oldOwner, "nothing moves until the guard accepts");

        vm.expectEmit(true, true, false, false, address(vault));
        emit OwnershipTransferred(oldOwner, address(guard));
        vm.expectEmit(true, false, false, false, address(guard));
        emit VaultOwnershipAccepted(oldOwner);
        vm.prank(controller);
        guard.acceptVaultOwnership();

        assertEq(vault.owner(), address(guard));
        assertEq(vault.pendingOwner(), address(0));
    }

    function test_only_the_controller_can_accept() public {
        vm.prank(oldOwner);
        vault.transferOwnership(address(guard));
        vm.prank(stranger);
        vm.expectRevert(VaultOwnerGuard.NotController.selector);
        guard.acceptVaultOwnership();
        vm.prank(oldOwner);
        vm.expectRevert(VaultOwnerGuard.NotController.selector);
        guard.acceptVaultOwnership();
    }

    function test_accept_needs_an_offer() public {
        vm.prank(controller);
        vm.expectRevert(ShieldPoolCore2.NotPendingOwner.selector);
        guard.acceptVaultOwnership();
    }

    function test_accept_works_once() public {
        _takeOver();
        vm.prank(controller);
        vm.expectRevert(VaultOwnerGuard.AlreadyVaultOwner.selector);
        guard.acceptVaultOwnership();
        _assertLocked();
    }

    function test_accept_refuses_a_vault_in_setup() public {
        address poseidon = _deployPoseidon();
        vm.prank(oldOwner);
        ShieldPoolPayments2 young = new ShieldPoolPayments2(poseidon, address(spendV), STRAY);
        VaultOwnerGuard g = new VaultOwnerGuard(address(young), controller);
        vm.prank(oldOwner);
        young.transferOwnership(address(g));
        vm.prank(controller);
        vm.expectRevert(VaultOwnerGuard.VaultInSetup.selector);
        g.acceptVaultOwnership();
        assertEq(young.owner(), oldOwner, "a half-wired vault stays with its owner");
    }

    function test_nothing_is_forwarded_for_a_vault_it_does_not_own_yet() public {
        vm.startPrank(controller);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        guard.queueChange(_limitCall(address(usd), PER, TOTAL + 1));
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        guard.lowerDepositLimit(address(usd), 0, 0);
        vm.stopPrank();
    }

    // ───────────────────────────────────────────────────────────── one-way

    function test_ownership_can_never_move_again() public {
        _takeOver();
        address[3] memory who = [oldOwner, controller, stranger];
        for (uint256 i = 0; i < who.length; i++) {
            vm.startPrank(who[i]);
            vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
            vault.transferOwnership(who[i]);
            vm.expectRevert(ShieldPoolCore2.NotPendingOwner.selector);
            vault.acceptOwnership();
            vm.stopPrank();
        }
        _assertLocked();
    }

    function test_the_old_owner_keeps_nothing() public {
        vm.prank(oldOwner);
        vault.queueChange(_limitCall(address(usd), PER, TOTAL + 1));
        _takeOver();
        vm.warp(block.timestamp + vault.CHANGE_DELAY());

        vm.startPrank(oldOwner);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        vault.queueChange(_setVerifierCall(address(evil)));
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        vault.executeChange(_limitCall(address(usd), PER, TOTAL + 1));
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        vault.cancelChange(_limitCall(address(usd), PER, TOTAL + 1));
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        vault.lowerDepositLimit(address(usd), 0, 0);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        vault.lowerWithdrawFee(0);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        vault.sweepStrayNative(oldOwner);
        vm.stopPrank();
    }

    function test_setup_only_functions_stay_shut() public {
        _takeOver();
        vm.startPrank(address(guard));
        // even a guard that could call them would hit onlySetup
        vm.expectRevert(ChangeTimelock.TimelockRequired.selector);
        vault.setVerifier(address(evil));
        vm.expectRevert(ChangeTimelock.TimelockRequired.selector);
        vault.setShieldVerifier(address(evil));
        vm.expectRevert(ChangeTimelock.TimelockRequired.selector);
        vault.setDepositLimit(address(usd), 1, 1);
        vm.expectRevert(ChangeTimelock.TimelockRequired.selector);
        vault.setWithdrawFee(1, treasury);
        vm.expectRevert(ChangeTimelock.TimelockRequired.selector);
        vault.turnOnDepositLimits();
        vm.expectRevert(ChangeTimelock.SetupAlreadyEnded.selector);
        vault.endSetup();
        vm.stopPrank();
    }

    // ───────────────────────────────────────────────────────────── what is allowed

    function test_queue_execute_a_deposit_limit() public {
        _takeOver();
        bytes memory call_ = _limitCall(address(usd), 2_000e6, 50_000e6);
        bytes32 id = keccak256(call_);

        vm.expectEmit(true, false, false, true, address(vault));
        emit ChangeQueued(id, call_, block.timestamp + 3 days);
        vm.prank(controller);
        (bytes32 got, uint256 eta) = guard.queueChange(call_);
        assertEq(got, id);
        assertEq(eta, block.timestamp + 3 days);

        vm.prank(controller);
        vm.expectRevert(ChangeTimelock.ChangeNotReady.selector);
        guard.executeChange(call_);

        vm.warp(eta);
        vm.expectEmit(true, false, false, false, address(vault));
        emit ChangeExecuted(id);
        vm.prank(controller);
        guard.executeChange(call_);
        (uint128 per, uint128 total) = vault.depositLimit(address(usd));
        assertEq(per, 2_000e6);
        assertEq(total, 50_000e6);
    }

    function test_queue_execute_a_new_asset_and_a_fee() public {
        _takeOver();
        MockERC20 next = new MockERC20();
        vm.startPrank(controller);
        guard.queueChange(_limitCall(address(next), 5, 50));
        guard.queueChange(_feeCall(100, stranger));
        vm.warp(block.timestamp + 3 days);
        guard.executeChange(_limitCall(address(next), 5, 50));
        guard.executeChange(_feeCall(100, stranger));
        vm.stopPrank();
        (uint128 per, uint128 total) = vault.depositLimit(address(next));
        assertEq(per, 5);
        assertEq(total, 50);
        assertEq(vault.withdrawFeeBps(), 100);
        assertEq(vault.feeRecipient(), stranger);
    }

    function test_the_vault_still_enforces_its_own_rules_through_the_guard() public {
        _takeOver();
        // over the 1% cap: the guard forwards it, the vault refuses it at execute
        vm.startPrank(controller);
        guard.queueChange(_feeCall(101, treasury));
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(ShieldPoolCore2.FeeTooHigh.selector);
        guard.executeChange(_feeCall(101, treasury));
        // queueing the same change twice while it is live
        vm.expectRevert(ChangeTimelock.ChangeAlreadyQueued.selector);
        guard.queueChange(_feeCall(101, treasury));
        // past the grace window
        vm.warp(block.timestamp + 14 days + 1);
        vm.expectRevert(ChangeTimelock.ChangeExpired.selector);
        guard.executeChange(_feeCall(101, treasury));
        vm.stopPrank();
    }

    function test_cancel() public {
        _takeOver();
        bytes memory call_ = _feeCall(50, treasury);
        vm.startPrank(controller);
        guard.queueChange(call_);
        vm.expectEmit(true, false, false, false, address(vault));
        emit ChangeCancelled(keccak256(call_));
        guard.cancelChange(call_);
        assertEq(vault.changeEta(keccak256(call_)), 0);
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(ChangeTimelock.ChangeNotQueued.selector);
        guard.executeChange(call_);
        vm.stopPrank();
    }

    function test_lower_limits_and_fee_at_once() public {
        _takeOver();
        vm.startPrank(controller);
        guard.lowerDepositLimit(address(usd), 1, 2);
        guard.lowerWithdrawFee(10);
        vm.expectRevert(ShieldPoolCore2.LimitNotLower.selector);
        guard.lowerDepositLimit(address(usd), 2, 2);
        vm.expectRevert(ShieldPoolCore2.FeeNotLower.selector);
        guard.lowerWithdrawFee(11);
        vm.stopPrank();
        (uint128 per, uint128 total) = vault.depositLimit(address(usd));
        assertEq(per, 1);
        assertEq(total, 2);
        assertEq(vault.withdrawFeeBps(), 10);
        assertEq(vault.feeRecipient(), treasury, "lowering never moves the recipient");
    }

    function test_sweep_takes_only_the_surplus() public {
        vm.deal(user, 2 ether);
        bytes32 c = keccak256("eth note");
        vm.prank(user);
        vault.shieldBound{value: 1 ether}(address(0), 1 ether, c, "");
        vm.prank(user);
        (bool sent, ) = address(vault).call{value: 0.5 ether}("");
        assertTrue(sent);
        _takeOver();

        vm.prank(controller);
        guard.sweepStrayNative(recipient);
        assertEq(recipient.balance, 0.5 ether, "the stray coin, no more");
        assertEq(address(vault).balance, 1 ether, "the note's coin stays");

        vm.prank(controller);
        vm.expectRevert(ShieldPoolCore2.NothingToSweep.selector);
        guard.sweepStrayNative(recipient);
    }

    function test_every_function_is_controller_only() public {
        _takeOver();
        bytes memory limit = _limitCall(address(usd), PER, TOTAL + 1);
        bytes[8] memory calls = [
            abi.encodeCall(VaultOwnerGuard.queueChange, (limit)),
            abi.encodeCall(VaultOwnerGuard.executeChange, (limit)),
            abi.encodeCall(VaultOwnerGuard.cancelChange, (limit)),
            abi.encodeCall(VaultOwnerGuard.lowerDepositLimit, (address(usd), 0, 0)),
            abi.encodeCall(VaultOwnerGuard.lowerWithdrawFee, (0)),
            abi.encodeCall(VaultOwnerGuard.sweepStrayNative, (stranger)),
            abi.encodeCall(VaultOwnerGuard.transferController, (stranger)),
            abi.encodeWithSelector(VaultOwnerGuard.acceptVaultOwnership.selector)
        ];
        address[3] memory who = [stranger, oldOwner, address(vault)];
        for (uint256 w = 0; w < who.length; w++) {
            for (uint256 i = 0; i < calls.length; i++) {
                vm.prank(who[w]);
                (bool ok, bytes memory ret) = address(guard).call(calls[i]);
                assertFalse(ok);
                assertEq(bytes4(ret), VaultOwnerGuard.NotController.selector);
            }
        }
    }

    function test_withdrawals_and_transfers_are_untouched() public {
        _deposit(100e6, 1);
        _takeOver();
        _withdraw(100e6, 7);
        assertEq(usd.balanceOf(recipient), 100e6 - 250_000, "amount less 0.25%");

        // collectFees stays permissionless and pays the treasury
        vm.prank(stranger);
        vault.collectFees(address(usd));
        assertEq(usd.balanceOf(treasury), 250_000);

        // a private transfer doesn't go near the owner either
        _deposit(50e6, 2);
        bytes32 root = vault.currentRoot();
        vm.prank(stranger);
        vault.transfer(hex"00", root, bytes32(uint256(9)), [keccak256("a"), keccak256("b")]);
        assertTrue(vault.isSpent(bytes32(uint256(9))));
    }

    /// The incident path: deposits closed in one call per asset, the fee waived,
    /// and everyone can still leave.
    function test_incident_close_deposits_and_everyone_still_leaves() public {
        _deposit(300e6, 1);
        _deposit(200e6, 2);
        _takeOver();

        vm.startPrank(controller);
        guard.lowerDepositLimit(address(usd), 0, 0);
        guard.lowerDepositLimit(address(0), 0, 0);
        guard.lowerWithdrawFee(0);
        vm.stopPrank();

        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.OverDepositLimit.selector);
        vault.shieldBound(address(usd), 1, keccak256("late"), "");

        _withdraw(300e6, 1);
        _withdraw(200e6, 2);
        assertEq(usd.balanceOf(recipient), 500e6, "no fee on the way out");
        assertEq(vault.deposited(address(usd)), 0);
        assertEq(usd.balanceOf(address(vault)), 0);
    }

    /// The price of the one-way door, written down: a proof checker that stops
    /// working cannot be replaced, so notes behind it stay where they are.
    function test_tradeoff_a_dead_checker_cannot_be_replaced() public {
        _deposit(100e6, 1);
        _takeOver();
        spendV.setOk(false);

        bytes32 root = vault.currentRoot();
        vm.prank(stranger);
        vm.expectRevert(ShieldPoolCore2.InvalidProof.selector);
        vault.unshield(hex"00", root, bytes32(uint256(7)), address(usd), recipient, 100e6);

        vm.startPrank(controller);
        vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
        guard.queueChange(_setVerifierCall(address(evil)));
        vm.stopPrank();
        assertEq(usd.balanceOf(address(vault)), 100e6, "the money stays, and stays stuck");
    }

    // ───────────────────────────────────────────────────────────── the filter

    function test_setVerifier_is_refused_by_all_three_routes() public {
        _takeOver();
        bytes[2] memory calls = [_setVerifierCall(address(evil)), _setShieldVerifierCall(address(evil))];
        vm.startPrank(controller);
        for (uint256 i = 0; i < calls.length; i++) {
            vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
            guard.queueChange(calls[i]);
            vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
            guard.executeChange(calls[i]);
            vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
            guard.cancelChange(calls[i]);
        }
        vm.stopPrank();
        _assertLocked();
    }

    /// Every selector the deployed vault has that is not a timelock setter, and
    /// every setter PoolHarness2 adds through _changeArgWords.
    function test_every_other_selector_is_refused() public {
        _takeOver();
        bytes4[20] memory selectors = [
            ShieldPoolCore2.setVerifier.selector,
            ShieldPoolCore2.setShieldVerifier.selector,
            ShieldPoolCore2.transferOwnership.selector,
            ShieldPoolCore2.acceptOwnership.selector,
            ChangeTimelock.endSetup.selector,
            ShieldPoolCore2.turnOnDepositLimits.selector,
            ChangeTimelock.queueChange.selector,
            ChangeTimelock.executeChange.selector,
            ChangeTimelock.cancelChange.selector,
            ShieldPoolCore2.lowerDepositLimit.selector,
            ShieldPoolCore2.lowerWithdrawFee.selector,
            ShieldPoolCore2.sweepStrayNative.selector,
            ShieldPoolCore2.collectFees.selector,
            bytes4(keccak256("unshield(bytes,bytes32,bytes32,address,address,uint256)")),
            ShieldPoolCore2.shieldBound.selector,
            ShieldPoolPoseidon.setSealedSwapVerifier.selector,
            ShieldPoolPoseidon.setSwapRate.selector,
            ShieldPoolPoseidon.setPriceFeed.selector,
            ShieldPoolPoseidon.setOracleConfig.selector,
            ShieldPoolPoseidon.setOracleRatePair.selector
        ];
        vm.startPrank(controller);
        for (uint256 i = 0; i < selectors.length; i++) {
            // at the two lengths the filter opens for, and the honest short one
            uint256[3] memory words = [uint256(1), 2, 3];
            for (uint256 w = 0; w < words.length; w++) {
                bytes memory call_ = abi.encodePacked(selectors[i], new bytes(32 * words[w]));
                assertFalse(guard.isAllowedChange(call_));
                vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
                guard.queueChange(call_);
                vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
                guard.executeChange(call_);
                vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
                guard.cancelChange(call_);
            }
        }
        vm.stopPrank();
        _assertLocked();
    }

    function test_malformed_bytes_are_refused() public {
        _takeOver();
        bytes memory limit = _limitCall(address(usd), PER, TOTAL + 1);
        bytes memory fee = _feeCall(10, treasury);
        bytes4 limitSel = ShieldPoolCore2.setDepositLimit.selector;
        bytes4 feeSel = ShieldPoolCore2.setWithdrawFee.selector;

        bytes[13] memory bad = [
            bytes(""),
            hex"a6",
            hex"a6c1",
            hex"a6c166",
            abi.encodePacked(limitSel),
            abi.encodePacked(limit, uint8(0)), // one trailing byte
            abi.encodePacked(limit, bytes32(0)), // one trailing word
            abi.encodePacked(limit, _setVerifierCall(address(evil))), // smuggled after the args
            abi.encodePacked(fee, uint8(0)),
            abi.encodePacked(fee, _setVerifierCall(address(evil))),
            _slice(limit, 99), // one byte short
            abi.encodePacked(limitSel, new bytes(64)), // the limit selector at the fee's length
            abi.encodePacked(feeSel, new bytes(96)) // the fee selector at the limit's length
        ];
        vm.startPrank(controller);
        for (uint256 i = 0; i < bad.length; i++) {
            assertFalse(guard.isAllowedChange(bad[i]));
            vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
            guard.queueChange(bad[i]);
            vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
            guard.executeChange(bad[i]);
            vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
            guard.cancelChange(bad[i]);
        }
        vm.stopPrank();
    }

    /// setVerifier's selector at every position a wrapper could hide it, with the
    /// outer call of the right length or not.
    function test_a_selector_nested_in_a_call_does_nothing() public {
        _takeOver();
        bytes memory evilCall = _setVerifierCall(address(evil));

        // wrapped in the timelock's own calls
        bytes[3] memory wrapped = [
            abi.encodeCall(ChangeTimelock.queueChange, (evilCall)),
            abi.encodeCall(ChangeTimelock.executeChange, (evilCall)),
            abi.encodeCall(ChangeTimelock.cancelChange, (evilCall))
        ];
        vm.startPrank(controller);
        for (uint256 i = 0; i < wrapped.length; i++) {
            vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
            guard.queueChange(wrapped[i]);
        }

        // inside an allowed call of exactly the right length: it passes the
        // filter as the limit call it is, and the vault runs it as nothing else
        bytes32 asWord = bytes32(evilCall);
        bytes memory nested = abi.encodePacked(ShieldPoolCore2.setDepositLimit.selector, asWord, bytes32(0), bytes32(0));
        assertEq(nested.length, 100);
        assertTrue(guard.isAllowedChange(nested));
        guard.queueChange(nested);
        vm.warp(block.timestamp + 3 days);
        // the address word has dirty high bytes, so the vault's abi.decode refuses it
        vm.expectRevert();
        guard.executeChange(nested);
        vm.stopPrank();
        _assertLocked();
    }

    /// Hand-built calldata: the ABI offset of `call` moved so the bytes checked
    /// could differ from the bytes sent, if the two were ever read separately.
    function test_non_canonical_outer_encoding_cannot_split_the_check_from_the_send() public {
        _takeOver();
        bytes memory allowed = _limitCall(address(usd), PER, TOTAL + 1);
        bytes memory evilCall = _setVerifierCall(address(evil));

        // the decoder lands on setVerifier: refused, whatever sits at the usual offset
        bytes memory decoyAllowed = abi.encodePacked(
            VaultOwnerGuard.queueChange.selector,
            uint256(0x20 + 0x20 + 0x80), // past the decoy
            uint256(allowed.length),
            allowed,
            new bytes(28),
            uint256(evilCall.length),
            evilCall,
            new bytes(28)
        );
        vm.prank(controller);
        (bool ok, bytes memory ret) = address(guard).call(decoyAllowed);
        assertFalse(ok, "setVerifier at the real offset");
        assertEq(bytes4(ret), VaultOwnerGuard.ChangeNotAllowed.selector);

        // the decoder lands on the allowed call: only that is queued
        bytes memory decoyEvil = abi.encodePacked(
            VaultOwnerGuard.queueChange.selector,
            uint256(0x20 + 0x20 + 0x40), // past the decoy
            uint256(evilCall.length),
            evilCall,
            new bytes(28),
            uint256(allowed.length),
            allowed,
            new bytes(28)
        );
        vm.prank(controller);
        (ok, ) = address(guard).call(decoyEvil);
        assertTrue(ok, "the allowed call at the real offset");
        assertGt(vault.changeEta(keccak256(allowed)), 0);
        assertEq(vault.changeEta(keccak256(evilCall)), 0, "setVerifier is not queued");

        // trailing calldata after a valid `bytes` is ignored by the decoder, and
        // what is sent to the vault is the decoded slice alone
        bytes memory trailing = abi.encodePacked(
            abi.encodeCall(VaultOwnerGuard.queueChange, (_feeCall(1, treasury))),
            evilCall
        );
        vm.prank(controller);
        (ok, ) = address(guard).call(trailing);
        assertTrue(ok);
        assertGt(vault.changeEta(keccak256(_feeCall(1, treasury))), 0);
        assertEq(vault.changeEta(keccak256(evilCall)), 0);
        _assertLocked();
    }

    // ───────────────────────────────────────────────────────────── queued changes

    function test_a_queued_verifier_change_dies_with_the_handover() public {
        bytes memory evilCall = _setVerifierCall(address(evil));
        vm.prank(oldOwner);
        (, uint256 eta) = vault.queueChange(evilCall);
        _takeOver();

        assertEq(vault.changeEta(keccak256(evilCall)), eta, "the entry survives the ownership move");

        vm.warp(eta);
        vm.prank(controller);
        vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
        guard.executeChange(evilCall);
        vm.prank(oldOwner);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        vault.executeChange(evilCall);
        vm.prank(stranger);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        vault.executeChange(evilCall);
        _assertLocked();

        // nor can it be cancelled here: it just expires, and stays dead
        vm.prank(controller);
        vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
        guard.cancelChange(evilCall);
        vm.warp(eta + vault.CHANGE_GRACE() + 1);
        vm.prank(controller);
        vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
        guard.executeChange(evilCall);
        _assertLocked();
    }

    /// Without the handover, the same queue entry really would run: the test above
    /// proves something only if this one holds.
    function test_control_the_old_owner_could_run_it_before_the_handover() public {
        bytes memory evilCall = _setVerifierCall(address(evil));
        vm.prank(oldOwner);
        (, uint256 eta) = vault.queueChange(evilCall);
        vm.warp(eta);
        vm.prank(oldOwner);
        vault.executeChange(evilCall);
        assertEq(address(vault.verifier()), address(evil), "the vault's own path is open to its owner");
    }

    function test_a_queued_limit_from_the_old_owner_runs_through_the_guard() public {
        bytes memory limit = _limitCall(address(usd), type(uint128).max, type(uint128).max);
        vm.prank(oldOwner);
        (, uint256 eta) = vault.queueChange(limit);
        _takeOver();
        vm.warp(eta);
        vm.prank(controller);
        guard.executeChange(limit);
        (uint128 per, uint128 total) = vault.depositLimit(address(usd));
        assertEq(per, type(uint128).max);
        assertEq(total, type(uint128).max);
    }

    function test_a_stale_lower_limit_from_the_old_owner_can_be_cancelled_through_the_guard() public {
        bytes memory stale = _limitCall(address(usd), 100_000e6, 2_500_000e6);
        vm.prank(oldOwner);
        vault.queueChange(stale);
        _takeOver();
        vm.prank(controller);
        guard.cancelChange(stale);
        assertEq(vault.changeEta(keccak256(stale)), 0);
    }

    // ───────────────────────────────────────────────────────────── reentrancy

    function test_a_sweep_target_cannot_reenter_as_the_controller() public {
        vm.deal(address(vault), 1 ether);
        _takeOver();
        ReentrantReceiver r = new ReentrantReceiver(guard);
        bytes memory evilCall = _setVerifierCall(address(evil));
        bytes[4] memory attempts = [
            abi.encodeCall(VaultOwnerGuard.queueChange, (evilCall)),
            abi.encodeCall(VaultOwnerGuard.executeChange, (evilCall)),
            abi.encodeCall(VaultOwnerGuard.transferController, (address(r))),
            abi.encodeCall(VaultOwnerGuard.queueChange, (_feeCall(1, address(r))))
        ];
        for (uint256 i = 0; i < attempts.length; i++) {
            r.arm(attempts[i]);
            vm.deal(address(vault), 1 ether);
            vm.prank(controller);
            guard.sweepStrayNative(address(r));
            assertTrue(r.reached());
            assertFalse(r.anySucceeded());
        }
        assertEq(guard.controller(), controller);
        assertEq(guard.pendingController(), address(0));
        _assertLocked();
    }

    function test_a_malicious_controller_cannot_reach_the_verifier_or_the_vault() public {
        MaliciousController bad = new MaliciousController(guard, address(evil));
        _takeOver();
        vm.prank(controller);
        guard.transferController(address(bad));
        bad.accept();
        assertEq(guard.controller(), address(bad));

        // with a setVerifier already matured in the queue, from the outside...
        bad.tryEverything();
        assertEq(bad.verifierAttemptsThatWorked(), 0);
        _assertLocked();

        // ...and from inside a sweep, while the vault's latch is held
        vm.deal(address(vault), 1 ether);
        bad.sweep();
        assertTrue(bad.reachedDuringSweep());
        assertEq(bad.verifierAttemptsThatWorked(), 0);
        _assertLocked();
    }

    function test_a_malicious_controller_finds_a_matured_verifier_change_shut() public {
        MaliciousController bad = new MaliciousController(guard, address(evil));
        vm.prank(oldOwner);
        (, uint256 eta) = vault.queueChange(_setVerifierCall(address(evil)));
        _takeOver();
        vm.prank(controller);
        guard.transferController(address(bad));
        bad.accept();
        vm.warp(eta);
        bad.tryEverything();
        assertEq(bad.verifierAttemptsThatWorked(), 0);
        _assertLocked();
    }

    // ───────────────────────────────────────────────────────────── surface

    /// The guard has no fallback: nothing outside its own ABI runs, and no vault
    /// selector it doesn't forward can be sent to it as if it were a proxy.
    function test_it_is_not_a_proxy() public {
        _takeOver();
        bytes[6] memory raw = [
            _setVerifierCall(address(evil)),
            _setShieldVerifierCall(address(evil)),
            abi.encodeCall(ShieldPoolCore2.transferOwnership, (controller)),
            abi.encodeCall(ChangeTimelock.endSetup, ()),
            abi.encodeCall(ShieldPoolCore2.turnOnDepositLimits, ()),
            bytes("")
        ];
        vm.startPrank(controller);
        for (uint256 i = 0; i < raw.length; i++) {
            (bool ok, ) = address(guard).call(raw[i]);
            assertFalse(ok);
        }
        vm.stopPrank();
        _assertLocked();
    }

    function test_it_takes_no_money() public {
        vm.deal(controller, 1 ether);
        vm.startPrank(controller);
        (bool ok, ) = address(guard).call{value: 1}("");
        assertFalse(ok, "no receive");
        (ok, ) = address(guard).call{value: 1}(abi.encodeCall(VaultOwnerGuard.lowerWithdrawFee, (0)));
        assertFalse(ok, "nothing payable");
        vm.stopPrank();

        // so a sweep to the guard fails rather than strands the coin in it
        vm.deal(address(vault), 1 ether);
        _takeOver();
        vm.prank(controller);
        vm.expectRevert(ShieldPoolCore2.TransferFailed.selector);
        guard.sweepStrayNative(address(guard));
    }

    /// Walks the runtime code, skipping PUSH data, up to the metadata.
    function test_the_runtime_has_no_delegatecall_selfdestruct_or_create() public view {
        bytes memory code = address(guard).code;
        uint256 metadata = (uint256(uint8(code[code.length - 2])) << 8) | uint256(uint8(code[code.length - 1]));
        uint256 end = code.length - metadata - 2;
        uint256 calls;
        for (uint256 pc = 0; pc < end; pc++) {
            uint8 op = uint8(code[pc]);
            if (op >= 0x60 && op <= 0x7f) {
                pc += op - 0x5f;
                continue;
            }
            assertTrue(op != 0xf4, "DELEGATECALL");
            assertTrue(op != 0xf2, "CALLCODE");
            assertTrue(op != 0xff, "SELFDESTRUCT");
            assertTrue(op != 0xf0, "CREATE");
            assertTrue(op != 0xf5, "CREATE2");
            if (op == 0xf1) calls++;
        }
        // seven forwarded functions (accept, queue, execute, cancel, lower limit,
        // lower fee, sweep); the optimizer shares identical call sites between them
        assertGt(calls, 0);
        assertLe(calls, 7);
    }

    /// Pins the surface: every 4-byte constant in the runtime must be a guard
    /// function, a vault function it calls, an error, or Panic. A new external
    /// function, or a new vault call, adds one and fails here.
    function test_the_runtime_holds_only_the_documented_selectors() public view {
        bytes4[28] memory known = [
            // the guard's ABI
            guard.SET_DEPOSIT_LIMIT.selector,
            guard.SET_WITHDRAW_FEE.selector,
            guard.vault.selector,
            guard.controller.selector,
            guard.pendingController.selector,
            VaultOwnerGuard.isAllowedChange.selector,
            VaultOwnerGuard.acceptVaultOwnership.selector,
            VaultOwnerGuard.queueChange.selector,
            VaultOwnerGuard.executeChange.selector,
            VaultOwnerGuard.cancelChange.selector,
            VaultOwnerGuard.lowerDepositLimit.selector,
            VaultOwnerGuard.lowerWithdrawFee.selector,
            VaultOwnerGuard.sweepStrayNative.selector,
            VaultOwnerGuard.transferController.selector,
            VaultOwnerGuard.acceptController.selector,
            // what it calls on the vault, beyond the same-named functions above
            vault.owner.selector,
            vault.setupMode.selector,
            ShieldPoolCore2.acceptOwnership.selector,
            // what it filters on
            ShieldPoolCore2.setDepositLimit.selector,
            ShieldPoolCore2.setWithdrawFee.selector,
            // its errors, and the compiler's panic
            VaultOwnerGuard.ZeroAddress.selector,
            VaultOwnerGuard.NotAContract.selector,
            VaultOwnerGuard.NotController.selector,
            VaultOwnerGuard.NotPendingController.selector,
            VaultOwnerGuard.ChangeNotAllowed.selector,
            VaultOwnerGuard.AlreadyVaultOwner.selector,
            VaultOwnerGuard.VaultInSetup.selector,
            bytes4(0x4e487b71)
        ];
        bytes memory code = address(guard).code;
        uint256 metadata = (uint256(uint8(code[code.length - 2])) << 8) | uint256(uint8(code[code.length - 1]));
        uint256 end = code.length - metadata - 2;
        uint256 seen;
        for (uint256 pc = 0; pc < end; pc++) {
            uint8 op = uint8(code[pc]);
            if (op == 0x63) {
                uint32 value = (uint32(uint8(code[pc + 1])) << 24) | (uint32(uint8(code[pc + 2])) << 16)
                    | (uint32(uint8(code[pc + 3])) << 8) | uint32(uint8(code[pc + 4]));
                // The optimizer writes a selector with leading zero bits as a smaller
                // constant and a longer shift: PUSH4 x, PUSH1 0xe2, SHL is x << 2.
                if (uint8(code[pc + 5]) == 0x60 && uint8(code[pc + 7]) == 0x1b && uint8(code[pc + 6]) > 0xe0) {
                    value <<= uint8(code[pc + 6]) - 0xe0;
                }
                bytes4 word = bytes4(value);
                bool found = word == 0xffffffff; // the selector mask before a vault call
                for (uint256 i = 0; i < known.length && !found; i++) found = known[i] == word;
                assertTrue(found, vm.toString(abi.encodePacked(word)));
                seen++;
            }
            if (op >= 0x60 && op <= 0x7f) pc += op - 0x5f;
        }
        assertGt(seen, 15, "the walk reached the dispatcher");
    }

    // ───────────────────────────────────────────────────────────── the controller

    function test_controller_handover() public {
        address safe = makeAddr("safe");
        vm.expectEmit(true, true, false, false, address(guard));
        emit ControllerTransferStarted(controller, safe);
        vm.prank(controller);
        guard.transferController(safe);
        assertEq(guard.controller(), controller, "nothing moves until it is accepted");
        assertEq(guard.pendingController(), safe);

        vm.prank(stranger);
        vm.expectRevert(VaultOwnerGuard.NotPendingController.selector);
        guard.acceptController();
        vm.prank(controller);
        vm.expectRevert(VaultOwnerGuard.NotPendingController.selector);
        guard.acceptController();

        vm.expectEmit(true, true, false, false, address(guard));
        emit ControllerTransferred(controller, safe);
        vm.prank(safe);
        guard.acceptController();
        assertEq(guard.controller(), safe);
        assertEq(guard.pendingController(), address(0));

        _vaultOffer();
        vm.prank(controller);
        vm.expectRevert(VaultOwnerGuard.NotController.selector);
        guard.acceptVaultOwnership();
        vm.prank(safe);
        guard.acceptVaultOwnership();
        vm.prank(controller);
        vm.expectRevert(VaultOwnerGuard.NotController.selector);
        guard.lowerWithdrawFee(0);
        vm.prank(safe);
        guard.lowerWithdrawFee(0);
    }

    function test_controller_zero_address_is_refused() public {
        vm.prank(controller);
        vm.expectRevert(VaultOwnerGuard.ZeroAddress.selector);
        guard.transferController(address(0));
    }

    function test_nobody_can_accept_when_nothing_is_pending() public {
        vm.prank(stranger);
        vm.expectRevert(VaultOwnerGuard.NotPendingController.selector);
        guard.acceptController();
    }

    function test_a_pending_handover_can_be_replaced_and_dropped() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        vm.startPrank(controller);
        guard.transferController(a);
        guard.transferController(b);
        vm.stopPrank();
        vm.prank(a);
        vm.expectRevert(VaultOwnerGuard.NotPendingController.selector);
        guard.acceptController();

        // dropped by naming the current controller and accepting
        vm.startPrank(controller);
        guard.transferController(controller);
        guard.acceptController();
        vm.stopPrank();
        assertEq(guard.controller(), controller);
        assertEq(guard.pendingController(), address(0));
        vm.prank(b);
        vm.expectRevert(VaultOwnerGuard.NotPendingController.selector);
        guard.acceptController();
    }

    function test_the_controller_handover_gives_the_new_controller_no_more_than_the_old() public {
        address safe = makeAddr("safe");
        _takeOver();
        vm.prank(controller);
        guard.transferController(safe);
        vm.prank(safe);
        guard.acceptController();
        vm.prank(safe);
        vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
        guard.queueChange(_setVerifierCall(safe));
        _assertLocked();
    }

    // ───────────────────────────────────────────────────────────── fuzz

    function testFuzz_isAllowedChange_is_exactly_the_two_setters(bytes calldata call_) public view {
        bool limit = call_.length == 100 && bytes4(call_[:4]) == ShieldPoolCore2.setDepositLimit.selector;
        bool fee = call_.length == 68 && bytes4(call_[:4]) == ShieldPoolCore2.setWithdrawFee.selector;
        assertEq(guard.isAllowedChange(call_), limit || fee);
    }

    function testFuzz_a_real_setter_call_is_allowed(address asset, uint128 per, uint128 total, uint16 bps, address to)
        public
        view
    {
        assertTrue(guard.isAllowedChange(_limitCall(asset, per, total)));
        assertTrue(guard.isAllowedChange(_feeCall(bps, to)));
    }

    function testFuzz_no_setVerifier_is_allowed(address to, bytes calldata tail) public view {
        assertFalse(guard.isAllowedChange(_setVerifierCall(to)));
        assertFalse(guard.isAllowedChange(_setShieldVerifierCall(to)));
        assertFalse(guard.isAllowedChange(abi.encodePacked(_setVerifierCall(to), tail)));
        assertFalse(guard.isAllowedChange(abi.encodePacked(_setShieldVerifierCall(to), tail)));
    }

    /// Any bytes, any time, by any of the three routes, with a verifier change
    /// matured in the queue: verifier and owner stay.
    function testFuzz_any_bytes_change_nothing_that_matters(bytes calldata call_, uint32 wait) public {
        vm.prank(oldOwner);
        vault.queueChange(_setVerifierCall(address(evil)));
        _takeOver();

        vm.startPrank(controller);
        try guard.queueChange(call_) {} catch {}
        vm.warp(block.timestamp + wait);
        try guard.executeChange(call_) {} catch {}
        try guard.cancelChange(call_) {} catch {}
        vm.stopPrank();
        _assertLocked();
    }

    /// A setVerifier call with one byte changed anywhere: either refused, or it
    /// has become one of the two setters and runs as that, never as setVerifier.
    function testFuzz_a_mutated_setVerifier_never_lands(uint256 at, uint8 flip, bytes calldata tail) public {
        vm.assume(flip != 0);
        _takeOver();
        bytes memory call_ = abi.encodePacked(_setVerifierCall(address(evil)), tail);
        call_[at % call_.length] = bytes1(uint8(call_[at % call_.length]) ^ flip);

        vm.startPrank(controller);
        try guard.queueChange(call_) {} catch {}
        vm.warp(block.timestamp + 3 days);
        try guard.executeChange(call_) {} catch {}
        vm.stopPrank();
        _assertLocked();
    }

    function testFuzz_anyone_else_gets_nothing(address caller, bytes calldata data) public {
        vm.assume(caller != controller && caller != address(0));
        _takeOver();
        bytes memory before = abi.encode(guard.controller(), guard.pendingController());
        vm.prank(caller);
        (bool ok, ) = address(guard).call(data);
        // only the views and the pure filter can succeed for a stranger
        if (ok) assertEq(abi.encode(guard.controller(), guard.pendingController()), before);
        _assertLocked();
    }

    // ───────────────────────────────────────────────────────────── helpers

    function _vaultOffer() internal {
        vm.prank(oldOwner);
        vault.transferOwnership(address(guard));
    }

    function _slice(bytes memory b, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; i++) out[i] = b[i];
    }
}

/**
 * The stateful handler. Everything a controller, a past controller, the old owner
 * or a stranger can do, in any order and at any time, with a verifier change and
 * a shield verifier change sitting in the queue from before the handover.
 */
contract GuardHandler is Test {
    VaultOwnerGuard public immutable guard;
    ShieldPoolPayments2 public immutable vault;
    address public immutable oldOwner;
    address public immutable evil;
    bytes public evilCall;
    bytes public evilShieldCall;

    address[] public actors;
    uint256 public allowedRan;

    constructor(VaultOwnerGuard guard_, ShieldPoolPayments2 vault_, address oldOwner_, address evil_) {
        guard = guard_;
        vault = vault_;
        oldOwner = oldOwner_;
        evil = evil_;
        evilCall = abi.encodeCall(ShieldPoolCore2.setVerifier, (evil_));
        evilShieldCall = abi.encodeCall(ShieldPoolCore2.setShieldVerifier, (evil_));
        actors.push(makeAddr("actor 0"));
        actors.push(makeAddr("actor 1"));
        actors.push(oldOwner_);
        actors.push(guard_.controller());
    }

    function _actor(uint256 seed) private view returns (address) {
        return actors[seed % actors.length];
    }

    /// Each of the three routes, with anything at all.
    function route(uint8 which, bytes calldata call_) public {
        vm.startPrank(guard.controller());
        if (which % 3 == 0) {
            try guard.queueChange(call_) {} catch {}
        } else if (which % 3 == 1) {
            try guard.executeChange(call_) {
                allowedRan++;
            } catch {}
        } else {
            try guard.cancelChange(call_) {} catch {}
        }
        vm.stopPrank();
    }

    /// The queued verifier calls themselves, and small edits of them.
    function queuedVerifier(uint8 which, bool shieldOne, uint8 extra) public {
        bytes memory c = shieldOne ? evilShieldCall : evilCall;
        if (extra % 4 == 1) c = bytes.concat(c, bytes1(0));
        if (extra % 4 == 2) c = bytes.concat(c, new bytes(32));
        if (extra % 4 == 3) c = bytes.concat(bytes4(guard.SET_DEPOSIT_LIMIT()), c, new bytes(28));
        this.route(which, c);
    }

    /// Real allowed calls, so the queue moves and matured changes do run.
    function allowed(uint8 which, uint128 per, uint128 total, uint16 bps) public {
        bytes memory c = which % 2 == 0
            ? abi.encodeCall(ShieldPoolCore2.setDepositLimit, (address(0), per, total))
            : abi.encodeCall(ShieldPoolCore2.setWithdrawFee, (uint16(bps % 101), address(this)));
        this.route(which / 2, c);
    }

    function raw(uint256 who, bytes calldata data) public {
        vm.prank(_actor(who));
        (bool ok, ) = address(guard).call(data);
        ok;
    }

    function rawAtVault(uint256 who, bytes calldata data) public {
        vm.prank(_actor(who));
        (bool ok, ) = address(vault).call(data);
        ok;
    }

    function oldOwnerTries() public {
        vm.startPrank(oldOwner);
        try vault.executeChange(evilCall) {} catch {}
        try vault.transferOwnership(oldOwner) {} catch {}
        try vault.queueChange(evilCall) {} catch {}
        try vault.acceptOwnership() {} catch {}
        vm.stopPrank();
    }

    function lower(uint128 per, uint128 total, uint16 bps) public {
        vm.startPrank(guard.controller());
        try guard.lowerDepositLimit(address(0), per, total) {} catch {}
        try guard.lowerWithdrawFee(bps) {} catch {}
        vm.stopPrank();
    }

    function moveController(uint256 who) public {
        address next = _actor(who);
        vm.prank(guard.controller());
        guard.transferController(next);
        vm.prank(next);
        guard.acceptController();
    }

    function acceptAgain() public {
        vm.prank(guard.controller());
        try guard.acceptVaultOwnership() {} catch {}
    }

    function wait(uint32 by) public {
        vm.warp(block.timestamp + (by % 4 days));
    }
}

contract VaultOwnerGuardInvariantTest is GuardFixture {
    GuardHandler handler;

    function setUp() public {
        _deployVault();
        vm.startPrank(oldOwner);
        vault.queueChange(_setVerifierCall(address(evil)));
        vm.stopPrank();
        _takeOver();
        handler = new GuardHandler(guard, vault, oldOwner, address(evil));
        targetContract(address(handler));
        bytes4[] memory s = new bytes4[](10);
        s[0] = GuardHandler.route.selector;
        s[1] = GuardHandler.queuedVerifier.selector;
        s[2] = GuardHandler.allowed.selector;
        s[3] = GuardHandler.raw.selector;
        s[4] = GuardHandler.rawAtVault.selector;
        s[5] = GuardHandler.oldOwnerTries.selector;
        s[6] = GuardHandler.lower.selector;
        s[7] = GuardHandler.moveController.selector;
        s[8] = GuardHandler.acceptAgain.selector;
        s[9] = GuardHandler.wait.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: s}));
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 64
    function invariant_verifier_never_changes() public view {
        assertEq(address(vault.verifier()), address(spendV));
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 64
    function invariant_shield_verifier_never_changes() public view {
        assertEq(address(vault.shieldVerifier()), address(shieldV));
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 64
    function invariant_owner_never_changes_and_nobody_is_offered_the_vault() public view {
        assertEq(vault.owner(), address(guard));
        assertEq(vault.pendingOwner(), address(0));
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 64
    function invariant_fee_stays_under_the_vaults_cap() public view {
        assertLe(vault.withdrawFeeBps(), vault.MAX_WITHDRAW_FEE_BPS());
    }
}
