// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolPayments} from "../src/ShieldPoolPayments.sol";
import {DeployBaseSepolia} from "../script/DeployBaseSepolia.s.sol";
import {DeployBaseMainnet} from "../script/DeployBaseMainnet.s.sol";
import {DeployEthereumMainnet} from "../script/DeployEthereumMainnet.s.sol";
import {MockERC20} from "./MockERC20.sol";
import {DeployEthereumSepolia} from "../script/DeployEthereumSepolia.s.sol";
import {DeployGloamPayMemo} from "../script/DeployGloamPayMemo.s.sol";
import {ElysiumDeploySteps} from "./DeployElysium.t.sol";

/**
 * The Base deploy scripts, run in a local EVM with the exact settings in
 * DEPLOY-BASE.md, and the Ethereum one with those in DEPLOY-ETHEREUM.md: each
 * runs only on its own chain (test/DeployChains.t.sol covers every script),
 * lists native ETH next to the stablecoins with the beta limits, sets the 0.25%
 * cash-out fee for the treasury, starts the handoff to the owner wallet and
 * ends setup. Elysium's guarded deploy runs here too (test/DeployElysium.t.sol).
 */
contract DeployBaseTest is Test, ElysiumDeploySteps {
    using stdJson for string;

    // Not a real key: a local test signer only.
    uint256 constant PK = 0xB45E;
    address constant TREASURY = 0xB3900ac9350903218e4c7597bAb0f008F01B30B8;
    address constant OWNER = 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8;

    address constant SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant SEPOLIA_EURC = 0x808456652fdb597867f38412077A9182bf77359F;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant EURC = 0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42;
    address constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;

    address constant ETH_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant ETH_USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address constant ETH_USDG = 0xe343167631d89B6Ffc58B88d6b7fB0228795491D;
    address constant ETH_PYUSD = 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8;
    address constant ETH_EURC = 0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c;

    function _env(string memory assets, string memory per, string memory total) internal {
        vm.setEnv("DEPLOYER_PK", vm.toString(bytes32(PK)));
        vm.setEnv("POSEIDON2", vm.toString(_deployPoseidon()));
        vm.setEnv("LIMIT_ASSETS", assets);
        vm.setEnv("LIMIT_PER_DEPOSIT", per);
        vm.setEnv("LIMIT_TOTAL", total);
        vm.setEnv("WITHDRAW_FEE_BPS", "25");
        vm.setEnv("FEE_RECIPIENT", vm.toString(TREASURY));
        vm.setEnv("NEW_OWNER", vm.toString(OWNER));
        vm.setEnv("NEW_OWNER_EOA", "1");
    }

    function _token(address at) internal {
        vm.etch(at, address(new MockERC20()).code);
    }

    /// The pool is the eighth contract the deployer creates (after three verifiers, their adapters and DualProofVerifier).
    function _poolAfter(uint256 nonceBefore) internal view returns (ShieldPoolPayments) {
        return ShieldPoolPayments(payable(vm.computeCreateAddress(vm.addr(PK), nonceBefore + 7)));
    }

    function _checkLimit(ShieldPoolPayments pool, address asset, uint256 per, uint256 total) internal view {
        (uint128 p, uint128 t) = pool.depositLimit(asset);
        assertEq(p, per, "perDeposit");
        assertEq(t, total, "total");
    }

    function _checkCommon(ShieldPoolPayments pool) internal view {
        assertTrue(pool.depositLimitsOn(), "limits on");
        assertFalse(pool.setupMode(), "setup ended");
        assertEq(pool.withdrawFeeBps(), 25, "fee");
        assertEq(pool.feeRecipient(), TREASURY, "fee recipient");
        assertEq(pool.pendingOwner(), OWNER, "pending owner");
        // ETH: 0.2 per deposit, 10 in total
        _checkLimit(pool, address(0), 0.2 ether, 10 ether);
    }

    function test_sepolia_refuses_other_chains() public {
        DeployBaseSepolia s = new DeployBaseSepolia();
        vm.expectRevert(bytes("wrong chain for this script"));
        s.run();
        vm.chainId(8453);
        vm.expectRevert(bytes("wrong chain for this script"));
        s.run();
    }

    function test_mainnet_refuses_other_chains() public {
        DeployBaseMainnet s = new DeployBaseMainnet();
        vm.expectRevert(bytes("wrong chain for this script"));
        s.run();
        vm.chainId(84532);
        vm.expectRevert(bytes("wrong chain for this script"));
        s.run();
    }

    /// One test runs every deploy in turn: the settings travel in process env vars,
    /// which tests running side by side would overwrite for each other. So the
    /// Ethereum deploy runs here too, not in a test file of its own.
    function test_deploys_with_runbook_settings() public {
        // Elysium (test/DeployElysium.t.sol) first, from the fresh deployer, rolled back after.
        _elysiumSteps();
        _ethereumSepoliaDeploy();
        _sepoliaDeploy();
        _mainnetDeploy();
        _ethereumDeploy();
    }

    function _sepoliaDeploy() internal {
        vm.chainId(84532);
        _token(SEPOLIA_USDC);
        _token(SEPOLIA_EURC);
        _env(
            string.concat(vm.toString(SEPOLIA_USDC), ",", vm.toString(SEPOLIA_EURC), ",0x0000000000000000000000000000000000000000"),
            "500000000,500000000,200000000000000000",
            "25000000000,25000000000,10000000000000000000"
        );
        uint256 n = vm.getNonce(vm.addr(PK));
        new DeployBaseSepolia().run();
        ShieldPoolPayments pool = _poolAfter(n);
        _checkCommon(pool);
        _checkLimit(pool, SEPOLIA_USDC, 500e6, 25_000e6);
        _checkLimit(pool, SEPOLIA_EURC, 500e6, 25_000e6);
        _checkLimit(pool, USDT, 0, 0);
    }

    function _mainnetDeploy() internal {
        vm.chainId(8453);
        _token(USDC);
        _token(EURC);
        _token(USDT);
        _env(
            string.concat(vm.toString(USDC), ",", vm.toString(EURC), ",", vm.toString(USDT), ",0x0000000000000000000000000000000000000000"),
            "500000000,500000000,500000000,200000000000000000",
            "25000000000,25000000000,25000000000,10000000000000000000"
        );
        uint256 n = vm.getNonce(vm.addr(PK));
        new DeployBaseMainnet().run();
        ShieldPoolPayments pool = _poolAfter(n);
        _checkCommon(pool);
        _checkLimit(pool, USDC, 500e6, 25_000e6);
        _checkLimit(pool, EURC, 500e6, 25_000e6);
        _checkLimit(pool, USDT, 500e6, 25_000e6);
    }

    function _ethereumDeploy() internal {
        vm.chainId(1);
        address[5] memory stables = [ETH_USDC, ETH_USDT, ETH_USDG, ETH_PYUSD, ETH_EURC];
        string memory assets;
        for (uint256 i = 0; i < stables.length; i++) {
            _token(stables[i]);
            assets = string.concat(assets, vm.toString(stables[i]), ",");
        }
        _env(
            string.concat(assets, "0x0000000000000000000000000000000000000000"),
            "500000000,500000000,500000000,500000000,500000000,200000000000000000",
            "25000000000,25000000000,25000000000,25000000000,25000000000,10000000000000000000"
        );
        uint256 n = vm.getNonce(vm.addr(PK));
        new DeployEthereumMainnet().run();
        ShieldPoolPayments pool = _poolAfter(n);
        _checkCommon(pool);
        for (uint256 i = 0; i < stables.length; i++) {
            _checkLimit(pool, stables[i], 500e6, 25_000e6);
        }
        // Base's assets are not listed on Ethereum
        _checkLimit(pool, USDC, 0, 0);
        _checkLimit(pool, USDT, 0, 0);
    }

    function _deployPoseidon() internal returns (address addr) {
        bytes memory bytecode = vm.readFile("test/fixtures/Poseidon2.json").readBytes(".bytecode");
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "poseidon deploy failed");
    }

    // ---------------------------------------------------------------- Ethereum Sepolia

    /// The real deployer: no key in this test, it runs as the address (script/DeployerBroadcast.sol).
    address constant DEPLOYER = 0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411;
    address constant ETH_SEPOLIA_USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address constant ETH_SEPOLIA_USDG = 0xfBb2A78CceEb415b00300925e464C3E44E6e06b0;
    address constant ETH_SEPOLIA_PYUSD = 0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9;
    address constant ETH_SEPOLIA_EURC = 0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4;

    /// DEPLOY-ETHEREUM-SEPOLIA.md as written, from the real deployer at nonce 0: PoseidonT3,
    /// the vault and its verifiers, and the memo board land where they did on the other
    /// chains, with the runbook's assets, limits, fee and owner handoff.
    function _ethereumSepoliaDeploy() internal {
        vm.chainId(11155111);
        assertEq(vm.getNonce(DEPLOYER), 0, "a fresh deployer, as on Sepolia");
        address[4] memory stables = [ETH_SEPOLIA_USDC, ETH_SEPOLIA_USDG, ETH_SEPOLIA_PYUSD, ETH_SEPOLIA_EURC];
        string memory assets;
        for (uint256 i = 0; i < stables.length; i++) {
            _token(stables[i]);
            assets = string.concat(assets, vm.toString(stables[i]), ",");
        }
        _env(
            string.concat(assets, "0x0000000000000000000000000000000000000000"),
            "500000000,500000000,500000000,500000000,200000000000000000",
            "25000000000,25000000000,25000000000,25000000000,10000000000000000000"
        );
        DeployEthereumSepolia s = new DeployEthereumSepolia();

        // A key that is not the deployer's stops the run before anything is sent.
        vm.setEnv("DEPLOYER", vm.toString(DEPLOYER));
        vm.expectRevert(bytes("DEPLOYER_PK is not the key of DEPLOYER"));
        s.run();

        // Step 2: PoseidonT3 from the deployer's first transaction.
        vm.prank(DEPLOYER);
        address poseidon = _deployPoseidon();
        assertEq(poseidon, 0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4, "PoseidonT3 where it is on the other chains");
        assertEq(poseidon.codehash, 0x354b26999e434f8256d168395315e1f51fc15bf49bf2e6bb58fc549bd597e7da, "PoseidonT3 code");

        // Step 3: the vault, sent as the deployer with no key in the environment.
        vm.setEnv("DEPLOYER_PK", "");
        vm.setEnv("POSEIDON2", vm.toString(poseidon));
        s.run();
        ShieldPoolPayments pool = ShieldPoolPayments(payable(0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194));
        assertEq(address(pool.verifier()), 0x1421353d471dF6C847713aee391Db38978fE714a, "DualProofVerifier");
        assertEq(address(pool.shieldVerifier()), 0x69Fa6d2De0A66dA718DF022cEe98485AfDb03465, "shield verifier");
        _checkCommon(pool);
        for (uint256 i = 0; i < stables.length; i++) {
            _checkLimit(pool, stables[i], 500e6, 25_000e6);
        }
        _checkLimit(pool, SEPOLIA_USDC, 0, 0);
        assertEq(pool.owner(), DEPLOYER, "the deployer holds it until the owner wallet accepts");

        // Step 4: the memo board, the deployer's next contract. On chain the ten setup
        // calls (limits on, shield verifier, five limits, fee, handoff, endSetup) are
        // transactions 9 to 18; a forge test counts only the deploys, so skip ahead.
        assertEq(vm.getNonce(DEPLOYER), 9, "eight contracts after PoseidonT3");
        vm.setNonce(DEPLOYER, 19);
        new DeployGloamPayMemo().run();
        assertGt(address(0x342E3745967FDB4223902E196Ceb792c15d8C1c4).code.length, 0, "memo board at nonce 19");
        assertEq(vm.getNonce(DEPLOYER), 20);

        // Step 6: the owner wallet accepts.
        vm.prank(OWNER);
        pool.acceptOwnership();
        assertEq(pool.owner(), OWNER);
        assertEq(pool.pendingOwner(), address(0));

        vm.setEnv("DEPLOYER", "");
    }
}
