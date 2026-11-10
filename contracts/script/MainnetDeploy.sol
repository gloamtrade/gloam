// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";
import {RedeployGuard} from "./RedeployGuard.sol";
import {ShieldPoolPayments} from "../src/ShieldPoolPayments.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {ShieldVerifierFinal} from "../src/verifiers/final/ShieldVerifierFinal.sol";
import {ShieldIVerifierFinal} from "../src/verifiers/final/ShieldIVerifierFinal.sol";
import {UnshieldVerifierFinal} from "../src/verifiers/final/UnshieldVerifierFinal.sol";
import {UnshieldIVerifierFinal} from "../src/verifiers/final/UnshieldIVerifierFinal.sol";
import {TransferVerifierFinal} from "../src/verifiers/final/TransferVerifierFinal.sol";
import {TransferIVerifierFinal} from "../src/verifiers/final/TransferIVerifierFinal.sol";
import {DualProofVerifier} from "../src/verifiers/DualProofVerifier.sol";
import {KeyCheckProofs} from "./KeyCheckProofs.sol";
import {VaultOwnerGuard} from "../src/VaultOwnerGuard.sol";

/**
 * The mainnet deploy every chain shares, so Tempo and Robinhood Chain get the
 * same pool wired the same way: the Groth16 verifiers from the trusted setup's
 * final keys (src/verifiers/final) and their adapters, the
 * DualProofVerifier, ShieldPoolPayments (no sealed swap), deposit limits on,
 * the shield verifier (deposits need shieldBound()), each listed asset's
 * limits, the cash-out fee, an optional handoff to a multisig owner, and
 * endSetup() last.
 *
 * After endSetup the owner can lower a limit at once (lowerDepositLimit, down
 * to 0/0 to close deposits) but raising one or listing a new asset takes the
 * 3-day timelock. Withdrawals and private transfers are never limited.
 *
 * Cash-out fee: deposits and private transfers are free; unshield keeps
 * WITHDRAW_FEE_BPS of the amount in the pool for FEE_RECIPIENT, who is paid by
 * collectFees(asset) (anyone may call it). The contract caps it at 100 bps (1%).
 * After endSetup the fee can be lowered at once (lowerWithdrawFee) but raising
 * it or changing the recipient takes the 3-day timelock, so if FEE_RECIPIENT is
 * left unset the pool launches with the fee off.
 *
 * Key gate: before the pool exists, the freshly deployed verifiers must accept
 * real proofs made with the ceremony's final keys and reject proofs made with
 * the dev keys (script/KeyCheckProofs.sol). A verifier on dev keys can be fooled
 * by whoever made them, so the script stops there (pre-mainnet audit GATE 2).
 * After the broadcast every setting is checked again and any mismatch fails the
 * run (GATE 1, F3): if it fails, do not announce the pool, deploy a fresh one.
 *
 * Runs once per chain: on a mainnet whose vault is already deployed (recorded
 * in contracts/deployments/ with code on chain, or made by this deployer) the
 * script stops before it reads a key or sends anything (script/RedeployGuard.sol).
 *
 * Environment (read by every chain's script):
 *   DEPLOYER_PK          funded deployer
 *   DEPLOYER             optional: the deployer's address. Next to DEPLOYER_PK the key must be
 *                        its key; alone, a local fork rehearses the deploy as that address
 *                        without a key (script/DeployerBroadcast.sol)
 *   POSEIDON2            PoseidonT3 deployed on this chain (circuits/scripts/deploy-poseidon.mjs)
 *   LIMIT_ASSETS         assets to list, comma separated (0x0 means the chain's native coin, where allowed)
 *   LIMIT_PER_DEPOSIT    per-deposit limit for each, raw units, same order
 *   LIMIT_TOTAL          total limit for each, raw units, same order
 *   WITHDRAW_FEE_BPS     cash-out fee in basis points, default 25 (0.25%), max 100 (1%)
 *   FEE_RECIPIENT        who collects cash-out fees; unset means the fee stays OFF
 *   NEW_OWNER            the owner multisig; it must call acceptOwnership() afterwards. It must
 *                        be a contract unless NEW_OWNER_EOA=1. Unset: the deployer keeps the pool.
 *   GLOAM_ALLOW_REDEPLOY 1 deploys a second vault on a chain that has one. Unset: refused.
 */
