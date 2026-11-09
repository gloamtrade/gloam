// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Stablecoin swaps through GloamVaultSwapV4c against the real tokens and the real
// PoolManager, on a local fork of Base or Ethereum. Each token's own rules are the point:
// USDT's non-standard approve and transfer and its fee switch, the issuers' blocklists
// and pauses, the 6-decimal amounts, and pools that are thin on one side or have moved
// since the quote. A fresh vault with accept-all verifiers stands in for the live one;
// app/scripts/fork-router-v3.mts runs the same pairs with real proofs against the live one.
//
// Off by default. From contracts/, once per chain:
//   ROUTER_FORK=ethereum forge test --evm-version cancun --match-path test/fork/VaultSwapStableFork.t.sol --match-test test_stable -vv
//   ROUTER_FORK=base ...

import {console2} from "forge-std/Test.sol";
import {GloamVaultSwap2} from "../../src/GloamVaultSwap2.sol";
import {PoolKey, SwapParams, IPoolManagerSwap} from "../../src/GloamVaultSwapV4.sol";
import {IERC20C, IExtC, VaultSwapV4cForkTest} from "./VaultSwapV4cFork.t.sol";

interface IAllowance {
    function allowance(address owner, address spender) external view returns (uint256);
}

interface ITether {
    function owner() external view returns (address);
    function setParams(uint256 newBasisPoints, uint256 newMaxFee) external;
    function pause() external;
    function unpause() external;
    function addBlackList(address who) external;
    function removeBlackList(address who) external;
}

interface ICircle {
    function blacklister() external view returns (address);
    function blacklist(address who) external;
    function unBlacklist(address who) external;
    function pauser() external view returns (address);
    function pause() external;
    function unpause() external;
}

interface IPM {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/// Moves a pool's price the way a large trade does: exact input, paid from what it holds.
contract PoolMover {
    IPM immutable pm;

    constructor(address pm_) {
        pm = IPM(pm_);
    }

    function move(PoolKey memory key, bool zeroForOne, uint256 amountIn, uint160 limit) external {
        pm.unlock(abi.encode(key, zeroForOne, amountIn, limit));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, bool z, uint256 amountIn, uint160 limit) = abi.decode(data, (PoolKey, bool, uint256, uint160));
        int256 d = pm.swap(key, SwapParams(z, -int256(amountIn), limit), "");
        int128 a0 = int128(d >> 128);
        int128 a1 = int128(d);
        (address payC, address takeC, int128 paid, int128 got) = z
            ? (key.currency0, key.currency1, a0, a1)
            : (key.currency1, key.currency0, a1, a0);
        pm.sync(payC);
        (bool ok, ) = payC.call(abi.encodeWithSelector(0xa9059cbb, address(pm), uint256(uint128(-paid))));
        require(ok, "pay");
        pm.settle();
        pm.take(takeC, address(this), uint256(uint128(got)));
        return "";
    }
}

