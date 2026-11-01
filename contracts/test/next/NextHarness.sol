// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShieldPoolCore2} from "../../src/ShieldPoolCore2.sol";

/// @dev Where a test vault's sweepStrayToken pays, in every ported suite.
address constant STRAY = address(0x57A7);

/// @notice ShieldPoolCore2 with plain shield() left open, as ShieldPoolPoseidon has
///         it: the suites ported from the older pool deposit that way. Not a real
///         pool: ShieldPoolPayments2 closes shield() for good.
contract PoolHarness2 is ShieldPoolCore2 {
    constructor(address poseidon2_, address verifier_) ShieldPoolCore2(poseidon2_, verifier_, STRAY) {}
}
