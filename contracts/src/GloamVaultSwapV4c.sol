// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GloamVaultSwap2} from "./GloamVaultSwap2.sol";
import {PoolKey, SwapParams, IPoolManagerSwap} from "./GloamVaultSwapV4.sol";
import {IWETH} from "./GloamVaultSwapV4b.sol";

/**
 * @title GloamVaultSwapV4c
 * @notice Vault swaps on Uniswap v4, third version: any pair of vault assets
 *         joined by allowed pools, up to three hops, with native ETH notes and
 *         WETH notes both. The allowlist and its governance are GloamVaultSwapV4b's.
 *         GloamVaultSwap2 has the escrow key, the refund note, the exit, leftovers
 *         to the treasury and the reentrancy latch.
 *
 * ETH. The vault may hold native ETH (asset address(0)), WETH, or both, as two
 * different assets. A pool may hold either one too, and either note can use
 * either pool: when a note's first pool holds only the other form, the router
 * converts exactly what that pool asks; when a route ends in the other form from
 * the new note, the router converts all of it. Both follow from the route alone,
 * so the escrow key's route hash fixes them too. Inside a route a currency nets
 * to zero in the PoolManager as before, so a middle ETH never leaves it.
 *
 * Pools. A route may use only pools on the allowlist. The constructor's pools
 * are live at once (the deploy itself is the public notice, as with v1). After
 * that the owner can add a pool only by queueing it: it is usable POOL_DELAY
 * after queueing, and the queue is public (PoolQueued, poolLiveAt). The owner
 * can remove a pool, live or queued, at once. The owner has no other power:
 * no function moves tokens, sets an approval, or changes the vault, the
 * treasury, the PoolManager or WETH, which are all immutable.
 *
 * What a bad pool can do (a hostile hook, or a pool priced against the swap).
 * Each swap names its route in its escrow key, so no pool added later can be
 * slipped into a swap someone already proved. On the routes it is on:
 *  - The new note is always exactly `d.amount` of `d.asset`: its shield proof
 *    binds it, and the swap reverts unless the router holds at least that much
 *    of the output it took.
 *  - The router pays at most what the note brought in (the note's amount less
 *    the vault's fee), and reverts whole above that: the note stays unspent.
 *    So the worst a pool can take is the swap's leftover, the price buffer that
 *    would otherwise go to the treasury. Never another note, never the vault.
 *  - The router gives no approval to any pool, hook or the PoolManager: it pays
 *    by transfer, exactly what the deltas say, and a PoolManager that doesn't
 *    net to zero reverts the whole swap.
 *  - A pool or hook that reverts, or is removed, stops only swaps that route
 *    through it. The refund path and the exit never touch a pool, so money sent
 *    to an escrow comes back whatever the allowlist says.
 */
