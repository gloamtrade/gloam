// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolPayments} from "../src/ShieldPoolPayments.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {GloamNames} from "../src/GloamNames.sol";
import {GloamNamesRegistrar} from "../src/GloamNamesRegistrar.sol";
import {MockERC20} from "./MockERC20.sol";

/// Accepts every shield proof (the commitment binding is the circuit's job, tested elsewhere).
contract ClaimAcceptVerifier is IVerifier {
    function verify(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return true;
    }
}

/// Stands in for the unshield proof's binding: the "proof" names the `to` it
/// was made for, and any other `to` fails, as a real Groth16 proof would.
contract ClaimToBindingVerifier is IVerifier {
    function verify(bytes calldata proof, uint256[] calldata inputs) external pure returns (bool) {
        if (inputs.length != 5) return true;
        return abi.decode(proof, (address)) == address(uint160(inputs[4]));
    }
}

/// Re-enters the registrar during the registry's payment pull (a hostile token).
contract ReenterToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public target;
    bytes public payload;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function arm(address t, bytes memory p) external {
        target = t;
        payload = p;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (target != address(0)) {
            (bool ok, bytes memory ret) = target.call(payload);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract GloamNamesRegistrarTest is Test {
    using stdJson for string;

    ShieldPoolPayments pool;
    GloamNames names;
    GloamNamesRegistrar reg;
    MockERC20 gloam;

    address safe = makeAddr("safe");
    address treasury = makeAddr("treasury");
    address relayer = makeAddr("relayer");
    address depositor = makeAddr("depositor");
    address holder = makeAddr("holder");
    address feeTo = makeAddr("feeTo");

    bytes32 constant GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296;
    bytes32 constant GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5;
    bytes32 constant G2X = 0x7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978;
    bytes32 constant G2Y = 0x07775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1;

    uint256 constant P4 = 15 ether;
    uint16 constant FEE_BPS = 50;

    struct Call {
        GloamNamesRegistrar.Spend s;
        GloamNamesRegistrar.Claim c;
        GloamNamesRegistrar.Refund r;
    }

    function setUp() public {
        vm.warp(1_900_000_000);
        gloam = new MockERC20();
        _vault(address(gloam));
        names = new GloamNames(address(gloam), safe, treasury, 50 ether, P4, 5 ether);
        reg = new GloamNamesRegistrar(address(pool), address(names), treasury);
    }

    function _vault(address token) internal {
        pool = new ShieldPoolPayments(_deployPoseidon(), address(new ClaimToBindingVerifier()));
        pool.setShieldVerifier(address(new ClaimAcceptVerifier()));
        pool.setWithdrawFee(FEE_BPS, feeTo);
        pool.turnOnDepositLimits();
        pool.setDepositLimit(token, 25_000e18, 250_000e18);
        // earlier deposits, so the vault holds what the notes below are worth
        ReenterToken(token).mint(depositor, 1_000e18);
        vm.prank(depositor);
        ReenterToken(token).approve(address(pool), type(uint256).max);
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(depositor);
            pool.shieldBound(token, 100e18, bytes32(uint256(0xC0FFEE + i)), hex"00");
        }
    }

    function _deployPoseidon() internal returns (address addr) {
        string memory json = vm.readFile("test/fixtures/Poseidon2.json");
        bytes memory bytecode = json.readBytes(".bytecode");
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "poseidon deploy failed");
    }

    /// The smallest note whose amount after the vault's fee covers `price`.
    function _noteFor(uint256 price) internal pure returns (uint256 a) {
        a = (price * 10_000 + (10_000 - FEE_BPS) - 1) / (10_000 - FEE_BPS);
        while (a - _fee(a) < price) a++;
    }

    function _fee(uint256 amount) internal pure returns (uint256) {
        return (amount / 10_000) * FEE_BPS + ((amount % 10_000) * FEE_BPS) / 10_000;
    }

    /// A claim of `name` with a note of `amount`, its unshield "proof" made for this claim's escrow.
    function _call(uint256 nul, uint256 amount, string memory name, address who, uint256 years_)
        internal
        view
        returns (Call memory k)
    {
        k.c = GloamNamesRegistrar.Claim(name, GX, GY, who, years_);
        // the refund note: the amount less the vault's highest possible fee (1%)
        k.r = GloamNamesRegistrar.Refund(hex"00", bytes32(nul + 0x1000), amount - amount / 100);
        address escrow = reg.escrowFor(_key(nul, amount, k.c, k.r));
        k.s = GloamNamesRegistrar.Spend(abi.encode(escrow), pool.currentRoot(), bytes32(nul), amount);
    }

    function _key(uint256 nul, uint256 amount, GloamNamesRegistrar.Claim memory c, GloamNamesRegistrar.Refund memory r)
        internal
        pure
        returns (GloamNamesRegistrar.EscrowKey memory)
    {
        return GloamNamesRegistrar.EscrowKey(
            bytes32(nul), amount, keccak256(bytes(c.name)), c.keyX, c.keyY, c.holder, c.years_, r.commitment, r.amount
        );
    }

    function _go(Call memory k) internal returns (uint256) {
        vm.prank(relayer);
        return reg.claim(k.s, k.c, k.r);
    }

    function _assertRegistrarEmpty() internal view {
        assertEq(gloam.balanceOf(address(reg)), 0, "registrar keeps no gloam");
        assertEq(gloam.allowance(address(reg), address(names)), 0, "no approval left to the registry");
        assertEq(gloam.allowance(address(reg), address(pool)), 0, "no approval left to the vault");
    }

    // ───────────────────────────────────────────────────────────── claims

    function test_claim_from_a_note_registers_and_pays_the_treasury() public {
        uint256 note = _noteFor(P4);
        Call memory k = _call(1, note, "yomi", holder, 1);
        uint256 vaultBefore = gloam.balanceOf(address(pool));

        uint256 paid = _go(k);

        assertEq(paid, P4);
        assertTrue(pool.isSpent(bytes32(uint256(1))), "note spent");
        (address h, bytes32 x, bytes32 y, uint64 exp) = names.resolve("yomi");
        assertEq(h, holder, "holder is the one the claim named");
        assertEq(x, GX);
        assertEq(y, GY);
        assertEq(exp, uint64(block.timestamp + 365 days));
        // the price to the treasury, plus the rounding dust; the fee stays in the vault
        assertEq(gloam.balanceOf(treasury), note - _fee(note), "treasury got the price and the dust");
        assertGe(gloam.balanceOf(treasury), P4);
        assertLt(gloam.balanceOf(treasury) - P4, 1e15, "dust only");
        assertEq(gloam.balanceOf(address(pool)), vaultBefore - (note - _fee(note)), "the vault kept its fee");
        assertFalse(pool.commitmentSeen(k.r.commitment), "refund note not used");
        _assertRegistrarEmpty();
    }

    function test_no_public_wallet_pays() public {
        // nobody but the vault holds or approves anything: the relayer and the holder spend nothing
        Call memory k = _call(1, _noteFor(P4), "yomi", holder, 1);
        _go(k);
        assertEq(gloam.balanceOf(relayer), 0);
        assertEq(gloam.balanceOf(holder), 0);
        (address h, , , ) = names.resolve("yomi");
        assertEq(h, holder);
    }

    function test_longer_claims_and_three_letter_names() public {
        uint256 price = names.priceOf("abc", 2);
        assertEq(price, 100 ether);
        Call memory k = _call(7, _noteFor(price), "abc", holder, 2);
        assertEq(_go(k), price);
        (, , , uint64 exp) = names.resolve("abc");
        assertEq(exp, uint64(block.timestamp + 2 * 365 days));
    }

    function test_a_bigger_note_leaves_the_rest_to_the_treasury() public {
        Call memory k = _call(2, 40 ether, "zoeys", holder, 1);
        uint256 paid = _go(k);
        assertEq(paid, 5 ether);
        assertEq(gloam.balanceOf(treasury), 40 ether - _fee(40 ether));
        _assertRegistrarEmpty();
    }

    // ───────────────────────────────────────────────────────────── what a copier can't change

    function test_a_copy_with_another_name_is_refused() public {
        Call memory k = _call(1, _noteFor(P4), "yomi", holder, 1);
        k.c.name = "duke";
        vm.expectRevert();
        _go(k);
        assertFalse(pool.isSpent(bytes32(uint256(1))), "note still unspent");
    }

    function test_a_copy_with_another_holder_key_or_years_is_refused() public {
        Call memory k = _call(1, _noteFor(P4), "yomi", holder, 1);
        k.c.holder = makeAddr("thief");
        vm.expectRevert();
        _go(k);

        k = _call(1, _noteFor(P4), "yomi", holder, 1);
        k.c.keyX = G2X;
        k.c.keyY = G2Y;
        vm.expectRevert();
        _go(k);

        k = _call(1, _noteFor(2 * P4), "yomi", holder, 1);
        k.c.years_ = 2;
        vm.expectRevert();
        _go(k);

        k = _call(1, _noteFor(P4), "yomi", holder, 1);
        k.r.commitment = bytes32(uint256(0xBAD));
        vm.expectRevert();
        _go(k);
        assertFalse(pool.isSpent(bytes32(uint256(1))), "note still unspent");
    }

    // ───────────────────────────────────────────────────────────── when the registry says no

    function test_a_taken_name_reverts_and_keeps_the_note() public {
        gloam.mint(holder, 100 ether);
        vm.startPrank(holder);
        gloam.approve(address(names), type(uint256).max);
        names.register("yomi", GX, GY, holder, 1);
        vm.stopPrank();

        Call memory k = _call(1, _noteFor(P4), "yomi", holder, 1);
        vm.expectRevert(GloamNames.NotAvailable.selector);
        _go(k);
        assertFalse(pool.isSpent(bytes32(uint256(1))), "note still unspent");
        _assertRegistrarEmpty();
    }

    function test_a_raised_price_reverts_and_keeps_the_note() public {
        Call memory k = _call(1, _noteFor(P4), "yomi", holder, 1);
        vm.prank(safe);
        names.setPrices(50 ether, 20 ether, 5 ether);
        vm.expectRevert(abi.encodeWithSelector(GloamNamesRegistrar.ShortInput.selector, 20 ether, k.s.amount - _fee(k.s.amount)));
        _go(k);
        assertFalse(pool.isSpent(bytes32(uint256(1))), "note still unspent");
    }

    function test_a_lowered_price_sends_the_difference_to_the_treasury() public {
        Call memory k = _call(1, _noteFor(P4), "yomi", holder, 1);
        vm.prank(safe);
        names.setPrices(50 ether, 10 ether, 5 ether);
        assertEq(_go(k), 10 ether);
        assertEq(gloam.balanceOf(treasury), k.s.amount - _fee(k.s.amount));
        _assertRegistrarEmpty();
    }

    function test_a_reserved_name_reverts() public {
        vm.prank(safe);
        names.reserve("gloam", safe);
        Call memory k = _call(1, _noteFor(P4), "gloam", holder, 1);
        vm.expectRevert(GloamNames.Reserved.selector);
        _go(k);
        assertFalse(pool.isSpent(bytes32(uint256(1))));
    }

    function test_bad_name_key_or_holder_revert_through_the_registry() public {
        Call memory k = _call(1, _noteFor(P4), "Yo", holder, 1);
        vm.expectRevert(GloamNames.BadName.selector);
        _go(k);

        k = _call(2, _noteFor(P4), "yomi", holder, 1);
        k.c.keyX = bytes32(uint256(1));
        k = _rebind(k, 2);
        vm.expectRevert(GloamNames.BadKey.selector);
        _go(k);

        k = _call(3, _noteFor(P4), "yomi", address(0), 1);
        vm.expectRevert(GloamNames.ZeroAddress.selector);
        _go(k);
    }

    /// Makes the "proof" again for a claim edited after _call.
    function _rebind(Call memory k, uint256 nul) internal view returns (Call memory) {
        address escrow = reg.escrowFor(_key(nul, k.s.amount, k.c, k.r));
        k.s.proof = abi.encode(escrow);
        return k;
    }

    // ───────────────────────────────────────────────────────────── the front-run and the refund

    function test_unshield_sent_alone_then_claim_refunds_into_the_vault() public {
        Call memory k = _call(1, _noteFor(P4), "yomi", holder, 1);
        // someone copies the public proof and sends the unshield on its own
        address escrow = abi.decode(k.s.proof, (address));
        pool.unshield(k.s.proof, k.s.root, k.s.nullifier, address(gloam), escrow, k.s.amount);
        assertEq(gloam.balanceOf(escrow), k.s.amount - _fee(k.s.amount), "money waits at the escrow");

        uint256 paid = _go(k);

        assertEq(paid, 0, "refund, not a claim");
        assertTrue(pool.commitmentSeen(k.r.commitment), "the refund note is in the vault");
        (address h, , , ) = names.resolve("yomi");
        assertEq(h, address(0), "no name was registered");
        // what the refund note didn't take goes to the treasury
        assertEq(gloam.balanceOf(treasury), k.s.amount - _fee(k.s.amount) - k.r.amount);
        _assertRegistrarEmpty();
    }

    function test_the_refund_runs_once() public {
        Call memory k = _call(1, _noteFor(P4), "yomi", holder, 1);
        address escrow = abi.decode(k.s.proof, (address));
        pool.unshield(k.s.proof, k.s.root, k.s.nullifier, address(gloam), escrow, k.s.amount);
        _go(k);
        vm.expectRevert(GloamNamesRegistrar.BadRefund.selector);
        _go(k);
    }

    function test_a_claim_that_landed_cannot_run_again() public {
        Call memory k = _call(1, _noteFor(P4), "yomi", holder, 1);
        _go(k);
        vm.expectRevert(GloamNamesRegistrar.BadRefund.selector);
        _go(k);
    }

    function test_a_refund_bigger_than_the_note_is_refused() public {
        Call memory k = _call(1, _noteFor(P4), "yomi", holder, 1);
        k.r.amount = k.s.amount + 1;
        vm.expectRevert(GloamNamesRegistrar.BadRefund.selector);
        _go(k);
        k.r.amount = 0;
        vm.expectRevert(GloamNamesRegistrar.BadRefund.selector);
        _go(k);
    }

    function test_a_note_spent_some_other_way_is_not_refunded() public {
        Call memory k = _call(1, _noteFor(P4), "yomi", holder, 1);
        // the note goes to a wallet, not this claim's escrow
        pool.unshield(abi.encode(address(0xBEEF)), k.s.root, k.s.nullifier, address(gloam), address(0xBEEF), k.s.amount);
        vm.expectRevert(GloamNamesRegistrar.BadRefund.selector);
        _go(k);
    }

    // ───────────────────────────────────────────────────────────── the contract itself

    function test_escrow_is_unique_per_claim() public view {
        GloamNamesRegistrar.Claim memory c = GloamNamesRegistrar.Claim("yomi", GX, GY, holder, 1);
        GloamNamesRegistrar.Refund memory r = GloamNamesRegistrar.Refund(hex"00", bytes32(uint256(9)), 1);
        address a = reg.escrowFor(_key(1, 10, c, r));
        assertTrue(a != reg.escrowFor(_key(2, 10, c, r)), "another note");
        assertTrue(a != reg.escrowFor(_key(1, 11, c, r)), "another amount");
        c.name = "yomo";
        assertTrue(a != reg.escrowFor(_key(1, 10, c, r)), "another name");
    }

    function test_constructor_checks_and_reads_the_token() public {
        assertEq(reg.token(), address(gloam));
        assertEq(address(reg.vault()), address(pool));
        assertEq(address(reg.names()), address(names));
        assertEq(reg.treasury(), treasury);
        vm.expectRevert(GloamNamesRegistrar.ZeroAddress.selector);
        new GloamNamesRegistrar(address(0), address(names), treasury);
        vm.expectRevert(GloamNamesRegistrar.ZeroAddress.selector);
        new GloamNamesRegistrar(address(pool), address(names), address(0));
        vm.expectRevert(GloamNamesRegistrar.NotAContract.selector);
        new GloamNamesRegistrar(makeAddr("eoa"), address(names), treasury);
    }

    function test_reentry_during_the_payment_is_refused() public {
        ReenterToken evil = new ReenterToken();
        _vault(address(evil));
        GloamNames n2 = new GloamNames(address(evil), safe, treasury, 50 ether, P4, 5 ether);
        GloamNamesRegistrar r2 = new GloamNamesRegistrar(address(pool), address(n2), treasury);
        reg = r2;
        Call memory k = _call(1, _noteFor(P4), "yomi", holder, 1);
        evil.arm(address(r2), abi.encodeCall(GloamNamesRegistrar.claim, (k.s, k.c, k.r)));
        // the inner claim hits the guard; the registry sees its pull fail and stops everything
        vm.prank(relayer);
        vm.expectRevert(GloamNames.PaymentFailed.selector);
        r2.claim(k.s, k.c, k.r);
        assertFalse(pool.isSpent(bytes32(uint256(1))), "note still unspent");
    }

    function testFuzz_any_big_enough_note_claims_and_ends_empty(uint96 extra) public {
        uint256 note = _noteFor(P4) + uint256(extra) % 50 ether;
        Call memory k = _call(11, note, "fuzzy", holder, 1);
        assertEq(_go(k), 5 ether);
        assertEq(gloam.balanceOf(treasury), note - _fee(note));
        _assertRegistrarEmpty();
    }
}
