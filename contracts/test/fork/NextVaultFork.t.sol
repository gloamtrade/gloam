// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// The next vault (not deployed, not audited) on a local fork of Base, wired to the
// live vault's own Poseidon and live proof verifiers. Nothing is broadcast.
//
//  - Replays every deposit, private send and cash out the live Base vault has ever
//    taken, in order, with the exact proofs from chain
//    (test/fixtures/next-vault-base-replay.json, circuits/scripts/gen-next-vault-replay.mjs),
//    then checks the tree, deposits and fees match the live vault at that block.
//  - Runs a floored cash out on the live verifiers with the real token, with a
//    proof made from the ceremony's final keys (next-vault-proofs.json).
//  - Checks DualProofVerifier2's deployed code is the live one's, metadata aside.
//
// Off by default (it reads mainnet over RPC). From contracts/:
//   NEXT_FORK=1 forge test --match-path test/fork/NextVaultFork.t.sol -vv
// NEXT_FORK_URL picks the RPC.

import {Test, console2} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore2} from "../../src/ShieldPoolCore2.sol";
import {ShieldPoolPayments2} from "../../src/ShieldPoolPayments2.sol";
import {IVerifier} from "../../src/interfaces/IVerifier.sol";
import {DualProofVerifier2} from "../../src/verifiers/DualProofVerifier2.sol";

interface ILiveVault {
    function poseidon2() external view returns (address);
    function verifier() external view returns (address);
    function shieldVerifier() external view returns (address);
    function currentRoot() external view returns (bytes32);
    function nextIndex() external view returns (uint256);
    function deposited(address asset) external view returns (uint256);
    function feesOwed(address asset) external view returns (uint256);
    function withdrawFeeBps() external view returns (uint16);
    function isSpent(bytes32 nullifier) external view returns (bool);
}

interface ILiveDual {
    function unshieldVerifier() external view returns (IVerifier);
    function transferVerifier() external view returns (IVerifier);
}

