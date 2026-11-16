// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {GloamPayMemo} from "../src/GloamPayMemo.sol";
import {ShieldPoolPayments} from "../src/ShieldPoolPayments.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {MockERC20} from "./MockERC20.sol";

contract MemoAcceptVerifier is IVerifier {
    function verify(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return true;
    }
}

/**
 * The payment-memo board is an open, ownerless log. Anyone can post any memo
 * under any commitment, up to MAX_MEMO bytes, and nothing is ever removed.
 * The relay's tighter caps (RELAY_MEMO_MAX_BYTES and its per-sender, per-payment
 * and per-IP limits) apply only to memos it posts; a direct post skips them.
 * A memo moves no value and changes no vault state: a client counts a payment
 * only when the memo's secret opens the commitment and the note is in the
 * vault and unspent (see SECURITY.md, "Payment-memo board").
 */
contract MemoBoardTest is Test {
    using stdJson for string;

    GloamPayMemo board;
    ShieldPoolPayments pool;
    MockERC20 usd;

    address payer = address(0xA11);
    address stranger = address(0xB0B);

    bytes32 constant PAYMENT_NOTE = keccak256("payment note");
    bytes32 constant CHANGE_NOTE = keccak256("change note");
    bytes32 constant MEMO_TOPIC = keccak256("PaymentMemo(bytes32,bytes)");

    function setUp() public {
        board = new GloamPayMemo();
        MemoAcceptVerifier acceptV = new MemoAcceptVerifier();
        pool = new ShieldPoolPayments(_deployPoseidon(), address(acceptV));
        usd = new MockERC20();
        pool.turnOnDepositLimits();
        pool.setShieldVerifier(address(acceptV));
        pool.setDepositLimit(address(usd), 1_000_000e6, 100_000_000e6);
        pool.endSetup();

        usd.mint(payer, 100e6);
        vm.startPrank(payer);
        usd.approve(address(pool), type(uint256).max);
        pool.shieldBound(address(usd), 100e6, bytes32(uint256(7)), "");
        bytes32 root = pool.currentRoot();
        pool.transfer(hex"00", root, bytes32(uint256(1)), [PAYMENT_NOTE, CHANGE_NOTE]);
        vm.stopPrank();
    }

    function test_anyone_posts_under_any_commitment() public {
        uint256 depositedBefore = pool.deposited(address(usd));
        bytes32 rootBefore = pool.currentRoot();
        uint256 leavesBefore = pool.nextIndex();

        // One memo at the board's limit, from an address that took no part in the payment.
        bytes memory big = new bytes(board.MAX_MEMO());
        vm.prank(stranger);
        uint256 g = gasleft();
        board.postMemo(PAYMENT_NOTE, big);
        uint256 used = g - gasleft();
        emit log_named_uint("gas for one MAX_MEMO post (call only)", used);

        // Fifty more from fifty addresses, all under the same payment.
        vm.recordLogs();
        for (uint256 i = 1; i <= 50; i++) {
            vm.prank(address(uint160(0x10000 + i)));
            board.postMemo(PAYMENT_NOTE, abi.encodePacked("gloam2t.not-a-real-ticket-", i));
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(board) && logs[i].topics[0] == MEMO_TOPIC && logs[i].topics[1] == PAYMENT_NOTE) n++;
        }
        assertEq(n, 50, "fifty memos logged under the one commitment");

        // The vault is untouched: a memo is only a hint, never a payment.
        assertEq(pool.deposited(address(usd)), depositedBefore);
        assertEq(pool.currentRoot(), rootBefore);
        assertEq(pool.nextIndex(), leavesBefore);
    }

    function test_board_bounds() public {
        assertEq(board.MAX_MEMO(), 8192);
        vm.expectRevert(GloamPayMemo.ZeroCommitment.selector);
        board.postMemo(bytes32(0), hex"01");
        vm.expectRevert(GloamPayMemo.BadMemo.selector);
        board.postMemo(PAYMENT_NOTE, "");
        bytes memory over = new bytes(board.MAX_MEMO() + 1);
        vm.expectRevert(GloamPayMemo.BadMemo.selector);
        board.postMemo(PAYMENT_NOTE, over);
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