abstract contract MainnetDeploy is RedeployGuard {
    struct Limits {
        address[] assets;
        uint256[] perDeposit;
        uint256[] total;
    }

    /**
     * @param chainId     the only chain this script may run on
     * @param allowNative whether address(0), the native coin, may be listed
     */
    function _deployMainnet(uint256 chainId, bool allowNative) internal {
        require(block.chainid == chainId, "wrong chain for this script");
        _refuseRedeploy();

        address poseidon2 = vm.envAddress("POSEIDON2");
        require(poseidon2.code.length > 0, "POSEIDON2 has no code on this chain");
        address newOwner = _readNewOwner();
        Limits memory lim = _readLimits(allowNative);
        (uint16 feeBps, address feeRecipient) = _readWithdrawFee();

        _startDeployerBroadcast();
        (ShieldPoolPayments pool, address dual, address shieldI) = _deployAndWire(poseidon2, lim, feeBps, feeRecipient);
        if (newOwner != address(0)) {
            pool.transferOwnership(newOwner);
        }
        // FINAL STEP: end setup mode. Irreversible. Do all wiring ABOVE this line.
        pool.endSetup();
        vm.stopBroadcast();

        _report(pool, poseidon2, dual, shieldI, lim.assets);
    }

    /**
     * The guarded mainnet deploy (Elysium first): the same pool wired the same
     * way, but its owner is a VaultOwnerGuard from the first block, so its proof
     * checkers can never be replaced and its ownership can never move again
     * (Kann I-02). Nothing changes for the chains above, which keep _deployMainnet.
     *
     * In the one broadcast, in this order: the verifiers and the key gate, the
     * pool (at the same nonce as on every other chain), limits, the shield
     * verifier, each asset, the fee, then the guard with the deployer as its
     * first controller, the handoff to the guard, endSetup, the guard accepting
     * the vault, and last the controller handed on to GUARD_CONTROLLER, who
     * must call acceptController() on the guard. Until then the deployer can
     * only do what the guard forwards (limits and the fee), never touch a
     * verifier.
     *
     * Environment, on top of the list above:
     *   GUARD_CONTROLLER      who runs the guard (a multisig). It must be a contract
     *                         unless GUARD_CONTROLLER_EOA=1. Required.
     *   NEW_OWNER             must be unset: the guard is the owner on this path.
     */
    function _deployMainnetGuarded(uint256 chainId, bool allowNative) internal {
        require(block.chainid == chainId, "wrong chain for this script");
        _refuseRedeploy();
        require(_envAddressOrZero("NEW_OWNER") == address(0), "NEW_OWNER must be unset: the guard owns this vault");

        address poseidon2 = vm.envAddress("POSEIDON2");
        require(poseidon2.code.length > 0, "POSEIDON2 has no code on this chain");
        address controller = _readGuardController();
        Limits memory lim = _readLimits(allowNative);
        (uint16 feeBps, address feeRecipient) = _readWithdrawFee();
        address deployer = _deployerAddress();

        _startDeployerBroadcast();
        (ShieldPoolPayments pool, address dual, address shieldI) = _deployAndWire(poseidon2, lim, feeBps, feeRecipient);
        // The guard comes after the pool, so the pool keeps its address on every chain.
        VaultOwnerGuard guard = new VaultOwnerGuard(address(pool), deployer);
        pool.transferOwnership(address(guard));
        // FINAL STEP of setup: irreversible. The guard refuses a vault still in setup.
        pool.endSetup();
        guard.acceptVaultOwnership();
        if (controller != deployer) {
            guard.transferController(controller);
        }
        vm.stopBroadcast();

        _report(pool, poseidon2, dual, shieldI, lim.assets);
        _reportGuard(pool, guard, deployer, controller);
    }

    /// @dev Verifiers, key gate, pool, limits, shield verifier, assets and fee, in the order every chain uses.
    function _deployAndWire(address poseidon2, Limits memory lim, uint16 feeBps, address feeRecipient)
        internal
        returns (ShieldPoolPayments pool, address dual, address shieldI)
    {
        (dual, shieldI) = _deployVerifiers();
        // GATE 2: no pool until the verifiers on chain prove they hold the ceremony keys
        _requireCeremonyKeys(dual, shieldI);
        pool = new ShieldPoolPayments(poseidon2, dual);
        // Limits on before deposits can work at all (shieldBound needs the shield
        // verifier): with nothing listed yet every deposit is refused, so there is
        // never a block where the pool takes any asset in any amount.
        pool.turnOnDepositLimits();
        pool.setShieldVerifier(shieldI);
        for (uint256 i = 0; i < lim.assets.length; i++) {
            pool.setDepositLimit(lim.assets[i], uint128(lim.perDeposit[i]), uint128(lim.total[i]));
        }
        if (feeRecipient != address(0)) {
            pool.setWithdrawFee(feeBps, feeRecipient);
        }
    }

    /// @dev GUARD_CONTROLLER is required, and must be a contract unless GUARD_CONTROLLER_EOA=1.
    function _readGuardController() internal view returns (address controller) {
        controller = _envAddressOrZero("GUARD_CONTROLLER");
        require(controller != address(0), "set GUARD_CONTROLLER: who runs the guard (a multisig)");
        require(
            controller.code.length > 0 || vm.envOr("GUARD_CONTROLLER_EOA", uint256(0)) == 1,
            "GUARD_CONTROLLER has no code: use a multisig, or set GUARD_CONTROLLER_EOA=1 to hand it to a plain key"
        );
    }

    /// @dev An address from the environment; unset or empty reads as zero.
    function _envAddressOrZero(string memory name) internal view returns (address) {
        string memory raw = vm.envOr(name, string(""));
        return bytes(raw).length > 0 ? vm.parseAddress(raw) : address(0);
    }

    /// @dev GATE 1 for the guard: read back from the chain, any mismatch fails the run.
    function _reportGuard(ShieldPoolPayments pool, VaultOwnerGuard guard, address deployer, address controller)
        internal
        view
    {
        console2.log("VaultOwnerGuard", address(guard));
        console2.log("guard controller", guard.controller());
        console2.log("guard pending controller", guard.pendingController());
        require(pool.owner() == address(guard), "the guard does not own the vault");
        require(pool.pendingOwner() == address(0), "someone is offered the vault");
        require(address(guard.vault()) == address(pool), "the guard names another vault");
        require(guard.controller() == deployer, "the guard has an unexpected controller");
        if (controller != deployer) {
            require(guard.pendingController() == controller, "GUARD_CONTROLLER is not offered the guard");
        } else {
            require(guard.pendingController() == address(0), "the guard has a controller handover pending");
        }
        bytes memory setVerifier = abi.encodeWithSignature("setVerifier(address)", address(1));
        bytes memory setShield = abi.encodeWithSignature("setShieldVerifier(address)", address(1));
        require(!guard.isAllowedChange(setVerifier), "the guard allows setVerifier");
        require(!guard.isAllowedChange(setShield), "the guard allows setShieldVerifier");
        console2.log("Guard checks passed: the guard owns the vault, its proof checkers are fixed for good.");
        if (guard.pendingController() != address(0)) {
            console2.log("Next: GUARD_CONTROLLER must call acceptController() on the guard", guard.pendingController());
        }
    }

    function _readLimits(bool allowNative) internal view returns (Limits memory lim) {
        lim.assets = vm.envAddress("LIMIT_ASSETS", ",");
        lim.perDeposit = vm.envUint("LIMIT_PER_DEPOSIT", ",");
        lim.total = vm.envUint("LIMIT_TOTAL", ",");
        require(lim.assets.length > 0, "LIMIT_ASSETS is empty");
        require(
            lim.assets.length == lim.perDeposit.length && lim.assets.length == lim.total.length,
            "limit lists differ in length"
        );
        for (uint256 i = 0; i < lim.assets.length; i++) {
            if (lim.assets[i] == address(0)) {
                require(allowNative, "this chain has no native coin to list");
            } else {
                require(lim.assets[i].code.length > 0, "listed asset has no code");
            }
            require(lim.perDeposit[i] > 0 && lim.perDeposit[i] <= lim.total[i], "need 0 < perDeposit <= total");
            require(lim.total[i] <= type(uint128).max, "limit too large");
        }
    }

    /// @dev WITHDRAW_FEE_BPS (default 25) and FEE_RECIPIENT. No recipient: fee off.
    function _readWithdrawFee() internal view returns (uint16 bps, address recipient) {
        uint256 raw = vm.envOr("WITHDRAW_FEE_BPS", uint256(25));
        require(raw <= 100, "WITHDRAW_FEE_BPS above the 100 bps (1%) cap");
        bps = uint16(raw);
        recipient = vm.envOr("FEE_RECIPIENT", address(0));
        if (recipient == address(0)) {
            console2.log("FEE_RECIPIENT unset: cash-out fee left OFF (0 bps). Turning it on later takes the 3-day timelock.");
            bps = 0;
        }
    }

    /// @dev NEW_OWNER must be a contract (a multisig) unless NEW_OWNER_EOA=1 (audit F2).
    function _readNewOwner() internal view returns (address newOwner) {
        newOwner = vm.envOr("NEW_OWNER", address(0));
        if (newOwner == address(0)) {
            console2.log("NEW_OWNER unset: the deployer key keeps the pool. A multisig owner is recommended.");
            return newOwner;
        }
        require(
            newOwner.code.length > 0 || vm.envOr("NEW_OWNER_EOA", uint256(0)) == 1,
            "NEW_OWNER has no code: use a multisig, or set NEW_OWNER_EOA=1 to hand it to a plain key"
        );
    }

    function _deployVerifiers() internal returns (address dual, address shieldI) {
        ShieldIVerifierFinal s = new ShieldIVerifierFinal(new ShieldVerifierFinal());
        UnshieldIVerifierFinal u = new UnshieldIVerifierFinal(new UnshieldVerifierFinal());
        TransferIVerifierFinal t = new TransferIVerifierFinal(new TransferVerifierFinal());
        dual = address(new DualProofVerifier(u, t));
        shieldI = address(s);
    }

    /// @dev Each verifier accepts a real proof made with the final keys and
    ///      rejects one made with the dev keys. Reads only, no transactions.
    function _requireCeremonyKeys(address dual, address shieldI) internal view {
        (bytes memory p, uint256[] memory pub) = KeyCheckProofs.shieldFinal();
        require(IVerifier(shieldI).verify(p, pub), "shield verifier rejects a final-key proof");
        (p, pub) = KeyCheckProofs.shieldDev();
        require(!IVerifier(shieldI).verify(p, pub), "shield verifier accepts a DEV-key proof");
        (p, pub) = KeyCheckProofs.unshieldFinal();
        require(IVerifier(dual).verify(p, pub), "unshield verifier rejects a final-key proof");
        (p, pub) = KeyCheckProofs.unshieldDev();
        require(!IVerifier(dual).verify(p, pub), "unshield verifier accepts a DEV-key proof");
        (p, pub) = KeyCheckProofs.transferFinal();
        require(IVerifier(dual).verify(p, pub), "transfer verifier rejects a final-key proof");
        (p, pub) = KeyCheckProofs.transferDev();
        require(!IVerifier(dual).verify(p, pub), "transfer verifier accepts a DEV-key proof");
    }

    function _report(
        ShieldPoolPayments pool,
        address poseidon2,
        address dual,
        address shieldI,
        address[] memory assets
    ) internal view {
        console2.log("chainId", block.chainid);
        console2.log("poseidon2", poseidon2);
        console2.log("ShieldPoolPayments", address(pool));
        console2.log("DualProofVerifier", dual);
        console2.log("ShieldIVerifier", shieldI);
        console2.log("depositLimitsOn (must be true)", pool.depositLimitsOn());
        console2.log("setupMode (must be false)", pool.setupMode());
        console2.log("withdrawFeeBps", uint256(pool.withdrawFeeBps()));
        console2.log("feeRecipient", pool.feeRecipient());
        for (uint256 i = 0; i < assets.length; i++) {
            (uint128 per, uint128 cap) = pool.depositLimit(assets[i]);
            console2.log("listed", assets[i]);
            console2.log("  perDeposit", uint256(per));
            console2.log("  total", uint256(cap));
        }
        if (pool.pendingOwner() != address(0)) {
            console2.log("pendingOwner (must call acceptOwnership)", pool.pendingOwner());
        }
        // GATE 1 / F3: the pool as deployed, read back from the chain. Any mismatch
        // fails the run; do not announce a pool that fails here.
        require(pool.depositLimitsOn(), "deposit limits not on");
        require(!pool.setupMode(), "setup not ended");
        require(address(pool.shieldVerifier()) == shieldI, "shield verifier mismatch");
        require(address(pool.verifier()) == dual, "spend verifier mismatch");
        require(pool.withdrawFeeBps() <= 100, "cash-out fee above 1%");
        _requireCeremonyKeys(address(pool.verifier()), address(pool.shieldVerifier()));
        console2.log("All checks passed. Next: pool + deploy block in app/src/lib/networks.ts");
    }
}
