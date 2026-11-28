// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoseidon2} from "./IPoseidon.sol";

/**
 * NEXT VAULT. NOT DEPLOYED. NOT AUDITED. The live vaults run IncrementalMerkleTreePoseidon.sol, which
 * stays in this repo unchanged. Nothing here reaches a live contract: a deployed
 * vault cannot be upgraded.
 *
 * @title IncrementalMerkleTreePoseidon2
 * @notice Same insert API as keccak tree, but H(left,right)=Poseidon2(left,right).
 * @dev Pair with unshield.circom MerkleTreeChecker. Depth 20. No root ring buffer:
 *      nothing read it and `knownRoots` is what checks a root (Kann I-06), so each
 *      insert does two fewer storage writes.
 */
library IncrementalMerkleTreePoseidon2 {
    uint256 internal constant DEPTH = 20;
    uint256 internal constant MAX_LEAVES = uint256(1) << DEPTH;

    struct Tree {
        uint256 nextIndex;
        uint256 currentRoot;
        uint256[DEPTH] filledSubtrees;
        uint256[DEPTH] zeros;
        mapping(uint256 => bool) knownRoots;
        IPoseidon2 poseidon;
        bool initialized;
    }

    error TreeFull();
    error ZeroLeaf();
    error NotInitialized();

    function initialize(Tree storage self, IPoseidon2 poseidon_) internal {
        self.poseidon = poseidon_;
        // Precomputed Poseidon2 zero-subtree hashes for a zero leaf. Hardcoded so
        // the constructor does no on-chain hashing: computing these via 20 Poseidon
        // calls costs ~30M gas, which is over Tempo's 30M per-tx cap. These are the
        // exact values the on-chain loop produced, verified against the live pool's
        // isKnownRoot(emptyRoot) == true. insert() still uses self.poseidon.
        self.zeros[0] = 0;
        self.zeros[1] = 14744269619966411208579211824598458697587494354926760081771325075741142829156;
        self.zeros[2] = 7423237065226347324353380772367382631490014989348495481811164164159255474657;
        self.zeros[3] = 11286972368698509976183087595462810875513684078608517520839298933882497716792;
        self.zeros[4] = 3607627140608796879659380071776844901612302623152076817094415224584923813162;
        self.zeros[5] = 19712377064642672829441595136074946683621277828620209496774504837737984048981;
        self.zeros[6] = 20775607673010627194014556968476266066927294572720319469184847051418138353016;
        self.zeros[7] = 3396914609616007258851405644437304192397291162432396347162513310381425243293;
        self.zeros[8] = 21551820661461729022865262380882070649935529853313286572328683688269863701601;
        self.zeros[9] = 6573136701248752079028194407151022595060682063033565181951145966236778420039;
        self.zeros[10] = 12413880268183407374852357075976609371175688755676981206018884971008854919922;
        self.zeros[11] = 14271763308400718165336499097156975241954733520325982997864342600795471836726;
        self.zeros[12] = 20066985985293572387227381049700832219069292839614107140851619262827735677018;
        self.zeros[13] = 9394776414966240069580838672673694685292165040808226440647796406499139370960;
        self.zeros[14] = 11331146992410411304059858900317123658895005918277453009197229807340014528524;
        self.zeros[15] = 15819538789928229930262697811477882737253464456578333862691129291651619515538;
        self.zeros[16] = 19217088683336594659449020493828377907203207941212636669271704950158751593251;
        self.zeros[17] = 21035245323335827719745544373081896983162834604456827698288649288827293579666;
        self.zeros[18] = 6939770416153240137322503476966641397417391950902474480970945462551409848591;
        self.zeros[19] = 10941962436777715901943463195175331263348098796018438960955633645115732864202;
        for (uint256 i = 0; i < DEPTH; i++) {
            self.filledSubtrees[i] = self.zeros[i];
        }
        uint256 z =
            15019797232609675441998260052101280400536945603062888308240081994073687793470;
        self.currentRoot = z;
        self.knownRoots[z] = true;
        self.nextIndex = 0;
        self.initialized = true;
    }

    function insert(Tree storage self, uint256 leaf) internal returns (uint256 index) {
        if (!self.initialized) revert NotInitialized();
        if (leaf == 0) revert ZeroLeaf();
        if (self.nextIndex >= MAX_LEAVES) revert TreeFull();

        index = self.nextIndex;
        uint256 currentIndex = index;
        uint256 currentLevelHash = leaf;

        for (uint256 i = 0; i < DEPTH; i++) {
            if (currentIndex % 2 == 0) {
                self.filledSubtrees[i] = currentLevelHash;
                currentLevelHash = _hash(self, currentLevelHash, self.zeros[i]);
            } else {
                currentLevelHash = _hash(
                    self,
                    self.filledSubtrees[i],
                    currentLevelHash
                );
            }
            currentIndex /= 2;
        }

        self.currentRoot = currentLevelHash;
        self.knownRoots[currentLevelHash] = true;

        self.nextIndex = index + 1;
    }

    /// @dev Every root ever produced stays valid permanently (via `knownRoots`), so an
    ///      in-flight proof never expires.
    function isKnownRoot(Tree storage self, uint256 root) internal view returns (bool) {
        if (root == 0) return false;
        return self.knownRoots[root];
    }

    function _hash(
        Tree storage self,
        uint256 left,
        uint256 right
    ) private view returns (uint256) {
        uint256[2] memory inputs;
        inputs[0] = left;
        inputs[1] = right;
        return self.poseidon.poseidon(inputs);
    }
}