interface IERC20Min {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

contract NextVaultForkTest is Test {
    using stdJson for string;

    ILiveVault constant LIVE = ILiveVault(0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194);
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant TREASURY = 0xB3900ac9350903218e4c7597bAb0f008F01B30B8;

    ShieldPoolPayments2 next;
    string fx;
    address payer = makeAddr("payer");
    address relayer = makeAddr("relayer");

    function setUp() public {
        if (!vm.envOr("NEXT_FORK", false)) {
            vm.skip(true);
            return;
        }
        fx = vm.readFile("test/fixtures/next-vault-base-replay.json");
        vm.createSelectFork(vm.envOr("NEXT_FORK_URL", string("https://mainnet.base.org")), fx.readUint(".block"));
        assertEq(block.chainid, 8453, "a Base mainnet fork");

        next = new ShieldPoolPayments2(LIVE.poseidon2(), LIVE.verifier(), TREASURY);
        next.turnOnDepositLimits();
        next.setShieldVerifier(LIVE.shieldVerifier());
        next.setDepositLimit(USDC, type(uint128).max, type(uint128).max);
        next.setWithdrawFee(LIVE.withdrawFeeBps(), TREASURY);
        next.endSetup();
        vm.prank(payer);
        IERC20Min(USDC).approve(address(next), type(uint256).max);
    }

    function test_every_live_base_proof_replays_on_the_next_vault() public {
        vm.pauseGasMetering(); // the fixture's strings fill the test's own memory
        (uint256 deposits, uint256 sends, uint256 cashOuts) = (0, 0, 0);
        for (uint256 i = 0; ; i++) {
            string memory at = string.concat(".ops[", vm.toString(i), "]");
            if (!vm.keyExistsJson(fx, at)) break;
            bytes32 kind = keccak256(bytes(fx.readString(string.concat(at, ".kind"))));
            if (kind == keccak256("shield")) {
                _deposit(at);
                deposits++;
            } else if (kind == keccak256("transfer")) {
                _send(at);
                sends++;
            } else {
                _cashOut(at);
                cashOuts++;
            }
        }
        console2.log("deposits, sends, cash outs", deposits, sends, cashOuts);

        assertEq(next.currentRoot(), fx.readBytes32(".root"), "the live root from the fixture");
        assertEq(next.currentRoot(), LIVE.currentRoot(), "the live root at this block");
        assertEq(next.nextIndex(), LIVE.nextIndex(), "same leaves");
        assertEq(next.deposited(USDC), LIVE.deposited(USDC), "same deposits");
        assertEq(next.feesOwed(USDC), LIVE.feesOwed(USDC), "same fees");
        assertEq(IERC20Min(USDC).balanceOf(address(next)), next.deposited(USDC) + next.feesOwed(USDC), "solvent");
    }

    function test_a_floored_cash_out_on_the_live_verifiers() public {
        string memory p = vm.readFile("test/fixtures/next-vault-proofs.json");
        assertEq(p.readAddress(".asset"), USDC);
        deal(USDC, payer, 200e6);
        vm.startPrank(payer);
        next.shieldBound(USDC, p.readUint(".shieldBig.amount"), p.readBytes32(".shieldBig.commitment"), p.readBytes(".shieldBig.proof"));
        next.shieldBound(USDC, p.readUint(".shieldTight.amount"), p.readBytes32(".shieldTight.commitment"), p.readBytes(".shieldTight.proof"));
        vm.stopPrank();
        vm.prank(relayer);
        next.transfer(
            p.readBytes(".send.proof"),
            p.readBytes32(".send.root"),
            p.readBytes32(".send.nullifier"),
            [p.readBytes32(".send.payment"), p.readBytes32(".send.change")]
        );

        address recipient = p.readAddress(".recipient");
        uint256 amount = p.readUint(".tight.amount");
        uint256 floor = p.readUint(".tight.minReceived");
        uint256 before = IERC20Min(USDC).balanceOf(recipient);
        vm.prank(relayer);
        next.unshield(p.readBytes(".tight.proof"), p.readBytes32(".tight.root"), p.readBytes32(".tight.nullifier"), USDC, recipient, amount, floor);
        assertEq(IERC20Min(USDC).balanceOf(recipient) - before, floor, "0.25% is what the live vault charges at this block");

        // the same live verifier refuses it with the floor taken off
        vm.prank(relayer);
        vm.expectRevert(ShieldPoolCore2.InvalidProof.selector);
        next.unshield(p.readBytes(".floored.proof"), p.readBytes32(".floored.root"), p.readBytes32(".floored.nullifier"), USDC, recipient, p.readUint(".floored.amount"));
    }

    function test_the_dual_verifier_runs_the_live_code() public {
        address liveDual = LIVE.verifier();
        DualProofVerifier2 d = new DualProofVerifier2(ILiveDual(liveDual).unshieldVerifier(), ILiveDual(liveDual).transferVerifier());
        assertEq(keccak256(_noMetadata(address(d).code)), keccak256(_noMetadata(liveDual.code)));
    }

    function _deposit(string memory at) internal {
        address asset = fx.readAddress(string.concat(at, ".asset"));
        uint256 amount = fx.readUint(string.concat(at, ".amount"));
        deal(USDC, payer, IERC20Min(USDC).balanceOf(payer) + amount);
        vm.prank(payer);
        next.shieldBound(asset, amount, fx.readBytes32(string.concat(at, ".commitment")), fx.readBytes(string.concat(at, ".proof")));
    }

    function _send(string memory at) internal {
        vm.prank(relayer);
        next.transfer(
            fx.readBytes(string.concat(at, ".proof")),
            fx.readBytes32(string.concat(at, ".root")),
            fx.readBytes32(string.concat(at, ".nullifier")),
            [fx.readBytes32(string.concat(at, ".payment")), fx.readBytes32(string.concat(at, ".change"))]
        );
    }

    function _cashOut(string memory at) internal {
        bytes32 nullifier = fx.readBytes32(string.concat(at, ".nullifier"));
        assertTrue(LIVE.isSpent(nullifier), "a real cash out");
        vm.prank(relayer);
        next.unshield(
            fx.readBytes(string.concat(at, ".proof")),
            fx.readBytes32(string.concat(at, ".root")),
            nullifier,
            fx.readAddress(string.concat(at, ".asset")),
            fx.readAddress(string.concat(at, ".to")),
            fx.readUint(string.concat(at, ".amount"))
        );
    }

    /// Runtime code without the CBOR metadata the compiler appends.
    function _noMetadata(bytes memory code) internal pure returns (bytes memory out) {
        uint256 cbor = (uint256(uint8(code[code.length - 2])) << 8) | uint8(code[code.length - 1]);
        out = new bytes(code.length - cbor - 2);
        for (uint256 i = 0; i < out.length; i++) out[i] = code[i];
    }
}
