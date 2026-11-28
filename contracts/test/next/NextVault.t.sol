// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore2} from "../../src/ShieldPoolCore2.sol";
import {ShieldPoolPayments2} from "../../src/ShieldPoolPayments2.sol";
import {ShieldPoolPayments} from "../../src/ShieldPoolPayments.sol";
import {ChangeTimelock} from "../../src/lib/ChangeTimelock.sol";
import {IVerifier} from "../../src/interfaces/IVerifier.sol";
import {IShieldPool} from "../../src/interfaces/IShieldPool.sol";
import {DualProofVerifier2} from "../../src/verifiers/DualProofVerifier2.sol";
import {MockERC20} from "../MockERC20.sol";

/// Accepts a proof only for the exact public inputs it names: abi.encode(keccak256(inputs)).
contract InputBoundVerifier is IVerifier {
    function verify(bytes calldata proof, uint256[] calldata inputs) external pure returns (bool) {
        return proof.length == 32 && bytes32(proof) == keccak256(abi.encode(inputs));
    }
}

/// Fails the test run if a proof is ever checked: for paths that must stop first.
contract NeverCalledVerifier is IVerifier {
    function verify(bytes calldata, uint256[] calldata) external pure returns (bool) {
        revert("proof check reached");
    }
}

/// Token with no return value from transfer or transferFrom, like Ethereum's USDT.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// An ERC-20 whose moves can be overridden.
contract PlainToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) public virtual returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// transfer() takes twice what it is told to from the sender.
contract OverDebitToken is PlainToken {
    function transfer(address to, uint256 amount) public override returns (bool) {
        balanceOf[msg.sender] -= amount * 2;
        balanceOf[to] += amount;
        return true;
    }
}

/// transfer() tries to re-enter the pool.
contract ReenteringToken is PlainToken {
    ShieldPoolCore2 public pool;
    bytes4 public error;

    function setPool(ShieldPoolCore2 pool_) external {
        pool = pool_;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (address(pool) != address(0)) {
            try pool.collectFees(address(this)) {
                error = bytes4(0xffffffff);
            } catch (bytes memory e) {
                error = bytes4(e);
            }
        }
        return super.transfer(to, amount);
    }
}

/// Takes 1% of every pull, which the pool must refuse.
contract FeeToken is PlainToken {
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - amount / 100;
        return true;
    }
}

/**
 * The next vault's own behaviour, one section per fix from the Kann Audits report
 * of 1 Nov 2026. test/next/*2.t.sol are the live vault's suites ported over. The
 * real proofs are in NextVaultProofs.t.sol. Not deployed, not audited.
 */
