// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore} from "../src/ShieldPoolCore.sol";
import {ShieldPoolPoseidon} from "../src/ShieldPoolPoseidon.sol";
import {ChangeTimelock} from "../src/lib/ChangeTimelock.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {MockERC20} from "./MockERC20.sol";

contract GateAcceptVerifier is IVerifier {
    function verify(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return true;
    }
}

/**
 * ShieldPoolPoseidon ends setup only when it is ready to go live, the same gate
 * as ShieldPoolPayments: both proof verifiers wired and deposit limits on.
 * turnOnDepositLimits() is setup-only and the timelock does not take it, so a
 * pool that left setup with limits off could never turn them on, and a later
 * timelocked setDepositLimit would be stored but never enforced.
 */
contract PoseidonLimitsGateTest is Test {
    using stdJson for string;

    GateAcceptVerifier acceptV;
    MockERC20 usd;
    address user = address(0x1234);

    function setUp() public {
        vm.warp(1_900_000_000);
        acceptV = new GateAcceptVerifier();
        usd = new MockERC20();
        usd.mint(user, 10_000e6);
    }

    function test_setup_cannot_end_with_limits_off() public {
        ShieldPoolPoseidon pool = new ShieldPoolPoseidon(_deployPoseidon(), address(acceptV));
        pool.setShieldVerifier(address(acceptV));
        vm.expectRevert(ShieldPoolCore.DepositLimitsOff.selector);
        pool.endSetup();
        assertTrue(pool.setupMode(), "still in setup, so limits can still be turned on");
        assertFalse(pool.depositLimitsOn());

        // the timelock still has no way to turn them on, which is why the gate is at endSetup
        pool.turnOnDepositLimits();
        pool.endSetup();
        vm.expectRevert(ChangeTimelock.UnknownChange.selector);
        pool.queueChange(abi.encodeWithSelector(ShieldPoolCore.turnOnDepositLimits.selector));
    }

    function test_setup_cannot_end_without_the_shield_verifier() public {
        ShieldPoolPoseidon pool = new ShieldPoolPoseidon(_deployPoseidon(), address(acceptV));
        pool.turnOnDepositLimits();
        vm.expectRevert(ShieldPoolCore.VerifierNotSet.selector);
        pool.endSetup();
        assertTrue(pool.setupMode());
    }

    function test_setup_cannot_end_without_the_spend_verifier() public {
        ShieldPoolPoseidon pool = new ShieldPoolPoseidon(_deployPoseidon(), address(0));
        pool.setShieldVerifier(address(acceptV));
        pool.turnOnDepositLimits();
        vm.expectRevert(ShieldPoolCore.VerifierNotSet.selector);
        pool.endSetup();
        assertTrue(pool.setupMode());
    }

    /// The same sequence as before the gate, now on a pool that could end setup:
    /// a limit raised through the timelock is enforced, not just stored.
    function test_timelocked_limit_is_enforced_after_setup() public {
        ShieldPoolPoseidon pool = new ShieldPoolPoseidon(_deployPoseidon(), address(acceptV));
        pool.setShieldVerifier(address(acceptV));
        pool.turnOnDepositLimits();
        pool.endSetup();
        assertFalse(pool.setupMode());
        assertTrue(pool.depositLimitsOn());

        vm.expectRevert(ChangeTimelock.TimelockRequired.selector);
        pool.turnOnDepositLimits();

        vm.startPrank(user);
        usd.approve(address(pool), type(uint256).max);
        // nothing listed yet: every deposit is refused
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector);
        pool.shieldBound(address(usd), 1e6, bytes32(uint256(41)), "");
        vm.stopPrank();

        bytes memory call_ = abi.encodeCall(ShieldPoolCore.setDepositLimit, (address(usd), uint128(100e6), uint128(1_000e6)));
        pool.queueChange(call_);
        vm.warp(block.timestamp + 3 days);
        pool.executeChange(call_);
        (uint128 per, uint128 total) = pool.depositLimit(address(usd));
        assertEq(per, 100e6);
        assertEq(total, 1_000e6);

        vm.prank(user);
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector);
        pool.shieldBound(address(usd), 5_000e6, bytes32(uint256(42)), "");
        assertEq(pool.deposited(address(usd)), 0);

        vm.prank(user);
        pool.shieldBound(address(usd), 100e6, bytes32(uint256(43)), "");
        assertEq(pool.deposited(address(usd)), 100e6);
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
