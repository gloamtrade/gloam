// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// GloamVaultSwapV4c (private swaps v3). Every test of the two routers before it,
// their reviews included, runs here against v3 (VaultSwapV4bTest), then the v3
// tests: native ETH notes on either side, the exit and what guards it, and
// exact accounting under fuzzing.

import {ShieldPoolCore} from "../src/ShieldPoolCore.sol";
import {GloamVaultSwap} from "../src/GloamVaultSwap.sol";
import {GloamVaultSwap2} from "../src/GloamVaultSwap2.sol";
import {GloamVaultSwapTempo2} from "../src/GloamVaultSwapTempo2.sol";
import {PoolKey} from "../src/GloamVaultSwapV4.sol";
import {GloamVaultSwapV4b} from "../src/GloamVaultSwapV4b.sol";
import {GloamVaultSwapV4c} from "../src/GloamVaultSwapV4c.sol";
import {SwapEscrow2} from "../src/SwapEscrow2.sol";
import {MockERC20} from "./MockERC20.sol";
import {MockStableDex} from "./VaultSwap.t.sol";
import {FreezeToken} from "./VaultSwapReview.t.sol";
import {HostileHook, MockWETH, MockWETH9, VaultSwapV4bTest} from "./VaultSwapV4b.t.sol";
import {DeployVaultSwapV4c} from "../script/DeployVaultSwapV4c.s.sol";

/// Takes an exit's ETH and, with it, tries whatever it is armed with.
contract ReenterReceiver {
    address public target;
    bytes public payload;
    bool public tried;
    bool public lastOk;
    bytes public lastRet;
    bool public refuse;

    function arm(address t, bytes calldata p) external {
        target = t;
        payload = p;
    }

    function setRefuse(bool r) external {
        refuse = r;
    }

    receive() external payable {
        require(!refuse, "refused");
        if (target != address(0)) {
            tried = true;
            (lastOk, lastRet) = target.call(payload);
        }
    }
}

