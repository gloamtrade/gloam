// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGloamVault, IERC20Swap} from "./GloamVaultSwap.sol";
import {IEscrowPayee, SwapEscrow2} from "./SwapEscrow2.sol";

/**
 * @title GloamVaultSwap2
 * @notice The next private swap through a live Gloam vault, in one transaction:
 *         take one note out of the vault, buy an exact amount of another asset
 *         on a DEX, and put that amount back into the vault as a new note. Who
 *         swapped stays private: the note spent and the note made are both
 *         unlinkable to a wallet, and the Gloam relay submits the call. The
 *         amounts are public, as on any DEX trade.
 *
 * What is new against GloamVaultSwap, whose rules all still hold:
 *  - Native ETH. A note may be native ETH (asset address(0)) on either side.
 *  - A way out. Each swap names a one-time exit key in its escrow key, and money
 *    waiting at the swap's escrow can leave to an address that key signs for.
 *  - A deadline. Each swap names the last time it can land in its escrow key.
 *    It limits the swap only. It does not limit a forced refund: once someone
 *    has sent the swap's unshield alone, the note's money waits at the escrow,
 *    and the same call puts it back as the refund note at any time, before or
 *    long after the deadline. An exit has no deadline either.
 *
 * What binds what. The vault's unshield proof has one free public input, `to`.
 * A swap sets it to an escrow address that CREATE2 derives from everything the
 * swap must do: the note spent (nullifier, amount), the new note (commitment,
 * asset, amount), a refund note (commitment, amount), the route, the exit key
 * and the deadline. So:
 *  - only the note's owner can start a swap (the proof needs its secret);
 *  - a caller who copies the call and changes the new note, the refund note,
 *    the route, the exit key or the deadline gets a different escrow, and the
 *    vault rejects the proof;
 *  - no two notes ever share an escrow;
 *  - the new note's shield proof binds it to exactly `amountOut` of the asset.
 *
 * If someone sends the unshield alone (the proof is public once broadcast),
 * the money waits at the escrow, which only this router can open. The same
 * swap call then sees the note already spent and puts the money back into the
 * vault as the owner's refund note, made beforehand for what is sure to have
 * arrived (the note's amount less the vault's highest possible fee). That call
 * needs only the refund note's proof: the spend's proof and root and the new
 * note's proof are not used on that path.
 *
 * The refund note is a deposit, so it takes room under the vault's limit for
 * the asset, and the vault can't exempt it. While that limit is full the money
 * would wait. exit() is the way out for that case, and for any other that keeps
 * a refund from landing: the holder of the exit key signs for an address, and
 * the whole escrow goes there, in the clear, straight from the escrow, so a token
 * that blocks this router still pays an exit. The exit key is a throwaway address
 * made for this one swap from a secret only the note's owner has, so it says
 * nothing about who that is, and nothing in a swap's proofs or calldata can sign
 * for it. The escrow opens once, so a refund and an exit can never both happen.
 * Nothing about an exit is private: it pays a public address the amount that
 * left the note, which is why the refund stays the normal way back.
 *
 * Leftovers (the input the swap did not need, any extra output, anything sent
 * here by mistake) go to the immutable treasury when it can receive them. A
 * treasury the token issuer blocks never stops a swap or a refund: what it
 * can't take stays here, and every amount a swap uses is measured as a change
 * in balance, so it is never spent on anyone's behalf. Every approval is set
 * back to zero. No upgrade, and no one can move what passes through.
 */
