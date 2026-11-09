// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GloamVaultSwap2} from "./GloamVaultSwap2.sol";
import {IStablecoinDex} from "./GloamVaultSwapTempo.sol";

/**
 * @title GloamVaultSwapTempo2
 * @notice Vault swaps between stablecoins on Tempo, through the Stablecoin DEX
 *         fixed at deploy, with GloamVaultSwap2's exit. Tempo blocks native
 *         value and the vault holds no native coin there, so neither end of a
 *         swap can be address(0). As in GloamVaultSwapTempo, the DEX routes the
 *         pair itself, so there is no route to pass and none a caller could
 *         change. It pulls the input from this contract (TIP-20 implicit
 *         approval for the DEX; the approval set here covers any token without
 *         it and is cleared after) and sends the output straight back here.
 *
 *         On Tempo a recipient can refuse senders with a receive policy
 *         (TIP-1028), and a payment it refuses is held rather than reverted.
 *         So an exit first asks the TIP-403 registry whether `to` accepts the
 *         token from the escrow that pays it, and reverts if not, and after
 *         the escrow paid it checks the recipient's balance went up by the whole
 *         amount, and reverts if not: either way the money stays at the escrow
 *         for an exit to another address.
 */
contract GloamVaultSwapTempo2 is GloamVaultSwap2 {
    IStablecoinDex public immutable dex;

    /// @notice Tempo's TIP-403 registry precompile, which answers for receive policies.
    address public constant TIP403_REGISTRY = 0x403c000000000000000000000000000000000000;
    /// @notice Tempo's address registry precompile, which resolves a virtual address (TIP-1022).
    address public constant ADDRESS_REGISTRY = 0xfDC0000000000000000000000000000000000000;

    error BadRoute();
    error NativeNotSupported();
    error ReceiveBlocked();

    /// @dev The DEX holds nothing for anyone.
    function _stopsHere(address to) internal view override returns (bool) {
        return to == address(dex);
    }

    constructor(address vault_, address treasury_, address dex_) GloamVaultSwap2(vault_, treasury_) {
        if (dex_ == address(0)) revert ZeroAddress();
        dex = IStablecoinDex(dex_);
    }

    function _swapExactOut(
        address assetIn,
        address assetOut,
        uint256 amountOut,
        uint256 maxIn,
        bytes calldata route
    ) internal override returns (uint256 amountIn) {
        if (route.length != 0) revert BadRoute();
        if (assetIn == NATIVE || assetOut == NATIVE) revert NativeNotSupported();
        if (amountOut > type(uint128).max) revert InvalidAmount();
        uint128 cap = maxIn > type(uint128).max ? type(uint128).max : uint128(maxIn);
        _approve(assetIn, address(dex), cap);
        amountIn = dex.swapExactAmountOut(assetIn, assetOut, uint128(amountOut), cap);
        _approve(assetIn, address(dex), 0);
    }

    /// @dev Reverts if `to`'s receive policy refuses `token` from `escrow`. A virtual address is
    ///      checked as the wallet it forwards to. A registry that doesn't answer is a chain with
    ///      no receive policies; _afterExit checks the money arrived all the same.
    function _beforeExit(address token, address escrow, address to) internal view override returns (address receiver, uint256 had) {
        (bool resolved, bytes memory who) = ADDRESS_REGISTRY.staticcall(abi.encodeWithSignature("resolveRecipient(address)", to));
        receiver = resolved && who.length >= 32 ? abi.decode(who, (address)) : to;
        if (receiver == address(0)) receiver = to;
        (bool ok, bytes memory ret) = TIP403_REGISTRY.staticcall(
            abi.encodeWithSignature("validateReceivePolicy(address,address,address)", token, escrow, receiver)
        );
        if (ok && ret.length >= 64) {
            (bool authorized, ) = abi.decode(ret, (bool, uint8));
            if (!authorized) revert ReceiveBlocked();
        }
        had = _holdingOf(token, receiver);
    }

    /// @dev The recipient must hold the whole amount more than before: a payment held for it
    ///      elsewhere reverts the exit, and the escrow keeps the money.
    function _afterExit(address token, address receiver, uint256 had, uint256 amount) internal view override {
        if (_holdingOf(token, receiver) < had + amount) revert ReceiveBlocked();
    }
}