contract GloamVaultSwapV4c is GloamVaultSwap2 {
    IPoolManagerSwap public immutable poolManager;
    /// @notice The chain's WETH, a separate vault asset from native ETH.
    address public immutable weth;

    /// @notice How long a queued pool waits before a route may use it.
    uint256 public constant POOL_DELAY = 3 days;
    uint256 public constant MAX_HOPS = 3;
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    /// @dev What a swap hands itself through the PoolManager's unlock().
    struct Unlock {
        PoolKey[] hops;
        bool[] zeroForOne;
        address assetIn;
        address assetOut;
        address payIn;
        address takeOut;
        uint256 amountOut;
        uint256 maxIn;
    }

    /// @notice Can queue and remove pools, nothing else.
    address public owner;
    address public pendingOwner;

    /// @notice keccak256(abi.encode(PoolKey)), the v4 PoolId, to the time a route may
    ///         first use it. 0: not on the allowlist.
    mapping(bytes32 => uint256) public poolLiveAt;

    event PoolQueued(
        bytes32 indexed poolId,
        address currency0,
        address currency1,
        uint24 fee,
        int24 tickSpacing,
        address hooks,
        uint256 liveAt
    );
    event PoolRemoved(bytes32 indexed poolId);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error BadRoute();
    error BadPool();
    error PoolNotAllowed(bytes32 poolId);
    error PoolListed(bytes32 poolId);
    error PoolNotListed(bytes32 poolId);
    error NotPoolManager();
    error MiddleNotSettled();
    error NotOwner();
    error NotPendingOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address vault_,
        address treasury_,
        address poolManager_,
        address weth_,
        address owner_,
        PoolKey[] memory pools
    ) GloamVaultSwap2(vault_, treasury_) {
        if (poolManager_ == address(0) || weth_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (poolManager_.code.length == 0 || weth_.code.length == 0) revert NotAContract();
        poolManager = IPoolManagerSwap(poolManager_);
        weth = weth_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        for (uint256 i = 0; i < pools.length; i++) {
            _list(pools[i], block.timestamp);
        }
    }

    /// @notice ETH comes in from an escrow as it opens, or during a swap from WETH (an unwrap) or the PoolManager (a take).
    /// @dev Mainnet WETH9 sends with a 2300 gas stipend: this stays a read of a warm slot and two compares.
    receive() external payable override {
        if (_opening()) return;
        if (!_inSwap() || (msg.sender != weth && msg.sender != address(poolManager))) revert NativeRefused();
    }

    /// @dev The PoolManager and WETH hold nothing for an exit's recipient.
    function _stopsHere(address to) internal view override returns (bool) {
        return to == address(poolManager) || to == weth;
    }

    // ───────────────────────────────────────────────────────────── the allowlist

    /// @notice Whether a route may use this pool now.
    function allowedPool(bytes32 poolId) public view returns (bool) {
        uint256 at = poolLiveAt[poolId];
        return at != 0 && block.timestamp >= at;
    }

    /// @notice Put a pool on the allowlist, usable POOL_DELAY from now.
    function queuePool(PoolKey calldata key) external onlyOwner returns (bytes32 poolId) {
        return _list(key, block.timestamp + POOL_DELAY);
    }

    /// @notice Take a pool off the allowlist (or out of the queue) at once.
    function removePool(bytes32 poolId) external onlyOwner {
        if (poolLiveAt[poolId] == 0) revert PoolNotListed(poolId);
        delete poolLiveAt[poolId];
        emit PoolRemoved(poolId);
    }

    function _list(PoolKey memory k, uint256 liveAt) private returns (bytes32 id) {
        // v4 keys hold their currencies sorted, native ETH (address 0) first
        if (k.currency0 >= k.currency1) revert BadPool();
        id = keccak256(abi.encode(k));
        if (poolLiveAt[id] != 0) revert PoolListed(id);
        poolLiveAt[id] = liveAt;
        emit PoolQueued(id, k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks, liveAt);
    }

    // ───────────────────────────────────────────────────────────── owner

    /// @notice Start handing the allowlist to `newOwner`, who must accept it.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, msg.sender);
    }

    // ───────────────────────────────────────────────────────────── the swap

    /// @dev route = abi.encode(PoolKey[]), pools in order from assetIn to assetOut.
    function _swapExactOut(
        address assetIn,
        address assetOut,
        uint256 amountOut,
        uint256 maxIn,
        bytes calldata route
    ) internal override returns (uint256 amountIn) {
        PoolKey[] memory hops = abi.decode(route, (PoolKey[]));
        if (amountOut > uint256(int256(type(int128).max))) revert InvalidAmount();
        (bool[] memory zeroForOne, address payIn, address takeOut) = _walk(hops, assetIn, assetOut);

        bytes memory res = poolManager.unlock(abi.encode(Unlock(hops, zeroForOne, assetIn, assetOut, payIn, takeOut, amountOut, maxIn)));
        amountIn = abi.decode(res, (uint256));
    }

    /**
     * @dev Checks a route and works out each hop's direction, the currency the
     *      router pays the PoolManager (the note's asset, or its other form of ETH
     *      when the first pool holds only that one) and the one it takes (the new
     *      note's asset, or its other form when the route ends there).
     */
    function _walk(PoolKey[] memory hops, address assetIn, address assetOut)
        private
        view
        returns (bool[] memory zeroForOne, address payIn, address takeOut)
    {
        uint256 n = hops.length;
        if (n == 0 || n > MAX_HOPS) revert BadRoute();

        // The currencies the route passes through, as the PoolManager sees them.
        address[] memory path = new address[](n + 1);
        zeroForOne = new bool[](n);
        address cur = assetIn;
        if (_isEth(assetIn) && !_holds(hops[0], assetIn) && _holds(hops[0], _otherEth(assetIn))) cur = _otherEth(assetIn);
        path[0] = cur;
        for (uint256 i = 0; i < n; i++) {
            PoolKey memory k = hops[i];
            bytes32 id = keccak256(abi.encode(k));
            if (!allowedPool(id)) revert PoolNotAllowed(id);
            if (k.currency0 == cur) {
                zeroForOne[i] = true;
                cur = k.currency1;
            } else if (k.currency1 == cur) {
                zeroForOne[i] = false;
                cur = k.currency0;
            } else {
                revert BadRoute();
            }
            path[i + 1] = cur;
        }
        if (cur != assetOut && !(_isEth(assetOut) && cur == _otherEth(assetOut))) revert BadRoute();

        // Each currency once, so the input, the output and every middle currency
        // each have one delta; and an end that is converted is nowhere inside the
        // route in the form the note holds.
        for (uint256 i = 0; i <= n; i++) {
            if (path[0] != assetIn && path[i] == assetIn) revert BadRoute();
            if (path[n] != assetOut && path[i] == assetOut) revert BadRoute();
            for (uint256 j = i + 1; j <= n; j++) {
                if (path[i] == path[j]) revert BadRoute();
            }
        }
        payIn = path[0];
        takeOut = path[n];
    }

    /// @notice Called back by the PoolManager inside unlock(), only during a swap.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_inSwap()) revert NotPoolManager();
        Unlock memory u = abi.decode(data, (Unlock));

        // From the last hop back: buy exactly `want`, then `want` becomes what
        // that hop cost, which the hop before it must buy.
        uint256 want = u.amountOut;
        uint256 finalOut;
        for (uint256 i = u.hops.length; i > 0; i--) {
            bool z = u.zeroForOne[i - 1];
            int256 delta = poolManager.swap(
                u.hops[i - 1],
                SwapParams({
                    zeroForOne: z,
                    amountSpecified: int256(want),
                    sqrtPriceLimitX96: z ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
                }),
                ""
            );
            int128 a0 = int128(delta >> 128);
            int128 a1 = int128(delta);
            int128 outD = z ? a1 : a0;
            int128 inD = z ? a0 : a1;
            if (outD < 0 || uint256(uint128(outD)) < want) revert ShortOutput(outD < 0 ? 0 : uint256(uint128(outD)), want);
            // a middle currency must net to exactly zero: no more out than the next hop paid in
            if (i < u.hops.length && uint256(uint128(outD)) != want) revert MiddleNotSettled();
            if (i == u.hops.length) finalOut = uint256(uint128(outD));
            if (inD >= 0) revert BadRoute();
            want = uint256(uint128(-inD));
        }
        if (want > u.maxIn) revert OverInput(want, u.maxIn);

        // Pay the input: the note's own form, or exactly that much of the other.
        if (u.payIn == NATIVE) {
            if (u.assetIn != NATIVE) IWETH(weth).withdraw(want);
            poolManager.sync(NATIVE);
            poolManager.settle{value: want}();
        } else {
            if (u.assetIn == NATIVE) IWETH(weth).deposit{value: want}();
            poolManager.sync(u.payIn);
            _transfer(u.payIn, address(poolManager), want);
            poolManager.settle();
        }
        // Take the whole output, converted to the new note's form, all of it.
        poolManager.take(u.takeOut, address(this), finalOut);
        if (u.takeOut != u.assetOut) {
            if (u.takeOut == NATIVE) IWETH(weth).deposit{value: finalOut}();
            else IWETH(weth).withdraw(finalOut);
        }
        return abi.encode(want);
    }

    function _isEth(address a) private view returns (bool) {
        return a == NATIVE || a == weth;
    }

    function _otherEth(address a) private view returns (address) {
        return a == NATIVE ? weth : NATIVE;
    }

    function _holds(PoolKey memory k, address c) private pure returns (bool) {
        return k.currency0 == c || k.currency1 == c;
    }
}
