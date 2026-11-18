// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore} from "../src/ShieldPoolCore.sol";
import {ShieldPoolPayments} from "../src/ShieldPoolPayments.sol";
import {VaultOwnerGuard} from "../src/VaultOwnerGuard.sol";
import {DeployBnbMainnet} from "../script/DeployBnbMainnet.s.sol";
import {DeployGloamPayMemo} from "../script/DeployGloamPayMemo.s.sol";
import {KeyCheckProofs} from "../script/KeyCheckProofs.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {ControllerWallet} from "./DeployElysium.t.sol";

/// A stand-in token with a chosen number of decimals.
contract DecimalsToken {
    uint8 public immutable decimals;
    string public symbol;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint8 d, string memory s) {
        decimals = d;
        symbol = s;
    }

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        allowance[f][msg.sender] -= v;
        balanceOf[f] -= v;
        balanceOf[to] += v;
        return true;
    }
}

/**
 * The BNB Chain deploy (DEPLOY-BNB.md), run in a local EVM from the planned
 * deployer 0xec99...6b60 at nonce 0 with no key, with the settings
 * bnb-mainnet-env.sh writes: USDT and USDC with 18 decimals and BNB with no
 * limit, BDX (9 decimals) capped at 100,000 / 2,000,000, the 0.5% fee to the
 * treasury, and the vault born guarded with the Safe offered the controller
 * seat. It lands at Elysium's addresses (PoseidonT3 0x62c4...3457, vault
 * 0x89d3...2164), byte for byte the same code, and the guard at nonce 16.
 *
 * Like Elysium's, these steps run inside DeployBaseTest's one deploy test: the
 * settings travel in process env vars that tests side by side would overwrite.
 */
