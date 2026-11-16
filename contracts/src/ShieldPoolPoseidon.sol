// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifier} from "./interfaces/IVerifier.sol";
import {IncrementalMerkleTreePoseidon as IMT} from "./lib/IncrementalMerkleTreePoseidon.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {OracleRates} from "./lib/OracleRates.sol";
import {ShieldPoolCore, IERC20} from "./ShieldPoolCore.sol";

/**
 * @title ShieldPoolPoseidon
 * @notice Phase-2 pool: the payment vault (ShieldPoolCore) plus sealed swaps.
 * @dev Pairs with UnshieldVerifier (Poseidon circuit). Not the live keccak pool.
 *      The testnet pools run this. Sealed swaps are switched off on them
 *      (sealedSwapVerifier = 0, audit H1 and ZK-1); a mainnet pool that only
 *      pays is ShieldPoolPayments.
 *
 * Owner powers: see ShieldPoolCore. The swap setters (setSealedSwapVerifier,
 * setSwapRate, setPriceFeed, setOracleConfig, setOracleRatePair) follow the same
 * rule: instant only during setup, timelocked after endSetup().
 */
contract ShieldPoolPoseidon is ShieldPoolCore {
    using IMT for IMT.Tree;

    /// @notice Optional sealed-swap verifier (9 public inputs). Separate from dual unshield/transfer.
    IVerifier public sealedSwapVerifier;

    /// @notice Owner-approved sealed-swap rate per (assetIn, assetOut) direction.
    /// @dev The circuit only proves amountOut*rateOut == amountSwap*rateIn; it does NOT
    ///      constrain the rate itself. Without an on-chain check the caller can pass any
    ///      rateIn/rateOut and mint an assetOut note worth far more than the assetIn spent,
    ///      then unshield the pool's assetOut inventory (Kensho C3). Pin the rate here.
    struct SwapRate {
        uint128 rateIn;
        uint128 rateOut;
        bool enabled;
    }
    mapping(address => mapping(address => SwapRate)) public swapRate;

    /// @notice M3: Chainlink-bound rates. When oracleRatePair[in][out] is true,
    ///         sealedSwap validates the caller's (rateIn, rateOut) ratio against
    ///         the live feeds in priceFeed (within oracleConfig.toleranceBps)
    ///         instead of the owner-pinned swapRate, removing the trusted price.
    OracleRates.Config public oracleConfig;
    mapping(address => IAggregatorV3) public priceFeed;
    mapping(address => mapping(address => bool)) public oracleRatePair;

    event SealedSwapped(
        bytes32 indexed nullifier,
        address indexed assetIn,
        address indexed assetOut,
        bytes32 newCommitmentOut,
        bytes32 newCommitmentChange
    );

    event SwapRateSet(
        address indexed assetIn,
        address indexed assetOut,
        uint128 rateIn,
        uint128 rateOut,
        bool enabled
    );

    event SealedSwapVerifierSet(address indexed verifier);
    event PriceFeedSet(address indexed asset, address indexed feed);
    event OraclePairSet(address indexed assetIn, address indexed assetOut, bool enabled);
    event OracleConfigSet(address sequencer, uint64 grace, uint64 maxStaleness, uint64 toleranceBps);

    error SameAsset();
    error RateNotAllowed();

    /**
     * @param poseidon2_ Circomlib Poseidon (2 inputs)
     * @param verifier_ UnshieldIVerifier or address(0) until set
     */
    constructor(address poseidon2_, address verifier_) ShieldPoolCore(poseidon2_, verifier_) {}

    /// @dev Setup can only end on a pool that is ready to go live, the same gate as
    ///      ShieldPoolPayments: both proof verifiers wired and deposit limits on.
    ///      turnOnDepositLimits() is setup-only and not timelockable, so a pool that
    ///      left setup with limits off could never turn them on.
    function _checkReadyToEndSetup() internal view override {
        if (address(verifier) == address(0) || address(shieldVerifier) == address(0)) revert VerifierNotSet();
        if (!depositLimitsOn) revert DepositLimitsOff();
    }

    function setSealedSwapVerifier(address verifier_) external onlyOwner onlySetup {
        _setSealedSwapVerifier(verifier_);
    }

    /**
     * @notice Set the only rate a sealed swap may use for a given direction.
     * @dev The circuit does not constrain the rate; this is the on-chain price
     *      anchor. Set enabled=false to pause a pair. Later replaceable by an oracle.
     */
    function setSwapRate(
        address assetIn,
        address assetOut,
        uint128 rateIn_,
        uint128 rateOut_,
        bool enabled_
    ) external onlyOwner onlySetup {
        _setSwapRate(assetIn, assetOut, rateIn_, rateOut_, enabled_);
    }

    /// @notice M3: register the Chainlink feed (AggregatorV3, USD) for an asset.
    function setPriceFeed(address asset, address feed) external onlyOwner onlySetup {
        _setPriceFeed(asset, feed);
    }

    /// @notice M3: L2 sequencer uptime feed + max price staleness + ratio tolerance.
    function setOracleConfig(
        address sequencer,
        uint64 sequencerGrace,
        uint64 maxStaleness,
        uint64 toleranceBps
    ) external onlyOwner onlySetup {
        _setOracleConfig(sequencer, sequencerGrace, maxStaleness, toleranceBps);
    }

    /// @notice M3: switch a direction to oracle-bound pricing (both feeds required).
    ///         While enabled, sealedSwap checks the caller's rate ratio against the
    ///         live feeds instead of the owner-pinned swapRate.
    function setOracleRatePair(
        address assetIn,
        address assetOut,
        bool enabled_
    ) external onlyOwner onlySetup {
        _setOracleRatePair(assetIn, assetOut, enabled_);
    }

    function _setSealedSwapVerifier(address verifier_) internal {
        sealedSwapVerifier = IVerifier(verifier_);
        emit SealedSwapVerifierSet(verifier_);
    }

    function _setSwapRate(
        address assetIn,
        address assetOut,
        uint128 rateIn_,
        uint128 rateOut_,
        bool enabled_
    ) internal {
        if (assetIn == assetOut) revert SameAsset();
        if (enabled_ && (rateIn_ == 0 || rateOut_ == 0)) revert InvalidAmount();
        swapRate[assetIn][assetOut] = SwapRate(rateIn_, rateOut_, enabled_);
        emit SwapRateSet(assetIn, assetOut, rateIn_, rateOut_, enabled_);
    }

    function _setPriceFeed(address asset, address feed) internal {
        priceFeed[asset] = IAggregatorV3(feed);
        emit PriceFeedSet(asset, feed);
    }

    function _setOracleConfig(
        address sequencer,
        uint64 sequencerGrace,
        uint64 maxStaleness,
        uint64 toleranceBps
    ) internal {
        if (maxStaleness == 0 || toleranceBps > 10_000) revert InvalidAmount();
        oracleConfig = OracleRates.Config(
            IAggregatorV3(sequencer),
            sequencerGrace,
            maxStaleness,
            toleranceBps
        );
        emit OracleConfigSet(sequencer, sequencerGrace, maxStaleness, toleranceBps);
    }

    function _setOracleRatePair(address assetIn, address assetOut, bool enabled_) internal {
        if (assetIn == assetOut) revert SameAsset();
        if (
            enabled_ &&
            (address(priceFeed[assetIn]) == address(0) ||
                address(priceFeed[assetOut]) == address(0))
        ) {
            revert ZeroAddress();
        }
        oracleRatePair[assetIn][assetOut] = enabled_;
        emit OraclePairSet(assetIn, assetOut, enabled_);
    }

    // ── ChangeTimelock hooks: the swap setters, then the core's ─────────────

    function _changeArgWords(bytes4 selector) internal pure override returns (uint256) {
        if (selector == ShieldPoolPoseidon.setSealedSwapVerifier.selector) return 1;
        if (selector == ShieldPoolPoseidon.setSwapRate.selector) return 5;
        if (selector == ShieldPoolPoseidon.setPriceFeed.selector) return 2;
        if (selector == ShieldPoolPoseidon.setOracleConfig.selector) return 4;
        if (selector == ShieldPoolPoseidon.setOracleRatePair.selector) return 3;
        return super._changeArgWords(selector);
    }

    function _applyChange(bytes4 selector, bytes calldata args) internal override {
        if (selector == ShieldPoolPoseidon.setSealedSwapVerifier.selector) {
            _setSealedSwapVerifier(abi.decode(args, (address)));
        } else if (selector == ShieldPoolPoseidon.setSwapRate.selector) {
            (address a, address b, uint128 ri, uint128 ro, bool en) = abi.decode(
                args,
                (address, address, uint128, uint128, bool)
            );
            _setSwapRate(a, b, ri, ro, en);
        } else if (selector == ShieldPoolPoseidon.setPriceFeed.selector) {
            (address asset, address feed) = abi.decode(args, (address, address));
            _setPriceFeed(asset, feed);
        } else if (selector == ShieldPoolPoseidon.setOracleConfig.selector) {
            (address seq, uint64 grace, uint64 stale, uint64 tol) = abi.decode(
                args,
                (address, uint64, uint64, uint64)
            );
            _setOracleConfig(seq, grace, stale, tol);
        } else if (selector == ShieldPoolPoseidon.setOracleRatePair.selector) {
            (address a, address b, bool en) = abi.decode(args, (address, address, bool));
            _setOracleRatePair(a, b, en);
        } else {
            super._applyChange(selector, args);
        }
    }

    /// @notice Token decimals for value math; native currency is treated as 18-dec.
    function _assetDecimals(address asset) internal view returns (uint8) {
        if (asset == address(0)) return 18;
        return IERC20(asset).decimals();
    }

    /**
     * @notice Private-size swap: spend assetIn note → assetOut note + assetIn change.
     * @dev Public inputs (9): root, nullifier, newCOut, newCChange, assetIn, assetOut,
     *      amountOutMin, rateIn, rateOut. Actual size is private in the circuit.
     *      Pool must already hold assetOut for later unshields (inventory / LP seed).
     *      Live RH pool may not have this method until redeploy — check code version.
     */
    function sealedSwap(
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifier,
        bytes32 newCommitmentOut,
        bytes32 newCommitmentChange,
        address assetIn,
        address assetOut,
        uint256 amountOutMin,
        uint256 rateIn,
        uint256 rateOut
    ) external nonReentrant {
        if (assetIn == assetOut) revert SameAsset();
        if (rateIn == 0 || rateOut == 0) revert InvalidAmount();
        // C3: the rate must match the owner-approved rate for this direction.
        // rateIn/rateOut fit in uint128 (they are set that way); reject anything larger.
        if (rateIn > type(uint128).max || rateOut > type(uint128).max) revert RateNotAllowed();
        // M3: oracle-bound pricing per direction removes the trusted price. When a
        // pair is oracle-enabled, the caller's rate ratio must match the live
        // Chainlink ratio within tolerance; otherwise fall back to the C3
        // owner-pinned rate. (Neither fixes H1 solvency accounting.)
        if (oracleRatePair[assetIn][assetOut]) {
            OracleRates.requireRatio(
                oracleConfig,
                priceFeed[assetIn],
                priceFeed[assetOut],
                rateIn,
                rateOut,
                _assetDecimals(assetIn),
                _assetDecimals(assetOut)
            );
        } else {
            SwapRate memory sr = swapRate[assetIn][assetOut];
            if (
                !sr.enabled ||
                uint256(sr.rateIn) != rateIn ||
                uint256(sr.rateOut) != rateOut
            ) {
                revert RateNotAllowed();
            }
        }
        _requireSealedSwapProof(
            proof,
            root,
            nullifier,
            newCommitmentOut,
            newCommitmentChange,
            assetIn,
            assetOut,
            amountOutMin,
            rateIn,
            rateOut
        );
        if (spent[nullifier]) revert AlreadySpent();
        spent[nullifier] = true;

        if (newCommitmentOut == bytes32(0) || newCommitmentChange == bytes32(0)) {
            revert ZeroCommitment();
        }
        if (commitmentSeen[newCommitmentOut] || commitmentSeen[newCommitmentChange]) {
            revert DuplicateCommitment();
        }
        commitmentSeen[newCommitmentOut] = true;
        commitmentSeen[newCommitmentChange] = true;
        tree.insert(uint256(newCommitmentOut));
        tree.insert(uint256(newCommitmentChange));

        emit SealedSwapped(
            nullifier,
            assetIn,
            assetOut,
            newCommitmentOut,
            newCommitmentChange
        );
    }

    function _requireSealedSwapProof(
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifier,
        bytes32 newCommitmentOut,
        bytes32 newCommitmentChange,
        address assetIn,
        address assetOut,
        uint256 amountOutMin,
        uint256 rateIn,
        uint256 rateOut
    ) internal view {
        if (address(sealedSwapVerifier) == address(0)) revert VerifierNotSet();
        if (!tree.isKnownRoot(uint256(root))) revert UnknownRoot();
        uint256[] memory inputs = new uint256[](9);
        inputs[0] = uint256(root);
        inputs[1] = uint256(nullifier);
        inputs[2] = uint256(newCommitmentOut);
        inputs[3] = uint256(newCommitmentChange);
        inputs[4] = uint256(uint160(assetIn));
        inputs[5] = uint256(uint160(assetOut));
        inputs[6] = amountOutMin;
        inputs[7] = rateIn;
        inputs[8] = rateOut;
        if (!sealedSwapVerifier.verify(proof, inputs)) revert InvalidProof();
    }
}
