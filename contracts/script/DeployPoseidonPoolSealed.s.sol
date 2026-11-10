// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";
import {ShieldPoolPoseidon} from "../src/ShieldPoolPoseidon.sol";
import {SealedSwapGuard} from "./SealedSwapGuard.sol";

/**
 * Deploy a Poseidon vault WITH the sealed swap verifier wired.
 *
 * GUARDED (audit L-2 / ZK-1, 2026-10-11). Sealed swap must stay off until H1 and
 * ZK-1 are fixed and a new circuit + ceremony is done; see SealedSwapGuard.sol.
 * The script reverts unless GLOAM_ACK_SEALED_SWAP_H1_ZK1=1. To deploy a pool with
 * sealed swap off, use script/archive/DeployTempoPool.s.sol (works on any chain).
 *
 * There are no hardcoded addresses. The old defaults (DualProofVerifier
 * 0x4B0D…949C, Poseidon2 0xcc2d…0947, the old sealed swap adapter) are superseded
 * and must not be wired again, so every address comes from env.
 *
 * Ends with endSetup(), after which every verifier/rate/oracle change needs the
 * 3-day timelock. So the shield verifier (C1 fix) is wired here too: ending setup
 * without it would leave the unbound shield() path open for at least 3 days.
 * Swap rates are NOT set here; add setSwapRate(...) calls before endSetup() if the
 * pool should launch with a pair enabled.
 *
 *   export GLOAM_ACK_SEALED_SWAP_H1_ZK1=1   # only once H1 + ZK-1 are fixed
 *   export DEPLOYER_PK=0x...
 *   export POSEIDON2=0x...               # Poseidon2 on the same chain
 *   export DUAL_VERIFIER=0x...           # current DualProofVerifier
 *   export SEALED_SWAP_IVERIFIER=0x...   # adapter for the NEW sealedSwap circuit
 *   export SHIELD_IVERIFIER=0x...        # ShieldIVerifier on the same chain
 *   export RPC_URL=https://rpc.testnet.chain.robinhood.com
 *   forge script script/DeployPoseidonPoolSealed.s.sol:DeployPoseidonPoolSealed \
 *     --rpc-url $RPC_URL --broadcast
 *
 * Then point the app at the new pool:
 *   NEXT_PUBLIC_POSEIDON_SHIELD_POOL=<new>
 *   NEXT_PUBLIC_SHIELD_DEPLOY_BLOCK=<block>
 * Or update app/src/lib/config.ts TESTNET_POSEIDON_POOL defaults.
 */
contract DeployPoseidonPoolSealed is SealedSwapGuard {
    function run() external {
        _requireSealedSwapAck();

        uint256 pk = vm.envUint("DEPLOYER_PK");
        address poseidon2 = vm.envAddress("POSEIDON2");
        address dual = vm.envAddress("DUAL_VERIFIER");
        address sealedSwapI = vm.envAddress("SEALED_SWAP_IVERIFIER");
        address shieldI = vm.envAddress("SHIELD_IVERIFIER");
        vm.startBroadcast(pk);

        // Constructor: (poseidon2, unshield/transfer dual verifier)
        ShieldPoolPoseidon pool = new ShieldPoolPoseidon(poseidon2, dual);
        pool.setSealedSwapVerifier(sealedSwapI);
        pool.setShieldVerifier(shieldI);

        // FINAL STEP: end setup mode. Irreversible. From here on the owner has no
        // instant power over proofs, pricing, or asset flows: every verifier / rate
        // / oracle setter reverts unless first announced with queueChange() and
        // executed after the 3-day CHANGE_DELAY. There is no emergencyWithdraw, so
        // the owner cannot move user funds at all. Do all wiring ABOVE this line.
        pool.endSetup();

        console2.log("ShieldPoolPoseidon (sealed)", address(pool));
        console2.log("verifier (dual)", address(pool.verifier()));
        console2.log("sealedSwapVerifier", address(pool.sealedSwapVerifier()));
        console2.log("shieldVerifier", address(pool.shieldVerifier()));
        console2.log("setupMode (must be false)", pool.setupMode());
        console2.log("Update app: NEXT_PUBLIC_POSEIDON_SHIELD_POOL + deploy block");

        vm.stopBroadcast();
    }
}
