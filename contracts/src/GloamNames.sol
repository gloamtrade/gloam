// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title GloamNames
 * @notice Short names for Gloam addresses: "duke" instead of gloamr1.<122 characters>.
 *
 *  - A name points at one P-256 receive key, the key inside a Gloam address
 *    (gloamr1.<base64url SPKI>). Paying "duke" seals a private payment to that
 *    key, exactly as pasting the full address does. The key is checked to be
 *    on the curve here, so a name can never point at a key nobody can open.
 *  - Names are paid for per year in $GLOAM. Every token paid goes straight
 *    from the payer to the Gloam treasury in the same transaction. This
 *    contract never holds tokens.
 *  - Names are lowercase a to z, 0 to 9 and underscore, 3 to 20 characters, so
 *    look-alike letters from other alphabets cannot copy a name.
 *  - After a name expires its holder has GRACE_PERIOD to renew it. Until then
 *    it still resolves to the same key and nobody else can take it.
 *  - Anyone can renew any name, so a friend or a team can keep one alive.
 *
 * Owner powers (the Safe): set the yearly prices, change where payments go
 * (the treasury), and set a name that nobody holds aside for one address (so
 * "gloam" or "support" cannot be taken to impersonate the team). The owner cannot change, take, cancel or re-point a
 * name someone holds. Only the holder can change its key or hand it on.
 *
 * Privacy: the wallet that holds a name is public, and so is the key the name
 * points at; both are meant to be shared. Payments to the key stay private:
 * memos are sealed with a fresh key each time, so the chain never shows which
 * Gloam address a payment was for.
 */
