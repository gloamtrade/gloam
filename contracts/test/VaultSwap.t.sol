// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore} from "../src/ShieldPoolCore.sol";
import {ShieldPoolPayments} from "../src/ShieldPoolPayments.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {GloamVaultSwap} from "../src/GloamVaultSwap.sol";
import {GloamVaultSwapV4, PoolKey, SwapParams} from "../src/GloamVaultSwapV4.sol";
import {GloamVaultSwapTempo} from "../src/GloamVaultSwapTempo.sol";
import {MockERC20} from "./MockERC20.sol";

contract SwapAcceptVerifier is IVerifier {
    function verify(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return true;
    }
}

interface IUnlockCallbackT {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

interface IERC20T {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// A hook the mock PoolManager calls during each swap (a stand-in for beforeSwap).
interface IMockHook {
    function onSwap() external;
}

/**
 * A small stand-in for Uniswap v4's PoolManager: a fixed price per pool and
 * direction, exact output only, with the real lock rules (deltas per currency
 * must net to zero before unlock returns; sync, settle and take move them).
 * Native ETH is address(0): settled with msg.value after sync(address(0)), and
 * taken as a plain ETH transfer, as in v4.
 */
contract MockPoolManager {
    struct Rate {
        uint256 num; // input = ceil(output * num / den)
        uint256 den;
    }

    mapping(bytes32 => Rate) public rate;
    mapping(address => int256) public delta;
    address[] internal touched;
    bool public unlocked;
    address internal synced;
    uint256 internal syncedBal;
    /// Extra output on top of what was asked (models a hook paying out more).
    uint256 public bonusOut;
    /// Output short of what was asked (models a hook keeping some of it).
    uint256 public shortOut;
    /// Extra input on top of the price (models a hook charging more).
    uint256 public extraIn;
    /// Called during every swap, like a hook.
    address public hook;

    error CurrencyNotSettled();
    error ManagerLocked();

    function setRate(PoolKey memory k, bool zeroForOne, uint256 num, uint256 den) external {
        rate[keccak256(abi.encode(k, zeroForOne))] = Rate(num, den);
    }

    function setBonusOut(uint256 b) external {
        bonusOut = b;
    }

    function setShortOut(uint256 s) external {
        shortOut = s;
    }

    function setExtraIn(uint256 e) external {
        extraIn = e;
    }

    function setHook(address h) external {
        hook = h;
    }

    receive() external payable {}

    function unlock(bytes calldata data) external returns (bytes memory r) {
        unlocked = true;
        r = IUnlockCallbackT(msg.sender).unlockCallback(data);
        for (uint256 i = 0; i < touched.length; i++) {
            if (delta[touched[i]] != 0) revert CurrencyNotSettled();
        }
        delete touched;
        unlocked = false;
    }

    function swap(PoolKey memory key, SwapParams memory p, bytes calldata) external returns (int256) {
        if (!unlocked) revert ManagerLocked();
        require(p.amountSpecified > 0, "mock: exact output only");
        Rate memory r = rate[keccak256(abi.encode(key, p.zeroForOne))];
        require(r.den != 0, "mock: no rate");
        if (hook != address(0)) IMockHook(hook).onSwap();
        uint256 out = uint256(p.amountSpecified) + bonusOut - shortOut;
        uint256 inAmt = (uint256(p.amountSpecified) * r.num + r.den - 1) / r.den + extraIn;
        int128 a0;
        int128 a1;
        if (p.zeroForOne) {
            a0 = -int128(int256(inAmt));
            a1 = int128(int256(out));
        } else {
            a1 = -int128(int256(inAmt));
            a0 = int128(int256(out));
        }
        _account(key.currency0, a0);
        _account(key.currency1, a1);
        return int256((uint256(int256(a0)) << 128) | uint256(uint128(a1)));
    }

    function sync(address c) external {
        synced = c;
        syncedBal = c == address(0) ? 0 : IERC20T(c).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        if (synced == address(0)) {
            paid = msg.value;
            _account(address(0), int128(int256(paid)));
        } else {
            require(msg.value == 0, "mock: value with a token");
            paid = IERC20T(synced).balanceOf(address(this)) - syncedBal;
            _account(synced, int128(int256(paid)));
            synced = address(0);
        }
    }

    function take(address c, address to, uint256 amount) external {
        _account(c, -int128(int256(amount)));
        if (c == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "mock: eth take failed");
        } else {
            IERC20T(c).transfer(to, amount);
        }
    }

