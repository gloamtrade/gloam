// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// GloamVaultSwapV4c against the REAL PoolManager on a local fork of each chain:
// every one of the deploy script's pools in both directions, with native ETH and
// WETH notes on either side where a pool holds ETH, the multi-hop routes the app
// builds, a refund and an exit in the chain's real tokens (Tether's USDT on
// Ethereum among them), and the deposit cap holding a refund back. Exact
// accounting on every swap: the spend equals the router's own exact-output quote,
// the new note is exact, the leftover and any extra output go to the treasury,
// and the router and the escrow end empty. A fresh vault with accept-all verifiers
// stands in for the live one, so the gas printed here leaves out the proof checks.
//
// Off by default (it reads mainnet over RPC). From contracts/, once per chain (the
// PoolManager uses transient storage, so Cancun):
//   ROUTER_FORK=robinhood forge test --evm-version cancun --match-path test/fork/VaultSwapV4cFork.t.sol -vv
//   ROUTER_FORK=base ...      ROUTER_FORK=ethereum ...
// A run takes minutes, so use an RPC that keeps state that long: RH_FORK_URL,
// BASE_FORK_URL and ETH_FORK_URL pick it.

import {Test, console2} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolPayments} from "../../src/ShieldPoolPayments.sol";
import {IVerifier} from "../../src/interfaces/IVerifier.sol";
import {GloamVaultSwap2} from "../../src/GloamVaultSwap2.sol";
import {PoolKey, SwapParams, IPoolManagerSwap} from "../../src/GloamVaultSwapV4.sol";
import {GloamVaultSwapV4c} from "../../src/GloamVaultSwapV4c.sol";
import {DeployVaultSwapV4c} from "../../script/DeployVaultSwapV4c.s.sol";

interface IERC20C {
    function balanceOf(address) external view returns (uint256);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

interface IWETHC {
    function deposit() external payable;
}

interface IExtC {
    function extsload(bytes32) external view returns (bytes32);
}

contract CAccept is IVerifier {
    function verify(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return true;
    }
}

/// Unshield proofs "bind" `to`: the proof bytes are the address the vault must pay.
contract CBind is IVerifier {
    function verify(bytes calldata proof, uint256[] calldata inputs) external pure returns (bool) {
        if (inputs.length != 5) return true;
        return abi.decode(proof, (address)) == address(uint160(inputs[4]));
    }
}

/// Exact-output cost of a route, hop by hop from the last, exactly as the router does it.
contract CQuoter {
    IPoolManagerSwap immutable pm;
    error Quote(uint256 cost, uint256 finalOut);

    constructor(address pm_) {
        pm = IPoolManagerSwap(pm_);
    }

    function quote(PoolKey[] memory hops, bool[] memory z, uint256 amountOut) external returns (uint256 cost, uint256 finalOut) {
        try this.q(hops, z, amountOut) {} catch (bytes memory r) {
            if (r.length == 68 && bytes4(r) == Quote.selector) {
                assembly {
                    cost := mload(add(r, 36))
                    finalOut := mload(add(r, 68))
                }
                return (cost, finalOut);
            }
            assembly {
                revert(add(r, 32), mload(r))
            }
        }
    }

    function q(PoolKey[] memory hops, bool[] memory z, uint256 amountOut) external {
        pm.unlock(abi.encode(hops, z, amountOut));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey[] memory hops, bool[] memory z, uint256 want) = abi.decode(data, (PoolKey[], bool[], uint256));
        uint256 finalOut;
        for (uint256 i = hops.length; i > 0; i--) {
            int256 d = pm.swap(
                hops[i - 1],
                SwapParams(z[i - 1], int256(want), z[i - 1] ? 4295128739 + 1 : 1461446703485210103287273052203988822378723970342 - 1),
                ""
            );
            int128 a0 = int128(d >> 128);
            int128 a1 = int128(d);
            int128 o = z[i - 1] ? a1 : a0;
            int128 n = z[i - 1] ? a0 : a1;
            if (i == hops.length) finalOut = uint256(uint128(o));
            want = uint256(uint128(-n));
        }
        revert Quote(want, finalOut);
    }
}

