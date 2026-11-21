// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// GloamNamesRegistrar against the REAL Robinhood Chain GloamNames registry, the
// real $GLOAM token and the real treasury, on a local fork. A fresh vault with
// accept-all verifiers (and the unshield "proof" bound to its `to`) stands in
// for the live one, as in VaultSwapV4bFork.t.sol: the circuits are the live
// vault's, unchanged, and app/scripts/sim-name-claim.mts runs real proofs
// against the live vault. Also runs the deploy script against the live vault.
//
// Off by default (it reads mainnet over RPC). From contracts/:
//   RH_FORK=1 forge test --match-path test/fork/GloamNamesRegistrarFork.t.sol -vv

import {Test, console2} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolPayments} from "../../src/ShieldPoolPayments.sol";
import {IVerifier} from "../../src/interfaces/IVerifier.sol";
import {GloamNamesRegistrar} from "../../src/GloamNamesRegistrar.sol";
import {DeployGloamNamesRegistrar} from "../../script/DeployGloamNamesRegistrar.s.sol";

interface INamesF {
    function resolve(string calldata name) external view returns (address holder, bytes32 keyX, bytes32 keyY, uint64 expires);
    function priceOf(string calldata name, uint256 years_) external view returns (uint256);
    function treasury() external view returns (address);
    function token() external view returns (address);
}

interface IERC20F {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}

contract FAccept is IVerifier {
    function verify(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return true;
    }
}

contract FBind is IVerifier {
    function verify(bytes calldata proof, uint256[] calldata inputs) external pure returns (bool) {
        if (inputs.length != 5) return true;
        return abi.decode(proof, (address)) == address(uint160(inputs[4]));
    }
}

