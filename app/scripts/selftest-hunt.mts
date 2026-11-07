/**
 * Self-test: the treasure hunt (lib/hunt), off by default and driven only by
 * server environment variables.
 *
 *  - off (HUNT_ENABLED unset): no home page clue, the hidden page and its
 *    answer route 404, Glim's check says nothing, and gloam_info
 *    answers as usual whatever arguments it gets
 *  - answers match ignoring case, spaces, punctuation and curly quotes, as
 *    plain text or a sha256 hash of the normalized answer (older hashes too),
 *    with alternatives split by "|"; anything too long or not text never matches
 *  - the home page clue: the HTML comment can't be ended early and the console
 *    line can't break out of its <script>
 *  - the hidden page: only the configured path renders (a visit is counted),
 *    every other path 404s; a wrong answer gets nothing, the right one returns
 *    the next clue, tries are rate limited per IP
 *  - the MCP step: a wrong key gets the usual gloam_info, the right key alone
 *    only how to bring the pieces, the right key with pieces 1 to 3 in order
 *    the prize link, whole; neither argument is in the schema
 *  - every step is needed: the three pieces are random codes that hold
 *    nothing of the prize (the same pieces open any prize link), so whoever
 *    has them but not the key gets nothing; the link handed out opens as the
 *    note, in short or long form, and its nullifier (also worked out from a
 *    short link, a %23 one or its body alone) is what the admin's check reads
 *  - progress is counted per step as distinct people, and nothing in a client
 *    component imports lib/hunt
 *
 * All values are throwaway ones made here. Uses the in-process store; nothing
 * leaves this process.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-hunt.mts
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import Module from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// the page reads request headers: outside a request they come from this stub (empty)
const stubs: Record<string, string> = { "next/headers": fileURLToPath(new URL("./next-headers-stub.cjs", import.meta.url)) };
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolveFilename = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return stubs[req] ?? resolveFilename.call(this, req, ...rest);
};

const env = process.env as Record<string, string | undefined>;
env.GLOAM_PARTNERS_STORE = "memory";
delete env.UPSTASH_REDIS_REST_URL;
delete env.UPSTASH_REDIS_REST_TOKEN;
env.NODE_ENV = "test";
const HUNT_VARS = [
  "HUNT_ENABLED",
  "HUNT_SOURCE_COMMENT",
  "HUNT_CONSOLE_MESSAGE",
  "HUNT_PATH_2",
  "HUNT_PAGE_TITLE",
  "HUNT_RIDDLE",
  "HUNT_ANSWER_2",
  "HUNT_CLUE_3",
  "HUNT_GLIM_PASSPHRASE",
  "HUNT_CLUE_4",
  "HUNT_MCP_ARG",
  "HUNT_MCP_KEY",
  "HUNT_FINAL_INSTRUCTIONS",
  "HUNT_FRAGMENT_1",
  "HUNT_FRAGMENT_2",
  "HUNT_FRAGMENT_3",
  "HUNT_MCP_PIECES_ARG",
  "HUNT_PRIZE_LINK",
  "HUNT_PRIZE_NET",
  "HUNT_PRIZE_NULLIFIER",
];
for (const v of HUNT_VARS) delete env[v];

globalThis.fetch = (async (input: unknown) => {
  throw new Error(`selftest-hunt: no network calls allowed (${String(input)})`);
}) as typeof fetch;

const hunt = await import("../src/lib/hunt");
const { POST } = await import("../src/app/api/hunt/route");
const { callTool, TOOLS } = await import("../src/lib/mcpRemote/tools");
const { HuntSourceClue } = await import("../src/components/hunt/HuntSourceClue");
const { default: HuntPage } = await import("../src/app/hunt/[slug]/page");
const { prizeState } = await import("../src/lib/huntPrize");
const { nullifierOfClaimLink } = await import("../src/lib/huntNullifier");
const { buildNotePackage, encodeNotePackage } = await import("../src/lib/notePackage");
const { claimLinkFor, longClaimLinkFor, shortCodeFor } = await import("../src/lib/claimLink");
const { paymentNullifier } = await import("../src/lib/sentLinks");
const { fieldToHex, noteCommitmentPoseidon } = await import("@gloamtrade/sdk");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const word = () => randomBytes(6).toString("hex");
let ipN = 1;
const freshIp = () => `198.51.100.${ipN++}`;

function post(body: unknown, ip = "203.0.113.7"): Promise<Response> {
  return POST(
    new Request("https://www.gloam.trade/api/hunt", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function info(args: Record<string, unknown>, ip = "203.0.113.9") {
  const r = await callTool("gloam_info", args, { origin: "https://www.gloam.trade", ip });
  const first = r.content[0] as { type: string; text: string };
  return { isError: Boolean(r.isError), json: JSON.parse(first.text) as Record<string, unknown> };
}

/** Renders the hidden page at a path: "page" when it renders, "404" when it is not found. */
async function openPage(slug: string): Promise<"page" | "404"> {
  try {
    await HuntPage({ params: Promise.resolve({ slug }) });
    return "page";
  } catch (e) {
    if (String((e as { digest?: string })?.digest ?? "").includes("404")) return "404";
    throw e;
  }
}

