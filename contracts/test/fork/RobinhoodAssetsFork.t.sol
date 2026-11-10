// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// New assets on the LIVE Robinhood Chain vault, on a local fork of it, with the
// real tokens and real proofs (final keys, test/fixtures/robinhood-assets-fork-
// proofs.json, from circuits/scripts/gen-robinhood-assets-fork-proofs.mjs) checked
// by the vault's real verifiers. Nothing is broadcast.
//
// For each asset: its limit goes through the real timelock (or is already live),
// a deposit, a private send, a cash out with the fee, and collectFees to the
// treasury. Each token's own transfer code runs for all of it: the exact-amount
// check on deposit, then the vault's transfer out.
//
// One shim, the same one app/scripts/sim-vault-swap-v2.mts uses: the notes sit on
// a small tree of their own, so its two roots are marked known on the fork
// (one storage slot each). Everything else is the live vault's own state.
//
// The candidates that were dropped from the listing run through the same steps by
// name, so the vetting report says what each one really does, not just the ones
// that made it. Off by default (it reads mainnet over RPC). From contracts/:
//   RH_FORK=1 forge test --evm-version cancun --match-path test/fork/RobinhoodAssetsFork.t.sol -vv
//
// Written while the ETH, AI and ORBIO limits and the 0.50% fee were still queued.
// Both landed on 3 Nov 2026, so at the head the four tests that expect "no limit
// yet" fail (before_the_limit_lands, listed_assets_at_todays_fee,
// every_listed_asset_at_the_queued_fee, sweep_cannot_touch_eth_notes); the other
// seven pass. Robinhood Chain's public RPC keeps no old state, so replaying them
// needs an archive RPC in RH_FORK_URL and the fork pinned to a block from before
// (e.g. 102717200, 31 Oct 2026), which setUp does not do today.

import {Test, console2} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore} from "../../src/ShieldPoolCore.sol";
import {ShieldPoolPayments} from "../../src/ShieldPoolPayments.sol";
import {ChangeTimelock} from "../../src/lib/ChangeTimelock.sol";
import {QueueRobinhoodAssets} from "../../script/archive/QueueRobinhoodAssets.s.sol";

interface IERC20F {
    function approve(address spender, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address who) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
}

