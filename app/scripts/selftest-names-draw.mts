/**
 * Self-test: the names draw (lib/nameStats pickWinners). The same beacon and list
 * always give the same picks, picks never repeat, and asking for more than the
 * list holds returns the whole list.
 *
 * Run from app/:  pnpm dlx tsx scripts/selftest-names-draw.mts
 */
import assert from "node:assert/strict";
import { pickWinners } from "../src/lib/nameStats";

const names = ["yomi", "duke", "diva", "kris", "zoe", "robin", "romeo", "amaka"];
const R = "8b676484b5fb1f37f9ec5c413c7d29883a0c9d9b7a0e9e8a2d8e3a1c5b4f6e7d";

const a = pickWinners(R, names, 2);
assert.deepEqual(a, pickWinners(R, names, 2), "same beacon, same picks");
assert.equal(new Set(a).size, 2, "no name twice");
assert.ok(a.every((x) => names.includes(x)));
assert.deepEqual(pickWinners(R.toUpperCase(), names, 2), a, "case of the beacon doesn't matter");
assert.notDeepEqual(pickWinners(R.replace(/^8/, "9"), names, 8), pickWinners(R, names, 8), "another beacon, another order");
assert.deepEqual(new Set(pickWinners(R, names, 20)), new Set(names), "more than the list: the whole list");
assert.deepEqual(pickWinners(R, [], 2), []);
assert.deepEqual(names, ["yomi", "duke", "diva", "kris", "zoe", "robin", "romeo", "amaka"], "the list itself is untouched");
console.log("names draw: 8 passed");
