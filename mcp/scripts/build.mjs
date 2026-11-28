#!/usr/bin/env node
/**
 * Builds the publishable server: one ESM file at dist/index.js.
 *
 * The Gloam workspace packages (@gloamtrade/sdk and friends) ship TypeScript
 * source, which plain Node will not run from node_modules. So they are bundled
 * in, and everything else stays an ordinary npm dependency, resolved at run
 * time. A bare import that is neither a workspace package nor listed in this
 * package's dependencies fails the build, so the published package can never
 * reach for a module its users do not have.
 *
 * A vendored package (a devDependency installed from a file: tarball, like
 * StarkWare's Starknet privacy SDK, which is not on npm) is bundled too, with
 * the modules it imports, except those it shares with this server (SHARED:
 * one starknet.js for both). Its license and notice, and those of every module
 * bundled with it, go into dist/THIRD-PARTY-NOTICES.txt.
 */
import { build } from "esbuild";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const isWorkspace = (spec) => typeof spec === "string" && spec.startsWith("workspace:");
const isVendored = (spec) => typeof spec === "string" && spec.startsWith("file:") && spec.endsWith(".tgz");
const allDeps = { ...pkg.devDependencies, ...pkg.dependencies };
/** Workspace packages: bundled. */
const bundled = Object.keys(allDeps).filter((name) => isWorkspace(allDeps[name]));
/** Vendored packages (file: tarballs, dev only): bundled with what they import. */
const vendored = Object.keys(pkg.devDependencies ?? {}).filter((name) => isVendored(pkg.devDependencies[name]));
/** Runtime dependencies a vendored package imports that stay one shared install. */
const SHARED = new Set(["starknet"]);
/** Runtime dependencies: left as imports. */
const runtime = Object.keys(pkg.dependencies ?? {}).filter((name) => !isWorkspace(pkg.dependencies[name]));

const misplaced = Object.keys(pkg.dependencies ?? {}).filter((name) => isWorkspace(pkg.dependencies[name]));
if (misplaced.length) {
  console.error(
    `build: ${misplaced.join(", ")} ${misplaced.length === 1 ? "is a workspace package" : "are workspace packages"} in "dependencies". ` +
      `They are bundled into dist, so list them under "devDependencies"; otherwise npm would try to install them for every user.`
  );
  process.exit(1);
}

const packageName = (spec) => {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const undeclared = new Set();
/** Third-party modules bundled into dist (vendored ones and what they import): name -> package directory. */
const thirdParty = new Map();
/** A module path inside node_modules: its package name and directory, or null. */
function packageOf(path) {
  const m = /^(.*\/node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(path);
  return m ? { name: m[2], dir: m[1] } : null;
}
const dependencyGuard = {
  name: "gloam-dependency-guard",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (builtins.has(args.path) || args.path.startsWith("node:")) return { path: args.path, external: true };
      const name = packageName(args.path);
      if (bundled.includes(name) || vendored.includes(name)) return undefined; // bundle it
      // Only bundled third-party code sits in node_modules here (everything else is external), so an
      // import from there is a vendored package's own: it rides along, unless it is shared.
      const fromThirdParty = packageOf(args.importer) !== null;
      if (fromThirdParty && !SHARED.has(name)) return undefined;
      if (runtime.includes(name)) return { path: args.path, external: true };
      undeclared.add(`${name} (imported from ${args.importer.replace(root, "mcp")})`);
      return { path: args.path, external: true };
    });
    b.onLoad({ filter: /\/node_modules\// }, (args) => {
      const p = packageOf(args.path);
      if (p && !thirdParty.has(p.name)) thirdParty.set(p.name, p.dir);
      return undefined;
    });
  },
};

rmSync(join(root, "dist"), { recursive: true, force: true });

await build({
  entryPoints: [join(root, "src/index.ts")],
  outfile: join(root, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  plugins: [dependencyGuard],
});

if (undeclared.size) {
  console.error(
    `build: these imports are not dependencies of ${pkg.name}, so the published server would crash on them:\n  ` +
      [...undeclared].join("\n  ") +
      `\nAdd them to "dependencies" in mcp/package.json.`
  );
  rmSync(join(root, "dist"), { recursive: true, force: true });
  process.exit(1);
}

// Licenses of the third-party code bundled in (Apache-2.0 asks for its license and notice to travel with it).
if (thirdParty.size) {
  const parts = [`Third-party code bundled into ${pkg.name} ${pkg.version} (dist/index.js).\n`];
  for (const [name, dir] of [...thirdParty].sort(([a], [b]) => a.localeCompare(b))) {
    let meta = {};
    try {
      meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      /* no package.json */
    }
    // A vendored tarball's license and notice sit next to it (it was built from its repository).
    const spec = pkg.devDependencies?.[name];
    const beside = isVendored(spec) ? dirname(join(root, spec.slice("file:".length))) : null;
    const files = [...(beside ? [join(beside, "LICENSE"), join(beside, "NOTICE")] : []), ...["LICENSE", "LICENSE.md", "LICENSE.txt", "NOTICE"].map((f) => join(dir, f))];
    const texts = [...new Set(files)].filter((f) => existsSync(f)).map((f) => readFileSync(f, "utf8").trim());
    parts.push(`${"=".repeat(72)}\n${name} ${meta.version ?? ""} (${meta.license ?? "see below"})\n${"=".repeat(72)}\n${texts.join("\n\n") || "No license file shipped with the package."}\n`);
  }
  writeFileSync(join(root, "dist/THIRD-PARTY-NOTICES.txt"), parts.join("\n"));
}

console.error(
  `build: dist/index.js (${pkg.name}@${pkg.version}; bundled ${bundled.join(", ") || "nothing"}${thirdParty.size ? `; third-party ${[...thirdParty.keys()].join(", ")}` : ""})`
);
