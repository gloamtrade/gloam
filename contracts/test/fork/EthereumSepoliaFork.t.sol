// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// DEPLOY-ETHEREUM-SEPOLIA.md rehearsed on a local fork of Ethereum Sepolia, as
// the real deployer (0x891E…F411) at its real nonce 0, with no key: the deploy
// scripts send as that address (script/DeployerBroadcast.sol). It shows that
//   - PoseidonT3, the verifiers, the vault and the memo board land at the same
//     addresses as on the other chains, with the same code as on Base Sepolia;
//   - the runbook's settings read back, and the owner wallet takes ownership;
//   - every listed asset (Circle's USDC and EURC, Paxos's USDG and PYUSD, and
//     ETH) goes through the vault with the real Sepolia tokens and proofs made
//     with the ceremony's final keys (test/fixtures/ethereum-sepolia-fork-proofs.json,
//     from circuits/scripts/gen-sepolia-fork-proofs.mjs): a deposit of each, a
//     private send from the relayer, a cash out of each with the 0.25% fee, and
//     the fees collected for the treasury.
// The gas each step logs is what DEPLOY-ETHEREUM-SEPOLIA.md prices the funding on.
//
// Off by default (it reads Sepolia over RPC). Run on its own, since the deploy
// settings travel in env vars, from contracts/:
//   SEPOLIA_FORK=1 forge test --match-path test/fork/EthereumSepoliaFork.t.sol -vv
// SEPOLIA_FORK_URL picks the RPC (default publicnode, which keeps recent state
// only; https://sepolia.gateway.tenderly.co keeps all of it); SEPOLIA_FORK_BLOCK
// pins a block (it needs an RPC that keeps old state, like Tenderly's).
// Once the vault is deployed, the nonce check fails at the head: pin a block
// from before the deploy to rehearse again. The vault is deployed (25 Oct 2026),
// so at the head setUp fails on the nonce check. This passes:
//   SEPOLIA_FORK=1 SEPOLIA_FORK_URL=https://sepolia.gateway.tenderly.co \
//     SEPOLIA_FORK_BLOCK=11992000 forge test --match-path test/fork/EthereumSepoliaFork.t.sol -vv
// It rehearses the planned addresses; the real deploy landed one nonce later
// (vault 0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef, DEPLOY-ETHEREUM-SEPOLIA.md).

import {Test, console2} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolPayments} from "../../src/ShieldPoolPayments.sol";
import {DeployEthereumSepolia} from "../../script/DeployEthereumSepolia.s.sol";
import {DeployGloamPayMemo} from "../../script/DeployGloamPayMemo.s.sol";
import {GloamPayMemo} from "../../src/GloamPayMemo.sol";

