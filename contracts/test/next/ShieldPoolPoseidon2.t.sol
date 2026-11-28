// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Ported from test/ShieldPoolPoseidon.t.sol to the next vault (not deployed, not audited).
// Keep the two in step until the live vaults are retired.

import {PoolHarness2, STRAY} from "./NextHarness.sol";
import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ShieldPoolCore2} from "../../src/ShieldPoolCore2.sol";
import {UnshieldVerifier} from "../../src/verifiers/UnshieldVerifier.sol";
import {UnshieldIVerifier} from "../../src/verifiers/UnshieldIVerifier.sol";
import {IPoseidon2} from "../../src/lib/IPoseidon.sol";

contract ShieldPoolPoseidonTestNext is Test {
    using stdJson for string;

    PoolHarness2 pool;
    UnshieldIVerifier adapter;
    address poseidon2;

    function setUp() public {
        poseidon2 = _deployPoseidon(2);
        UnshieldVerifier g16 = new UnshieldVerifier();
        adapter = new UnshieldIVerifier(g16);
        pool = new PoolHarness2(poseidon2, address(adapter));
        vm.deal(address(this), 100 ether);
    }

    function test_scheme_is_poseidon() public view {
        assertEq(
            keccak256(bytes(pool.HASH_SCHEME())),
            keccak256(bytes("poseidon"))
        );
        assertEq(pool.PROOF_LAYOUT_VERSION(), 2);
    }

    function test_shield_eth_updates_root() public {
        bytes32 root0 = pool.currentRoot();
        // field element as leaf (non-zero)
        bytes32 leaf = bytes32(uint256(12345));
        pool.shield{value: 1 ether}(address(0), 1 ether, leaf);
        assertEq(pool.nextIndex(), 1);
        assertEq(pool.deposited(address(0)), 1 ether);
        assertTrue(pool.currentRoot() != root0);
        assertTrue(pool.isKnownRoot(pool.currentRoot()));
    }

    function test_unshield_with_real_proof() public {
        // Use fixed leaf matching fixture commitment after we insert path tree offline.
        // Full e2e: shield commitment from fixture, then unshield with proof.
        // Fixture commitment (from real-input gen):
        uint256 commitment = 11179136681126804365240602711725845052065738228952456689860115672198330107473;
        // For a valid unshield the tree must match the proof's root.
        // Building the exact 3-leaf tree on-chain:
        uint256 leaf1 = 11179136681126804365240602711725845052065738228952456689860115672198330107473;
        // other leaves from gen-real-input
        // We only insert leaf0 for a simpler test: unshield needs matching root.
        // Skip full e2e if tree doesn't match fixture — use known proof only on verifier.
        // Here: ensure unshield reverts without matching root even with valid snark.
        bytes32 root = bytes32(
            uint256(
                13234193652734635164697424209615330599412255191967788575267034634808796923137
            )
        );
        bytes32 nullifier = bytes32(
            uint256(
                1945704986784996205275124157419427994886512646982192210318468338970744312245
            )
        );

        // Build proof bytes for fixture (swapped G2)
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
        // verify adapter alone works
        assertTrue(
            adapter.verify(
                abi.encode(a, b, c),
                _pub(
                    13234193652734635164697424209615330599412255191967788575267034634808796923137,
                    1945704986784996205275124157419427994886512646982192210318468338970744312245,
                    0,
                    1000000000000000,
                    1288467190840644149448244075784839353812473341992
                )
            )
        );

        // Unknown root on empty-ish pool. The note's amount is backed first: the
        // pool's balance check now runs before the proof (Kann I-05).
        vm.deal(address(this), 1 ether);
        pool.shield{value: 1000000000000000}(address(0), 1000000000000000, bytes32(uint256(777)));
        vm.expectRevert(ShieldPoolCore2.UnknownRoot.selector);
        pool.unshield(
            abi.encode(a, b, c),
            root,
            nullifier,
            address(0),
            address(uint160(1288467190840644149448244075784839353812473341992)),
            1000000000000000
        );

        // silence unused
        commitment;
        leaf1;
    }

    function _pub(
        uint256 r,
        uint256 n,
        uint256 asset,
        uint256 amount,
        uint256 to
    ) internal pure returns (uint256[] memory inputs) {
        inputs = new uint256[](5);
        inputs[0] = r;
        inputs[1] = n;
        inputs[2] = asset;
        inputs[3] = amount;
        inputs[4] = to;
    }

    function _deployPoseidon(uint256 nInputs) internal returns (address addr) {
        string memory path = nInputs == 2
            ? "test/fixtures/Poseidon2.json"
            : "test/fixtures/Poseidon3.json";
        string memory json = vm.readFile(path);
        bytes memory bytecode = json.readBytes(".bytecode");
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "poseidon deploy failed");
        // sanity
        uint256[2] memory input;
        input[0] = 1;
        input[1] = 2;
        uint256 out = IPoseidon2(addr).poseidon(input);
        require(out != 0, "poseidon zero");
    }
}