contract GloamNamesRegistrarForkTest is Test {
    using stdJson for string;

    address constant NAMES = 0x62c435CE6886fa91e3b0e91500c6dC9219723457;
    address constant GLOAM = 0xDcD885F5c60b3aD49F6D58718696417314e8724d;
    address constant TREASURY = 0xB3900ac9350903218e4c7597bAb0f008F01B30B8;
    address constant LIVE_VAULT = 0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194;
    bytes32 constant GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296;
    bytes32 constant GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5;
    uint16 constant FEE_BPS = 50;

    bool on;
    ShieldPoolPayments pool;
    GloamNamesRegistrar reg;
    address depositor = makeAddr("depositor");
    address holder = makeAddr("holder");

    function setUp() public {
        if (!vm.envOr("RH_FORK", false)) return;
        on = true;
        vm.createSelectFork("https://rpc.mainnet.chain.robinhood.com");
        pool = new ShieldPoolPayments(_deployPoseidon(), address(new FBind()));
        pool.setShieldVerifier(address(new FAccept()));
        pool.setWithdrawFee(FEE_BPS, makeAddr("feeTo"));
        pool.turnOnDepositLimits();
        pool.setDepositLimit(GLOAM, 25_000e18, 250_000e18);
        // real $GLOAM, given to a depositor (its balance slot), shielded so the vault backs the notes
        deal(GLOAM, depositor, 1_000e18);
        vm.startPrank(depositor);
        IERC20F(GLOAM).approve(address(pool), type(uint256).max);
        for (uint256 i = 0; i < 4; i++) pool.shieldBound(GLOAM, 100e18, bytes32(uint256(0xF00D + i)), hex"00");
        vm.stopPrank();
        reg = new GloamNamesRegistrar(address(pool), NAMES, TREASURY);
    }

    function _deployPoseidon() internal returns (address addr) {
        string memory json = vm.readFile("test/fixtures/Poseidon2.json");
        bytes memory bytecode = json.readBytes(".bytecode");
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
    }

    function _fee(uint256 amount) internal pure returns (uint256) {
        return (amount / 10_000) * FEE_BPS + ((amount % 10_000) * FEE_BPS) / 10_000;
    }

    function _noteFor(uint256 price) internal pure returns (uint256 a) {
        a = (price * 10_000 + (10_000 - FEE_BPS) - 1) / (10_000 - FEE_BPS);
        while (a - _fee(a) < price) a++;
    }

    function _claim(uint256 nul, string memory name, uint256 years_, uint256 amount) internal returns (uint256 paid, GloamNamesRegistrar.Refund memory r) {
        GloamNamesRegistrar.Claim memory c = GloamNamesRegistrar.Claim(name, GX, GY, holder, years_);
        r = GloamNamesRegistrar.Refund(hex"00", bytes32(nul + 0x1000), amount - amount / 100);
        address escrow = reg.escrowFor(
            GloamNamesRegistrar.EscrowKey(bytes32(nul), amount, keccak256(bytes(name)), GX, GY, holder, years_, r.commitment, r.amount)
        );
        GloamNamesRegistrar.Spend memory s = GloamNamesRegistrar.Spend(abi.encode(escrow), pool.currentRoot(), bytes32(nul), amount);
        vm.prank(makeAddr("relayer"));
        paid = reg.claim(s, c, r);
    }

    function test_fork_private_claim_on_the_live_registry() public {
        if (!on) return;
        string memory name = "privateyomi7";
        (address before, , , ) = INamesF(NAMES).resolve(name);
        assertEq(before, address(0), "name free on mainnet");
        uint256 price = INamesF(NAMES).priceOf(name, 1);
        assertEq(price, 5e18, "5+ letters: 5 GLOAM a year (live price)");
        uint256 tBefore = IERC20F(GLOAM).balanceOf(TREASURY);
        uint256 note = _noteFor(price);

        (uint256 paid, ) = _claim(1, name, 1, note);

        assertEq(paid, price);
        (address h, bytes32 x, bytes32 y, uint64 exp) = INamesF(NAMES).resolve(name);
        assertEq(h, holder);
        assertEq(x, GX);
        assertEq(y, GY);
        assertEq(exp, uint64(block.timestamp + 365 days));
        assertEq(IERC20F(GLOAM).balanceOf(TREASURY) - tBefore, note - _fee(note), "treasury: the price and the dust");
        assertEq(IERC20F(GLOAM).balanceOf(address(reg)), 0);
        assertEq(IERC20F(GLOAM).allowance(address(reg), NAMES), 0);
        console2.log("note spent (GLOAM wei)", note);
        console2.log("price paid", paid);
    }

    function test_fork_front_run_refunds_with_real_gloam() public {
        if (!on) return;
        uint256 note = _noteFor(15e18);
        GloamNamesRegistrar.Claim memory c = GloamNamesRegistrar.Claim("yomx", GX, GY, holder, 1);
        GloamNamesRegistrar.Refund memory r = GloamNamesRegistrar.Refund(hex"00", bytes32(uint256(0xABC)), note - note / 100);
        address escrow = reg.escrowFor(
            GloamNamesRegistrar.EscrowKey(bytes32(uint256(9)), note, keccak256(bytes(c.name)), GX, GY, holder, 1, r.commitment, r.amount)
        );
        GloamNamesRegistrar.Spend memory s = GloamNamesRegistrar.Spend(abi.encode(escrow), pool.currentRoot(), bytes32(uint256(9)), note);
        pool.unshield(s.proof, s.root, s.nullifier, GLOAM, escrow, note);
        assertEq(reg.claim(s, c, r), 0);
        assertTrue(pool.commitmentSeen(r.commitment), "refund note in the vault");
        (address h, , , ) = INamesF(NAMES).resolve("yomx");
        assertEq(h, address(0));
    }

    function test_fork_deploy_script_against_the_live_vault() public {
        if (!on) return;
        vm.setEnv("DEPLOYER", vm.toString(makeAddr("deployer")));
        GloamNamesRegistrar live = new DeployGloamNamesRegistrar().run();
        assertEq(address(live.vault()), LIVE_VAULT);
        assertEq(address(live.names()), NAMES);
        assertEq(live.token(), GLOAM);
        assertEq(live.treasury(), TREASURY);
        assertEq(INamesF(NAMES).token(), GLOAM);
        // the live vault refuses a claim whose proof is not real: nothing moves
        GloamNamesRegistrar.Claim memory c = GloamNamesRegistrar.Claim("nobodyfree", GX, GY, holder, 1);
        GloamNamesRegistrar.Refund memory r = GloamNamesRegistrar.Refund(hex"00", bytes32(uint256(1)), 1e18);
        GloamNamesRegistrar.Spend memory s = GloamNamesRegistrar.Spend(hex"00", bytes32(0), bytes32(uint256(0xDEAD)), 6e18);
        vm.expectRevert();
        live.claim(s, c, r);
    }
}
