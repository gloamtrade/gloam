// Written by scripts/vote-snapshot.mts. Do not edit by hand: run the script again.
import type { VoteSnapshot } from "../core";
import s0 from "./first-integration.json";
import s1 from "./gloam-migration.json";
import s2 from "./next-chain.json";
import s3 from "./private-swaps-next.json";

export const SNAPSHOTS: Record<string, VoteSnapshot> = {
  "first-integration": s0 as VoteSnapshot,
  "gloam-migration": s1 as VoteSnapshot,
  "next-chain": s2 as VoteSnapshot,
  "private-swaps-next": s3 as VoteSnapshot,
};