abstract contract BnbDeploySteps is Test {
    using stdJson for string;

    uint256 constant BNB_ID = 56;
    address constant B_DEPLOYER = 0xec9993765e249e8e9DC677B7BCB61F78b31c6b60;
    address constant B_TREASURY = 0xB3900ac9350903218e4c7597bAb0f008F01B30B8;
    address constant B_OWNER = 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8;
    address constant B_USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant B_USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address constant B_BDX = 0x6ad12E761b438beA3EA09F6C6266556Bb24C2181;
    /// Where the planned deployer's contracts land: the same as on Elysium.
    address constant B_POSEIDON = 0x62c435CE6886fa91e3b0e91500c6dC9219723457;
    address constant B_POOL = 0x89d3042390204f57b8b4F8949D3c2203E4002164;
    address constant B_DUAL = 0x29053A713E3a7D37053374446869a6f55858FcEf;
    address constant B_SHIELD_I = 0xAEB8cb99B3BB43eB230F9fEB7293fB5E39080016;
    /// The guard: the deployer's nonce 16, after the pool, its setup and four listings.
    address constant B_GUARD = 0x633B24cf4C48CF68cB815BC87C110c47E218B4af;
    /// The memo board, the deployer's next contract after the deploy (nonce 21).
    address constant B_MEMO = 0xb692c86B13f65a123f45cF9A21580b2dDC7B8a79;
    uint128 constant MAX = type(uint128).max;

    function _bnbSteps() internal {
        uint256 snap = vm.snapshotState();
        _bnbRefusals();
        vm.revertToState(snap);
        snap = vm.snapshotState();
        _bnbDeployToSafe();
        vm.revertToState(snap);
        snap = vm.snapshotState();
        _bnbDeployToWallet();
        vm.revertToState(snap);
        _bnbEnvClear();
    }

    /// bnb-mainnet-env.sh's settings with its defaults, from the planned deployer, no key.
    function _bnbEnv(address controller, bool controllerIsWallet) internal {
        vm.chainId(BNB_ID);
        vm.etch(B_USDT, address(new DecimalsToken(18, "USDT")).code);
        vm.etch(B_USDC, address(new DecimalsToken(18, "USDC")).code);
        vm.etch(B_BDX, address(new DecimalsToken(9, "BDX")).code);
        vm.setEnv("DEPLOYER", vm.toString(B_DEPLOYER));
        vm.setEnv("DEPLOYER_PK", "");
        vm.setEnv(
            "LIMIT_ASSETS",
            string.concat(vm.toString(B_USDT), ",", vm.toString(B_USDC), ",", vm.toString(address(0)), ",", vm.toString(B_BDX))
        );
        string memory max = vm.toString(uint256(MAX));
        vm.setEnv("LIMIT_PER_DEPOSIT", string.concat(max, ",", max, ",", max, ",100000000000000"));
        vm.setEnv("LIMIT_TOTAL", string.concat(max, ",", max, ",", max, ",2000000000000000"));
        vm.setEnv("WITHDRAW_FEE_BPS", "50");
        vm.setEnv("FEE_RECIPIENT", vm.toString(B_TREASURY));
        vm.setEnv("NEW_OWNER", "");
        vm.setEnv("NEW_OWNER_EOA", "0");
        vm.setEnv("BNB_ALLOW_OTHER_ASSETS", "0");
        vm.setEnv("GUARD_CONTROLLER", controller == address(0) ? "" : vm.toString(controller));
        vm.setEnv("GUARD_CONTROLLER_EOA", controllerIsWallet ? "1" : "0");
    }

    function _bnbEnvClear() internal {
        vm.setEnv("GUARD_CONTROLLER", "");
        vm.setEnv("GUARD_CONTROLLER_EOA", "0");
        vm.setEnv("DEPLOYER", "");
        vm.setEnv("BNB_ALLOW_OTHER_ASSETS", "0");
    }

    /// Step 4 of the runbook: PoseidonT3 is the deployer's first transaction.
    function _bnbPoseidon() internal returns (address poseidon) {
        assertEq(vm.getNonce(B_DEPLOYER), 0, "a fresh deployer");
        bytes memory bytecode = vm.readFile("test/fixtures/Poseidon2.json").readBytes(".bytecode");
        vm.prank(B_DEPLOYER);
        assembly {
            poseidon := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        assertEq(poseidon, B_POSEIDON, "PoseidonT3 where it is on Elysium");
        vm.setEnv("POSEIDON2", vm.toString(poseidon));
    }

    /// Every way the script must stop before it sends anything.
    function _bnbRefusals() internal {
        ControllerWallet safe = new ControllerWallet();
        _bnbEnv(address(safe), false);
        _bnbPoseidon();
        DeployBnbMainnet s = new DeployBnbMainnet();

        // Only on 56: BNB's testnet (97), every Gloam chain and the local chain are refused.
        uint256[12] memory others = [uint256(97), 1, 4663, 4217, 8453, 99901, 46630, 42431, 84532, 11155111, 99801, 31337];
        for (uint256 i = 0; i < others.length; i++) {
            vm.chainId(others[i]);
            vm.expectRevert(bytes("wrong chain for this script"));
            s.run();
        }
        vm.chainId(BNB_ID);

        // Limits written for 6 decimals (Base's raw 50,000 USDC) would cap USDT at dust: refused.
        string memory max = vm.toString(uint256(MAX));
        vm.setEnv("LIMIT_PER_DEPOSIT", string.concat("50000000000,", max, ",", max, ",100000000000000"));
        vm.expectRevert(bytes("a per-deposit limit is under one whole token: limits must be in the token's own decimals"));
        s.run();
        // BDX's cap written for 18 decimals reads as 100,000 BDX either way; one written for 6 is under one BDX.
        vm.setEnv("LIMIT_PER_DEPOSIT", string.concat(max, ",", max, ",", max, ",100000000"));
        vm.expectRevert(bytes("a per-deposit limit is under one whole token: limits must be in the token's own decimals"));
        s.run();
        vm.setEnv("LIMIT_PER_DEPOSIT", string.concat(max, ",", max, ",", max, ",100000000000000"));

        // Only the four assets, each once.
        address stray = address(new DecimalsToken(18, "FAKE"));
        vm.setEnv(
            "LIMIT_ASSETS",
            string.concat(vm.toString(B_USDT), ",", vm.toString(stray), ",", vm.toString(address(0)), ",", vm.toString(B_BDX))
        );
        vm.expectRevert(bytes("LIMIT_ASSETS lists a token that is not USDT, USDC, BDX or BNB"));
        s.run();
        vm.setEnv(
            "LIMIT_ASSETS",
            string.concat(vm.toString(B_USDT), ",", vm.toString(B_USDT), ",", vm.toString(address(0)), ",", vm.toString(B_BDX))
        );
        vm.expectRevert(bytes("LIMIT_ASSETS lists a token twice"));
        s.run();
        vm.setEnv(
            "LIMIT_ASSETS",
            string.concat(vm.toString(B_USDT), ",", vm.toString(B_USDC), ",", vm.toString(address(0)), ",", vm.toString(B_BDX))
        );

        // The guard is the owner on this path.
        vm.setEnv("NEW_OWNER", vm.toString(B_OWNER));
        vm.expectRevert(bytes("NEW_OWNER must be unset: the guard owns this vault"));
        s.run();
        vm.setEnv("NEW_OWNER", "");

        vm.setEnv("GUARD_CONTROLLER", "");
        vm.expectRevert(bytes("set GUARD_CONTROLLER: who runs the guard (a multisig)"));
        s.run();

        // The Safe not replayed yet: its address has no code, refused unless a wallet is named on purpose.
        vm.setEnv("GUARD_CONTROLLER", vm.toString(address(0x8E74b2b85b40f36771f92392b42BBaeacDC75507)));
        vm.expectRevert(
            bytes("GUARD_CONTROLLER has no code: use a multisig, or set GUARD_CONTROLLER_EOA=1 to hand it to a plain key")
        );
        s.run();

        assertEq(vm.getNonce(B_DEPLOYER), 1, "nothing sent past PoseidonT3");
    }

    /// The runbook as written: the Safe runs the guard.
    function _bnbDeployToSafe() internal {
        ControllerWallet safe = new ControllerWallet();
        _bnbEnv(address(safe), false);
        address poseidon = _bnbPoseidon();
        new DeployBnbMainnet().run();

        ShieldPoolPayments pool = ShieldPoolPayments(payable(B_POOL));
        _checkBnbPool(pool, poseidon);
        // On chain every call is a transaction and moves the nonce, so the guard lands at nonce 16
        // (B_GUARD) and the memo board at 21 (B_MEMO); a forge test moves it on creates only, so
        // those two addresses are checked by the anvil rehearsal in DEPLOY-BNB.md, not here.

        VaultOwnerGuard guard = VaultOwnerGuard(pool.owner());
        assertGt(address(guard).code.length, 0, "the owner is a contract");
        assertEq(address(guard.vault()), address(pool), "the guard names this vault");
        assertEq(guard.controller(), B_DEPLOYER, "the deployer runs it until the Safe accepts");
        assertEq(guard.pendingController(), address(safe), "the Safe is offered the guard");

        // Step 6: the memo board, the deployer's next contract, the same code as on every chain.
        address memo = vm.computeCreateAddress(B_DEPLOYER, vm.getNonce(B_DEPLOYER));
        new DeployGloamPayMemo().run();
        assertEq(keccak256(memo.code), 0xf24e84ff514b7b8e3eba03c4b7ac70bbeb8b799b5fd3006d552a34362cf5edae, "the board's code, as on every chain");

        // Step 7: the Safe accepts (data 0x9bc21c0c); the deployer is out.
        assertEq(abi.encodeCall(VaultOwnerGuard.acceptController, ()), hex"9bc21c0c", "acceptController()'s calldata");
        safe.exec(address(guard), hex"9bc21c0c");
        assertEq(guard.controller(), address(safe));
        assertEq(guard.pendingController(), address(0));
        vm.prank(B_DEPLOYER);
        vm.expectRevert(VaultOwnerGuard.NotController.selector);
        guard.lowerWithdrawFee(0);

        _checkBnbGuardHolds(pool, guard, address(safe));
    }

    /// No Safe on BNB Chain: the owner wallet runs the guard, named on purpose.
    function _bnbDeployToWallet() internal {
        _bnbEnv(B_OWNER, true);
        address poseidon = _bnbPoseidon();
        new DeployBnbMainnet().run();
        ShieldPoolPayments pool = ShieldPoolPayments(payable(B_POOL));
        _checkBnbPool(pool, poseidon);
        VaultOwnerGuard guard = VaultOwnerGuard(pool.owner());
        assertEq(guard.pendingController(), B_OWNER, "the owner wallet is offered the guard");
        vm.prank(B_OWNER);
        guard.acceptController();
        assertEq(guard.controller(), B_OWNER);
    }

    function _checkBnbPool(ShieldPoolPayments pool, address poseidon) internal view {
        assertGt(address(pool).code.length, 0, "the vault at Elysium's address");
        assertEq(address(pool.poseidon2()), poseidon);
        assertEq(address(pool.verifier()), B_DUAL, "DualProofVerifier at Elysium's address");
        assertEq(address(pool.shieldVerifier()), B_SHIELD_I, "shield verifier at Elysium's address");
        // Byte for byte Elysium's code (read from its live contracts): same source, same addresses.
        assertEq(keccak256(address(pool).code), 0x6c08d853f894304930eb234dac17256cdbe0bf1141c3c0df2ef61690603c629d, "vault code = Elysium's");
        assertEq(keccak256(B_DUAL.code), 0xa3b1c3d3f4fc9393ffdee6ab52ec8590e2d07ba230dd236ee8837d97e81e45ef, "DualProofVerifier = Elysium's");
        assertEq(keccak256(B_SHIELD_I.code), 0xabdd6484a23bcb1c26d272c7ed95c616e6a55838f0d819ca33eb4f7ff276eadb, "ShieldIVerifierFinal = Elysium's");
        assertTrue(pool.depositLimitsOn(), "limits on");
        assertFalse(pool.setupMode(), "setup ended");
        assertEq(pool.withdrawFeeBps(), 50, "0.5% cash-out fee");
        assertEq(pool.feeRecipient(), B_TREASURY, "fee to the treasury");
        address[3] memory open = [B_USDT, B_USDC, address(0)];
        for (uint256 i = 0; i < open.length; i++) {
            (uint128 per, uint128 total) = pool.depositLimit(open[i]);
            assertEq(per, MAX, "no limit per deposit");
            assertEq(total, MAX, "no limit in total");
        }
        (uint128 bper, uint128 btotal) = pool.depositLimit(B_BDX);
        assertEq(bper, 100_000e9, "100,000 BDX per deposit, 9 decimals");
        assertEq(btotal, 2_000_000e9, "2,000,000 BDX in total");
        assertEq(pool.pendingOwner(), address(0), "nobody else offered the vault");

        IVerifier dual = pool.verifier();
        IVerifier shieldI = pool.shieldVerifier();
        (bytes memory p, uint256[] memory pub) = KeyCheckProofs.shieldFinal();
        assertTrue(shieldI.verify(p, pub), "shield: final-key proof");
        (p, pub) = KeyCheckProofs.shieldDev();
        assertFalse(shieldI.verify(p, pub), "shield: dev-key proof");
        (p, pub) = KeyCheckProofs.unshieldFinal();
        assertTrue(dual.verify(p, pub), "unshield: final-key proof");
        (p, pub) = KeyCheckProofs.transferDev();
        assertFalse(dual.verify(p, pub), "transfer: dev-key proof");
    }

    /// Nobody can swap a proof checker or move the vault; the Safe can still run limits and the fee.
    function _checkBnbGuardHolds(ShieldPoolPayments pool, VaultOwnerGuard guard, address safe) internal {
        address evil = address(0xBAD);
        bytes memory setVerifier = abi.encodeCall(ShieldPoolCore.setVerifier, (evil));
        vm.expectRevert(VaultOwnerGuard.ChangeNotAllowed.selector);
        ControllerWallet(safe).exec(address(guard), abi.encodeCall(VaultOwnerGuard.queueChange, (setVerifier)));
        address[3] memory callers = [B_DEPLOYER, safe, address(0xCAFE)];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.startPrank(callers[i]);
            vm.expectRevert(ShieldPoolCore.NotOwner.selector);
            pool.setVerifier(evil);
            vm.expectRevert(ShieldPoolCore.NotOwner.selector);
            pool.transferOwnership(callers[i]);
            vm.stopPrank();
        }
        // An incident: the Safe closes BDX at once (no timelock to lower), and queues a raise.
        ControllerWallet(safe).exec(
            address(guard), abi.encodeCall(VaultOwnerGuard.lowerDepositLimit, (B_BDX, uint128(0), uint128(0)))
        );
        (uint128 per,) = pool.depositLimit(B_BDX);
        assertEq(per, 0, "BDX closed at once");
        bytes memory raise = abi.encodeCall(ShieldPoolCore.setDepositLimit, (B_BDX, uint128(100_000e9), uint128(2_000_000e9)));
        ControllerWallet(safe).exec(address(guard), abi.encodeCall(VaultOwnerGuard.queueChange, (raise)));
    }
}