contract VaultSwapStableForkTest is VaultSwapV4cForkTest {
    function _eth() internal view returns (bool) {
        return _is("ethereum");
    }

    function _usdc() internal view returns (address) {
        return _eth() ? 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 : 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    }

    function _usdt() internal view returns (address) {
        return _eth() ? 0xdAC17F958D2ee523a2206206994597C13D831ec7 : 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    }

    function _eurc() internal view returns (address) {
        return _eth() ? 0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c : 0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42;
    }

    function _usdg() internal pure returns (address) {
        return 0xe343167631d89B6Ffc58B88d6b7fB0228795491D;
    }

    /// The deepest direct USDC / USDT pool in the deploy list.
    function _usdPool() internal view returns (uint256) {
        return _eth() ? 4 : 2;
    }

    function _one1(uint256 i) internal view returns (PoolKey[] memory hops) {
        hops = new PoolKey[](1);
        hops[0] = p[i];
    }

    function _noAllowance(address token) internal view {
        assertEq(IAllowance(token).allowance(address(router), address(pool)), 0, "no allowance left to the vault");
        assertEq(IAllowance(token).allowance(address(router), pm), 0, "no allowance to the PoolManager");
    }

    /// A funded note, its swap call and escrow, buying `want` of `out` through `hops`.
    function _prepared(PoolKey[] memory hops, address asset, address out, uint256 note, uint256 want)
        internal
        returns (Call memory k, Snap memory sn)
    {
        nul++;
        assertTrue(_fund(asset, note), "funded");
        sn.assetIn = asset;
        sn.assetOut = out;
        sn.note = note;
        sn.want = want;
        k = _build(hops, sn);
    }

    /// USDC to USDT and back, at sizes up to the vault's limit, on the pools that carry them.
    function test_stable_usd_pairs_at_size() public {
        uint256[3] memory sizes = [uint256(1_000e6), 10_000e6, 45_000e6];
        address usdc = _usdc();
        address usdt = _usdt();
        for (uint256 i = 0; i < 3; i++) {
            // Base's pools run out at about $15,000: that case has its own test
            if (!_eth() && sizes[i] > 10_000e6) continue;
            _swap(_one1(_usdPool()), usdc, usdt, sizes[i], "USDC>USDT");
            _swap(_one1(_usdPool()), usdt, usdc, sizes[i], "USDT>USDC");
        }
        if (_eth()) {
            _swap(_route(_usdPool(), 8), usdt, _usdg(), 45_000e6, "USDT>USDC>USDG, the route past the thin direct pool");
            _swap(_one1(8), usdc, _usdg(), 400e6, "USDC>USDG, its cheap pool");
            _swap(_one1(9), usdc, _usdg(), 45_000e6, "USDC>USDG, its deep pool");
            _swap(_route(10, _usdPool()), _usdg(), usdc, 45_000e6, "USDG>USDT>USDC");
        }
        console2.log("failures", failures);
        assertEq(failures, 0, "every size swaps");
        _noAllowance(usdc);
        _noAllowance(usdt);
    }

    /// EURC at what its pools fill. The amounts are 6 decimals each way, whatever the euro rate is.
    function test_stable_eurc_at_what_its_pools_fill() public {
        uint256 i = _eth() ? 11 : 6;
        _swap(_one1(i), _usdc(), _eurc(), 200e6, "USDC>EURC");
        _swap(_one1(i), _eurc(), _usdc(), 200e6, "EURC>USDC");
        assertEq(failures, 0, "EURC swaps");
        _noAllowance(_eurc());
    }

    /// Tether's approve() refuses non-zero to non-zero and returns nothing; two swaps in a row must both clear.
    function test_stable_usdt_needs_no_allowance_reset_between_swaps() public {
        if (!_eth()) return;
        _swap(_one1(4), _usdc(), _usdt(), 100e6, "first USDC>USDT");
        _noAllowance(_usdt());
        _swap(_one1(4), _usdc(), _usdt(), 100e6, "second USDC>USDT");
        _noAllowance(_usdt());
        assertEq(failures, 0, "both swaps land");
    }

    /// Tether switches its fee on: nothing lands, the note stays, and a waiting refund can still exit.
    function test_stable_usdt_fee_switch() public {
        if (!_eth()) return;
        address usdt = _usdt();
        (Call memory k, Snap memory sn) = _prepared(_one1(4), _usdc(), usdt, 200e6, 100e6);
        (Call memory o, Snap memory so) = _prepared(_one1(4), usdt, _usdc(), 200e6, 100e6);
        ITether t = ITether(usdt);
        vm.prank(t.owner());
        t.setParams(10, 5);

        // into USDT: the vault refuses a short arrival, the whole swap reverts
        vm.expectRevert();
        this.swapOnce(k);
        assertFalse(pool.isSpent(k.s.nullifier), "the note stays");
        assertEq(_bal(_usdc(), sn.escrow), 0, "nothing at the escrow");

        // out of USDT: the PoolManager credits less than it is owed, the whole swap reverts
        vm.expectRevert();
        this.swapOnce(o);
        assertFalse(pool.isSpent(o.s.nullifier), "the note stays");

        // a USDT note sent to its escrow alone: the refund can't land while the fee is on, the exit pays
        pool.unshield(o.s.proof, o.s.root, o.s.nullifier, o.s.asset, so.escrow, o.s.amount);
        uint256 waiting = _bal(usdt, so.escrow);
        assertGt(waiting, 0, "money waits");
        vm.expectRevert();
        this.swapOnce(o);
        assertEq(_bal(usdt, so.escrow), waiting, "still waiting");

        // back to no fee: the refund lands as before
        vm.prank(t.owner());
        t.setParams(0, 0);
        assertEq(this.swapOnce(o), 0, "a refund");
        assertTrue(pool.commitmentSeen(o.r.commitment), "the refund note landed");
    }

    /// Tether pauses: a swap moves nothing, and money already waiting comes back once it unpauses.
    function test_stable_usdt_pause() public {
        if (!_eth()) return;
        address usdt = _usdt();
        (Call memory k, Snap memory sn) = _prepared(_one1(4), usdt, _usdc(), 200e6, 100e6);
        pool.unshield(k.s.proof, k.s.root, k.s.nullifier, k.s.asset, sn.escrow, k.s.amount);
        (Call memory o, ) = _prepared(_one1(4), usdt, _usdc(), 200e6, 100e6);
        ITether t = ITether(usdt);
        vm.prank(t.owner());
        t.pause();
        vm.expectRevert();
        this.swapOnce(o);
        assertFalse(pool.isSpent(o.s.nullifier), "the note stays");
        vm.expectRevert();
        this.swapOnce(k);
        assertGt(_bal(usdt, sn.escrow), 0, "the refund waits");
        vm.prank(t.owner());
        t.unpause();
        assertEq(this.swapOnce(k), 0, "a refund");
        assertTrue(pool.commitmentSeen(k.r.commitment), "the refund note landed");
    }

    /// An issuer blocks the router: swaps move nothing and money waiting stays put until it is unblocked.
    function test_stable_a_blocked_router_strands_nothing() public {
        if (!_eth()) return;
        address usdt = _usdt();
        (Call memory k, Snap memory sn) = _prepared(_one1(4), usdt, _usdc(), 200e6, 100e6);
        pool.unshield(k.s.proof, k.s.root, k.s.nullifier, k.s.asset, sn.escrow, k.s.amount);
        (Call memory o, ) = _prepared(_one1(4), usdt, _usdc(), 200e6, 100e6);
        ITether t = ITether(usdt);
        vm.startPrank(t.owner());
        t.addBlackList(address(router));
        vm.stopPrank();
        vm.expectRevert();
        this.swapOnce(o);
        assertFalse(pool.isSpent(o.s.nullifier), "the note stays");
        vm.expectRevert();
        this.swapOnce(k);
        assertGt(_bal(usdt, sn.escrow), 0, "the refund waits");
        vm.prank(t.owner());
        t.removeBlackList(address(router));
        assertEq(this.swapOnce(k), 0, "a refund");
    }

    /// Circle blocks the treasury: swaps keep landing, the leftover stays at the router, and no later swap spends it.
    function test_stable_a_blocked_treasury_never_stops_a_swap() public {
        address usdc = _usdc();
        address usdt = _usdt();
        ICircle c = ICircle(usdc);
        vm.prank(c.blacklister());
        c.blacklist(treasury);
        nul++;
        uint256 note = 100e6;
        assertTrue(_fund(usdc, note), "funded");
        Snap memory sn;
        sn.assetIn = usdc;
        sn.assetOut = usdt;
        sn.note = note;
        sn.want = 99e6;
        Call memory k = _build(_one1(_usdPool()), sn);
        this.swapOnce(k);
        uint256 held = _bal(usdc, address(router));
        assertGt(held, 0, "the leftover stays here");
        (Call memory o, ) = _prepared(_one1(_usdPool()), usdc, usdt, 100e6, 99e6);
        this.swapOnce(o);
        assertGt(_bal(usdc, address(router)), held, "and nothing spent it");
        assertTrue(pool.commitmentSeen(o.d.commitment), "the later swap landed");
    }

    /// A swap whose pool moved past its buffer after the quote: the whole thing reverts and the note stays.
    function test_stable_a_price_move_past_the_buffer_reverts_whole() public {
        address usdc = _usdc();
        address usdt = _usdt();
        uint256 want = 9_900e6; // for a note of 10,000 USDC
        (Call memory k, Snap memory sn) = _prepared(_one1(_usdPool()), usdc, usdt, 10_000e6, want);
        PoolMover m = new PoolMover(pm);
        bool usdcIs0 = p[_usdPool()].currency0 == usdc;
        uint256 size = IERC20C(usdc).balanceOf(pm) / 2;
        vm.prank(pm);
        (bool ok, ) = usdc.call(abi.encodeWithSelector(0xa9059cbb, address(m), size));
        assertTrue(ok, "funded the mover");
        uint256 depBefore = pool.deposited(usdc);
        // buying USDT with size makes USDT dear: 10,000 USDC no longer buys 9,900. The price
        // moves 3%, which is past the 1% the swap has room for, and stops there.
        bytes32 slot = keccak256(abi.encode(keccak256(abi.encode(p[_usdPool()])), bytes32(uint256(6))));
        uint160 price = uint160(uint256(IExtC(pm).extsload(slot)));
        m.move(p[_usdPool()], usdcIs0, size, usdcIs0 ? (price / 200) * 197 : (price / 200) * 203);
        vm.expectRevert();
        this.swapOnce(k);
        assertFalse(pool.isSpent(k.s.nullifier), "the note stays");
        assertEq(pool.deposited(usdc), depBefore, "nothing left the vault");
        assertEq(_bal(usdc, sn.escrow), 0, "nothing at the escrow");
    }

    /// What a thin pool does to a large order: Base's EURC pool, the worst one in the deploy lists.
    function test_stable_a_thin_pool_never_pays_a_short_note() public {
        if (_eth()) return;
        // exact output is asked of the pool, so a thin pool either fills all of it or the swap reverts
        (Call memory k, Snap memory sn) = _prepared(_one1(6), _usdc(), _eurc(), 45_000e6, 40_000e6);
        vm.expectRevert();
        this.swapOnce(k);
        assertFalse(pool.isSpent(k.s.nullifier), "the note stays");
        assertEq(_bal(_usdc(), sn.escrow), 0, "nothing at the escrow");
    }

    /// The same proof with another route can't land: the escrow it names is a different one.
    function test_stable_a_copied_swap_cannot_change_its_route() public {
        if (!_eth()) return;
        (Call memory k, ) = _prepared(_one1(4), _usdc(), _usdt(), 200e6, 100e6);
        k.route = abi.encode(_one1(7));
        vm.expectRevert();
        this.swapOnce(k);
        assertFalse(pool.isSpent(k.s.nullifier), "the note stays");
    }

    /// One note out to its escrow, then the same token's refund: nothing left behind at any step.
    function test_stable_refund_and_exit_in_each_token() public {
        address[4] memory tokens = [_usdc(), _usdt(), _eurc(), _eth() ? _usdg() : _usdc()];
        for (uint256 i = 0; i < 4; i++) {
            address asset = tokens[i];
            address out = asset == _usdc() ? _usdt() : _usdc();
            for (uint256 way = 0; way < 2; way++) {
                (Call memory k, Snap memory sn) = _prepared(_one1(_usdPool()), asset, out, 100e6, 1);
                pool.unshield(k.s.proof, k.s.root, k.s.nullifier, k.s.asset, sn.escrow, k.s.amount);
                uint256 arrived = 100e6 - (100e6 * 25) / 10_000;
                assertEq(_bal(asset, sn.escrow), arrived, "waiting");
                if (way == 0) {
                    uint256 t = _bal(asset, treasury);
                    assertEq(this.swapOnce(k), 0, "a refund");
                    assertEq(_bal(asset, treasury) - t, arrived - k.r.amount, "only the margin");
                } else {
                    address to = address(uint160(0xE5C0 + i));
                    router.exit(asset, _key(k), to, _sign(sn.escrow, to));
                    assertEq(_bal(asset, to), arrived, "all of it");
                }
                assertEq(_bal(asset, sn.escrow), 0, "escrow empty");
                assertEq(_bal(asset, address(router)), 0, "router empty");
                _noAllowance(asset);
            }
        }
    }
}
