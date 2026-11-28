// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";
import {MainnetDeploy} from "./MainnetDeploy.sol";
import {ShieldPoolPayments2} from "../src/ShieldPoolPayments2.sol";
import {DualProofVerifier2} from "../src/verifiers/DualProofVerifier2.sol";
import {ShieldVerifierFinal} from "../src/verifiers/final/ShieldVerifierFinal.sol";
import {ShieldIVerifierFinal} from "../src/verifiers/final/ShieldIVerifierFinal.sol";
import {UnshieldVerifierFinal} from "../src/verifiers/final/UnshieldVerifierFinal.sol";
import {UnshieldIVerifierFinal} from "../src/verifiers/final/UnshieldIVerifierFinal.sol";
import {TransferVerifierFinal} from "../src/verifiers/final/TransferVerifierFinal.sol";
import {TransferIVerifierFinal} from "../src/verifiers/final/TransferIVerifierFinal.sol";

/**
 * The next vault's deploy. NOT DEPLOYED, NOT AUDITED: it refuses to run until
 * GLOAM_ACK_NEXT_VAULT_UNAUDITED=1, which belongs only after an outside review of
 * ShieldPoolCore2 and a migration plan. Same steps and same gates as MainnetDeploy
 * (ceremony key check before the pool exists, every setting read back after), the
 * same circuits and verifiers, and ShieldPoolPayments2 in place of the live pool.
 *
 * Environment, on top of MainnetDeploy's:
 *   GLOAM_ACK_NEXT_VAULT_UNAUDITED  must be 1
 *   NEXT_VAULT_CHAIN_ID             the only chain this run may touch: 1, 8453, 4663 or 4217
 *   STRAY_RECIPIENT                 where sweepStrayToken() pays, fixed for good. Unset: FEE_RECIPIENT
 */
contract DeployNextVault is MainnetDeploy {
    string internal constant ACK_ENV = "GLOAM_ACK_NEXT_VAULT_UNAUDITED";

    function run() external {
        require(
            vm.envOr(ACK_ENV, uint256(0)) == 1,
            "the next vault is not audited: set GLOAM_ACK_NEXT_VAULT_UNAUDITED=1 only after an outside review"
        );
        uint256 chainId = vm.envUint("NEXT_VAULT_CHAIN_ID");
        require(block.chainid == chainId, "wrong chain for this script");
        // Tempo has no native coin to list, as in DeployTempoMainnet
        require(chainId == 1 || chainId == 8453 || chainId == 4663 || chainId == 4217, "not a Gloam mainnet");
        bool allowNative = chainId != 4217;

        address poseidon2 = vm.envAddress("POSEIDON2");
        require(poseidon2.code.length > 0, "POSEIDON2 has no code on this chain");
        address newOwner = _readNewOwner();
        Limits memory lim = _readLimits(allowNative);
        (uint16 feeBps, address feeRecipient) = _readWithdrawFee();
        address strayRecipient = vm.envOr("STRAY_RECIPIENT", feeRecipient);
        require(strayRecipient != address(0), "set STRAY_RECIPIENT or FEE_RECIPIENT");

        _startDeployerBroadcast();
        (address dual, address shieldI) = _deployVerifiers2();
        // GATE 2: no pool until the verifiers on chain prove they hold the ceremony keys
        _requireCeremonyKeys(dual, shieldI);
        ShieldPoolPayments2 pool = new ShieldPoolPayments2(poseidon2, dual, strayRecipient);
        // Limits on before deposits can work at all, as in MainnetDeploy
        pool.turnOnDepositLimits();
        pool.setShieldVerifier(shieldI);
        for (uint256 i = 0; i < lim.assets.length; i++) {
            pool.setDepositLimit(lim.assets[i], uint128(lim.perDeposit[i]), uint128(lim.total[i]));
        }
        if (feeRecipient != address(0)) {
            pool.setWithdrawFee(feeBps, feeRecipient);
        }
        if (newOwner != address(0)) {
            pool.transferOwnership(newOwner);
        }
        // FINAL STEP: end setup mode. Irreversible. Do all wiring ABOVE this line.
        pool.endSetup();
        vm.stopBroadcast();

        console2.log("ShieldPoolPayments2 (next vault, not audited)", address(pool));
        console2.log("DualProofVerifier2", dual);
        console2.log("ShieldIVerifier", shieldI);
        console2.log("strayRecipient", pool.strayRecipient());
        // GATE 1 / F3: the pool as deployed, read back from the chain.
        require(pool.depositLimitsOn(), "deposit limits not on");
        require(!pool.setupMode(), "setup not ended");
        require(address(pool.shieldVerifier()) == shieldI, "shield verifier mismatch");
        require(address(pool.verifier()) == dual, "spend verifier mismatch");
        require(pool.strayRecipient() == strayRecipient, "stray recipient mismatch");
        require(pool.withdrawFeeBps() <= 100, "cash-out fee above 1%");
        _requireCeremonyKeys(address(pool.verifier()), address(pool.shieldVerifier()));
    }

    function _deployVerifiers2() internal returns (address dual, address shieldI) {
        ShieldIVerifierFinal s = new ShieldIVerifierFinal(new ShieldVerifierFinal());
        UnshieldIVerifierFinal u = new UnshieldIVerifierFinal(new UnshieldVerifierFinal());
        TransferIVerifierFinal t = new TransferIVerifierFinal(new TransferVerifierFinal());
        dual = address(new DualProofVerifier2(u, t));
        shieldI = address(s);
    }
}