// ---------------------------------------------------------------- off

const ANSWER = `Shielded ${word()}`;
const PATH = `p-${word()}`;
const KEY = `k-${word()}`;
const PHRASE = `Phrase ${word()} ${word()}`;

await test("off by default: nothing renders, nothing resolves, nothing answers", async () => {
  // set every other part, so only HUNT_ENABLED keeps it off
  env.HUNT_PATH_2 = PATH;
  env.HUNT_RIDDLE = "riddle";
  env.HUNT_ANSWER_2 = ANSWER;
  env.HUNT_CLUE_3 = "clue three";
  env.HUNT_SOURCE_COMMENT = "comment";
  env.HUNT_CONSOLE_MESSAGE = "console";
  env.HUNT_GLIM_PASSPHRASE = PHRASE;
  env.HUNT_CLUE_4 = "clue four";
  env.HUNT_MCP_KEY = KEY;
  env.HUNT_FINAL_INSTRUCTIONS = "final";
  for (const off of [undefined, "", "0", "false", "no", "yes"]) {
    if (off === undefined) delete env.HUNT_ENABLED;
    else env.HUNT_ENABLED = off;
    assert.equal(hunt.huntEnabled(), false, String(off));
    assert.equal(hunt.huntSourceClue(), null);
    assert.equal(HuntSourceClue(), null, "the home page gets nothing");
    assert.equal(hunt.huntPagePath(), null);
    assert.equal(await openPage(PATH), "404", "the hidden page is a 404");
    assert.equal(hunt.huntRiddle(), null);
    assert.equal(hunt.checkRiddleAnswer(ANSWER), null);
    assert.equal(hunt.glimHuntReply(PHRASE), null);
    assert.equal(hunt.mcpHuntFinal(KEY, "a b c"), null);
    assert.equal((await post({ answer: ANSWER })).status, 404);
    const r = await info({ code: KEY });
    assert.equal(r.isError, false);
    assert.ok(typeof r.json.what === "string" && !("message" in r.json), "gloam_info answers as usual");
  }
  assert.equal(hunt.huntSetup().enabled, false);
});

// ---------------------------------------------------------------- matching

await test("answers match ignoring case and spaces, plain or hashed, with alternatives", () => {
  assert.equal(hunt.matchesSecret("shielded pool", "Shielded Pool"), true);
  assert.equal(hunt.matchesSecret("  SHIELDEDPOOL ", "shielded pool"), true);
  assert.equal(hunt.matchesSecret("shielded\tpool\n", "shielded pool"), true);
  assert.equal(hunt.matchesSecret("shielded pools", "shielded pool"), false);
  assert.equal(hunt.matchesSecret("", "x"), false);
  assert.equal(hunt.matchesSecret("   ", " "), false);
  assert.equal(hunt.matchesSecret("x", ""), false);
  assert.equal(hunt.matchesSecret(42, "42"), false);
  assert.equal(hunt.matchesSecret(null, "x"), false);
  assert.equal(hunt.matchesSecret("a".repeat(hunt.HUNT_INPUT_MAX + 1), "a".repeat(hunt.HUNT_INPUT_MAX + 1)), false);
  // alternatives
  assert.equal(hunt.matchesSecret("two", "one | two"), true);
  assert.equal(hunt.matchesSecret("three", "one | two"), false);
  // hashed: sha256 of normalizeGuess(answer), here lowered with spaces removed
  const hashed = `sha256:${createHash("sha256").update("darkforest").digest("hex")}`;
  assert.equal(hunt.matchesSecret("Dark Forest", hashed), true);
  assert.equal(hunt.matchesSecret("dark", hashed), false);
  assert.equal(hunt.matchesSecret("Dark Forest", `nope|${hashed.toUpperCase().replace("SHA256:", "sha256:")}`), true);
  // full-width letters fold to plain ones
  assert.equal(hunt.matchesSecret("ＧＬＯＡＭ", "gloam"), true);
});

