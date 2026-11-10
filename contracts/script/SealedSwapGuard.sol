// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";

/**
 * @notice Guard for every script that deploys, sets, queues or wires a sealed
 *         swap verifier (audit L-2, 2026-10-11).
 * @dev Sealed swap is off on both live pools (`sealedSwapVerifier == 0`) and must
 *      stay off until all of this is done:
 *
 *   - H1: sealedSwap mints an assetOut note that no deposit backs. Needs the
 *     solvency accounting redesign (audit/H1-SWAP-SOLVENCY.md).
 *   - ZK-1: `amountOut * rateOut === amountSwap * rateIn` wraps the BN254 field.
 *     The 128-bit rate caps do NOT stop it. Amount bits + rate bits must be
 *     <= 252 (for example 96-bit rates in the circuit and the contract), and one
 *     side of an oracle-bound rate must be a fixed scale. Proven by
 *     test/auditzk/SealedSwapRateWrap.t.sol (1 wei in, ~2.57e38 out).
 *   - A new sealedSwap circuit build, a new ceremony and a regenerated
 *     SealedSwapVerifier.sol. The one in src/verifiers is stale vs the circuit
 *     (ZK review I-1), so deploying it ships none of the hardening.
 *
 * Only after that, run the guarded scripts with GLOAM_ACK_SEALED_SWAP_H1_ZK1=1.
 * Same idea as the shieldVerifier check in script/archive/SeedVaultInventory.s.sol:
 * refuse by default, never guess.
 */
abstract contract SealedSwapGuard is Script {
    string internal constant SEALED_SWAP_ACK_ENV = "GLOAM_ACK_SEALED_SWAP_H1_ZK1";

    function _requireSealedSwapAck() internal view {
        require(
            vm.envOr(SEALED_SWAP_ACK_ENV, uint256(0)) == 1,
            "unsafe: sealed swap must stay off until H1 (solvency accounting) and ZK-1 "
            "(rate product wraps the field: amount bits + rate bits must be <= 252, e.g. 96-bit "
            "rates in circuit and contract, and one side of the oracle rate fixed to a constant "
            "scale) are fixed and a new circuit + ceremony is done. Then set "
            "GLOAM_ACK_SEALED_SWAP_H1_ZK1=1"
        );
    }
}
