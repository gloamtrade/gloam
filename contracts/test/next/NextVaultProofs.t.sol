// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore2} from "../../src/ShieldPoolCore2.sol";
import {ShieldPoolPayments2} from "../../src/ShieldPoolPayments2.sol";
import {ShieldPoolCore} from "../../src/ShieldPoolCore.sol";
import {ShieldPoolPayments} from "../../src/ShieldPoolPayments.sol";
import {IVerifier} from "../../src/interfaces/IVerifier.sol";
import {DualProofVerifier} from "../../src/verifiers/DualProofVerifier.sol";
import {DualProofVerifier2} from "../../src/verifiers/DualProofVerifier2.sol";
import {ShieldVerifierFinal} from "../../src/verifiers/final/ShieldVerifierFinal.sol";
import {ShieldIVerifierFinal} from "../../src/verifiers/final/ShieldIVerifierFinal.sol";
import {UnshieldVerifierFinal} from "../../src/verifiers/final/UnshieldVerifierFinal.sol";
import {UnshieldIVerifierFinal} from "../../src/verifiers/final/UnshieldIVerifierFinal.sol";
import {TransferVerifierFinal} from "../../src/verifiers/final/TransferVerifierFinal.sol";
import {TransferIVerifierFinal} from "../../src/verifiers/final/TransferIVerifierFinal.sol";
import {MockERC20} from "../MockERC20.sol";

/// What the two vaults share, so one story runs on both.
interface IPool {
    function shieldBound(address asset, uint256 amount, bytes32 commitment, bytes calldata proof) external payable;

    function transfer(bytes calldata proof, bytes32 root, bytes32 nullifier, bytes32[2] calldata newCommitments) external;

    function unshield(bytes calldata proof, bytes32 root, bytes32 nullifier, address asset, address to, uint256 amount) external;

    function currentRoot() external view returns (bytes32);

    function isKnownRoot(bytes32 root) external view returns (bool);

    function deposited(address asset) external view returns (uint256);

    function feesOwed(address asset) external view returns (uint256);

    function nextIndex() external view returns (uint256);
}

contract AcceptEverything is IVerifier {
    function verify(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return true;
    }
}

/**
 * Real Groth16 proofs made with the ceremony's final keys
 * (test/fixtures/next-vault-proofs.json, circuits/scripts/gen-next-vault-proofs.mjs)
 * on the final verifiers, against the live vault's source and the next vault side
 * by side. The same proofs pass on both, and a floored cash-out passes the same
 * unshield verifier with no circuit change. Also the gas comparison: every number
 * is one isolated transaction, from the same proofs, on an empty tree.
 *
 *   forge test --match-contract NextVaultProofsTest -vv
 */
