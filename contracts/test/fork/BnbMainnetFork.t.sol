// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// The BNB Chain runbook (DEPLOY-BNB.md) on a local fork of BNB Smart Chain mainnet,
// with the real tokens and the real Safe factory:
//   1. the Gloam Owner Safe is replayed from its exact creation calldata
//      (test/fixtures/bnb-safe-replay.json) and lands at 0x8E74...5507 with its
//      three signers and threshold 2;
//   2. PoseidonT3 and DeployBnbMainnet run from the planned deployer
//      0xec99...6b60 at its live nonce 0 (no key) with bnb-mainnet-env.sh's
//      default settings: everything lands at Elysium's addresses, the vault is
//      born guarded and the Safe is offered the guard, then accepts;
//   3. real USDT (18 decimals), BDX (9) and BNB go through the vault with proofs
//      made with the ceremony's final keys (test/fixtures/bnb-fork-proofs.json,
//      from circuits/scripts/gen-bnb-fork-proofs.mjs): a deposit of each, a
//      private send of 60 USDT, and a cash out of each with the 0.5% fee
//      collected for the treasury. BDX over its cap is refused.
//
// Off by default (it reads mainnet over RPC). Run on its own, since the deploy
// settings travel in env vars, from contracts/:
//   BNB_FORK=1 forge test --match-path test/fork/BnbMainnetFork.t.sol -vv
// BNB_FORK_URL picks the RPC (default BNB Chain's own dataseed, which serves state
// at the head; the test pins one block and reads it within a minute or two).

import {Test, console2} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore} from "../../src/ShieldPoolCore.sol";
import {ShieldPoolPayments} from "../../src/ShieldPoolPayments.sol";
import {VaultOwnerGuard} from "../../src/VaultOwnerGuard.sol";
import {DeployBnbMainnet} from "../../script/DeployBnbMainnet.s.sol";

