// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolPayments} from "../src/ShieldPoolPayments.sol";
import {VaultOwnerGuard} from "../src/VaultOwnerGuard.sol";
import {MainnetDeploy} from "../script/MainnetDeploy.sol";
import {DeployRobinhoodMainnet} from "../script/DeployRobinhoodMainnet.s.sol";
import {DeployTempoMainnet} from "../script/DeployTempoMainnet.s.sol";
import {DeployBaseMainnet} from "../script/DeployBaseMainnet.s.sol";
import {DeployEthereumMainnet} from "../script/DeployEthereumMainnet.s.sol";
import {MockERC20} from "./MockERC20.sol";

/// The shared mainnet deploy with its checks opened up, and an optional stand-in deployments file.
contract RedeployGuardHarness is MainnetDeploy {
    string fakeFile;
    string fakeKey;

    function useRecord(string memory file, string memory key) external {
        fakeFile = file;
        fakeKey = key;
    }

    function _vaultRecord(uint256 chainId) internal view override returns (string memory, string memory) {
        if (bytes(fakeFile).length > 0) return (fakeFile, fakeKey);
        return super._vaultRecord(chainId);
    }

    function record(uint256 chainId) external view returns (string memory file, address vault) {
        string memory key;
        (file, key) = _vaultRecord(chainId);
        if (bytes(file).length > 0) vault = _recordedVault(file, key);
    }

    function requireFirstDeploy(address deployer) external view {
        _requireFirstDeploy(block.chainid, deployer);
    }

    function refuseRedeploy() external view {
        _refuseRedeploy();
    }

    function deployGuarded(uint256 chainId) external {
        _deployMainnetGuarded(chainId, true);
    }

    function looksLikeVault(address a) external view returns (bool) {
        return _looksLikeVault(a);
    }
}

/// Answers the vault's three getters and nothing else.
contract VaultShaped {
    address public verifier;
    address public shieldVerifier;
    address public poseidon2;
}

interface IRun {
    function run() external;
}

/**
 * A mainnet deploy that already happened is refused (script/RedeployGuard.sol),
 * with no fork: vm.etch stands in for the live vault, vm.setNonce for the
 * deployer's history, and test/fixtures/redeploy-guard.json for a deployments file.
 *
 * Only test_real_scripts_refuse_and_the_override touches process env vars, which
 * tests running side by side share; every other test calls the check directly.
 */
