// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IShieldPool} from "./interfaces/IShieldPool.sol";
import {IVerifier} from "./interfaces/IVerifier.sol";
import {IPoseidon2} from "./lib/IPoseidon.sol";
import {IncrementalMerkleTreePoseidon2 as IMT} from "./lib/IncrementalMerkleTreePoseidon2.sol";
import {ChangeTimelock} from "./lib/ChangeTimelock.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/**
 * NEXT VAULT. NOT DEPLOYED. NOT AUDITED. The live vaults run ShieldPoolCore.sol, which
 * stays in this repo unchanged. Nothing here reaches a live contract: a deployed
 * vault cannot be upgraded.
 *
 * @title ShieldPoolCore2
 * @notice The payment vault every Gloam pool shares: Poseidon Merkle tree,
 *         deposits (shield / shieldBound), private transfers, withdrawals
 *         (unshield), the setup-then-timelock owner, and beta deposit limits.
 * @dev Leaves/roots stored as uint256 field elements, exposed as bytes32 for IShieldPool.
 *      ShieldPoolPoseidon adds sealed swaps on top; ShieldPoolPayments is this alone.
 *
 * Owner powers (no-middlemen hardening):
 *  - The owner has NO function that moves user funds. There is no emergencyWithdraw;
 *    notes leave the pool only through proof-gated unshield(). sweepStrayNative()
 *    can only take native currency above deposited[address(0)] + feesOwed[address(0)],
 *    i.e. ETH sent straight to receive() that backs no note and is no owed fee.
 *  - Every setter that affects proof validity or asset flows is instant only
 *    during setup mode. After endSetup() it must go through ChangeTimelock:
 *    queueChange -> CHANGE_DELAY (3 days) public notice -> executeChange.
 *  - Deposit limits (mainnet beta): once turnOnDepositLimits() runs in setup, an
 *    asset can be deposited only up to its perDeposit and total limits, and an
 *    asset with no limit cannot be deposited at all. The owner can LOWER a limit
 *    instantly (down to zero, which closes deposits for that asset); raising one
 *    goes through the timelock. Limits never touch transfers or withdrawals.
 *  - Cash-out fee (mainnet): deposits and private transfers are free; unshield()
 *    keeps withdrawFeeBps of the proven amount (rounded down, capped at
 *    MAX_WITHDRAW_FEE_BPS = 1%) in the pool as feesOwed[asset]. Anyone can call
 *    collectFees(asset) to send it to feeRecipient; unshield never calls the
 *    recipient, so a frozen or reverting recipient cannot block a withdrawal.
 *    Off (0 bps, no recipient) by default. Set instantly in setup, then only
 *    through the timelock; lowering or turning it off is instant.
 *    Invariant: balance(asset) >= deposited[asset] + feesOwed[asset].
 */
