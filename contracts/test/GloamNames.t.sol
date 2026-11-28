// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {GloamNames} from "../src/GloamNames.sol";
import {MockERC20} from "./MockERC20.sol";

contract GloamNamesTest is Test {
    GloamNames names;
    MockERC20 gloam;

    address safe = makeAddr("safe");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    address treasury = makeAddr("treasury");

    // P-256 generator G and 2G: real points on the curve, as in a Gloam address.
    bytes32 constant GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296;
    bytes32 constant GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5;
    bytes32 constant G2X = 0x7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978;
    bytes32 constant G2Y = 0x07775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1;

    uint256 constant P3 = 50 ether;
    uint256 constant P4 = 15 ether;
    uint256 constant P5 = 5 ether;

    function setUp() public {
        gloam = new MockERC20();
        names = new GloamNames(address(gloam), safe, treasury, P3, P4, P5);
        for (uint256 i; i < 3; ++i) {
            address who = [alice, bob, carol][i];
            gloam.mint(who, 10_000 ether);
            vm.prank(who);
            gloam.approve(address(names), type(uint256).max);
        }
    }

    function _register(address who, string memory name, uint256 years_) internal returns (uint64) {
        vm.prank(who);
        return names.register(name, GX, GY, who, years_);
    }

    // ------------------------------------------------------------ register

    function test_register_pays_treasury_and_resolves() public {
        uint64 exp = _register(alice, "duke", 2);
        assertEq(exp, uint64(block.timestamp + 2 * 365 days));
        assertEq(gloam.balanceOf(treasury), 2 * P4);
        assertEq(gloam.balanceOf(address(names)), 0);
        assertEq(names.totalCollected(), 2 * P4);

        (address holder, bytes32 x, bytes32 y, uint64 expires) = names.resolve("duke");
        assertEq(holder, alice);
        assertEq(x, GX);
        assertEq(y, GY);
        assertEq(expires, exp);
    }

    function test_price_tiers() public view {
        assertEq(names.priceOf("abc", 1), P3);
        assertEq(names.priceOf("abcd", 1), P4);
        assertEq(names.priceOf("abcde", 3), 3 * P5);
        assertEq(names.priceOf("a_long_name_here_20c", 1), P5);
    }

    function test_holder_can_differ_from_payer() public {
        vm.prank(alice);
        names.register("payroll_team", GX, GY, carol, 1);
        (address holder,,,) = names.resolve("payroll_team");
        assertEq(holder, carol);
        assertEq(gloam.balanceOf(alice), 10_000 ether - P5);
    }

    function test_rejects_bad_names() public {
        string[8] memory bad =
            ["ab", "Duke", "du-ke", "du.ke", "du ke", "", "a_name_that_is_way_too_long", unicode"dukё"];
        for (uint256 i; i < bad.length; ++i) {
            assertFalse(names.validName(bad[i]));
            vm.prank(alice);
            vm.expectRevert(GloamNames.BadName.selector);
            names.register(bad[i], GX, GY, alice, 1);
        }
        assertTrue(names.validName("duke_01"));
        assertTrue(names.validName("abc"));
    }

    function test_rejects_bad_keys() public {
        assertTrue(names.validKey(GX, GY));
        assertTrue(names.validKey(G2X, G2Y));
        assertFalse(names.validKey(GX, G2Y));
        assertFalse(names.validKey(bytes32(0), bytes32(0)));
        assertFalse(names.validKey(bytes32(type(uint256).max), GY));
        vm.prank(alice);
        vm.expectRevert(GloamNames.BadKey.selector);
        names.register("duke", GX, G2Y, alice, 1);
    }

    function test_rejects_bad_years_and_zero_holder() public {
        vm.startPrank(alice);
        vm.expectRevert(GloamNames.BadYears.selector);
        names.register("duke", GX, GY, alice, 0);
        vm.expectRevert(GloamNames.BadYears.selector);
        names.register("duke", GX, GY, alice, 11);
        vm.expectRevert(GloamNames.ZeroAddress.selector);
        names.register("duke", GX, GY, address(0), 1);
        vm.stopPrank();
    }

    function test_unpaid_register_reverts_and_leaves_nothing() public {
        address broke = makeAddr("broke");
        vm.prank(broke);
        vm.expectRevert();
        names.register("duke", GX, GY, broke, 1);
        (address holder,,,) = names.resolve("duke");
        assertEq(holder, address(0));
        assertEq(names.totalCollected(), 0);
        assertEq(gloam.balanceOf(treasury), 0);
    }

    function test_free_names_when_price_is_zero() public {
        vm.prank(safe);
        names.setPrices(0, 0, 0);
        address broke = makeAddr("broke");
        vm.prank(broke);
        names.register("freebie", GX, GY, broke, 1);
        (address holder,,,) = names.resolve("freebie");
        assertEq(holder, broke);
    }

    // ------------------------------------------------------------ expiry

    function test_taken_name_cannot_be_registered_until_grace_ends() public {
        uint64 exp = _register(alice, "duke", 1);
        vm.prank(bob);
        vm.expectRevert(GloamNames.NotAvailable.selector);
        names.register("duke", G2X, G2Y, bob, 1);

        // Expired but in grace: still resolves to Alice's key, still not takeable.
        vm.warp(uint256(exp) + 30 days);
        (address holder, bytes32 x,,) = names.resolve("duke");
        assertEq(holder, alice);
        assertEq(x, GX);
        assertFalse(names.available("duke", bob));
        vm.prank(bob);
        vm.expectRevert(GloamNames.NotAvailable.selector);
        names.register("duke", G2X, G2Y, bob, 1);

        // Grace over: resolves to nothing, Bob can take it.
        vm.warp(uint256(exp) + 30 days + 1);
        (holder,,,) = names.resolve("duke");
        assertEq(holder, address(0));
        assertTrue(names.available("duke", bob));
        vm.prank(bob);
        names.register("duke", G2X, G2Y, bob, 1);
        (holder, x,,) = names.resolve("duke");
        assertEq(holder, bob);
        assertEq(x, G2X);
    }

    function test_anyone_can_renew_until_grace_ends() public {
        uint64 exp = _register(alice, "duke", 1);
        vm.prank(bob);
        uint64 renewed = names.renew("duke", 2);
        assertEq(renewed, exp + uint64(2 * 365 days));
        assertEq(gloam.balanceOf(bob), 10_000 ether - 2 * P4);

        vm.warp(uint256(renewed) + 10 days);
        vm.prank(carol);
        names.renew("duke", 1);

        vm.warp(uint256(renewed) + 365 days + 30 days + 1);
        vm.prank(alice);
        vm.expectRevert(GloamNames.Expired.selector);
        names.renew("duke", 1);
    }

    function test_renew_caps_at_ten_years_ahead() public {
        _register(alice, "duke", 10);
        vm.prank(alice);
        vm.expectRevert(GloamNames.BadYears.selector);
        names.renew("duke", 1);
    }

    function test_renew_unknown_name_reverts() public {
        vm.expectRevert(GloamNames.NotRegistered.selector);
        names.renew("nobody", 1);
    }

    // ------------------------------------------------------------ holder powers

    function test_holder_changes_key_and_hands_on() public {
        _register(alice, "duke", 1);
        vm.prank(alice);
        names.setKey("duke", G2X, G2Y);
        (, bytes32 x, bytes32 y,) = names.resolve("duke");
        assertEq(x, G2X);
        assertEq(y, G2Y);

        vm.prank(alice);
        names.transferName("duke", bob);
        (address holder,,,) = names.resolve("duke");
        assertEq(holder, bob);

        vm.prank(alice);
        vm.expectRevert(GloamNames.NotHolder.selector);
        names.setKey("duke", GX, GY);
    }

    function test_only_holder_changes_key() public {
        _register(alice, "duke", 1);
        vm.prank(bob);
        vm.expectRevert(GloamNames.NotHolder.selector);
        names.setKey("duke", G2X, G2Y);
        vm.prank(safe);
        vm.expectRevert(GloamNames.NotHolder.selector);
        names.setKey("duke", G2X, G2Y);
        vm.prank(bob);
        vm.expectRevert(GloamNames.NotHolder.selector);
        names.transferName("duke", bob);
    }

    function test_holder_cannot_change_expired_name() public {
        uint64 exp = _register(alice, "duke", 1);
        vm.warp(uint256(exp) + 1);
        vm.startPrank(alice);
        vm.expectRevert(GloamNames.Expired.selector);
        names.setKey("duke", G2X, G2Y);
        vm.expectRevert(GloamNames.Expired.selector);
        names.transferName("duke", bob);
        vm.stopPrank();
    }

    function test_set_key_rejects_off_curve() public {
        _register(alice, "duke", 1);
        vm.prank(alice);
        vm.expectRevert(GloamNames.BadKey.selector);
        names.setKey("duke", GX, G2Y);
    }

    // ------------------------------------------------------------ owner powers

    function test_reserved_name_only_for_its_account() public {
        vm.prank(safe);
        names.reserve("gloam", carol);
        assertFalse(names.available("gloam", alice));
        assertTrue(names.available("gloam", carol));

        vm.prank(alice);
        vm.expectRevert(GloamNames.Reserved.selector);
        names.register("gloam", GX, GY, alice, 1);

        vm.prank(carol);
        names.register("gloam", GX, GY, carol, 1);
        assertEq(names.reservedFor(keccak256("gloam")), address(0));
    }

    function test_owner_cannot_reserve_a_held_name() public {
        _register(alice, "duke", 1);
        vm.prank(safe);
        vm.expectRevert(GloamNames.NotAvailable.selector);
        names.reserve("duke", carol);
    }

    function test_only_owner_sets_prices_and_reserves() public {
        vm.startPrank(alice);
        vm.expectRevert(GloamNames.NotOwner.selector);
        names.setPrices(1, 1, 1);
        vm.expectRevert(GloamNames.NotOwner.selector);
        names.reserve("gloam", alice);
        vm.stopPrank();

        vm.prank(safe);
        names.setPrices(1 ether, 2 ether, 3 ether);
        assertEq(names.priceOf("abc", 1), 1 ether);
        assertEq(names.priceOf("abcd", 1), 2 ether);
        assertEq(names.priceOf("abcde", 1), 3 ether);
    }

    function test_renewals_pay_treasury() public {
        _register(alice, "duke", 1);
        vm.prank(bob);
        names.renew("duke", 3);
        assertEq(gloam.balanceOf(treasury), 4 * P4);
        assertEq(names.totalCollected(), 4 * P4);
    }

    function test_only_owner_moves_the_treasury() public {
        address next = makeAddr("next");
        vm.prank(alice);
        vm.expectRevert(GloamNames.NotOwner.selector);
        names.setTreasury(alice);
        vm.prank(safe);
        vm.expectRevert(GloamNames.ZeroAddress.selector);
        names.setTreasury(address(0));

        _register(alice, "duke", 1);
        vm.prank(safe);
        names.setTreasury(next);
        _register(bob, "bobby", 1);
        assertEq(gloam.balanceOf(treasury), P4);
        assertEq(gloam.balanceOf(next), P5);
    }

    function test_price_change_keeps_paid_expiry() public {
        uint64 exp = _register(alice, "duke", 1);
        vm.prank(safe);
        names.setPrices(1, 1, 1);
        (,,, uint64 expires) = names.resolve("duke");
        assertEq(expires, exp);
    }

    function test_two_step_ownership() public {
        vm.prank(safe);
        names.transferOwnership(bob);
        assertEq(names.owner(), safe);
        vm.prank(alice);
        vm.expectRevert(GloamNames.NotPendingOwner.selector);
        names.acceptOwnership();
        vm.prank(bob);
        names.acceptOwnership();
        assertEq(names.owner(), bob);
        assertEq(names.pendingOwner(), address(0));
    }

    function test_constructor_rejects_missing_token() public {
        vm.expectRevert(GloamNames.ZeroAddress.selector);
        new GloamNames(address(0), safe, treasury, 1, 1, 1);
        vm.expectRevert(GloamNames.ZeroAddress.selector);
        new GloamNames(makeAddr("eoa"), safe, treasury, 1, 1, 1);
        vm.expectRevert(GloamNames.ZeroAddress.selector);
        new GloamNames(address(gloam), address(0), treasury, 1, 1, 1);
        vm.expectRevert(GloamNames.ZeroAddress.selector);
        new GloamNames(address(gloam), safe, address(0), 1, 1, 1);
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_valid_names_only_use_the_allowed_set(string calldata name) public view {
        bytes memory b = bytes(name);
        bool expected = b.length >= 3 && b.length <= 20;
        for (uint256 i; expected && i < b.length; ++i) {
            bytes1 c = b[i];
            expected = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "_";
        }
        assertEq(names.validName(name), expected);
    }
}
