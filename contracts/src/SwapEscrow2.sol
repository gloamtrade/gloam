// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Balance} from "./SwapEscrow.sol";

/// @notice What an escrow asks the router that deploys it: where its money goes.
interface IEscrowPayee {
    function escrowPayee() external view returns (address);
}

/**
 * @notice One vault swap's drop-off point (GloamVaultSwap2). As SwapEscrow, and
 *         for a native ETH note too: the vault pays a swap's input here, and the
 *         router deploys it with CREATE2 in the same transaction or later. The
 *         constructor hands the whole balance to whoever the router names: the
 *         router itself for a swap or a refund, the exit's recipient for an exit,
 *         so an exit never passes through the router. It leaves one byte of code
 *         that refuses every call, so the router can see it was opened before
 *         trying again, and ETH sent to it later is refused.
 * @dev Its own file, so the creation code (and every escrow address the app
 *      works out from it) does not change when GloamVaultSwap2.sol is edited.
 *      The recipient is asked for, not passed in, so it isn't part of the address.
 */
contract SwapEscrow2 {
    /// @param token The note's asset; address(0) for native ETH.
    constructor(address token) {
        address payee = IEscrowPayee(msg.sender).escrowPayee();
        if (token == address(0)) {
            uint256 amount = address(this).balance;
            if (amount != 0) {
                (bool ok, ) = payee.call{value: amount}("");
                require(ok, "escrow transfer");
            }
        } else {
            uint256 amount = IERC20Balance(token).balanceOf(address(this));
            if (amount != 0) {
                (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, payee, amount));
                require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "escrow transfer");
            }
        }
        assembly {
            // 0xFE: INVALID. Any call to the opened escrow reverts.
            mstore8(0, 0xfe)
            return(0, 1)
        }
    }
}
