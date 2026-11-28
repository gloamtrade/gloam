// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Ported from test/GloamHardeningFixes.t.sol to the next vault (not deployed, not audited).
// Keep the two in step until the live vaults are retired.

import {PoolHarness2, STRAY} from "./NextHarness.sol";
import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore2} from "../../src/ShieldPoolCore2.sol";
import {IVerifier} from "../../src/interfaces/IVerifier.sol";

/// Always-true verifier: stands in for "attacker holds a valid Groth16 proof".
contract MockVerifier is IVerifier {
    function verify(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return true;
    }
}

/// ERC-20 that reenters unshield during its own transfer() (the _pushAsset call).
contract ReentrantToken {
    mapping(address => uint256) public balanceOf;
    PoolHarness2 public pool;
    bool public armed;
    bool public reentryBlocked;
    uint8 public constant decimals = 18;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function arm(PoolHarness2 p) external {
        pool = p;
        armed = true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        if (armed) {
            armed = false;
            // Attempt to reenter the pool while it is mid-unshield. The nonReentrant
            // latch must reject this at the modifier, before any state is touched.
            try
                pool.unshield(
                    "",
                    pool.currentRoot(),
                    bytes32(uint256(0xBEEF2)),
                    address(this),
                    address(0xDEAD),
                    1
                )
            {
                reentryBlocked = false; // reentry went through — guard failed
            } catch {
                reentryBlocked = true; // reverted (Reentrancy) — guard held
            }
        }
        return true;
    }
}

contract GloamHardeningFixesTestNext is Test {
    using stdJson for string;

    PoolHarness2 pool;
    address poseidon2;
    address owner = address(this);
    address user = address(0x1234);

    function setUp() public {
        poseidon2 = _deployPoseidon();
        pool = new PoolHarness2(poseidon2, address(new MockVerifier()));
        vm.deal(user, 100 ether);
    }

    // INFO-2: a codeless `asset` must be rejected explicitly (no phantom deposit credit).
    function test_codeless_asset_shield_reverts() public {
        address codeless = address(0xC0DE1E55);
        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.NotAContract.selector);
        pool.shield(codeless, 1e18, bytes32(uint256(1)));
    }

    // INFO-3: the reentrancy latch blocks a malicious token from reentering unshield.
    function test_reentrancy_guard_blocks_malicious_token() public {
        ReentrantToken tok = new ReentrantToken();
        tok.mint(user, 5e18);
        // user shields 5 tokens (plain shield: shieldVerifier unset).
        vm.startPrank(user);
        tok.mint(user, 0);
        // approve-less: our token's transferFrom ignores allowance.
        pool.shield(address(tok), 5e18, bytes32(uint256(0xAAAA)));
        vm.stopPrank();
        assertEq(pool.deposited(address(tok)), 5e18);

        tok.arm(pool);
        // Unshield 5 tokens; during _pushAsset the token reenters unshield.
        pool.unshield("", pool.currentRoot(), bytes32(uint256(0x1111)), address(tok), user, 5e18);

        assertTrue(tok.reentryBlocked(), "reentrant unshield should have been rejected");
    }

    // INFO-1: sweepStrayNative recovers only the surplus over deposited[native].
    function test_sweep_recovers_only_surplus() public {
        // user shields 3 ETH (backed native).
        vm.prank(user);
        pool.shield{value: 3 ether}(address(0), 3 ether, bytes32(uint256(0xBEEF)));
        assertEq(pool.deposited(address(0)), 3 ether);

        // 2 ETH arrives directly via receive() — unbacked, otherwise stuck.
        (bool ok, ) = address(pool).call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(address(pool).balance, 5 ether);

        address sink = address(0x5151);
        pool.sweepStrayNative(sink);

        assertEq(sink.balance, 2 ether, "only the 2 ETH surplus is swept");
        assertEq(address(pool).balance, 3 ether, "backed 3 ETH untouched");
        assertEq(pool.deposited(address(0)), 3 ether, "deposited unchanged");
    }

    function test_sweep_reverts_when_no_surplus() public {
        vm.prank(user);
        pool.shield{value: 1 ether}(address(0), 1 ether, bytes32(uint256(0xBEEF)));
        vm.expectRevert(ShieldPoolCore2.NothingToSweep.selector);
        pool.sweepStrayNative(address(0x5151));
    }

    function test_sweep_only_owner() public {
        vm.prank(user);
        vm.expectRevert(ShieldPoolCore2.NotOwner.selector);
        pool.sweepStrayNative(user);
    }

    function _deployPoseidon() internal returns (address addr) {
        string memory json = vm.readFile("test/fixtures/Poseidon2.json");
        bytes memory bytecode = json.readBytes(".bytecode");
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "poseidon deploy failed");
    }
}
