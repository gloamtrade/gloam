// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Ported from test/KenshoOct11.t.sol to the next vault (not deployed, not audited).
// Keep the two in step until the live vaults are retired.

import {PoolHarness2, STRAY} from "./NextHarness.sol";
import {Test, console} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore2} from "../../src/ShieldPoolCore2.sol";
import {UnshieldVerifier} from "../../src/verifiers/UnshieldVerifier.sol";
import {UnshieldIVerifier} from "../../src/verifiers/UnshieldIVerifier.sol";
import {TransferVerifier} from "../../src/verifiers/TransferVerifier.sol";
import {TransferIVerifier} from "../../src/verifiers/TransferIVerifier.sol";
import {DualProofVerifier2} from "../../src/verifiers/DualProofVerifier2.sol";

/**
 * Kensho 2026-10-11. Local unit tests only; nothing touches a live network.
 *
 * R-2: a relayed spend that loses a race (same proof sent twice, or copied by
 * anyone) reverts with AlreadySpent only AFTER the full Groth16 pairing check,
 * because the pool verifies the proof before it looks at `spent`. The relay's
 * dry run cannot catch two in-flight copies, so each extra copy costs the relay
 * the whole verification. Correctness is unaffected; this is a cost note.
 *
 * Uses the repo's real unshield proof fixture (PoolHarness2.t.sol). Its
 * root is marked known with vm.store, which stands in for the tree state the
 * proof was generated against.
 */
