/**
 * Self-test: Gloam names in the app (lib/gloamNames, lib/receiveTag, lib/payRecipient).
 *
 * "@duke" in Pay is a name to look up; a name record turns back into the exact
 * Gloam address it was made from; a bad or empty record never becomes an
 * address. Nothing here reads a chain or moves money.
 *
 * Run from app/:  pnpm dlx tsx scripts/selftest-gloam-names.mts
 */
import assert from "node:assert/strict";
import { zeroAddress, type Address, type Hex } from "viem";
import {
  isBlockedName,
  isValidName,
  nameExpired,
  nameFromClaimInput,
  nameFromPayInput,
  nameProblem,
  readNameRecord,
  type NameReader,
} from "../src/lib/gloamNames";
import { RECEIVE_TAG_PREFIX, isValidReceiveTag, receiveTagFromPoint, receiveTagPoint } from "../src/lib/receiveTag";
import { classifyPayRecipient } from "../src/lib/payRecipient";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

async function freshTag(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return RECEIVE_TAG_PREFIX + Buffer.from(spki).toString("base64url");
}

const HOLDER = "0x1111111111111111111111111111111111111111" as Address;

await test("name shape matches the registry's rules", () => {
  for (const ok of ["duke", "abc", "duke_01", "a_long_name_here_20c"]) assert.equal(isValidName(ok), true, ok);
  for (const bad of ["ab", "Duke", "du-ke", "du.ke", "du ke", "", "a_name_that_is_way_too_long", "dukё"]) {
    assert.equal(isValidName(bad), false, bad);
  }
});

await test("Pay reads only @name as a name", () => {
  assert.equal(nameFromPayInput("@duke"), "duke");
  assert.equal(nameFromPayInput("  @Duke  "), "duke");
  assert.equal(nameFromPayInput("duke"), null);
  assert.equal(nameFromPayInput("@du"), null);
  assert.equal(nameFromPayInput("@du-ke"), null);
  assert.equal(nameFromPayInput("@"), null);
  assert.deepEqual(classifyPayRecipient("@duke"), { kind: "name", name: "duke" });
  assert.equal(classifyPayRecipient("duke").kind, "other");
  assert.equal(classifyPayRecipient("@du").kind, "other");
  assert.equal(classifyPayRecipient("vitalik.eth").kind, "ens");
  assert.equal(classifyPayRecipient("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045").kind, "address");
});

await test("picking a name: @ and case are forgiven, problems are named", () => {
  assert.equal(nameFromClaimInput(" @Duke "), "duke");
  assert.equal(nameProblem(""), null);
  assert.equal(nameProblem("duke"), null);
  assert.match(nameProblem("du") ?? "", /at least 3/);
  assert.match(nameProblem("a".repeat(21)) ?? "", /at most 20/);
  assert.match(nameProblem("du-ke") ?? "", /letters, numbers and underscores/);
});

await test("a Gloam address survives the trip through the registry", async () => {
  for (let i = 0; i < 20; i++) {
    const tag = await freshTag();
    assert.equal(isValidReceiveTag(tag), true);
    const point = receiveTagPoint(tag);
    assert.ok(point);
    assert.match(point.x, /^0x[0-9a-f]{64}$/);
    assert.equal(receiveTagFromPoint(point.x, point.y), tag);
  }
});

await test("a point off the curve, or a broken one, never becomes an address", async () => {
  const point = receiveTagPoint(await freshTag())!;
  const otherY = receiveTagPoint(await freshTag())!.y;
  assert.equal(receiveTagFromPoint(point.x, otherY), null);
  assert.equal(receiveTagFromPoint(`0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`), null);
  assert.equal(receiveTagFromPoint("0x1234", point.y), null);
  assert.equal(receiveTagPoint("gloamr1.invalid"), null);
  assert.equal(receiveTagPoint("not an address"), null);
});

await test("reading a record: found, empty, bad key, failed read", async () => {
  const tag = await freshTag();
  const { x, y } = receiveTagPoint(tag)!;
  const reader =
    (holder: Address, kx: Hex, ky: Hex, expires: bigint): NameReader =>
    async () =>
      [holder, kx, ky, expires] as const;

  const found = await readNameRecord("duke", reader(HOLDER, x, y, 2_000_000_000n));
  assert.deepEqual(found, { name: "duke", tag, holder: HOLDER, expires: 2_000_000_000 });

  const zero = `0x${"00".repeat(32)}` as Hex;
  assert.equal(await readNameRecord("duke", reader(zeroAddress, zero, zero, 0n)), null);
  const otherY = receiveTagPoint(await freshTag())!.y;
  assert.equal(await readNameRecord("duke", reader(HOLDER, x, otherY, 2_000_000_000n)), null);
  assert.equal(
    await readNameRecord("duke", async () => {
      throw new Error("rpc down");
    }),
    null
  );
  let asked = false;
  assert.equal(
    await readNameRecord("Du", async () => {
      asked = true;
      return [HOLDER, x, y, 1n] as const;
    }),
    null
  );
  assert.equal(asked, false, "an invalid name is never sent to the chain");
});

await test("expiry is judged against the time given", () => {
  assert.equal(nameExpired({ expires: 100 }, 99), false);
  assert.equal(nameExpired({ expires: 100 }, 100), false);
  assert.equal(nameExpired({ expires: 100 }, 101), true);
});

await test("team, staff and brand names are blocked, with their disguises", async () => {
  for (const n of [
    "gloam", "gloamtrade", "gloam_support", "xgloamx", "gl0am", "glim",
    "support", "supp0rt", "support1", "s_u_p_p_o_r_t", "support_team", "help", "h3lp",
    "official", "0ff1c1al", "official_okx", "adminbob", "4dmin", "airdrop2026", "refunds",
    "okx", "robinhood", "usdg", "treasury",
  ]) {
    assert.equal(isBlockedName(n), true, n);
    assert.match(nameProblem(n) ?? "", /isn't available/, n);
  }
  for (const n of ["duke", "alice", "badminton", "glimmer", "teamrocket", "helper", "basel", "ama_99", "sam"]) {
    assert.equal(isBlockedName(n), false, n);
    assert.equal(nameProblem(n), null, n);
  }
  let asked = false;
  const record = await readNameRecord("support", async () => {
    asked = true;
    return ["0x00000000000000000000000000000000000000aa" as Address, "0x01" as Hex, "0x02" as Hex, 1n];
  });
  assert.equal(record, null, "a blocked name never resolves, even if someone registered it on chain");
  assert.equal(asked, false, "a blocked name is never looked up");
});

console.log(`\n${passed} passed`);