abstract contract ShieldPoolCore2 is IShieldPool, ChangeTimelock {
    using IMT for IMT.Tree;

    IVerifier public verifier;
    /// @notice Optional shield (deposit) verifier: binds the inserted commitment to the
    ///         public (commitment, amount, asset). While address(0), shield() trusts the
    ///         client — which lets a depositor embed a larger amount than they send (C1).
    ///         Once set, plain shield() is blocked and shieldBound() (proof required) is the
    ///         only deposit path, closing the value-binding gap.
    IVerifier public shieldVerifier;
    IPoseidon2 public immutable poseidon2;
    IMT.Tree internal tree;

    mapping(bytes32 => bool) public spent;
    mapping(address => uint256) public override deposited;

    /// @notice Reject a commitment that has already been inserted (double-shield footgun).
    mapping(bytes32 => bool) public commitmentSeen;

    /// @notice Beta deposit limits per asset, in the asset's own units.
    ///         perDeposit caps one deposit; total caps deposited[asset].
    struct DepositLimit {
        uint128 perDeposit;
        uint128 total;
    }
    mapping(address => DepositLimit) public depositLimit;
    /// @notice True once turnOnDepositLimits() ran. One-way.
    bool public depositLimitsOn;

    address public owner;
    /// @notice M-4: two-step ownership. Set by transferOwnership, claimed by the
    ///         incoming owner via acceptOwnership. Guards against handing the pool
    ///         to a wrong/dead address in one irreversible step.
    address public pendingOwner;

    /// @notice Reentrancy latch. The value-moving paths follow checks-effects-
    ///         interactions, so this is defense-in-depth (audit INFO-3): it removes
    ///         reliance on CEI + STATICCALL-only view calls holding under future edits.
    uint256 private _entered;

    /// @notice Cash-out fee receiver. address(0) means the fee is off.
    address public feeRecipient;
    /// @notice Cash-out fee in basis points of the unshielded amount. 0 means off.
    uint16 public withdrawFeeBps;
    /// @notice Cash-out fees held in the pool per asset, waiting for collectFees().
    ///         Kept apart from deposited[]: they back no note.
    mapping(address => uint256) public feesOwed;

    /// @notice Hard cap on the cash-out fee: 100 bps = 1%.
    uint16 public constant MAX_WITHDRAW_FEE_BPS = 100;
    uint256 private constant BPS = 10_000;

    uint256 public constant PROOF_LAYOUT_VERSION = 2;
    string public constant HASH_SCHEME = "poseidon";

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ShieldVerifierSet(address indexed verifier);
    event VerifierSet(address indexed verifier);
    event StrayNativeSwept(address indexed to, uint256 amount);
    event DepositLimitsOn();
    event DepositLimitSet(address indexed asset, uint128 perDeposit, uint128 total);
    event WithdrawFeeSet(uint16 bps, address indexed recipient);
    /// @notice Emitted by unshield() when a fee is kept, next to Unshielded (whose
    ///         amount stays the full proven amount; `to` received amount - fee).
    event WithdrawFee(bytes32 indexed nullifier, address indexed asset, uint256 fee);
    event FeesCollected(address indexed asset, address indexed recipient, uint256 amount);

    error NotOwner();
    error NotPendingOwner();
    error ShieldVerifierAlreadySet();
    error ZeroCommitment();
    error AlreadySpent();
    error UnknownRoot();
    error VerifierNotSet();
    error InvalidProof();
    error ZeroAddress();
    error TransferFailed();
    error InvalidAmount();
    error InvalidMsgValue();
    error InsufficientPoolBalance();
    error FeeOnTransferNotSupported();
    error DuplicateCommitment();
    error ShieldProofRequired();
    error Reentrancy();
    error NotAContract();
    error NothingToSweep();
    error OverDepositLimit();
    error LimitNotLower();
    error FeeTooHigh();
    error FeeNotLower();
    error NothingToCollect();
    error DepositLimitsOff();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    /**
     * @param poseidon2_ Circomlib Poseidon (2 inputs)
     * @param verifier_ UnshieldIVerifier or address(0) until set
     */
    constructor(address poseidon2_, address verifier_) {
        if (poseidon2_ == address(0)) revert ZeroAddress();
        if (poseidon2_.code.length == 0) revert NotAContract();
        owner = msg.sender;
        poseidon2 = IPoseidon2(poseidon2_);
        if (verifier_ != address(0)) {
            if (verifier_.code.length == 0) revert NotAContract();
            verifier = IVerifier(verifier_);
        }
        tree.initialize(IPoseidon2(poseidon2_));
    }

    receive() external payable {}

    // ─────────────────────────────────────────────────────────────────────────
    // Rule-changing setters. Direct calls work only in setup mode (onlySetup);
    // after endSetup() the same calls must be queued via queueChange() and run
    // via executeChange() after CHANGE_DELAY. Both paths share the internal
    // _setX() bodies, so validation and events are identical.
    // ─────────────────────────────────────────────────────────────────────────

    function setVerifier(address verifier_) external onlyOwner onlySetup {
        _setVerifier(verifier_);
    }

    /// @notice Enable value-bound deposits. Once set, plain shield() is blocked and
    ///         callers must use shieldBound() with a proof binding commitment↔amount↔asset.
    /// @dev M-4: one-way, and setup only. Once bound-shield enforcement is on it can
    ///      never be cleared or repointed (e.g. reset to 0 to reopen the unbound C1
    ///      path), and the timelock does not take this setter.
    function setShieldVerifier(address verifier_) external onlyOwner onlySetup {
        _setShieldVerifier(verifier_);
    }

    /// @notice Enforce deposit limits from now on. Setup only, and one-way: limits
    ///         can be lowered or raised later, never switched off.
    function turnOnDepositLimits() external onlyOwner onlySetup {
        depositLimitsOn = true;
        emit DepositLimitsOn();
    }

    /// @notice Set an asset's deposit limits. Instant in setup; after it, queue it.
    function setDepositLimit(
        address asset,
        uint128 perDeposit,
        uint128 total
    ) external onlyOwner onlySetup {
        _setDepositLimit(asset, perDeposit, total);
    }

    /// @notice Lower an asset's deposit limits at once, with no timelock, e.g. to
    ///         close deposits (0, 0) during an incident. Cannot raise either value.
    ///         Withdrawals and transfers are never affected.
    function lowerDepositLimit(address asset, uint128 perDeposit, uint128 total) external onlyOwner {
        DepositLimit memory cur = depositLimit[asset];
        if (perDeposit > cur.perDeposit || total > cur.total) revert LimitNotLower();
        _setDepositLimit(asset, perDeposit, total);
    }

    /// @notice Set the cash-out fee and who collects it. Instant in setup; after
    ///         it, queue it. bps is capped at MAX_WITHDRAW_FEE_BPS, and a non-zero
    ///         fee needs a recipient. (0, address(0)) turns the fee off.
    function setWithdrawFee(uint16 bps, address recipient) external onlyOwner onlySetup {
        _setWithdrawFee(bps, recipient);
    }

    /// @notice Lower the cash-out fee at once, with no timelock, down to 0 (off).
    ///         Cannot raise it or change the recipient, so owed fees stay collectable.
    function lowerWithdrawFee(uint16 bps) external onlyOwner {
        if (bps > withdrawFeeBps) revert FeeNotLower();
        _setWithdrawFee(bps, feeRecipient);
    }

    function _setVerifier(address verifier_) internal {
        // A verifier with no code would stop every spend (Kann I-07). Covers address(0) too.
        if (verifier_.code.length == 0) revert NotAContract();
        verifier = IVerifier(verifier_);
        emit VerifierSet(verifier_);
    }

    function _setShieldVerifier(address verifier_) internal {
        if (address(shieldVerifier) != address(0)) revert ShieldVerifierAlreadySet();
        if (verifier_ == address(0)) revert ZeroAddress();
        if (verifier_.code.length == 0) revert NotAContract();
        shieldVerifier = IVerifier(verifier_);
        emit ShieldVerifierSet(verifier_);
    }

    function _setDepositLimit(address asset, uint128 perDeposit, uint128 total) internal {
        depositLimit[asset] = DepositLimit(perDeposit, total);
        emit DepositLimitSet(asset, perDeposit, total);
    }

    function _setWithdrawFee(uint16 bps, address recipient) internal {
        if (bps > MAX_WITHDRAW_FEE_BPS) revert FeeTooHigh();
        if (bps != 0 && recipient == address(0)) revert ZeroAddress();
        withdrawFeeBps = bps;
        feeRecipient = recipient;
        emit WithdrawFeeSet(bps, recipient);
    }

    // ── ChangeTimelock hooks ────────────────────────────────────────────────

    function _checkOwner() internal view override {
        if (msg.sender != owner) revert NotOwner();
    }

    /// @dev Whitelist of timelockable setters and their static-arg word counts.
    ///      A pool that adds setters checks its own first, then calls this.
    ///      setShieldVerifier is not here: it is set once in setup and never again,
    ///      so a queued change could only ever fail (Kann I-04).
    function _changeArgWords(bytes4 selector) internal pure virtual override returns (uint256) {
        if (selector == ShieldPoolCore2.setVerifier.selector) return 1;
        if (selector == ShieldPoolCore2.setDepositLimit.selector) return 3;
        if (selector == ShieldPoolCore2.setWithdrawFee.selector) return 2;
        return 0;
    }

    /// @dev Internal dispatch for a matured queued change. No external calls.
    function _applyChange(bytes4 selector, bytes calldata args) internal virtual override {
        if (selector == ShieldPoolCore2.setVerifier.selector) {
            _setVerifier(abi.decode(args, (address)));
        } else if (selector == ShieldPoolCore2.setDepositLimit.selector) {
            (address asset, uint128 per, uint128 total) = abi.decode(args, (address, uint128, uint128));
            _setDepositLimit(asset, per, total);
        } else if (selector == ShieldPoolCore2.setWithdrawFee.selector) {
            (uint16 bps, address recipient) = abi.decode(args, (uint16, address));
            _setWithdrawFee(bps, recipient);
        } else {
            revert UnknownChange();
        }
    }

    /// @notice M-4: begin a two-step ownership handoff. The new owner must call
    ///         acceptOwnership() to take control.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice M-4: claim ownership after transferOwnership named you.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, owner);
    }

    /// @notice Recover native currency that was sent directly (via receive()) and is
    ///         not backing any shielded note. Audit INFO-1: such ETH is otherwise
    ///         permanently stuck, since unshield only pays proof-bound notes. Only
    ///         the surplus over deposited[address(0)] + feesOwed[address(0)] is
    ///         sweepable, so shielded native balances and owed fees are never
    ///         touched. This is the owner's only value-moving function and it
    ///         cannot reach note-backing funds.
    function sweepStrayNative(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 backed = deposited[address(0)] + feesOwed[address(0)];
        uint256 bal = address(this).balance;
        if (bal <= backed) revert NothingToSweep();
        uint256 surplus = bal - backed;
        (bool ok, ) = to.call{value: surplus}("");
        if (!ok) revert TransferFailed();
        emit StrayNativeSwept(to, surplus);
    }

    /// @notice Send an asset's owed cash-out fees to feeRecipient. Anyone may call
    ///         it; the destination is fixed. It moves only feesOwed[asset], never
    ///         note-backing funds. If the recipient cannot receive (e.g. frozen by
    ///         the token issuer) this reverts and the fees stay owed in the pool.
    function collectFees(address asset) external nonReentrant {
        address recipient = feeRecipient;
        if (recipient == address(0)) revert ZeroAddress();
        uint256 amount = feesOwed[asset];
        if (amount == 0) revert NothingToCollect();
        feesOwed[asset] = 0;
        _pushAsset(asset, recipient, amount);
        emit FeesCollected(asset, recipient, amount);
    }

    function nextIndex() external view returns (uint256) {
        return tree.nextIndex;
    }

    function currentRoot() external view returns (bytes32) {
        return bytes32(tree.currentRoot);
    }

    function isKnownRoot(bytes32 root) external view returns (bool) {
        return tree.isKnownRoot(uint256(root));
    }

    function isSpent(bytes32 nullifier) external view returns (bool) {
        return spent[nullifier];
    }

    /**
     * @notice Trust-the-client deposit. Blocked once a shieldVerifier is configured.
     * @dev While shieldVerifier == address(0) this preserves legacy/testnet behavior,
     *      but the commitment is NOT bound to `amount` (C1). Prefer shieldBound().
     */
    function shield(
        address asset,
        uint256 amount,
        bytes32 commitment
    ) external payable virtual override nonReentrant {
        if (address(shieldVerifier) != address(0)) revert ShieldProofRequired();
        _shield(asset, amount, commitment);
    }

    /**
     * @notice Value-bound deposit. Requires a proof that `commitment` opens to the
     *         PUBLIC (amount, asset) — so the note's value cannot exceed the funds sent.
     * @param proof Groth16 proof for public inputs [commitment, amount, asset].
     */
    function shieldBound(
        address asset,
        uint256 amount,
        bytes32 commitment,
        bytes calldata proof
    ) external payable nonReentrant {
        if (address(shieldVerifier) == address(0)) revert VerifierNotSet();
        uint256[] memory inputs = new uint256[](3);
        inputs[0] = uint256(commitment);
        inputs[1] = amount;
        inputs[2] = uint256(uint160(asset));
        if (!shieldVerifier.verify(proof, inputs)) revert InvalidProof();
        _shield(asset, amount, commitment);
    }

    function _shield(
        address asset,
        uint256 amount,
        bytes32 commitment
    ) internal {
        if (commitment == bytes32(0)) revert ZeroCommitment();
        if (amount == 0) revert InvalidAmount();
        if (commitmentSeen[commitment]) revert DuplicateCommitment();
        if (depositLimitsOn) {
            DepositLimit memory lim = depositLimit[asset];
            if (amount > lim.perDeposit || deposited[asset] + amount > lim.total) {
                revert OverDepositLimit();
            }
        }
        commitmentSeen[commitment] = true;

        if (asset == address(0)) {
            if (msg.value != amount) revert InvalidMsgValue();
        } else {
            if (msg.value != 0) revert InvalidMsgValue();
            // Audit INFO-2: reject a codeless `asset` explicitly. Otherwise the
            // low-level transferFrom in _pullERC20 would return success (empty data)
            // against an EOA/undeployed address and mint phantom `deposited` credit.
            // (The balanceOf delta below also catches it today, but only incidentally.)
            if (asset.code.length == 0) revert NotAContract();
            uint256 before = IERC20(asset).balanceOf(address(this));
            _pullERC20(msg.sender, amount, asset);
            uint256 received = IERC20(asset).balanceOf(address(this)) - before;
            if (received != amount) revert FeeOnTransferNotSupported();
        }

        deposited[asset] += amount;
        uint256 leafIndex = tree.insert(uint256(commitment));

        emit Shielded(commitment, asset, amount, leafIndex, msg.sender);
    }

    function transfer(
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifier,
        bytes32[2] calldata newCommitments
    ) external override nonReentrant {
        // spent first: a duplicate spend stops before the ~300k gas proof check (audit R-1)
        if (spent[nullifier]) revert AlreadySpent();
        _requireTransferProof(proof, root, nullifier, newCommitments);
        spent[nullifier] = true;

        for (uint256 i = 0; i < 2; i++) {
            if (newCommitments[i] == bytes32(0)) revert ZeroCommitment();
            if (commitmentSeen[newCommitments[i]]) revert DuplicateCommitment();
            commitmentSeen[newCommitments[i]] = true;
            tree.insert(uint256(newCommitments[i]));
        }

        emit Transferred(nullifier, newCommitments);
    }

    function unshield(
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifier,
        address asset,
        address to,
        uint256 amount
    ) external override nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        if (spent[nullifier]) revert AlreadySpent();
        _requireUnshieldProof(proof, root, nullifier, asset, to, amount);
        spent[nullifier] = true;

        if (deposited[asset] < amount) revert InsufficientPoolBalance();
        // The proof binds the full `amount`; the note is spent in full. The fee
        // stays in the pool as feesOwed (no call to the recipient here), and `to`
        // gets the rest. fee < amount always, since bps <= 1%.
        uint256 fee = _withdrawFee(amount);
        deposited[asset] -= amount;
        if (fee != 0) feesOwed[asset] += fee;
        _pushAsset(asset, to, amount - fee);

        emit Unshielded(nullifier, asset, to, amount);
        if (fee != 0) emit WithdrawFee(nullifier, asset, fee);
    }

    /// @dev floor(amount * bps / 10_000), rounding in the user's favour, split so
    ///      it cannot overflow for any amount. 0 while the fee is off.
    function _withdrawFee(uint256 amount) internal view returns (uint256) {
        uint256 bps = withdrawFeeBps;
        if (bps == 0 || feeRecipient == address(0)) return 0;
        return (amount / BPS) * bps + ((amount % BPS) * bps) / BPS;
    }

    function _requireTransferProof(
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifier,
        bytes32[2] calldata newCommitments
    ) internal view {
        if (address(verifier) == address(0)) revert VerifierNotSet();
        if (!tree.isKnownRoot(uint256(root))) revert UnknownRoot();
        uint256[] memory inputs = new uint256[](4);
        inputs[0] = uint256(root);
        inputs[1] = uint256(nullifier);
        inputs[2] = uint256(newCommitments[0]);
        inputs[3] = uint256(newCommitments[1]);
        if (!verifier.verify(proof, inputs)) revert InvalidProof();
    }

    function _requireUnshieldProof(
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifier,
        address asset,
        address to,
        uint256 amount
    ) internal view {
        if (address(verifier) == address(0)) revert VerifierNotSet();
        if (!tree.isKnownRoot(uint256(root))) revert UnknownRoot();
        uint256[] memory inputs = new uint256[](5);
        inputs[0] = uint256(root);
        inputs[1] = uint256(nullifier);
        inputs[2] = uint256(uint160(asset));
        inputs[3] = amount;
        inputs[4] = uint256(uint160(to));
        if (!verifier.verify(proof, inputs)) revert InvalidProof();
    }

    function _pullERC20(address from, uint256 amount, address asset) internal {
        (bool success, bytes memory data) = asset.call(
            abi.encodeWithSelector(
                IERC20.transferFrom.selector,
                from,
                address(this),
                amount
            )
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }

    function _pushAsset(address asset, address to, uint256 amount) internal {
        if (asset == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            (bool success, bytes memory data) = asset.call(
                abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
            );
            if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
                revert TransferFailed();
            }
        }
    }
}
