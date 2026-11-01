// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Ported from test/AssetIsolation.t.sol to the next vault (not deployed, not audited).
// Keep the two in step until the live vaults are retired.

import {STRAY} from "./NextHarness.sol";
import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore2} from "../../src/ShieldPoolCore2.sol";
import {ShieldPoolPayments2} from "../../src/ShieldPoolPayments2.sol";
import {IVerifier} from "../../src/interfaces/IVerifier.sol";
import {MockERC20} from "../MockERC20.sol";

contract IsolationMockVerifier is IVerifier {
    function verify(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return true;
    }
}

/// Every way a listed token could turn bad. One switch at a time.
contract BadToken {
    enum Mode {
        Plain,
        TakesAFee, // the vault receives less than it was sent
        Paused, // every transfer reverts
        Lies, // balanceOf reports the deposit, nothing moved
        Reenters // transfer calls back into the vault
    }

    uint8 public decimals = 18;
    Mode public mode;
    mapping(address => uint256) internal balances;
    mapping(address => mapping(address => uint256)) public allowance;

    ShieldPoolCore2 public pool;
    address public reenterAsset;
    bytes4 public reenterError;

    function setMode(Mode m) external {
        mode = m;
    }

    function setReentry(ShieldPoolCore2 pool_, address asset) external {
        pool = pool_;
        reenterAsset = asset;
    }

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
    }

    /// A rebase down, a seizure, a hack: the vault's balance simply shrinks.
    function slash(address who, uint256 amount) external {
        balances[who] -= amount;
    }

    function balanceOf(address who) external view returns (uint256) {
        return balances[who];
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        if (mode == Mode.Paused) revert("paused");
        if (mode == Mode.Lies) {
            balances[to] += amount;
            return;
        }
        if (mode == Mode.Reenters) {
            // Any other asset's books, from inside this token's transfer.
            try pool.collectFees(reenterAsset) {} catch (bytes memory e) {
                reenterError = bytes4(e);
            }
        }
        balances[from] -= amount;
        balances[to] += mode == Mode.TakesAFee ? (amount * 99) / 100 : amount;
    }
}