await test("answers ignore punctuation, symbols and curly quotes, and keep letters and digits from any script", () => {
  const want = "don't trust, verify";
  // a phone types a curly apostrophe
  assert.equal(hunt.matchesSecret("don\u2019t trust, verify", want), true);
  assert.equal(hunt.matchesSecret("Don\u2019t trust, verify!", "dont trust verify"), true);
  assert.equal(hunt.matchesSecret("DONT TRUST VERIFY", want), true);
  assert.equal(hunt.matchesSecret("\u201cdon't trust; verify.\u201d", want), true);
  assert.equal(hunt.matchesSecret("don't trust, verify?!", want), true);
  assert.equal(hunt.matchesSecret("do trust, verify", want), false, "the words still have to be the same");
  assert.equal(hunt.normalizeGuess("Don\u2019t trust, verify!"), "donttrustverify");
  assert.equal(hunt.normalizeGuess("dont trust verify"), "donttrustverify");
  // symbols go, digits stay
  assert.equal(hunt.normalizeGuess("$GLOAM #1 -> 100%"), "gloam1100");
  // other scripts keep their letters, with their marks
  assert.equal(hunt.normalizeGuess("Größe, Straße!"), "größestraße");
  assert.equal(hunt.normalizeGuess("नमस्ते, दुनिया"), "नमस्तेदुनिया");
  assert.equal(hunt.normalizeGuess("秘密の 合言葉。"), "秘密の合言葉");
  assert.equal(hunt.matchesSecret("ПРИВЕТ, мир!", "привет мир"), true);
  // an answer of only punctuation never matches anything
  assert.equal(hunt.matchesSecret("!!!", "!!!"), false);
  assert.equal(hunt.matchesSecret("a", "!!!"), false);
});

await test("a sha256 answer is the hash of normalizeGuess, and hashes made before still match", () => {
  const h = (s: string) => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;
  // the runbook's recipe: hash the normalized form
  const hashed = h(hunt.normalizeGuess("Don't trust, verify"));
  assert.equal(hashed, h("donttrustverify"));
  assert.equal(hunt.matchesSecret("Don\u2019t trust, verify!", hashed), true);
  assert.equal(hunt.matchesSecret("dont trust verify", hashed), true);
  assert.equal(hunt.matchesSecret("trust verify", hashed), false);
  // a hash made the old way (lower case, spaces removed, punctuation kept) still opens with the curly apostrophe
  const old = h("don'ttrust,verify");
  assert.equal(hunt.matchesSecret("Don't trust, verify", old), true);
  assert.equal(hunt.matchesSecret("don\u2019t trust, verify", old), true);
  assert.equal(hunt.matchesSecret("dont trust verify", old), false, "an old hash knows only its own punctuation");
});

// ---------------------------------------------------------------- on

env.HUNT_ENABLED = "true";

