// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ShieldPoolPoseidon} from "../../src/ShieldPoolPoseidon.sol";
import {ShieldVerifier} from "../../src/verifiers/ShieldVerifier.sol";
import {ShieldIVerifier} from "../../src/verifiers/ShieldIVerifier.sol";
import {UnshieldVerifier} from "../../src/verifiers/UnshieldVerifier.sol";
import {UnshieldIVerifier} from "../../src/verifiers/UnshieldIVerifier.sol";
import {TransferVerifier} from "../../src/verifiers/TransferVerifier.sol";
import {TransferIVerifier} from "../../src/verifiers/TransferIVerifier.sol";
import {DualProofVerifier} from "../../src/verifiers/DualProofVerifier.sol";

/**
 * Full-stack Gloam deploy for a fresh EVM chain (Tempo Moderato, chainId 42431).
 *
 * Tempo has none of Gloam's on-chain deps, so this deploys the raw Groth16
 * verifiers, their IVerifier adapters, the combined DualProofVerifier, and the
 * hardened pool; wires the shield verifier so deposits go through shieldBound();
 * leaves sealedSwap DISABLED (audit H1); then calls endSetup() so every later
 * rule change is timelocked (queueChange -> 3 days -> executeChange). The Poseidon2 (PoseidonT3) hasher is
 * deployed separately from precomputed bytecode; pass its address in POSEIDON2.
 *
 * The USER runs this. It is NOT executed by CI or by any agent, and the proving
 * keys here are the dev ceremony, so this is a testnet deploy only.
 *
 * Prereqs:
 *   1. Deploy Poseidon:  node circuits/scripts/deploy-poseidon.mjs   (against Tempo RPC)
 *   2. export POSEIDON2=0x...     # PoseidonT3 address from step 1
 *   3. export DEPLOYER_PK=0x...   # funded Tempo deployer (gas is paid in USD)
 *   4. export RPC_URL=https://rpc.moderato.tempo.xyz
 *
 * Run:
 *   forge script script/archive/DeployTempo.s.sol:DeployTempo --rpc-url $RPC_URL --broadcast
 *
 * After: record the pool address + its deploy block, set them in the `tempo`
 * entry of app/src/lib/networks.ts, and flip its status from "planned" to "live".
 */
contract DeployTempo is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address poseidon2 = vm.envAddress("POSEIDON2");
        vm.startBroadcast(pk);

        // Raw Groth16 verifiers. Same circuits and dev-ceremony keys as Robinhood;
        // the production ceremony is a mainnet-gate item, not a testnet blocker.
        ShieldVerifier shieldG = new ShieldVerifier();
        UnshieldVerifier unshieldG = new UnshieldVerifier();
        TransferVerifier transferG = new TransferVerifier();

        // IVerifier adapters over the raw verifiers.
        ShieldIVerifier shieldI = new ShieldIVerifier(shieldG);
        UnshieldIVerifier unshieldI = new UnshieldIVerifier(unshieldG);
        TransferIVerifier transferI = new TransferIVerifier(transferG);

        // Combined unshield + transfer verifier the pool calls.
        DualProofVerifier dual = new DualProofVerifier(unshieldI, transferI);

        // Hardened pool: shieldBound() is enforced at deposit once the shield
        // verifier is set; sealedSwap stays off (verifier unset) pending H1.
        ShieldPoolPoseidon pool = new ShieldPoolPoseidon(poseidon2, address(dual));
        pool.setShieldVerifier(address(shieldI));

        // FINAL STEP: end setup mode. Irreversible. From here on the owner has no
        // instant power over proofs, pricing, or asset flows: every verifier / rate
        // / oracle setter reverts unless first announced with queueChange() and
        // executed after the 3-day CHANGE_DELAY. There is no emergencyWithdraw, so
        // the owner cannot move user funds at all. Do all wiring ABOVE this line.
        pool.endSetup();

        console2.log("chainId", block.chainid);
        console2.log("poseidon2", poseidon2);
        console2.log("ShieldPoolPoseidon", address(pool));
        console2.log("DualProofVerifier", address(dual));
        console2.log("ShieldIVerifier", address(shieldI));
        console2.log("sealedSwapVerifier (must be 0)", address(pool.sealedSwapVerifier()));
        console2.log("setupMode (must be false)", pool.setupMode());
        console2.log("Next: set pool + deploy block in app/src/lib/networks.ts tempo, flip status to live");

        vm.stopBroadcast();
    }
}