abstract contract GloamVaultSwap2 is IEscrowPayee {
    struct Spend {
        bytes proof;
        bytes32 root;
        bytes32 nullifier;
        address asset;
        uint256 amount;
    }

    struct Deposit {
        bytes proof;
        bytes32 commitment;
        address asset;
        uint256 amount;
    }

    /// @notice What a swap's escrow address is derived from (with the input asset).
    struct EscrowKey {
        bytes32 nullifier;
        uint256 amountIn;
        bytes32 outCommitment;
        address assetOut;
        uint256 amountOut;
        bytes32 refundCommitment;
        uint256 refundAmount;
        bytes32 routeHash;
        address exitKey;
        uint256 deadline;
    }

    /// @notice Native ETH, as the vault names it.
    address internal constant NATIVE = address(0);

    uint96 private constant IDLE = 0;
    uint96 private constant RUNNING = 1;
    /// @dev An escrow is being deployed: the one time ETH may come in from an address this contract can't name up front.
    uint96 private constant OPENING = 2;
    /// @dev An exit's escrow is being deployed and pays its recipient: nothing comes in here.
    uint96 private constant EXITING = 3;

    /// @dev Keeps an exit signature from meaning anything else.
    bytes32 private constant EXIT_DOMAIN = keccak256("gloam.vault-swap.exit.v1");

    IGloamVault public immutable vault;
    /// @notice Where the leftover input goes: the input the swap did not need.
    address public immutable treasury;

    uint96 private _entered;
    /// @dev While an exit opens its escrow, where the escrow pays. The router otherwise.
    address private _payee;

    event VaultSwap(
        bytes32 indexed nullifier,
        bytes32 indexed commitment,
        address indexed assetIn,
        address assetOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 leftover
    );
    event VaultSwapRefund(bytes32 indexed nullifier, bytes32 indexed commitment, address indexed asset, uint256 amount);
    event VaultSwapExit(bytes32 indexed nullifier, address indexed asset, address indexed to, uint256 amount);

    error ZeroAddress();
    error NotAContract();
    error SameAsset();
    error InvalidAmount();
    error BadRefund();
    error BadExit();
    error EscrowUsed();
    /// @notice The escrow's constructor stopped with no reason: out of gas, most likely.
    error EscrowFailed();
    error SwapExpired();
    error OverInput(uint256 needed, uint256 available);
    error ShortOutput(uint256 got, uint256 wanted);
    error Reentrancy();
    error TokenCallFailed();
    error NativeRefused();

    modifier nonReentrant() {
        if (_entered != IDLE) revert Reentrancy();
        _entered = RUNNING;
        _;
        _entered = IDLE;
    }

    constructor(address vault_, address treasury_) {
        if (vault_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (vault_.code.length == 0) revert NotAContract();
        vault = IGloamVault(vault_);
        treasury = treasury_;
    }

    /// @notice ETH comes in only from an escrow as it opens. A venue that handles ETH adds its own senders.
    receive() external payable virtual {
        if (!_opening()) revert NativeRefused();
    }

    /**
     * @notice The address a swap's unshield proof must name as `to`.
     * @param assetIn The note's asset (the escrow hands this on); address(0) for native ETH.
     * @param k The swap: routeHash is keccak256 of the route bytes passed to swap().
     */
    function escrowFor(address assetIn, EscrowKey calldata k) external view returns (address) {
        return _escrowAt(keccak256(abi.encode(k)), assetIn);
    }

    /**
     * @notice Swap one private note for `d.amount` of `d.asset`, back in the vault.
     *         When the note was already taken out to this swap's escrow by
     *         someone else, puts it back as the refund note `r` instead.
     * @param s The note to spend: its unshield proof names escrowFor(...) as `to`.
     * @param d The note to make: its shield proof binds `d.commitment` to `d.amount` of `d.asset`.
     * @param r The refund note, in `s.asset`, made in advance; used only in that case.
     * @param route Venue-specific route, checked by the venue contract.
     * @param exitKey The swap's one-time exit key (exit()).
     * @param deadline The last time the swap can land. It does not limit a forced refund:
     *        once the note's unshield has been sent alone, this call refunds at any time.
     * @return amountIn What the swap spent of the input (0 on a refund).
     */
    function swap(
        Spend calldata s,
        Deposit calldata d,
        Deposit calldata r,
        bytes calldata route,
        address exitKey,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountIn) {
        if (s.asset == d.asset) revert SameAsset();
        if (d.amount == 0) revert InvalidAmount();
        if (r.asset != s.asset || r.amount == 0 || r.amount > s.amount || r.commitment == d.commitment) revert BadRefund();

        bool refunding = vault.isSpent(s.nullifier);
        if (!refunding && block.timestamp > deadline) revert SwapExpired();
        uint256 available = _collect(s, r, _salt(s, d, r, keccak256(route), exitKey, deadline), refunding);

        if (refunding) {
            if (available < r.amount) revert BadRefund();
            _deposit(r);
            _trySweep(s.asset);
            emit VaultSwapRefund(s.nullifier, r.commitment, r.asset, r.amount);
            return 0;
        }
        return _buy(s, d, route, available);
    }

    /// @dev The swap itself: buys the new note with what arrived, and deposits it.
    function _buy(Spend calldata s, Deposit calldata d, bytes calldata route, uint256 available)
        private
        returns (uint256 amountIn)
    {
        uint256 outBefore = _balance(d.asset);
        amountIn = _swapExactOut(s.asset, d.asset, d.amount, available, route);
        if (amountIn > available) revert OverInput(amountIn, available);
        uint256 got = _balance(d.asset) - outBefore;
        if (got < d.amount) revert ShortOutput(got, d.amount);

        _deposit(d);
        _trySweep(s.asset);
        _trySweep(d.asset);
        // ETH a route's hook pushed here on a swap that holds neither end in ETH
        _trySweep(NATIVE);
        emit VaultSwap(s.nullifier, d.commitment, s.asset, d.asset, amountIn, d.amount, available - amountIn);
    }

    /**
     * @notice Take a swap's waiting money out of its escrow to `to`, in the clear,
     *         when its refund can't land. Anyone may send this; only the swap's
     *         exit key can have signed it, and the signature names `to`, so a
     *         copy can't send the money anywhere else. The escrow pays `to`
     *         itself: the money never passes through this router.
     * @param assetIn The note's asset.
     * @param k The swap's escrow key, as it was proved.
     * @param to Where the money goes. Public on chain, next to this swap.
     * @param signature k.exitKey's signature of exitDigest(escrow, to).
     * @return amount All that waited at the escrow.
     */
    function exit(address assetIn, EscrowKey calldata k, address to, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 amount)
    {
        bytes32 salt = keccak256(abi.encode(k));
        address escrow = _escrowAt(salt, assetIn);
        // nowhere the money would stop for good: the escrow itself, this router, the vault,
        // the token's own contract, or the venue's own contracts
        if (to == address(0) || to == escrow || to == address(this) || to == address(vault) || to == assetIn || _stopsHere(to)) {
            revert BadExit();
        }
        // address(0) is what ecrecover answers a bad signature, never a key
        address signer = _recover(exitDigest(escrow, to), signature);
        if (signer == address(0) || signer != k.exitKey) revert BadExit();
        // a note still in the vault hasn't paid this escrow: there is nothing to take out yet
        if (!vault.isSpent(k.nullifier)) revert BadExit();
        amount = _holding(assetIn, escrow);
        if (amount == 0) revert BadExit();
        (address receiver, uint256 had) = _beforeExit(assetIn, escrow, to);

        _payee = to;
        _open(salt, assetIn, EXITING);
        _payee = address(0);
        _afterExit(assetIn, receiver, had, amount);
        emit VaultSwapExit(k.nullifier, assetIn, to, amount);
    }

    /// @dev A venue's own contracts, where money sent from an escrow would stop. None here.
    function _stopsHere(address to) internal view virtual returns (bool) {
        to;
        return false;
    }

    /// @dev Before an exit pays: refuses one `to` would not receive as sent from `escrow`, and
    ///      returns who will hold the money and what they hold now. A venue on a chain where a
    ///      recipient can refuse a payment without a revert overrides it (Tempo).
    function _beforeExit(address token, address escrow, address to) internal view virtual returns (address receiver, uint256 had) {
        token;
        escrow;
        return (to, 0);
    }

    /// @dev After an exit paid: a venue that checked before may check the money arrived.
    function _afterExit(address token, address receiver, uint256 had, uint256 amount) internal view virtual {}

    /// @notice Where an escrow opening now pays (SwapEscrow2 asks): an exit's recipient, or this router.
    function escrowPayee() external view returns (address) {
        return _payee == address(0) ? address(this) : _payee;
    }

    /// @notice What an exit key signs: this escrow's money, on this chain and router, to `to`.
    function exitDigest(address escrow, address to) public view returns (bytes32) {
        return keccak256(abi.encode(EXIT_DOMAIN, block.chainid, address(this), escrow, to));
    }

    /// @dev Buy exactly `amountOut` of `assetOut` with at most `maxIn` of
    ///      `assetIn` held here, leaving the output here. Returns what it spent.
    function _swapExactOut(
        address assetIn,
        address assetOut,
        uint256 amountOut,
        uint256 maxIn,
        bytes calldata route
    ) internal virtual returns (uint256 amountIn);

    /// @dev True while a swap is running, for venue callbacks.
    function _inSwap() internal view returns (bool) {
        return _entered == RUNNING;
    }

    /// @dev True while an escrow is handing over what it holds.
    function _opening() internal view returns (bool) {
        return _entered == OPENING;
    }

    /// @dev Takes the note out to the swap's escrow (unless that already
    ///      happened), opens the escrow, and returns what arrived here.
    function _collect(Spend calldata s, Deposit calldata r, bytes32 salt, bool spent) private returns (uint256 available) {
        address escrow = _escrowAt(salt, s.asset);
        if (!spent) {
            _unshieldTo(s, escrow);
        } else if (_holding(s.asset, escrow) < r.amount) {
            // spent some other way, or this swap already ran: nothing waits at the escrow
            revert BadRefund();
        }
        // the vault keeps its cash-out fee: what arrived is what the swap may spend
        available = _open(salt, s.asset, OPENING);
    }

    function _unshieldTo(Spend calldata s, address to) private {
        vault.unshield(s.proof, s.root, s.nullifier, s.asset, to, s.amount);
    }

    /// @dev keccak256(abi.encode(EscrowKey)), field by field.
    function _salt(
        Spend calldata s,
        Deposit calldata d,
        Deposit calldata r,
        bytes32 routeHash,
        address exitKey,
        uint256 deadline
    ) private pure returns (bytes32) {
        EscrowKey memory k;
        k.nullifier = s.nullifier;
        k.amountIn = s.amount;
        k.outCommitment = d.commitment;
        k.assetOut = d.asset;
        k.amountOut = d.amount;
        k.refundCommitment = r.commitment;
        k.refundAmount = r.amount;
        k.routeHash = routeHash;
        k.exitKey = exitKey;
        k.deadline = deadline;
        return keccak256(abi.encode(k));
    }

    function _escrowAt(bytes32 salt, address token) private view returns (address) {
        bytes32 codeHash = keccak256(abi.encodePacked(type(SwapEscrow2).creationCode, abi.encode(token)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, codeHash)))));
    }

    /// @dev Deploys the swap's escrow, which sends all it holds to escrowPayee(), and
    ///      returns what came in here. Once per swap: a second deploy can't happen.
    ///      `state` is OPENING when the escrow pays this router, EXITING when it pays
    ///      an exit's recipient, while receive() takes no ETH.
    function _open(bytes32 salt, address token, uint96 state) private returns (uint256 arrived) {
        // an opened escrow keeps one byte of code: refuse it here, before a second deploy
        // could fail at that address and use up the gas the caller sent
        if (_escrowAt(salt, token).code.length != 0) revert EscrowUsed();
        uint256 before = _balance(token);
        bytes memory code = abi.encodePacked(type(SwapEscrow2).creationCode, abi.encode(token));
        address e;
        uint256 said;
        _entered = state;
        assembly {
            e := create2(0, add(code, 0x20), mload(code), salt)
            said := returndatasize()
        }
        _entered = RUNNING;
        // a payment out of the escrow that was refused says why; one that stopped with no
        // reason ran out of gas, most likely
        if (e == address(0)) {
            if (said != 0) revert TokenCallFailed();
            revert EscrowFailed();
        }
        arrived = _balance(token) - before;
    }

    function _deposit(Deposit calldata d) private {
        if (d.asset == NATIVE) {
            vault.shieldBound{value: d.amount}(NATIVE, d.amount, d.commitment, d.proof);
            return;
        }
        _approve(d.asset, address(vault), d.amount);
        vault.shieldBound(d.asset, d.amount, d.commitment, d.proof);
        _approve(d.asset, address(vault), 0);
    }

    function _balance(address token) internal view returns (uint256) {
        return _holding(token, address(this));
    }

    function _holding(address token, address who) private view returns (uint256) {
        return token == NATIVE ? who.balance : IERC20Swap(token).balanceOf(who);
    }

    /// @dev What `who` holds of `token`, for a venue's checks.
    function _holdingOf(address token, address who) internal view returns (uint256) {
        return _holding(token, who);
    }

    /// @dev Everything held of `token` to the treasury, if it can take it. A
    ///      refusal (an issuer block, a pause) is ignored: the tokens stay here.
    function _trySweep(address token) private {
        uint256 amount = _balance(token);
        if (amount == 0) return;
        bool ok;
        if (token == NATIVE) {
            (ok, ) = treasury.call{value: amount}("");
        } else {
            (ok, ) = token.call(abi.encodeWithSelector(0xa9059cbb, treasury, amount));
        }
        ok; // best effort, on purpose
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        return ecrecover(digest, uint8(signature[64]), bytes32(signature[0:32]), bytes32(signature[32:64]));
    }

    function _transfer(address token, address to, uint256 amount) internal {
        _call(token, abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer(address,uint256)
    }

    function _approve(address token, address spender, uint256 amount) internal {
        _call(token, abi.encodeWithSelector(0x095ea7b3, spender, amount)); // approve(address,uint256)
    }

    /// @dev A token call that must succeed, for tokens that return true or nothing.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenCallFailed();
    }
}