await test("the home page clue: a comment that can't end early, a console line that can't leave its script", () => {
  env.HUNT_SOURCE_COMMENT = "look --> here -- and\\nthere";
  env.HUNT_CONSOLE_MESSAGE = 'hi</script><script>alert(1)</script>" ';
  const clue = hunt.huntSourceClue()!;
  assert.equal(clue.comment, "look --> here -- and\nthere", "a written \\n is a line break");
  const c = hunt.htmlComment(clue.comment);
  assert.ok(c.startsWith("<!-- ") && c.endsWith(" -->"));
  assert.equal(c.slice(4, -3).includes("--"), false, "nothing inside can close the comment");
  const lit = hunt.scriptLiteral(clue.console);
  assert.equal(/<\/?script/i.test(lit), false);
  assert.equal(lit.includes(" "), false);
  assert.equal(JSON.parse(lit), clue.console, "the browser prints the text as written");
  // the component renders both
  const out = HuntSourceClue() as unknown as { props: { children: { props: { dangerouslySetInnerHTML: { __html: string } } }[] } };
  const html = out.props.children.map((ch) => ch.props.dangerouslySetInnerHTML.__html);
  assert.equal(html[0], c);
  assert.equal(html[1], `console.log(${lit});`);
  // either one alone is enough; neither turns it off
  env.HUNT_SOURCE_COMMENT = "";
  assert.deepEqual(hunt.huntSourceClue(), { comment: "", console: clue.console });
  env.HUNT_CONSOLE_MESSAGE = "";
  assert.equal(hunt.huntSourceClue(), null);
});

await test("the hidden page path: only a plain slug, and only with the riddle, answer and next clue set", async () => {
  env.HUNT_PATH_2 = `/${PATH}/`;
  assert.equal(hunt.huntPagePath(), PATH);
  assert.equal(await openPage(PATH), "page");
  for (const other of [`${PATH}x`, PATH.toUpperCase(), "anything", ""]) assert.equal(await openPage(other), "404", other);
  for (const bad of ["ab", "../etc", "a/b", "has space", "-lead", "x".repeat(65), "q?x=1"]) {
    env.HUNT_PATH_2 = bad;
    assert.equal(hunt.huntPagePath(), null, bad);
  }
  env.HUNT_PATH_2 = PATH;
  for (const need of ["HUNT_RIDDLE", "HUNT_ANSWER_2", "HUNT_CLUE_3"]) {
    const keep = env[need];
    delete env[need];
    assert.equal(hunt.huntPagePath(), null, need);
    assert.equal(await openPage(PATH), "404", need);
    env[need] = keep;
  }
  env.HUNT_ENABLED = "1";
  assert.equal(hunt.huntPagePath(), PATH, '"1" turns it on too');
});

await test("the hidden page: visits counted as people, wrong answers get nothing, the right one the next clue", async () => {
  env.HUNT_CLUE_3 = "Next: talk to the bot.\\nSay the words.";
  // every render above came from the same (stubbed, empty) request: one person
  assert.equal((await hunt.readHuntProgress())!.page, 1, "distinct people, not visits");
  await openPage(PATH);
  assert.equal((await hunt.readHuntProgress())!.page, 1);
  await hunt.countHuntStep("page", hunt.huntSubject("ip", "203.0.113.21"));
  assert.equal((await hunt.readHuntProgress())!.page, 2);

  const wrong = await post({ answer: "privacy" }, "203.0.113.30");
  assert.equal(wrong.status, 200);
  const wj = (await wrong.json()) as { ok: boolean; data: Record<string, unknown> };
  assert.equal(wj.ok, true);
  assert.deepEqual(wj.data, {}, "a wrong answer says nothing about the right one");

  const right = await post({ answer: ANSWER.toUpperCase().replace(" ", "   ") }, "203.0.113.30");
  const rj = (await right.json()) as { ok: boolean; data: { next?: string } };
  assert.equal(rj.data.next, "Next: talk to the bot.\nSay the words.");
  assert.equal((await hunt.readHuntProgress())!.riddle, 1);

  assert.equal((await post("not json")).status, 400);
  assert.equal((await post({ answer: "" })).status, 400);
  assert.equal((await post({ answer: 7 })).status, 400);
  assert.equal((await post({ answer: "a".repeat(201) })).status, 400);
  assert.equal((await post(`{"answer":"${"a".repeat(1100)}"}`)).status, 413);
});

await test("answer tries are rate limited per IP", async () => {
  const ip = "203.0.113.40";
  for (let i = 0; i < 8; i++) assert.equal((await post({ answer: `guess ${i}` }, ip)).status, 200);
  const r = await post({ answer: ANSWER }, ip);
  assert.equal(r.status, 429, "even the right answer waits once the limit is hit");
  assert.ok(Number(r.headers.get("Retry-After")) > 0);
  assert.equal((await post({ answer: ANSWER }, "203.0.113.41")).status, 200, "another IP is not held up");
});

