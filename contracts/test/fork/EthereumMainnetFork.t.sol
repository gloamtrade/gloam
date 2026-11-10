// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// DeployEthereumMainnet on a local fork of Ethereum mainnet, with the runbook's
// settings and the real tokens: every read-back check passes, the owner wallet
// accepts ownership, and real USDT and ETH go through the vault with proofs made
// with the ceremony's final keys (test/fixtures/ethereum-fork-proofs.json, from
// circuits/scripts/gen-ethereum-fork-proofs.mjs): a deposit of each, a private
// send, and a cash out of each with the 0.25% fee collected for the treasury.
// USDT is the one with quirks: approve() and transfer() return nothing, and
// approve() refuses to turn one non-zero allowance into another.
//
// Off by default (it reads mainnet over RPC). Run on its own, since the deploy
// settings travel in env vars, from contracts/:
//   ETH_FORK=1 forge test --match-path test/fork/EthereumMainnetFork.t.sol -vv
// ETH_FORK_URL picks the RPC (default Tenderly's public gateway, which serves old state).

import {Test, console2} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolPayments} from "../../src/ShieldPoolPayments.sol";
import {DeployEthereumMainnet} from "../../script/DeployEthereumMainnet.s.sol";

/// Tether's interface: approve and transfer return nothing.
interface ITether {
    function approve(address spender, uint256 value) external;
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address who) external view returns (uint256);
    function basisPointsRate() external view returns (uint256);
}