contract NextVaultTest is Test {
    using stdJson for string;

    ShieldPoolPayments2 pool;
    InputBoundVerifier boundV;
    MockERC20 usd;
    address poseidon2;

    address owner = address(this);
    address user = address(0x1234);
    address to = address(0xBEEF);
    address treasury = address(0x7EA5);
    address stray = address(0x57A7);

    uint256 constant AMT = 1_000e6;
    uint128 constant PER = 1_000_000e6;
    uint128 constant TOTAL = 10_000_000e6;
    // forge inspect ShieldPoolPayments2 storage-layout
    uint256 constant SPENT_SLOT = 48;
    uint256 constant DEPOSITED_SLOT = 49;
    uint256 constant COMMITMENT_SEEN_SLOT = 50;

    event StrayTokenSwept(address indexed asset, address indexed to, uint256 amount);
    event WithdrawFeeSet(uint16 bps, address indexed recipient);

    function setUp() public {
        vm.warp(1_900_000_000);
        poseidon2 = _deployPoseidon();
        boundV = new InputBoundVerifier();
        pool = new ShieldPoolPayments2(poseidon2, address(boundV), stray);
        pool.setShieldVerifier(address(boundV));
        pool.turnOnDepositLimits();
        usd = new MockERC20();
        pool.setDepositLimit(address(usd), PER, TOTAL);
        pool.setDepositLimit(address(0), 100 ether, 1_000 ether);
        pool.setWithdrawFee(25, treasury);
        usd.mint(user, 100_000_000e6);
        vm.prank(user);
        usd.approve(address(pool), type(uint256).max);
        vm.deal(user, 1_000 ether);
    }

    // ───────────────────────────────────────────────────────────── L-02 the floor

    function test_L02_floor_met_pays_out() public {
        _deposit(address(usd), AMT, 1);
        uint256 net = AMT - AMT / 400;
        _floored(address(usd), AMT, 2, to, net, net);
        assertEq(usd.balanceOf(to), net);
        assertEq(pool.feesOwed(address(usd)), AMT / 400);
        assertEq(pool.deposited(address(usd)), 0);
        assertTrue(pool.isSpent(bytes32(uint256(2))));
    }

    function test_L02_a_raised_fee_reverts_the_cash_out_and_the_note_stays_unspent() public {
        _deposit(address(usd), AMT, 1);
        uint256 net = AMT - AMT / 400; // what 0.25% leaves
        bytes memory proof = _proof(address(usd), AMT, 2, pool.recipientInput(to, net));
        bytes32 root = pool.currentRoot();

        // fee goes to 1% through the timelock while the proof is waiting
        pool.endSetup();
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setWithdrawFee, (100, treasury));
        (, uint256 eta) = pool.queueChange(call_);
        vm.warp(eta);
        pool.executeChange(call_);

        vm.expectRevert(abi.encodeWithSelector(ShieldPoolCore2.BelowMinReceived.selector, AMT - AMT / 100, net));
        pool.unshield(proof, root, bytes32(uint256(2)), address(usd), to, AMT, net);
        assertFalse(pool.isSpent(bytes32(uint256(2))));
        assertEq(pool.deposited(address(usd)), AMT);

        // and when the fee comes back down the same proof still works
        pool.lowerWithdrawFee(25);
        pool.unshield(proof, root, bytes32(uint256(2)), address(usd), to, AMT, net);
        assertEq(usd.balanceOf(to), net);
    }

    function test_L02_the_floor_cannot_be_stripped_or_changed_by_whoever_sends_it() public {
        _deposit(address(usd), AMT, 1);
        uint256 net = AMT - AMT / 400;
        bytes memory proof = _proof(address(usd), AMT, 2, pool.recipientInput(to, net));
        bytes32 root = pool.currentRoot();

        // the plain call: no floor means the plain recipient input, which this proof is not for
        vm.expectRevert(ShieldPoolCore2.InvalidProof.selector);
        pool.unshield(proof, root, bytes32(uint256(2)), address(usd), to, AMT);
        // a lower floor
        vm.expectRevert(ShieldPoolCore2.InvalidProof.selector);
        pool.unshield(proof, root, bytes32(uint256(2)), address(usd), to, AMT, net - 1);
        // no floor through the longer call
        vm.expectRevert(ShieldPoolCore2.InvalidProof.selector);
        pool.unshield(proof, root, bytes32(uint256(2)), address(usd), to, AMT, 0);
        // the hash read as an address, the one way a plain input could match a floored one
        address asAddress = address(uint160(pool.recipientInput(to, net)));
        vm.expectRevert(ShieldPoolCore2.InvalidProof.selector);
        pool.unshield(proof, root, bytes32(uint256(2)), address(usd), asAddress, AMT);
        // another recipient with the same floor
        vm.expectRevert(ShieldPoolCore2.InvalidProof.selector);
        pool.unshield(proof, root, bytes32(uint256(2)), address(usd), address(0xBAD), AMT, net);
        assertFalse(pool.isSpent(bytes32(uint256(2))));
    }

    function test_L02_a_plain_proof_cannot_take_a_floor_it_does_not_commit_to() public {
        _deposit(address(usd), AMT, 1);
        bytes memory proof = _proof(address(usd), AMT, 2, uint256(uint160(to)));
        bytes32 root = pool.currentRoot();
        vm.expectRevert(ShieldPoolCore2.InvalidProof.selector);
        pool.unshield(proof, root, bytes32(uint256(2)), address(usd), to, AMT, 1);
    }

    function test_L02_no_floor_is_the_plain_call() public {
        assertEq(pool.recipientInput(to, 0), uint256(uint160(to)));
        _deposit(address(usd), AMT, 1);
        bytes memory proof = _proof(address(usd), AMT, 2, uint256(uint160(to)));
        bytes32 root = pool.currentRoot();
        uint256 snap = vm.snapshotState();
        pool.unshield(proof, root, bytes32(uint256(2)), address(usd), to, AMT);
        uint256 viaPlain = usd.balanceOf(to);
        vm.revertToState(snap);
        pool.unshield(proof, root, bytes32(uint256(2)), address(usd), to, AMT, 0);
        assertEq(usd.balanceOf(to), viaPlain);
    }

    function test_L02_works_on_native_coin() public {
        _deposit(address(0), 4 ether, 1);
        uint256 net = 4 ether - 0.01 ether;
        _floored(address(0), 4 ether, 2, to, net, net);
        assertEq(to.balance, net);
    }

    function testFuzz_L02_recipient_input_is_a_field_element_and_never_an_address(address who, uint256 floor) public view {
        vm.assume(floor != 0);
        uint256 input = pool.recipientInput(who, floor);
        assertEq(input >> 247, 1, "bit 247 set, nothing above it");
        assertGt(input, type(uint160).max);
        // BN254 scalar field: the verifiers' checkField takes it
        assertLt(input, 21888242871839275222246405745257275088548364400416034343698204186575808495617);
    }

    function testFuzz_L02_floor_is_exact(uint96 rawAmount, uint16 bpsRaw, uint96 floorRaw) public {
        uint256 amount = bound(uint256(rawAmount), 1, PER);
        uint16 bps = uint16(bound(bpsRaw, 0, 100));
        uint256 floor = bound(uint256(floorRaw), 1, amount);
        pool.setWithdrawFee(bps, treasury);
        _deposit(address(usd), amount, 1);
        uint256 fee = (amount / 10_000) * bps + ((amount % 10_000) * bps) / 10_000;
        uint256 net = amount - fee;
        bytes memory proof = _proof(address(usd), amount, 2, pool.recipientInput(to, floor));
        bytes32 root = pool.currentRoot();
        if (net < floor) {
            vm.expectRevert(abi.encodeWithSelector(ShieldPoolCore2.BelowMinReceived.selector, net, floor));
            pool.unshield(proof, root, bytes32(uint256(2)), address(usd), to, amount, floor);
        } else {
            pool.unshield(proof, root, bytes32(uint256(2)), address(usd), to, amount, floor);
            assertEq(usd.balanceOf(to), net);
        }
    }

    // ───────────────────────────────────────────────────────────── I-01 fee off

    function test_I01_turning_the_fee_off_keeps_owed_fees_collectable() public {
        _deposit(address(usd), AMT, 1);
        _plain(address(usd), AMT, 2, to);
        uint256 owed = pool.feesOwed(address(usd));
        assertGt(owed, 0);

        pool.endSetup();
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setWithdrawFee, (0, address(0)));
        (, uint256 eta) = pool.queueChange(call_);
        vm.warp(eta);
        vm.expectEmit(true, true, true, true, address(pool));
        emit WithdrawFeeSet(0, treasury);
        pool.executeChange(call_);

        assertEq(pool.withdrawFeeBps(), 0);
        assertEq(pool.feeRecipient(), treasury, "recipient kept");
        pool.collectFees(address(usd));
        assertEq(usd.balanceOf(treasury), owed);
    }

    function test_I01_fee_off_takes_no_fee_and_a_new_recipient_still_replaces_the_old() public {
        pool.setWithdrawFee(0, address(0));
        _deposit(address(usd), AMT, 1);
        _plain(address(usd), AMT, 2, to);
        assertEq(usd.balanceOf(to), AMT);
        assertEq(pool.feesOwed(address(usd)), 0);

        pool.setWithdrawFee(0, address(0xCAFE));
        assertEq(pool.feeRecipient(), address(0xCAFE));
    }

    function test_I01_a_pool_with_no_recipient_stays_without_one() public {
        ShieldPoolPayments2 fresh = new ShieldPoolPayments2(poseidon2, address(boundV), stray);
        fresh.setWithdrawFee(0, address(0));
        assertEq(fresh.feeRecipient(), address(0));
        vm.expectRevert(ShieldPoolCore2.ZeroAddress.selector);
        fresh.setWithdrawFee(25, address(0));
    }

    // ───────────────────────────────────────────────────────────── I-03 paying the pool

    function test_I03_cash_out_to_the_pool_is_refused_on_both_calls() public {
        _deposit(address(usd), AMT, 1);
        bytes32 root = pool.currentRoot();
        bytes memory proof = _proof(address(usd), AMT, 2, uint256(uint160(address(pool))));
        vm.expectRevert(ShieldPoolCore2.RecipientIsPool.selector);
        pool.unshield(proof, root, bytes32(uint256(2)), address(usd), address(pool), AMT);
        vm.expectRevert(ShieldPoolCore2.RecipientIsPool.selector);
        pool.unshield(proof, root, bytes32(uint256(2)), address(usd), address(pool), AMT, 1);
        assertFalse(pool.isSpent(bytes32(uint256(2))));
        assertEq(pool.deposited(address(usd)), AMT);
    }

    function test_I03_native_cash_out_to_the_pool_is_refused() public {
        _deposit(address(0), 1 ether, 1);
        bytes32 root = pool.currentRoot();
        vm.expectRevert(ShieldPoolCore2.RecipientIsPool.selector);
        pool.unshield("", root, bytes32(uint256(2)), address(0), address(pool), 1 ether);
    }

    // ───────────────────────────────────────────────────────────── I-04 shield verifier

    function test_I04_shield_verifier_is_gone_from_the_timelock() public {
        pool.endSetup();
        vm.expectRevert(ChangeTimelock.UnknownChange.selector);
        pool.queueChange(abi.encodeCall(ShieldPoolCore2.setShieldVerifier, (address(boundV))));
        vm.expectRevert(ChangeTimelock.TimelockRequired.selector);
        pool.setShieldVerifier(address(boundV));
    }

    function test_I04_the_other_setters_stay_in_the_timelock() public {
        pool.endSetup();
        pool.queueChange(abi.encodeCall(ShieldPoolCore2.setVerifier, (address(boundV))));
        pool.queueChange(abi.encodeCall(ShieldPoolCore2.setDepositLimit, (address(usd), 1, 1)));
        pool.queueChange(abi.encodeCall(ShieldPoolCore2.setWithdrawFee, (1, treasury)));
    }

    function test_I04_a_call_queued_by_hand_cannot_reach_it() public {
        // queue refuses the selector, so executeChange has nothing to run
        pool.endSetup();
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setShieldVerifier, (address(boundV)));
        vm.expectRevert(ChangeTimelock.ChangeNotQueued.selector);
        pool.executeChange(call_);
    }

    function test_I04_still_one_way_in_setup() public {
        address other = address(new InputBoundVerifier());
        vm.expectRevert(ShieldPoolCore2.ShieldVerifierAlreadySet.selector);
        pool.setShieldVerifier(other);
    }

    // ───────────────────────────────────────────────────────────── I-05 cheap checks first

    function _noProofChecks() internal returns (ShieldPoolPayments2 p, address never) {
        never = address(new NeverCalledVerifier());
        p = new ShieldPoolPayments2(poseidon2, never, stray);
        p.setShieldVerifier(never);
        p.turnOnDepositLimits();
        p.setDepositLimit(address(usd), PER, TOTAL);
        p.setDepositLimit(address(0), PER, TOTAL);
        vm.prank(user);
        usd.approve(address(p), type(uint256).max);
    }

    function test_I05_a_deposit_that_cannot_land_never_reaches_the_proof() public {
        (ShieldPoolPayments2 p, ) = _noProofChecks();
        bytes32 c = bytes32(uint256(7));
        vm.startPrank(user);
        vm.expectRevert(ShieldPoolCore2.ZeroCommitment.selector);
        p.shieldBound(address(usd), AMT, bytes32(0), "");
        vm.expectRevert(ShieldPoolCore2.InvalidAmount.selector);
        p.shieldBound(address(usd), 0, c, "");
        vm.expectRevert(ShieldPoolCore2.OverDepositLimit.selector);
        p.shieldBound(address(usd), uint256(PER) + 1, c, "");
        vm.expectRevert(ShieldPoolCore2.OverDepositLimit.selector);
        p.shieldBound(address(0xDEAD), AMT, c, ""); // unlisted
        vm.expectRevert(ShieldPoolCore2.InvalidMsgValue.selector);
        p.shieldBound{value: 1}(address(usd), AMT, c, "");
        vm.expectRevert(ShieldPoolCore2.InvalidMsgValue.selector);
        p.shieldBound{value: 1}(address(0), AMT, c, "");
        vm.stopPrank();
    }

    function test_I05_a_seen_commitment_and_a_codeless_asset_never_reach_the_proof() public {
        (ShieldPoolPayments2 p, ) = _noProofChecks();
        // limits off here, so the limit check does not stop the codeless case first
        ShieldPoolPayments2 q = new ShieldPoolPayments2(poseidon2, address(new NeverCalledVerifier()), stray);
        q.setShieldVerifier(address(new NeverCalledVerifier()));
        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.NotAContract.selector);
        q.shieldBound(address(0xDEAD), AMT, bytes32(uint256(7)), "");

        // a seen commitment: mark one seen by storage so no proof is ever needed
        bytes32 c = bytes32(uint256(7));
        vm.store(address(p), keccak256(abi.encode(c, COMMITMENT_SEEN_SLOT)), bytes32(uint256(1)));
        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.DuplicateCommitment.selector);
        p.shieldBound(address(usd), AMT, c, "");
    }

    function test_I05_a_send_that_cannot_land_never_reaches_the_proof() public {
        (ShieldPoolPayments2 p, ) = _noProofChecks();
        bytes32 root = p.currentRoot();
        bytes32 n = bytes32(uint256(3));
        bytes32 seen = bytes32(uint256(7));
        vm.store(address(p), keccak256(abi.encode(seen, COMMITMENT_SEEN_SLOT)), bytes32(uint256(1)));

        vm.expectRevert(ShieldPoolCore2.ZeroCommitment.selector);
        p.transfer("", root, n, [bytes32(0), bytes32(uint256(1))]);
        vm.expectRevert(ShieldPoolCore2.ZeroCommitment.selector);
        p.transfer("", root, n, [bytes32(uint256(1)), bytes32(0)]);
        vm.expectRevert(ShieldPoolCore2.DuplicateCommitment.selector);
        p.transfer("", root, n, [bytes32(uint256(1)), bytes32(uint256(1))]);
        vm.expectRevert(ShieldPoolCore2.DuplicateCommitment.selector);
        p.transfer("", root, n, [seen, bytes32(uint256(1))]);
        vm.expectRevert(ShieldPoolCore2.DuplicateCommitment.selector);
        p.transfer("", root, n, [bytes32(uint256(1)), seen]);

        vm.store(address(p), keccak256(abi.encode(n, SPENT_SLOT)), bytes32(uint256(1)));
        vm.expectRevert(ShieldPoolCore2.AlreadySpent.selector);
        p.transfer("", root, n, [bytes32(uint256(1)), bytes32(uint256(2))]);
    }

    function test_I05_a_cash_out_that_cannot_land_never_reaches_the_proof() public {
        (ShieldPoolPayments2 p, ) = _noProofChecks();
        bytes32 root = p.currentRoot();
        bytes32 n = bytes32(uint256(3));
        vm.expectRevert(ShieldPoolCore2.ZeroAddress.selector);
        p.unshield("", root, n, address(usd), address(0), AMT);
        vm.expectRevert(ShieldPoolCore2.RecipientIsPool.selector);
        p.unshield("", root, n, address(usd), address(p), AMT);
        vm.expectRevert(ShieldPoolCore2.InvalidAmount.selector);
        p.unshield("", root, n, address(usd), to, 0);
        vm.expectRevert(ShieldPoolCore2.InsufficientPoolBalance.selector);
        p.unshield("", root, n, address(usd), to, AMT); // more than the pool holds for the asset
    }

    function test_I05_a_floor_too_high_and_an_unknown_root_never_reach_the_proof() public {
        (ShieldPoolPayments2 p, ) = _noProofChecks();
        // back a note by storage: the never-called verifier cannot take a deposit
        vm.store(address(p), keccak256(abi.encode(address(usd), DEPOSITED_SLOT)), bytes32(AMT));
        bytes32 root = p.currentRoot();
        bytes32 n = bytes32(uint256(3));
        vm.expectRevert(abi.encodeWithSelector(ShieldPoolCore2.BelowMinReceived.selector, AMT, AMT + 1));
        p.unshield("", root, n, address(usd), to, AMT, AMT + 1);
        vm.expectRevert(ShieldPoolCore2.UnknownRoot.selector);
        p.unshield("", bytes32(uint256(99)), n, address(usd), to, AMT);
        vm.store(address(p), keccak256(abi.encode(n, SPENT_SLOT)), bytes32(uint256(1)));
        vm.expectRevert(ShieldPoolCore2.AlreadySpent.selector);
        p.unshield("", root, n, address(usd), to, AMT);
    }

    function test_I05_a_bad_proof_changes_nothing() public {
        _deposit(address(usd), AMT, 1);
        bytes32 root = pool.currentRoot();
        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.InvalidProof.selector);
        pool.shieldBound(address(usd), AMT, bytes32(uint256(9)), "bad");
        assertFalse(pool.commitmentSeen(bytes32(uint256(9))));
        vm.expectRevert(ShieldPoolCore2.InvalidProof.selector);
        pool.transfer("bad", root, bytes32(uint256(2)), [bytes32(uint256(5)), bytes32(uint256(6))]);
        assertFalse(pool.isSpent(bytes32(uint256(2))));
        assertFalse(pool.commitmentSeen(bytes32(uint256(5))));
        vm.expectRevert(ShieldPoolCore2.InvalidProof.selector);
        pool.unshield("bad", root, bytes32(uint256(2)), address(usd), to, AMT);
        assertFalse(pool.isSpent(bytes32(uint256(2))));
        assertEq(pool.deposited(address(usd)), AMT);
        assertEq(pool.nextIndex(), 1);
    }

    function test_I05_deposit_still_refuses_a_fee_on_transfer_token_after_the_proof() public {
        FeeToken t = new FeeToken();
        pool.setDepositLimit(address(t), PER, TOTAL);
        t.mint(user, AMT);
        vm.prank(user);
        t.approve(address(pool), AMT);
        bytes32 c = bytes32(uint256(7));
        bytes memory proof = _depositProof(address(t), AMT, c);
        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.FeeOnTransferNotSupported.selector);
        pool.shieldBound(address(t), AMT, c, proof);
    }

    // ───────────────────────────────────────────────────────────── I-06 the tree

    function testFuzz_I06_same_roots_as_the_live_tree(uint256 seed) public {
        ShieldPoolPayments live = new ShieldPoolPayments(poseidon2, address(boundV));
        live.setShieldVerifier(address(boundV));
        ShieldPoolPayments2 next = new ShieldPoolPayments2(poseidon2, address(boundV), stray);
        next.setShieldVerifier(address(boundV));
        assertEq(live.currentRoot(), next.currentRoot(), "empty roots");
        vm.deal(address(this), 10 ether);
        for (uint256 i = 0; i < 12; i++) {
            bytes32 c = bytes32(uint256(keccak256(abi.encode(seed, i))) >> 8);
            bytes memory proof = _depositProof(address(0), 1, c);
            live.shieldBound{value: 1}(address(0), 1, c, proof);
            next.shieldBound{value: 1}(address(0), 1, c, proof);
            assertEq(live.currentRoot(), next.currentRoot(), "root");
            assertTrue(next.isKnownRoot(live.currentRoot()));
            assertEq(live.nextIndex(), next.nextIndex());
        }
    }

    function test_I06_old_roots_stay_good_past_the_old_ring_size() public {
        vm.deal(address(this), 1 ether);
        bytes32 first = pool.currentRoot();
        for (uint256 i = 1; i <= 105; i++) {
            bytes32 c = bytes32(i);
            pool.shieldBound{value: 1}(address(0), 1, c, _depositProof(address(0), 1, c));
        }
        assertTrue(pool.isKnownRoot(first));
        assertFalse(pool.isKnownRoot(bytes32(0)));
        assertEq(pool.nextIndex(), 105);
    }

    // ───────────────────────────────────────────────────────────── I-07 verifiers

    function test_I07_dual_verifier_needs_two_contracts() public {
        IVerifier v = IVerifier(address(boundV));
        vm.expectRevert(DualProofVerifier2.NotAContract.selector);
        new DualProofVerifier2(IVerifier(address(0)), v);
        vm.expectRevert(DualProofVerifier2.NotAContract.selector);
        new DualProofVerifier2(v, IVerifier(address(0)));
        vm.expectRevert(DualProofVerifier2.NotAContract.selector);
        new DualProofVerifier2(IVerifier(address(0xDEAD)), v);
        vm.expectRevert(DualProofVerifier2.NotAContract.selector);
        new DualProofVerifier2(v, IVerifier(address(0xDEAD)));
        DualProofVerifier2 d = new DualProofVerifier2(v, v);
        assertEq(address(d.unshieldVerifier()), address(v));
        assertEq(address(d.transferVerifier()), address(v));
    }

    function test_I07_dual_verifier_routes_as_before() public {
        InputBoundVerifier u = new InputBoundVerifier();
        NeverCalledVerifier t = new NeverCalledVerifier();
        DualProofVerifier2 d = new DualProofVerifier2(u, t);
        uint256[] memory five = new uint256[](5);
        assertTrue(d.verify(abi.encode(keccak256(abi.encode(five))), five));
        vm.expectRevert(bytes("proof check reached"));
        d.verify("", new uint256[](4));
        assertFalse(d.verify("", new uint256[](3)));
        assertFalse(d.verify("", new uint256[](6)));
    }

    function test_I07_pool_constructor_checks() public {
        vm.expectRevert(ShieldPoolCore2.ZeroAddress.selector);
        new ShieldPoolPayments2(address(0), address(boundV), stray);
        vm.expectRevert(ShieldPoolCore2.NotAContract.selector);
        new ShieldPoolPayments2(address(0xDEAD), address(boundV), stray);
        vm.expectRevert(ShieldPoolCore2.NotAContract.selector);
        new ShieldPoolPayments2(poseidon2, address(0xDEAD), stray);
        // no verifier yet is fine: endSetup refuses until both are wired
        ShieldPoolPayments2 p = new ShieldPoolPayments2(poseidon2, address(0), stray);
        assertEq(address(p.verifier()), address(0));
    }

    function test_I07_setters_refuse_no_code() public {
        ShieldPoolPayments2 p = new ShieldPoolPayments2(poseidon2, address(0), stray);
        vm.expectRevert(ShieldPoolCore2.NotAContract.selector);
        p.setVerifier(address(0));
        vm.expectRevert(ShieldPoolCore2.NotAContract.selector);
        p.setVerifier(address(0xDEAD));
        vm.expectRevert(ShieldPoolCore2.ZeroAddress.selector);
        p.setShieldVerifier(address(0));
        vm.expectRevert(ShieldPoolCore2.NotAContract.selector);
        p.setShieldVerifier(address(0xDEAD));
    }

    function test_I07_a_queued_verifier_with_no_code_cannot_land() public {
        pool.endSetup();
        address spend = address(pool.verifier());
        for (uint256 i = 0; i < 2; i++) {
            bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setVerifier, (i == 0 ? address(0) : address(0xDEAD)));
            (, uint256 eta) = pool.queueChange(call_);
            vm.warp(eta);
            vm.expectRevert(ShieldPoolCore2.NotAContract.selector);
            pool.executeChange(call_);
        }
        assertEq(address(pool.verifier()), spend);
    }

    // ───────────────────────────────────────────────────────────── I-08 the sweep

    function test_I08_moves_only_the_surplus_to_the_fixed_address() public {
        _deposit(address(usd), AMT, 1);
        _deposit(address(usd), AMT, 3);
        _plain(address(usd), AMT, 4, to); // leaves one note and an owed fee
        uint256 owed = pool.feesOwed(address(usd));
        usd.mint(address(pool), 123e6);

        vm.expectEmit(true, true, true, true, address(pool));
        emit StrayTokenSwept(address(usd), stray, 123e6);
        pool.sweepStrayToken(address(usd));

        assertEq(usd.balanceOf(stray), 123e6);
        assertEq(usd.balanceOf(address(pool)), AMT + owed);
        assertEq(pool.deposited(address(usd)), AMT);
        assertEq(pool.feesOwed(address(usd)), owed);

        // notes and fees still come out in full
        _plain(address(usd), AMT, 2, to);
        pool.collectFees(address(usd));
        assertEq(usd.balanceOf(address(pool)), 0);
    }

    function test_I08_nothing_to_take() public {
        _deposit(address(usd), AMT, 1);
        vm.expectRevert(ShieldPoolCore2.NothingToSweep.selector);
        pool.sweepStrayToken(address(usd));
        MockERC20 other = new MockERC20();
        vm.expectRevert(ShieldPoolCore2.NothingToSweep.selector);
        pool.sweepStrayToken(address(other));
    }

    function test_I08_an_unlisted_token_moves_in_full() public {
        MockERC20 other = new MockERC20();
        other.mint(address(pool), 5e18);
        pool.sweepStrayToken(address(other));
        assertEq(other.balanceOf(stray), 5e18);
    }

    function test_I08_owner_only_and_after_setup_too() public {
        usd.mint(address(pool), 1);
        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        pool.sweepStrayToken(address(usd));
        pool.endSetup();
        pool.sweepStrayToken(address(usd));
        assertEq(usd.balanceOf(stray), 1);
    }

    function test_I08_refuses_the_native_coin_and_codeless_tokens() public {
        vm.deal(address(pool), 1 ether);
        vm.expectRevert(ShieldPoolCore2.NotAContract.selector);
        pool.sweepStrayToken(address(0));
        vm.expectRevert(ShieldPoolCore2.NotAContract.selector);
        pool.sweepStrayToken(address(0xDEAD));
    }

    function test_I08_no_way_to_choose_the_destination() public {
        (bool ok, ) = address(pool).call(abi.encodeWithSignature("sweepStrayToken(address,address)", address(usd), user));
        assertFalse(ok);
        assertEq(pool.strayRecipient(), stray);
        vm.expectRevert(ShieldPoolCore2.ZeroAddress.selector);
        new ShieldPoolPayments2(poseidon2, address(boundV), address(0));
        // not in the timelock
        pool.endSetup();
        vm.expectRevert(ChangeTimelock.UnknownChange.selector);
        pool.queueChange(abi.encodeCall(ShieldPoolCore2.sweepStrayToken, (address(usd))));
    }

    function test_I08_tokens_that_return_nothing() public {
        NoReturnToken t = new NoReturnToken();
        t.mint(address(pool), 77);
        pool.sweepStrayToken(address(t));
        assertEq(t.balanceOf(stray), 77);
    }

    function test_I08_a_token_that_takes_too_much_cannot_eat_the_notes() public {
        OverDebitToken t = new OverDebitToken();
        pool.setDepositLimit(address(t), PER, TOTAL);
        t.mint(user, AMT);
        vm.prank(user);
        t.approve(address(pool), AMT);
        bytes32 c = bytes32(uint256(7));
        bytes memory proof = _depositProof(address(t), AMT, c);
        vm.prank(user);
        pool.shieldBound(address(t), AMT, c, proof);
        t.mint(address(pool), 10);
        vm.expectRevert(ShieldPoolCore2.InsufficientPoolBalance.selector);
        pool.sweepStrayToken(address(t));
    }

    function test_I08_reentry_is_refused() public {
        ReenteringToken t = new ReenteringToken();
        t.mint(address(pool), 10);
        t.setPool(pool);
        pool.sweepStrayToken(address(t));
        assertEq(t.error(), ShieldPoolCore2.Reentrancy.selector);
        assertEq(t.balanceOf(stray), 10);
    }

    function test_I08_sweep_does_not_touch_native_rules() public {
        vm.deal(address(pool), 1 ether);
        pool.sweepStrayNative(user);
        assertEq(address(pool).balance, 0);
    }

    function testFuzz_I08_never_goes_below_what_backs_notes_and_fees(
        uint64 depositA,
        uint64 depositB,
        uint64 donation,
        uint16 bpsRaw
    ) public {
        uint256 a = bound(uint256(depositA), 1, PER);
        uint256 b = bound(uint256(depositB), 1, PER);
        uint16 bps = uint16(bound(bpsRaw, 0, 100));
        pool.setWithdrawFee(bps, treasury);
        _deposit(address(usd), a, 1);
        _deposit(address(usd), b, 3);
        _plain(address(usd), a, 2, to);
        usd.mint(address(pool), donation);
        uint256 backed = pool.deposited(address(usd)) + pool.feesOwed(address(usd));
        assertEq(usd.balanceOf(address(pool)), backed + donation);
        if (donation == 0) {
            vm.expectRevert(ShieldPoolCore2.NothingToSweep.selector);
            pool.sweepStrayToken(address(usd));
        } else {
            pool.sweepStrayToken(address(usd));
            assertEq(usd.balanceOf(address(pool)), backed);
            assertEq(usd.balanceOf(stray), donation);
        }
    }

    // ───────────────────────────────────────────────────────────── the ABI apps use

    function test_abi_the_plain_cash_out_keeps_its_selector() public view {
        assertEq(
            bytes4(keccak256("unshield(bytes,bytes32,bytes32,address,address,uint256)")),
            IShieldPool.unshield.selector
        );
        assertEq(IShieldPool.unshield.selector, bytes4(0x67cca6c5));
        assertEq(pool.PROOF_LAYOUT_VERSION(), 2);
    }

    // ───────────────────────────────────────────────────────────── helpers

    function _inputsProof(uint256[] memory inputs) internal pure returns (bytes memory) {
        return abi.encode(keccak256(abi.encode(inputs)));
    }

    function _depositProof(address asset, uint256 amount, bytes32 commitment) internal pure returns (bytes memory) {
        uint256[] memory inputs = new uint256[](3);
        inputs[0] = uint256(commitment);
        inputs[1] = amount;
        inputs[2] = uint256(uint160(asset));
        return _inputsProof(inputs);
    }

    function _proof(address asset, uint256 amount, uint256 nullifier, uint256 recipient) internal view returns (bytes memory) {
        uint256[] memory inputs = new uint256[](5);
        inputs[0] = uint256(pool.currentRoot());
        inputs[1] = nullifier;
        inputs[2] = uint256(uint160(asset));
        inputs[3] = amount;
        inputs[4] = recipient;
        return _inputsProof(inputs);
    }

    function _deposit(address asset, uint256 amount, uint256 commitment) internal {
        bytes32 c = bytes32(commitment);
        bytes memory proof = _depositProof(asset, amount, c);
        vm.prank(user);
        pool.shieldBound{value: asset == address(0) ? amount : 0}(asset, amount, c, proof);
    }

    function _plain(address asset, uint256 amount, uint256 nullifier, address who) internal {
        bytes memory proof = _proof(asset, amount, nullifier, uint256(uint160(who)));
        pool.unshield(proof, pool.currentRoot(), bytes32(nullifier), asset, who, amount);
    }

    function _floored(address asset, uint256 amount, uint256 nullifier, address who, uint256 floor, uint256 expectNet) internal {
        bytes memory proof = _proof(asset, amount, nullifier, pool.recipientInput(who, floor));
        uint256 before = asset == address(0) ? who.balance : MockERC20(asset).balanceOf(who);
        pool.unshield(proof, pool.currentRoot(), bytes32(nullifier), asset, who, amount, floor);
        uint256 got = (asset == address(0) ? who.balance : MockERC20(asset).balanceOf(who)) - before;
        assertEq(got, expectNet);
    }

    function _deployPoseidon() internal returns (address addr) {
        string memory json = vm.readFile("test/fixtures/Poseidon2.json");
        bytes memory bytecode = json.readBytes(".bytecode");
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "poseidon");
    }
}