await test("Glim's passphrase: exact match only, case and spaces aside", () => {
  env.HUNT_CLUE_4 = "Developers: call gloam_info with the key.";
  assert.equal(hunt.glimHuntReply(PHRASE.toLowerCase()), env.HUNT_CLUE_4);
  assert.equal(hunt.glimHuntReply(` ${PHRASE.toUpperCase()} `), env.HUNT_CLUE_4);
  assert.equal(hunt.glimHuntReply(`${PHRASE} please`), null);
  assert.equal(hunt.glimHuntReply(`what is ${PHRASE}?`), null);
  assert.equal(hunt.glimHuntReply("hi"), null);
  delete env.HUNT_CLUE_4;
  assert.equal(hunt.glimHuntReply(PHRASE), null, "no reply text, no reply");
  env.HUNT_CLUE_4 = "clue four";
});

/** A throwaway prize note, made the way the app makes one, as a short or long claim link. */
async function prizeNote(form: "short" | "long") {
  const asset = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const amount = 100_000_000n;
  const secret = fieldToHex(BigInt(`0x${randomBytes(30).toString("hex")}`));
  const commitment = fieldToHex(await noteCommitmentPoseidon(BigInt(secret), amount, asset));
  const code = encodeNotePackage(
    buildNotePackage({ pool: "0x39e28cde55cab798874746ac52cb4b5cc99a0194", asset, amountWei: amount.toString(), secret, commitment, chainId: 4663 }),
  );
  const link = form === "short" ? claimLinkFor(code, "robinhood-mainnet") : longClaimLinkFor(code, "robinhood-mainnet");
  return { code, link, secret, commitment, nullifier: await paymentNullifier(secret, commitment) };
}

const newPieces = () => [0, 1, 2].map(() => randomBytes(8).toString("hex"));
const setPieces = (pieces: string[]) => pieces.forEach((f, i) => (env[`HUNT_FRAGMENT_${i + 1}`] = ` ${f}\n`));

