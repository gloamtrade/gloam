// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Ported from test/VaultSwapReview.t.sol to the next vault (not deployed, not audited).
// Keep the two in step until the live vaults are retired.

// The independent review of the vault swap (2026-10-22), as tests of the fixed behaviour.

import {STRAY} from "./NextHarness.sol";
import {ShieldPoolCore2} from "../../src/ShieldPoolCore2.sol";
import {GloamVaultSwap} from "../../src/GloamVaultSwap.sol";
import {SwapEscrow} from "../../src/SwapEscrow.sol";
import {VaultSwapTestNext} from "./VaultSwap2.t.sol";

/// A token whose issuer can block an address from receiving (USDG, USDC.e and TIP-403 tokens can).
contract FreezeToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public frozen;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function freeze(address who, bool on) external {
        frozen[who] = on;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        require(!frozen[to], "frozen");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        require(!frozen[to], "frozen");
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

contract VaultSwapReviewTestNext is VaultSwapTestNext {
    address outsider = address(0xBAD0);

    /// The app works escrow addresses out from this (lib/vaultSwap SWAP_ESCROW_INIT_CODE):
    /// a change here must change the app too.
    bytes32 constant ESCROW_CODE_HASH = 0x192133b7cb5a5193a55ec981c9f7272702248f684d2b85aa1dd843dde9b85bd4;

    function _escrow(Call memory k) internal pure returns (address) {
        return abi.decode(k.s.proof, (address));
    }

    // ───────────────────────────── the escrow address the app works out

    function test_escrow_creation_code_is_pinned() public pure {
        assertEq(keccak256(type(SwapEscrow).creationCode), ESCROW_CODE_HASH);
    }

    function test_escrow_address_is_create2_of_the_key() public view {
        GloamVaultSwap.EscrowKey memory key = GloamVaultSwap.EscrowKey(
            bytes32(uint256(1)), NOTE, bytes32(uint256(2)), address(gloam), 39e18, bytes32(uint256(3)), 99e6, keccak256("r")
        );
        bytes32 codeHash = keccak256(abi.encodePacked(type(SwapEscrow).creationCode, abi.encode(address(usd))));
        address want = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(router), keccak256(abi.encode(key)), codeHash))))
        );
        assertEq(router.escrowFor(address(usd), key), want);
    }

    /// F-6: two notes never share an escrow, even with the same new note, refund note and route.
    function test_escrow_differs_per_note() public view {
        Call memory a = _call(router, 601, address(gloam), 39e18, 0xE1, _route1(direct));
        Call memory b = _call(router, 602, address(gloam), 39e18, 0xE1, _route1(direct));
        assertTrue(_escrow(a) != _escrow(b), "another nullifier, another escrow");
        Call memory c = _callFrom(router, 601, address(usd), NOTE - 1, address(gloam), 39e18, 0xE1, _route1(direct));
        // same nullifier, other amount (and so another refund amount): another escrow too
        assertTrue(_escrow(a) != _escrow(c));
    }

    // ───────────────────────────── F-1: what a reverted receipt can hide (the app keeps both notes)

    /// Someone who sees the relay's pending transaction sends the identical call first: it does
    /// the owner's swap, and the relay's own transaction reverts. The new note is in the vault.
    function test_review_F1_copied_call_lands_first_and_the_relay_tx_reverts() public {
        Call memory k = _call(router, 501, address(gloam), 39e18, 0xF1, _route1(direct));
        vm.prank(outsider);
        router.swap(k.s, k.d, k.r, k.route);
        vm.prank(relayer);
        vm.expectRevert(GloamVaultSwap.BadRefund.selector);
        router.swap(k.s, k.d, k.r, k.route);
        assertTrue(pool.isSpent(k.s.nullifier));
        assertTrue(pool.commitmentSeen(k.d.commitment), "the owner's new note landed");
    }

    /// The relay's swap reverts (the price moved) and its calldata stays valid: an outsider lands
    /// the unshield alone and calls the router with the same args. The value is the refund note.
    function test_review_F1_reverted_swap_lands_later_as_the_refund() public {
        Call memory k = _call(router, 502, address(gloam), 41e18, 0xF2, _route1(direct));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwap.OverInput.selector, 102_500_000, ARRIVES));
        router.swap(k.s, k.d, k.r, k.route);
        assertFalse(pool.isSpent(k.s.nullifier));

        vm.startPrank(outsider);
        pool.unshield(k.s.proof, k.s.root, k.s.nullifier, k.s.asset, _escrow(k), k.s.amount);
        router.swap(k.s, k.d, k.r, k.route);
        vm.stopPrank();
        assertTrue(pool.commitmentSeen(k.r.commitment), "the value sits in the owner's refund note");
        assertEq(usd.balanceOf(treasury), ARRIVES - k.r.amount);
    }

    /// The same calldata replayed as is once the price comes back: the new note lands.
    function test_review_F1_reverted_swap_replayed_when_the_price_comes_back() public {
        Call memory k = _call(router, 503, address(gloam), 41e18, 0xF3, _route1(direct));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwap.OverInput.selector, 102_500_000, ARRIVES));
        router.swap(k.s, k.d, k.r, k.route);
        _rate(direct, address(usd), 24, 10 ** 13); // 41 gloam now costs 98.4
        vm.prank(outsider);
        router.swap(k.s, k.d, k.r, k.route);
        assertTrue(pool.commitmentSeen(k.d.commitment));
    }

    // ───────────────────────────── F-2: spent and unseen is not dead for a swap

    /// After an unshield sent alone the note is spent and neither new note is in the vault,
    /// yet the whole value waits at the escrow and the same call brings it back.
    function test_review_F2_spent_and_unseen_is_waiting() public {
        Call memory k = _call(router, 507, address(gloam), 39e18, 0xF7, _route1(direct));
        pool.unshield(k.s.proof, k.s.root, k.s.nullifier, k.s.asset, _escrow(k), k.s.amount);
        assertTrue(pool.isSpent(k.s.nullifier));
        assertFalse(pool.commitmentSeen(k.d.commitment));
        assertFalse(pool.commitmentSeen(k.r.commitment));
        assertEq(usd.balanceOf(_escrow(k)), ARRIVES, "the money is waiting, not gone");
        router.swap(k.s, k.d, k.r, k.route);
        assertTrue(pool.commitmentSeen(k.r.commitment));
    }

    /// The finishing call needs only the refund note's proof: the spend's proof and root and the
    /// new note's proof are not read on that path (the app sends placeholders).
    function test_review_F2_refund_needs_only_the_refund_proof() public {
        Call memory k = _call(router, 508, address(gloam), 39e18, 0xF8, _route1(direct));
        pool.unshield(k.s.proof, k.s.root, k.s.nullifier, k.s.asset, _escrow(k), k.s.amount);
        GloamVaultSwap.Spend memory s = k.s;
        s.proof = new bytes(64);
        s.root = bytes32(0);
        GloamVaultSwap.Deposit memory d = k.d;
        d.proof = new bytes(64);
        router.swap(s, d, k.r, k.route);
        assertTrue(pool.commitmentSeen(k.r.commitment));
    }

    // ───────────────────────────── refund math: exact for every fee the vault allows

    function testFuzz_review_refund_never_exceeds_what_arrives(uint128 amount, uint16 bps) public pure {
        bps = uint16(bound(bps, 0, 100)); // MAX_WITHDRAW_FEE_BPS
        uint256 a = amount;
        uint256 fee = (a / 10_000) * bps + ((a % 10_000) * bps) / 10_000; // ShieldPoolCore2._withdrawFee
        uint256 refund = a - a / 100; // lib/vaultSwap refundAmountFor
        assertGe(a - fee, refund);
    }

    function test_review_refund_at_the_fee_ceiling_is_exact() public {
        pool.setWithdrawFee(100, feeTo);
        Call memory k = _call(router, 504, address(gloam), 39e18, 0xF4, _route1(direct));
        pool.unshield(k.s.proof, k.s.root, k.s.nullifier, k.s.asset, _escrow(k), k.s.amount);
        assertEq(usd.balanceOf(_escrow(k)), k.r.amount);
        router.swap(k.s, k.d, k.r, k.route);
        assertTrue(pool.commitmentSeen(k.r.commitment));
        assertEq(usd.balanceOf(treasury), 0);
    }

    // ───────────────────────────── refund liveness

    /// A full deposit cap holds a refund back; the money waits at the escrow until there is room.
    function test_review_refund_waits_while_the_cap_is_full() public {
        Call memory k = _call(router, 505, address(gloam), 39e18, 0xF5, _route1(direct));
        pool.unshield(k.s.proof, k.s.root, k.s.nullifier, k.s.asset, _escrow(k), k.s.amount);
        vm.startPrank(depositor);
        for (uint256 i = 0; i < 49; i++) pool.shieldBound(address(usd), 500e6, bytes32(uint256(0xCA90 + i)), hex"00");
        pool.shieldBound(address(usd), 120e6, bytes32(uint256(0xCAFF)), hex"00");
        vm.stopPrank();

        vm.expectRevert(ShieldPoolCore2.OverDepositLimit.selector);
        router.swap(k.s, k.d, k.r, k.route);
        assertEq(usd.balanceOf(_escrow(k)), ARRIVES, "waits at the escrow");

        pool.setDepositLimit(address(usd), 500e6, 30_000e6);
        router.swap(k.s, k.d, k.r, k.route);
        assertTrue(pool.commitmentSeen(k.r.commitment));
    }

    /// F-3: a treasury the issuer blocks no longer stops a refund. The margin it could not take
    /// stays in the router, and the next swap of that token measures only its own money.
    function test_review_F3_refund_lands_while_the_treasury_cannot_receive() public {
        FreezeToken ft = new FreezeToken();
        pool.setDepositLimit(address(ft), 500e6, 25_000e6);
        ft.mint(depositor, 1_000e6);
        vm.startPrank(depositor);
        ft.approve(address(pool), type(uint256).max);
        pool.shieldBound(address(ft), NOTE, bytes32(uint256(0xF7F7)), hex"00");
        pool.shieldBound(address(ft), NOTE, bytes32(uint256(0xF7F8)), hex"00");
        vm.stopPrank();

        Call memory k = _callFrom(router, 506, address(ft), NOTE, address(gloam), 39e18, 0xF6, _route1(direct));
        pool.unshield(k.s.proof, k.s.root, k.s.nullifier, k.s.asset, _escrow(k), k.s.amount);
        ft.freeze(treasury, true);
        router.swap(k.s, k.d, k.r, k.route);
        assertTrue(pool.commitmentSeen(k.r.commitment), "the refund landed");
        assertEq(ft.balanceOf(address(router)), ARRIVES - k.r.amount, "the margin waits in the router");

        // a later refund of the same token still lands, and uses only what its own escrow paid
        Call memory k2 = _callFrom(router, 509, address(ft), NOTE, address(gloam), 39e18, 0xF9, _route1(direct));
        pool.unshield(k2.s.proof, k2.s.root, k2.s.nullifier, k2.s.asset, _escrow(k2), k2.s.amount);
        router.swap(k2.s, k2.d, k2.r, k2.route);
        assertTrue(pool.commitmentSeen(k2.r.commitment));
        assertEq(ft.balanceOf(address(router)), 2 * (ARRIVES - k.r.amount));

        // once the treasury can receive again, the next sweep takes all of it
        ft.freeze(treasury, false);
        pool.setDepositLimit(address(gloam), 25_000e18, 250_000e18);
        Call memory k3 = _callFrom(router, 510, address(ft), NOTE, address(gloam), 39e18, 0xFA, _route1(direct));
        pool.unshield(k3.s.proof, k3.s.root, k3.s.nullifier, k3.s.asset, _escrow(k3), k3.s.amount);
        router.swap(k3.s, k3.d, k3.r, k3.route);
        assertEq(ft.balanceOf(address(router)), 0);
        assertEq(ft.balanceOf(treasury), 3 * (ARRIVES - k.r.amount));
    }

    /// F-3 on the swap path: a blocked treasury doesn't stop a swap either.
    function test_review_F3_swap_lands_while_the_treasury_cannot_receive_the_output() public {
        // the treasury refuses gloam: the extra output stays in the router, the swap still lands
        pm.setBonusOut(1e18);
        vm.mockCallRevert(
            address(gloam), abi.encodeWithSelector(0xa9059cbb, treasury, uint256(1e18)), bytes("blocked")
        );
        Call memory k = _call(router, 511, address(gloam), 39e18, 0xFB, _route1(direct));
        router.swap(k.s, k.d, k.r, k.route);
        assertTrue(pool.commitmentSeen(k.d.commitment));
        assertEq(gloam.balanceOf(address(router)), 1e18);
        vm.clearMockedCalls();
    }
}