interface IERC20Meta {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

contract EthereumMainnetForkTest is Test {
    using stdJson for string;

    // Not a real key: a local test signer only.
    uint256 constant PK = 0xE7E0;
    address constant TREASURY = 0xB3900ac9350903218e4c7597bAb0f008F01B30B8;
    address constant OWNER = 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8;

    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address constant USDG = 0xe343167631d89B6Ffc58B88d6b7fB0228795491D;
    address constant PYUSD = 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8;
    address constant EURC = 0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c;

    ShieldPoolPayments pool;
    string fx;
    address payer = makeAddr("payer");
    address relayer = makeAddr("relayer");

    function setUp() public {
        if (!vm.envOr("ETH_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("ETH_FORK_URL", string("https://gateway.tenderly.co/public/mainnet")));
        assertEq(block.chainid, 1, "an Ethereum mainnet fork");
        fx = vm.readFile("test/fixtures/ethereum-fork-proofs.json");

        vm.setEnv("DEPLOYER_PK", vm.toString(bytes32(PK)));
        vm.setEnv("POSEIDON2", vm.toString(_deployPoseidon()));
        vm.setEnv(
            "LIMIT_ASSETS",
            string.concat(
                vm.toString(USDC),
                ",",
                vm.toString(USDT),
                ",",
                vm.toString(USDG),
                ",",
                vm.toString(PYUSD),
                ",",
                vm.toString(EURC),
                ",0x0000000000000000000000000000000000000000"
            )
        );
        vm.setEnv("LIMIT_PER_DEPOSIT", "500000000,500000000,500000000,500000000,500000000,200000000000000000");
        vm.setEnv("LIMIT_TOTAL", "25000000000,25000000000,25000000000,25000000000,25000000000,10000000000000000000");
        vm.setEnv("WITHDRAW_FEE_BPS", "25");
        vm.setEnv("FEE_RECIPIENT", vm.toString(TREASURY));
        vm.setEnv("NEW_OWNER", vm.toString(OWNER));
        vm.setEnv("NEW_OWNER_EOA", "1");
        // The vault is live on this fork, so the deploy's redeploy check would stop
        // this rehearsal (script/RedeployGuard.sol): a second vault here is the point.
        vm.setEnv("GLOAM_ALLOW_REDEPLOY", "1");

        uint256 n = vm.getNonce(vm.addr(PK));
        new DeployEthereumMainnet().run();
        // the pool is the eighth contract the deployer creates (after three verifiers, their adapters and DualProofVerifier)
        pool = ShieldPoolPayments(payable(vm.computeCreateAddress(vm.addr(PK), n + 7)));
    }

    function test_deploy_settings_and_owner_handoff() public {
        assertTrue(pool.depositLimitsOn(), "limits on");
        assertFalse(pool.setupMode(), "setup ended");
        assertEq(pool.withdrawFeeBps(), 25, "fee");
        assertEq(pool.feeRecipient(), TREASURY, "fee recipient");
        address[5] memory stables = [USDC, USDT, USDG, PYUSD, EURC];
        for (uint256 i = 0; i < stables.length; i++) {
            assertEq(IERC20Meta(stables[i]).decimals(), 6, IERC20Meta(stables[i]).symbol());
            (uint128 per, uint128 total) = pool.depositLimit(stables[i]);
            assertEq(per, 500e6, "500 per deposit");
            assertEq(total, 25_000e6, "25,000 in total");
        }
        (uint128 ethPer, uint128 ethTotal) = pool.depositLimit(address(0));
        assertEq(ethPer, 0.2 ether);
        assertEq(ethTotal, 10 ether);

        // The deployer keeps the vault until the owner wallet accepts.
        assertEq(pool.owner(), vm.addr(PK));
        assertEq(pool.pendingOwner(), OWNER);
        vm.prank(relayer);
        vm.expectRevert();
        pool.acceptOwnership();
        vm.prank(OWNER);
        pool.acceptOwnership();
        assertEq(pool.owner(), OWNER, "owner accepted");
        assertEq(pool.pendingOwner(), address(0));
    }

    function test_usdt_and_eth_through_the_vault() public {
        ITether usdt = ITether(USDT);
        assertEq(usdt.basisPointsRate(), 0, "Tether's transfer fee is off");
        deal(USDT, payer, 1_000e6);
        vm.deal(payer, 1 ether);
        address recipient = fx.readAddress(".recipient");

        // USDT approve: exact amounts, and a stale allowance must go to 0 first.
        vm.startPrank(payer);
        usdt.approve(address(pool), 30e6);
        vm.expectRevert();
        usdt.approve(address(pool), 100e6);
        usdt.approve(address(pool), 0);
        usdt.approve(address(pool), 100e6);
        vm.stopPrank();

        uint256 g = gasleft();
        vm.prank(payer);
        pool.shieldBound(
            USDT,
            fx.readUint(".shieldUsdt.amount"),
            fx.readBytes32(".shieldUsdt.commitment"),
            fx.readBytes(".shieldUsdt.proof")
        );
        console2.log("gas: deposit USDT", g - gasleft());
        assertEq(pool.deposited(USDT), 100e6);
        assertEq(usdt.balanceOf(address(pool)), 100e6);
        assertEq(usdt.allowance(payer, address(pool)), 0, "exact approval used up");

        g = gasleft();
        vm.prank(payer);
        pool.shieldBound{value: 0.01 ether}(
            address(0),
            fx.readUint(".shieldEth.amount"),
            fx.readBytes32(".shieldEth.commitment"),
            fx.readBytes(".shieldEth.proof")
        );
        console2.log("gas: deposit ETH", g - gasleft());
        assertEq(pool.deposited(address(0)), 0.01 ether);

        // A private send from the relay: 60 USDT paid, 40 back as change.
        bytes32 sendRoot = fx.readBytes32(".send.root");
        assertTrue(pool.isKnownRoot(sendRoot), "the vault's root matches the off-chain tree");
        bytes32[2] memory outs = [fx.readBytes32(".send.payment"), fx.readBytes32(".send.change")];
        g = gasleft();
        vm.prank(relayer);
        pool.transfer(fx.readBytes(".send.proof"), sendRoot, fx.readBytes32(".send.nullifier"), outs);
        console2.log("gas: private send", g - gasleft());

        // Cash outs from the relay: the recipient gets the amount less 0.25%.
        bytes32 root = fx.readBytes32(".cashOutUsdt.root");
        g = gasleft();
        vm.prank(relayer);
        pool.unshield(
            fx.readBytes(".cashOutUsdt.proof"), root, fx.readBytes32(".cashOutUsdt.nullifier"), USDT, recipient, 60e6
        );
        console2.log("gas: cash out USDT", g - gasleft());
        assertEq(usdt.balanceOf(recipient), 60e6 - 150_000, "60 USDT less the 0.25% fee");
        assertEq(pool.deposited(USDT), 40e6, "the change stays in the vault");

        g = gasleft();
        vm.prank(relayer);
        pool.unshield(
            fx.readBytes(".cashOutEth.proof"),
            root,
            fx.readBytes32(".cashOutEth.nullifier"),
            address(0),
            recipient,
            0.01 ether
        );
        console2.log("gas: cash out ETH", g - gasleft());
        assertEq(recipient.balance, 0.01 ether - 0.000025 ether);

        // Fees go to the treasury only, in full.
        uint256 before = usdt.balanceOf(TREASURY);
        pool.collectFees(USDT);
        assertEq(usdt.balanceOf(TREASURY) - before, 150_000);
        before = TREASURY.balance;
        pool.collectFees(address(0));
        assertEq(TREASURY.balance - before, 0.000025 ether);
        assertEq(usdt.balanceOf(address(pool)), 40e6, "exactly the change is left");

        // A spent note is refused before the proof check.
        vm.prank(relayer);
        vm.expectRevert();
        pool.unshield(
            fx.readBytes(".cashOutUsdt.proof"), root, fx.readBytes32(".cashOutUsdt.nullifier"), USDT, recipient, 60e6
        );
    }

    function _deployPoseidon() internal returns (address addr) {
        bytes memory bytecode = vm.readFile("test/fixtures/Poseidon2.json").readBytes(".bytecode");
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "poseidon deploy failed");
    }
}