/// A listed token can only ever hurt its own notes: deposited[] and feesOwed[] are
/// per asset, and every path that pays reads only the asset it was asked for. The
/// proof side (a note cannot leave as another asset) runs with real proofs in
/// test/fork/RobinhoodAssetsFork.t.sol. Here the verifier accepts everything, so
/// these show the accounting holds even with that gate open.
contract AssetIsolationTestNext is Test {
    using stdJson for string;

    ShieldPoolPayments2 pool;
    MockERC20 usd;
    BadToken bad;
    address user = makeAddr("user");
    address to = makeAddr("to");
    address treasury = makeAddr("treasury");
    uint256 constant AMT = 1_000e18;
    uint256 salt;

    function setUp() public {
        address verifier = address(new IsolationMockVerifier());
        pool = new ShieldPoolPayments2(_deployPoseidon(), verifier, STRAY);
        pool.setShieldVerifier(verifier);
        pool.setWithdrawFee(25, treasury);
        pool.turnOnDepositLimits();
        usd = new MockERC20();
        bad = new BadToken();
        pool.setDepositLimit(address(usd), type(uint128).max, type(uint128).max);
        pool.setDepositLimit(address(bad), type(uint128).max, type(uint128).max);
        pool.setDepositLimit(address(0), type(uint128).max, type(uint128).max);
        pool.endSetup();
        usd.mint(user, 10 * AMT);
        bad.mint(user, 10 * AMT);
        vm.deal(user, 10 * AMT);
        vm.startPrank(user);
        usd.approve(address(pool), type(uint256).max);
        bad.approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    function _deposit(address asset, uint256 amount) internal {
        vm.prank(user);
        pool.shieldBound{value: asset == address(0) ? amount : 0}(asset, amount, bytes32(++salt), "");
    }

    function _cashOut(address asset, uint256 amount) internal {
        bytes32 root = pool.currentRoot();
        pool.unshield("", root, bytes32(++salt), asset, to, amount);
    }

    function _cashOutRefused(bytes4 reason, address asset, uint256 amount) internal {
        bytes32 root = pool.currentRoot();
        vm.expectRevert(reason);
        pool.unshield("", root, bytes32(++salt), asset, to, amount);
    }

    /// The good asset's note cashes out in full, whatever the bad token did.
    function _goodNoteStillPaysInFull() internal {
        uint256 got = usd.balanceOf(to);
        _cashOut(address(usd), AMT);
        assertEq(usd.balanceOf(to) - got, AMT - (AMT * 25) / 10_000, "paid less the fee");
        assertEq(pool.deposited(address(usd)), 0);
    }

    function test_a_fee_token_is_refused_at_the_door() public {
        bad.setMode(BadToken.Mode.TakesAFee);
        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.FeeOnTransferNotSupported.selector);
        pool.shieldBound(address(bad), AMT, bytes32(uint256(1)), "");
        assertEq(pool.deposited(address(bad)), 0);
        assertEq(pool.nextIndex(), 0, "no note was minted");
    }

    function test_a_slashed_token_shorts_only_itself() public {
        _deposit(address(usd), AMT);
        _deposit(address(bad), AMT);
        bad.slash(address(pool), AMT / 2);

        // Its own note can't get paid out of anyone else's balance.
        _cashOutRefused(ShieldPoolCore2.TransferFailed.selector, address(bad), AMT);
        assertEq(pool.deposited(address(bad)), AMT, "the failed cash out undid itself");
        _goodNoteStillPaysInFull();
    }

    function test_a_paused_token_stops_only_its_own_cash_outs() public {
        _deposit(address(usd), AMT);
        _deposit(address(bad), AMT);
        bad.setMode(BadToken.Mode.Paused);
        _cashOutRefused(ShieldPoolCore2.TransferFailed.selector, address(bad), AMT);
        _goodNoteStillPaysInFull();
    }

    function test_a_lying_token_gets_credit_only_in_itself() public {
        _deposit(address(usd), AMT);
        bad.setMode(BadToken.Mode.Lies);
        _deposit(address(bad), 5 * AMT);
        assertEq(pool.deposited(address(bad)), 5 * AMT, "unbacked credit, in its own book");

        // The book is per asset: the fake credit buys nothing in another asset.
        _cashOutRefused(ShieldPoolCore2.InsufficientPoolBalance.selector, address(usd), 2 * AMT);
        _goodNoteStillPaysInFull();
    }

    function test_a_token_cannot_reach_another_assets_fees_from_its_transfer() public {
        _deposit(address(usd), 2 * AMT);
        _cashOut(address(usd), AMT);
        uint256 owed = pool.feesOwed(address(usd));
        assertGt(owed, 0);
        bad.setReentry(pool, address(usd));
        bad.setMode(BadToken.Mode.Reenters);
        _deposit(address(bad), AMT);
        assertEq(bad.reenterError(), ShieldPoolCore2.Reentrancy.selector, "the latch refused it");
        assertEq(pool.feesOwed(address(usd)), owed, "the other asset's fees did not move");
    }

    function test_a_bad_tokens_fees_never_touch_another_asset() public {
        _deposit(address(usd), AMT);
        _deposit(address(bad), AMT);
        _cashOut(address(bad), AMT);
        bad.setMode(BadToken.Mode.Paused);
        vm.expectRevert(ShieldPoolCore2.TransferFailed.selector);
        pool.collectFees(address(bad));
        assertGt(pool.feesOwed(address(bad)), 0, "still owed");
        _goodNoteStillPaysInFull();
    }

    function test_eth_and_a_bad_token_keep_separate_books() public {
        _deposit(address(0), AMT);
        _deposit(address(bad), AMT);
        bad.slash(address(pool), AMT);
        _cashOutRefused(ShieldPoolCore2.TransferFailed.selector, address(bad), AMT);
        uint256 got = to.balance;
        _cashOut(address(0), AMT);
        assertEq(to.balance - got, AMT - (AMT * 25) / 10_000);
    }

    function _deployPoseidon() internal returns (address addr) {
        bytes memory bytecode = vm.readFile("test/fixtures/Poseidon2.json").readBytes(".bytecode");
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "poseidon deploy failed");
    }
}