contract VaultSwapV4cTest is VaultSwapV4bTest {
    uint256 constant EXIT_PK = 0xE817;
    uint256 constant ENOTE = 0.05 ether;
    uint256 constant EARRIVES = ENOTE - (ENOTE * 25) / 10_000;
    address constant NATIVE = address(0);

    address exitKey;
    /// Far enough off that the warps in the older routers' tests never reach it.
    uint256 swapDeadline = type(uint64).max;
    address payable exitTo = payable(address(0xE417));

    function setUp() public override {
        exitKey = vm.addr(EXIT_PK);
        super.setUp();
        pool.setDepositLimit(NATIVE, 10 ether, 100 ether);
        vm.startPrank(depositor);
        for (uint256 i = 0; i < 4; i++) pool.shieldBound{value: ENOTE}(NATIVE, ENOTE, bytes32(uint256(0xEEE0 + i)), hex"00");
        vm.stopPrank();
    }

    function _v3() internal view returns (GloamVaultSwapV4c) {
        return GloamVaultSwapV4c(payable(address(router)));
    }

    function _newRouter(PoolKey[] memory allow) internal override returns (GloamVaultSwap) {
        if (address(weth) == address(0)) weth = new MockWETH();
        return GloamVaultSwap(address(new GloamVaultSwapV4c(address(pool), treasury, address(pm), address(weth), owner, allow)));
    }

    function _s2(GloamVaultSwap.Spend memory s) internal pure returns (GloamVaultSwap2.Spend memory) {
        return GloamVaultSwap2.Spend(s.proof, s.root, s.nullifier, s.asset, s.amount);
    }

    function _d2(GloamVaultSwap.Deposit memory d) internal pure returns (GloamVaultSwap2.Deposit memory) {
        return GloamVaultSwap2.Deposit(d.proof, d.commitment, d.asset, d.amount);
    }

    function _key2(GloamVaultSwap.EscrowKey memory k, address key) internal view returns (GloamVaultSwap2.EscrowKey memory) {
        return GloamVaultSwap2.EscrowKey(
            k.nullifier, k.amountIn, k.outCommitment, k.assetOut, k.amountOut, k.refundCommitment, k.refundAmount, k.routeHash, key, swapDeadline
        );
    }

    function _escrowOf(GloamVaultSwap on, address assetIn, GloamVaultSwap.EscrowKey memory key)
        internal
        view
        override
        returns (address)
    {
        return GloamVaultSwap2(payable(address(on))).escrowFor(assetIn, _key2(key, exitKey));
    }

    function _go(GloamVaultSwap on, Call memory k) internal override returns (uint256) {
        return GloamVaultSwap2(payable(address(on))).swap(_s2(k.s), _d2(k.d), _d2(k.r), k.route, exitKey, swapDeadline);
    }

    function _swapData(Call memory k) internal view override returns (bytes memory) {
        return abi.encodeCall(GloamVaultSwap2.swap, (_s2(k.s), _d2(k.d), _d2(k.r), k.route, exitKey, swapDeadline));
    }

    function _keyOf(Call memory k) internal view returns (GloamVaultSwap2.EscrowKey memory) {
        return GloamVaultSwap2.EscrowKey(
            k.s.nullifier, k.s.amount, k.d.commitment, k.d.asset, k.d.amount, k.r.commitment, k.r.amount, keccak256(k.route), exitKey, swapDeadline
        );
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// What the exit key signs for this swap, paying `to`.
    function _exitSig(Call memory k, address to) internal view returns (bytes memory) {
        return _sign(EXIT_PK, _v3().exitDigest(_escrow(k), to));
    }

    /// The note leaves for its escrow on its own, as anyone can make it.
    function _leaveAlone(Call memory k) internal {
        vm.prank(outsider);
        pool.unshield(k.s.proof, k.s.root, k.s.nullifier, k.s.asset, _escrow(k), k.s.amount);
    }

    /// Fills the vault's total for an asset, so nothing more can be deposited.
    function _fillVault(address asset) internal {
        (uint128 per, uint128 total) = pool.depositLimit(asset);
        pool.lowerDepositLimit(asset, per, uint128(pool.deposited(asset)));
        assertEq(uint256(total) >= pool.deposited(asset), true);
    }

    function _assertEthBacked() internal view {
        assertGe(address(pool).balance, pool.deposited(NATIVE) + pool.feesOwed(NATIVE), "vault backs every ETH note");
    }

    // ═════════════════════════════════════════════════════════════ ported, adjusted

    function test_constructor_checks() public override {
        PoolKey[] memory none = new PoolKey[](0);
        vm.expectRevert(GloamVaultSwap2.ZeroAddress.selector);
        new GloamVaultSwapV4c(address(pool), address(0), address(pm), address(weth), owner, none);
        vm.expectRevert(GloamVaultSwap2.ZeroAddress.selector);
        new GloamVaultSwapV4c(address(pool), treasury, address(pm), address(0), owner, none);
        vm.expectRevert(GloamVaultSwap2.ZeroAddress.selector);
        new GloamVaultSwapV4c(address(pool), treasury, address(pm), address(weth), address(0), none);
        vm.expectRevert(GloamVaultSwap2.NotAContract.selector);
        new GloamVaultSwapV4c(address(0xDEAD), treasury, address(pm), address(weth), owner, none);
        vm.expectRevert(GloamVaultSwap2.NotAContract.selector);
        new GloamVaultSwapV4c(address(pool), treasury, address(0xDEAD), address(weth), owner, none);
        vm.expectRevert(GloamVaultSwap2.NotAContract.selector);
        new GloamVaultSwapV4c(address(pool), treasury, address(pm), address(0xDEAD), owner, none);
        PoolKey[] memory bad = new PoolKey[](1);
        bad[0] = PoolKey(address(gloam), address(0), 0, 1, address(0)); // unsorted
        vm.expectRevert(GloamVaultSwapV4c.BadPool.selector);
        new GloamVaultSwapV4c(address(pool), treasury, address(pm), address(weth), owner, bad);

        assertEq(address(_v3().vault()), address(pool));
        assertEq(_v3().treasury(), treasury);
        assertEq(address(_v3().poolManager()), address(pm));
        assertEq(_v3().weth(), address(weth));
        assertEq(_v3().owner(), owner);
    }

    /// v1 and v2 refused address(0); v3 takes it as native ETH. Same-asset and zero amounts stay refused.
    function test_same_asset_native_and_zero_are_refused() public override {
        Call memory k = _call(router, 14, address(usd), 1e6, 0xB4, _route1(direct));
        vm.expectRevert(GloamVaultSwap2.SameAsset.selector);
        _go(router, k);
        k = _callFrom(router, 14, NATIVE, ENOTE, NATIVE, 1e6, 0xB4, _route1(ethUsd));
        vm.expectRevert(GloamVaultSwap2.SameAsset.selector);
        _go(router, k);
        k = _call(router, 14, address(gloam), 0, 0xB4, _route1(direct));
        vm.expectRevert(GloamVaultSwap2.InvalidAmount.selector);
        _go(router, k);
    }

    function test_escrow_creation_code_is_pinned() public view override {
        assertEq(
            keccak256(type(SwapEscrow2).creationCode),
            vm.parseJsonBytes32(vm.readFile("test/fixtures/router-next.json"), ".escrowCodeHash"),
            "the app works escrow addresses out from this code: change lib/vaultSwap with it"
        );
    }

    function test_escrow_address_is_create2_of_the_key() public view override {
        GloamVaultSwap2.EscrowKey memory key = GloamVaultSwap2.EscrowKey(
            bytes32(uint256(1)), NOTE, bytes32(uint256(2)), address(gloam), 39e18, bytes32(uint256(3)), 99e6, keccak256("r"), exitKey, swapDeadline
        );
        bytes32 codeHash = keccak256(abi.encodePacked(type(SwapEscrow2).creationCode, abi.encode(address(usd))));
        address want = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(router), keccak256(abi.encode(key)), codeHash))))
        );
        assertEq(_v3().escrowFor(address(usd), key), want);
    }

    /// v2 wrapped ETH a hook pushed in; v3 sends it to the treasury as ETH, the way it sends any leftover.
    function test_v2_eth_pushed_to_the_router_is_wrapped_and_swept() public override {
        HostileHook h = new HostileHook();
        vm.deal(address(h), 1 ether);
        pm.setHook(address(h));
        h.armEthPush(address(pm), address(router), 0.3 ether);
        _go(router, _call(router, 948, address(gloam), 39e18, 0x948, _route1(direct)));
        assertEq(address(router).balance, 0, "no ETH stays");
        assertEq(treasury.balance, 0.3 ether, "it went to the treasury");
        _assertRouterEmpty();
    }

    /// A swap on Tempo, on the Tempo router of this generation.
    function test_tempo_swap_between_stablecoins() public override {
        (GloamVaultSwapTempo2 t, MockERC20 usdt, MockStableDex dex) = _tempo();
        uint256 want = 99e6;
        vm.prank(relayer);
        uint256 spent = _go(GloamVaultSwap(address(t)), _call(GloamVaultSwap(address(t)), 20, address(usdt), want, 0xC1, ""));
        assertEq(spent, 99_099_000);
        assertEq(pool.deposited(address(usdt)), want);
        assertEq(usd.balanceOf(treasury), ARRIVES - 99_099_000);
        assertEq(usd.balanceOf(address(t)), 0);
        assertEq(usdt.balanceOf(address(t)), 0);
        assertEq(usd.allowance(address(t), address(dex)), 0, "approval cleared");

        Call memory k = _call(GloamVaultSwap(address(t)), 21, address(usdt), want, 0xC2, hex"01");
        vm.expectRevert(GloamVaultSwapTempo2.BadRoute.selector);
        _go(GloamVaultSwap(address(t)), k);

        dex.setRate(1_010, 1_000);
        k = _call(GloamVaultSwap(address(t)), 22, address(usdt), want, 0xC3, "");
        vm.expectRevert(MockStableDex.MaxInputExceeded.selector);
        _go(GloamVaultSwap(address(t)), k);
        assertFalse(pool.isSpent(bytes32(uint256(22))));

        dex.setRate(1_001, 1_000);
        dex.setShortBy(1);
        k = _call(GloamVaultSwap(address(t)), 23, address(usdt), want, 0xC4, "");
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwap2.ShortOutput.selector, want - 1, want));
        _go(GloamVaultSwap(address(t)), k);
    }

    function _tempo() internal returns (GloamVaultSwapTempo2 t, MockERC20 usdt, MockStableDex dex) {
        usdt = new MockERC20();
        pool.setDepositLimit(address(usdt), 500e6, 25_000e6);
        dex = new MockStableDex();
        usdt.mint(address(dex), 1_000_000e6);
        t = new GloamVaultSwapTempo2(address(pool), treasury, address(dex));
    }

    /// Tempo's router has no venue that pays ETH: nothing but an opening escrow may send it any.
    function test_tempo_takes_no_eth() public {
        (GloamVaultSwapTempo2 t, , ) = _tempo();
        vm.deal(outsider, 1 ether);
        vm.prank(outsider);
        (bool ok, bytes memory ret) = address(t).call{value: 1}("");
        assertFalse(ok);
        assertEq(bytes4(ret), GloamVaultSwap2.NativeRefused.selector);
    }

    function test_tempo_refuses_native_and_exits_like_the_others() public {
        (GloamVaultSwapTempo2 t, MockERC20 usdt, ) = _tempo();
        GloamVaultSwap on = GloamVaultSwap(address(t));
        Call memory n = _callFrom(on, 24, NATIVE, ENOTE, address(usdt), 1e6, 0xC5, "");
        vm.expectRevert(GloamVaultSwapTempo2.NativeNotSupported.selector);
        _go(on, n);
        assertFalse(pool.isSpent(n.s.nullifier));

        Call memory k = _call(on, 25, address(usdt), 99e6, 0xC6, "");
        _leaveAlone(k);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        t.exit(address(usd), key, exitTo, _sign(EXIT_PK, t.exitDigest(_escrow(k), exitTo)));
        assertEq(usd.balanceOf(exitTo), ARRIVES);
    }

    /// On Tempo a receive policy can hold a payment instead of refusing it, so an exit asks first,
    /// with the escrow as the sender, as the escrow pays. Refused, the money waits for another address.
    function test_tempo_exit_asks_the_recipients_receive_policy_first() public {
        (GloamVaultSwapTempo2 t, Call memory k) = _tempoLeftAlone(26, 0xC7);
        address escrow = _escrow(k);
        vm.etch(t.TIP403_REGISTRY(), address(new MockReceivePolicy()).code);
        // a policy against the router alone holds nothing back: the router doesn't pay
        MockReceivePolicy(t.TIP403_REGISTRY()).refuse(address(usd), address(t), exitTo);
        MockReceivePolicy(t.TIP403_REGISTRY()).refuse(address(usd), escrow, exitTo);
        _tempoExitRefused(t, k, exitTo);
        assertEq(usd.balanceOf(escrow), ARRIVES, "the money waits");
        // a virtual address is asked as the wallet it forwards to
        address virtualTo = address(0xaBCdef01fDFDFDfDfDFDfDFDfdFd123456789aBC);
        vm.etch(t.ADDRESS_REGISTRY(), address(new MockAddressRegistry()).code);
        MockAddressRegistry(t.ADDRESS_REGISTRY()).set(virtualTo, exitTo);
        _tempoExitRefused(t, k, virtualTo);
        // an address whose policy takes it
        address other = address(0xE419);
        t.exit(address(usd), _keyOf(k), other, _sign(EXIT_PK, t.exitDigest(escrow, other)));
        assertEq(usd.balanceOf(other), ARRIVES);
        assertEq(usd.balanceOf(address(t)), 0, "never through the router");
    }

    function _tempoLeftAlone(uint256 id, uint256 salt) internal returns (GloamVaultSwapTempo2 t, Call memory k) {
        MockERC20 usdt;
        (t, usdt, ) = _tempo();
        k = _call(GloamVaultSwap(address(t)), id, address(usdt), 99e6, salt, "");
        _leaveAlone(k);
    }

    function _tempoExitRefused(GloamVaultSwapTempo2 t, Call memory k, address to) internal {
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        bytes memory sig = _sign(EXIT_PK, t.exitDigest(_escrow(k), to));
        vm.expectRevert(GloamVaultSwapTempo2.ReceiveBlocked.selector);
        t.exit(address(usd), key, to, sig);
    }

    /// Tempo's DEX holds nothing for anyone: an exit there is refused.
    function test_tempo_exit_refuses_the_dex() public {
        (GloamVaultSwapTempo2 t, Call memory k) = _tempoLeftAlone(28, 0xC9);
        address dexAt = address(t.dex());
        bytes memory sig = _sign(EXIT_PK, t.exitDigest(_escrow(k), dexAt));
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        t.exit(address(usd), key, dexAt, sig);
    }

    /// With no registry to ask, a payment held somewhere other than the recipient still fails the
    /// exit: the recipient must hold the whole amount more than before, or the escrow keeps it.
    function test_tempo_exit_checks_the_money_arrived() public {
        (GloamVaultSwapTempo2 t, MockERC20 usdt, ) = _tempo();
        HoldingToken ht = new HoldingToken();
        pool.setDepositLimit(address(ht), 500e6, 25_000e6);
        ht.mint(depositor, 1_000e6);
        vm.startPrank(depositor);
        ht.approve(address(pool), type(uint256).max);
        pool.shieldBound(address(ht), NOTE, bytes32(uint256(0xFCFC)), hex"00");
        vm.stopPrank();
        Call memory k = _callFrom(GloamVaultSwap(address(t)), 29, address(ht), NOTE, address(usdt), 1e6, 0xCA, "");
        _leaveAlone(k);
        ht.holdFor(exitTo);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        bytes memory sig = _sign(EXIT_PK, t.exitDigest(_escrow(k), exitTo));
        vm.expectRevert(GloamVaultSwapTempo2.ReceiveBlocked.selector);
        t.exit(address(ht), key, exitTo, sig);
        assertEq(ht.balanceOf(_escrow(k)), ARRIVES, "the escrow keeps it");
        address other = address(0xE41B);
        t.exit(address(ht), key, other, _sign(EXIT_PK, t.exitDigest(_escrow(k), other)));
        assertEq(ht.balanceOf(other), ARRIVES);
    }

    /// A registry that doesn't answer is a chain without receive policies: nothing there can hold a payment.
    function test_tempo_exit_goes_where_no_receive_policy_answers() public {
        (GloamVaultSwapTempo2 t, Call memory k) = _tempoLeftAlone(27, 0xC8);
        vm.etch(t.TIP403_REGISTRY(), address(new RevertingRegistry()).code);
        t.exit(address(usd), _keyOf(k), exitTo, _sign(EXIT_PK, t.exitDigest(_escrow(k), exitTo)));
        assertEq(usd.balanceOf(exitTo), ARRIVES);
    }

    // ═════════════════════════════════════════════════════════════ the deploy

    /// The deploy script's lists equal the fixture, in order, sorted as v4 keys must be, with no pool
    /// twice, and the router takes them all at deploy. Base and Ethereum stay hookless.
    function test_v3_deploy_script_pools_are_pinned() public {
        DeployVaultSwapV4c d = new DeployVaultSwapV4c();
        string memory fx = vm.readFile("test/fixtures/router-next.json");
        uint256[3] memory chains = [uint256(4663), 8453, 1];
        for (uint256 c = 0; c < 3; c++) {
            (, , PoolKey[] memory p) = d.config(chains[c]);
            bytes32[] memory ids = vm.parseJsonBytes32Array(fx, string.concat(".chains.", vm.toString(chains[c]), ".poolIds"));
            assertEq(p.length, ids.length);
            for (uint256 i = 0; i < p.length; i++) {
                assertEq(_id(p[i]), ids[i]);
                assertLt(uint160(p[i].currency0), uint160(p[i].currency1));
                assertTrue(p[i].hooks != 0x958541C0Ce2E1A158309f7d1b141963eDa31C880, "banned hook");
                if (chains[c] != 4663) assertEq(p[i].hooks, address(0), "hookless only here");
                for (uint256 j = 0; j < i; j++) assertTrue(ids[j] != ids[i], "a pool twice");
            }
            GloamVaultSwapV4c r = GloamVaultSwapV4c(payable(address(_newRouter(p))));
            for (uint256 i = 0; i < p.length; i++) assertTrue(r.allowedPool(ids[i]));
        }
    }

    /// Robinhood Chain's list is v2's deploy list, unchanged, then AI's and ORBIO's four.
    function test_v3_robinhood_keeps_every_v2_pool_and_adds_ai_and_orbio() public {
        DeployVaultSwapV4c d = new DeployVaultSwapV4c();
        (, , PoolKey[] memory p) = d.config(4663);
        bytes32[] memory v2 = vm.parseJsonBytes32Array(vm.readFile("test/fixtures/vault-swap-v2-pools.json"), ".poolIds");
        assertEq(p.length, v2.length + 4);
        for (uint256 i = 0; i < v2.length; i++) assertEq(_id(p[i]), v2[i]);
        assertEq(_id(p[41]), 0x592e3fb7ea947506b36481025abc15baada8e1839a50fded46ecf08b3182fa96);
        assertEq(_id(p[42]), 0x7aebd80541bfaaf23dbb6e99ce13d4d31c1a84c91414f971eadbff7db5f85995);
        assertEq(_id(p[43]), 0xea9f200e13055b82f175f44f592c4c13dd8c9d9320a66487d3c5cd90d68550ef);
        assertEq(_id(p[44]), 0xc761f7de760d2b73cc3e3cc3d729916a4ed2f7fc6b0aa3872e2ced4258961e92);
    }

    /// Where each router lands is fixed by its source: any edit to the contracts moves these.
    function test_v3_predicted_addresses_are_pinned() public {
        DeployVaultSwapV4c d = new DeployVaultSwapV4c();
        string memory fx = vm.readFile("test/fixtures/router-next.json");
        uint256[4] memory chains = [uint256(4663), 8453, 1, 4217];
        for (uint256 c = 0; c < 4; c++) {
            address want = vm.parseJsonAddress(fx, string.concat(".chains.", vm.toString(chains[c]), ".address"));
            assertEq(d.predicted(chains[c]), want, "rerun launch/router-fixture.mjs and update the fixture");
        }
    }

    // ═════════════════════════════════════════════════════════════ from a native ETH note

    /// ETH note -> usd on a pool that holds ETH: the router pays exactly what it asks, in ETH.
    function test_v3_eth_note_to_usd_through_an_eth_pool() public {
        uint256 want = 110e6;
        uint256 cost = (want * 10 ** 12 + 2400 - 1) / 2400;
        Call memory k = _callFrom(router, 1000, NATIVE, ENOTE, address(usd), want, 0x1000, _route1(ethUsd));
        address escrow = _escrow(k);
        uint256 pmEth = address(pm).balance;
        uint256 depBefore = pool.deposited(NATIVE);
        vm.prank(relayer);
        uint256 spent = _go(router, k);
        assertEq(spent, cost);
        assertEq(address(pm).balance, pmEth + cost, "paid in ETH");
        assertTrue(pool.isSpent(k.s.nullifier));
        assertTrue(pool.commitmentSeen(k.d.commitment));
        assertFalse(pool.commitmentSeen(k.r.commitment));
        assertEq(pool.deposited(NATIVE), depBefore - ENOTE);
        assertEq(pool.deposited(address(usd)), 4 * NOTE + want, "the new note, exactly");
        assertEq(treasury.balance, EARRIVES - cost, "leftover ETH to the treasury");
        assertEq(escrow.balance, 0, "escrow empty");
        assertEq(escrow.code, hex"fe", "one byte left, which refuses every call");
        _assertRouterEmpty();
        _assertEthBacked();
        _assertVaultBacked();
    }

    /// ETH note -> usd on a pool that holds WETH and not ETH: wrapped, exactly what the pool asks.
    function test_v3_eth_note_to_usd_through_a_weth_pool() public {
        uint256 want = 110e6;
        uint256 cost = (want * 10 ** 12 + 2400 - 1) / 2400;
        Call memory k = _callFrom(router, 1001, NATIVE, ENOTE, address(usd), want, 0x1001, _route1(wethUsd));
        uint256 pmWeth = weth.balanceOf(address(pm));
        uint256 supply = weth.totalSupply();
        assertEq(_go(router, k), cost);
        assertEq(weth.balanceOf(address(pm)), pmWeth + cost, "paid in WETH");
        assertEq(weth.totalSupply(), supply + cost, "exactly that much wrapped");
        assertEq(treasury.balance, EARRIVES - cost, "the rest stays ETH, to the treasury");
        assertEq(weth.balanceOf(treasury), 0);
        _assertRouterEmpty();
        _assertEthBacked();
    }

    function test_v3_eth_note_two_and_three_hops() public {
        // ETH -> gloam -> stock is not a route: ETH -> usd -> stock is
        uint256 want = 0.5e18; // 100 usd = 1/24 eth
        Call memory k = _callFrom(router, 1002, NATIVE, ENOTE, address(stock), want, 0x1002, _route2(ethUsd, usdStock));
        uint256 pmUsd = usd.balanceOf(address(pm));
        _go(router, k);
        assertEq(pool.deposited(address(stock)), want);
        assertEq(usd.balanceOf(address(pm)), pmUsd, "the middle usd never left the pool manager");
        _assertRouterEmpty();

        // ETH wrapped at the first pool, three hops: (WETH) -> gloam -> usd -> stock
        uint256 want3 = 0.4e18; // 80 usd = 32 gloam = 0.032 eth
        Call memory k3 = _callFrom(router, 1003, NATIVE, ENOTE, address(stock), want3, 0x1003, _route3(wethGloam, direct, usdStock));
        assertEq(_go(router, k3), 0.032 ether);
        assertEq(pool.deposited(address(stock)), want + want3);
        _assertRouterEmpty();
        _assertEthBacked();
    }

    function test_v3_eth_note_over_price_moves_nothing() public {
        uint256 want = 200e6; // costs 1/12 eth, far above the note
        Call memory k = _callFrom(router, 1004, NATIVE, ENOTE, address(usd), want, 0x1004, _route1(ethUsd));
        uint256 dep = pool.deposited(NATIVE);
        vm.expectRevert(
            abi.encodeWithSelector(GloamVaultSwap2.OverInput.selector, (want * 10 ** 12 + 2400 - 1) / 2400, EARRIVES)
        );
        _go(router, k);
        _assertNothingMoved(k, dep);
        assertEq(_escrow(k).balance, 0);
    }

    // ═════════════════════════════════════════════════════════════ into a native ETH note

    function test_v3_usd_note_to_eth_note_through_an_eth_pool() public {
        uint256 want = 0.04 ether; // 96 usd
        Call memory k = _callFrom(router, 1010, address(usd), NOTE, NATIVE, want, 0x1010, _route1(ethUsd));
        uint256 depBefore = pool.deposited(NATIVE);
        uint256 vaultEth = address(pool).balance;
        uint256 pmEth = address(pm).balance;
        vm.prank(relayer);
        assertEq(_go(router, k), 96e6);
        assertEq(pool.deposited(NATIVE), depBefore + want, "the new ETH note, exactly");
        assertEq(address(pool).balance, vaultEth + want);
        assertEq(address(pm).balance, pmEth - want);
        assertEq(usd.balanceOf(treasury), ARRIVES - 96e6);
        _assertRouterEmpty();
        _assertEthBacked();
        _assertVaultBacked();
    }

    /// A route ending at WETH into an ETH note: all of it unwrapped, and only what the note is worth goes in.
    function test_v3_usd_note_to_eth_note_through_a_weth_pool() public {
        uint256 want = 0.04 ether;
        pm.setBonusOut(0.001 ether);
        Call memory k = _callFrom(router, 1011, address(usd), NOTE, NATIVE, want, 0x1011, _route1(wethUsd));
        uint256 depBefore = pool.deposited(NATIVE);
        uint256 supply = weth.totalSupply();
        _go(router, k);
        assertEq(pool.deposited(NATIVE), depBefore + want, "the note is worth exactly what was proven");
        assertEq(weth.totalSupply(), supply - 0.041 ether, "all of the output unwrapped");
        assertEq(treasury.balance, 0.001 ether, "extra output to the treasury, as ETH");
        _assertRouterEmpty();
        _assertEthBacked();
    }

    function test_v3_eth_note_to_weth_note_and_back_through_usd() public {
        // ETH -> usd -> WETH: both forms of ETH, one at each end, no conversion
        Call memory k = _callFrom(router, 1012, NATIVE, ENOTE, address(weth), 0.04 ether, 0x1012, _route2(ethUsd, wethUsd));
        _go(router, k);
        assertEq(pool.deposited(address(weth)), 4 * WNOTE + 0.04 ether);
        assertEq(pool.deposited(NATIVE), 3 * ENOTE);
        _assertRouterEmpty();
        // WETH -> usd -> ETH
        Call memory b = _callFrom(router, 1013, address(weth), WNOTE, NATIVE, 0.04 ether, 0x1013, _route2(wethUsd, ethUsd));
        _go(router, b);
        assertEq(pool.deposited(NATIVE), 3 * ENOTE + 0.04 ether);
        _assertRouterEmpty();
        _assertEthBacked();
        _assertVaultBacked();
    }

    /// The vault takes a native deposit only with the value on it, and the limit applies as to any asset.
    function test_v3_eth_note_over_the_deposit_limit_reverts_whole() public {
        pool.lowerDepositLimit(NATIVE, 0.01 ether, 100 ether);
        Call memory k = _callFrom(router, 1014, address(usd), NOTE, NATIVE, 0.04 ether, 0x1014, _route1(ethUsd));
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector);
        _go(router, k);
        _assertNothingMoved(k, 4 * NOTE);
    }

    /// Ethereum's and Base's WETH9 pay with a 2300 gas stipend: an ETH note through WETH pools fits.
    function test_v3_eth_notes_with_weth9s_gas_stipend() public {
        MockWETH9 w9 = new MockWETH9();
        vm.deal(address(this), 10 ether);
        w9.deposit{value: 1 ether}();
        w9.transfer(address(pm), 1 ether);
        weth = w9;
        PoolKey memory w9Usd = _sorted(address(w9), address(usd), 200, 4);
        _rate(w9Usd, address(usd), 2400, 10 ** 12);
        _rate(w9Usd, address(w9), 10 ** 12, 2400);
        PoolKey[] memory allow = new PoolKey[](1);
        allow[0] = w9Usd;
        GloamVaultSwap r = _newRouter(allow);

        Call memory k = _callFrom(r, 1015, address(usd), NOTE, NATIVE, 0.04 ether, 0x1015, _route1(w9Usd));
        _go(r, k);
        assertTrue(pool.commitmentSeen(k.d.commitment), "unwrapped under the stipend");
        assertEq(address(r).balance, 0);
        Call memory b = _callFrom(r, 1016, NATIVE, ENOTE, address(usd), 110e6, 0x1016, _route1(w9Usd));
        _go(r, b);
        assertTrue(pool.commitmentSeen(b.d.commitment));
        assertEq(address(r).balance, 0);
        assertEq(w9.balanceOf(address(r)), 0);
    }

    // ═════════════════════════════════════════════════════════════ routes with ETH

    /// Five distinct currencies, so nothing but the hop limit can refuse it.
    function test_v3_a_clean_four_hop_route_is_refused() public {
        PoolKey[] memory four = new PoolKey[](4);
        four[0] = wethGloam;
        four[1] = ethGloam;
        four[2] = ethUsd;
        four[3] = usdStock;
        Call memory k = _callFrom(router, 1026, address(weth), WNOTE, address(stock), 1e15, 0x1026, abi.encode(four));
        vm.expectRevert(GloamVaultSwapV4c.BadRoute.selector);
        _go(router, k);
        _assertNothingMoved(k, 4 * WNOTE);
    }

    /// The router and lib/vaultSwap routeCurrencies refuse the same routes.
    function test_v3_eth_inside_a_route_that_converts_is_refused() public {
        // ETH note, WETH first pool (wrapped), then ETH again further on
        Call memory k = _callFrom(router, 1020, NATIVE, ENOTE, address(gloam), 1e18, 0x1020, _route3(wethUsd, ethUsd, ethGloam));
        vm.expectRevert(GloamVaultSwapV4c.BadRoute.selector);
        _go(router, k);
        // usd -> eth -> ... -> weth, unwrapped into an ETH note: ETH inside the route
        k = _callFrom(router, 1021, address(usd), NOTE, NATIVE, 1e18, 0x1021, _route3(ethUsd, ethGloam, wethGloam));
        vm.expectRevert(GloamVaultSwapV4c.BadRoute.selector);
        _go(router, k);
        // ETH note to a WETH note converted at both ends
        k = _callFrom(router, 1022, NATIVE, ENOTE, address(weth), 1e15, 0x1022, _route2(wethUsd, ethUsd));
        vm.expectRevert(GloamVaultSwapV4c.BadRoute.selector);
        _go(router, k);
        _assertNothingMoved(k, 4 * ENOTE);
    }

    function test_v3_a_usd_note_never_pays_in_eth_and_a_token_note_is_never_wrapped() public {
        Call memory k = _callFrom(router, 1023, address(usd), NOTE, NATIVE, 1e15, 0x1023, _route1(ethGloam));
        vm.expectRevert(GloamVaultSwapV4c.BadRoute.selector);
        _go(router, k);
        k = _callFrom(router, 1024, NATIVE, ENOTE, address(stock), 1e15, 0x1024, _route1(ethUsd));
        vm.expectRevert(GloamVaultSwapV4c.BadRoute.selector);
        _go(router, k);
    }

    /// The route is fixed by the proof for ETH notes too: the same swap on the other pool is another escrow.
    function test_v3_a_copied_eth_swap_with_another_route_is_refused() public {
        Call memory k = _callFrom(router, 1025, NATIVE, ENOTE, address(usd), 110e6, 0x1025, _route1(ethUsd));
        Call memory theirs = _callFrom(router, 1025, NATIVE, ENOTE, address(usd), 110e6, 0x1025, _route1(wethUsd));
        theirs.s.proof = k.s.proof;
        vm.expectRevert(ShieldPoolCore.InvalidProof.selector);
        _go(router, theirs);
        _go(router, k);
    }

    // ═════════════════════════════════════════════════════════════ hostile pools, with ETH

    function test_v3_a_pool_charging_everything_that_arrived_takes_only_the_leftover_of_an_eth_note() public {
        uint256 want = 110e6;
        uint256 fair = (want * 10 ** 12 + 2400 - 1) / 2400;
        pm.setExtraIn(EARRIVES - fair);
        Call memory k = _callFrom(router, 1030, NATIVE, ENOTE, address(usd), want, 0x1030, _route1(ethUsd));
        assertEq(_go(router, k), EARRIVES, "the whole input, and no more");
        assertEq(pool.deposited(address(usd)), 4 * NOTE + want, "the new note exactly");
        assertEq(pool.deposited(NATIVE), 3 * ENOTE, "only the spent note left the vault");
        assertEq(treasury.balance, 0, "the leftover went to the pool");
        _assertRouterEmpty();
        _assertEthBacked();

        pm.setExtraIn(EARRIVES - fair + 1);
        k = _callFrom(router, 1031, NATIVE, ENOTE, address(usd), want, 0x1031, _route1(ethUsd));
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwap2.OverInput.selector, EARRIVES + 1, EARRIVES));
        _go(router, k);
        _assertNothingMoved(k, 3 * ENOTE);
    }

    /// With stray ETH already in the router (a treasury that refused it), a pool still can't reach past the note.
    function test_v3_a_pool_cannot_spend_eth_the_router_already_held() public {
        vm.etch(treasury, hex"5f5ffd"); // the treasury refuses ETH: revert(0, 0)
        Call memory first = _callFrom(router, 1032, NATIVE, ENOTE, address(usd), 110e6, 0x1032, _route1(ethUsd));
        _go(router, first);
        uint256 held = address(router).balance;
        assertGt(held, 0, "what the treasury refused stays here");

        uint256 fair = (uint256(110e6) * 10 ** 12 + 2400 - 1) / 2400;
        pm.setExtraIn(EARRIVES - fair + 1);
        Call memory k = _callFrom(router, 1033, NATIVE, ENOTE, address(usd), 110e6, 0x1033, _route1(ethUsd));
        vm.expectRevert(abi.encodeWithSelector(GloamVaultSwap2.OverInput.selector, EARRIVES + 1, EARRIVES));
        _go(router, k);
        assertEq(address(router).balance, held);
    }

    /// A hook pushing ETH to the router during a swap into an ETH note can't make the output short or long.
    function test_v3_a_hook_pushing_eth_mid_swap_changes_no_note() public {
        HostileHook h = new HostileHook();
        vm.deal(address(h), 1 ether);
        pm.setHook(address(h));
        h.armEthPush(address(pm), address(router), 0.3 ether);
        Call memory k = _callFrom(router, 1034, address(usd), NOTE, NATIVE, 0.04 ether, 0x1034, _route1(ethUsd));
        uint256 dep = pool.deposited(NATIVE);
        _go(router, k);
        assertEq(pool.deposited(NATIVE), dep + 0.04 ether);
        assertEq(treasury.balance, 0.3 ether, "the push is a leftover");
        _assertRouterEmpty();
        _assertEthBacked();
    }

    /// During a swap only WETH and the PoolManager can send ETH here. A hook's plain send is refused.
    function test_v3_a_hook_cannot_send_eth_straight_to_the_router() public {
        HostileHook h = new HostileHook();
        vm.deal(address(h), 1 ether);
        pm.setHook(address(h));
        // the hook itself calling the router with value and no data
        h.arm(address(router), "");
        Call memory k = _callFrom(router, 1035, NATIVE, ENOTE, address(usd), 110e6, 0x1035, _route1(ethUsd));
        _go(router, k);
        assertTrue(h.tried());
        // a plain call without value reaches receive() too, and is refused the same way
        assertFalse(h.lastOk());
        assertEq(bytes4(h.lastRet()), GloamVaultSwap2.NativeRefused.selector);
    }

    function test_v3_a_hook_cannot_reenter_exit_or_swap() public {
        Call memory waiting = _callFrom(router, 1036, NATIVE, ENOTE, address(usd), 110e6, 0x1036, _route1(ethUsd));
        _leaveAlone(waiting);
        HostileHook h = new HostileHook();
        pm.setHook(address(h));
        h.arm(address(router), abi.encodeCall(GloamVaultSwap2.exit, (NATIVE, _keyOf(waiting), exitTo, _exitSig(waiting, exitTo))));
        _go(router, _callFrom(router, 1037, NATIVE, ENOTE, address(usd), 110e6, 0x1037, _route1(ethUsd)));
        assertTrue(h.tried());
        assertFalse(h.lastOk());
        assertEq(bytes4(h.lastRet()), GloamVaultSwap2.Reentrancy.selector);
        assertEq(_escrow(waiting).balance, EARRIVES, "it still waits");
    }

    // ═════════════════════════════════════════════════════════════ refunds of ETH notes

    function test_v3_an_eth_unshield_sent_alone_comes_back_as_the_refund_note() public {
        Call memory k = _callFrom(router, 1040, NATIVE, ENOTE, address(usd), 110e6, 0x1040, _route1(ethUsd));
        _leaveAlone(k);
        assertEq(_escrow(k).balance, EARRIVES, "the money waits at the escrow");
        vm.prank(relayer);
        assertEq(_go(router, k), 0);
        assertTrue(pool.commitmentSeen(k.r.commitment), "refund note in the vault");
        assertFalse(pool.commitmentSeen(k.d.commitment));
        assertEq(pool.deposited(NATIVE), 3 * ENOTE + k.r.amount);
        assertEq(_escrow(k).balance, 0);
        assertEq(treasury.balance, EARRIVES - k.r.amount, "only the fee margin");
        _assertRouterEmpty();
        _assertEthBacked();
        vm.expectRevert(GloamVaultSwap2.BadRefund.selector);
        _go(router, k);
    }

    /// What the escrow holds is not what arrives if the token skims the hand-over. The refund note can
    /// only be paid from what arrived, never from something else the router happens to hold.
    function test_v3_a_refund_is_never_topped_up_from_what_the_router_holds() public {
        SkimToken skim = new SkimToken();
        pool.setDepositLimit(address(skim), 500e6, 25_000e6);
        skim.mint(depositor, 1_000e6);
        vm.startPrank(depositor);
        skim.approve(address(pool), type(uint256).max);
        pool.shieldBound(address(skim), NOTE, bytes32(uint256(0x5C10)), hex"00");
        vm.stopPrank();
        skim.mint(address(router), 50e6); // stray money, someone else's mistake

        Call memory k = _callFrom(router, 1042, address(skim), NOTE, address(gloam), 39e18, 0x1042, _route1(direct));
        _leaveAlone(k);
        skim.skimFrom(_escrow(k), 2e6); // the hand-over loses more than the 0.75% margin
        vm.expectRevert(GloamVaultSwap2.BadRefund.selector);
        _go(router, k);
        assertEq(skim.balanceOf(address(router)), 50e6, "the stray money is untouched");
        assertFalse(pool.commitmentSeen(k.r.commitment));
    }

    function test_v3_a_short_eth_escrow_is_no_refund() public {
        Call memory k = _callFrom(router, 1041, NATIVE, ENOTE, address(usd), 110e6, 0x1041, _route1(ethUsd));
        // cashed out normally instead: spent, and the escrow never got anything
        pool.unshield(abi.encode(address(0xCA5)), k.s.root, k.s.nullifier, k.s.asset, address(0xCA5), k.s.amount);
        vm.expectRevert(GloamVaultSwap2.BadRefund.selector);
        _go(router, k);
    }

    // ═════════════════════════════════════════════════════════════ the exit

    function test_exit_pays_the_whole_escrow_when_the_refund_cannot_land() public {
        Call memory k = _call(router, 1100, address(gloam), 39e18, 0x1100, _route1(direct));
        _leaveAlone(k);
        _fillVault(address(usd));
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector);
        _go(router, k);
        assertEq(usd.balanceOf(_escrow(k)), ARRIVES, "the refund waits");

        vm.expectEmit(true, true, true, true, address(router));
        emit GloamVaultSwap2.VaultSwapExit(k.s.nullifier, address(usd), exitTo, ARRIVES);
        vm.prank(relayer);
        uint256 out = _v3().exit(address(usd), _keyOf(k), exitTo, _exitSig(k, exitTo));
        assertEq(out, ARRIVES);
        assertEq(usd.balanceOf(exitTo), ARRIVES, "all of it, nothing for the treasury");
        assertEq(usd.balanceOf(_escrow(k)), 0);
        assertEq(usd.balanceOf(relayer), 0, "the caller gains nothing");
        assertEq(usd.balanceOf(treasury), 0);
        _assertRouterEmpty();
        _assertVaultBacked();
    }

    function test_exit_of_an_eth_note() public {
        Call memory k = _callFrom(router, 1101, NATIVE, ENOTE, address(usd), 110e6, 0x1101, _route1(ethUsd));
        _leaveAlone(k);
        _fillVault(NATIVE);
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector);
        _go(router, k);

        vm.prank(outsider);
        assertEq(_v3().exit(NATIVE, _keyOf(k), exitTo, _exitSig(k, exitTo)), EARRIVES);
        assertEq(exitTo.balance, EARRIVES);
        assertEq(_escrow(k).balance, 0);
        assertEq(address(router).balance, 0);
        _assertEthBacked();
    }

    function test_exit_works_while_the_allowlist_is_empty_and_for_a_route_that_never_was_allowed() public {
        Call memory k = _call(router, 1102, address(gloam), 1e18, 0x1102, _route1(stranger));
        _leaveAlone(k);
        _v2().removePool(_id(direct));
        _v3().exit(address(usd), _keyOf(k), exitTo, _exitSig(k, exitTo));
        assertEq(usd.balanceOf(exitTo), ARRIVES);
    }

    // ── what guards it

    function test_exit_needs_the_exit_key() public {
        Call memory k = _call(router, 1103, address(gloam), 39e18, 0x1103, _route1(direct));
        _leaveAlone(k);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        // the note's proof, the relay, a stranger: none of them holds it
        bytes memory theirs = _sign(0xBAD, _v3().exitDigest(_escrow(k), outsider));
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        _v3().exit(address(usd), key, outsider, theirs);
        // the swap's own unshield proof is no signature
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        _v3().exit(address(usd), key, outsider, k.s.proof);
        // nor is nothing
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        _v3().exit(address(usd), key, outsider, "");
        assertEq(usd.balanceOf(_escrow(k)), ARRIVES);
    }

    function test_exit_with_an_exit_key_of_your_own_finds_an_empty_escrow() public {
        Call memory k = _call(router, 1104, address(gloam), 39e18, 0x1104, _route1(direct));
        _leaveAlone(k);
        // the same swap with a stranger's key is a different escrow: nothing is there
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        key.exitKey = vm.addr(0xBAD);
        address other = _v3().escrowFor(address(usd), key);
        assertTrue(other != _escrow(k));
        bytes memory theirs = _sign(0xBAD, _v3().exitDigest(other, outsider));
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        _v3().exit(address(usd), key, outsider, theirs);
        assertEq(usd.balanceOf(_escrow(k)), ARRIVES);
    }

    /// ecrecover answers address(0) to a bad signature: a swap with no exit key has no exit.
    function test_exit_is_shut_for_a_swap_with_no_exit_key() public {
        address real = exitKey;
        exitKey = address(0);
        Call memory k = _call(router, 1105, address(gloam), 39e18, 0x1105, _route1(direct));
        _leaveAlone(k);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        exitKey = real;
        bytes memory bad = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(5));
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        _v3().exit(address(usd), key, outsider, bad);
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        _v3().exit(address(usd), key, outsider, new bytes(65));
        assertEq(usd.balanceOf(_escrow(k)), ARRIVES);
    }

    function test_exit_signature_names_the_address() public {
        Call memory k = _call(router, 1106, address(gloam), 39e18, 0x1106, _route1(direct));
        _leaveAlone(k);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        bytes memory sig = _exitSig(k, exitTo);
        // a copy of the owner's exit, with the copier's address on it
        vm.prank(outsider);
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        _v3().exit(address(usd), key, outsider, sig);
        // sent as signed, it pays who it names, whoever sends it
        vm.prank(outsider);
        _v3().exit(address(usd), key, exitTo, sig);
        assertEq(usd.balanceOf(exitTo), ARRIVES);
        assertEq(usd.balanceOf(outsider), 0);
    }

    function test_exit_signature_is_for_this_chain_router_and_escrow() public {
        Call memory k = _call(router, 1107, address(gloam), 39e18, 0x1107, _route1(direct));
        Call memory other = _call(router, 1108, address(gloam), 39e18, 0x1108, _route1(direct));
        _leaveAlone(k);
        _leaveAlone(other);
        // signed for another escrow of the same key
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        bytes memory forOther = _exitSig(other, exitTo);
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        _v3().exit(address(usd), key, exitTo, forOther);
        // signed on another chain
        bytes32 here = _v3().exitDigest(_escrow(k), exitTo);
        vm.chainId(block.chainid + 1);
        assertTrue(_v3().exitDigest(_escrow(k), exitTo) != here);
        bytes memory sig = _sign(EXIT_PK, here);
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        _v3().exit(address(usd), key, exitTo, sig);
        vm.chainId(block.chainid - 1);
        // signed for another router
        PoolKey[] memory none = new PoolKey[](0);
        GloamVaultSwapV4c r2 = GloamVaultSwapV4c(payable(address(_newRouter(none))));
        assertTrue(r2.exitDigest(_escrow(k), exitTo) != here);
        _v3().exit(address(usd), key, exitTo, sig);
        assertEq(usd.balanceOf(exitTo), ARRIVES);
    }

    function test_exit_refuses_a_note_still_in_the_vault() public {
        Call memory k = _call(router, 1109, address(gloam), 39e18, 0x1109, _route1(direct));
        // money sent to the escrow by mistake is no reason to burn it
        usd.mint(_escrow(k), 5e6);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        bytes memory sig = _exitSig(k, exitTo);
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        _v3().exit(address(usd), key, exitTo, sig);
        // the swap still runs, and the mistake goes with its leftover
        _go(router, k);
        assertTrue(pool.commitmentSeen(k.d.commitment));
        assertEq(usd.balanceOf(treasury), ARRIVES + 5e6 - 97_500_000);
    }

    function test_exit_refuses_a_note_spent_elsewhere() public {
        Call memory k = _call(router, 1110, address(gloam), 39e18, 0x1110, _route1(direct));
        pool.unshield(abi.encode(address(0xCA5)), k.s.root, k.s.nullifier, k.s.asset, address(0xCA5), k.s.amount);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        bytes memory sig = _exitSig(k, exitTo);
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        _v3().exit(address(usd), key, exitTo, sig);
    }

    /// Nowhere the money would stop for good: nothing, the router, the vault, the escrow itself,
    /// the token's own contract, the PoolManager or WETH.
    function test_exit_refuses_places_the_money_would_stop() public {
        Call memory k = _call(router, 1111, address(gloam), 39e18, 0x1111, _route1(direct));
        _leaveAlone(k);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        address[7] memory bad =
            [address(0), address(router), address(pool), _escrow(k), address(usd), address(_v3().poolManager()), _v3().weth()];
        for (uint256 i = 0; i < bad.length; i++) {
            bytes memory sig = _exitSig(k, bad[i]);
            vm.expectRevert(GloamVaultSwap2.BadExit.selector);
            _v3().exit(address(usd), key, bad[i], sig);
        }
        assertEq(usd.balanceOf(_escrow(k)), ARRIVES);
        _v3().exit(address(usd), key, exitTo, _exitSig(k, exitTo));
        assertEq(usd.balanceOf(exitTo), ARRIVES, "and then where it can go");
    }

    /// The same for an ETH note: WETH would wrap it for the escrow, and the PoolManager keeps it.
    function test_exit_of_an_eth_note_refuses_its_escrow_weth_and_the_pool_manager() public {
        Call memory k = _callFrom(router, 1160, NATIVE, ENOTE, address(usd), 110e6, 0x1160, _route1(ethUsd));
        _leaveAlone(k);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        address[3] memory bad = [_escrow(k), _v3().weth(), address(_v3().poolManager())];
        for (uint256 i = 0; i < bad.length; i++) {
            bytes memory sig = _exitSig(k, bad[i]);
            vm.expectRevert(GloamVaultSwap2.BadExit.selector);
            _v3().exit(NATIVE, key, bad[i], sig);
        }
        assertEq(_escrow(k).balance, EARRIVES, "the money still waits");
        // and the refund still lands
        pool.setDepositLimit(NATIVE, 10 ether, 100 ether);
        vm.prank(outsider);
        _go(router, k);
        assertTrue(pool.commitmentSeen(k.r.commitment));
    }

    /// An opened escrow keeps one byte of code that refuses every call: ETH sent to it later is
    /// refused, and a second opening is refused at once, without using up the caller's gas.
    function test_an_opened_escrow_is_refused_at_once_and_takes_no_eth() public {
        Call memory k = _call(router, 1161, address(gloam), 39e18, 0x1161, _route1(direct));
        _leaveAlone(k);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        _v3().exit(address(usd), key, exitTo, _exitSig(k, exitTo));
        address e = _escrow(k);
        assertEq(e.code, hex"fe");
        vm.deal(outsider, 1 ether);
        vm.prank(outsider);
        (bool sent, ) = e.call{value: 1}("");
        assertFalse(sent, "no ETH into an opened escrow");
        // something sent to it later: a second exit is refused as used, cheaply
        usd.mint(e, 1);
        address second = address(0xE41A);
        bytes memory data = abi.encodeCall(GloamVaultSwap2.exit, (address(usd), key, second, _exitSig(k, second)));
        uint256 g = gasleft();
        (bool ok, bytes memory ret) = address(router).call{gas: 5_000_000}(data);
        uint256 used = g - gasleft();
        assertFalse(ok);
        assertEq(bytes4(ret), GloamVaultSwap2.EscrowUsed.selector);
        assertLt(used, 200_000, "the caller's gas is not used up");
    }

    /// An escrow whose constructor stops with no reason (out of gas here, copying what a token
    /// sent back) says so, apart from an escrow opened before. The money still waits.
    function test_an_escrow_that_stops_with_no_reason_says_so() public {
        BigReturnToken rb = new BigReturnToken();
        pool.setDepositLimit(address(rb), 500e6, 25_000e6);
        rb.mint(depositor, 1_000e6);
        vm.startPrank(depositor);
        rb.approve(address(pool), type(uint256).max);
        pool.shieldBound(address(rb), NOTE, bytes32(uint256(0xFBFB)), hex"00");
        vm.stopPrank();
        Call memory k = _callFrom(router, 1162, address(rb), NOTE, address(gloam), 39e18, 0x1162, _route1(direct));
        _leaveAlone(k);
        rb.sendBackLotsFrom(_escrow(k));
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        bytes memory sig = _exitSig(k, exitTo);
        vm.expectRevert(GloamVaultSwap2.EscrowFailed.selector);
        _v3().exit{gas: 3_000_000}(address(rb), key, exitTo, sig);
        assertEq(rb.balanceOf(_escrow(k)), ARRIVES, "still there");
        rb.sendBackLotsFrom(address(0));
        _v3().exit(address(rb), key, exitTo, sig);
        assertEq(rb.balanceOf(exitTo), ARRIVES);
    }

    /// An address that can't be paid fails the exit, not the money: sign for another and go again.
    function test_exit_to_an_address_the_issuer_blocks_keeps_the_money_and_can_go_elsewhere() public {
        FreezeToken ft = new FreezeToken();
        pool.setDepositLimit(address(ft), 500e6, 25_000e6);
        ft.mint(depositor, 1_000e6);
        vm.startPrank(depositor);
        ft.approve(address(pool), type(uint256).max);
        pool.shieldBound(address(ft), NOTE, bytes32(uint256(0xF7F7)), hex"00");
        vm.stopPrank();
        Call memory k = _callFrom(router, 1112, address(ft), NOTE, address(gloam), 39e18, 0x1112, _route1(direct));
        _leaveAlone(k);
        ft.freeze(exitTo, true);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        bytes memory blocked = _exitSig(k, exitTo);
        vm.expectRevert(GloamVaultSwap2.TokenCallFailed.selector);
        _v3().exit(address(ft), key, exitTo, blocked);
        assertEq(ft.balanceOf(_escrow(k)), ARRIVES, "still there");

        address second = address(0xE418);
        _v3().exit(address(ft), key, second, _exitSig(k, second));
        assertEq(ft.balanceOf(second), ARRIVES);
    }

    function test_exit_eth_to_an_address_that_refuses_keeps_the_money() public {
        Call memory k = _callFrom(router, 1113, NATIVE, ENOTE, address(usd), 110e6, 0x1113, _route1(ethUsd));
        _leaveAlone(k);
        ReenterReceiver c = new ReenterReceiver();
        c.setRefuse(true);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        bytes memory sig = _exitSig(k, address(c));
        vm.expectRevert(GloamVaultSwap2.TokenCallFailed.selector);
        _v3().exit(NATIVE, key, address(c), sig);
        assertEq(_escrow(k).balance, EARRIVES);
        c.setRefuse(false);
        _v3().exit(NATIVE, key, address(c), sig);
        assertEq(address(c).balance, EARRIVES);
    }

    // ── once, and only once

    /// An escrow that can't hand its ETH over must not deploy: it would leave the money in an address
    /// nothing can ever open again. A send that runs out of gas fails the same way.
    function test_escrow_that_cannot_pay_never_deploys() public {
        NoEthOpener opener = new NoEthOpener();
        bytes32 salt = bytes32(uint256(0xE5));
        address at = opener.at(salt);
        vm.deal(at, 1 ether);
        vm.expectRevert();
        opener.open(salt);
        assertEq(at.balance, 1 ether, "still there");
        assertEq(at.code.length, 0);
        // and with the router short of gas, the whole call fails instead of burning the escrow
        Call memory k = _callFrom(router, 1124, NATIVE, ENOTE, address(usd), 110e6, 0x1124, _route1(ethUsd));
        _leaveAlone(k);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        bytes memory sig = _exitSig(k, exitTo);
        (bool ok, ) = address(router).call{gas: 90_000}(abi.encodeCall(GloamVaultSwap2.exit, (NATIVE, key, exitTo, sig)));
        assertFalse(ok, "out of gas");
        assertEq(_escrow(k).balance, EARRIVES, "the money still waits");
        _v3().exit(NATIVE, key, exitTo, sig);
        assertEq(exitTo.balance, EARRIVES, "and the exit still works");
    }

    function test_exit_twice_pays_once() public {
        Call memory k = _callFrom(router, 1120, NATIVE, ENOTE, address(usd), 110e6, 0x1120, _route1(ethUsd));
        _leaveAlone(k);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        bytes memory sig = _exitSig(k, exitTo);
        _v3().exit(NATIVE, key, exitTo, sig);
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        _v3().exit(NATIVE, key, exitTo, sig);
        // even with more money waiting at the used address
        vm.deal(_escrow(k), 1 ether);
        vm.expectRevert(GloamVaultSwap2.EscrowUsed.selector);
        _v3().exit(NATIVE, key, exitTo, sig);
        assertEq(exitTo.balance, EARRIVES);
    }

    function test_refund_then_exit_pays_once() public {
        Call memory k = _call(router, 1121, address(gloam), 39e18, 0x1121, _route1(direct));
        _leaveAlone(k);
        _go(router, k);
        assertTrue(pool.commitmentSeen(k.r.commitment));
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        bytes memory sig = _exitSig(k, exitTo);
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        _v3().exit(address(usd), key, exitTo, sig);
        assertEq(usd.balanceOf(exitTo), 0);
    }

    function test_exit_then_refund_pays_once() public {
        Call memory k = _call(router, 1122, address(gloam), 39e18, 0x1122, _route1(direct));
        _leaveAlone(k);
        _v3().exit(address(usd), _keyOf(k), exitTo, _exitSig(k, exitTo));
        vm.expectRevert(GloamVaultSwap2.BadRefund.selector);
        _go(router, k);
        assertFalse(pool.commitmentSeen(k.r.commitment));
        // and money that lands at the used escrow later can't reopen it
        usd.mint(_escrow(k), ARRIVES);
        vm.expectRevert(GloamVaultSwap2.EscrowUsed.selector);
        _go(router, k);
    }

    function test_a_done_swap_has_no_exit() public {
        Call memory k = _call(router, 1123, address(gloam), 39e18, 0x1123, _route1(direct));
        _go(router, k);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        bytes memory sig = _exitSig(k, exitTo);
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        _v3().exit(address(usd), key, exitTo, sig);
    }

    // ── what the swap's proofs can't do

    /// A caller who copies the swap and names their own exit key gets another escrow, so the proof fails.
    function test_the_escrow_key_fixes_the_exit_key() public {
        Call memory k = _call(router, 1130, address(gloam), 39e18, 0x1130, _route1(direct));
        address real = exitKey;
        exitKey = vm.addr(0xBAD);
        vm.expectRevert(ShieldPoolCore.InvalidProof.selector);
        _go(router, k);
        exitKey = real;
        assertFalse(pool.isSpent(k.s.nullifier));
        _go(router, k);
        assertTrue(pool.commitmentSeen(k.d.commitment));
    }

    /// The route, the notes and the amounts stay fixed with the longer key.
    function test_the_escrow_key_still_fixes_every_field() public view {
        Call memory k = _call(router, 1131, address(gloam), 39e18, 0x1131, _route1(direct));
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        address base = _v3().escrowFor(address(usd), key);
        assertEq(base, _escrow(k));

        GloamVaultSwap2.EscrowKey memory c = _keyOf(k);
        c.nullifier = bytes32(uint256(1));
        assertTrue(_v3().escrowFor(address(usd), c) != base, "nullifier");
        c = _keyOf(k);
        c.amountIn += 1;
        assertTrue(_v3().escrowFor(address(usd), c) != base, "amount in");
        c = _keyOf(k);
        c.outCommitment = bytes32(uint256(1));
        assertTrue(_v3().escrowFor(address(usd), c) != base, "new note");
        c = _keyOf(k);
        c.assetOut = address(stock);
        assertTrue(_v3().escrowFor(address(usd), c) != base, "asset out");
        c = _keyOf(k);
        c.amountOut += 1;
        assertTrue(_v3().escrowFor(address(usd), c) != base, "amount out");
        c = _keyOf(k);
        c.refundCommitment = bytes32(uint256(1));
        assertTrue(_v3().escrowFor(address(usd), c) != base, "refund note");
        c = _keyOf(k);
        c.refundAmount += 1;
        assertTrue(_v3().escrowFor(address(usd), c) != base, "refund amount");
        c = _keyOf(k);
        c.routeHash = keccak256(_route1(ethUsd));
        assertTrue(_v3().escrowFor(address(usd), c) != base, "route");
        c = _keyOf(k);
        c.exitKey = address(1);
        assertTrue(_v3().escrowFor(address(usd), c) != base, "exit key");
        c = _keyOf(k);
        c.deadline -= 1;
        assertTrue(_v3().escrowFor(address(usd), c) != base, "deadline");
        assertTrue(_v3().escrowFor(address(gloam), key) != base, "asset in");
    }

    /// The exit is no way around the vault's fee: it pays what arrived, after the fee.
    function test_the_exit_pays_after_the_vaults_fee() public {
        Call memory k = _call(router, 1132, address(gloam), 39e18, 0x1132, _route1(direct));
        uint256 owed = pool.feesOwed(address(usd));
        _leaveAlone(k);
        _v3().exit(address(usd), _keyOf(k), exitTo, _exitSig(k, exitTo));
        assertEq(pool.feesOwed(address(usd)), owed + NOTE - ARRIVES);
        assertEq(usd.balanceOf(exitTo), ARRIVES);
    }

    // ── reentrancy, with ETH moving

    function test_exit_receiver_cannot_reenter() public {
        Call memory k = _callFrom(router, 1140, NATIVE, ENOTE, address(usd), 110e6, 0x1140, _route1(ethUsd));
        Call memory other = _callFrom(router, 1141, NATIVE, ENOTE, address(usd), 110e6, 0x1141, _route1(ethUsd));
        _leaveAlone(k);
        _leaveAlone(other);
        ReenterReceiver c = new ReenterReceiver();
        // back into exit for the second escrow, and for the same one
        c.arm(address(router), abi.encodeCall(GloamVaultSwap2.exit, (NATIVE, _keyOf(other), address(c), _exitSig(other, address(c)))));
        _v3().exit(NATIVE, _keyOf(k), address(c), _exitSig(k, address(c)));
        assertTrue(c.tried());
        assertFalse(c.lastOk());
        assertEq(bytes4(c.lastRet()), GloamVaultSwap2.Reentrancy.selector);
        assertEq(address(c).balance, EARRIVES);
        assertEq(_escrow(other).balance, EARRIVES, "the other one still waits");

        // back into swap
        Call memory third = _callFrom(router, 1142, NATIVE, ENOTE, address(usd), 110e6, 0x1142, _route1(ethUsd));
        ReenterReceiver c2 = new ReenterReceiver();
        c2.arm(address(router), _swapData(third));
        _v3().exit(NATIVE, _keyOf(other), address(c2), _exitSig(other, address(c2)));
        assertFalse(c2.lastOk());
        assertEq(bytes4(c2.lastRet()), GloamVaultSwap2.Reentrancy.selector);
        assertFalse(pool.isSpent(third.s.nullifier));
    }

    function test_exit_receiver_cannot_send_eth_back_to_the_router() public {
        Call memory k = _callFrom(router, 1143, NATIVE, ENOTE, address(usd), 110e6, 0x1143, _route1(ethUsd));
        _leaveAlone(k);
        ReenterReceiver c = new ReenterReceiver();
        c.arm(address(router), "");
        _v3().exit(NATIVE, _keyOf(k), address(c), _exitSig(k, address(c)));
        assertFalse(c.lastOk());
        assertEq(bytes4(c.lastRet()), GloamVaultSwap2.NativeRefused.selector);
    }

    // ── an exit is paid by the escrow itself

    /// A token that won't pay the router keeps a refund from landing; the exit still pays, as the
    /// escrow pays its recipient itself.
    function test_exit_pays_from_the_escrow_when_the_token_blocks_the_router() public {
        FreezeToken ft = new FreezeToken();
        pool.setDepositLimit(address(ft), 500e6, 25_000e6);
        ft.mint(depositor, 1_000e6);
        vm.startPrank(depositor);
        ft.approve(address(pool), type(uint256).max);
        pool.shieldBound(address(ft), NOTE, bytes32(uint256(0xF8F8)), hex"00");
        vm.stopPrank();
        Call memory k = _callFrom(router, 1150, address(ft), NOTE, address(gloam), 39e18, 0x1150, _route1(direct));
        _leaveAlone(k);
        ft.freeze(address(router), true);
        vm.expectRevert(GloamVaultSwap2.TokenCallFailed.selector);
        _go(router, k);
        assertEq(ft.balanceOf(_escrow(k)), ARRIVES, "the refund can't land");
        uint256 paid = _v3().exit(address(ft), _keyOf(k), exitTo, _exitSig(k, exitTo));
        assertEq(paid, ARRIVES);
        assertEq(ft.balanceOf(exitTo), ARRIVES);
        assertEq(ft.balanceOf(address(router)), 0);
        assertEq(ft.balanceOf(_escrow(k)), 0);
    }

    function test_an_exit_of_eth_never_passes_through_the_router() public {
        Call memory k = _callFrom(router, 1151, NATIVE, ENOTE, address(usd), 110e6, 0x1151, _route1(ethUsd));
        _leaveAlone(k);
        uint256 before = address(router).balance;
        assertEq(_v3().escrowPayee(), address(router));
        _v3().exit(NATIVE, _keyOf(k), exitTo, _exitSig(k, exitTo));
        assertEq(exitTo.balance, EARRIVES);
        assertEq(address(router).balance, before);
        assertEq(_v3().escrowPayee(), address(router), "the router is the payee again");
    }

    /// While an escrow opens, the router takes ETH from anyone, but only the escrow's constructor can run then.
    function test_receive_is_shut_outside_a_swap_and_an_open() public {
        vm.deal(outsider, 1 ether);
        vm.prank(outsider);
        (bool ok, bytes memory ret) = address(router).call{value: 1}("");
        assertFalse(ok);
        assertEq(bytes4(ret), GloamVaultSwap2.NativeRefused.selector);
    }

    /// A token whose transfer runs code while an escrow opens gets nowhere: the latch is closed.
    function test_a_token_that_calls_back_while_an_escrow_opens_cannot_reenter() public {
        CallbackToken evil = new CallbackToken();
        pool.setDepositLimit(address(evil), 1e30, 1e30);
        evil.mint(depositor, 1_000e6);
        vm.startPrank(depositor);
        evil.approve(address(pool), type(uint256).max);
        pool.shieldBound(address(evil), NOTE, bytes32(uint256(0x7777)), hex"00");
        vm.stopPrank();
        Call memory inner = _call(router, 1144, address(gloam), 39e18, 0x1144, _route1(direct));
        Call memory k = _callFrom(router, 1145, address(evil), NOTE, address(gloam), 39e18, 0x1145, _route1(direct));
        _leaveAlone(k);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        bytes memory sig = _exitSig(k, exitTo);
        // an exit: the escrow pays its recipient, and the call goes off then. The latch stops it
        // inside the escrow's constructor, which fails, so the escrow never opens
        evil.armOn(exitTo, address(router), _swapData(inner));
        vm.expectRevert(GloamVaultSwap2.TokenCallFailed.selector);
        _v3().exit(address(evil), key, exitTo, sig);
        // a refund: the escrow pays the router, and the same
        evil.arm(address(router), _swapData(inner));
        vm.expectRevert(GloamVaultSwap2.TokenCallFailed.selector);
        _go(router, k);
        assertFalse(pool.isSpent(inner.s.nullifier));
        assertEq(evil.balanceOf(_escrow(k)), ARRIVES, "still waiting");
    }

    // ═════════════════════════════════════════════════════════════ the deadline

    function test_deadline_a_swap_lands_up_to_its_last_second() public {
        swapDeadline = block.timestamp + 30 minutes;
        Call memory k = _call(router, 1300, address(gloam), 39e18, 0x1300, _route1(direct));
        vm.warp(swapDeadline);
        _go(router, k);
        assertTrue(pool.commitmentSeen(k.d.commitment), "lands at the deadline itself");
        _assertRouterEmpty();
    }

    function test_deadline_a_swap_past_it_moves_nothing() public {
        swapDeadline = block.timestamp + 30 minutes;
        Call memory k = _call(router, 1301, address(gloam), 39e18, 0x1301, _route1(direct));
        vm.warp(swapDeadline + 1);
        vm.expectRevert(GloamVaultSwap2.SwapExpired.selector);
        _go(router, k);
        _assertNothingMoved(k, 4 * NOTE);
        assertEq(usd.balanceOf(_escrow(k)), 0);
    }

    function test_deadline_an_eth_note_swap_past_it_moves_nothing() public {
        swapDeadline = block.timestamp + 30 minutes;
        Call memory k = _callFrom(router, 1302, NATIVE, ENOTE, address(usd), 110e6, 0x1302, _route1(ethUsd));
        vm.warp(swapDeadline + 1);
        vm.expectRevert(GloamVaultSwap2.SwapExpired.selector);
        _go(router, k);
        _assertNothingMoved(k, 4 * ENOTE);
    }

    function test_deadline_is_fixed_by_the_proof() public {
        swapDeadline = block.timestamp + 30 minutes;
        Call memory k = _call(router, 1303, address(gloam), 39e18, 0x1303, _route1(direct));
        // the same swap with a later deadline is another escrow, and the proof names this one
        swapDeadline += 1 days;
        vm.expectRevert(ShieldPoolCore.InvalidProof.selector);
        _go(router, k);
        assertFalse(pool.isSpent(k.s.nullifier));
    }

    function test_deadline_never_holds_back_a_refund() public {
        swapDeadline = block.timestamp + 30 minutes;
        Call memory k = _call(router, 1304, address(gloam), 39e18, 0x1304, _route1(direct));
        vm.warp(swapDeadline + 365 days);
        _leaveAlone(k);
        vm.prank(relayer);
        assertEq(_go(router, k), 0);
        assertTrue(pool.commitmentSeen(k.r.commitment), "the refund landed a year late");
        _assertRouterEmpty();
    }

    function test_deadline_never_holds_back_an_exit() public {
        swapDeadline = block.timestamp + 30 minutes;
        Call memory k = _callFrom(router, 1305, NATIVE, ENOTE, address(usd), 110e6, 0x1305, _route1(ethUsd));
        vm.warp(swapDeadline + 365 days);
        _leaveAlone(k);
        _v3().exit(NATIVE, _keyOf(k), exitTo, _exitSig(k, exitTo));
        assertEq(exitTo.balance, EARRIVES, "the exit paid a year late");
    }

    /// Money that left for its escrow before the deadline can still come back after it.
    function test_deadline_a_note_left_before_it_comes_back_after_it() public {
        swapDeadline = block.timestamp + 30 minutes;
        Call memory k = _call(router, 1306, address(gloam), 39e18, 0x1306, _route1(direct));
        _leaveAlone(k);
        vm.warp(swapDeadline + 1);
        assertEq(_go(router, k), 0);
        assertTrue(pool.commitmentSeen(k.r.commitment));
    }

    function test_deadline_on_tempo() public {
        (GloamVaultSwapTempo2 t, MockERC20 usdt, ) = _tempo();
        GloamVaultSwap on = GloamVaultSwap(address(t));
        swapDeadline = block.timestamp + 30 minutes;
        Call memory k = _call(on, 1307, address(usdt), 99e6, 0x1307, "");
        vm.warp(swapDeadline + 1);
        vm.expectRevert(GloamVaultSwap2.SwapExpired.selector);
        _go(on, k);
        assertFalse(pool.isSpent(k.s.nullifier));
        // and its refund and exit stay open
        _leaveAlone(k);
        assertEq(_go(on, k), 0);
        assertTrue(pool.commitmentSeen(k.r.commitment));
    }

    /// At any time: a swap lands only up to its deadline, and a refund lands either way.
    function testFuzz_deadline_gates_the_swap_and_nothing_else(uint32 wait, bool leftAlone) public {
        swapDeadline = block.timestamp + 30 minutes;
        Call memory k = _call(router, 1308, address(gloam), 39e18, 0x1308, _route1(direct));
        if (leftAlone) _leaveAlone(k);
        vm.warp(block.timestamp + wait);
        if (!leftAlone && block.timestamp > swapDeadline) {
            vm.expectRevert(GloamVaultSwap2.SwapExpired.selector);
            _go(router, k);
            assertFalse(pool.isSpent(k.s.nullifier));
            return;
        }
        _go(router, k);
        assertTrue(pool.commitmentSeen(leftAlone ? k.r.commitment : k.d.commitment));
    }

    // ═════════════════════════════════════════════════════════════ fuzz

    /// Any price, any size, into or out of ETH, on either form of pool: exact accounting, or nothing moves.
    function testFuzz_v3_eth_note_swaps_account_exactly(uint256 want, uint256 price, bool wethPool, bool fromEth) public {
        price = bound(price, 1_000, 5_000);
        PoolKey memory p = wethPool ? wethUsd : ethUsd;
        address ethSide = wethPool ? address(weth) : NATIVE;
        _rate(p, address(usd), price, 10 ** 12);
        _rate(p, ethSide, 10 ** 12, price);

        Call memory k;
        uint256 arrives;
        uint256 cost;
        if (fromEth) {
            want = bound(want, 1, 300e6);
            k = _callFrom(router, 1200, NATIVE, ENOTE, address(usd), want, 0x1200, _route1(p));
            arrives = EARRIVES;
            cost = (want * 10 ** 12 + price - 1) / price;
        } else {
            want = bound(want, 1, 0.1 ether);
            k = _callFrom(router, 1201, address(usd), NOTE, NATIVE, want, 0x1201, _route1(p));
            arrives = ARRIVES;
            cost = (want * price + 10 ** 12 - 1) / 10 ** 12;
        }
        uint256 depIn = pool.deposited(k.s.asset);
        uint256 depOut = pool.deposited(k.d.asset);
        if (cost > arrives) {
            vm.expectRevert(abi.encodeWithSelector(GloamVaultSwap2.OverInput.selector, cost, arrives));
            _go(router, k);
            _assertNothingMoved(k, depIn);
            return;
        }
        uint256 tBefore = fromEth ? treasury.balance : usd.balanceOf(treasury);
        assertEq(_go(router, k), cost);
        assertEq(pool.deposited(k.s.asset), depIn - k.s.amount);
        assertEq(pool.deposited(k.d.asset), depOut + want);
        assertEq((fromEth ? treasury.balance : usd.balanceOf(treasury)) - tBefore, arrives - cost, "every unit accounted");
        assertEq(_escrow(k).balance, 0);
        _assertRouterEmpty();
        _assertVaultBacked();
        _assertEthBacked();
    }

    /// Nobody but the exit key can take the money, whatever they sign and wherever they point it.
    function testFuzz_exit_needs_exactly_the_exit_key(uint256 pk, address to) public {
        pk = bound(pk, 1, 115792089237316195423570985008687907852837564279074904382605163141518161494336);
        vm.assume(pk != EXIT_PK);
        vm.assume(to != address(0) && to != address(router) && to != address(pool));
        Call memory k = _callFrom(router, 1202, NATIVE, ENOTE, address(usd), 110e6, 0x1202, _route1(ethUsd));
        _leaveAlone(k);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        bytes memory sig = _sign(pk, _v3().exitDigest(_escrow(k), to));
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        _v3().exit(NATIVE, key, to, sig);
        assertEq(_escrow(k).balance, EARRIVES);
    }

    /// Whatever order a refund, an exit and a repeat of either come in, the money lands once.
    function testFuzz_refund_and_exit_land_once(uint8 order, bool eth) public {
        Call memory k = eth
            ? _callFrom(router, 1203, NATIVE, ENOTE, address(usd), 110e6, 0x1203, _route1(ethUsd))
            : _call(router, 1204, address(gloam), 39e18, 0x1204, _route1(direct));
        address asset = k.s.asset;
        uint256 arrives = eth ? EARRIVES : ARRIVES;
        _leaveAlone(k);
        uint256 vaultBefore = pool.deposited(asset);
        GloamVaultSwap2.EscrowKey memory key = _keyOf(k);
        bytes memory sig = _exitSig(k, exitTo);

        uint256 landed;
        for (uint256 i = 0; i < 4; i++) {
            bool exitFirst = (order >> i) & 1 == 1;
            if (exitFirst) {
                try _v3().exit(asset, key, exitTo, sig) {
                    landed++;
                } catch {}
            } else {
                try this.goExternal(k) {
                    landed++;
                } catch {}
            }
        }
        assertEq(landed, 1, "exactly one way out ran");
        uint256 paid = eth ? exitTo.balance : usd.balanceOf(exitTo);
        uint256 back = pool.deposited(asset) - vaultBefore;
        uint256 toTreasury = eth ? treasury.balance : usd.balanceOf(treasury);
        assertEq(paid + back + toTreasury, arrives, "every unit that arrived, accounted once");
        assertTrue(paid == 0 || back == 0, "never both");
        _assertRouterEmpty();
    }

    function goExternal(Call memory k) external returns (uint256) {
        return _go(router, k);
    }
}