await test("the MCP step: hidden arguments, the usual answer for a wrong key, the pieces asked for, then the prize link", async () => {
  const gi = TOOLS.find((t) => t.name === "gloam_info")!;
  assert.deepEqual(gi.inputSchema.properties, {}, "neither argument is in the schema");
  assert.equal(JSON.stringify(TOOLS).includes(KEY), false);

  const prize = await prizeNote("short");
  const PIECES = newPieces();
  delete env.HUNT_FINAL_INSTRUCTIONS;
  const plain = await info({});
  assert.ok(typeof plain.json.what === "string");

  // off until the key, the prize link and all three pieces are set
  env.HUNT_PRIZE_LINK = prize.link;
  assert.deepEqual((await info({ code: KEY, pieces: PIECES.join(" ") }, freshIp())).json, plain.json, "no pieces set: off");
  setPieces(PIECES);
  delete env.HUNT_PRIZE_LINK;
  assert.deepEqual((await info({ code: KEY, pieces: PIECES.join(" ") }, freshIp())).json, plain.json, "no prize link set: off");
  for (const bad of ["https://www.gloam.trade/c", "https://www.gloam.trade/claim?net=x#claim=", "http://www.gloam.trade/c#2Muuo9o8HGWzGgY6sVnAweQDGXr", "gloam.trade/c#2Muuo9o8HGWzGgY6sVnAweQDGXr", `${prize.link} x`]) {
    env.HUNT_PRIZE_LINK = bad;
    assert.equal(hunt.huntPrizeLink(), null, bad);
  }
  env.HUNT_PRIZE_LINK = prize.link;
  assert.equal(hunt.huntPrizeLink(), prize.link);

  for (const args of [{ code: "wrong", pieces: PIECES.join(" ") }, { code: 5 }, { other: KEY }, { pieces: PIECES.join(" ") }, { code: `${KEY} ` + "x" }]) {
    const r = await info(args, freshIp());
    assert.deepEqual(r.json, plain.json, JSON.stringify(args));
  }

  // the right key alone: how to bring the pieces, no link, not counted
  const bare = await info({ code: KEY.toUpperCase() }, freshIp());
  assert.deepEqual(Object.keys(bare.json), ["message"]);
  const ask = String(bare.json.message);
  assert.ok(ask.includes('"pieces"') && ask.includes("piece 1, piece 2 and piece 3"), ask);
  assert.equal(JSON.stringify(bare.json).includes(prize.link.split("#")[1]!), false);
  assert.equal((await hunt.readHuntProgress())!.mcp, 0);

  // missing, partial, wrong or out of order: the same answer, which says nothing about which piece is off
  const [p1, p2, p3] = PIECES as [string, string, string];
  for (const pieces of [
    undefined,
    "",
    5,
    null,
    `${p1} ${p2}`,
    `${p2} ${p1} ${p3}`,
    `${p1} ${p3} ${p2}`,
    `${p1} ${p2} ${p3.slice(1)}`,
    `${p1} ${p2} ${"0".repeat(16)}`,
    [p1, p2, 7],
    [p1, p2],
    `${p1} ${p2} ${p3} ${"x".repeat(200)}`,
  ]) {
    const r = await info({ code: KEY, pieces }, freshIp());
    assert.deepEqual(r.json, bare.json, JSON.stringify(pieces));
  }
  assert.equal((await hunt.readHuntProgress())!.mcp, 0);

  // all three in order, with any separators: the link, whole, counted
  const kinds = [`${p1} ${p2} ${p3}`, `${p1},${p2},${p3}`, `piece 1: ${p1}\npiece 2: ${p2}\npiece 3: ${p3}`, [p1, p2, p3], `${p1}${p2}${p3}`];
  for (const pieces of kinds) {
    const r = await info({ code: KEY, pieces }, freshIp());
    assert.deepEqual(Object.keys(r.json), ["message", "link"], JSON.stringify(pieces));
    assert.equal(r.json.link, prize.link);
  }
  assert.equal((await hunt.readHuntProgress())!.mcp, kinds.length, "one per person who got the link");

  // the default words work for either link form: nothing to put together, the link comes whole
  const msg = String((await info({ code: KEY, pieces: PIECES }, freshIp())).json.message);
  assert.equal(msg, hunt.defaultFinalInstructions());
  assert.ok(msg.includes("whole") && msg.includes("no gas"), msg);
  assert.equal(/gloam1=|add the result|put them together/i.test(msg), false, msg);
  env.HUNT_FINAL_INSTRUCTIONS = "Here it is.\\nGo.";
  assert.deepEqual((await info({ code: KEY, pieces: PIECES }, freshIp())).json, { message: "Here it is.\nGo.", link: prize.link });
  delete env.HUNT_FINAL_INSTRUCTIONS;

  // the argument names can be changed
  env.HUNT_MCP_ARG = "invite";
  env.HUNT_MCP_PIECES_ARG = "found";
  assert.ok(typeof (await info({ code: KEY, pieces: PIECES }, freshIp())).json.what === "string");
  assert.equal((await info({ invite: KEY, pieces: PIECES }, freshIp())).json.link, undefined, "pieces under the old name are not read");
  assert.equal((await info({ invite: KEY, found: PIECES }, freshIp())).json.link, prize.link);
  env.HUNT_MCP_ARG = "bad name!";
  env.HUNT_MCP_PIECES_ARG = "code";
  assert.equal(hunt.huntMcpArg(), "code", "a bad name falls back to the default");
  assert.equal(hunt.huntMcpPiecesArg(), "pieces", "the pieces can't share the key's argument");
  delete env.HUNT_MCP_ARG;
  delete env.HUNT_MCP_PIECES_ARG;

  // a key that looks like a secret is refused before any tool runs, as always
  const hex = await callTool("gloam_info", { code: "ab".repeat(32) }, { origin: "https://www.gloam.trade", ip: freshIp() });
  assert.equal(hex.isError, true);
});