    function _account(address c, int128 d) internal {
        if (d == 0) return;
        if (delta[c] == 0) touched.push(c);
        delta[c] += d;
    }
}

/// Tempo's Stablecoin DEX, reduced to exact-output swaps at a fixed price.
contract MockStableDex {
    uint256 public num = 1_001; // input = ceil(out * 1001 / 1000)
    uint256 public den = 1_000;
    uint256 public shortBy;

    error MaxInputExceeded();

    function setRate(uint256 n, uint256 d) external {
        num = n;
        den = d;
    }

    function setShortBy(uint256 s) external {
        shortBy = s;
    }

    function swapExactAmountOut(address tokenIn, address tokenOut, uint128 amountOut, uint128 maxAmountIn)
        external
        returns (uint128 amountIn)
    {
        uint256 need = (uint256(amountOut) * num + den - 1) / den;
        if (need > maxAmountIn) revert MaxInputExceeded();
        MockERC20(tokenIn).transferFrom(msg.sender, address(this), need);
        MockERC20(tokenOut).transfer(msg.sender, amountOut - shortBy);
        return uint128(need);
    }
}

/// A token whose transfer calls back into the router (re-entry attempt).
contract ReenterToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public target;
    bytes public payload;

    function arm(address t, bytes calldata p) external {
        target = t;
        payload = p;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (target != address(0) && to == target) {
            (bool ok, bytes memory ret) = target.call(payload);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Stands in for the unshield proof's binding: the "proof" names the `to` it
/// was made for, and any other `to` fails, as a real Groth16 proof would.
contract ToBindingVerifier is IVerifier {
    function verify(bytes calldata proof, uint256[] calldata inputs) external pure returns (bool) {
        if (inputs.length != 5) return true;
        return abi.decode(proof, (address)) == address(uint160(inputs[4]));
    }
}

contract VaultSwapTest is Test {
    using stdJson for string;

    ShieldPoolPayments pool;
    SwapAcceptVerifier acceptV;
    ToBindingVerifier bindV;
    MockERC20 usd; // 6 decimals in spirit; amounts below are raw
    MockERC20 gloam;
    MockPoolManager pm;
    /// The router under test (GloamVaultSwapV4 here; VaultSwapV4b.t.sol runs every test on v2).
    GloamVaultSwap router;
    PoolKey direct; // usd / gloam, no hook
    PoolKey ethGloam; // native ETH / gloam
    PoolKey ethUsd; // native ETH / usd
    PoolKey stranger; // a pool nobody allowlisted

    address treasury = address(0x7EA5);
    address relayer = address(0x5E1A);
    address depositor = address(0xD0D0);
    address feeTo = address(0xFEE);

    uint256 constant NOTE = 100e6;
    uint256 constant ARRIVES = NOTE - (NOTE * 25) / 10_000; // after the 0.25% cash-out fee

    struct Call {
        GloamVaultSwap.Spend s;
        GloamVaultSwap.Deposit d;
        GloamVaultSwap.Deposit r;
        bytes route;
    }

    function setUp() public virtual {
        vm.warp(1_900_000_000);
        acceptV = new SwapAcceptVerifier();
        bindV = new ToBindingVerifier();
        pool = new ShieldPoolPayments(_deployPoseidon(), address(bindV));
        pool.setShieldVerifier(address(acceptV));
        usd = new MockERC20();
        gloam = new MockERC20();
        pool.setWithdrawFee(25, feeTo);
        pool.turnOnDepositLimits();
        pool.setDepositLimit(address(usd), 500e6, 25_000e6);
        pool.setDepositLimit(address(gloam), 25_000e18, 250_000e18);

        // earlier deposits, so the vault holds what the notes below are worth
        usd.mint(depositor, 1_000_000e6);
        vm.prank(depositor);
        usd.approve(address(pool), type(uint256).max);
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(depositor);
            pool.shieldBound(address(usd), NOTE, bytes32(uint256(0xC0FFEE + i)), hex"00");
        }

        pm = new MockPoolManager();
        usd.mint(address(pm), 1_000_000e6);
        gloam.mint(address(pm), 1_000_000e18);

        (address a, address b) = address(usd) < address(gloam) ? (address(usd), address(gloam)) : (address(gloam), address(usd));
        direct = PoolKey(a, b, 3000, 60, address(0));
        ethGloam = PoolKey(address(0), address(gloam), 0, 200, address(0xC0C0));
        ethUsd = PoolKey(address(0), address(usd), 87, 1, address(0));
        stranger = PoolKey(a, b, 10000, 200, address(0xBAD));

        // 1 gloam = 2.5 usd on the direct pool; usd has 6 decimals, gloam 18
        _rate(direct, address(usd), 25, 10 ** 13); // in usd = out gloam * 2.5e6 / 1e18
        _rate(direct, address(gloam), 10 ** 13, 25); // in gloam = out usd * 1e18 / 2.5e6
        // via ETH: 1 eth = 2400 usd, 1 gloam = 0.001 eth
        _rate(ethUsd, address(usd), 2400, 10 ** 12); // usd in per eth out
        _rate(ethUsd, address(0), 10 ** 12, 2400);
        _rate(ethGloam, address(0), 1, 1000); // eth in per gloam out
        _rate(ethGloam, address(gloam), 1000, 1);
        _rate(stranger, address(usd), 50, 10 ** 13); // twice the price

        PoolKey[] memory allow = new PoolKey[](3);
        allow[0] = direct;
        allow[1] = ethGloam;
        allow[2] = ethUsd;
        router = _newRouter(allow);
    }

    // ───────────────────────────────────────────────────────────── helpers

    /// A router on this vault, treasury and pool manager, allowing `allow`.
    function _newRouter(PoolKey[] memory allow) internal virtual returns (GloamVaultSwap) {
        return new GloamVaultSwapV4(address(pool), treasury, address(pm), allow);
    }

    function _rate(PoolKey memory k, address inCurrency, uint256 num, uint256 den) internal {
        pm.setRate(k, k.currency0 == inCurrency, num, den);
    }

    /// A swap of a usd note, its unshield "proof" made for this swap's escrow on `on`.
    function _call(GloamVaultSwap on, uint256 nul, address assetOut, uint256 amountOut, uint256 c, bytes memory route)
        internal
        view
        returns (Call memory k)
    {
        return _callFrom(on, nul, address(usd), NOTE, assetOut, amountOut, c, route);
    }

    function _callFrom(
        GloamVaultSwap on,
        uint256 nul,
        address assetIn,
        uint256 amount,
        address assetOut,
        uint256 amountOut,
        uint256 c,
        bytes memory route
    ) internal view returns (Call memory k) {
        k.d = GloamVaultSwap.Deposit(hex"00", bytes32(c), assetOut, amountOut);
        // the refund note: the amount less the vault's highest possible fee (1%)
        k.r = GloamVaultSwap.Deposit(hex"00", bytes32(c + 0x1000), assetIn, amount - amount / 100);
        k.route = route;
        address escrow = _escrowOf(
            on,
            assetIn,
            GloamVaultSwap.EscrowKey(
                bytes32(nul), amount, k.d.commitment, assetOut, amountOut, k.r.commitment, k.r.amount, keccak256(route)
            )
        );
        k.s = GloamVaultSwap.Spend(abi.encode(escrow), pool.currentRoot(), bytes32(nul), assetIn, amount);
    }

    /// The escrow a swap's unshield must name, on the router under test.
    function _escrowOf(GloamVaultSwap on, address assetIn, GloamVaultSwap.EscrowKey memory key)
        internal
        view
        virtual
        returns (address)
    {
        return on.escrowFor(assetIn, key);
    }

    function _go(GloamVaultSwap on, Call memory k) internal virtual returns (uint256) {
        return on.swap(k.s, k.d, k.r, k.route);
    }

    /// The swap call as calldata, for a contract that re-enters with it.
    function _swapData(Call memory k) internal view virtual returns (bytes memory) {
        return abi.encodeCall(GloamVaultSwap.swap, (k.s, k.d, k.r, k.route));
    }

    function _route1(PoolKey memory k) internal pure returns (bytes memory) {
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = k;
        return abi.encode(r);
    }

    function _route2(PoolKey memory k0, PoolKey memory k1) internal pure returns (bytes memory) {
        PoolKey[] memory r = new PoolKey[](2);
        r[0] = k0;
        r[1] = k1;
        return abi.encode(r);
    }

    function _assertRouterEmpty() internal view virtual {
        assertEq(usd.balanceOf(address(router)), 0, "router keeps no usd");
        assertEq(gloam.balanceOf(address(router)), 0, "router keeps no gloam");
        assertEq(address(router).balance, 0, "router keeps no eth");
        assertEq(usd.allowance(address(router), address(pool)), 0);
        assertEq(gloam.allowance(address(router), address(pool)), 0);
    }

    function _deployPoseidon() internal returns (address addr) {
        string memory json = vm.readFile("test/fixtures/Poseidon2.json");
        bytes memory bytecode = json.readBytes(".bytecode");
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "poseidon deploy failed");
    }

    // ───────────────────────────────────────────────────────────── swaps

    function test_direct_swap_lands_exact_amount_and_router_ends_empty() public {
        uint256 want = 39e18; // 97.5 usd at 2.5
        uint256 cost = 97_500_000;
        Call memory k = _call(router, 1, address(gloam), want, 0xA1, _route1(direct));

        vm.prank(relayer);
        uint256 spent = _go(router, k);

        assertEq(spent, cost);
        assertTrue(pool.isSpent(bytes32(uint256(1))), "note spent");
        assertTrue(pool.commitmentSeen(bytes32(uint256(0xA1))), "new note in the vault");
        assertFalse(pool.commitmentSeen(k.r.commitment), "refund note not used");
        assertEq(pool.deposited(address(gloam)), want, "vault holds exactly the new note");
        assertEq(pool.deposited(address(usd)), 3 * NOTE);
        assertEq(gloam.balanceOf(address(pool)), want);
        assertEq(usd.balanceOf(treasury), ARRIVES - cost, "unspent input to the treasury");
        assertEq(usd.balanceOf(relayer), 0, "the caller gains nothing");
        _assertRouterEmpty();
    }

    function test_two_hops_through_native_eth() public {
        uint256 want = 39e18; // 0.039 eth = 93.6 usd
        Call memory k = _call(router, 2, address(gloam), want, 0xA2, _route2(ethUsd, ethGloam));
        uint256 spent = _go(router, k);
        assertEq(spent, 93_600_000);
        assertEq(pool.deposited(address(gloam)), want);
        assertEq(usd.balanceOf(treasury), ARRIVES - 93_600_000);
        _assertRouterEmpty();
    }

    function test_swap_back_to_usd() public {
        _go(router, _call(router, 3, address(gloam), 39e18, 0xA3, _route1(direct)));
        uint256 treasuryUsd = usd.balanceOf(treasury);
        Call memory k = _callFrom(router, 4, address(gloam), 39e18, address(usd), 90e6, 0xA4, _route1(direct));
        _go(router, k);
        assertEq(pool.deposited(address(usd)), 3 * NOTE + 90e6);
        assertEq(pool.deposited(address(gloam)), 0);
        assertGt(gloam.balanceOf(treasury), 0, "unspent gloam to the treasury");
        assertEq(usd.balanceOf(treasury), treasuryUsd);
        _assertRouterEmpty();
    }

    // ───────────────────────────────────────────────────────────── what binds

    function test_a_copied_call_with_another_new_note_is_refused() public {
        Call memory k = _call(router, 5, address(gloam), 39e18, 0xA5, _route1(direct));
        // someone copies the owner's proof and swaps the new note for one of their own
        Call memory theirs = k;
        theirs.d = GloamVaultSwap.Deposit(hex"00", bytes32(uint256(0xBADBAD)), address(gloam), 39e18);
        vm.expectRevert(ShieldPoolCore.InvalidProof.selector);
        _go(router, theirs);
        // a different amount, a different refund note, a different route: all refused
        theirs = _call(router, 5, address(gloam), 39e18, 0xA5, _route1(direct));
        theirs.d.amount = 30e18;
        vm.expectRevert(ShieldPoolCore.InvalidProof.selector);
        _go(router, theirs);
        theirs = _call(router, 5, address(gloam), 39e18, 0xA5, _route1(direct));
        theirs.r.commitment = bytes32(uint256(0xBADBAD));
        vm.expectRevert(ShieldPoolCore.InvalidProof.selector);
        _go(router, theirs);
        theirs = _call(router, 5, address(gloam), 39e18, 0xA5, _route1(direct));
        theirs.route = _route2(ethUsd, ethGloam);
        vm.expectRevert(ShieldPoolCore.InvalidProof.selector);
        _go(router, theirs);
        assertFalse(pool.isSpent(bytes32(uint256(5))), "nothing moved");
        // the call as made still goes through, for the owner
        k = _call(router, 5, address(gloam), 39e18, 0xA5, _route1(direct));
        _go(router, k);
        assertTrue(pool.commitmentSeen(bytes32(uint256(0xA5))));
    }

    function test_an_unshield_sent_alone_comes_back_as_the_refund_note() public {
        Call memory k = _call(router, 6, address(gloam), 39e18, 0xA6, _route1(direct));
        // someone sends just the unshield: the money waits at the escrow, which only the router can open
        address escrow = abi.decode(k.s.proof, (address));
        pool.unshield(k.s.proof, k.s.root, k.s.nullifier, k.s.asset, escrow, k.s.amount);
        assertEq(usd.balanceOf(escrow), ARRIVES);

        // the same swap call now puts it back as the owner's refund note
        vm.prank(relayer);
        uint256 spent = _go(router, k);
        assertEq(spent, 0);
        assertTrue(pool.commitmentSeen(k.r.commitment), "refund note in the vault");
        assertFalse(pool.commitmentSeen(k.d.commitment));
        assertEq(usd.balanceOf(escrow), 0);
        assertEq(usd.balanceOf(treasury), ARRIVES - k.r.amount, "only the fee margin, never the note");
        _assertRouterEmpty();
        // and only once
        vm.expectRevert(GloamVaultSwap.BadRefund.selector);
        _go(router, k);
    }

    function test_a_note_spent_elsewhere_has_nothing_to_refund() public {
        Call memory k = _call(router, 7, address(gloam), 39e18, 0xA7, _route1(direct));
        // the owner cashed the note out normally instead
        pool.unshield(abi.encode(address(0xCA5)), k.s.root, k.s.nullifier, k.s.asset, address(0xCA5), k.s.amount);
        vm.expectRevert(GloamVaultSwap.BadRefund.selector);
        _go(router, k);
    }

    function test_a_done_swap_cannot_run_again() public {
        Call memory k = _call(router, 8, address(gloam), 39e18, 0xA8, _route1(direct));
        _go(router, k);
        vm.expectRevert(GloamVaultSwap.BadRefund.selector);
        _go(router, k);
        // money sent to a used escrow later can't reopen it either
        usd.mint(abi.decode(k.s.proof, (address)), 1_000e6);
        vm.expectRevert(GloamVaultSwap.EscrowUsed.selector);
        _go(router, k);
    }

    function test_refund_note_must_be_sane() public {
        Call memory k = _call(router, 9, address(gloam), 39e18, 0xA9, _route1(direct));
        k.r.asset = address(gloam);
        vm.expectRevert(GloamVaultSwap.BadRefund.selector);
        _go(router, k);
        k = _call(router, 9, address(gloam), 39e18, 0xA9, _route1(direct));
        k.r.amount = NOTE + 1;
        vm.expectRevert(GloamVaultSwap.BadRefund.selector);
        _go(router, k);
        k = _call(router, 9, address(gloam), 39e18, 0xA9, _route1(direct));
        k.r.commitment = k.d.commitment;
        vm.expectRevert(GloamVaultSwap.BadRefund.selector);
        _go(router, k);
    }

    // ───────────────────────────────────────────────────────────── routes and amounts

    function test_pool_not_on_the_allowlist_is_refused() public {
        bytes32 id = keccak256(abi.encode(stranger));
        Call memory k = _call(router, 10, address(gloam), 1e18, 0xB0, _route1(stranger));
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwapV4.PoolNotAllowed.selector, id));
        _go(router, k);
        assertFalse(pool.isSpent(bytes32(uint256(10))), "nothing moved");
    }

    function test_route_must_join_the_two_assets() public {
        Call memory k = _call(router, 11, address(gloam), 1e18, 0xB1, _route1(ethGloam)); // starts at eth, not usd
        vm.expectRevert(GloamVaultSwapV4.BadRoute.selector);
        _go(router, k);
        k = _call(router, 11, address(gloam), 1e18, 0xB1, _route1(ethUsd)); // ends at eth
        vm.expectRevert(GloamVaultSwapV4.BadRoute.selector);
        _go(router, k);
        k = _call(router, 11, address(gloam), 1e18, 0xB1, abi.encode(new PoolKey[](0)));
        vm.expectRevert(GloamVaultSwapV4.BadRoute.selector);
        _go(router, k);
        PoolKey[] memory three = new PoolKey[](3);
        three[0] = ethUsd;
        three[1] = ethGloam;
        three[2] = direct;
        k = _call(router, 11, address(gloam), 1e18, 0xB1, abi.encode(three));
        vm.expectRevert(GloamVaultSwapV4.BadRoute.selector);
        _go(router, k);
    }

    function test_needing_more_input_than_the_note_reverts_whole() public {
        // 41 gloam costs 102.5 usd, more than the 99.75 that arrives
        Call memory k = _call(router, 12, address(gloam), 41e18, 0xB2, _route1(direct));
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwap.OverInput.selector, 102_500_000, ARRIVES));
        _go(router, k);
        assertFalse(pool.isSpent(bytes32(uint256(12))), "note still unspent");
        assertEq(pool.deposited(address(usd)), 4 * NOTE);
        _assertRouterEmpty();
    }

    function test_over_the_deposit_limit_reverts_whole() public {
        pool.lowerDepositLimit(address(gloam), 10e18, 250_000e18);
        Call memory k = _call(router, 13, address(gloam), 39e18, 0xB3, _route1(direct));
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector);
        _go(router, k);
        assertFalse(pool.isSpent(bytes32(uint256(13))));
    }

    function test_same_asset_native_and_zero_are_refused() public virtual {
        Call memory k = _call(router, 14, address(usd), 1e6, 0xB4, _route1(direct));
        vm.expectRevert(GloamVaultSwap.SameAsset.selector);
        _go(router, k);
        k = _call(router, 14, address(0), 1e6, 0xB4, _route1(ethUsd));
        vm.expectRevert(GloamVaultSwap.NativeNotSupported.selector);
        _go(router, k);
        k = _call(router, 14, address(gloam), 0, 0xB4, _route1(direct));
        vm.expectRevert(GloamVaultSwap.InvalidAmount.selector);
        _go(router, k);
    }

    function test_unlock_callback_only_from_the_pool_manager_during_a_swap() public {
        vm.expectRevert(GloamVaultSwapV4.NotPoolManager.selector);
        GloamVaultSwapV4(payable(address(router))).unlockCallback("");
        // the pool manager itself, outside a swap
        vm.prank(address(pm));
        vm.expectRevert(GloamVaultSwapV4.NotPoolManager.selector);
        GloamVaultSwapV4(payable(address(router))).unlockCallback("");
    }

    function test_extra_output_goes_to_the_treasury() public {
        pm.setBonusOut(1e18);
        _go(router, _call(router, 15, address(gloam), 39e18, 0xB5, _route1(direct)));
        assertEq(pool.deposited(address(gloam)), 39e18, "the note is worth exactly what was proven");
        assertEq(gloam.balanceOf(treasury), 1e18);
        _assertRouterEmpty();
    }

    function test_a_middle_currency_that_does_not_net_reverts() public {
        // the first hop pays out more eth than the second hop takes: refused, not stranded
        pm.setBonusOut(1);
        Call memory k = _call(router, 16, address(gloam), 39e18, 0xB6, _route2(ethUsd, ethGloam));
        vm.expectRevert(GloamVaultSwapV4.MiddleNotSettled.selector);
        _go(router, k);
    }

    function test_tokens_sent_here_by_mistake_leave_with_the_next_swap() public {
        usd.mint(address(router), 5e6);
        gloam.mint(address(router), 2e18);
        _go(router, _call(router, 17, address(gloam), 39e18, 0xB7, _route1(direct)));
        assertEq(usd.balanceOf(treasury), ARRIVES - 97_500_000 + 5e6);
        assertEq(gloam.balanceOf(treasury), 2e18);
        _assertRouterEmpty();
    }

    function test_reentry_through_a_token_is_refused() public {
        ReenterToken evil = new ReenterToken();
        pool.setDepositLimit(address(evil), 1e30, 1e30);
        evil.mint(address(pm), 1e30);
        (address a, address b) = address(usd) < address(evil) ? (address(usd), address(evil)) : (address(evil), address(usd));
        PoolKey memory k = PoolKey(a, b, 3000, 60, address(0));
        pm.setRate(k, k.currency0 == address(usd), 1, 10 ** 12);
        PoolKey[] memory allow = new PoolKey[](1);
        allow[0] = k;
        GloamVaultSwap r2 = _newRouter(allow);
        Call memory inner = _call(r2, 19, address(evil), 1e18, 0xB9, _route1(k));
        // when the pool manager pays the router, the token re-enters swap()
        evil.arm(address(r2), _swapData(inner));
        Call memory outer = _call(r2, 18, address(evil), 1e18, 0xB8, _route1(k));
        vm.expectRevert(GloamVaultSwap.Reentrancy.selector);
        _go(r2, outer);
        assertFalse(pool.isSpent(bytes32(uint256(18))));
    }

    function test_constructor_checks() public virtual {
        PoolKey[] memory none = new PoolKey[](0);
        vm.expectRevert(GloamVaultSwap.ZeroAddress.selector);
        new GloamVaultSwapV4(address(pool), address(0), address(pm), none);
        vm.expectRevert(GloamVaultSwap.NotAContract.selector);
        new GloamVaultSwapV4(address(0xDEAD), treasury, address(pm), none);
        vm.expectRevert(GloamVaultSwap.NotAContract.selector);
        new GloamVaultSwapV4(address(pool), treasury, address(0xDEAD), none);
        assertTrue(GloamVaultSwapV4(address(router)).allowedPool(keccak256(abi.encode(direct))));
        assertFalse(GloamVaultSwapV4(address(router)).allowedPool(keccak256(abi.encode(stranger))));
    }

    // ───────────────────────────────────────────────────────────── tempo

    function test_tempo_swap_between_stablecoins() public virtual {
        MockERC20 usdt = new MockERC20();
        pool.setDepositLimit(address(usdt), 500e6, 25_000e6);
        MockStableDex dex = new MockStableDex();
        usdt.mint(address(dex), 1_000_000e6);
        GloamVaultSwapTempo t = new GloamVaultSwapTempo(address(pool), treasury, address(dex));

        uint256 want = 99e6; // costs 99.099 at 0.1%
        vm.prank(relayer);
        uint256 spent = _go(t, _call(t, 20, address(usdt), want, 0xC1, ""));
        assertEq(spent, 99_099_000);
        assertEq(pool.deposited(address(usdt)), want);
        assertEq(usd.balanceOf(treasury), ARRIVES - 99_099_000);
        assertEq(usd.balanceOf(address(t)), 0);
        assertEq(usdt.balanceOf(address(t)), 0);
        assertEq(usd.allowance(address(t), address(dex)), 0, "approval cleared");

        Call memory k = _call(t, 21, address(usdt), want, 0xC2, hex"01");
        vm.expectRevert(GloamVaultSwapTempo.BadRoute.selector);
        _go(t, k);

        // the DEX asking for more than arrived: refused whole
        dex.setRate(1_010, 1_000);
        k = _call(t, 22, address(usdt), want, 0xC3, "");
        vm.expectRevert(MockStableDex.MaxInputExceeded.selector);
        _go(t, k);
        assertFalse(pool.isSpent(bytes32(uint256(22))));

        // the DEX paying out short: refused whole
        dex.setRate(1_001, 1_000);
        dex.setShortBy(1);
        k = _call(t, 23, address(usdt), want, 0xC4, "");
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwap.ShortOutput.selector, want - 1, want));
        _go(t, k);
    }
}
