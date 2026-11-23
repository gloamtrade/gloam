/**
 * Self-test: every page that sets its own openGraph still has a share card.
 *
 * Next merges metadata per segment, and a page or layout that sets `openGraph`
 * replaces its parent's whole openGraph, images included. Without `images` of
 * its own or an opengraph-image file in its own folder, the page shares with
 * no picture (/security, /compliance, /updates and the status page did, until
 * 23 Nov 2026). The twitter card keeps the site's image, so only some apps showed it.
 *
 *  - each page.tsx or layout.tsx under src/app that sets openGraph either lists
 *    images in it or sits next to an opengraph-image file
 *  - each opengraph-image the pages above rely on has a twitter-image beside it,
 *    so X shows the same card
 *
 * Reads the source only. Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-share-cards.mts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const APP = join(process.cwd(), "src/app");
const IMAGE = /^opengraph-image\.(tsx|ts|jsx|js|png|jpe?g)$/;
const TWITTER = /^twitter-image\.(tsx|ts|jsx|js|png|jpe?g)$/;

/** The text of each `openGraph: { ... }` object in a file, braces balanced. */
export function openGraphObjects(src: string): string[] {
  const out: string[] = [];
  const re = /\bopenGraph\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

function walk(dir: string, files: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === "api" || e.name === "node_modules") continue;
      walk(join(dir, e.name), files);
    } else files.push(join(dir, e.name));
  }
  return files;
}

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

test("openGraphObjects reads nested objects and leaves other keys out", () => {
  const src = `export const metadata = { title: "x", openGraph: { title: "a", images: [{ url: "/i.png" }] }, twitter: { card: "summary" } };`;
  const got = openGraphObjects(src);
  assert.equal(got.length, 1);
  assert.ok(got[0]!.includes("images"));
  assert.ok(!got[0]!.includes("twitter"));
  assert.deepEqual(openGraphObjects(`const a = { openGraph: { title: "b" } };`), [`openGraph: { title: "b" }`]);
});

const files = walk(APP);
const segments = new Map<string, string[]>();
for (const f of files) {
  const dir = f.slice(0, f.lastIndexOf("/"));
  segments.set(dir, [...(segments.get(dir) ?? []), f.slice(dir.length + 1)]);
}

const needCard: string[] = [];
test("every page or layout that sets openGraph has images or an opengraph-image beside it", () => {
  const missing: string[] = [];
  for (const f of files) {
    if (!/\/(page|layout)\.tsx$/.test(f)) continue;
    const objs = openGraphObjects(readFileSync(f, "utf8"));
    if (objs.length === 0) continue;
    if (objs.every((o) => /\bimages\s*:/.test(o))) continue;
    const dir = f.slice(0, f.lastIndexOf("/"));
    const names = segments.get(dir) ?? [];
    if (names.some((n) => IMAGE.test(n))) {
      needCard.push(dir);
      continue;
    }
    missing.push(relative(process.cwd(), f));
  }
  assert.deepEqual(missing, [], `these set openGraph without images and share with no picture:\n  ${missing.join("\n  ")}`);
  assert.ok(needCard.length > 10, "found the pages that rely on their own card");
});

test("the pages fixed on 23 Nov 2026 keep their cards", () => {
  for (const seg of ["security", "compliance", "updates", "updates/[id]", "status"]) {
    assert.ok(needCard.includes(join(APP, seg)), `${seg} has its own opengraph-image`);
  }
});

test("each of those cards has a twitter-image beside it", () => {
  const missing = needCard.filter((d) => !(segments.get(d) ?? []).some((n) => TWITTER.test(n))).map((d) => relative(process.cwd(), d));
  assert.deepEqual(missing, [], `opengraph-image without twitter-image:\n  ${missing.join("\n  ")}`);
});

console.log(`\n${passed} passed`);