contract KenshoOct11TestNext is Test {
    using stdJson for string;

    PoolHarness2 pool;

    uint256 constant ROOT = 13234193652734635164697424209615330599412255191967788575267034634808796923137;
    uint256 constant NULLIFIER = 1945704986784996205275124157419427994886512646982192210318468338970744312245;
    uint256 constant AMOUNT = 1000000000000000;
    address constant TO = address(uint160(1288467190840644149448244075784839353812473341992));
    uint256 constant KNOWN_ROOTS_SLOT = 46; // tree (slot 4) + 42 words: nextIndex, currentRoot, 20 filled, 20 zeros

    function setUp() public {
        address poseidon2 = _deployPoseidon2();
        UnshieldIVerifier u = new UnshieldIVerifier(new UnshieldVerifier());
        TransferIVerifier t = new TransferIVerifier(new TransferVerifier());
        pool = new PoolHarness2(poseidon2, address(new DualProofVerifier2(u, t)));
        // Back the note: a plain native shield (no shield verifier in this fresh pool).
        vm.deal(address(this), 1 ether);
        pool.shield{value: AMOUNT}(address(0), AMOUNT, bytes32(uint256(777)));
        // The fixture proof was made against ROOT; mark it known.
        vm.store(address(pool), keccak256(abi.encode(ROOT, KNOWN_ROOTS_SLOT)), bytes32(uint256(1)));
        assertTrue(pool.isKnownRoot(bytes32(ROOT)));
    }

    function _proof() internal pure returns (bytes memory) {
        uint256[2] memory a = [
            6957634454184109021678114444733524918042004519382135232440347764408400209238,
            11907590611510504133919552265477234176969003254081885100204008656767523539196
        ];
        uint256[2][2] memory b = [
            [
                12074783442507916633665182906111838295327766373230105789758870116418853661786,
                19673558567803714857983365441418227075419614852577444669868838041523053822495
            ],
            [
                14345503577131882347105010025369547760188533575101097022140360378203860768985,
                19277946504698722565498037945482598261293101185291893033191136039510096573580
            ]
        ];
        uint256[2] memory c = [
            1286191535724976993115868645733440518664215538340370499605925468686013731076,
            11746696505189778215652626326845383882865623404423651651334365119807194577109
        ];
        return abi.encode(a, b, c);
    }

    function _unshield() internal {
        pool.unshield(_proof(), bytes32(ROOT), bytes32(NULLIFIER), address(0), TO, AMOUNT);
    }

    /// Fixed for mainnet (pre-mainnet audit R-1): `spent` is read before the proof,
    /// so a duplicate stops at one storage read instead of a pairing check.
    function test_R2_duplicate_spend_stops_before_verification() public {
        uint256 g0 = gasleft();
        _unshield();
        uint256 firstGas = g0 - gasleft();
        assertEq(TO.balance, AMOUNT, "first copy pays the bound recipient");
        assertTrue(pool.isSpent(bytes32(NULLIFIER)));

        // Second, identical copy (what a racing relay request or a copier sends).
        uint256 g1 = gasleft();
        try pool.unshield(_proof(), bytes32(ROOT), bytes32(NULLIFIER), address(0), TO, AMOUNT) {
            fail();
        } catch (bytes memory err) {
            assertEq(bytes4(err), ShieldPoolCore2.AlreadySpent.selector);
        }
        uint256 dupGas = g1 - gasleft();

        // What the same rejection costs when `spent` is read first (one cold SLOAD + revert).
        uint256 g2 = gasleft();
        bool s = pool.isSpent(bytes32(NULLIFIER));
        uint256 precheckGas = g2 - gasleft();
        assertTrue(s);

        console.log("first unshield gas      ", firstGas);
        console.log("duplicate (reverts) gas ", dupGas);
        console.log("spent-first check gas   ", precheckGas);
        assertEq(TO.balance, AMOUNT, "no double payout");
        assertLt(dupGas, 150_000, "a duplicate no longer pays for the pairing check");
        assertLt(dupGas, firstGas / 3, "a duplicate costs a fraction of a real cash-out");
    }

    /// Informational: gas for one leaf insert (plain shield in a fresh test pool),
    /// used to price filling the depth-20 tree (2^20 leaves).
    function test_info_tree_insert_cost() public {
        uint256 g = gasleft();
        pool.shield{value: 1}(address(0), 1, bytes32(uint256(778)));
        uint256 used = g - gasleft();
        console.log("one shield (one leaf insert) gas", used);
        console.log("leaves left", (uint256(1) << 20) - pool.nextIndex());
    }

    /// Informational: gas for one private send (real transfer proof fixture from
    /// TransferVerifier.t.sol), i.e. what the relay pays per relayed transfer.
    function test_info_relayed_transfer_cost() public {
        uint256 root = 13234193652734635164697424209615330599412255191967788575267034634808796923137;
        uint256 nul = 1945704986784996205275124157419427994886512646982192210318468338970744312245;
        bytes32[2] memory outs = [
            bytes32(uint256(2186333139843944972658356119109857323200738647011566664081090527609332676017)),
            bytes32(uint256(3180035557422202473253632809944765439556973547489051915971181442156632288984))
        ];
        uint256[2] memory a = [
            4994736957918134786226605030040568191609880316858913371450060956591293020264,
            1939927180158196869479555283731397552051517026347560724497366490389645503831
        ];
        uint256[2] memory c = [
            775945886546460737893514309443563528369445707847419794797671770815409485006,
            5313733941641050780117625135868340314175452320815727461455282425870701311089
        ];
        uint256 x0 = 5814710323753880607625188964305193786620395657213476869001018618896200906011;
        uint256 x1 = 14648938953548529752399047728535083902285724950969956080342401724612824582190;
        uint256 y0 = 14024005994502824019812057340112422029463536490776677972184979560384051446147;
        uint256 y1 = 3525631349122729021340704709433622805582432954772737725296117196252975128802;
        // The fixture is stored in one G2 coordinate order; accept whichever verifies.
        uint256[] memory pub = new uint256[](4);
        (pub[0], pub[1], pub[2], pub[3]) = (root, nul, uint256(outs[0]), uint256(outs[1]));
        bytes memory proof = abi.encode(a, [[x0, x1], [y0, y1]], c);
        if (!pool.verifier().verify(proof, pub)) proof = abi.encode(a, [[x1, x0], [y1, y0]], c);
        assertTrue(pool.verifier().verify(proof, pub), "fixture verifies");

        uint256 g = gasleft();
        pool.transfer(proof, bytes32(root), bytes32(nul), outs);
        uint256 used = g - gasleft();
        console.log("one relayed private send (verify + 2 inserts) gas", used);
        assertTrue(pool.isSpent(bytes32(nul)));
    }

    function _deployPoseidon2() internal returns (address addr) {
        bytes memory bytecode = vm.readFile("test/fixtures/Poseidon2.json").readBytes(".bytecode");
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "poseidon deploy failed");
    }
}
