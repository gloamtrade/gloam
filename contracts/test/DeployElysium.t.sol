// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore} from "../src/ShieldPoolCore.sol";
import {ShieldPoolPayments} from "../src/ShieldPoolPayments.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {VaultOwnerGuard} from "../src/VaultOwnerGuard.sol";
import {DeployElysiumMainnet} from "../script/DeployElysiumMainnet.s.sol";
import {DeployElysiumTestnet} from "../script/DeployElysiumTestnet.s.sol";
import {KeyCheckProofs} from "../script/KeyCheckProofs.sol";
import {MockERC20} from "./MockERC20.sol";

/// Stands in for the multisig that runs the guard: it only forwards calls.
contract ControllerWallet {
    function exec(address to, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = to.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}

/**
 * The Elysium deploy (DEPLOY-ELYSIUM.md), run in a local EVM from the real
 * deployer at nonce 0 with no key: the vault lands at its address on every other
 * chain, is wired like them, and is born guarded. Its owner is a VaultOwnerGuard,
 * so nobody can replace a proof checker or move the vault, the deployer included.
 *
 * The settings travel in process env vars, which tests running side by side would
 * overwrite for each other, so these steps run inside DeployBaseTest's one deploy
 * test (test/DeployBase.t.sol), each from a state snapshot it rolls back.
 */
abstract contract ElysiumDeploySteps is Test {
    using stdJson for string;

    /// Where Elysium mainnet is pretended to be: its real id was not public yet.
    uint256 constant ELYSIUM_ID = 99_901;
    address constant E_DEPLOYER = 0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411;
    address constant E_TREASURY = 0xB3900ac9350903218e4c7597bAb0f008F01B30B8;
    address constant E_OWNER = 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8;
    /// A stand-in for Elysium's USDC.
    address constant E_USDC = 0x00000000000000000000000000000000e1EC05d1;
    address constant CANON_POSEIDON = 0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4;
    address constant CANON_POOL = 0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194;
    address constant CANON_DUAL = 0x1421353d471dF6C847713aee391Db38978fE714a;
    address constant CANON_SHIELD_I = 0x69Fa6d2De0A66dA718DF022cEe98485AfDb03465;
    /// Elysium testnet: its chain id and Kinetiq's test USDC (packages/sdk/src/elysium.ts).
    uint256 constant ELYSIUM_TESTNET_ID = 99801;
    address constant E_TESTNET_USDC = 0x7D29d8047B905000459c0E80c34a26CeedcB47b2;

    function _elysiumSteps() internal {
        uint256 snap = vm.snapshotState();
        _elysiumRefusals();
        vm.revertToState(snap);
        snap = vm.snapshotState();
        _elysiumDeployToMultisig();
        vm.revertToState(snap);
        snap = vm.snapshotState();
        _elysiumDeployToWallet();
        vm.revertToState(snap);
        snap = vm.snapshotState();
        _elysiumTestnetRefusals();
        vm.revertToState(snap);
        snap = vm.snapshotState();
        _elysiumTestnetDeploy();
        vm.revertToState(snap);
        _elysiumEnvClear();
    }

    /// Elysium testnet's settings (elysium-testnet-env.sh): test USDC only, at Base Sepolia's testnet limits.
    function _elysiumTestnetEnv(address controller, bool controllerIsWallet) internal {
        _elysiumEnv(controller, controllerIsWallet);
        vm.chainId(ELYSIUM_TESTNET_ID);
        vm.etch(E_TESTNET_USDC, address(new MockERC20()).code);
        vm.setEnv("ELYSIUM_CHAIN_ID", "99801");
        vm.setEnv("LIMIT_ASSETS", vm.toString(E_TESTNET_USDC));
    }

    /// The testnet script stops before it sends anything when a setting is off.
    function _elysiumTestnetRefusals() internal {
        ControllerWallet multisig = new ControllerWallet();
        _elysiumTestnetEnv(address(multisig), false);
        _elysiumPoseidon();
        DeployElysiumTestnet s = new DeployElysiumTestnet();
        assertEq(s.ELYSIUM_TESTNET(), 99801, "the testnet id, fixed");

        // Only on 99801: Elysium mainnet (99901) and every other chain are refused.
        uint256[10] memory others = [uint256(99901), 1, 4663, 4217, 8453, 46630, 42431, 84532, 11155111, 31337];
        for (uint256 i = 0; i < others.length; i++) {
            vm.chainId(others[i]);
            vm.expectRevert(bytes("wrong chain for this script"));
            s.run();
        }
        vm.chainId(ELYSIUM_TESTNET_ID);

        vm.setEnv("NEW_OWNER", vm.toString(E_OWNER));
        vm.expectRevert(bytes("NEW_OWNER must be unset: the guard owns this vault"));
        s.run();
        vm.setEnv("NEW_OWNER", "");

        vm.setEnv("GUARD_CONTROLLER", "");
        vm.expectRevert(bytes("set GUARD_CONTROLLER: who runs the guard (a multisig)"));
        s.run();
        vm.setEnv("GUARD_CONTROLLER", vm.toString(address(multisig)));

        // USDC only: native test HYPE is never listed here.
        vm.setEnv("LIMIT_ASSETS", string.concat(vm.toString(E_TESTNET_USDC), ",", vm.toString(address(0))));
        vm.setEnv("LIMIT_PER_DEPOSIT", "500000000,1000000000000000000");
        vm.setEnv("LIMIT_TOTAL", "25000000000,10000000000000000000");
        vm.expectRevert(bytes("this chain has no native coin to list"));
        s.run();

        assertEq(vm.getNonce(E_DEPLOYER), 1, "nothing sent past PoseidonT3");
    }

    /// The testnet deploy: the same vault at the same address, born guarded, test USDC at 500 / 25,000.
    function _elysiumTestnetDeploy() internal {
        ControllerWallet multisig = new ControllerWallet();
        _elysiumTestnetEnv(address(multisig), false);
        address poseidon = _elysiumPoseidon();
        new DeployElysiumTestnet().run();

        ShieldPoolPayments pool = ShieldPoolPayments(payable(CANON_POOL));
        _checkElysiumPoolFor(pool, poseidon, E_TESTNET_USDC);
        VaultOwnerGuard guard = VaultOwnerGuard(pool.owner());
        assertEq(address(guard.vault()), address(pool), "the guard names this vault");
        assertEq(guard.controller(), E_DEPLOYER, "the deployer runs it until the multisig accepts");
        assertEq(guard.pendingController(), address(multisig), "the multisig is offered the guard");
        multisig.exec(address(guard), abi.encodeCall(VaultOwnerGuard.acceptController, ()));
        assertEq(guard.controller(), address(multisig));
        _checkGuardHoldsFor(pool, guard, address(multisig), true, E_TESTNET_USDC);
    }

    /// DEPLOY-ELYSIUM.md's settings, from the deployer with no key in the environment.
    function _elysiumEnv(address controller, bool controllerIsWallet) internal {
        vm.chainId(ELYSIUM_ID);
        vm.etch(E_USDC, address(new MockERC20()).code);
        vm.setEnv("ELYSIUM_CHAIN_ID", vm.toString(ELYSIUM_ID));
        vm.setEnv("ELYSIUM_ALLOW_TESTNET", "0");
        vm.setEnv("DEPLOYER", vm.toString(E_DEPLOYER));
        vm.setEnv("DEPLOYER_PK", "");
        vm.setEnv("LIMIT_ASSETS", vm.toString(E_USDC));
        vm.setEnv("LIMIT_PER_DEPOSIT", "500000000");
        vm.setEnv("LIMIT_TOTAL", "25000000000");
        vm.setEnv("WITHDRAW_FEE_BPS", "50");
        vm.setEnv("FEE_RECIPIENT", vm.toString(E_TREASURY));
        vm.setEnv("NEW_OWNER", "");
        vm.setEnv("NEW_OWNER_EOA", "0");
        vm.setEnv("GUARD_CONTROLLER", controller == address(0) ? "" : vm.toString(controller));
        vm.setEnv("GUARD_CONTROLLER_EOA", controllerIsWallet ? "1" : "0");
    }

    function _elysiumEnvClear() internal {
        vm.setEnv("ELYSIUM_CHAIN_ID", "0");
        vm.setEnv("GUARD_CONTROLLER", "");
        vm.setEnv("GUARD_CONTROLLER_EOA", "0");
        vm.setEnv("DEPLOYER", "");
    }

    /// Step 3 of the runbook: PoseidonT3 is the deployer's first transaction.
    function _elysiumPoseidon() internal returns (address poseidon) {
        assertEq(vm.getNonce(E_DEPLOYER), 0, "a fresh deployer");
        bytes memory bytecode = vm.readFile("test/fixtures/Poseidon2.json").readBytes(".bytecode");
        vm.prank(E_DEPLOYER);
        assembly {
            poseidon := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        assertEq(poseidon, CANON_POSEIDON, "PoseidonT3 where it is on the other chains");
        vm.setEnv("POSEIDON2", vm.toString(poseidon));
    }

    /// Every way the script must stop before it sends anything.
    function _elysiumRefusals() internal {
        ControllerWallet multisig = new ControllerWallet();
        _elysiumEnv(address(multisig), false);
        _elysiumPoseidon();
        DeployElysiumMainnet s = new DeployElysiumMainnet();

        vm.setEnv("ELYSIUM_CHAIN_ID", "0");
        vm.expectRevert(bytes("set ELYSIUM_CHAIN_ID: Elysium mainnet's chain id"));
        s.run();

        // Any id but Elysium mainnet's (99901) is refused.
        vm.setEnv("ELYSIUM_CHAIN_ID", "999998");
        vm.expectRevert(bytes("ELYSIUM_CHAIN_ID must be 99901, Elysium mainnet's"));
        s.run();

        // The id names another chain than the RPC it runs on.
        vm.chainId(999_998);
        vm.setEnv("ELYSIUM_CHAIN_ID", "99901");
        vm.expectRevert(bytes("wrong chain for this script"));
        s.run();
        vm.chainId(ELYSIUM_ID);

        // Elysium's testnet, unless a rehearsal there is asked for.
        vm.chainId(99801);
        vm.setEnv("ELYSIUM_CHAIN_ID", "99801");
        vm.expectRevert(bytes("ELYSIUM_CHAIN_ID is the Elysium testnet: set ELYSIUM_ALLOW_TESTNET=1 for a rehearsal there"));
        s.run();

        // A chain Gloam already runs on is never Elysium.
        uint256[8] memory others = [uint256(1), 4663, 4217, 8453, 46630, 42431, 84532, 11155111];
        for (uint256 i = 0; i < others.length; i++) {
            vm.chainId(others[i]);
            vm.setEnv("ELYSIUM_CHAIN_ID", vm.toString(others[i]));
            vm.expectRevert(bytes("ELYSIUM_CHAIN_ID is another Gloam chain, not Elysium"));
            s.run();
        }
        vm.chainId(ELYSIUM_ID);
        vm.setEnv("ELYSIUM_CHAIN_ID", vm.toString(ELYSIUM_ID));

        // The guard is the owner on this path: a NEW_OWNER would be a second owner.
        vm.setEnv("NEW_OWNER", vm.toString(E_OWNER));
        vm.expectRevert(bytes("NEW_OWNER must be unset: the guard owns this vault"));
        s.run();
        vm.setEnv("NEW_OWNER", "");

        vm.setEnv("GUARD_CONTROLLER", "");
        vm.expectRevert(bytes("set GUARD_CONTROLLER: who runs the guard (a multisig)"));
        s.run();

        // A plain wallet only when asked for by name.
        vm.setEnv("GUARD_CONTROLLER", vm.toString(E_OWNER));
        vm.expectRevert(
            bytes("GUARD_CONTROLLER has no code: use a multisig, or set GUARD_CONTROLLER_EOA=1 to hand it to a plain key")
        );
        s.run();

        assertEq(vm.getNonce(E_DEPLOYER), 1, "nothing sent past PoseidonT3");
    }

    /// The runbook as written, with a multisig running the guard.
    function _elysiumDeployToMultisig() internal {
        ControllerWallet multisig = new ControllerWallet();
        _elysiumEnv(address(multisig), false);
        address poseidon = _elysiumPoseidon();
        new DeployElysiumMainnet().run();

        ShieldPoolPayments pool = ShieldPoolPayments(payable(CANON_POOL));
        _checkElysiumPool(pool, poseidon);

        // The guard is the deployer's next contract after the pool and its setup calls.
        VaultOwnerGuard guard = VaultOwnerGuard(pool.owner());
        assertGt(address(guard).code.length, 0, "the owner is a contract");
        assertEq(address(guard.vault()), address(pool), "the guard names this vault");
        assertEq(guard.controller(), E_DEPLOYER, "the deployer runs it until the multisig accepts");
        assertEq(guard.pendingController(), address(multisig), "the multisig is offered the guard");

        // The multisig accepts; the deployer is out.
        multisig.exec(address(guard), abi.encodeCall(VaultOwnerGuard.acceptController, ()));
        assertEq(guard.controller(), address(multisig));
        assertEq(guard.pendingController(), address(0));
        vm.prank(E_DEPLOYER);
        vm.expectRevert(VaultOwnerGuard.NotController.selector);
        guard.lowerWithdrawFee(0);

        _checkGuardHolds(pool, guard, address(multisig), true);
    }

    /// No Safe on Elysium yet: the owner wallet runs the guard, named on purpose.
    function _elysiumDeployToWallet() internal {
        _elysiumEnv(E_DEPLOYER, true);
        address poseidon = _elysiumPoseidon();
        new DeployElysiumMainnet().run();

        ShieldPoolPayments pool = ShieldPoolPayments(payable(CANON_POOL));
        _checkElysiumPool(pool, poseidon);
        VaultOwnerGuard guard = VaultOwnerGuard(pool.owner());
        assertEq(guard.controller(), E_DEPLOYER, "the deployer runs it, nothing pending");
        assertEq(guard.pendingController(), address(0));
        _checkGuardHolds(pool, guard, E_DEPLOYER, false);
    }

    function _checkElysiumPool(ShieldPoolPayments pool, address poseidon) internal view {
        _checkElysiumPoolFor(pool, poseidon, E_USDC);
    }

    function _checkElysiumPoolFor(ShieldPoolPayments pool, address poseidon, address usdc) internal view {
        assertGt(address(pool).code.length, 0, "the vault at its address on every other chain");
        assertEq(address(pool.poseidon2()), poseidon);
        assertEq(address(pool.verifier()), CANON_DUAL, "DualProofVerifier at its usual address");
        assertEq(address(pool.shieldVerifier()), CANON_SHIELD_I, "shield verifier at its usual address");
        assertTrue(pool.depositLimitsOn(), "limits on");
        assertFalse(pool.setupMode(), "setup ended");
        assertEq(pool.withdrawFeeBps(), 50, "0.5% cash-out fee");
        assertEq(pool.feeRecipient(), E_TREASURY, "fee to the treasury");
        (uint128 per, uint128 total) = pool.depositLimit(usdc);
        assertEq(per, 500e6, "500 USDC per deposit");
        assertEq(total, 25_000e6, "25,000 USDC in total");
        (per, total) = pool.depositLimit(address(0));
        assertEq(per, 0, "HYPE not listed");
        assertEq(total, 0);
        assertEq(pool.pendingOwner(), address(0), "nobody else offered the vault");

        // The verifiers hold the ceremony's final keys.
        IVerifier dual = pool.verifier();
        IVerifier shieldI = pool.shieldVerifier();
        (bytes memory p, uint256[] memory pub) = KeyCheckProofs.shieldFinal();
        assertTrue(shieldI.verify(p, pub), "shield: final-key proof");
        (p, pub) = KeyCheckProofs.shieldDev();
        assertFalse(shieldI.verify(p, pub), "shield: dev-key proof");
        (p, pub) = KeyCheckProofs.unshieldFinal();
        assertTrue(dual.verify(p, pub), "unshield: final-key proof");
        (p, pub) = KeyCheckProofs.unshieldDev();
        assertFalse(dual.verify(p, pub), "unshield: dev-key proof");
        (p, pub) = KeyCheckProofs.transferFinal();
        assertTrue(dual.verify(p, pub), "transfer: final-key proof");
        (p, pub) = KeyCheckProofs.transferDev();
        assertFalse(dual.verify(p, pub), "transfer: dev-key proof");
    }

    /// Nobody can swap a proof checker or move the vault; the controller can still run limits and the fee.
    function _checkGuardHolds(ShieldPoolPayments pool, VaultOwnerGuard guard, address controller, bool viaWallet)
        internal
    {
        _checkGuardHoldsFor(pool, guard, controller, viaWallet, E_USDC);
    }

    function _checkGuardHoldsFor(
        ShieldPoolPayments pool,
        VaultOwnerGuard guard,
        address controller,
        bool viaWallet,
        address usdc
    ) internal {
        address evil = address(0xBAD);
        bytes memory setVerifier = abi.encodeCall(ShieldPoolCore.setVerifier, (evil));
        bytes memory setShield = abi.encodeCall(ShieldPoolCore.setShieldVerifier, (evil));

        // Through the guard, as its controller: refused by the filter.
        bytes[2] memory banned = [setVerifier, setShield];
        for (uint256 i = 0; i < banned.length; i++) {
            bytes[3] memory routes = [
                abi.encodeCall(VaultOwnerGuard.queueChange, (banned[i])),
                abi.encodeCall(VaultOwnerGuard.executeChange, (banned[i])),
                abi.encodeCall(VaultOwnerGuard.cancelChange, (banned[i]))
            ];
            for (uint256 j = 0; j < routes.length; j++) {
                vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
                _asController(guard, controller, viaWallet, routes[j]);
            }
        }

        // Straight at the vault, from the old deployer, the controller or anyone: not the owner.
        address[3] memory callers = [E_DEPLOYER, controller, address(0xCAFE)];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.startPrank(callers[i]);
            vm.expectRevert(ShieldPoolCore.NotOwner.selector);
            pool.setVerifier(evil);
            vm.expectRevert(ShieldPoolCore.NotOwner.selector);
            pool.queueChange(setVerifier);
            vm.expectRevert(ShieldPoolCore.NotOwner.selector);
            pool.transferOwnership(callers[i]);
            vm.stopPrank();
        }
        // The guard cannot be offered the vault again, and has no call that moves it.
        vm.expectRevert(VaultOwnerGuard.AlreadyVaultOwner.selector);
        _asController(guard, controller, viaWallet, abi.encodeCall(VaultOwnerGuard.acceptVaultOwnership, ()));
        assertEq(address(pool.verifier()), CANON_DUAL);
        assertEq(address(pool.shieldVerifier()), CANON_SHIELD_I);
        assertEq(pool.owner(), address(guard));

        // What the guard is for still works: queue a limit raise, lower the fee at once.
        bytes memory raise = abi.encodeCall(ShieldPoolCore.setDepositLimit, (usdc, uint128(1_000e6), uint128(50_000e6)));
        _asController(guard, controller, viaWallet, abi.encodeCall(VaultOwnerGuard.queueChange, (raise)));
        _asController(guard, controller, viaWallet, abi.encodeCall(VaultOwnerGuard.lowerWithdrawFee, (uint16(25))));
        assertEq(pool.withdrawFeeBps(), 25);
    }

    function _asController(VaultOwnerGuard guard, address controller, bool viaWallet, bytes memory data) internal {
        if (viaWallet) {
            ControllerWallet(controller).exec(address(guard), data);
        } else {
            vm.prank(controller);
            (bool ok, bytes memory ret) = address(guard).call(data);
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }
}
