// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SwapEscrow} from "./SwapEscrow.sol";

/// @notice The vault calls a private claim makes. unshield and shieldBound are proof-gated in the vault.
interface IClaimVault {
    function unshield(
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifier,
        address asset,
        address to,
        uint256 amount
    ) external;

    function shieldBound(address asset, uint256 amount, bytes32 commitment, bytes calldata proof) external payable;

    function isSpent(bytes32 nullifier) external view returns (bool);
}

/// @notice The GloamNames registry calls a private claim makes (contracts/src/GloamNames.sol).
interface IClaimNames {
    function token() external view returns (address);

    function priceOf(string calldata name, uint256 years_) external view returns (uint256);

    function register(string calldata name, bytes32 keyX, bytes32 keyY, address holder, uint256 years_)
        external
        returns (uint64 expires);
}

interface IClaimERC20 {
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title GloamNamesRegistrar
 * @notice Claim a Gloam name with $GLOAM from a private balance, in one transaction:
 *         take one GLOAM note out of the vault and pay the GloamNames registry
 *         with it. No public wallet pays, so nobody can see which wallet bought
 *         the name. The holder (the address that may re-point or hand on the
 *         name) is whatever address the claim names, and that stays public on
 *         the registry, as it does for any name.
 *
 * What binds what (the pattern of GloamVaultSwap). The vault's unshield proof
 * has one free public input, `to`. A claim sets it to an escrow address that
 * CREATE2 derives from everything the claim must do: the note spent (nullifier,
 * amount), the name, the key it points at, the holder, the years, and a refund
 * note (commitment, amount). So:
 *  - only the note's owner can start a claim (the proof needs its secret);
 *  - a caller who copies the call and changes the name, key, holder, years or
 *    refund note gets a different escrow, and the vault rejects the proof;
 *  - no two notes ever share an escrow.
 *
 * The note is sized so what arrives after the vault's cash-out fee covers the
 * price; whatever is left (rounding, or a price the owner lowered meanwhile)
 * goes to the treasury, as the swap router does with its leftovers. A price
 * raised meanwhile, a name taken meanwhile, or a reserved name makes the
 * registry revert, and with it the whole call: the note stays unspent.
 *
 * If someone sends the unshield alone (the proof is public once broadcast), the
 * money waits at the escrow, which only this contract can open. The same claim
 * call then sees the note already spent and puts the money back into the vault
 * as the owner's refund note, made beforehand for what is sure to have arrived
 * (the note's amount less the vault's highest possible fee).
 *
 * No owner, no admin, no upgrade. Every approval is set back to zero.
 */
contract GloamNamesRegistrar {
    struct Spend {
        bytes proof;
        bytes32 root;
        bytes32 nullifier;
        uint256 amount;
    }

    struct Claim {
        string name;
        bytes32 keyX;
        bytes32 keyY;
        address holder;
        uint256 years_;
    }

    /// @notice A note made in advance, put into the vault only if the claim's unshield was sent alone.
    struct Refund {
        bytes proof;
        bytes32 commitment;
        uint256 amount;
    }

    /// @notice What a claim's escrow address is derived from.
    struct EscrowKey {
        bytes32 nullifier;
        uint256 amount;
        bytes32 nameHash;
        bytes32 keyX;
        bytes32 keyY;
        address holder;
        uint256 years_;
        bytes32 refundCommitment;
        uint256 refundAmount;
    }

    IClaimVault public immutable vault;
    IClaimNames public immutable names;
    /// @notice $GLOAM: what names are paid in, and what the notes spent here hold.
    address public immutable token;
    /// @notice Where what a claim did not need goes.
    address public immutable treasury;

    uint256 private _entered;

    event NameClaimedPrivately(
        bytes32 indexed nullifier, bytes32 indexed node, address indexed holder, string name, uint256 paid, uint256 leftover
    );
    event ClaimRefund(bytes32 indexed nullifier, bytes32 indexed commitment, uint256 amount);

    error ZeroAddress();
    error NotAContract();
    error BadRefund();
    error EscrowUsed();
    error ShortInput(uint256 price, uint256 available);
    error PaidWrong(uint256 paid, uint256 price);
    error Reentrancy();
    error TokenCallFailed();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address vault_, address names_, address treasury_) {
        if (vault_ == address(0) || names_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (vault_.code.length == 0 || names_.code.length == 0) revert NotAContract();
        vault = IClaimVault(vault_);
        names = IClaimNames(names_);
        token = IClaimNames(names_).token();
        treasury = treasury_;
    }

    /// @notice The address a claim's unshield proof must name as `to`.
    function escrowFor(EscrowKey calldata k) external view returns (address) {
        return _escrowAt(keccak256(abi.encode(k)));
    }

    /**
     * @notice Pay for `c.name` with one private GLOAM note. When the note was
     *         already taken out to this claim's escrow by someone else, puts it
     *         back into the vault as the refund note `r` instead.
     * @param s The note to spend: its unshield proof names escrowFor(...) as `to`.
     * @param c The name, the key it points at, its holder and the years.
     * @param r The refund note, in GLOAM, made in advance; used only in that case.
     * @return paid What the registry took (0 on a refund).
     */
    function claim(Spend calldata s, Claim calldata c, Refund calldata r) external nonReentrant returns (uint256 paid) {
        if (r.amount == 0 || r.amount > s.amount) revert BadRefund();

        bool refunding = vault.isSpent(s.nullifier);
        bytes32 salt = _salt(s, c, r);
        address escrow = _escrowAt(salt);
        if (!refunding) {
            vault.unshield(s.proof, s.root, s.nullifier, token, escrow, s.amount);
        } else if (IClaimERC20(token).balanceOf(escrow) < r.amount) {
            // spent some other way, or this claim already ran: nothing waits at the escrow
            revert BadRefund();
        }
        uint256 before = _balance();
        _openEscrow(salt);
        // the vault keeps its cash-out fee: what arrived is what the claim may spend
        uint256 available = _balance() - before;

        if (refunding) {
            if (available < r.amount) revert BadRefund();
            _approve(address(vault), r.amount);
            vault.shieldBound(token, r.amount, r.commitment, r.proof);
            _approve(address(vault), 0);
            _trySweep();
            emit ClaimRefund(s.nullifier, r.commitment, r.amount);
            return 0;
        }

        paid = names.priceOf(c.name, c.years_);
        if (paid > available) revert ShortInput(paid, available);
        uint256 held = _balance();
        _approve(address(names), paid);
        names.register(c.name, c.keyX, c.keyY, c.holder, c.years_);
        _approve(address(names), 0);
        // the registry takes the price from here; anything else would be a bug worth stopping for
        if (held - _balance() != paid) revert PaidWrong(held - _balance(), paid);

        _trySweep();
        emit NameClaimedPrivately(s.nullifier, keccak256(bytes(c.name)), c.holder, c.name, paid, available - paid);
    }

    /// @dev keccak256(abi.encode(EscrowKey)), field by field.
    function _salt(Spend calldata s, Claim calldata c, Refund calldata r) private pure returns (bytes32) {
        EscrowKey memory k;
        k.nullifier = s.nullifier;
        k.amount = s.amount;
        k.nameHash = keccak256(bytes(c.name));
        k.keyX = c.keyX;
        k.keyY = c.keyY;
        k.holder = c.holder;
        k.years_ = c.years_;
        k.refundCommitment = r.commitment;
        k.refundAmount = r.amount;
        return keccak256(abi.encode(k));
    }

    function _escrowAt(bytes32 salt) private view returns (address) {
        bytes32 codeHash = keccak256(abi.encodePacked(type(SwapEscrow).creationCode, abi.encode(token)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, codeHash)))));
    }

    /// @dev Deploys the claim's escrow, which sends this contract what the vault paid it. Once per claim.
    function _openEscrow(bytes32 salt) private {
        bytes memory code = abi.encodePacked(type(SwapEscrow).creationCode, abi.encode(token));
        address e;
        assembly {
            e := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (e == address(0)) revert EscrowUsed();
    }

    function _balance() private view returns (uint256) {
        return IClaimERC20(token).balanceOf(address(this));
    }

    /// @dev Everything held to the treasury, if it can take it. A refusal is ignored: the tokens stay here.
    function _trySweep() private {
        uint256 amount = _balance();
        if (amount == 0) return;
        (bool ok, ) = token.call(abi.encodeWithSelector(0xa9059cbb, treasury, amount));
        ok; // best effort, on purpose
    }

    /// @dev approve(address,uint256), for tokens that return true or nothing.
    function _approve(address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenCallFailed();
    }
}
