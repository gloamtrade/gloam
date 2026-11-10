/**
 * Poseidon incremental Merkle tree. Matches IncrementalMerkleTreePoseidon.sol
 * and the circom MerkleTreeChecker.
 */

import { fieldToHex, poseidon2, toField } from "./poseidon.js";

export const MERKLE_DEPTH = 20;

export type PoseidonMerklePath = {
  leafIndex: number;
  leaf: bigint;
  pathElements: bigint[];
  pathIndices: number[];
  root: bigint;
};

export class IncrementalMerkleTreePoseidon {
  zeros: bigint[] = [];
  filledSubtrees: bigint[] = [];
  nextIndex = 0;
  currentRoot = 0n;
  leaves: bigint[] = [];
  /**
   * Every node written so far, by level (levels[0] are the leaves). A node that
   * is not here yet is that level's zero, so a path is 20 lookups, not a rebuild.
   */
  levels: bigint[][] = Array.from({ length: MERKLE_DEPTH }, () => []);
  private ready = false;

  async init() {
    if (this.ready) return;
    const zeros: bigint[] = [];
    let z = 0n;
    for (let i = 0; i < MERKLE_DEPTH; i++) {
      zeros.push(z);
      z = await poseidon2(z, z);
    }
    this.zeros = zeros;
    this.filledSubtrees = zeros.slice();
    this.currentRoot = z;
    this.ready = true;
  }

  async insert(leaf: bigint): Promise<number> {
    await this.init();
    const L = toField(leaf);
    if (L === 0n) throw new Error("ZeroLeaf");
    const index = this.nextIndex;
    let currentIndex = BigInt(index);
    let h = L;

    for (let i = 0; i < MERKLE_DEPTH; i++) {
      this.levels[i]![Number(currentIndex)] = h;
      if (currentIndex % 2n === 0n) {
        this.filledSubtrees[i] = h;
        h = await poseidon2(h, this.zeros[i]!);
      } else {
        h = await poseidon2(this.filledSubtrees[i]!, h);
      }
      currentIndex = currentIndex / 2n;
    }

    this.currentRoot = h;
    this.leaves.push(L);
    this.nextIndex = index + 1;
    return index;
  }

  async path(leafIndex: number): Promise<PoseidonMerklePath> {
    await this.init();
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new Error("leafIndex out of range");
    }

    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let idx = leafIndex;
    for (let level = 0; level < MERKLE_DEPTH; level++) {
      const isRight = idx % 2 === 1;
      pathElements.push(this.levels[level]![isRight ? idx - 1 : idx + 1] ?? this.zeros[level]!);
      pathIndices.push(isRight ? 1 : 0);
      idx = Math.floor(idx / 2);
    }
    const root = this.currentRoot;

    // verify
    let hash = this.leaves[leafIndex]!;
    let ix = leafIndex;
    for (let i = 0; i < MERKLE_DEPTH; i++) {
      const sib = pathElements[i]!;
      hash = ix % 2 === 0 ? await poseidon2(hash, sib) : await poseidon2(sib, hash);
      ix = Math.floor(ix / 2);
    }
    if (hash !== root) throw new Error("path verification failed");

    return { leafIndex, leaf: this.leaves[leafIndex]!, pathElements, pathIndices, root };
  }

  /** A copy that later inserts into this tree do not touch (a few array copies, no hashing). */
  clone(): IncrementalMerkleTreePoseidon {
    const t = new IncrementalMerkleTreePoseidon();
    t.zeros = this.zeros;
    t.filledSubtrees = this.filledSubtrees.slice();
    t.nextIndex = this.nextIndex;
    t.currentRoot = this.currentRoot;
    t.leaves = this.leaves.slice();
    t.levels = this.levels.map((level) => level.slice());
    t.ready = this.ready;
    return t;
  }
}

export function pathToCircomInput(path: PoseidonMerklePath) {
  return {
    pathElements: path.pathElements.map((x) => x.toString()),
    pathIndices: path.pathIndices.map(String),
    root: path.root.toString(),
    leaf: path.leaf.toString(),
    leafHex: fieldToHex(path.leaf),
    rootHex: fieldToHex(path.root),
  };
}
