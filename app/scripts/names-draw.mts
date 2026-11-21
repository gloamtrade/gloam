/**
 * The names surprise draw: pick N claimed Gloam names at random with a public
 * drand beacon, so anyone can check the pick. Read-only: it never signs or sends.
 * The team pays each winner privately at their @name from the app's Pay.
 *
 *   pnpm dlx tsx scripts/names-draw.mts --list
 *       every name claimed so far
 *   pnpm dlx tsx scripts/names-draw.mts --cutoff 2026-11-23T18:00:00Z [--count 2] [--write]
 *       the draw: names claimed at or before the cutoff, still paid up, not the team's,
 *       not blocked in the app, in claim order; drand mainnet round = the first round
 *       published after the cutoff (or --round N). Pick k = sha256("<randomness>:<k>")
 *       mod the names still left (lib/nameStats pickWinners).
 *
 * drand mainnet (the ceremony's chain): 8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce,
 * 30 s rounds from 1595431050. https://api.drand.sh/public/<round>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sha256, stringToBytes } from "viem";
import { getNetwork } from "../src/lib/networks";
import { publicClientFor } from "../src/lib/rhClient";
import { readClaimedNames, pickWinners, type ClaimedName } from "../src/lib/nameStats";
import { excludedFor } from "../src/lib/vote/excluded";

const DRAND_GENESIS = 1595431050;
const DRAND_PERIOD = 30;
const DRAND_CHAIN = "8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce";
const SAFE = "0x8E74b2b85b40f36771f92392b42BBaeacDC75507";

const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (k: string) => argv.includes(`--${k}`);
const iso = (s: number) => new Date(s * 1000).toISOString().replace(".000Z", "Z");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const client = publicClientFor(getNetwork("robinhood-mainnet"));
const snap = await readClaimedNames(client);

if (flag("list") || !opt("cutoff")) {
  console.log(`${snap.names.length} name(s) on the registry, ${snap.registrations} registration(s), ${snap.collectedGloam} $GLOAM to the treasury (block ${snap.latestBlock}).\n`);
  for (const n of snap.names) {
    console.log(`@${n.name.padEnd(21)} ${short(n.holder)}  claimed ${iso(n.claimedAt)}  paid until ${iso(n.expires).slice(0, 10)}  ${n.paidGloam} GLOAM${n.blocked ? "  (blocked in app)" : ""}`);
  }
  if (!opt("cutoff")) process.exit(0);
}

const cutoff = Math.floor(Date.parse(opt("cutoff")!) / 1000);
if (!Number.isFinite(cutoff)) throw new Error("--cutoff must be an ISO time, e.g. 2026-11-23T18:00:00Z");
const count = Number(opt("count") ?? 2);
const round = opt("round") ? Number(opt("round")) : Math.floor((cutoff - DRAND_GENESIS) / DRAND_PERIOD) + 2;
const publishes = DRAND_GENESIS + (round - 1) * DRAND_PERIOD;
if (publishes <= cutoff) throw new Error(`Round ${round} was published before the cutoff; pick a later one.`);

// the team: the vote exclusion list, the deployer, the Safe and every Safe signer
const owners = (await client.readContract({
  address: SAFE,
  abi: [{ type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] }],
  functionName: "getOwners",
})) as `0x${string}`[];
const team = excludedFor([
  { address: "0xec9993765e249e8e9DC677B7BCB61F78b31c6b60", reason: "Team: the deployer" },
  { address: SAFE, reason: "Team: the Gloam Owner Safe" },
  ...owners.map((o) => ({ address: o, reason: "Team: a Safe signer" })),
]);

const eligible: ClaimedName[] = snap.names.filter(
  (n) => n.claimedAt > 0 && n.claimedAt <= cutoff && n.expires > cutoff && !n.blocked && !team.has(n.holder.toLowerCase())
);
const listDigest = sha256(stringToBytes(eligible.map((n) => n.name).join(",")));
console.log(`\nDraw: names claimed by ${iso(cutoff)}, ${eligible.length} eligible (list sha256 ${listDigest}).`);
eligible.forEach((n, i) => console.log(`  ${String(i).padStart(3)}  @${n.name}`));

if (Date.now() / 1000 < publishes) {
  console.log(`\ndrand round ${round} publishes ${iso(publishes)}. Run again after that.`);
  process.exit(0);
}
const res = await fetch(`https://api.drand.sh/${DRAND_CHAIN}/public/${round}`);
if (!res.ok) throw new Error(`drand round ${round}: HTTP ${res.status}`);
const beacon = (await res.json()) as { round: number; randomness: string };
const winners = pickWinners(beacon.randomness, eligible, count);
console.log(`\ndrand round ${beacon.round}, randomness ${beacon.randomness}`);
console.log(`Winners: ${winners.map((w) => "@" + w.name).join(", ")}`);
console.log("Pay each one privately at their @name from the app's Pay.");

if (flag("write")) {
  const dir = join(homedir(), "Desktop", "Gloam-Names-Draw");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `draw-${round}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      { cutoff: iso(cutoff), drand: { chain: DRAND_CHAIN, round, randomness: beacon.randomness }, rule: 'pick k = sha256("<randomness>:<k>") mod names left, in claim order', listDigest, eligible: eligible.map((n) => n.name), winners: winners.map((w) => w.name) },
      null,
      2
    )
  );
  console.log(`Saved ${file}`);
}