/// Deploys an ETH escrow from a contract that refuses ETH, so the escrow's send fails.
contract NoEthOpener {
    function at(bytes32 salt) external view returns (address) {
        bytes32 code = keccak256(abi.encodePacked(type(SwapEscrow2).creationCode, abi.encode(address(0))));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, code)))));
    }

    function open(bytes32 salt) external {
        new SwapEscrow2{salt: salt}(address(0));
    }
}

/// A token that takes a cut of whatever one address sends.
contract SkimToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public skimmed;
    uint256 public cut;

    function skimFrom(address who, uint256 amount) external {
        skimmed = who;
        cut = amount;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += msg.sender == skimmed ? a - cut : a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// A token that runs code on every transfer to the router.
contract CallbackToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public target;
    bytes public payload;
    /// @dev Who a transfer to sets the call off: the target unless set.
    address public on;

    function arm(address t, bytes calldata p) external {
        on = address(0);
        target = t;
        payload = p;
    }

    function armOn(address o, address t, bytes calldata p) external {
        on = o;
        target = t;
        payload = p;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        if (target != address(0) && to == (on == address(0) ? target : on)) {
            (bool ok, bytes memory ret) = target.call(payload);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// Tempo's TIP-403 registry, as far as receive policies go: refuses what it is told to.
contract MockReceivePolicy {
    mapping(bytes32 => bool) public refused;

    function refuse(address token, address sender, address receiver) external {
        refused[keccak256(abi.encode(token, sender, receiver))] = true;
    }

    function validateReceivePolicy(address token, address sender, address receiver) external view returns (bool, uint8) {
        bool no = refused[keccak256(abi.encode(token, sender, receiver))];
        return (!no, no ? 2 : 0);
    }
}

/// Tempo's address registry: a virtual address forwards to its master.
contract MockAddressRegistry {
    mapping(address => address) public master;

    function set(address virtualAddress, address to) external {
        master[virtualAddress] = to;
    }

    function resolveRecipient(address to) external view returns (address) {
        address m = master[to];
        return m == address(0) ? to : m;
    }
}

/// A registry with no receive policies to answer for.
contract RevertingRegistry {
    fallback() external {
        revert("no such method");
    }
}

/// A token that, for one sender, sends back a megabyte from transfer: copying it runs the caller out of gas.
contract BigReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public bigFrom;

    function sendBackLotsFrom(address who) external {
        bigFrom = who;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        if (msg.sender == bigFrom && bigFrom != address(0)) {
            // as much as six tenths of the gas left pays to send back: the caller has less to copy it
            uint256 words = _sqrt((gasleft() * 6 / 10) * 512);
            assembly {
                mstore(0, 1)
                return(0, mul(words, 32))
            }
        }
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }

    function _sqrt(uint256 x) private pure returns (uint256 y) {
        y = x;
        uint256 z = (x + 1) / 2;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}

/// A token that holds payments to some recipients somewhere else, as Tempo's receive-policy guard does.
contract HoldingToken {
    address public constant GUARD = address(0x4010);
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public held;

    function holdFor(address who) external {
        held[who] = true;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[held[to] ? GUARD : to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[held[to] ? GUARD : to] += a;
        return true;
    }
}
