/**
 * SDK_VERSION (src/index.ts) is written by hand. It must be the version in
 * package.json, the one npm installs, or apps that show it (the SDK
 * playground) and anyone reading it at run time see the wrong release.
 *
 * Run after build:  node test/version.selftest.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SDK_VERSION } from "../dist/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, `package.json version ${pkg.version}`);
assert.equal(SDK_VERSION, pkg.version, `SDK_VERSION in src/index.ts is ${SDK_VERSION}, package.json says ${pkg.version}: change both together`);

console.log(`version.selftest: ok (SDK_VERSION ${SDK_VERSION} matches package.json)`);
