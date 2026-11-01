// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Ported from test/VaultSwapV4b.t.sol to the next vault (not deployed, not audited).
// Keep the two in step until the live vaults are retired.

// GloamVaultSwapV4b (private swaps v2). Every test of the v1 router, its review
// included, runs here against v2 (VaultSwapReviewTestNext is VaultSwapTestNext), then
// the v2 tests: the pool allowlist's governance, ETH through WETH, three-hop
// routes, hostile pools and hooks, refunds of WETH notes, and exact accounting.

import {STRAY} from "./NextHarness.sol";
import {ShieldPoolCore2} from "../../src/ShieldPoolCore2.sol";
import {GloamVaultSwap} from "../../src/GloamVaultSwap.sol";
import {GloamVaultSwapV4, PoolKey} from "../../src/GloamVaultSwapV4.sol";
import {GloamVaultSwapV4b} from "../../src/GloamVaultSwapV4b.sol";
import {MockERC20} from "../MockERC20.sol";
import {MockPoolManager} from "./VaultSwap2.t.sol";
import {VaultSwapReviewTestNext} from "./VaultSwapReview2.t.sol";
import {DeployVaultSwapV4b} from "../../script/DeployVaultSwapV4b.s.sol";

/// WETH as Robinhood Chain has it (Arbitrum's aeWETH): withdraw sends ETH with a plain call.
contract MockWETH {
    string public name = "Wrapped Ether";
    string public symbol = "WETH";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external virtual {
        balanceOf[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "FAIL_TRANSFER");
    }

    receive() external payable {
        deposit();
    }

    function totalSupply() external view returns (uint256) {
        return address(this).balance;
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
        if (allowance[from][msg.sender] != type(uint256).max) allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Mainnet WETH9: withdraw sends ETH with transfer(), a 2300 gas stipend.
contract MockWETH9 is MockWETH {
    function withdraw(uint256 amount) external override {
        balanceOf[msg.sender] -= amount;
        payable(msg.sender).transfer(amount);
    }
}

/// A hook that does whatever it is armed with during a swap, and records how that went.
contract HostileHook {
    address public target;
    bytes public payload;
    bool public tried;
    bool public lastOk;
    bytes public lastRet;
    // push ETH to `ethTo` through the pool manager, then pay for it
    address public pm;
    address public ethTo;
    uint256 public ethAmount;

    receive() external payable {}

    function arm(address t, bytes calldata p) external {
        target = t;
        payload = p;
    }

    function armEthPush(address pm_, address to, uint256 amount) external {
        pm = pm_;
        ethTo = to;
        ethAmount = amount;
    }

    function onSwap() external {
        if (target != address(0) && !tried) {
            tried = true;
            (lastOk, lastRet) = target.call(payload);
        }
        if (ethAmount != 0) {
            uint256 a = ethAmount;
            ethAmount = 0;
            MockPoolManager(payable(pm)).take(address(0), ethTo, a);
            MockPoolManager(payable(pm)).sync(address(0));
            MockPoolManager(payable(pm)).settle{value: a}();
        }
    }
}

contract VaultSwapV4bTestNext is VaultSwapReviewTestNext {
    MockWETH weth;
    MockERC20 stock; // a third token, for three hops
    address owner = address(this);

    PoolKey usdStock; // usd / stock, no hook
    PoolKey wethUsd; // WETH (the ERC20) / usd, no hook
    PoolKey wethGloam; // WETH / gloam, no hook

    uint256 constant WNOTE = 0.05 ether;
    uint256 constant WARRIVES = WNOTE - (WNOTE * 25) / 10_000;

    function _v2() internal view returns (GloamVaultSwapV4b) {
        return GloamVaultSwapV4b(payable(address(router)));
    }

    /// Every inherited test deploys v2 through here.
    function _newRouter(PoolKey[] memory allow) internal override returns (GloamVaultSwap) {
        if (address(weth) == address(0)) weth = new MockWETH();
        return new GloamVaultSwapV4b(address(pool), treasury, address(pm), address(weth), owner, allow);
    }

    function setUp() public override {
        super.setUp();
        stock = new MockERC20();
        pool.setDepositLimit(address(weth), 10 ether, 100 ether);
        pool.setDepositLimit(address(stock), 1_000e18, 100_000e18);
        stock.mint(address(pm), 1_000_000e18);
        vm.deal(address(pm), 10_000 ether);

        // WETH notes in the vault: a depositor wraps ETH and shields it
        vm.deal(depositor, 100 ether);
        vm.startPrank(depositor);
        weth.deposit{value: 10 ether}();
        weth.approve(address(pool), type(uint256).max);
        for (uint256 i = 0; i < 4; i++) pool.shieldBound(address(weth), WNOTE, bytes32(uint256(0xE7E7 + i)), hex"00");
        vm.stopPrank();
        weth.deposit{value: 1 ether}();
        weth.transfer(address(pm), 1 ether); // WETH liquidity for the ERC20 WETH pools

        usdStock = _sorted(address(usd), address(stock), 500, 10);
        wethUsd = _sorted(address(weth), address(usd), 200, 4);
        wethGloam = _sorted(address(weth), address(gloam), 3000, 60);
        // 1 stock = 200 usd; WETH at 2400 usd and 1000 gloam, like ETH
        _rate(usdStock, address(usd), 200, 10 ** 12);
        _rate(usdStock, address(stock), 10 ** 12, 200);
        _rate(wethUsd, address(usd), 2400, 10 ** 12);
        _rate(wethUsd, address(weth), 10 ** 12, 2400);
        _rate(wethGloam, address(weth), 1, 1000);
        _rate(wethGloam, address(gloam), 1000, 1);

        // added the governed way: queued, then live once the delay has passed
        _v2().queuePool(usdStock);
        _v2().queuePool(wethUsd);
        _v2().queuePool(wethGloam);
        vm.warp(block.timestamp + 3 days);
    }

    function _sorted(address a, address b, uint24 fee, int24 ts) internal pure returns (PoolKey memory) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return PoolKey(c0, c1, fee, ts, address(0));
    }

    function _route3(PoolKey memory k0, PoolKey memory k1, PoolKey memory k2) internal pure returns (bytes memory) {
        PoolKey[] memory r = new PoolKey[](3);
        r[0] = k0;
        r[1] = k1;
        r[2] = k2;
        return abi.encode(r);
    }

    function _id(PoolKey memory k) internal pure returns (bytes32) {
        return keccak256(abi.encode(k));
    }

    function _assertRouterEmpty() internal view override {
        super._assertRouterEmpty();
        assertEq(weth.balanceOf(address(router)), 0, "router keeps no WETH");
        assertEq(stock.balanceOf(address(router)), 0, "router keeps no stock");
        assertEq(weth.allowance(address(router), address(pool)), 0);
        assertEq(stock.allowance(address(router), address(pool)), 0);
    }

    /// The vault holds at least what backs its notes and owed fees, for every asset.
    function _assertVaultBacked() internal view {
        address[4] memory assets = [address(usd), address(gloam), address(weth), address(stock)];
        for (uint256 i = 0; i < 4; i++) {
            uint256 bal = MockERC20(assets[i]).balanceOf(address(pool));
            assertGe(bal, pool.deposited(assets[i]) + pool.feesOwed(assets[i]), "vault backs every note");
        }
    }

    /// Nothing moved: the note is unspent and the vault holds what it held.
    function _assertNothingMoved(Call memory k, uint256 depositedIn) internal view {
        assertFalse(pool.isSpent(k.s.nullifier), "note still unspent");
        assertFalse(pool.commitmentSeen(k.d.commitment));
        assertFalse(pool.commitmentSeen(k.r.commitment));
        assertEq(pool.deposited(k.s.asset), depositedIn);
        _assertRouterEmpty();
    }

    // ═════════════════════════════════════════════════════════════ ported, adjusted

    /// v1's constructor test, for v2's constructor.
    function test_constructor_checks() public override {
        PoolKey[] memory none = new PoolKey[](0);
        vm.expectRevert(GloamVaultSwap.ZeroAddress.selector);
        new GloamVaultSwapV4b(address(pool), address(0), address(pm), address(weth), owner, none);
        vm.expectRevert(GloamVaultSwap.ZeroAddress.selector);
        new GloamVaultSwapV4b(address(pool), treasury, address(pm), address(0), owner, none);
        vm.expectRevert(GloamVaultSwap.ZeroAddress.selector);
        new GloamVaultSwapV4b(address(pool), treasury, address(pm), address(weth), address(0), none);
        vm.expectRevert(GloamVaultSwap.NotAContract.selector);
        new GloamVaultSwapV4b(address(0xDEAD), treasury, address(pm), address(weth), owner, none);
        vm.expectRevert(GloamVaultSwap.NotAContract.selector);
        new GloamVaultSwapV4b(address(pool), treasury, address(0xDEAD), address(weth), owner, none);
        vm.expectRevert(GloamVaultSwap.NotAContract.selector);
        new GloamVaultSwapV4b(address(pool), treasury, address(pm), address(0xDEAD), owner, none);
        PoolKey[] memory bad = new PoolKey[](1);
        bad[0] = PoolKey(address(gloam), address(0), 0, 1, address(0)); // unsorted
        vm.expectRevert(GloamVaultSwapV4b.BadPool.selector);
        new GloamVaultSwapV4b(address(pool), treasury, address(pm), address(weth), owner, bad);

        assertTrue(_v2().allowedPool(_id(direct)));
        assertFalse(_v2().allowedPool(_id(stranger)));
        assertEq(address(_v2().vault()), address(pool));
        assertEq(_v2().treasury(), treasury);
        assertEq(address(_v2().poolManager()), address(pm));
        assertEq(_v2().weth(), address(weth));
        assertEq(_v2().owner(), owner);
    }

    // ═════════════════════════════════════════════════════════════ the allowlist

    function test_v2_constructor_pools_are_live_at_once() public {
        PoolKey[] memory allow = new PoolKey[](1);
        allow[0] = direct;
        GloamVaultSwapV4b r = GloamVaultSwapV4b(payable(address(_newRouter(allow))));
        assertEq(r.poolLiveAt(_id(direct)), block.timestamp);
        assertTrue(r.allowedPool(_id(direct)));
        assertFalse(r.allowedPool(_id(ethUsd)));
        assertEq(r.POOL_DELAY(), 3 days);
        assertEq(r.MAX_HOPS(), 3);
    }

    function test_v2_a_queued_pool_is_refused_until_the_delay_has_passed() public {
        PoolKey memory cheap = _sorted(address(usd), address(gloam), 500, 10);
        _rate(cheap, address(usd), 25, 10 ** 13);
        bytes32 id = _id(cheap);
        vm.expectEmit(true, false, false, true, address(router));
        emit GloamVaultSwapV4b.PoolQueued(id, cheap.currency0, cheap.currency1, 500, 10, address(0), block.timestamp + 3 days);
        _v2().queuePool(cheap);
        uint256 liveAt = _v2().poolLiveAt(id);
        assertEq(liveAt, block.timestamp + 3 days);

        Call memory k = _call(router, 900, address(gloam), 39e18, 0x900, _route1(cheap));
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwapV4.PoolNotAllowed.selector, id));
        _go(router, k);
        _assertNothingMoved(k, 4 * NOTE);

        vm.warp(liveAt - 1);
        assertFalse(_v2().allowedPool(id));
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwapV4.PoolNotAllowed.selector, id));
        _go(router, k);

        vm.warp(liveAt);
        assertTrue(_v2().allowedPool(id));
        _go(router, k);
        assertTrue(pool.commitmentSeen(k.d.commitment), "usable from liveAt");
        _assertRouterEmpty();
    }

    function test_v2_only_the_owner_queues_and_removes() public {
        PoolKey memory cheap = _sorted(address(usd), address(gloam), 500, 10);
        vm.startPrank(outsider);
        vm.expectRevert(GloamVaultSwapV4b.NotOwner.selector);
        _v2().queuePool(cheap);
        vm.expectRevert(GloamVaultSwapV4b.NotOwner.selector);
        _v2().removePool(_id(direct));
        vm.expectRevert(GloamVaultSwapV4b.NotOwner.selector);
        _v2().transferOwnership(outsider);
        vm.stopPrank();
        assertTrue(_v2().allowedPool(_id(direct)));
    }

    function test_v2_queue_refuses_a_listed_or_unsorted_pool() public {
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwapV4b.PoolListed.selector, _id(direct)));
        _v2().queuePool(direct);
        PoolKey memory cheap = _sorted(address(usd), address(gloam), 500, 10);
        _v2().queuePool(cheap);
        // queueing again can't move the time it goes live
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwapV4b.PoolListed.selector, _id(cheap)));
        _v2().queuePool(cheap);
        vm.expectRevert(GloamVaultSwapV4b.BadPool.selector);
        _v2().queuePool(PoolKey(cheap.currency1, cheap.currency0, 500, 10, address(0)));
        vm.expectRevert(GloamVaultSwapV4b.BadPool.selector);
        _v2().queuePool(PoolKey(address(usd), address(usd), 500, 10, address(0)));
    }

    function test_v2_removal_is_instant_and_a_new_queue_waits_again() public {
        bytes32 id = _id(direct);
        vm.expectEmit(true, false, false, false, address(router));
        emit GloamVaultSwapV4b.PoolRemoved(id);
        _v2().removePool(id);
        assertEq(_v2().poolLiveAt(id), 0);
        Call memory k = _call(router, 901, address(gloam), 39e18, 0x901, _route1(direct));
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwapV4.PoolNotAllowed.selector, id));
        _go(router, k);
        _assertNothingMoved(k, 4 * NOTE);
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwapV4b.PoolNotListed.selector, id));
        _v2().removePool(id);

        // back on the list only through the queue
        _v2().queuePool(direct);
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwapV4.PoolNotAllowed.selector, id));
        _go(router, k);
        // a queued pool removed before it goes live never does
        _v2().removePool(id);
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwapV4.PoolNotAllowed.selector, id));
        _go(router, k);
        _v2().queuePool(direct);
        vm.warp(block.timestamp + 3 days);
        _go(router, k);
        assertTrue(pool.commitmentSeen(k.d.commitment));
    }

    /// The refund path never reads the allowlist: a griefed swap whose pool was
    /// removed (or whose route never was allowed) still comes back whole.
    function test_v2_a_removed_pool_never_blocks_a_refund() public {
        Call memory k = _call(router, 902, address(gloam), 39e18, 0x902, _route1(direct));
        pool.unshield(k.s.proof, k.s.root, k.s.nullifier, k.s.asset, _escrow(k), k.s.amount);
        _v2().removePool(_id(direct));
        _v2().removePool(_id(ethUsd));
        vm.prank(relayer);
        assertEq(_go(router, k), 0);
        assertTrue(pool.commitmentSeen(k.r.commitment), "the refund landed");
        assertEq(usd.balanceOf(_escrow(k)), 0);
        _assertRouterEmpty();

        Call memory never = _call(router, 903, address(gloam), 1e18, 0x903, _route1(stranger));
        pool.unshield(never.s.proof, never.s.root, never.s.nullifier, never.s.asset, _escrow(never), never.s.amount);
        _go(router, never);
        assertTrue(pool.commitmentSeen(never.r.commitment));
        _assertRouterEmpty();
    }

    function test_v2_ownership_is_two_step() public {
        address next = address(0x0E1);
        vm.expectRevert(GloamVaultSwap.ZeroAddress.selector);
        _v2().transferOwnership(address(0));
        _v2().transferOwnership(next);
        assertEq(_v2().owner(), owner, "nothing changes until accepted");
        assertEq(_v2().pendingOwner(), next);
        vm.prank(outsider);
        vm.expectRevert(GloamVaultSwapV4b.NotPendingOwner.selector);
        _v2().acceptOwnership();
        vm.prank(next);
        _v2().acceptOwnership();
        assertEq(_v2().owner(), next);
        assertEq(_v2().pendingOwner(), address(0));
        vm.expectRevert(GloamVaultSwapV4b.NotOwner.selector);
        _v2().removePool(_id(direct));
        vm.prank(next);
        _v2().removePool(_id(direct));
    }

    /// The deploy script's pools are the app's (lib/vaultSwap RH_SWAP_POOLS_V2): both must equal
    /// the fixture, in order (selftest-vault-swap checks the app's side), sorted as v4 keys
    /// must be, with no pool twice.
    function test_v2_deploy_script_pools_are_the_apps() public {
        PoolKey[] memory p = new DeployVaultSwapV4b().pools();
        bytes32[] memory ids = vm.parseJsonBytes32Array(vm.readFile("test/fixtures/vault-swap-v2-pools.json"), ".poolIds");
        assertEq(p.length, ids.length);
        for (uint256 i = 0; i < p.length; i++) {
            assertEq(_id(p[i]), ids[i]);
            assertLt(uint160(p[i].currency0), uint160(p[i].currency1));
            assertTrue(p[i].hooks != 0x958541C0Ce2E1A158309f7d1b141963eDa31C880, "banned hook");
            for (uint256 j = 0; j < i; j++) assertTrue(ids[j] != ids[i], "a pool twice");
        }
        // and the router takes them all at deploy
        GloamVaultSwapV4b r = GloamVaultSwapV4b(payable(address(_newRouter(p))));
        for (uint256 i = 0; i < p.length; i++) assertTrue(r.allowedPool(ids[i]));
    }

    // ═════════════════════════════════════════════════════════════ ETH through WETH

    /// USDG -> WETH on a native ETH pool: the router takes ETH and wraps all of it.
    function test_v2_usdg_to_weth_through_a_native_pool() public {
        uint256 want = 0.04 ether; // 96 usd at 2400
        Call memory k = _call(router, 910, address(weth), want, 0x910, _route1(ethUsd));
        uint256 pmEth = address(pm).balance;
        vm.prank(relayer);
        uint256 spent = _go(router, k);
        assertEq(spent, 96e6);
        assertEq(pool.deposited(address(weth)), 4 * WNOTE + want, "the new WETH note, exactly");
        assertEq(weth.balanceOf(address(pool)), 4 * WNOTE + want);
        assertEq(address(pm).balance, pmEth - want, "paid out in ETH");
        assertEq(usd.balanceOf(treasury), ARRIVES - 96e6);
        assertEq(address(router).balance, 0, "no ETH left");
        assertEq(usd.balanceOf(_escrow(k)), 0, "escrow empty");
        _assertRouterEmpty();
        _assertVaultBacked();
    }

    /// WETH -> USDG on a native ETH pool: the router unwraps exactly what the pool asks.
    function test_v2_weth_to_usdg_through_a_native_pool() public {
        uint256 want = 110e6; // costs 110 / 2400 eth
        uint256 cost = (want * 10 ** 12 + 2400 - 1) / 2400;
        Call memory k = _callFrom(router, 911, address(weth), WNOTE, address(usd), want, 0x911, _route1(ethUsd));
        uint256 pmEth = address(pm).balance;
        uint256 wethSupply = weth.totalSupply();
        vm.prank(relayer);
        uint256 spent = _go(router, k);
        assertEq(spent, cost);
        assertEq(address(pm).balance, pmEth + cost, "paid in ETH");
        assertEq(weth.totalSupply(), wethSupply - cost, "exactly that much unwrapped");
        assertEq(pool.deposited(address(usd)), 4 * NOTE + want);
        assertEq(pool.deposited(address(weth)), 3 * WNOTE);
        assertEq(weth.balanceOf(treasury), WARRIVES - cost, "leftover WETH to the treasury");
        assertEq(weth.balanceOf(_escrow(k)), 0);
        _assertRouterEmpty();
        _assertVaultBacked();
    }

    /// WETH on a pool that holds WETH itself: no wrapping at all.
    function test_v2_weth_to_usdg_through_a_weth_pool() public {
        uint256 want = 110e6;
        uint256 cost = (want * 10 ** 12 + 2400 - 1) / 2400;
        Call memory k = _callFrom(router, 912, address(weth), WNOTE, address(usd), want, 0x912, _route1(wethUsd));
        uint256 wethSupply = weth.totalSupply();
        uint256 pmWeth = weth.balanceOf(address(pm));
        _go(router, k);
        assertEq(weth.totalSupply(), wethSupply, "nothing unwrapped");
        assertEq(weth.balanceOf(address(pm)), pmWeth + cost);
        assertEq(pool.deposited(address(usd)), 4 * NOTE + want);
        assertEq(weth.balanceOf(treasury), WARRIVES - cost);
        _assertRouterEmpty();

        // and back: USDG -> WETH on the same pool
        Call memory b = _call(router, 913, address(weth), 0.04 ether, 0x913, _route1(wethUsd));
        _go(router, b);
        assertEq(weth.totalSupply(), wethSupply, "still nothing wrapped");
        assertEq(pool.deposited(address(weth)), 3 * WNOTE + 0.04 ether);
        _assertRouterEmpty();
        _assertVaultBacked();
    }

    function test_v2_gloam_to_weth_and_back_through_the_eth_gloam_pool() public {
        // 39 gloam in the vault first
        _go(router, _call(router, 914, address(gloam), 39e18, 0x914, _route1(direct)));
        Call memory k = _callFrom(router, 915, address(gloam), 39e18, address(weth), 0.035 ether, 0x915, _route1(ethGloam));
        _go(router, k);
        assertEq(pool.deposited(address(weth)), 4 * WNOTE + 0.035 ether);
        assertEq(pool.deposited(address(gloam)), 0);
        _assertRouterEmpty();

        Call memory b = _callFrom(router, 916, address(weth), WNOTE, address(gloam), 45e18, 0x916, _route1(ethGloam));
        _go(router, b);
        assertEq(pool.deposited(address(gloam)), 45e18);
        assertEq(weth.balanceOf(treasury), WARRIVES - 0.045 ether);
        _assertRouterEmpty();
        _assertVaultBacked();
    }

    /// Mainnet-style WETH9 pays a withdrawal with a 2300 gas stipend: the router's receive fits.
    function test_v2_works_with_weth9s_gas_stipend() public {
        MockWETH9 w9 = new MockWETH9();
        weth = w9;
        PoolKey[] memory allow = new PoolKey[](1);
        allow[0] = ethUsd;
        GloamVaultSwap r = _newRouter(allow);
        pool.setDepositLimit(address(w9), 10 ether, 100 ether);
        vm.startPrank(depositor);
        w9.deposit{value: 1 ether}();
        w9.approve(address(pool), type(uint256).max);
        pool.shieldBound(address(w9), WNOTE, bytes32(uint256(0x9999)), hex"00");
        vm.stopPrank();

        Call memory k = _callFrom(r, 917, address(w9), WNOTE, address(usd), 110e6, 0x917, _route1(ethUsd));
        _go(r, k);
        assertEq(pool.deposited(address(usd)), 4 * NOTE + 110e6);
        assertEq(address(r).balance, 0);
        assertEq(w9.balanceOf(address(r)), 0);
        Call memory b = _callFrom(r, 918, address(usd), NOTE, address(w9), 0.04 ether, 0x918, _route1(ethUsd));
        _go(r, b);
        assertEq(pool.deposited(address(w9)), 0.04 ether);
        assertEq(address(r).balance, 0);
    }

    function test_v2_router_takes_eth_only_during_a_swap_from_weth_or_the_pool_manager() public {
        vm.deal(outsider, 1 ether);
        vm.prank(outsider);
        (bool ok, bytes memory ret) = address(router).call{value: 1}("");
        assertFalse(ok);
        assertEq(bytes4(ret), GloamVaultSwapV4b.NativeRefused.selector);
        vm.deal(address(weth), 1 ether);
        vm.prank(address(weth));
        (ok, ret) = address(router).call{value: 1}("");
        assertFalse(ok, "not outside a swap, even from WETH");
        vm.deal(address(pm), 1 ether);
        vm.prank(address(pm));
        (ok, ret) = address(router).call{value: 1}("");
        assertFalse(ok, "nor from the pool manager");
    }

    // ═════════════════════════════════════════════════════════════ routes

    /// Token to token in three hops, with two middle currencies (ETH and USDG) netting inside the lock.
    function test_v2_three_hops_token_to_token() public {
        _go(router, _call(router, 920, address(gloam), 39e18, 0x920, _route1(direct)));
        // gloam -> eth -> usd -> stock: 0.4 stock = 80 usd = 1/30 eth = 33.34 gloam
        uint256 want = 0.4e18;
        Call memory k = _callFrom(router, 921, address(gloam), 39e18, address(stock), want, 0x921, _route3(ethGloam, ethUsd, usdStock));
        uint256 pmEth = address(pm).balance;
        uint256 pmUsd = usd.balanceOf(address(pm));
        uint256 spent = _go(router, k);
        uint256 ethMid = (uint256(80e6) * 10 ** 12 + 2400 - 1) / 2400;
        assertEq(spent, ethMid * 1000, "gloam paid for the eth the usd hop needed");
        assertEq(address(pm).balance, pmEth, "the middle ETH never left the pool manager");
        assertEq(usd.balanceOf(address(pm)), pmUsd, "nor the middle USDG");
        assertEq(pool.deposited(address(stock)), want);
        assertEq(gloam.balanceOf(treasury), 39e18 - (39e18 * 25) / 10_000 - spent);
        _assertRouterEmpty();
        _assertVaultBacked();
    }

    /// Three hops out of WETH: unwrapped at the first pool, then two token pools.
    function test_v2_three_hops_from_weth() public {
        // weth -> (eth) gloam -> usd -> stock
        uint256 want = 0.5e18; // 100 usd = 40 gloam = 0.04 eth
        Call memory k = _callFrom(router, 922, address(weth), WNOTE, address(stock), want, 0x922, _route3(ethGloam, direct, usdStock));
        uint256 spent = _go(router, k);
        assertEq(spent, 0.04 ether);
        assertEq(pool.deposited(address(stock)), want);
        assertEq(weth.balanceOf(treasury), WARRIVES - 0.04 ether);
        _assertRouterEmpty();
        _assertVaultBacked();
    }

    function test_v2_four_hops_are_refused() public {
        PoolKey[] memory four = new PoolKey[](4);
        four[0] = direct;
        four[1] = ethGloam;
        four[2] = ethUsd;
        four[3] = usdStock;
        Call memory k = _call(router, 923, address(stock), 1e18, 0x923, abi.encode(four));
        vm.expectRevert(GloamVaultSwapV4.BadRoute.selector);
        _go(router, k);
        _assertNothingMoved(k, 4 * NOTE);
    }

    function test_v2_a_route_that_comes_back_to_a_currency_is_refused() public {
        // usd -> gloam -> usd -> stock: the same pool twice, usd twice
        Call memory k = _call(router, 924, address(stock), 0.1e18, 0x924, _route3(direct, direct, usdStock));
        vm.expectRevert(GloamVaultSwapV4.BadRoute.selector);
        _go(router, k);
        // usd -> eth -> gloam -> eth? ends wrong anyway; usd -> eth -> usd -> stock revisits usd
        k = _call(router, 924, address(stock), 0.1e18, 0x924, _route3(ethUsd, ethUsd, usdStock));
        vm.expectRevert(GloamVaultSwapV4.BadRoute.selector);
        _go(router, k);
        _assertNothingMoved(k, 4 * NOTE);
    }

    /// When WETH is unwrapped or wrapped at an end, it can't also be inside the route.
    function test_v2_weth_inside_a_wrapping_route_is_refused() public {
        // weth -(unwrap)-> eth -> usd -> weth -> gloam
        Call memory k = _callFrom(router, 925, address(weth), WNOTE, address(gloam), 1e18, 0x925, _route3(ethUsd, wethUsd, wethGloam));
        vm.expectRevert(GloamVaultSwapV4.BadRoute.selector);
        _go(router, k);
        // usd -> weth -> gloam -> eth, wrapped to weth at the end
        k = _call(router, 926, address(weth), 0.001 ether, 0x926, _route3(wethUsd, wethGloam, ethGloam));
        vm.expectRevert(GloamVaultSwapV4.BadRoute.selector);
        _go(router, k);
        _assertNothingMoved(k, 4 * NOTE);
    }

    function test_v2_route_must_start_at_the_note_and_end_at_the_new_note() public {
        // a USDG note can't start at an ETH pool: only a WETH note pays in ETH
        Call memory k = _call(router, 927, address(gloam), 1e18, 0x927, _route1(ethGloam));
        vm.expectRevert(GloamVaultSwapV4.BadRoute.selector);
        _go(router, k);
        // a route ending at ETH is wrapped only into a WETH note
        k = _call(router, 928, address(stock), 1e18, 0x928, _route1(ethUsd));
        vm.expectRevert(GloamVaultSwapV4.BadRoute.selector);
        _go(router, k);
        // a WETH note on a pool with neither WETH nor ETH
        k = _callFrom(router, 929, address(weth), WNOTE, address(gloam), 1e18, 0x929, _route1(direct));
        vm.expectRevert(GloamVaultSwapV4.BadRoute.selector);
        _go(router, k);
        // a malformed route
        k = _call(router, 930, address(gloam), 1e18, 0x930, hex"1234");
        vm.expectRevert();
        _go(router, k);
        _assertNothingMoved(k, 4 * NOTE);
    }

    /// The proof binds the route: the same WETH swap through a WETH pool instead of the
    /// native one (or the other way round) is another escrow, and the vault refuses it.
    function test_v2_a_copied_weth_swap_with_another_route_is_refused() public {
        Call memory k = _callFrom(router, 931, address(weth), WNOTE, address(usd), 110e6, 0x931, _route1(ethUsd));
        Call memory theirs = _callFrom(router, 931, address(weth), WNOTE, address(usd), 110e6, 0x931, _route1(wethUsd));
        theirs.s.proof = k.s.proof;
        vm.expectRevert(ShieldPoolCore2.InvalidProof.selector);
        _go(router, theirs);
        _go(router, k);
        assertTrue(pool.commitmentSeen(k.d.commitment));
    }

    // ═════════════════════════════════════════════════════════════ hostile pools and hooks

    /// A pool may charge up to everything that arrived: the new note is still exact, and
    /// the most it takes is the leftover the treasury would have had. Never the vault's.
    function test_v2_a_pool_charging_everything_that_arrived_takes_only_the_leftover() public {
        uint256 want = 39e18;
        uint256 fair = 97_500_000;
        pm.setExtraIn(ARRIVES - fair);
        Call memory k = _call(router, 940, address(gloam), want, 0x940, _route1(direct));
        uint256 spent = _go(router, k);
        assertEq(spent, ARRIVES, "the whole input, and no more");
        assertEq(pool.deposited(address(gloam)), want, "the new note is exactly what was proven");
        assertEq(pool.deposited(address(usd)), 3 * NOTE, "only the spent note left the vault");
        assertEq(usd.balanceOf(treasury), 0, "the leftover went to the pool");
        _assertRouterEmpty();
        _assertVaultBacked();
    }

    function test_v2_a_pool_charging_one_unit_more_than_arrived_moves_nothing() public {
        pm.setExtraIn(ARRIVES - 97_500_000 + 1);
        Call memory k = _call(router, 941, address(gloam), 39e18, 0x941, _route1(direct));
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwap.OverInput.selector, ARRIVES + 1, ARRIVES));
        _go(router, k);
        _assertNothingMoved(k, 4 * NOTE);
        // the same for a WETH note through ETH: one wei over and nothing moves
        uint256 cost = (uint256(110e6) * 10 ** 12 + 2400 - 1) / 2400;
        pm.setExtraIn(WARRIVES - cost + 1);
        k = _callFrom(router, 942, address(weth), WNOTE, address(usd), 110e6, 0x942, _route1(ethUsd));
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwap.OverInput.selector, WARRIVES + 1, WARRIVES));
        _go(router, k);
        _assertNothingMoved(k, 4 * WNOTE);
    }

    function test_v2_a_pool_paying_out_short_moves_nothing() public {
        pm.setShortOut(1);
        Call memory k = _call(router, 943, address(weth), 0.04 ether, 0x943, _route1(ethUsd));
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwap.ShortOutput.selector, 0.04 ether - 1, 0.04 ether));
        _go(router, k);
        _assertNothingMoved(k, 4 * NOTE);
    }

    function test_v2_a_hook_cannot_pull_the_routers_tokens() public {
        HostileHook h = new HostileHook();
        pm.setHook(address(h));
        h.arm(address(usd), abi.encodeWithSelector(MockERC20.transferFrom.selector, address(router), address(h), 1));
        Call memory k = _call(router, 944, address(gloam), 39e18, 0x944, _route1(direct));
        _go(router, k);
        assertTrue(h.tried());
        assertFalse(h.lastOk(), "no allowance to anyone");
        assertEq(usd.balanceOf(address(h)), 0);
        assertEq(usd.balanceOf(treasury), ARRIVES - 97_500_000);
        _assertRouterEmpty();
    }

    function test_v2_a_hook_cannot_reenter_the_router() public {
        HostileHook h = new HostileHook();
        pm.setHook(address(h));
        Call memory other = _call(router, 945, address(gloam), 39e18, 0x945, _route1(direct));
        h.arm(address(router), abi.encodeCall(GloamVaultSwap.swap, (other.s, other.d, other.r, other.route)));
        Call memory k = _call(router, 946, address(gloam), 39e18, 0x946, _route1(direct));
        _go(router, k);
        assertFalse(h.lastOk());
        assertEq(bytes4(h.lastRet()), GloamVaultSwap.Reentrancy.selector);
        assertFalse(pool.isSpent(other.s.nullifier), "the other note untouched");
        assertTrue(pool.commitmentSeen(k.d.commitment), "the swap itself went through");

        HostileHook h2 = new HostileHook();
        pm.setHook(address(h2));
        h2.arm(address(router), abi.encodeCall(GloamVaultSwapV4b.unlockCallback, (bytes(""))));
        _go(router, _call(router, 947, address(gloam), 39e18, 0x947, _route1(direct)));
        assertFalse(h2.lastOk());
        assertEq(bytes4(h2.lastRet()), GloamVaultSwapV4.NotPoolManager.selector);
        _assertRouterEmpty();
    }

    /// A hook that pushes ETH to the router mid-swap: the router keeps no ETH. It is
    /// wrapped, and the WETH leaves with the next WETH swap.
    function test_v2_eth_pushed_to_the_router_is_wrapped_and_swept() public {
        HostileHook h = new HostileHook();
        vm.deal(address(h), 1 ether);
        pm.setHook(address(h));
        h.armEthPush(address(pm), address(router), 0.3 ether);
        _go(router, _call(router, 948, address(gloam), 39e18, 0x948, _route1(direct)));
        assertEq(address(router).balance, 0, "no ETH stays");
        assertEq(weth.balanceOf(address(router)), 0.3 ether, "wrapped, waiting for a WETH sweep");
        pm.setHook(address(0));
        _go(router, _callFrom(router, 949, address(weth), WNOTE, address(usd), 110e6, 0x949, _route1(ethUsd)));
        uint256 cost = (uint256(110e6) * 10 ** 12 + 2400 - 1) / 2400;
        assertEq(weth.balanceOf(treasury), WARRIVES - cost + 0.3 ether);
        _assertRouterEmpty();
    }

    // ═════════════════════════════════════════════════════════════ griefing and refunds

    function test_v2_a_weth_unshield_sent_alone_comes_back_as_the_refund_note() public {
        Call memory k = _callFrom(router, 950, address(weth), WNOTE, address(usd), 110e6, 0x950, _route1(ethUsd));
        pool.unshield(k.s.proof, k.s.root, k.s.nullifier, k.s.asset, _escrow(k), k.s.amount);
        assertEq(weth.balanceOf(_escrow(k)), WARRIVES);
        uint256 supply = weth.totalSupply();
        vm.prank(relayer);
        assertEq(_go(router, k), 0);
        assertTrue(pool.commitmentSeen(k.r.commitment), "refund note in the vault");
        assertFalse(pool.commitmentSeen(k.d.commitment));
        assertEq(pool.deposited(address(weth)), 3 * WNOTE + k.r.amount);
        assertEq(weth.balanceOf(_escrow(k)), 0);
        assertEq(weth.balanceOf(treasury), WARRIVES - k.r.amount, "only the fee margin");
        assertEq(weth.totalSupply(), supply, "a refund never touches a pool or unwraps");
        _assertRouterEmpty();
        vm.expectRevert(GloamVaultSwap.BadRefund.selector);
        _go(router, k);
    }

    function test_v2_a_weth_swap_that_reverts_lands_later_as_the_refund() public {
        // a price that needs more than arrived: the relay's call reverts whole
        Call memory k = _callFrom(router, 951, address(weth), WNOTE, address(usd), 200e6, 0x951, _route1(ethUsd));
        vm.expectRevert();
        _go(router, k);
        assertFalse(pool.isSpent(k.s.nullifier));
        // then someone lands the unshield alone and calls the router
        vm.startPrank(outsider);
        pool.unshield(k.s.proof, k.s.root, k.s.nullifier, k.s.asset, _escrow(k), k.s.amount);
        _go(router, k);
        vm.stopPrank();
        assertTrue(pool.commitmentSeen(k.r.commitment));
        _assertRouterEmpty();
    }

    // ═════════════════════════════════════════════════════════════ accounting

    /// Any amount, any price, either direction through ETH: the swap lands with
    /// exact accounting and an empty router and escrow, or nothing moves.
    function testFuzz_v2_weth_swaps_account_exactly(uint256 want, uint256 price, bool toWeth) public {
        price = bound(price, 1_000, 5_000); // usd per eth
        _rate(ethUsd, address(usd), price, 10 ** 12);
        _rate(ethUsd, address(0), 10 ** 12, price);
        Call memory k;
        uint256 arrives;
        if (toWeth) {
            want = bound(want, 1, 0.1 ether);
            k = _call(router, 960, address(weth), want, 0x960, _route1(ethUsd));
            arrives = ARRIVES;
        } else {
            want = bound(want, 1, 300e6);
            k = _callFrom(router, 961, address(weth), WNOTE, address(usd), want, 0x961, _route1(ethUsd));
            arrives = WARRIVES;
        }
        address assetIn = k.s.asset;
        uint256 inBefore = pool.deposited(assetIn);
        uint256 outBefore = pool.deposited(k.d.asset);
        uint256 cost = toWeth ? (want * price + 10 ** 12 - 1) / 10 ** 12 : (want * 10 ** 12 + price - 1) / price;
        if (cost > arrives) {
            vm.expectRevert(abi.encodeWithSelector(GloamVaultSwap.OverInput.selector, cost, arrives));
            _go(router, k);
            _assertNothingMoved(k, inBefore);
            return;
        }
        uint256 treasuryBefore = MockERC20(assetIn).balanceOf(treasury);
        assertEq(_go(router, k), cost);
        assertEq(pool.deposited(assetIn), inBefore - k.s.amount);
        assertEq(pool.deposited(k.d.asset), outBefore + want);
        assertEq(MockERC20(assetIn).balanceOf(treasury) - treasuryBefore, arrives - cost, "every unit accounted");
        assertEq(MockERC20(assetIn).balanceOf(_escrow(k)), 0);
        assertEq(address(router).balance, 0);
        _assertRouterEmpty();
        _assertVaultBacked();
    }
}