interface IERC20Full {
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface ISafe {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function nonce() external view returns (uint256);
}

interface IOft {
    function token() external view returns (address);
}

contract BnbMainnetForkTest is Test {
    using stdJson for string;

    address constant DEPLOYER = 0xec9993765e249e8e9DC677B7BCB61F78b31c6b60;
    address constant TREASURY = 0xB3900ac9350903218e4c7597bAb0f008F01B30B8;
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address constant BDX = 0x6ad12E761b438beA3EA09F6C6266556Bb24C2181;
    address constant SAFE = 0x8E74b2b85b40f36771f92392b42BBaeacDC75507;
    address constant PLANNED_POSEIDON = 0x62c435CE6886fa91e3b0e91500c6dC9219723457;
    address constant PLANNED_POOL = 0x89d3042390204f57b8b4F8949D3c2203E4002164;
    uint128 constant MAX = type(uint128).max;

    ShieldPoolPayments pool;
    VaultOwnerGuard guard;
    string fx;
    address payer = makeAddr("payer");
    address relayer = makeAddr("relayer");

    function setUp() public {
        if (!vm.envOr("BNB_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("BNB_FORK_URL", string("https://bsc-dataseed.bnbchain.org")));
        assertEq(block.chainid, 56, "a BNB Smart Chain mainnet fork");
        fx = vm.readFile("test/fixtures/bnb-fork-proofs.json");

        // Step 1: the Safe, replayed from its creation calldata by anyone.
        string memory safeFx = vm.readFile("test/fixtures/bnb-safe-replay.json");
        assertEq(SAFE.code.length, 0, "no Safe on BNB Chain yet");
        (bool ok, bytes memory ret) = safeFx.readAddress(".factory").call(safeFx.readBytes(".calldata"));
        assertTrue(ok, "the factory takes the replay");
        assertEq(abi.decode(ret, (address)), SAFE, "the Safe at its address on the other chains");

        // Step 4: PoseidonT3 is the planned deployer's first transaction.
        assertEq(vm.getNonce(DEPLOYER), 0, "the planned deployer is fresh on BNB Chain");
        bytes memory bytecode = vm.readFile("test/fixtures/Poseidon2.json").readBytes(".bytecode");
        address poseidon;
        vm.prank(DEPLOYER);
        assembly {
            poseidon := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        assertEq(poseidon, PLANNED_POSEIDON, "PoseidonT3 at Elysium's address");

        // bnb-mainnet-env.sh's defaults, from the deployer with no key.
        vm.setEnv("DEPLOYER", vm.toString(DEPLOYER));
        vm.setEnv("DEPLOYER_PK", "");
        vm.setEnv("POSEIDON2", vm.toString(poseidon));
        vm.setEnv(
            "LIMIT_ASSETS",
            string.concat(vm.toString(USDT), ",", vm.toString(USDC), ",", vm.toString(address(0)), ",", vm.toString(BDX))
        );
        string memory max = vm.toString(uint256(MAX));
        vm.setEnv("LIMIT_PER_DEPOSIT", string.concat(max, ",", max, ",", max, ",100000000000000"));
        vm.setEnv("LIMIT_TOTAL", string.concat(max, ",", max, ",", max, ",2000000000000000"));
        vm.setEnv("WITHDRAW_FEE_BPS", "50");
        vm.setEnv("FEE_RECIPIENT", vm.toString(TREASURY));
        vm.setEnv("NEW_OWNER", "");
        vm.setEnv("GUARD_CONTROLLER", vm.toString(SAFE));
        vm.setEnv("GUARD_CONTROLLER_EOA", "0");
        vm.setEnv("BNB_ALLOW_OTHER_ASSETS", "0");
        vm.setEnv("GLOAM_ALLOW_REDEPLOY", "0");
        new DeployBnbMainnet().run();
        pool = ShieldPoolPayments(payable(PLANNED_POOL));
        guard = VaultOwnerGuard(pool.owner());

        // Step 7: the Safe accepts (on chain: a Safe transaction to the guard, data 0x9bc21c0c).
        vm.prank(SAFE);
        guard.acceptController();
    }

    function test_safe_replay_and_guarded_deploy() public view {
        address[] memory owners = ISafe(SAFE).getOwners();
        assertEq(owners.length, 3);
        assertEq(owners[0], 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8);
        assertEq(owners[1], 0x0b827E40443579391F7Df83A563A276Ce8d8C4df);
        assertEq(owners[2], 0xf9B744fC1E018bf82Dc84Be7A9AD2b34A2DeD3d7);
        assertEq(ISafe(SAFE).getThreshold(), 2, "2 of 3");
        assertEq(ISafe(SAFE).nonce(), 0, "a fresh Safe: nonce 0 on this chain");

        assertEq(address(pool).code.length > 0, true, "the vault at Elysium's address");
        assertEq(keccak256(address(pool).code), 0x6c08d853f894304930eb234dac17256cdbe0bf1141c3c0df2ef61690603c629d, "vault code = Elysium's");
        assertTrue(pool.depositLimitsOn());
        assertFalse(pool.setupMode());
        assertEq(pool.withdrawFeeBps(), 50);
        assertEq(pool.feeRecipient(), TREASURY);
        assertEq(address(guard.vault()), address(pool));
        assertEq(guard.controller(), SAFE, "the Safe runs the guard");
        assertEq(guard.pendingController(), address(0));

        // The real tokens: what the env script reads and the limits it sets.
        assertEq(IERC20Full(USDT).decimals(), 18, "USDT has 18 decimals on BNB Chain");
        assertEq(IERC20Full(USDC).decimals(), 18, "USDC has 18 decimals on BNB Chain");
        assertEq(IERC20Full(BDX).decimals(), 9, "BDX has 9");
        assertEq(IOft(BDX).token(), BDX, "BDX is the OFT itself");
        address[3] memory open = [USDT, USDC, address(0)];
        for (uint256 i = 0; i < open.length; i++) {
            (uint128 per, uint128 total) = pool.depositLimit(open[i]);
            assertEq(per, MAX);
            assertEq(total, MAX);
        }
        (uint128 bper, uint128 btotal) = pool.depositLimit(BDX);
        assertEq(bper, 100_000e9);
        assertEq(btotal, 2_000_000e9);
    }

    function test_usdt_bdx_and_bnb_through_the_vault() public {
        address recipient = fx.readAddress(".recipient");
        deal(USDT, payer, 1_000e18);
        deal(BDX, payer, 200_000e9);
        vm.deal(payer, 1 ether);
        assertEq(IERC20Full(USDT).balanceOf(payer), 1_000e18, "deal works on BNB Chain's USDT");
        assertEq(IERC20Full(BDX).balanceOf(payer), 200_000e9, "deal works on the BDX OFT");

        // Deposits: exact approvals, a proof each.
        vm.startPrank(payer);
        IERC20Full(USDT).approve(address(pool), 100e18);
        uint256 g = gasleft();
        pool.shieldBound(USDT, fx.readUint(".shieldUsdt.amount"), fx.readBytes32(".shieldUsdt.commitment"), fx.readBytes(".shieldUsdt.proof"));
        console2.log("gas: deposit USDT", g - gasleft());
        IERC20Full(BDX).approve(address(pool), 1_000e9);
        g = gasleft();
        pool.shieldBound(BDX, fx.readUint(".shieldBdx.amount"), fx.readBytes32(".shieldBdx.commitment"), fx.readBytes(".shieldBdx.proof"));
        console2.log("gas: deposit BDX", g - gasleft());
        g = gasleft();
        pool.shieldBound{value: 0.01 ether}(address(0), fx.readUint(".shieldBnb.amount"), fx.readBytes32(".shieldBnb.commitment"), fx.readBytes(".shieldBnb.proof"));
        console2.log("gas: deposit BNB", g - gasleft());
        vm.stopPrank();
        assertEq(pool.deposited(USDT), 100e18);
        assertEq(pool.deposited(BDX), 1_000e9);
        assertEq(pool.deposited(address(0)), 0.01 ether);
        assertEq(IERC20Full(USDT).allowance(payer, address(pool)), 0, "exact approval used up");

        // BDX over its 100,000 cap is refused, with a valid proof for the amount.
        vm.startPrank(payer);
        IERC20Full(BDX).approve(address(pool), 100_001e9);
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector);
        pool.shieldBound(
            BDX, fx.readUint(".shieldBdxOverCap.amount"), fx.readBytes32(".shieldBdxOverCap.commitment"), fx.readBytes(".shieldBdxOverCap.proof")
        );
        IERC20Full(BDX).approve(address(pool), 0);
        vm.stopPrank();

        // A private send from the relay: 60 USDT paid, 40 back as change.
        bytes32 sendRoot = fx.readBytes32(".send.root");
        assertTrue(pool.isKnownRoot(sendRoot), "the vault's root matches the off-chain tree");
        bytes32[2] memory outs = [fx.readBytes32(".send.payment"), fx.readBytes32(".send.change")];
        g = gasleft();
        vm.prank(relayer);
        pool.transfer(fx.readBytes(".send.proof"), sendRoot, fx.readBytes32(".send.nullifier"), outs);
        console2.log("gas: private send", g - gasleft());

        // Cash outs from the relay: the recipient gets each amount less 0.5%.
        bytes32 root = fx.readBytes32(".cashOutUsdt.root");
        g = gasleft();
        vm.prank(relayer);
        pool.unshield(fx.readBytes(".cashOutUsdt.proof"), root, fx.readBytes32(".cashOutUsdt.nullifier"), USDT, recipient, 60e18);
        console2.log("gas: cash out USDT", g - gasleft());
        assertEq(IERC20Full(USDT).balanceOf(recipient), 60e18 - 0.3e18, "60 USDT less the 0.5% fee");
        assertEq(pool.deposited(USDT), 40e18, "the change stays in the vault");

        vm.prank(relayer);
        pool.unshield(fx.readBytes(".cashOutBdx.proof"), root, fx.readBytes32(".cashOutBdx.nullifier"), BDX, recipient, 1_000e9);
        assertEq(IERC20Full(BDX).balanceOf(recipient), 1_000e9 - 5e9, "1,000 BDX less 0.5%");

        g = gasleft();
        vm.prank(relayer);
        pool.unshield(fx.readBytes(".cashOutBnb.proof"), root, fx.readBytes32(".cashOutBnb.nullifier"), address(0), recipient, 0.01 ether);
        console2.log("gas: cash out BNB", g - gasleft());
        assertEq(recipient.balance, 0.01 ether - 0.00005 ether, "0.01 BNB less 0.5%");

        // Fees go to the treasury only, in full.
        uint256 before = IERC20Full(USDT).balanceOf(TREASURY);
        pool.collectFees(USDT);
        assertEq(IERC20Full(USDT).balanceOf(TREASURY) - before, 0.3e18);
        before = IERC20Full(BDX).balanceOf(TREASURY);
        pool.collectFees(BDX);
        assertEq(IERC20Full(BDX).balanceOf(TREASURY) - before, 5e9);
        before = TREASURY.balance;
        pool.collectFees(address(0));
        assertEq(TREASURY.balance - before, 0.00005 ether);
        assertEq(IERC20Full(USDT).balanceOf(address(pool)), 40e18, "exactly the change is left");

        // A spent note is refused.
        vm.prank(relayer);
        vm.expectRevert();
        pool.unshield(fx.readBytes(".cashOutUsdt.proof"), root, fx.readBytes32(".cashOutUsdt.nullifier"), USDT, recipient, 60e18);
    }

    /// The Safe closes a listing at once in an incident, and a raise waits 3 days.
    function test_safe_runs_limits_through_the_guard() public {
        vm.prank(SAFE);
        guard.lowerDepositLimit(USDT, 0, 0);
        (uint128 per,) = pool.depositLimit(USDT);
        assertEq(per, 0, "USDT closed at once");
        bytes memory raise = abi.encodeCall(ShieldPoolCore.setDepositLimit, (USDT, MAX, MAX));
        vm.prank(SAFE);
        guard.queueChange(raise);
        vm.prank(SAFE);
        vm.expectRevert();
        guard.executeChange(raise);
        vm.warp(block.timestamp + 3 days + 1);
        vm.prank(SAFE);
        guard.executeChange(raise);
        (per,) = pool.depositLimit(USDT);
        assertEq(per, MAX, "open again after the timelock");
        // Never a proof checker.
        vm.prank(SAFE);
        vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
        guard.queueChange(abi.encodeCall(ShieldPoolCore.setVerifier, (address(0xBAD))));
    }
}