contract VaultSwapV4cForkTest is Test {
    using stdJson for string;

    address constant NATIVE = address(0);
    uint256 constant EXIT_PK = 0xE817;
    uint256 constant DEADLINE = type(uint64).max;

    ShieldPoolPayments pool;
    GloamVaultSwapV4c router;
    CQuoter quoter;
    address pm;
    address weth;
    PoolKey[] p;
    address treasury = address(0x7EA5);
    address depositor = address(0xD0D0);
    uint256 nul = 1;
    uint256 failures;
    uint256 ran;
    string which;

    struct Snap {
        uint256 cost;
        uint256 finalOut;
        uint256 note;
        uint256 arrives;
        uint256 depIn;
        uint256 depOut;
        uint256 tIn;
        uint256 tOut;
        address escrow;
        address assetIn;
        address assetOut;
        uint256 want;
        string label;
    }

    struct Call {
        GloamVaultSwap2.Spend s;
        GloamVaultSwap2.Deposit d;
        GloamVaultSwap2.Deposit r;
        bytes route;
    }

    function setUp() public {
        which = vm.envOr("ROUTER_FORK", string(""));
        if (bytes(which).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 id;
        if (_is("robinhood")) {
            vm.createSelectFork(vm.envOr("RH_FORK_URL", string("https://rpc.mainnet.chain.robinhood.com")));
            id = 4663;
        } else if (_is("base")) {
            vm.createSelectFork(vm.envOr("BASE_FORK_URL", string("https://gateway.tenderly.co/public/base")));
            id = 8453;
        } else {
            vm.createSelectFork(vm.envOr("ETH_FORK_URL", string("https://gateway.tenderly.co/public/mainnet")));
            id = 1;
        }
        DeployVaultSwapV4c d = new DeployVaultSwapV4c{salt: bytes32(uint256(1))}();
        PoolKey[] memory ps;
        (pm, weth, ps) = d.config(id);
        pool = new ShieldPoolPayments{salt: bytes32(uint256(1))}(_deployPoseidon(), address(new CBind{salt: bytes32(uint256(1))}()));
        pool.setShieldVerifier(address(new CAccept{salt: bytes32(uint256(1))}()));
        pool.setWithdrawFee(25, address(0xFEE));
        pool.turnOnDepositLimits();
        pool.setDepositLimit(NATIVE, type(uint128).max, type(uint128).max);
        pool.setDepositLimit(weth, type(uint128).max, type(uint128).max);
        for (uint256 i = 0; i < ps.length; i++) {
            p.push(ps[i]);
            if (ps[i].currency0 != NATIVE) pool.setDepositLimit(ps[i].currency0, type(uint128).max, type(uint128).max);
            pool.setDepositLimit(ps[i].currency1, type(uint128).max, type(uint128).max);
        }
        router = new GloamVaultSwapV4c{salt: bytes32(uint256(1))}(address(pool), treasury, pm, weth, address(this), ps);
        quoter = new CQuoter{salt: bytes32(uint256(1))}(pm);
        vm.deal(depositor, 10_000 ether);
    }

    function _is(string memory s) internal view returns (bool) {
        return keccak256(bytes(which)) == keccak256(bytes(s));
    }

    function _deployPoseidon() internal returns (address addr) {
        bytes memory bytecode = vm.readFile("test/fixtures/Poseidon2.json").readBytes(".bytecode");
        bytes32 salt = bytes32(uint256(1));
        assembly {
            addr := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
        }
        require(addr != address(0), "poseidon deploy failed");
    }

    function _sym(address a) internal view returns (string memory) {
        if (a == NATIVE) return "ETH";
        try IERC20C(a).symbol() returns (string memory s) {
            return s;
        } catch {
            return "?";
        }
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return token == NATIVE ? who.balance : IERC20C(token).balanceOf(who);
    }

    /// The pool's virtual reserve of one side, from slot0 and liquidity.
    function _reserve(PoolKey memory k, bool side1) internal view returns (uint256) {
        bytes32 id = keccak256(abi.encode(k));
        bytes32 slot = keccak256(abi.encode(id, bytes32(uint256(6))));
        uint160 sp = uint160(uint256(IExtC(pm).extsload(slot)));
        uint128 liq = uint128(uint256(IExtC(pm).extsload(bytes32(uint256(slot) + 3))));
        if (sp == 0 || liq == 0) return 0;
        return side1 ? (uint256(liq) * sp) >> 96 : (uint256(liq) << 96) / sp;
    }

    /// A token for the depositor, from whoever holds the most we can reach. Handles tokens that return nothing.
    function _take(address asset, uint256 amount) internal returns (bool ok) {
        if (IERC20C(asset).balanceOf(pm) < amount) return false;
        vm.prank(pm);
        (ok, ) = asset.call(abi.encodeWithSelector(0xa9059cbb, depositor, amount));
    }

    function _fund(address asset, uint256 amount) internal returns (bool) {
        bytes32 c = bytes32(uint256(0xC0FFEE00000 + nul));
        if (asset == NATIVE) {
            vm.prank(depositor);
            pool.shieldBound{value: amount}(NATIVE, amount, c, hex"00");
            return true;
        }
        if (asset == weth) {
            vm.prank(depositor);
            IWETHC(weth).deposit{value: amount}();
        } else if (!_take(asset, amount)) {
            return false;
        }
        vm.startPrank(depositor);
        (bool ok, ) = asset.call(abi.encodeWithSelector(0x095ea7b3, address(pool), 0));
        (ok, ) = asset.call(abi.encodeWithSelector(0x095ea7b3, address(pool), amount));
        ok;
        pool.shieldBound(asset, amount, c, hex"00");
        vm.stopPrank();
        return true;
    }

    /// Each hop's direction, as GloamVaultSwapV4c._walk works it out.
    function _dirs(PoolKey[] memory hops, address assetIn) internal view returns (bool[] memory z) {
        z = new bool[](hops.length);
        address cur = assetIn;
        bool holds = hops[0].currency0 == assetIn || hops[0].currency1 == assetIn;
        if (!holds && assetIn == weth) cur = NATIVE;
        if (!holds && assetIn == NATIVE) cur = weth;
        for (uint256 i = 0; i < hops.length; i++) {
            z[i] = hops[i].currency0 == cur;
            cur = z[i] ? hops[i].currency1 : hops[i].currency0;
        }
    }

    function _key(Call memory k) internal view returns (GloamVaultSwap2.EscrowKey memory) {
        return GloamVaultSwap2.EscrowKey(
            k.s.nullifier, k.s.amount, k.d.commitment, k.d.asset, k.d.amount, k.r.commitment, k.r.amount, keccak256(k.route), vm.addr(EXIT_PK), DEADLINE
        );
    }

    function _build(PoolKey[] memory hops, Snap memory sn) internal view returns (Call memory k) {
        k.d = GloamVaultSwap2.Deposit(hex"00", bytes32(nul + 0x1_0000_0000), sn.assetOut, sn.want);
        k.r = GloamVaultSwap2.Deposit(hex"00", bytes32(nul + 0x2_0000_0000), sn.assetIn, sn.note - sn.note / 100);
        k.route = abi.encode(hops);
        k.s.nullifier = bytes32(nul);
        k.s.amount = sn.note;
        sn.escrow = router.escrowFor(sn.assetIn, _key(k));
        k.s = GloamVaultSwap2.Spend(abi.encode(sn.escrow), pool.currentRoot(), bytes32(nul), sn.assetIn, sn.note);
    }

    function swapOnce(Call memory k) external returns (uint256) {
        return router.swap(k.s, k.d, k.r, k.route, vm.addr(EXIT_PK), DEADLINE);
    }

    /// One private swap through `hops`, buying `want` of assetOut; checks every invariant.
    function _swap(PoolKey[] memory hops, address assetIn, address assetOut, uint256 want, string memory label) internal {
        nul++;
        ran++;
        Snap memory sn;
        sn.assetIn = assetIn;
        sn.assetOut = assetOut;
        sn.want = want;
        sn.label = label;
        try quoter.quote(hops, _dirs(hops, assetIn), want) returns (uint256 c, uint256 f) {
            sn.cost = c;
            sn.finalOut = f;
        } catch (bytes memory err) {
            failures++;
            console2.log("QUOTE FAIL", label);
            console2.logBytes(err);
            return;
        }
        // a note that leaves 1% over the cost after the vault's 0.25% fee
        sn.note = ((sn.cost * 10_100) / 10_000 * 10_000) / 9_975 + 2;
        if (!_fund(assetIn, sn.note)) {
            failures++;
            console2.log("FUND FAIL", label);
            return;
        }
        sn.arrives = sn.note - (sn.note * 25) / 10_000;
        Call memory k = _build(hops, sn);
        sn.depIn = pool.deposited(assetIn);
        sn.depOut = pool.deposited(assetOut);
        sn.tIn = _bal(assetIn, treasury);
        sn.tOut = _bal(assetOut, treasury);
        uint256 g = gasleft();
        try this.swapOnce(k) returns (uint256 spent) {
            g -= gasleft();
            _check(sn, spent);
            console2.log("gas", label, g);
        } catch (bytes memory err) {
            failures++;
            console2.log("SWAP FAIL", label);
            console2.logBytes(err);
        }
    }

    function _check(Snap memory sn, uint256 spent) internal view {
        assertEq(spent, sn.cost, string.concat(sn.label, ": spent = quoted cost"));
        assertEq(pool.deposited(sn.assetIn), sn.depIn - sn.note, string.concat(sn.label, ": note out"));
        assertEq(pool.deposited(sn.assetOut), sn.depOut + sn.want, string.concat(sn.label, ": new note exact"));
        assertEq(_bal(sn.assetIn, treasury) - sn.tIn, sn.arrives - sn.cost, string.concat(sn.label, ": leftover"));
        assertEq(_bal(sn.assetOut, treasury) - sn.tOut, sn.finalOut - sn.want, string.concat(sn.label, ": extra out"));
        assertEq(address(router).balance, 0, "router holds no ETH");
        assertEq(_bal(sn.assetIn, address(router)), 0, "router holds no input");
        assertEq(_bal(sn.assetOut, address(router)), 0, "router holds no output");
        assertEq(_bal(sn.assetIn, sn.escrow), 0, "escrow empty");
        assertGe(_bal(sn.assetIn, address(pool)), pool.deposited(sn.assetIn), "vault backs its notes");
    }

    function _one(uint256 i, bool zeroForOne, address cin, address cout) internal {
        PoolKey[] memory hops = new PoolKey[](1);
        hops[0] = p[i];
        uint256 res = _reserve(p[i], zeroForOne);
        uint256 want = res / 2_000; // 0.05% of the pool's virtual reserve of the output
        string memory label = string.concat(vm.toString(i), " ", _sym(cin), "->", _sym(cout));
        if (want == 0) {
            failures++;
            console2.log("NO LIQUIDITY", label);
            return;
        }
        // Concentrated pools quote billions of virtual reserve and can hold far less on one side.
        // Keep to a real swap's size: the vault takes 500 of a stablecoin in one deposit.
        uint256 cap = (cout == NATIVE || cout == weth) ? 0.2 ether : 10 ** uint256(IERC20C(cout).decimals()) * 500;
        if (want > cap) want = cap;
        // A pool can hold less on one side than that, and a live pool's depth moves day to day. The
        // router reverts whole on what it can't fill (a test of its own, below), so run at what it fills.
        try quoter.quote(hops, _dirs(hops, cin), want) returns (uint256, uint256 fills) {
            if (fills < want) {
                console2.log("THIN", label, fills);
                want = (fills * 9) / 10;
            }
        } catch {}
        if (want == 0) {
            failures++;
            console2.log("NO LIQUIDITY", label);
            return;
        }
        _swap(hops, cin, cout, want, label);
    }

    /// Every deploy pool, both ways; a pool that holds ETH runs for an ETH note and a WETH note.
    function test_fork_every_pool_both_ways() public {
        for (uint256 i = 0; i < p.length; i++) {
            address c0 = p[i].currency0;
            address c1 = p[i].currency1;
            _one(i, true, c0, c1);
            _one(i, false, c1, c0);
            if (c0 == NATIVE) {
                _one(i, true, weth, c1);
                _one(i, false, c1, weth);
            }
            if (c0 == weth || c1 == weth) {
                _one(i, c0 == weth, NATIVE, c0 == weth ? c1 : c0);
                _one(i, c0 != weth, c0 == weth ? c1 : c0, NATIVE);
            }
        }
        console2.log("swaps run", ran);
        console2.log("failures", failures);
        assertEq(failures, 0, "every pool swaps both ways");
    }

    function _route(uint256 a, uint256 b) internal view returns (PoolKey[] memory hops) {
        hops = new PoolKey[](2);
        hops[0] = p[a];
        hops[1] = p[b];
    }

    /// The two-hop routes that matter on each chain: a stablecoin against ETH through the hub.
    function test_fork_two_hop_routes() public {
        if (_is("base")) {
            address usdt = p[2].currency1;
            address eurc = p[6].currency0;
            _swap(_route(2, 0), usdt, NATIVE, 0.05 ether, "USDT>USDC>ETH");
            _swap(_route(0, 2), NATIVE, usdt, 100e6, "ETH>USDC>USDT");
            _swap(_route(6, 0), eurc, NATIVE, 0.02 ether, "EURC>USDC>ETH");
            _swap(_route(0, 6), NATIVE, eurc, 50e6, "ETH>USDC>EURC");
            _swap(_route(2, 6), usdt, eurc, 50e6, "USDT>USDC>EURC");
        } else if (_is("ethereum")) {
            address usdg = p[8].currency1;
            address eurc = p[11].currency0;
            _swap(_route(8, 0), usdg, NATIVE, 0.05 ether, "USDG>USDC>ETH");
            _swap(_route(0, 8), NATIVE, usdg, 100e6, "ETH>USDC>USDG");
            _swap(_route(11, 0), eurc, NATIVE, 0.02 ether, "EURC>USDC>ETH");
            _swap(_route(10, 2), usdg, NATIVE, 0.02 ether, "USDG>USDT>ETH");
            _swap(_route(7, 11), p[7].currency1, eurc, 50e6, "USDT>USDC>EURC");
            _swap(_route(4, 8), p[4].currency1, usdg, 500e6, "USDT>USDC>USDG, at the vault's limit");
        } else {
            address tsla = p[15].currency0;
            _swap(_route(15, 0), tsla, NATIVE, 0.002 ether, "TSLA>USDG>ETH");
            _swap(_route(0, 15), NATIVE, tsla, 0.01e18, "ETH>USDG>TSLA");
            _swap(_route(2, 15), NATIVE, tsla, 0.01e18, "ETH(wrapped)>USDG>TSLA");
        }
        console2.log("failures", failures);
        assertEq(failures, 0, "every route swaps");
    }

    /// Asking a real pool for more than it holds: the router reverts whole and the note stays.
    function test_fork_asking_more_than_a_pool_holds_moves_nothing() public {
        PoolKey[] memory hops = new PoolKey[](1);
        hops[0] = p[p.length - 1];
        address out = hops[0].currency0;
        address input = hops[0].currency1;
        uint256 note = 500 * 10 ** uint256(IERC20C(input).decimals());
        if (out == NATIVE) out = weth;
        nul++;
        assertTrue(_fund(input, note), "funded");
        Snap memory sn;
        sn.assetIn = input;
        sn.assetOut = out;
        sn.note = note;
        sn.want = type(uint128).max / 2; // past anything a pool holds, and any note could buy
        Call memory k = _build(hops, sn);
        uint256 dep = pool.deposited(input);
        vm.expectRevert();
        this.swapOnce(k);
        assertFalse(pool.isSpent(k.s.nullifier), "the note stays");
        assertEq(pool.deposited(input), dep);
        assertEq(_bal(input, sn.escrow), 0);
    }

    function _sign(address escrow, address to) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(EXIT_PK, router.exitDigest(escrow, to));
        return abi.encodePacked(r, s, v);
    }

    /// A note taken out on its own, with the vault's limit full: the refund can't land, the exit pays.
    function test_fork_exit_when_the_refund_cannot_land() public {
        address[2] memory assets = [NATIVE, p[p.length - 1].currency1];
        for (uint256 i = 0; i < 2; i++) {
            address asset = assets[i];
            uint256 amount = asset == NATIVE ? 0.1 ether : 100 * 10 ** uint256(IERC20C(asset).decimals());
            nul++;
            assertTrue(_fund(asset, amount), "funded");
            Snap memory sn;
            sn.assetIn = asset;
            sn.assetOut = asset == NATIVE ? p[0].currency1 : (p[p.length - 1].currency0 == NATIVE ? weth : p[p.length - 1].currency0);
            sn.want = 1;
            sn.note = amount;
            PoolKey[] memory hops = new PoolKey[](1);
            hops[0] = asset == NATIVE ? p[0] : p[p.length - 1];
            Call memory k = _build(hops, sn);
            pool.unshield(k.s.proof, k.s.root, k.s.nullifier, k.s.asset, sn.escrow, k.s.amount);
            uint256 arrives = amount - (amount * 25) / 10_000;
            assertEq(_bal(asset, sn.escrow), arrives, "waiting at the escrow");

            // the limit fills: the refund can't land
            uint256 dep = pool.deposited(asset);
            pool.lowerDepositLimit(asset, type(uint128).max, uint128(dep));
            vm.expectRevert();
            this.swapOnce(k);
            assertEq(_bal(asset, sn.escrow), arrives, "still waiting");

            address to = address(uint160(0xE417 + i));
            bytes memory sig = _sign(sn.escrow, to);
            uint256 g = gasleft();
            router.exit(asset, _key(k), to, sig);
            console2.log("gas exit", _sym(asset), g - gasleft());
            assertEq(_bal(asset, to), arrives, "all of it, at the address the key signed for");
            assertEq(_bal(asset, sn.escrow), 0);
            assertEq(_bal(asset, address(router)), 0);
            vm.expectRevert();
            router.exit(asset, _key(k), to, sig);
        }
    }

    /// A refund in the chain's own tokens, native and ERC-20, the way it runs when nothing holds it back.
    function test_fork_refund_lands() public {
        address[2] memory assets = [NATIVE, p[p.length - 1].currency1];
        for (uint256 i = 0; i < 2; i++) {
            address asset = assets[i];
            uint256 amount = asset == NATIVE ? 0.1 ether : 100 * 10 ** uint256(IERC20C(asset).decimals());
            nul++;
            assertTrue(_fund(asset, amount), "funded");
            Snap memory sn;
            sn.assetIn = asset;
            sn.assetOut = asset == NATIVE ? p[0].currency1 : (p[p.length - 1].currency0 == NATIVE ? weth : p[p.length - 1].currency0);
            sn.want = 1;
            sn.note = amount;
            PoolKey[] memory hops = new PoolKey[](1);
            hops[0] = asset == NATIVE ? p[0] : p[p.length - 1];
            Call memory k = _build(hops, sn);
            pool.unshield(k.s.proof, k.s.root, k.s.nullifier, k.s.asset, sn.escrow, k.s.amount);
            uint256 t = _bal(asset, treasury);
            assertEq(this.swapOnce(k), 0);
            assertTrue(pool.commitmentSeen(k.r.commitment), "the refund note landed");
            assertEq(_bal(asset, sn.escrow), 0);
            assertEq(_bal(asset, address(router)), 0);
            assertEq(_bal(asset, treasury) - t, amount - (amount * 25) / 10_000 - k.r.amount, "only the margin");
        }
    }

    function test_fork_deploy_pools_are_live() public view {
        for (uint256 i = 0; i < p.length; i++) {
            bytes32 id = keccak256(abi.encode(p[i]));
            assertTrue(router.allowedPool(id), "allowed at deploy");
            bytes32 slot = keccak256(abi.encode(id, bytes32(uint256(6))));
            assertTrue(IExtC(pm).extsload(slot) != bytes32(0), "initialized");
        }
    }
}