contract NextVaultProofsTest is Test {
    using stdJson for string;

    address constant TREASURY = address(0x7EA5);
    address constant STRAY = address(0x57A7);

    string fx;
    address asset;
    address recipient;
    address payer = makeAddr("payer");
    address relayer = makeAddr("relayer");

    ShieldPoolPayments live;
    ShieldPoolPayments2 next;
    address poseidon2;

    function setUp() public {
        fx = vm.readFile("test/fixtures/next-vault-proofs.json");
        asset = fx.readAddress(".asset");
        recipient = fx.readAddress(".recipient");
        vm.etch(asset, address(new MockERC20()).code);
        MockERC20(asset).mint(payer, 1_000_000e6);
        poseidon2 = _deployPoseidon();

        ShieldIVerifierFinal s = new ShieldIVerifierFinal(new ShieldVerifierFinal());
        UnshieldIVerifierFinal u = new UnshieldIVerifierFinal(new UnshieldVerifierFinal());
        TransferIVerifierFinal t = new TransferIVerifierFinal(new TransferVerifierFinal());

        live = new ShieldPoolPayments(poseidon2, address(new DualProofVerifier(u, t)));
        next = new ShieldPoolPayments2(poseidon2, address(new DualProofVerifier2(u, t)), STRAY);
        _configure(address(live), address(s));
        _configure(address(next), address(s));
        live.endSetup();
        next.endSetup();
    }

    function _configure(address p, address shieldV) internal {
        ShieldPoolPayments pool = ShieldPoolPayments(payable(p)); // same setup ABI on both
        pool.turnOnDepositLimits();
        pool.setShieldVerifier(shieldV);
        pool.setDepositLimit(asset, 1_000_000e6, 10_000_000e6);
        pool.setWithdrawFee(25, TREASURY);
        vm.prank(payer);
        MockERC20(asset).approve(p, type(uint256).max);
    }

    // ───────────────────────────────────────────────────────────── the proofs

    function test_final_key_proofs_pass_on_both_vaults_and_end_the_same() public {
        _story(IPool(address(live)));
        _story(IPool(address(next)));
        assertEq(live.currentRoot(), next.currentRoot(), "same tree");
        assertEq(live.nextIndex(), next.nextIndex());
        assertEq(live.deposited(asset), next.deposited(asset));
        assertEq(live.feesOwed(asset), next.feesOwed(asset));
    }

    function test_a_floored_proof_passes_the_unchanged_verifier() public {
        _story(IPool(address(next)));
        uint256 amount = fx.readUint(".floored.amount");
        uint256 floor = fx.readUint(".floored.minReceived");
        assertEq(next.recipientInput(recipient, floor), fx.readUint(".floored.recipientInput"), "same hash as the prover");

        next.lowerWithdrawFee(25);
        uint256 before = MockERC20(asset).balanceOf(recipient);
        vm.prank(relayer);
        next.unshield(
            fx.readBytes(".floored.proof"),
            fx.readBytes32(".floored.root"),
            fx.readBytes32(".floored.nullifier"),
            asset,
            recipient,
            amount,
            floor
        );
        assertEq(MockERC20(asset).balanceOf(recipient) - before, amount - (amount * 25) / 10_000);
    }

    function test_a_real_floored_proof_holds_when_the_fee_rises() public {
        _story(IPool(address(next)));
        bytes memory proof = fx.readBytes(".tight.proof");
        bytes32 root = fx.readBytes32(".tight.root");
        bytes32 nullifier = fx.readBytes32(".tight.nullifier");
        uint256 amount = fx.readUint(".tight.amount");
        uint256 floor = fx.readUint(".tight.minReceived");

        // 0.5%, queued while the proof waits
        bytes memory call_ = abi.encodeCall(ShieldPoolCore2.setWithdrawFee, (50, TREASURY));
        (, uint256 eta) = next.queueChange(call_);
        vm.warp(eta);
        next.executeChange(call_);

        uint256 at50 = amount - (amount * 50) / 10_000;
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ShieldPoolCore2.BelowMinReceived.selector, at50, floor));
        next.unshield(proof, root, nullifier, asset, recipient, amount, floor);

        // A copy of the real proof cannot go out with the floor removed or lowered.
        vm.prank(relayer);
        vm.expectRevert(ShieldPoolCore2.InvalidProof.selector);
        next.unshield(proof, root, nullifier, asset, recipient, amount);
        vm.prank(relayer);
        vm.expectRevert(ShieldPoolCore2.InvalidProof.selector);
        next.unshield(proof, root, nullifier, asset, recipient, amount, at50);
        assertFalse(next.isSpent(nullifier));

        // The fee back at 0.25%, the same proof lands.
        next.lowerWithdrawFee(25);
        uint256 before = MockERC20(asset).balanceOf(recipient);
        vm.prank(relayer);
        next.unshield(proof, root, nullifier, asset, recipient, amount, floor);
        assertEq(MockERC20(asset).balanceOf(recipient) - before, floor);
        assertTrue(next.isSpent(nullifier));
    }

    // ───────────────────────────────────────────────────────────── gas

    /// forge-config: default.isolate = true
    function test_gas_real_proofs_live_vs_next() public {
        // from the same state: a recipient already holding the token is a cheaper write
        uint256 start = vm.snapshotState();
        uint256[] memory a = _measured(IPool(address(live)));
        vm.revertToState(start);
        uint256[] memory b = _measured(IPool(address(next)));
        string[5] memory names = ["deposit, leaf 0", "deposit, leaf 1", "send, leaves 2-3", "cash out", "losing duplicate deposit"];
        console2.log("gas with real proofs, one transaction each: live, next vault");
        for (uint256 i = 0; i < 5; i++) {
            console2.log(names[i], a[i], b[i]);
            if (b[i] > a[i]) console2.log("  more by", b[i] - a[i]);
            else console2.log("  less by", a[i] - b[i]);
        }
        assertLt(b[0], a[0], "a deposit costs less");
        assertLt(b[1], a[1], "a deposit costs less");
        assertLt(b[2], a[2], "a send costs less");
        assertLe(b[3], a[3] + 1_000, "a cash out does two more checks and no more");
        assertLt(b[4] * 4, a[4], "a losing deposit stops before the proof");

        vm.prank(relayer);
        next.unshield(
            fx.readBytes(".floored.proof"),
            fx.readBytes32(".floored.root"),
            fx.readBytes32(".floored.nullifier"),
            asset,
            recipient,
            fx.readUint(".floored.amount"),
            fx.readUint(".floored.minReceived")
        );
        console2.log("next vault cash out with a floor", vm.lastCallGas().gasTotalUsed);
    }

    /// Past leaf 100 the live tree rewrites a ring slot instead of filling a fresh
    /// one, so the saving changes. Same accept-all verifier on both: the proof cost
    /// is the same on both vaults, so what differs is the vault's own work.
    /// forge-config: default.isolate = true
    function test_gas_deep_tree_live_vs_next() public {
        AcceptEverything v = new AcceptEverything();
        ShieldPoolPayments a = new ShieldPoolPayments(poseidon2, address(v));
        a.setShieldVerifier(address(v));
        ShieldPoolPayments2 b = new ShieldPoolPayments2(poseidon2, address(v), STRAY);
        b.setShieldVerifier(address(v));
        vm.deal(address(this), 1 ether);
        for (uint256 i = 1; i <= 120; i++) {
            a.shieldBound{value: 1}(address(0), 1, bytes32(i), "");
            b.shieldBound{value: 1}(address(0), 1, bytes32(i), "");
        }
        a.shieldBound{value: 1}(address(0), 1, bytes32(uint256(1000)), "");
        uint256 gasA = vm.lastCallGas().gasTotalUsed;
        b.shieldBound{value: 1}(address(0), 1, bytes32(uint256(1000)), "");
        uint256 gasB = vm.lastCallGas().gasTotalUsed;
        console2.log("deposit at leaf 120, live, next", gasA, gasB);
        assertLt(gasB, gasA);

        bytes32 rootA = a.currentRoot();
        a.transfer("", rootA, bytes32(uint256(1)), [bytes32(uint256(2000)), bytes32(uint256(2001))]);
        gasA = vm.lastCallGas().gasTotalUsed;
        bytes32 rootB = b.currentRoot();
        b.transfer("", rootB, bytes32(uint256(1)), [bytes32(uint256(2000)), bytes32(uint256(2001))]);
        gasB = vm.lastCallGas().gasTotalUsed;
        console2.log("send at leaf 121, live, next", gasA, gasB);
        assertLt(gasB, gasA);
    }

    function test_gas_deploy_live_vs_next() public {
        uint256 g = gasleft();
        new ShieldPoolPayments(poseidon2, address(0));
        uint256 gasLive = g - gasleft();
        g = gasleft();
        new ShieldPoolPayments2(poseidon2, address(0), STRAY);
        uint256 gasNext = g - gasleft();
        console2.log("deploy, live, next", gasLive, gasNext);
        assertLt(gasNext, 30_000_000, "under Tempo's per-transaction cap");
    }

    // ───────────────────────────────────────────────────────────── helpers

    function _story(IPool pool) internal {
        vm.startPrank(payer);
        pool.shieldBound(asset, fx.readUint(".shieldBig.amount"), fx.readBytes32(".shieldBig.commitment"), fx.readBytes(".shieldBig.proof"));
        pool.shieldBound(asset, fx.readUint(".shieldTight.amount"), fx.readBytes32(".shieldTight.commitment"), fx.readBytes(".shieldTight.proof"));
        vm.stopPrank();
        assertTrue(pool.isKnownRoot(fx.readBytes32(".send.root")), "the root off-chain");
        vm.prank(relayer);
        pool.transfer(
            fx.readBytes(".send.proof"),
            fx.readBytes32(".send.root"),
            fx.readBytes32(".send.nullifier"),
            [fx.readBytes32(".send.payment"), fx.readBytes32(".send.change")]
        );
        assertTrue(pool.isKnownRoot(fx.readBytes32(".plain.root")), "the root off-chain");
        vm.prank(relayer);
        pool.unshield(fx.readBytes(".plain.proof"), fx.readBytes32(".plain.root"), fx.readBytes32(".plain.nullifier"), asset, recipient, fx.readUint(".plain.amount"));
        assertEq(MockERC20(asset).balanceOf(recipient) > 0, true);
    }

    function _measured(IPool pool) internal returns (uint256[] memory g) {
        g = new uint256[](5);
        vm.prank(payer);
        pool.shieldBound(asset, fx.readUint(".shieldBig.amount"), fx.readBytes32(".shieldBig.commitment"), fx.readBytes(".shieldBig.proof"));
        g[0] = vm.lastCallGas().gasTotalUsed;
        vm.prank(payer);
        pool.shieldBound(asset, fx.readUint(".shieldTight.amount"), fx.readBytes32(".shieldTight.commitment"), fx.readBytes(".shieldTight.proof"));
        g[1] = vm.lastCallGas().gasTotalUsed;
        vm.prank(relayer);
        pool.transfer(
            fx.readBytes(".send.proof"),
            fx.readBytes32(".send.root"),
            fx.readBytes32(".send.nullifier"),
            [fx.readBytes32(".send.payment"), fx.readBytes32(".send.change")]
        );
        g[2] = vm.lastCallGas().gasTotalUsed;
        vm.prank(relayer);
        pool.unshield(fx.readBytes(".plain.proof"), fx.readBytes32(".plain.root"), fx.readBytes32(".plain.nullifier"), asset, recipient, fx.readUint(".plain.amount"));
        g[3] = vm.lastCallGas().gasTotalUsed;
        bytes memory again = abi.encodeCall(
            IPool.shieldBound,
            (asset, fx.readUint(".shieldBig.amount"), fx.readBytes32(".shieldBig.commitment"), fx.readBytes(".shieldBig.proof"))
        );
        vm.prank(payer);
        (bool ok, ) = address(pool).call(again);
        assertFalse(ok, "a duplicate deposit reverts");
        g[4] = vm.lastCallGas().gasTotalUsed;
    }

    function _deployPoseidon() internal returns (address addr) {
        string memory json = vm.readFile("test/fixtures/Poseidon2.json");
        bytes memory bytecode = json.readBytes(".bytecode");
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "poseidon");
    }
}