contract GloamNames {
    uint256 public constant YEAR = 365 days;
    uint256 public constant GRACE_PERIOD = 30 days;
    uint256 public constant MIN_LENGTH = 3;
    uint256 public constant MAX_LENGTH = 20;
    uint256 public constant MAX_YEARS = 10;

    /// @dev P-256 field prime and curve constant b (a = -3).
    uint256 private constant P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff;
    uint256 private constant P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b;

    /// @notice $GLOAM, the token names are paid in.
    address public immutable token;

    address public owner;
    address public pendingOwner;

    /// @notice Where every $GLOAM paid for a name goes: the Gloam treasury.
    address public treasury;

    /// @notice Yearly price in $GLOAM base units for a 3, 4, and 5-or-more character name.
    uint256 public price3;
    uint256 public price4;
    uint256 public price5;

    /// @notice Every $GLOAM paid for names so far.
    uint256 public totalCollected;

    struct Record {
        address holder;
        uint64 expires;
        bytes32 keyX;
        bytes32 keyY;
    }

    /// @dev keccak256(bytes(name)) => record.
    mapping(bytes32 => Record) private records;
    /// @notice A name set aside by the owner, and the one address that may register it.
    mapping(bytes32 => address) public reservedFor;

    event NameRegistered(
        bytes32 indexed node, string name, address indexed holder, bytes32 keyX, bytes32 keyY, uint64 expires, uint256 paid
    );
    event NameRenewed(bytes32 indexed node, uint64 expires, uint256 paid);
    event KeyChanged(bytes32 indexed node, bytes32 keyX, bytes32 keyY);
    event NameTransferred(bytes32 indexed node, address indexed from, address indexed to);
    event NameReserved(bytes32 indexed node, string name, address indexed reservedFor);
    event PricesSet(uint256 price3, uint256 price4, uint256 price5);
    event TreasurySet(address indexed treasury);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotPendingOwner();
    error NotHolder();
    error BadName();
    error BadYears();
    error BadKey();
    error ZeroAddress();
    error NotAvailable();
    error Reserved();
    error NotRegistered();
    error Expired();
    error PaymentFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address token_,
        address owner_,
        address treasury_,
        uint256 price3_,
        uint256 price4_,
        uint256 price5_
    ) {
        if (token_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (token_.code.length == 0) revert ZeroAddress();
        token = token_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        _setTreasury(treasury_);
        _setPrices(price3_, price4_, price5_);
    }

    // ---------------------------------------------------------------- reads

    /// @notice The name's holder, key and expiry. All zero once the grace period
    ///         has passed (the name is free to register again) or if it was never taken.
    function resolve(string calldata name)
        external
        view
        returns (address holder, bytes32 keyX, bytes32 keyY, uint64 expires)
    {
        Record storage r = records[keccak256(bytes(name))];
        if (r.holder == address(0) || block.timestamp > uint256(r.expires) + GRACE_PERIOD) {
            return (address(0), bytes32(0), bytes32(0), 0);
        }
        return (r.holder, r.keyX, r.keyY, r.expires);
    }

    /// @notice Whether `name` is well formed and free for `account` to register now.
    function available(string calldata name, address account) external view returns (bool) {
        if (!validName(name)) return false;
        bytes32 node = keccak256(bytes(name));
        address reserved = reservedFor[node];
        if (reserved != address(0) && reserved != account) return false;
        return _free(records[node]);
    }

    /// @notice What `years_` of `name` costs in $GLOAM base units.
    function priceOf(string calldata name, uint256 years_) public view returns (uint256) {
        uint256 len = bytes(name).length;
        uint256 yearly = len == 3 ? price3 : len == 4 ? price4 : price5;
        return yearly * years_;
    }

    /// @notice 3 to 20 characters, each a to z, 0 to 9 or underscore.
    function validName(string calldata name) public pure returns (bool) {
        bytes calldata b = bytes(name);
        if (b.length < MIN_LENGTH || b.length > MAX_LENGTH) return false;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x5f;
            if (!ok) return false;
        }
        return true;
    }

    /// @notice Whether (x, y) is a point on P-256 (the curve of every Gloam address).
    function validKey(bytes32 keyX, bytes32 keyY) public pure returns (bool) {
        uint256 x = uint256(keyX);
        uint256 y = uint256(keyY);
        if (x >= P256_P || y >= P256_P) return false;
        if (x == 0 && y == 0) return false;
        uint256 lhs = mulmod(y, y, P256_P);
        uint256 rhs = addmod(
            addmod(mulmod(mulmod(x, x, P256_P), x, P256_P), mulmod(x, P256_P - 3, P256_P), P256_P), P256_B, P256_P
        );
        return lhs == rhs;
    }

    // ---------------------------------------------------------------- names

    /**
     * @notice Register `name` for `years_` years, pointing at the Gloam address
     *         key (keyX, keyY), held by `holder`. The caller pays the price in
     *         $GLOAM (approve this contract first), sent to the treasury.
     * @param holder The wallet that may change the key or hand the name on.
     *        It can be any wallet; it never sees payments made to the name.
     */
    function register(string calldata name, bytes32 keyX, bytes32 keyY, address holder, uint256 years_)
        external
        returns (uint64 expires)
    {
        if (!validName(name)) revert BadName();
        if (years_ == 0 || years_ > MAX_YEARS) revert BadYears();
        if (!validKey(keyX, keyY)) revert BadKey();
        if (holder == address(0)) revert ZeroAddress();

        bytes32 node = keccak256(bytes(name));
        address reserved = reservedFor[node];
        if (reserved != address(0) && reserved != msg.sender) revert Reserved();
        Record storage r = records[node];
        if (!_free(r)) revert NotAvailable();

        address previous = r.holder;
        expires = uint64(block.timestamp + years_ * YEAR);
        r.holder = holder;
        r.expires = expires;
        r.keyX = keyX;
        r.keyY = keyY;
        if (reserved != address(0)) delete reservedFor[node];

        uint256 cost = priceOf(name, years_);
        if (previous != address(0)) emit NameTransferred(node, previous, holder);
        emit NameRegistered(node, name, holder, keyX, keyY, expires, cost);
        _collect(msg.sender, cost);
    }

    /// @notice Add `years_` years to a name. Anyone can pay; the caller's $GLOAM goes to the treasury.
    ///         Works until the grace period ends, then the name is open to anyone.
    function renew(string calldata name, uint256 years_) external returns (uint64 expires) {
        if (years_ == 0 || years_ > MAX_YEARS) revert BadYears();
        bytes32 node = keccak256(bytes(name));
        Record storage r = records[node];
        if (r.holder == address(0)) revert NotRegistered();
        if (block.timestamp > uint256(r.expires) + GRACE_PERIOD) revert Expired();
        uint256 newExpiry = uint256(r.expires) + years_ * YEAR;
        // One renewal can never push a name more than MAX_YEARS ahead of today.
        if (newExpiry > block.timestamp + MAX_YEARS * YEAR) revert BadYears();
        expires = uint64(newExpiry);
        r.expires = expires;

        uint256 cost = priceOf(name, years_);
        emit NameRenewed(node, expires, cost);
        _collect(msg.sender, cost);
    }

    /// @notice Point the name at a new Gloam address key. Holder only, while the name is live.
    function setKey(string calldata name, bytes32 keyX, bytes32 keyY) external {
        bytes32 node = keccak256(bytes(name));
        Record storage r = _held(node);
        if (!validKey(keyX, keyY)) revert BadKey();
        r.keyX = keyX;
        r.keyY = keyY;
        emit KeyChanged(node, keyX, keyY);
    }

    /// @notice Hand the name to another wallet. Holder only, while the name is live.
    function transferName(string calldata name, address to) external {
        if (to == address(0)) revert ZeroAddress();
        bytes32 node = keccak256(bytes(name));
        Record storage r = _held(node);
        r.holder = to;
        emit NameTransferred(node, msg.sender, to);
    }

    // ---------------------------------------------------------------- owner

    /// @notice Set the yearly prices in $GLOAM base units. Names already paid for keep their expiry.
    function setPrices(uint256 price3_, uint256 price4_, uint256 price5_) external onlyOwner {
        _setPrices(price3_, price4_, price5_);
    }

    /// @notice Change where name payments go. Payments already made stay where they went.
    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    /**
     * @notice Set a name nobody holds aside for `account`, the only address that
     *         can then register it (paying the normal price). address(0) lifts
     *         the reservation. A name someone holds cannot be reserved.
     */
    function reserve(string calldata name, address account) external onlyOwner {
        if (!validName(name)) revert BadName();
        bytes32 node = keccak256(bytes(name));
        if (!_free(records[node])) revert NotAvailable();
        reservedFor[node] = account;
        emit NameReserved(node, name, account);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ---------------------------------------------------------------- internal

    function _free(Record storage r) private view returns (bool) {
        return r.holder == address(0) || block.timestamp > uint256(r.expires) + GRACE_PERIOD;
    }

    /// @dev The caller's live record (holder and not past expiry).
    function _held(bytes32 node) private view returns (Record storage r) {
        r = records[node];
        if (r.holder != msg.sender) revert NotHolder();
        if (block.timestamp > r.expires) revert Expired();
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function _setPrices(uint256 price3_, uint256 price4_, uint256 price5_) private {
        price3 = price3_;
        price4 = price4_;
        price5 = price5_;
        emit PricesSet(price3_, price4_, price5_);
    }

    /// @dev Move `amount` $GLOAM from `from` straight to the treasury. Accepts
    ///      tokens that return true or nothing; anything else reverts.
    function _collect(address from, uint256 amount) private {
        if (amount == 0) return;
        totalCollected += amount;
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(0x23b872dd, from, treasury, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert PaymentFailed();
    }
}