contract RobinhoodAssetsForkTest is Test {
    using stdJson for string;

    ShieldPoolPayments constant VAULT = ShieldPoolPayments(payable(0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194));
    address constant OWNER = 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8;
    address constant TREASURY = 0xB3900ac9350903218e4c7597bAb0f008F01B30B8;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// @dev Uniswap v4's PoolManager holds some of every token here: the test's source of them.
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    /// @dev The vault's tree sits at slot 4 and its knownRoots mapping 42 slots in (forge inspect).
    uint256 constant KNOWN_ROOTS_SLOT = 46;

    string fx;
    address payer = makeAddr("payer");
    address relayer = makeAddr("relayer");
    address recipient;

    function setUp() public {
        if (!vm.envOr("RH_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("RH_FORK_URL", string("https://rpc.mainnet.chain.robinhood.com")));
        assertEq(block.chainid, 4663, "a Robinhood Chain fork");
        fx = vm.readFile("test/fixtures/robinhood-assets-fork-proofs.json");
        recipient = fx.readAddress(".recipient");
    }

    function _key(string memory symbol, string memory field) internal pure returns (string memory) {
        return string.concat(".assets.", symbol, field);
    }

    function _balance(address asset, address who) internal view returns (uint256) {
        return asset == address(0) ? who.balance : IERC20F(asset).balanceOf(who);
    }

    /// One asset's fixture and the books before it runs.
    struct Case {
        string s;
        address asset;
        uint256 amount;
        uint256 payment;
        uint256 fee;
        uint256 vaultStart;
        uint256 depositedStart;
        uint256 feesStart;
    }

    function _case(string memory s) internal view returns (Case memory c) {
        c.s = s;
        c.asset = fx.readAddress(_key(s, ".address"));
        c.amount = fx.readUint(_key(s, ".amount"));
        c.payment = fx.readUint(_key(s, ".payment"));
        uint256 bps = VAULT.withdrawFeeBps();
        c.fee = (c.payment / 10_000) * bps + ((c.payment % 10_000) * bps) / 10_000;
        c.vaultStart = _balance(c.asset, address(VAULT));
        c.depositedStart = VAULT.deposited(c.asset);
        c.feesStart = VAULT.feesOwed(c.asset);
    }

    /// Deposit, for the exact amount, with an exact approval.
    function _deposit(Case memory c) internal {
        bytes memory proof = fx.readBytes(_key(c.s, ".shield.proof"));
        bytes32 commitment = fx.readBytes32(_key(c.s, ".shield.commitment"));
        if (c.asset == address(0)) {
            vm.deal(payer, c.amount);
            vm.prank(payer);
            VAULT.shieldBound{value: c.amount}(c.asset, c.amount, commitment, proof);
        } else {
            vm.prank(POOL_MANAGER);
            IERC20F(c.asset).transfer(payer, c.amount);
            assertEq(IERC20F(c.asset).balanceOf(payer), c.amount, string.concat(c.s, ": a plain transfer pays the exact amount"));
            vm.startPrank(payer);
            IERC20F(c.asset).approve(address(VAULT), c.amount);
            VAULT.shieldBound(c.asset, c.amount, commitment, proof);
            vm.stopPrank();
            assertEq(IERC20F(c.asset).allowance(payer, address(VAULT)), 0, string.concat(c.s, ": approval used up"));
        }
        assertEq(VAULT.deposited(c.asset) - c.depositedStart, c.amount, string.concat(c.s, ": deposited counts it"));
        assertEq(_balance(c.asset, address(VAULT)) - c.vaultStart, c.amount, string.concat(c.s, ": the vault holds it"));
    }

    /// A private send: nothing leaves, deposited does not move.
    function _send(Case memory c) internal {
        // The small tree's two roots, on the fork only.
        for (uint256 i = 0; i < 2; i++) {
            bytes32 root = fx.readBytes32(_key(c.s, i == 0 ? ".send.root" : ".cashOut.root"));
            vm.store(address(VAULT), keccak256(abi.encode(uint256(root), KNOWN_ROOTS_SLOT)), bytes32(uint256(1)));
            assertTrue(VAULT.isKnownRoot(root));
        }
        bytes32[2] memory outs = [fx.readBytes32(_key(c.s, ".send.payment")), fx.readBytes32(_key(c.s, ".send.change"))];
        vm.prank(relayer);
        VAULT.transfer(fx.readBytes(_key(c.s, ".send.proof")), fx.readBytes32(_key(c.s, ".send.root")), fx.readBytes32(_key(c.s, ".send.nullifier")), outs);
        assertEq(VAULT.deposited(c.asset) - c.depositedStart, c.amount, string.concat(c.s, ": a send moves nothing"));
    }

    function _unshield(Case memory c) internal {
        vm.prank(relayer);
        VAULT.unshield(fx.readBytes(_key(c.s, ".cashOut.proof")), fx.readBytes32(_key(c.s, ".cashOut.root")), fx.readBytes32(_key(c.s, ".cashOut.nullifier")), c.asset, recipient, c.payment);
    }

    /// Cash out the payment: the recipient gets it less the fee, the fee stays owed until collected.
    function _cashOut(Case memory c) internal {
        uint256 gotBefore = _balance(c.asset, recipient);
        _unshield(c);
        assertEq(_balance(c.asset, recipient) - gotBefore, c.payment - c.fee, string.concat(c.s, ": the amount less the fee"));
        assertEq(VAULT.deposited(c.asset) - c.depositedStart, c.amount - c.payment, string.concat(c.s, ": the change stays"));
        assertEq(VAULT.feesOwed(c.asset) - c.feesStart, c.fee, string.concat(c.s, ": fee owed"));

        // Fees go to the treasury only, in full.
        uint256 treasuryBefore = _balance(c.asset, TREASURY);
        VAULT.collectFees(c.asset);
        assertEq(_balance(c.asset, TREASURY) - treasuryBefore, c.fee + c.feesStart, string.concat(c.s, ": fee collected"));
        assertEq(VAULT.feesOwed(c.asset), 0);
    }

    /// One asset through the live vault: deposit, private send, cash out, fees.
    function _throughTheVault(string memory s) internal {
        Case memory c = _case(s);
        uint256 usdgDeposited = VAULT.deposited(USDG);
        uint256 usdgHeld = IERC20F(USDG).balanceOf(address(VAULT));

        _deposit(c);
        _send(c);
        _cashOut(c);

        // Solvency on this asset, and no other asset noticed.
        assertGe(_balance(c.asset, address(VAULT)), VAULT.deposited(c.asset) + VAULT.feesOwed(c.asset), string.concat(s, ": backed"));
        assertEq(_balance(c.asset, address(VAULT)) + c.feesStart - c.vaultStart, c.amount - c.payment, string.concat(s, ": only the change is added"));
        assertEq(VAULT.deposited(USDG), usdgDeposited, "USDG's books untouched");
        assertEq(IERC20F(USDG).balanceOf(address(VAULT)), usdgHeld, "USDG's balance untouched");

        // A spent note is refused.
        vm.expectRevert(ShieldPoolCore.AlreadySpent.selector);
        _unshield(c);

        console2.log(s, "through the vault; fee bps, fee:", VAULT.withdrawFeeBps(), c.fee);
    }

    /// Queue every listed limit through the real timelock, and land them 3 days later.
    function _landTheLimits() internal {
        QueueRobinhoodAssets q = new QueueRobinhoodAssets();
        QueueRobinhoodAssets.Asset[] memory a = q.assets();
        for (uint256 i = 0; i < a.length; i++) {
            (uint128 per, uint128 total) = VAULT.depositLimit(a[i].token);
            assertEq(per, 0, string.concat(a[i].symbol, ": no limit yet"));
            assertEq(total, 0);
            bytes memory call_ = q.changeCall(a[i]);
            assertEq(VAULT.changeEta(keccak256(call_)), 0, "nothing queued for it already");

            // Not the owner: refused. The owner: queued.
            vm.prank(relayer);
            vm.expectRevert(ShieldPoolCore.NotOwner.selector);
            VAULT.queueChange(call_);
            vm.prank(OWNER);
            VAULT.queueChange(call_);
            vm.prank(OWNER);
            vm.expectRevert(ChangeTimelock.ChangeNotReady.selector);
            VAULT.executeChange(call_);
        }
        vm.warp(block.timestamp + 3 days + 1);
        for (uint256 i = 0; i < a.length; i++) {
            bytes memory call_ = q.changeCall(a[i]);
            vm.prank(OWNER);
            VAULT.executeChange(call_);
            (uint128 per, uint128 total) = VAULT.depositLimit(a[i].token);
            assertEq(per, a[i].perDeposit);
            assertEq(total, a[i].total);
        }
    }

    /// The queued 0.50% cash-out fee, landed on the fork.
    function _landTheFee() internal {
        bytes memory call_ = abi.encodeCall(ShieldPoolCore.setWithdrawFee, (50, TREASURY));
        uint256 eta = VAULT.changeEta(keccak256(call_));
        assertGt(eta, 0, "the 0.50% fee is queued");
        if (block.timestamp < eta) vm.warp(eta + 1);
        vm.prank(OWNER);
        VAULT.executeChange(call_);
        assertEq(VAULT.withdrawFeeBps(), 50);
    }

    function test_fork_before_the_limit_lands_the_vault_refuses() public {
        string[3] memory listed = ["ETH", "AI", "ORBIO"];
        for (uint256 i = 0; i < listed.length; i++) {
            address asset = fx.readAddress(_key(listed[i], ".address"));
            uint256 amount = fx.readUint(_key(listed[i], ".amount"));
            bytes memory proof = fx.readBytes(_key(listed[i], ".shield.proof"));
            bytes32 commitment = fx.readBytes32(_key(listed[i], ".shield.commitment"));
            vm.deal(payer, amount);
            vm.prank(payer);
            vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector);
            VAULT.shieldBound{value: asset == address(0) ? amount : 0}(asset, amount, commitment, proof);
        }
    }

    /// PONS and CASHCAT are open on the live vault today: no timelock step at all.
    function test_fork_open_today_at_todays_fee() public {
        _throughTheVault("PONS");
        _throughTheVault("CASHCAT");
    }

    function test_fork_listed_assets_at_todays_fee() public {
        _landTheLimits();
        _throughTheVault("ETH");
        _throughTheVault("AI");
        _throughTheVault("ORBIO");
    }

    /// The same with the 0.50% fee queued for 3 Nov landed first.
    function test_fork_every_listed_asset_at_the_queued_fee() public {
        _landTheLimits();
        _landTheFee();
        _throughTheVault("ETH");
        _throughTheVault("PONS");
        _throughTheVault("CASHCAT");
        _throughTheVault("AI");
        _throughTheVault("ORBIO");
    }

    /// The asset is a public input of the cash-out proof: a note can't leave as another asset.
    function test_fork_a_note_cannot_leave_as_another_asset() public {
        Case memory c = _case("PONS");
        address other = fx.readAddress(_key("CASHCAT", ".address"));
        uint256 cashcatHeld = IERC20F(other).balanceOf(address(VAULT));
        _deposit(c);
        _send(c);
        vm.prank(relayer);
        vm.expectRevert(ShieldPoolCore.InvalidProof.selector);
        VAULT.unshield(fx.readBytes(_key("PONS", ".cashOut.proof")), fx.readBytes32(_key("PONS", ".cashOut.root")), fx.readBytes32(_key("PONS", ".cashOut.nullifier")), other, recipient, c.payment);
        assertEq(IERC20F(other).balanceOf(address(VAULT)), cashcatHeld);
    }

    /// ETH's stray sweep still cannot reach notes or owed fees once ETH is listed.
    function test_fork_sweep_cannot_touch_eth_notes() public {
        _landTheLimits();
        string memory s = "ETH";
        uint256 amount = fx.readUint(_key(s, ".amount"));
        vm.deal(payer, amount);
        vm.prank(payer);
        VAULT.shieldBound{value: amount}(address(0), amount, fx.readBytes32(_key(s, ".shield.commitment")), fx.readBytes(_key(s, ".shield.proof")));
        vm.prank(OWNER);
        vm.expectRevert(ShieldPoolCore.NothingToSweep.selector);
        VAULT.sweepStrayNative(OWNER);

        // ETH sent straight to the vault backs no note: only that much can be swept.
        vm.deal(payer, 1 ether);
        vm.prank(payer);
        (bool ok, ) = address(VAULT).call{value: 1 ether}("");
        assertTrue(ok);
        uint256 before = OWNER.balance;
        vm.prank(OWNER);
        VAULT.sweepStrayNative(OWNER);
        assertEq(OWNER.balance - before, 1 ether);
        assertEq(address(VAULT).balance, amount, "the note's ETH stays");
    }

    /// The candidates left off the list, with a limit forced on the fork, so the report has facts on them.
    function _dropped(string memory s) internal {
        address asset = fx.readAddress(_key(s, ".address"));
        (uint128 per, ) = VAULT.depositLimit(asset);
        assertEq(per, 0, "not open on the live vault");
        bytes memory call_ = abi.encodeCall(ShieldPoolCore.setDepositLimit, (asset, type(uint128).max, type(uint128).max));
        vm.prank(OWNER);
        VAULT.queueChange(call_);
        vm.warp(block.timestamp + 3 days + 1);
        vm.prank(OWNER);
        VAULT.executeChange(call_);
        _throughTheVault(s);
    }

    function test_fork_dropped_WALLET() public {
        _dropped("WALLET");
    }

    function test_fork_dropped_INU() public {
        _dropped("INU");
    }

    function test_fork_dropped_BOOMER() public {
        _dropped("BOOMER");
    }

    function test_fork_dropped_WORM() public {
        _dropped("WORM");
    }

    function test_fork_dropped_DARK() public {
        _dropped("DARK");
    }
}
