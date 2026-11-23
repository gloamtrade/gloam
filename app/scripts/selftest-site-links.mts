/**
 * Self-test: internal links that go through next/link point at a Next page.
 *
 * next/link prefetches its href as a React Server Component payload. A page
 * Next doesn't route (the pitch deck, public/pitch/index.html behind a rewrite)
 * answers that prefetch 404, so every page whose footer linked /pitch with
 * <Link> logged a failed request in the console (found 23 Nov 2026).
 *
 *  - each literal <Link href="/..."> in src resolves to a page under src/app
 *  - each footer entry resolves to a page, unless it is marked `document`;
 *    a `document` entry is one Next does not route (a public file or a rewrite)
 *  - every <table> sits in its own overflow-x-auto wrapper, so a wide one
 *    scrolls inside itself instead of widening the page on a phone
 *
 * Reads the source only. Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-site-links.mts
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");
const APP = join(SRC, "app");
const PUBLIC = join(process.cwd(), "public");
const PAGE = /^page\.(tsx|ts|jsx|js|mdx)$/;

/** Whether a path ("/docs/agents") is a page in the app router: exact folders first, then [param] and [...param], route groups see-through. */
export function routes(path: string): boolean {
  const segs = path.split(/[?#]/)[0]!.split("/").filter(Boolean);
  const walk = (dir: string, i: number): boolean => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return false;
    }
    const dirs = names.filter((n) => statSync(join(dir, n)).isDirectory());
    // route groups add no segment
    for (const g of dirs.filter((n) => /^\(.+\)$/.test(n))) if (walk(join(dir, g), i)) return true;
    if (i === segs.length) return names.some((n) => PAGE.test(n)) || dirs.some((n) => /^\[\[\.\.\..+\]\]$/.test(n) && walk(join(dir, n), i));
    const seg = segs[i]!;
    if (dirs.includes(seg) && walk(join(dir, seg), i + 1)) return true;
    for (const d of dirs) {
      if (/^\[(?!\.\.\.)[^\]]+\]$/.test(d) && walk(join(dir, d), i + 1)) return true;
      if (/^\[\[?\.\.\..+\]\]?$/.test(d) && walk(join(dir, d), segs.length)) return true;
    }
    return false;
  };
  return walk(APP, 0);
}

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) files(join(dir, e.name), out);
    else if (/\.tsx$/.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

test("routes() knows a page, a dynamic page, a static file and a missing page", () => {
  assert.equal(routes("/"), true);
  assert.equal(routes("/docs/agents#spending-limits"), true);
  assert.equal(routes("/app/vault?tab=move"), true);
  assert.equal(routes("/vote/next-chain"), true);
  assert.equal(routes("/pitch"), false);
  assert.equal(routes("/no-such-page"), false);
});

test("every literal <Link href=\"/...\"> goes to a Next page", () => {
  const bad: string[] = [];
  for (const f of files(SRC)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/<Link\b[^>]*?\shref=\{?"(\/[^"]*)"/g)) {
      if (!routes(m[1]!)) bad.push(`${relative(process.cwd(), f)}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `these are not Next pages, so <Link> prefetches them into a 404; use <a>:\n  ${bad.join("\n  ")}`);
});

test("footer entries are Next pages, or marked document and served as a file", () => {
  const footer = readFileSync(join(SRC, "components/Footer.tsx"), "utf8");
  const entries = [...footer.matchAll(/\{\s*href:\s*"(\/[^"]*)"[^}]*\}/g)].map((m) => ({ href: m[1]!, document: /\bdocument:\s*true\b/.test(m[0]), external: /\bexternal:\s*true\b/.test(m[0]) }));
  assert.ok(entries.length > 20, "read the footer's links");
  const pitch = entries.find((e) => e.href === "/pitch");
  assert.ok(pitch?.document, "/pitch is a document link");
  const bad: string[] = [];
  for (const e of entries) {
    if (e.external) continue;
    const isRoute = routes(e.href);
    if (e.document) {
      const path = e.href.split(/[?#]/)[0]!;
      const file = existsSync(join(PUBLIC, path, "index.html")) || existsSync(join(PUBLIC, path));
      if (isRoute || !file) bad.push(`${e.href} is marked document but ${isRoute ? "is a Next page" : "has no file in public/"}`);
    } else if (!isRoute) bad.push(`${e.href} is not a Next page: mark it document`);
  }
  assert.deepEqual(bad, []);
});

// A docs table of call signatures pushed /docs/agents/commitments to 691px on a 375px phone
// (found 23 Nov 2026): every table sits in its own horizontal scroller, never the page.
test("every <table> sits directly in an overflow-x-auto wrapper", () => {
  const bad: string[] = [];
  for (const f of files(SRC)) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((ln, i) => {
      if (!/<table[\s>]/.test(ln)) return;
      let j = i - 1;
      while (j >= 0 && lines[j]!.trim() === "") j--;
      if (!/overflow-x-auto/.test(lines[j] ?? "")) bad.push(`${relative(process.cwd(), f)}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, [], `tables that can widen the page on a phone:\n  ${bad.join("\n  ")}`);
});

console.log(`\n${passed} passed`);