await test("MCP key tries are rate limited per IP: past the limit even the right key and pieces get the usual answer", async () => {
  const ip = "203.0.113.60";
  const pieces = [1, 2, 3].map((n) => hunt.huntFragment(n));
  assert.ok(pieces.every(Boolean) && hunt.huntPrizeLink());
  for (let i = 0; i < 20; i++) await info({ code: `try ${i}` }, ip);
  const r = await info({ code: KEY, pieces }, ip);
  assert.ok(typeof r.json.what === "string" && !("message" in r.json) && !("link" in r.json));
});

await test("every step is needed: pieces 1 to 3 hold nothing of the prize, and only the key with them gets the link", async () => {
  // a piece is a plain code: letters, digits and "=", 8 to 48 characters, and only 1 to 3
  for (const [v, ok] of [["abc def!", false], ["short", false], ["a".repeat(49), false], ["a".repeat(48), true], [" abcd1234\n", true]] as const) {
    env.HUNT_FRAGMENT_1 = v;
    assert.equal(Boolean(hunt.huntFragment(1)), ok, v);
  }
  env.HUNT_FRAGMENT_4 = "abcd1234";
  assert.equal(hunt.huntFragment(4), "", "there is no piece 4: the last step is the key");
  delete env.HUNT_FRAGMENT_4;

  for (const form of ["short", "long"] as const) {
    const prize = await prizeNote(form);
    assert.ok(form === "short" ? /^https:\/\/www\.gloam\.trade\/c#[0-9A-Za-z]{20,}$/.test(prize.link) : prize.link.includes("#claim=gloam1="), prize.link);
    env.HUNT_PRIZE_LINK = prize.link;
    const PIECES = newPieces();
    setPieces(PIECES);

    // the hunter's way: a piece from each of the first three steps
    env.HUNT_SOURCE_COMMENT = "Look closer.";
    env.HUNT_CONSOLE_MESSAGE = "Hello.";
    assert.deepEqual(hunt.huntSourceClue(), { comment: `Look closer.\n\nPiece 1 of 3: ${PIECES[0]}`, console: "Hello." });
    env.HUNT_CONSOLE_MESSAGE = "Hello. {fragment}";
    assert.deepEqual(hunt.huntSourceClue(), { comment: "Look closer.", console: `Hello. ${PIECES[0]}` });
    env.HUNT_SOURCE_COMMENT = "";
    env.HUNT_CONSOLE_MESSAGE = "Hello.";
    const one = hunt.huntSourceClue()!.console.split("Piece 1 of 3: ")[1]!;
    const r2 = (await (await post({ answer: ANSWER }, freshIp())).json()) as { data: { next: string } };
    assert.ok(r2.data.next.startsWith("Next: talk to the bot."));
    const two = r2.data.next.split("Piece 2 of 3: ")[1]!;
    const three = hunt.glimHuntReply(PHRASE)!.split("Piece 3 of 3: ")[1]!;
    const found = [one, two, three];
    assert.deepEqual(found, PIECES);

    // pieces 1 to 3 hold nothing of the prize: no part of the link or its secret, and no 6 characters in a row of its body
    const body = prize.link.slice(prize.link.indexOf("#") + 1);
    const secretHex = prize.secret.slice(2);
    for (const piece of found) {
      assert.equal(prize.link.includes(piece) || secretHex.includes(piece.toLowerCase()), false);
      for (let i = 0; i + 6 <= piece.length; i++) assert.equal(body.includes(piece.slice(i, i + 6)), false, `${form}: ${piece}`);
    }
    // put together every way the old split allowed, they are no claim code
    for (const guess of [found.join(""), `gloam1=${found.join("")}`, `gloam3=${found.join("")}`, `https://www.gloam.trade/c#${found.join("")}`]) {
      await assert.rejects(nullifierOfClaimLink(guess), guess);
    }
    // and the same pieces open any other prize: they were made apart from it, so they can't say what it is
    const other = await prizeNote(form);
    env.HUNT_PRIZE_LINK = other.link;
    assert.equal((await info({ code: KEY, pieces: found.join(" ") }, freshIp())).json.link, other.link);
    env.HUNT_PRIZE_LINK = prize.link;

    // the pieces without the key: the usual gloam_info, nothing of the prize
    const plain = await info({});
    for (const args of [{ pieces: found.join(" ") }, { code: found.join(" ") }, { code: found[2], pieces: found.join(" ") }]) {
      assert.deepEqual((await info(args, freshIp())).json, plain.json, JSON.stringify(args));
    }
    // the key without the pieces: no link
    assert.equal((await info({ code: KEY }, freshIp())).json.link, undefined);

    // the key with all three: the link, which opens as the prize note and spends its nullifier
    const r4 = await info({ code: KEY, pieces: found.join(" ") }, freshIp());
    assert.equal(r4.json.link, prize.link);
    assert.equal(await nullifierOfClaimLink(String(r4.json.link)), prize.nullifier, form);
  }

  // the nullifier script reads every form a short link turns up in
  const short = await prizeNote("short");
  const body = short.link.slice(short.link.indexOf("#") + 1);
  for (const text of [short.link, short.link.replace("#", "%23"), `  ${short.link}\n`, body, shortCodeFor(short.code, "robinhood-mainnet"), short.code]) {
    assert.equal(await nullifierOfClaimLink(text), short.nullifier, text);
  }
  await assert.rejects(nullifierOfClaimLink("https://www.gloam.trade/claim?net=robinhood-mainnet#claim="));
  await assert.rejects(nullifierOfClaimLink(body.slice(0, -3)), "a cut body is refused");
});

await test("prize check: only with a nullifier, claimed is kept, a failed read is unknown", async () => {
  delete env.HUNT_PRIZE_NULLIFIER;
  assert.equal(await prizeState(), "unchecked");
  env.HUNT_PRIZE_NULLIFIER = "0x1234";
  assert.equal(await prizeState(), "unchecked", "a malformed nullifier is not checked");
  const nullifier = `0x${randomBytes(32).toString("hex")}`;
  env.HUNT_PRIZE_NULLIFIER = nullifier;
  const asked: string[] = [];
  let spent = false;
  const read = async (n: string) => {
    asked.push(n);
    return spent;
  };
  const t0 = 1_000_000;
  assert.equal(await prizeState(t0, read), "unclaimed");
  assert.deepEqual(asked, [nullifier]);
  spent = true;
  assert.equal(await prizeState(t0 + 10_000, read), "unclaimed", "kept for a minute");
  assert.equal(await prizeState(t0 + 61_000, read), "claimed");
  spent = false;
  assert.equal(await prizeState(t0 + 600_000, read), "claimed", "a claim is kept for good");
  assert.equal(asked.length, 2);
  env.HUNT_PRIZE_NULLIFIER = `0x${randomBytes(32).toString("hex")}`;
  assert.equal(await prizeState(t0, async () => { throw new Error("rpc down"); }), "unknown");
});

await test("the admin view says what is set up, never what it holds", async () => {
  const setup = hunt.huntSetup();
  assert.deepEqual(setup, { enabled: true, source: true, page: true, glim: true, mcp: true, pieces: true, prizeLink: true, prizeCheck: true });
  const all = JSON.stringify({ setup, progress: await hunt.readHuntProgress() });
  for (const s of [KEY, PHRASE, ANSWER, PATH, env.HUNT_FRAGMENT_1!.trim(), env.HUNT_FRAGMENT_2!.trim(), env.HUNT_FRAGMENT_3!.trim(), env.HUNT_PRIZE_LINK!, env.HUNT_PRIZE_NULLIFIER!]) assert.equal(all.includes(s), false);
  delete env.HUNT_FRAGMENT_3;
  assert.equal(hunt.huntSetup().pieces, false);
  delete env.HUNT_PRIZE_LINK;
  assert.equal(hunt.huntSetup().prizeLink, false);
});

await test("no client component imports lib/hunt, so nothing of it reaches the browser", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|mts)$/.test(name)) files.push(p);
    }
  };
  walk(new URL("../src", import.meta.url).pathname);
  const client = files.filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
  assert.ok(client.length > 10);
  for (const f of client) {
    const src = readFileSync(f, "utf8");
    assert.equal(/from\s+["'](@\/lib\/hunt|.*\/lib\/hunt)["']/.test(src), false, f);
  }
});

for (const v of HUNT_VARS) delete env[v];
console.log(`\nhunt: ${passed} passed`);