contract RedeployGuardTest is Test {
    using stdJson for string;

    address constant VAULT = 0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194;
    address constant ELYSIUM_VAULT = 0x89d3042390204f57b8b4F8949D3c2203E4002164;
    address constant FAKE_VAULT = address(uint160(0xFA4E1));
    string constant HINT = ". Set GLOAM_ALLOW_REDEPLOY=1 only to deploy a second vault on purpose";

    uint256[5] mainnets = [uint256(4663), 4217, 8453, 1, 99901];

    RedeployGuardHarness h;
    address deployer = makeAddr("deployer");

    function setUp() public {
        h = new RedeployGuardHarness();
    }

    function _recordedRefusal(address vault, string memory file) internal pure returns (bytes memory) {
        return bytes(
            string.concat("already deployed: this chain's vault ", vm.toString(vault), " (", file, ") has code", HINT)
        );
    }

    function _deployerRefusal(address vault, uint256 nonce) internal pure returns (bytes memory) {
        return bytes(
            string.concat(
                "already deployed: the deployer made a vault at ",
                vm.toString(vault),
                " (its nonce ",
                vm.toString(nonce),
                ")",
                HINT
            )
        );
    }

    function _code() internal returns (bytes memory) {
        return address(new VaultShaped()).code;
    }

    /// Each mainnet reads the vault its deployments file records; testnets and the local chain have none.
    function test_reads_each_mainnets_recorded_vault() public view {
        string[5] memory files = [
            "deployments/mainnet.json",
            "deployments/mainnet.json",
            "deployments/base-mainnet.json",
            "deployments/ethereum-mainnet.json",
            "deployments/elysium-mainnet.json"
        ];
        for (uint256 i = 0; i < mainnets.length; i++) {
            (string memory file, address vault) = h.record(mainnets[i]);
            assertEq(file, files[i]);
            assertEq(vault, mainnets[i] == 99901 ? ELYSIUM_VAULT : VAULT);
        }
        uint256[7] memory others = [uint256(46630), 42431, 84532, 11155111, 99801, 31337, 10];
        for (uint256 i = 0; i < others.length; i++) {
            (string memory file, address vault) = h.record(others[i]);
            assertEq(bytes(file).length, 0, "not a mainnet");
            assertEq(vault, address(0));
        }
    }

    /// The recorded vault has code on chain: refused on every mainnet, before a key is read.
    function test_refuses_when_the_recorded_vault_has_code() public {
        for (uint256 i = 0; i < mainnets.length; i++) {
            vm.chainId(mainnets[i]);
            (string memory file, address vault) = h.record(mainnets[i]);
            h.requireFirstDeploy(address(0));
            vm.etch(vault, _code());
            vm.expectRevert(_recordedRefusal(vault, file));
            h.requireFirstDeploy(address(0));
            vm.expectRevert(_recordedRefusal(vault, file));
            h.requireFirstDeploy(deployer);
            vm.etch(vault, "");
        }
    }

    /// A testnet is never checked: rehearsals there run again on purpose.
    function test_testnets_are_not_checked() public {
        vm.chainId(84532);
        vm.etch(VAULT, _code());
        vm.prank(deployer);
        new VaultShaped();
        h.requireFirstDeploy(deployer);
    }

    /// The stand-in deployments file: no code at its vault passes, code refuses, no entry passes.
    function test_fake_deployments_file() public {
        vm.chainId(8453);
        h.useRecord("test/fixtures/redeploy-guard.json", ".contracts.ShieldPoolPayments");
        (string memory file, address vault) = h.record(8453);
        assertEq(vault, FAKE_VAULT);
        assertEq(file, "test/fixtures/redeploy-guard.json");

        // The real Base vault's address is not this file's: its code does not count here.
        vm.etch(VAULT, _code());
        h.requireFirstDeploy(deployer);

        vm.etch(FAKE_VAULT, _code());
        vm.expectRevert(_recordedRefusal(FAKE_VAULT, "test/fixtures/redeploy-guard.json"));
        h.requireFirstDeploy(deployer);

        // A file that names no vault yet (a new mainnet before its first deploy).
        h.useRecord("test/fixtures/redeploy-guard.json", ".contracts.NotDeployedYet");
        h.requireFirstDeploy(deployer);
    }

    /// Deployed but not recorded yet: the deployer's earlier nonces made a vault.
    function test_refuses_when_the_deployer_already_made_a_vault() public {
        vm.chainId(8453);
        bytes memory poseidonCode = vm.readFile("test/fixtures/Poseidon2.json").readBytes(".bytecode");

        // Nonce 0: PoseidonT3, as in every runbook. Not a vault.
        address poseidon;
        vm.prank(deployer);
        assembly {
            poseidon := create(0, add(poseidonCode, 0x20), mload(poseidonCode))
        }
        assertEq(poseidon, vm.computeCreateAddress(deployer, 0));
        h.requireFirstDeploy(deployer);

        // Nonces 1 to 7: other contracts (a token, the guard). Not vaults.
        vm.startPrank(deployer);
        for (uint256 i = 0; i < 6; i++) {
            new MockERC20();
        }
        new VaultOwnerGuard(poseidon, deployer);
        vm.stopPrank();
        h.requireFirstDeploy(deployer);

        // Nonce 8: a real vault, where the runbooks put it.
        vm.prank(deployer);
        ShieldPoolPayments pool = new ShieldPoolPayments(poseidon, address(0));
        assertEq(address(pool), vm.computeCreateAddress(deployer, 8));
        vm.expectRevert(_deployerRefusal(address(pool), 8));
        h.requireFirstDeploy(deployer);

        // Another deployer, or none, is not refused for it.
        h.requireFirstDeploy(makeAddr("someone else"));
        h.requireFirstDeploy(address(0));
    }

    /// The deployer check reads the first 64 nonces only.
    function test_deployer_check_reads_64_nonces() public {
        vm.chainId(1);
        bytes memory code = _code();
        vm.setNonce(deployer, 200);
        vm.etch(vm.computeCreateAddress(deployer, 100), code);
        h.requireFirstDeploy(deployer);
        vm.etch(vm.computeCreateAddress(deployer, 63), code);
        vm.expectRevert(_deployerRefusal(vm.computeCreateAddress(deployer, 63), 63));
        h.requireFirstDeploy(deployer);
    }

    /// Only a vault counts: the guard, a verifier-less token and empty addresses do not.
    function test_what_counts_as_a_vault() public {
        bytes memory poseidonCode = vm.readFile("test/fixtures/Poseidon2.json").readBytes(".bytecode");
        address poseidon;
        assembly {
            poseidon := create(0, add(poseidonCode, 0x20), mload(poseidonCode))
        }
        assertTrue(h.looksLikeVault(address(new ShieldPoolPayments(poseidon, address(0)))));
        assertTrue(h.looksLikeVault(address(new VaultShaped())));
        assertFalse(h.looksLikeVault(poseidon), "PoseidonT3");
        assertFalse(h.looksLikeVault(address(new MockERC20())), "a token");
        assertFalse(h.looksLikeVault(address(new VaultOwnerGuard(poseidon, deployer))), "the owner guard");
        assertFalse(h.looksLikeVault(makeAddr("nobody")), "no code");
    }

    /// Each mainnet script stops at the check; GLOAM_ALLOW_REDEPLOY=1 lets the check pass.
    function test_real_scripts_refuse_and_the_override() public {
        vm.setEnv("GLOAM_ALLOW_REDEPLOY", "0");
        vm.etch(VAULT, _code());
        vm.etch(ELYSIUM_VAULT, _code());

        IRun[4] memory scripts = [
            IRun(address(new DeployRobinhoodMainnet())),
            IRun(address(new DeployTempoMainnet())),
            IRun(address(new DeployBaseMainnet())),
            IRun(address(new DeployEthereumMainnet()))
        ];
        for (uint256 i = 0; i < scripts.length; i++) {
            vm.chainId(mainnets[i]);
            (string memory file,) = h.record(mainnets[i]);
            vm.expectRevert(_recordedRefusal(VAULT, file));
            scripts[i].run();
        }
        // Elysium's guarded path (DeployElysiumMainnet.run() checks its chain id env first, then this).
        vm.chainId(99901);
        vm.expectRevert(_recordedRefusal(ELYSIUM_VAULT, "deployments/elysium-mainnet.json"));
        h.deployGuarded(99901);

        vm.chainId(8453);
        vm.expectRevert(_recordedRefusal(VAULT, "deployments/base-mainnet.json"));
        h.refuseRedeploy();
        vm.setEnv("GLOAM_ALLOW_REDEPLOY", "1");
        h.refuseRedeploy();
        vm.setEnv("GLOAM_ALLOW_REDEPLOY", "0");
        vm.expectRevert(_recordedRefusal(VAULT, "deployments/base-mainnet.json"));
        h.refuseRedeploy();
    }
}