interface IERC20Lite {
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

contract EthereumSepoliaForkTest is Test {
    using stdJson for string;

    address constant DEPLOYER = 0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411;
    address constant OWNER = 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8;
    address constant TREASURY = 0xB3900ac9350903218e4c7597bAb0f008F01B30B8;
    address constant RELAYER = 0xb1E994586E62994648a0b866BF33F2EDd942512e;

    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address constant USDG = 0xfBb2A78CceEb415b00300925e464C3E44E6e06b0;
    address constant PYUSD = 0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9;
    address constant EURC = 0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4;

    // Where they are on Robinhood Chain, Tempo and Base Sepolia (deployer nonces 0, 7, 2, 8; memo 19 with five listed assets).
    address constant POSEIDON_T3 = 0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4;
    address constant DUAL = 0x1421353d471dF6C847713aee391Db38978fE714a;
    address constant SHIELD_I = 0x69Fa6d2De0A66dA718DF022cEe98485AfDb03465;
    address constant VAULT = 0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194;
    address constant MEMO = 0x342E3745967FDB4223902E196Ceb792c15d8C1c4;

    // Code hashes read from Base Sepolia (84532) on 2026-10-25: the same contracts, byte for byte.
    bytes32 constant POSEIDON_T3_CODE = 0x354b26999e434f8256d168395315e1f51fc15bf49bf2e6bb58fc549bd597e7da;
    bytes32 constant VAULT_CODE = 0x58d9843b0c6d9b81fbbb015de6a2413a7443cc63476185edf43d882f672088f2;
    bytes32 constant DUAL_CODE = 0x1d93455a6dd1b0b9b4793ba446ce84e2c301263578674ab438013bcb8dbec5c6;
    bytes32 constant SHIELD_I_CODE = 0x956f69128783bd1c3a7a487667bb29a9d146ed1894ce8cb904c629841e58e632;
    bytes32 constant MEMO_CODE = 0xf24e84ff514b7b8e3eba03c4b7ac70bbeb8b799b5fd3006d552a34362cf5edae;

    ShieldPoolPayments pool;
    string fx;
    address payer = makeAddr("payer");

    function setUp() public {
        if (!vm.envOr("SEPOLIA_FORK", false)) {
            vm.skip(true);
            return;
        }
        string memory url = vm.envOr("SEPOLIA_FORK_URL", string("https://ethereum-sepolia-rpc.publicnode.com"));
        uint256 pinned = vm.envOr("SEPOLIA_FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, pinned);
        assertEq(block.chainid, 11155111, "an Ethereum Sepolia fork");
        fx = vm.readFile("test/fixtures/ethereum-sepolia-fork-proofs.json");

        // What Sepolia must look like for the addresses to match the other chains.
        assertEq(vm.getNonce(DEPLOYER), 0, "the deployer has sent nothing on Sepolia yet");
        address[5] memory taken = [POSEIDON_T3, DUAL, SHIELD_I, VAULT, MEMO];
        for (uint256 i = 0; i < taken.length; i++) {
            assertEq(taken[i].code.length, 0, "address already has code on Sepolia");
        }

        // Step 2: PoseidonT3 is the deployer's first transaction.
        vm.prank(DEPLOYER);
        address poseidon = _deployPoseidon();
        assertEq(poseidon, POSEIDON_T3, "PoseidonT3 at nonce 0");

        // Step 3: the vault, with ethereum-sepolia-env.sh's settings, sent as the deployer.
        vm.setEnv("DEPLOYER", vm.toString(DEPLOYER));
        vm.setEnv("DEPLOYER_PK", "");
        vm.setEnv("POSEIDON2", vm.toString(poseidon));
        vm.setEnv(
            "LIMIT_ASSETS",
            string.concat(
                vm.toString(USDC), ",", vm.toString(USDG), ",", vm.toString(PYUSD), ",", vm.toString(EURC),
                ",0x0000000000000000000000000000000000000000"
            )
        );
        vm.setEnv("LIMIT_PER_DEPOSIT", "500000000,500000000,500000000,500000000,200000000000000000");
        vm.setEnv("LIMIT_TOTAL", "25000000000,25000000000,25000000000,25000000000,10000000000000000000");
        vm.setEnv("WITHDRAW_FEE_BPS", "25");
        vm.setEnv("FEE_RECIPIENT", vm.toString(TREASURY));
        vm.setEnv("NEW_OWNER", vm.toString(OWNER));
        vm.setEnv("NEW_OWNER_EOA", "1");
        new DeployEthereumSepolia().run();
        pool = ShieldPoolPayments(payable(VAULT));

        // Step 4: the memo board. On chain the ten setup calls are transactions 9 to 18;
        // a forge test counts only the deploys, so the nonce skips ahead to where it will be.
        assertEq(vm.getNonce(DEPLOYER), 9, "eight contracts after PoseidonT3");
        vm.setNonce(DEPLOYER, 19);
        new DeployGloamPayMemo().run();
        vm.setEnv("DEPLOYER", "");
    }

    function test_lands_where_the_other_chains_have_it() public view {
        assertEq(POSEIDON_T3.codehash, POSEIDON_T3_CODE, "PoseidonT3 code");
        assertEq(VAULT.codehash, VAULT_CODE, "vault code, as on Base Sepolia");
        assertEq(DUAL.codehash, DUAL_CODE, "DualProofVerifier code");
        assertEq(SHIELD_I.codehash, SHIELD_I_CODE, "shield verifier code");
        assertEq(MEMO.codehash, MEMO_CODE, "memo board code");
        assertEq(address(pool.verifier()), DUAL);
        assertEq(address(pool.shieldVerifier()), SHIELD_I);
        assertEq(vm.getNonce(DEPLOYER), 20, "the memo board was the deployer's 20th transaction");
    }

    function test_deploy_settings_and_owner_handoff() public {
        assertTrue(pool.depositLimitsOn(), "limits on");
        assertFalse(pool.setupMode(), "setup ended");
        assertEq(pool.withdrawFeeBps(), 25, "fee");
        assertEq(pool.feeRecipient(), TREASURY, "fee recipient");
        address[4] memory stables = [USDC, USDG, PYUSD, EURC];
        for (uint256 i = 0; i < stables.length; i++) {
            assertEq(IERC20Lite(stables[i]).decimals(), 6, IERC20Lite(stables[i]).symbol());
            (uint128 per, uint128 total) = pool.depositLimit(stables[i]);
            assertEq(per, 500e6, "500 per deposit");
            assertEq(total, 25_000e6, "25,000 in total");
        }
        (uint128 ethPer, uint128 ethTotal) = pool.depositLimit(address(0));
        assertEq(ethPer, 0.2 ether);
        assertEq(ethTotal, 10 ether);

        // The deployer keeps the vault until the owner wallet accepts (the 127.0.0.1:4730 page).
        assertEq(pool.owner(), DEPLOYER);
        assertEq(pool.pendingOwner(), OWNER);
        vm.prank(RELAYER);
        vm.expectRevert();
        pool.acceptOwnership();
        uint256 g = gasleft();
        vm.prank(OWNER);
        pool.acceptOwnership();
        console2.log("gas: acceptOwnership", g - gasleft());
        assertEq(pool.owner(), OWNER, "owner accepted");
        assertEq(pool.pendingOwner(), address(0));
    }

    function test_every_asset_through_the_vault() public {
        address recipient = fx.readAddress(".recipient");
        deal(USDC, payer, 1_000e6);
        deal(EURC, payer, 1_000e6);
        deal(USDG, payer, 1_000e6);
        deal(PYUSD, payer, 1_000e6);
        vm.deal(payer, 1 ether);

        // Deposits, in the order the proofs' tree expects: USDC, ETH, EURC, USDG, PYUSD (leaves 0 to 4).
        _deposit(USDC, ".shieldUsdc", "USDC");
        uint256 g = gasleft();
        vm.prank(payer);
        pool.shieldBound{value: 0.01 ether}(
            address(0), fx.readUint(".shieldEth.amount"), fx.readBytes32(".shieldEth.commitment"), fx.readBytes(".shieldEth.proof")
        );
        console2.log("gas: deposit ETH", g - gasleft());
        _deposit(EURC, ".shieldEurc", "EURC");
        _deposit(USDG, ".shieldUsdg", "USDG");
        _deposit(PYUSD, ".shieldPyusd", "PYUSD");
        assertEq(pool.deposited(USDC), 100e6);
        assertEq(pool.deposited(address(0)), 0.01 ether);
        assertEq(pool.deposited(EURC), 50e6);
        assertEq(pool.deposited(USDG), 25e6);
        assertEq(pool.deposited(PYUSD), 25e6);

        // A private send from the relayer: 60 USDC paid, 40 back as change.
        bytes32 sendRoot = fx.readBytes32(".send.root");
        assertTrue(pool.isKnownRoot(sendRoot), "the vault's root matches the off-chain tree");
        bytes32[2] memory outs = [fx.readBytes32(".send.payment"), fx.readBytes32(".send.change")];
        g = gasleft();
        vm.prank(RELAYER);
        pool.transfer(fx.readBytes(".send.proof"), sendRoot, fx.readBytes32(".send.nullifier"), outs);
        console2.log("gas: private send", g - gasleft());

        // The relayer posts the payment's sealed message on the board.
        g = gasleft();
        vm.prank(RELAYER);
        GloamPayMemo(MEMO).postMemo(outs[0], new bytes(400));
        console2.log("gas: payment message (400 bytes)", g - gasleft());

        // Cash outs from the relayer: the recipient gets each amount less 0.25%.
        _cashOut(USDC, ".cashOutUsdc", 60e6, "USDC");
        uint256 before = recipient.balance;
        g = gasleft();
        vm.prank(RELAYER);
        pool.unshield(
            fx.readBytes(".cashOutEth.proof"), fx.readBytes32(".cashOutEth.root"), fx.readBytes32(".cashOutEth.nullifier"),
            address(0), recipient, 0.01 ether
        );
        console2.log("gas: cash out ETH", g - gasleft());
        assertEq(recipient.balance - before, 0.01 ether - 0.000025 ether, "0.01 ETH less the fee");
        _cashOut(EURC, ".cashOutEurc", 50e6, "EURC");
        _cashOut(USDG, ".cashOutUsdg", 25e6, "USDG");
        _cashOut(PYUSD, ".cashOutPyusd", 25e6, "PYUSD");
        assertEq(pool.deposited(USDC), 40e6, "the change stays in the vault");

        // Fees go to the treasury only, in full.
        _collect(USDC, 150_000);
        _collect(EURC, 125_000);
        _collect(USDG, 62_500);
        _collect(PYUSD, 62_500);
        before = TREASURY.balance;
        pool.collectFees(address(0));
        assertEq(TREASURY.balance - before, 0.000025 ether);
        assertEq(IERC20Lite(USDC).balanceOf(address(pool)), 40e6, "exactly the change is left");
        assertEq(IERC20Lite(EURC).balanceOf(address(pool)), 0);

        // A spent note is refused.
        vm.prank(RELAYER);
        vm.expectRevert();
        pool.unshield(
            fx.readBytes(".cashOutUsdc.proof"), fx.readBytes32(".cashOutUsdc.root"), fx.readBytes32(".cashOutUsdc.nullifier"),
            USDC, recipient, 60e6
        );
    }

    function _deposit(address token, string memory key, string memory name) internal {
        uint256 amount = fx.readUint(string.concat(key, ".amount"));
        vm.prank(payer);
        IERC20Lite(token).approve(address(pool), amount);
        uint256 g = gasleft();
        vm.prank(payer);
        pool.shieldBound(token, amount, fx.readBytes32(string.concat(key, ".commitment")), fx.readBytes(string.concat(key, ".proof")));
        console2.log(string.concat("gas: deposit ", name), g - gasleft());
        assertEq(IERC20Lite(token).balanceOf(address(pool)), amount, name);
    }

    function _cashOut(address token, string memory key, uint256 amount, string memory name) internal {
        address recipient = fx.readAddress(".recipient");
        uint256 before = IERC20Lite(token).balanceOf(recipient);
        uint256 g = gasleft();
        vm.prank(RELAYER);
        pool.unshield(
            fx.readBytes(string.concat(key, ".proof")),
            fx.readBytes32(string.concat(key, ".root")),
            fx.readBytes32(string.concat(key, ".nullifier")),
            token,
            recipient,
            amount
        );
        console2.log(string.concat("gas: cash out ", name), g - gasleft());
        assertEq(IERC20Lite(token).balanceOf(recipient) - before, amount - (amount * 25) / 10_000, name);
    }

    function _collect(address token, uint256 fee) internal {
        uint256 before = IERC20Lite(token).balanceOf(TREASURY);
        pool.collectFees(token);
        assertEq(IERC20Lite(token).balanceOf(TREASURY) - before, fee, IERC20Lite(token).symbol());
    }

    function _deployPoseidon() internal returns (address addr) {
        bytes memory bytecode = vm.readFile("test/fixtures/Poseidon2.json").readBytes(".bytecode");
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "poseidon deploy failed");
    }
}
