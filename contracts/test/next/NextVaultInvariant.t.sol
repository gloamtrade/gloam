// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore2} from "../../src/ShieldPoolCore2.sol";
import {ShieldPoolPayments2} from "../../src/ShieldPoolPayments2.sol";
import {IVerifier} from "../../src/interfaces/IVerifier.sol";
import {MockERC20} from "../MockERC20.sol";

contract AcceptAll is IVerifier {
    function verify(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return true;
    }
}

/// Random deposits, cash outs, fees, donations, collections and sweeps on one
/// token and the native coin. The verifier accepts everything, so this is the
/// vault's own accounting under any proof the circuits would allow.
contract NextVaultHandler is Test {
    ShieldPoolPayments2 public immutable pool;
    MockERC20 public immutable usd;
    address public immutable treasury;
    address public immutable stray;
    address constant USER = address(0x1234);
    address constant TO = address(0xBEEF);

    uint256 public sumDepositedIn;
    uint256 public sumPaidOut;
    uint256 public sumDonated;
    uint256 public sumSwept;
    uint256 public sumCollected;
    uint256 public sumFees;
    uint256 nonce;

    constructor(ShieldPoolPayments2 pool_, MockERC20 usd_, address treasury_, address stray_) {
        pool = pool_;
        usd = usd_;
        treasury = treasury_;
        stray = stray_;
        usd.mint(USER, 1e30);
        vm.prank(USER);
        usd.approve(address(pool), type(uint256).max);
        vm.deal(USER, 1e30);
    }

    function deposit(uint96 amount) external {
        uint256 a = bound(uint256(amount), 1, 1e24);
        vm.prank(USER);
        pool.shieldBound(address(usd), a, bytes32(++nonce), "");
        sumDepositedIn += a;
    }

    function cashOut(uint96 amount, uint96 floor) external {
        uint256 d = pool.deposited(address(usd));
        if (d == 0) return;
        uint256 a = bound(uint256(amount), 1, d);
        uint256 min = bound(uint256(floor), 0, a);
        uint256 feeBefore = pool.feesOwed(address(usd));
        uint256 before = usd.balanceOf(TO);
        bytes32 root = pool.currentRoot();
        try pool.unshield("", root, bytes32(++nonce), address(usd), TO, a, min) {
            uint256 got = usd.balanceOf(TO) - before;
            assertGe(got, min, "the floor held");
            uint256 fee = pool.feesOwed(address(usd)) - feeBefore;
            assertEq(got + fee, a, "nothing lost between the recipient and the fee");
            sumPaidOut += got;
            sumFees += fee;
        } catch (bytes memory e) {
            assertEq(bytes4(e), ShieldPoolCore2.BelowMinReceived.selector, "only the floor can stop this");
        }
    }

    function donate(uint96 amount) external {
        usd.mint(address(pool), amount);
        sumDonated += amount;
    }

    function setFee(uint16 bps) external {
        pool.setWithdrawFee(uint16(bound(bps, 0, 100)), treasury);
    }

    function collect() external {
        uint256 before = usd.balanceOf(treasury);
        try pool.collectFees(address(usd)) {
            sumCollected += usd.balanceOf(treasury) - before;
        } catch {}
    }

    function sweep() external {
        uint256 before = usd.balanceOf(stray);
        vm.prank(pool.owner());
        try pool.sweepStrayToken(address(usd)) {
            sumSwept += usd.balanceOf(stray) - before;
        } catch {}
    }
}

/// The vault never owes more than it holds, and the sweep can never make it so.
contract NextVaultInvariantTest is Test {
    using stdJson for string;

    ShieldPoolPayments2 pool;
    MockERC20 usd;
    NextVaultHandler handler;
    address treasury = address(0x7EA5);
    address stray = address(0x57A7);

    function setUp() public {
        string memory json = vm.readFile("test/fixtures/Poseidon2.json");
        bytes memory bytecode = json.readBytes(".bytecode");
        address poseidon;
        assembly {
            poseidon := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        AcceptAll v = new AcceptAll();
        pool = new ShieldPoolPayments2(poseidon, address(v), stray);
        pool.setShieldVerifier(address(v));
        pool.setWithdrawFee(50, treasury);
        usd = new MockERC20();
        handler = new NextVaultHandler(pool, usd, treasury, stray);
        pool.transferOwnership(address(handler));
        vm.prank(address(handler));
        pool.acceptOwnership();
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 40
    /// forge-config: default.invariant.depth = 120
    function invariant_the_vault_holds_what_it_owes() public view {
        assertGe(usd.balanceOf(address(pool)), pool.deposited(address(usd)) + pool.feesOwed(address(usd)));
    }

    /// forge-config: default.invariant.runs = 40
    /// forge-config: default.invariant.depth = 120
    function invariant_every_unit_is_accounted_for() public view {
        uint256 inflow = handler.sumDepositedIn() + handler.sumDonated();
        uint256 outflow = handler.sumPaidOut() + handler.sumCollected() + handler.sumSwept();
        assertEq(usd.balanceOf(address(pool)), inflow - outflow);
        assertEq(handler.sumDepositedIn() - handler.sumPaidOut() - handler.sumFees(), pool.deposited(address(usd)));
        assertEq(handler.sumFees() - handler.sumCollected(), pool.feesOwed(address(usd)));
        assertLe(handler.sumSwept(), handler.sumDonated(), "the sweep only ever took what was donated");
    }
}
