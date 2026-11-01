// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShieldPoolCore2} from "./ShieldPoolCore2.sol";

/**
 * NEXT VAULT. NOT DEPLOYED. NOT AUDITED. The live vaults run ShieldPoolPayments.sol, which
 * stays in this repo unchanged. Nothing here reaches a live contract: a deployed
 * vault cannot be upgraded.
 *
 * @title ShieldPoolPayments2
 * @notice The mainnet pool: private deposits, transfers and withdrawals, with
 *         beta deposit limits, and no sealed swap. See ShieldPoolCore2 for the
 *         owner's powers.
 * @dev Sealed swaps stay off until their accounting is redesigned (audit H1,
 *      ZK-1), so this pool leaves that code out entirely. That also keeps the
 *      deploy under Tempo's 30M per-transaction gas cap.
 */
contract ShieldPoolPayments2 is ShieldPoolCore2 {
    /**
     * @param poseidon2_ Circomlib Poseidon (2 inputs)
     * @param verifier_ UnshieldIVerifier or address(0) until set
     * @param strayRecipient_ Where sweepStrayToken() pays. Fixed for good.
     */
    constructor(
        address poseidon2_,
        address verifier_,
        address strayRecipient_
    ) ShieldPoolCore2(poseidon2_, verifier_, strayRecipient_) {}

    /// @notice Deposits take shieldBound() only: its proof binds the commitment to
    ///         the amount sent, so this pool never takes an unbound deposit, not
    ///         even in the deploy window before the shield verifier is wired
    ///         (pre-mainnet audit F1).
    function shield(address, uint256, bytes32) external payable override {
        revert ShieldProofRequired();
    }

    /// @dev Setup can only end on a pool that is ready to go live: both proof
    ///      verifiers wired and deposit limits on (pre-mainnet audit F1, GATE 1).
    function _checkReadyToEndSetup() internal view override {
        if (address(verifier) == address(0) || address(shieldVerifier) == address(0)) revert VerifierNotSet();
        if (!depositLimitsOn) revert DepositLimitsOff();
    }

    /// @notice Always zero: this pool has no sealed swap. The app reads it the
    ///         same way it reads ShieldPoolPoseidon's to keep trading off.
    function sealedSwapVerifier() external pure returns (address) {
        return address(0);
    }
}
